package paper

import (
	"bufio"
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
)

// The live account, from Papertrade's /state/user/live stream (through the proxy pool): a snapshot,
// then patches that each name the revision they follow. The browser keeps the same model (web/src/lib/account.ts).

type Position struct {
	ID       string  `json:"id"`
	Coin     string  `json:"coin"`
	Long     bool    `json:"long"`
	Entry    float64 `json:"entry"`
	Margin   float64 `json:"margin"`
	Leverage float64 `json:"leverage"`
	Bust     float64 `json:"bust"`
	OpenedAt int64   `json:"openedAt"`
	Intent   string  `json:"intent"`
}

type Op struct {
	ID     string   `json:"id"`
	Action string   `json:"action"`
	At     int64    `json:"at"`
	Closes []string `json:"closes"`
}

type Closed struct {
	PnL        float64 `json:"pnl"`
	Paper      float64 `json:"paper"`
	Liquidated bool    `json:"liquidated"`
}

type Acct struct {
	Rev       int64
	Sessions  map[string]int64 // session key -> expiry (unix s)
	Avail     float64
	Balance   float64
	Positions map[string]Position
	Ops       map[string]Op
	Outcomes  map[string]string // intent -> succeeded / failed / ..., as seen while streaming
	Closed    map[string]Closed // positions settled while streaming
}

var (
	coinOf     = map[float64]string{0: "BTC", 1: "ETH"}
	priceScale = map[int]float64{0: 10, 1: 100}
)

func parsePos(a []any) (Position, bool) {
	if len(a) < 10 {
		return Position{}, false
	}
	str := func(i int) string { v, _ := a[i].(string); return v }
	inst, _ := a[1].(float64)
	sc, ok := priceScale[int(inst)]
	if !ok {
		return Position{}, false
	}
	long, _ := a[2].(bool)
	lev, _ := a[6].(float64)
	opened, _ := a[8].(float64)
	p := Position{ID: str(0), Coin: coinOf[inst], Long: long, Entry: Raw(str(4), 0) / sc, Margin: Raw(str(5), 18), Leverage: lev,
		Bust: Raw(str(7), 0) / sc, OpenedAt: int64(opened), Intent: strings.ToLower(str(9))}
	return p, p.ID != "" && p.Entry > 0 && p.Margin > 0
}

func parseOp(a []any) (Op, bool) {
	if len(a) < 8 {
		return Op{}, false
	}
	id, _ := a[0].(string)
	act, _ := a[1].(string)
	at, _ := a[7].(float64)
	o := Op{ID: strings.ToLower(id), Action: act, At: int64(at)}
	if len(a) > 9 {
		if ids, ok := a[9].([]any); ok {
			for _, x := range ids {
				if s, ok := x.(string); ok {
					o.Closes = append(o.Closes, s)
				}
			}
		}
	}
	return o, o.ID != "" && o.Action != ""
}

type frameState struct {
	SessionKeys [][2]string `json:"sessionKeys"`
	Balance     *string     `json:"balance"`
	Funds       *struct {
		AvailableBalance string `json:"availableBalance"`
	} `json:"funds"`
}

type frame struct {
	Address         string          `json:"address"`
	AccountRevision int64           `json:"accountRevision"`
	BaseRevision    json.RawMessage `json:"baseAccountRevision"`
	State           *frameState     `json:"state"`
	OpenPositions   [][]any         `json:"openPositions"`
	Operations      [][]any         `json:"operations"`
	AddedPositions  [][]any         `json:"addedPositions"`
	RemovedPos      []string        `json:"removedPositionIds"`
	AddedOps        [][]any         `json:"addedOperations"`
	RemovedOps      []string        `json:"removedOperationIds"`
	IntentOutcomes  [][2]string     `json:"intentOutcomes"`
	ClosedPositions [][]any         `json:"closedPositions"` // [id, instrument, isLong, margin, leverage, liquidated, netPnl, paperMinted]
	frameState
}

func (a *Acct) merge(s *frameState) {
	if s.SessionKeys != nil {
		a.Sessions = map[string]int64{}
		for _, k := range s.SessionKeys {
			a.Sessions[strings.ToLower(k[0])], _ = strconv.ParseInt(k[1], 10, 64)
		}
	}
	if s.Balance != nil {
		a.Balance = Raw(*s.Balance, 18)
	}
	if s.Funds != nil {
		a.Avail = Raw(s.Funds.AvailableBalance, 18)
	}
}

// ApplyFrame returns the account after one stream frame, or an error when a patch does not follow prev
// (the caller reconnects for a fresh snapshot). prev is never modified.
func ApplyFrame(prev *Acct, b []byte) (*Acct, error) {
	var f frame
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	if f.BaseRevision == nil { // a snapshot
		a := &Acct{Rev: f.AccountRevision, Sessions: map[string]int64{}, Positions: map[string]Position{}, Ops: map[string]Op{}, Outcomes: map[string]string{}, Closed: map[string]Closed{}}
		if prev != nil { // what we saw settle before a reconnect still counts
			a.Outcomes, a.Closed = prev.Outcomes, prev.Closed
		}
		a.merge(&f.frameState)
		for _, r := range f.OpenPositions {
			if p, ok := parsePos(r); ok {
				a.Positions[p.ID] = p
			}
		}
		for _, r := range f.Operations {
			if o, ok := parseOp(r); ok {
				a.Ops[o.ID] = o
			}
		}
		return a, nil
	}
	var base int64
	if prev == nil || json.Unmarshal(f.BaseRevision, &base) != nil || base != prev.Rev {
		return nil, errors.New("a patch out of order")
	}
	a := &Acct{Rev: f.AccountRevision, Sessions: prev.Sessions, Avail: prev.Avail, Balance: prev.Balance,
		Positions: map[string]Position{}, Ops: map[string]Op{}, Outcomes: map[string]string{}, Closed: map[string]Closed{}}
	for k, v := range prev.Positions {
		a.Positions[k] = v
	}
	for k, v := range prev.Ops {
		a.Ops[k] = v
	}
	for k, v := range prev.Outcomes {
		a.Outcomes[k] = v
	}
	for k, v := range prev.Closed {
		a.Closed[k] = v
	}
	if f.State != nil {
		a.merge(f.State)
	}
	for _, id := range f.RemovedPos {
		delete(a.Positions, id)
	}
	for _, r := range f.AddedPositions {
		if p, ok := parsePos(r); ok {
			a.Positions[p.ID] = p
		}
	}
	for _, id := range f.RemovedOps {
		delete(a.Ops, strings.ToLower(id))
	}
	for _, r := range f.AddedOps {
		if o, ok := parseOp(r); ok {
			a.Ops[o.ID] = o
		}
	}
	for _, o := range f.IntentOutcomes {
		a.Outcomes[strings.ToLower(o[0])] = o[1]
	}
	for _, c := range f.ClosedPositions {
		if len(c) < 8 {
			continue
		}
		id, _ := c[0].(string)
		margin, _ := c[3].(string)
		liq, _ := c[5].(bool)
		pnl, _ := c[6].(string)
		paper, _ := c[7].(string)
		cl := Closed{PnL: Raw(pnl, 18), Paper: Raw(paper, 18), Liquidated: liq}
		if liq {
			cl.PnL = -Raw(margin, 18)
		}
		a.Closed[id] = cl
	}
	return a, nil
}

// Watcher follows one wallet's stream until ctx ends, reconnecting with backoff.
type Watcher struct {
	Addr  string
	mu    sync.Mutex
	acct  *Acct
	at    time.Time // last frame or heartbeat
	onAny func()    // called after every applied frame
}

func (w *Watcher) Account() (*Acct, time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.acct, w.at
}

var streamClient = &http.Client{Transport: paperTransport} // a stream: no overall timeout

func (w *Watcher) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := w.stream(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		log.Printf("account %s stream: %v; reconnecting in %s", ShortAddr(w.Addr), err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (w *Watcher) stream(parent context.Context) error {
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	req, _ := http.NewRequestWithContext(ctx, "GET", paperAPI+"/state/user/live?wallet="+w.Addr, nil)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", "paperfarm/1")
	res, err := streamClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("http %d", res.StatusCode)
	}
	quiet := time.AfterFunc(45*time.Second, func() { cancel(errors.New("silent for 45 s")) }) // heartbeats come every 10 s
	defer quiet.Stop()
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	var event string
	var data bytes.Buffer
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if event == "wallet" {
				w.mu.Lock()
				next, err := ApplyFrame(w.acct, data.Bytes())
				if err == nil {
					w.acct = next
				}
				w.mu.Unlock()
				if err != nil {
					return err
				}
			}
			if event != "" {
				quiet.Reset(45 * time.Second)
				w.mu.Lock()
				w.at = time.Now()
				w.mu.Unlock()
				if event == "wallet" && w.onAny != nil {
					w.onAny()
				}
			}
			event = ""
			data.Reset()
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data.WriteString(strings.TrimPrefix(line[5:], " "))
		}
	}
	if c := context.Cause(ctx); c != nil && parent.Err() == nil {
		return c
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return errors.New("stream ended")
}

// ShortAddr abbreviates an address for logs.
func ShortAddr(a string) string {
	if len(a) < 10 {
		return a
	}
	return a[:6] + "…" + a[len(a)-4:]
}
