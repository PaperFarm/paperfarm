// Package farm is the engine that runs every signed-in wallet's farms and pairs on the server, and the
// Trader that signs and sends their intents.
package farm

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"paperfarm/internal/paper"
)

// Pairs and farms. A pair is a long and a short of the same size, opened together and tracked by the
// intents that opened them. A farm keeps `Slots` pairs running: when one closes at its take-profit, the
// next opens. The server runs this for every signed-in wallet (engine.go); the browser only shows it.

const (
	openTTL  = 5 * time.Minute // an open not executed by then never executes: a leg filling late is worse than none
	closeTTL = time.Hour
)

type CloseRec struct {
	ID  string   `json:"id"`
	At  int64    `json:"at"`
	IDs []string `json:"ids"`
}

type PairRec struct {
	ID        string            `json:"id"`
	Coin      string            `json:"coin"`
	Notional  float64           `json:"notional"` // per leg, USD
	Lev       float64           `json:"lev"`
	TP        float64           `json:"tp"` // fraction of price
	Auto      bool              `json:"auto"`
	CreatedAt int64             `json:"createdAt"`
	Deadline  int64             `json:"deadline"` // ms
	Intents   map[string]string `json:"intents"`  // side -> opening intent
	Legs      map[string]string `json:"legs"`     // side -> position id, once seen
	Close     *CloseRec         `json:"close,omitempty"`
	Found     bool              `json:"found,omitempty"` // positions opened elsewhere, adopted
	Error     string            `json:"error,omitempty"`
	Archived  bool              `json:"archived,omitempty"`
	Farm      string            `json:"farm,omitempty"`
	Counted   bool              `json:"counted,omitempty"`
}

type Farm struct {
	ID           string  `json:"id"`
	Coin         string  `json:"coin"`
	Notional     float64 `json:"notional"`
	Lev          float64 `json:"lev"`
	TP           float64 `json:"tp"`
	Slots        int     `json:"slots"`
	Running      bool    `json:"running"`
	CreatedAt    int64   `json:"createdAt"`
	Opened       int     `json:"opened"`
	Closed       int     `json:"closed"`
	Paper        float64 `json:"paper"`
	PnL          float64 `json:"pnl"`
	LastOpen     int64   `json:"lastOpen"`
	BackoffUntil int64   `json:"backoffUntil"`
	Fails        int     `json:"fails"`
	Status       string  `json:"status,omitempty"`
}

var Sides = []string{"long", "short"}

type Leg struct {
	Status string // none, sending, queued, open, failed, closed
	Pos    *paper.Position
	Closed *paper.Closed
	Why    string
}

type PairView struct {
	Rec   *PairRec
	State string // sending, queued, partial, open, broken, closing, closed, failed
	Long  Leg
	Short Leg
	Entry float64
}

func (v PairView) Leg(side string) Leg {
	if side == "long" {
		return v.Long
	}
	return v.Short
}

func legOf(r *PairRec, side string, a *paper.Acct, now int64) Leg {
	pid, iid := r.Legs[side], r.Intents[side]
	if pid != "" {
		if p, ok := a.Positions[pid]; ok {
			return Leg{Status: "open", Pos: &p}
		}
		l := Leg{Status: "closed"}
		if c, ok := a.Closed[pid]; ok {
			l.Closed = &c
		}
		return l
	}
	if iid == "" {
		if r.Error != "" {
			return Leg{Status: "failed", Why: r.Error}
		}
		return Leg{Status: "none"}
	}
	for _, p := range a.Positions {
		if p.Intent == iid {
			p := p
			return Leg{Status: "open", Pos: &p}
		}
	}
	if _, ok := a.Ops[iid]; ok {
		return Leg{Status: "queued"}
	}
	if out := a.Outcomes[iid]; out != "" && out != "succeeded" {
		return Leg{Status: "failed", Why: paper.Reason(out)}
	} else if out == "succeeded" {
		return Leg{Status: "closed"} // opened and already gone (a fast liquidation)
	}
	if now > r.Deadline+60_000 {
		return Leg{Status: "failed", Why: "expired"}
	}
	return Leg{Status: "sending"}
}

// Derive is a pair against the live account: each leg's status and the pair's state.
func Derive(r *PairRec, a *paper.Acct, now int64) PairView {
	v := PairView{Rec: r, Long: legOf(r, "long", a, now), Short: legOf(r, "short", a, now)}
	count := func(st ...string) int {
		n := 0
		for _, l := range []Leg{v.Long, v.Short} {
			for _, s := range st {
				if l.Status == s {
					n++
				}
			}
		}
		return n
	}
	open, waiting, dead := count("open"), count("queued", "sending"), count("failed", "none")
	switch {
	case open == 2:
		v.State = "open"
	case open == 0 && waiting == 0:
		v.State = "failed"
		if count("closed") > 0 {
			v.State = "closed"
		}
	case waiting > 0 && dead == 0:
		switch {
		case open > 0:
			v.State = "partial"
		case count("sending") > 0 && count("queued") == 0:
			v.State = "sending"
		default:
			v.State = "queued"
		}
	default:
		v.State = "broken" // one side open or waiting, the other dead or gone
	}
	if r.Close != nil && open > 0 && (v.State == "open" || v.State == "broken") {
		v.State = "closing"
	}
	n := 0.0
	for _, l := range []Leg{v.Long, v.Short} {
		if l.Pos != nil {
			v.Entry += l.Pos.Entry
			n++
		}
	}
	if n > 0 {
		v.Entry /= n
	}
	return v
}

// SyncLegs records position ids for legs that opened. It reports whether anything changed.
func SyncLegs(recs []*PairRec, a *paper.Acct) bool {
	changed := false
	for _, r := range recs {
		for _, side := range Sides {
			iid := r.Intents[side]
			if r.Legs[side] != "" || iid == "" {
				continue
			}
			for _, p := range a.Positions {
				if p.Intent == iid {
					if r.Legs == nil {
						r.Legs = map[string]string{}
					}
					r.Legs[side] = p.ID
					changed = true
				}
			}
		}
	}
	return changed
}

// decide says what the engine should do with a pair now: "close", "cancel" or "".
func decide(v PairView, a *paper.Acct, mid float64, now int64) string {
	r := v.Rec
	if !r.Auto || mid <= 0 {
		return ""
	}
	if r.Close != nil && now-r.Close.At < 20_000 {
		return "" // give a sent close time
	}
	if r.Close != nil {
		if _, queued := a.Ops[r.Close.ID]; queued {
			return ""
		}
	}
	switch v.State {
	case "closing":
		return "close" // the earlier close did not take
	case "open":
		if v.Entry > 0 && math.Abs(mid/v.Entry-1) >= r.TP {
			return "close"
		}
	case "broken":
		open := v.Long.Status == "open" || v.Short.Status == "open"
		queued := v.Long.Status == "queued" || v.Short.Status == "queued"
		if !open {
			if queued {
				return "cancel" // the leg still queued must not fill alone
			}
			return ""
		}
		if queued || v.Long.Status == "sending" || v.Short.Status == "sending" {
			return ""
		}
		return "close" // one leg is open and the other never will be: close it
	}
	return ""
}

// farmNeeds is how many pairs a running farm should open now: its empty slots, at most one every 5 s.
func farmNeeds(f *Farm, views []PairView, now int64) int {
	if !f.Running || now < f.BackoffUntil || now-f.LastOpen < 5000 {
		return 0
	}
	live := 0
	for _, v := range views {
		if v.Rec.Farm == f.ID && !v.Rec.Archived && v.State != "closed" && v.State != "failed" {
			live++
		}
	}
	return max(0, f.Slots-live)
}

// tally books a finished farm pair into its farm, once. A pair that never opened backs the farm off
// (30 s, doubling, up to 10 min).
func tally(f *Farm, v PairView, now int64) bool {
	if v.Rec.Counted || v.Rec.Farm != f.ID || (v.State != "closed" && v.State != "failed") {
		return false
	}
	if v.State == "failed" {
		f.Fails++
		f.BackoffUntil = now + int64(math.Min(600_000, 30_000*math.Pow(2, float64(f.Fails-1))))
		why := v.Long.Why
		if why == "" {
			why = v.Short.Why
		}
		f.Status = fmt.Sprintf("A pair did not open (%s); retrying", or(why, "refused"))
	} else {
		f.Closed++
		f.Fails = 0
		for _, l := range []Leg{v.Long, v.Short} {
			if l.Closed != nil {
				f.Paper += l.Closed.Paper
				f.PnL += l.Closed.PnL
			}
		}
	}
	v.Rec.Counted = true
	return true
}

func or(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// ---- actions: each signs with the wallet's trading key and sends through Papertrade's API ----

type Trader struct {
	Paper  *paper.Client
	Key    *paper.Key // the wallet's trading (session) key
	User   string     // the wallet
	Lease  func(context.Context) error
	Save   func(*Doc) error                                                                 // writes the wallet's document now
	Submit func(ctx context.Context, action string, signed map[string]any, id string) error // Papertrade's intent endpoint; Paper.Submit unless stubbed
}

// notSent is an intent that never left this server, so Papertrade certainly does not have it.
type notSent struct{ error }

func (e notSent) Unwrap() error { return e.error }

func (t *Trader) send(ctx context.Context, action string, signed map[string]any, id string) error {
	if t.Lease != nil {
		if err := t.Lease(ctx); err != nil {
			return notSent{err}
		}
	}
	if t.Submit != nil {
		return t.Submit(ctx, action, signed, id)
	}
	return t.Paper.Submit(ctx, action, signed, id)
}

// refused reports whether Papertrade certainly does not have an intent that failed to send: it was never
// sent, or Papertrade answered with a refusal. A timeout or a dropped connection is not certain either way.
func refused(err error) bool {
	var ns notSent
	var ae *paper.APIError
	return errors.As(err, &ns) || errors.As(err, &ae)
}

func instrumentID(coin string) (int, error) {
	switch coin {
	case "BTC":
		return 0, nil
	case "ETH":
		return 1, nil
	}
	return 0, fmt.Errorf("unknown coin %q", coin)
}

// OpenPair signs both legs, records the pair with both intents and saves it, then sends the legs back to
// back so Papertrade queues them together. Saving first means a crash or a redeploy at any point after
// still knows the pair: whatever Papertrade does with an intent, the next process sees it by its id. A leg
// Papertrade certainly does not have is dropped from the record; one that may have landed stays until it
// shows up or expires. If the short cannot be sent, the long is cancelled while it still waits.
func (t *Trader) OpenPair(ctx context.Context, d *Doc, coin string, notional, lev, tp float64, auto bool, farm string) (*PairRec, error) {
	inst, err := instrumentID(coin)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(openTTL)
	leg := func(long bool) (map[string]any, string, error) {
		return paper.Sign(t.Key, "exchange", "OpenPosition", t.User, map[string]any{
			"instrumentId": inst, "isLong": long, "size": paper.USDRaw(notional / lev), "leverage": int(lev), "useDebt": false, "deadline": deadline.Unix()})
	}
	L, lid, err := leg(true)
	if err != nil {
		return nil, err
	}
	S, sid, err := leg(false)
	if err != nil {
		return nil, err
	}
	r := &PairRec{ID: lid[2:14], Coin: coin, Notional: notional, Lev: lev, TP: tp, Auto: auto, CreatedAt: time.Now().UnixMilli(),
		Deadline: deadline.UnixMilli(), Intents: map[string]string{"long": lid, "short": sid}, Legs: map[string]string{}, Farm: farm}
	d.Add(r)
	unsent := func(err error, sides ...string) {
		d.Update(func() {
			r.Error = err.Error()
			for _, side := range sides {
				delete(r.Intents, side)
			}
		})
	}
	if t.Save != nil {
		if err := t.Save(d); err != nil {
			unsent(fmt.Errorf("could not record the pair, so nothing was sent: %w", err), "long", "short")
			return r, err
		}
	}
	if err := t.send(ctx, "openPosition", L, lid); err != nil {
		if refused(err) {
			unsent(err, "long", "short")
		} else {
			unsent(err, "short") // the long may have landed: it stays known and is closed if it opens alone
		}
		return r, err
	}
	if err := t.send(ctx, "openPosition", S, sid); err != nil {
		if refused(err) {
			unsent(err, "short")
		} else {
			d.Update(func() { r.Error = err.Error() })
		}
		if cerr := t.Cancel(ctx, lid); cerr != nil {
			log.Printf("pair %s: the short failed and the long could not be cancelled (%v); the engine closes it if it fills", r.ID, cerr)
		}
		return r, err
	}
	return r, nil
}

// ClosePair closes whatever legs are open, in one intent.
func (t *Trader) ClosePair(ctx context.Context, d *Doc, v PairView) error {
	var ids []string
	for _, l := range []Leg{v.Long, v.Short} {
		if l.Pos != nil {
			ids = append(ids, l.Pos.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	return t.ClosePositions(ctx, ids, func(id string) {
		d.Update(func() { v.Rec.Close = &CloseRec{ID: id, At: time.Now().UnixMilli(), IDs: ids} })
	})
}

func (t *Trader) ClosePositions(ctx context.Context, ids []string, record func(intent string)) error {
	signed, id, err := paper.Sign(t.Key, "exchange", "Close", t.User, map[string]any{"positionIds": ids, "deadline": time.Now().Add(closeTTL).Unix()})
	if err != nil {
		return err
	}
	if record != nil {
		record(id)
	}
	err = t.send(ctx, "closePositions", signed, id)
	var ae *paper.APIError
	if errors.As(err, &ae) && strings.Contains(string(ae.Body), "noOpenPositions") {
		return nil // already closed or closing
	}
	return err
}

// HedgeLeg opens `side` for a pair whose other leg is open alone, at that leg's size and leverage.
func (t *Trader) HedgeLeg(ctx context.Context, d *Doc, r *PairRec, side string) error {
	inst, err := instrumentID(r.Coin)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(openTTL)
	signed, id, err := paper.Sign(t.Key, "exchange", "OpenPosition", t.User, map[string]any{
		"instrumentId": inst, "isLong": side == "long", "size": paper.USDRaw(r.Notional / r.Lev), "leverage": int(r.Lev), "useDebt": false, "deadline": deadline.Unix()})
	if err != nil {
		return err
	}
	d.Update(func() {
		r.Intents[side] = id
		delete(r.Legs, side)
		r.Deadline, r.Error, r.Close = deadline.UnixMilli(), "", nil
	})
	if err := t.send(ctx, "openPosition", signed, id); err != nil {
		d.Update(func() { r.Error = err.Error() })
		return err
	}
	return nil
}

func (t *Trader) Cancel(ctx context.Context, intent string) error {
	if err := t.Lease(ctx); err != nil {
		return err
	}
	return t.Paper.CancelIntent(ctx, t.Key, t.User, intent)
}
