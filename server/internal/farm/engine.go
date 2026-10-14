package farm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"paperfarm/internal/auth"
	"paperfarm/internal/paper"
	"paperfarm/internal/store"
)

// ---- a wallet's document: its trading key (sealed), farms and pairs ----

type SealedKey struct {
	Sealed string `json:"sealed"`
	Addr   string `json:"addr"`
	Expiry int64  `json:"expiry"` // unix s
}

type Doc struct {
	sync.Mutex
	Address string          `json:"address"`
	Key     *SealedKey      `json:"key,omitempty"`
	Farms   []*Farm         `json:"farms"`
	Pairs   []*PairRec      `json:"pairs"`
	Board   json.RawMessage `json:"board,omitempty"` // the Farm page's window layout, opaque to the server
	dirty   bool
}

func (d *Doc) Add(r *PairRec) {
	d.Lock()
	defer d.Unlock()
	d.Pairs = append(d.Pairs, r)
	// Keep the book bounded: drop the oldest finished pairs first.
	for len(d.Pairs) > 400 {
		i := 0
		for i < len(d.Pairs) && !(d.Pairs[i].Counted || d.Pairs[i].Archived) {
			i++
		}
		if i == len(d.Pairs) {
			break
		}
		d.Pairs = append(d.Pairs[:i], d.Pairs[i+1:]...)
	}
	d.dirty = true
}

func (d *Doc) Update(f func()) {
	d.Lock()
	f()
	d.dirty = true
	d.Unlock()
}

func docKey(addr string) string { return "acct:" + addr }

// ---- Hyperliquid mids, the price Papertrade executes at ----

type Mids struct {
	mu   sync.Mutex
	mids map[string]float64
	at   time.Time
}

func (m *Mids) Get(coin string) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if time.Since(m.at) > 10*time.Second {
		return 0 // stale prices take no decisions
	}
	return m.mids[coin]
}

func (m *Mids) Run(ctx context.Context) {
	c := &http.Client{Timeout: 5 * time.Second}
	for ctx.Err() == nil {
		req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.hyperliquid.xyz/info", bytes.NewReader([]byte(`{"type":"allMids"}`)))
		req.Header.Set("Content-Type", "application/json")
		if res, err := c.Do(req); err == nil {
			var all map[string]string
			if json.NewDecoder(res.Body).Decode(&all) == nil {
				next := map[string]float64{}
				for _, coin := range []string{"BTC", "ETH"} {
					if v, err := strconv.ParseFloat(all[coin], 64); err == nil && v > 0 {
						next[coin] = v
					}
				}
				m.mu.Lock()
				m.mids, m.at = next, time.Now()
				m.mu.Unlock()
			}
			res.Body.Close()
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
}

// ---- the engine: one Farmer per wallet with a trading key ----

type Engine struct {
	store  store.Store
	paper  *paper.Client
	Market func(context.Context) (paper.Market, error) // Papertrade's live limits; a stub in tests
	seal   *auth.Sealer
	mids   *Mids
	ctx    context.Context
	mu     sync.Mutex
	docs   map[string]*Doc
	farmer map[string]*Farmer
	leased chan struct{}  // closed once this process holds the trading lease
	jobs   sync.WaitGroup // trades in flight
}

// NewEngine returns an engine that trades nothing until Run.
func NewEngine(ctx context.Context, s store.Store, p *paper.Client, seal *auth.Sealer) *Engine {
	return &Engine{store: s, paper: p, Market: p.Market, seal: seal, mids: &Mids{}, ctx: ctx, docs: map[string]*Doc{}, farmer: map[string]*Farmer{}, leased: make(chan struct{})}
}

// Run polls prices and, once this process holds the trading lease, starts every keyed wallet's farmer.
// It returns when ctx ends.
func (e *Engine) Run() {
	go func() {
		if err := e.store.Acquire(e.ctx); err != nil {
			log.Printf("trading lease: %v", err)
			return
		}
		close(e.leased)
		log.Printf("trading lease held; starting farms")
		keys, err := e.store.Keys("acct:")
		if err != nil {
			log.Printf("listing accounts: %v", err)
			return
		}
		for _, k := range keys {
			if d, err := e.Doc(strings.TrimPrefix(k, "acct:")); err == nil && d.Key != nil {
				e.Start(d.Address)
			}
		}
	}()
	e.mids.Run(e.ctx)
}

func (e *Engine) lease(ctx context.Context) error {
	select {
	case <-e.leased:
	default:
		return errors.New("this server is not the trading instance yet")
	}
	return e.store.Check(ctx)
}

// Doc loads (once) and returns a wallet's document.
func (e *Engine) Doc(addr string) (*Doc, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if d := e.docs[addr]; d != nil {
		return d, nil
	}
	d := &Doc{Address: addr}
	b, err := e.store.Load(docKey(addr))
	if err != nil {
		return nil, err
	}
	if b != nil {
		if err := json.Unmarshal(b, d); err != nil {
			return nil, fmt.Errorf("account %s: %w", paper.ShortAddr(addr), err)
		}
	}
	for _, r := range d.Pairs {
		if r.Intents == nil {
			r.Intents = map[string]string{}
		}
		if r.Legs == nil {
			r.Legs = map[string]string{}
		}
	}
	e.docs[addr] = d
	return d, nil
}

// Save writes a document if it changed.
func (e *Engine) Save(d *Doc) error {
	d.Lock()
	if !d.dirty {
		d.Unlock()
		return nil
	}
	b, err := json.Marshal(d)
	d.dirty = false
	d.Unlock()
	if err != nil {
		return err
	}
	if err := e.store.Save(docKey(d.Address), b); err != nil {
		d.Update(func() {}) // still dirty: try again next tick
		return err
	}
	return nil
}

// Trader returns the wallet's trader, or an error when it has no usable trading key.
func (e *Engine) Trader(d *Doc) (*Trader, error) {
	d.Lock()
	k := d.Key
	d.Unlock()
	if k == nil {
		return nil, errors.New("no trading key: set one up first")
	}
	plain, err := e.seal.Open(k.Sealed, d.Address)
	if err != nil {
		return nil, errors.New("the stored trading key cannot be read; set up a new one")
	}
	key, err := paper.ParseKey(string(plain))
	if err != nil {
		return nil, err
	}
	return &Trader{Paper: e.paper, Key: key, User: d.Address, Lease: e.lease, Save: e.Save}, nil
}

// Mid is the coin's live Hyperliquid mid, 0 when stale.
func (e *Engine) Mid(coin string) float64 { return e.mids.Get(coin) }

// Shutdown, once the server's context has ended (no new trades start), waits up to `wait` for the trades
// already in flight, then saves every account, so a redeploy loses nothing it was doing.
func (e *Engine) Shutdown(wait time.Duration) {
	done := make(chan struct{})
	go func() { e.jobs.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(wait):
		log.Printf("shutdown: trades still in flight after %s; their intents are already saved", wait)
	}
	e.mu.Lock()
	docs := make([]*Doc, 0, len(e.docs))
	for _, d := range e.docs {
		docs = append(docs, d)
	}
	e.mu.Unlock()
	for _, d := range docs {
		if err := e.Save(d); err != nil {
			log.Printf("shutdown: account %s: save: %v", paper.ShortAddr(d.Address), err)
		}
	}
}

// Start runs a wallet's farmer (idempotent). Only the lease holder trades.
func (e *Engine) Start(addr string) {
	select {
	case <-e.leased:
	default:
		return // started for every keyed account once the lease is ours
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.farmer[addr] != nil {
		return
	}
	d := e.docs[addr]
	if d == nil {
		return
	}
	f := &Farmer{e: e, doc: d, watch: &paper.Watcher{Addr: addr}, busy: map[string]bool{}}
	e.farmer[addr] = f
	go f.watch.Run(e.ctx)
	go f.loop()
}

// Account is the live account of a farmed wallet, if this process follows it.
func (e *Engine) Account(addr string) *paper.Acct {
	e.mu.Lock()
	f := e.farmer[addr]
	e.mu.Unlock()
	if f == nil {
		return nil
	}
	a, _ := f.watch.Account()
	return a
}

type Farmer struct {
	e     *Engine
	doc   *Doc
	watch *paper.Watcher
	bmu   sync.Mutex
	busy  map[string]bool // pairs and farms with an action in flight
}

func (f *Farmer) loop() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-f.e.ctx.Done():
			return
		case <-t.C:
			f.run()
			if err := f.e.Save(f.doc); err != nil {
				log.Printf("account %s: save: %v", paper.ShortAddr(f.doc.Address), err)
			}
		}
	}
}

func (f *Farmer) claim(id string) bool {
	f.bmu.Lock()
	defer f.bmu.Unlock()
	if f.busy[id] {
		return false
	}
	f.busy[id] = true
	return true
}

func (f *Farmer) release(id string, after time.Duration) {
	time.AfterFunc(after, func() { f.bmu.Lock(); delete(f.busy, id); f.bmu.Unlock() })
}

// run is one pass of the engine for one wallet.
func (f *Farmer) run() {
	a, at := f.watch.Account()
	if a == nil || time.Since(at) > 60*time.Second {
		return // no fresh account: decide nothing
	}
	now := time.Now().UnixMilli()
	d := f.doc

	// Under the lock: record legs, book finished farm pairs, and decide.
	type job struct {
		id  string
		act string
		v   PairView
	}
	var jobs []job
	var opens []*Farm
	d.Lock()
	if SyncLegs(d.Pairs, a) {
		d.dirty = true
	}
	var views []PairView
	for _, r := range d.Pairs {
		if !r.Archived {
			views = append(views, Derive(r, a, now))
		}
	}
	for _, fm := range d.Farms {
		for _, v := range views {
			if tally(fm, v, now) {
				d.dirty = true
			}
		}
	}
	for _, v := range views {
		if act := decide(v, a, f.e.mids.Get(v.Rec.Coin), now); act != "" {
			jobs = append(jobs, job{v.Rec.ID, act, v})
		}
	}
	for _, fm := range d.Farms {
		if farmNeeds(fm, views, now) > 0 {
			opens = append(opens, fm)
		}
	}
	keyAddr, keyExp := "", int64(0)
	if d.Key != nil {
		keyAddr, keyExp = d.Key.Addr, d.Key.Expiry
	}
	d.Unlock()

	if len(jobs) == 0 && len(opens) == 0 {
		return
	}
	// The trading key must be registered on Papertrade with time to spare.
	if exp := a.Sessions[keyAddr]; keyAddr == "" || exp*1000-now < 3600_000 {
		msg := "Trading key expired; renew it"
		switch {
		case keyAddr == "":
			msg = "Set up a trading key to start"
		case exp == 0 && keyExp*1000 > now:
			msg = "Waiting for Papertrade to register the trading key"
		}
		d.Lock()
		for _, fm := range opens {
			if fm.Status != msg {
				fm.Status, d.dirty = msg, true
			}
		}
		d.Unlock()
		return
	}
	tr, err := f.e.Trader(d)
	if err != nil {
		log.Printf("account %s: %v", paper.ShortAddr(d.Address), err)
		return
	}
	for _, j := range jobs {
		if !f.claim(j.id) {
			continue
		}
		f.e.jobs.Add(1)
		go func(j job) {
			defer f.e.jobs.Done()
			defer f.release(j.id, 5*time.Second)
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute) // not the server's: a shutdown lets it finish
			defer cancel()
			var err error
			if j.act == "close" {
				err = tr.ClosePair(ctx, d, j.v)
			} else {
				iid := j.v.Rec.Intents["long"]
				if j.v.Short.Status == "queued" {
					iid = j.v.Rec.Intents["short"]
				}
				err = tr.Cancel(ctx, iid)
			}
			if err != nil {
				log.Printf("account %s pair %s: %s: %v", paper.ShortAddr(d.Address), j.id, j.act, err)
			}
		}(j)
	}

	mctx, mcancel := context.WithTimeout(f.e.ctx, 15*time.Second)
	m, merr := f.e.Market(mctx)
	mcancel()
	for _, fm := range opens {
		margin := fm.Notional / fm.Lev * 2
		wait := ""
		switch {
		case merr != nil:
			wait = "Papertrade data unavailable"
		case !m.Coins[fm.Coin].Openable || contains(m.Paused, "openPosition") || contains(m.Paused, "closePositions"):
			wait = "Papertrade has paused opens"
		case a.Avail < margin:
			wait = fmt.Sprintf("Waiting for $%.2f available", margin)
		case fm.Notional > m.PairRoom(fm.Coin, f.e.mids.Get(fm.Coin)):
			// what Papertrade's order form checks: sending now would only be refused
			wait = fmt.Sprintf("Papertrade's open interest limit leaves room for $%.0f a leg right now; waiting for room", m.PairRoom(fm.Coin, f.e.mids.Get(fm.Coin)))
		}
		if wait != "" {
			d.Update(func() { fm.Status = wait })
			continue
		}
		if !f.claim(fm.ID) {
			continue
		}
		d.Update(func() { fm.LastOpen, fm.Status = now, "" })
		f.e.jobs.Add(1)
		go func(fm *Farm) {
			defer f.e.jobs.Done()
			defer f.release(fm.ID, 0)
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute) // not the server's: a shutdown lets it finish
			defer cancel()
			if _, err := tr.OpenPair(ctx, d, fm.Coin, fm.Notional, fm.Lev, fm.TP, true, fm.ID); err != nil {
				// The dead pair is booked (and backs the farm off) by tally; this covers a failure before it existed.
				d.Update(func() {
					fm.BackoffUntil = max(fm.BackoffUntil, time.Now().UnixMilli()+30_000)
					fm.Status = paper.Explain(err)
				})
				log.Printf("account %s farm %s: open: %v", paper.ShortAddr(d.Address), fm.ID, err)
				return
			}
			d.Update(func() { fm.Opened++ })
		}(fm)
	}
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
