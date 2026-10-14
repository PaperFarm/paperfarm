package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"paperfarm/internal/auth"
	"paperfarm/internal/farm"
	"paperfarm/internal/paper"
)

// The signed-in API. A wallet signs in with a message signature; every /api/me call then acts on that
// wallet only. The server holds each wallet's trading key (it can open and close positions on
// Papertrade, never withdraw) and runs its farms in package farm.

type server struct {
	e     *farm.Engine
	paper *paper.Client
	auth  *auth.Auth
	seal  *auth.Sealer
}

const maxFarms = 10

func (api *server) routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/challenge", api.challenge)
	mux.HandleFunc("POST /api/auth/verify", api.verify)
	mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		api.auth.ClearSession(w)
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/me", api.me)
	me := func(pattern string, h func(w http.ResponseWriter, r *http.Request, d *farm.Doc)) {
		mux.HandleFunc(pattern, api.signedIn(h))
	}
	me("POST /api/me/key", api.newKey)
	me("POST /api/me/key/register", api.registerKey)
	me("POST /api/me/farms", api.createFarm)
	me("PATCH /api/me/farms/{id}", api.patchFarm)
	me("POST /api/me/farms/{id}/stop", api.stopFarm)
	me("DELETE /api/me/farms/{id}", api.deleteFarm)
	me("POST /api/me/pairs", api.openPair)
	me("PATCH /api/me/pairs/{id}", api.patchPair)
	me("POST /api/me/pairs/{id}/close", api.closePair)
	me("POST /api/me/pairs/{id}/hedge", api.hedgePair)
	me("POST /api/me/positions/close", api.closePositions)
	me("POST /api/me/positions/hedge", api.hedgePosition)
	me("POST /api/me/positions/track", api.trackPositions)
	me("POST /api/me/intents/{id}/cancel", api.cancelIntent)
	me("PUT /api/me/board", api.putBoard)
}

// ---- helpers ----

func readJSON(r *http.Request, v any) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func bad(w http.ResponseWriter, msg string, a ...any) {
	httpErr(w, http.StatusBadRequest, errString(fmt.Sprintf(msg, a...)))
}

func (api *server) signedIn(h func(http.ResponseWriter, *http.Request, *farm.Doc)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := api.auth.User(r, time.Now())
		if user == "" {
			httpErr(w, http.StatusUnauthorized, errString("sign in first"))
			return
		}
		// A cross-site form cannot set this header; together with SameSite=Strict it stops CSRF.
		if r.Method != http.MethodGet && r.Header.Get("X-PF") != "1" {
			httpErr(w, http.StatusForbidden, errString("missing request header"))
			return
		}
		d, err := api.e.Doc(user)
		if err != nil {
			httpErr(w, http.StatusInternalServerError, err)
			return
		}
		h(w, r, d)
		if err := api.e.Save(d); err != nil {
			log.Printf("account %s: save: %v", paper.ShortAddr(user), err)
		}
	}
}

func (api *server) trader(w http.ResponseWriter, d *farm.Doc) *farm.Trader {
	t, err := api.e.Trader(d)
	if err != nil {
		httpErr(w, http.StatusConflict, err)
		return nil
	}
	return t
}

func ctx30(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 30*time.Second)
}

// spec checks a pair's settings against Papertrade's live limits.
func (api *server) spec(ctx context.Context, coin string, notional, lev, tp float64) error {
	m, err := api.e.Market(ctx)
	if err != nil {
		return fmt.Errorf("Papertrade data unavailable: %w", err)
	}
	c, ok := m.Coins[coin]
	switch {
	case !ok:
		return fmt.Errorf("unknown coin %q", coin)
	case math.IsNaN(notional) || math.IsNaN(lev) || math.IsNaN(tp):
		return errors.New("bad number")
	case lev < 1 || lev > float64(c.MaxLeverage) || lev != math.Trunc(lev):
		return fmt.Errorf("leverage must be a whole number from 1 to %d", c.MaxLeverage)
	case notional < m.MinNotional || notional > c.MaxNotional:
		return fmt.Errorf("size per leg must be between $%.0f and $%.0f", m.MinNotional, c.MaxNotional)
	case notional/lev < m.MinMargin:
		return fmt.Errorf("each leg needs at least $%.0f of margin (size ÷ leverage)", m.MinMargin)
	case tp < 0.001 || tp > 0.05:
		return errors.New("take-profit must be between 0.1% and 5%")
	}
	return nil
}

// ---- auth ----

func (api *server) challenge(w http.ResponseWriter, r *http.Request) {
	var in struct{ Address string }
	if readJSON(r, &in) != nil || !common.IsHexAddress(in.Address) {
		bad(w, "not an address")
		return
	}
	writeJSON(w, map[string]string{"message": api.auth.Challenge(strings.ToLower(in.Address), r.Host, time.Now())})
}

func (api *server) verify(w http.ResponseWriter, r *http.Request) {
	var in struct{ Address, Signature string }
	if readJSON(r, &in) != nil || !common.IsHexAddress(in.Address) {
		bad(w, "not an address")
		return
	}
	addr := strings.ToLower(in.Address)
	if err := api.auth.Verify(addr, in.Signature, time.Now()); err != nil {
		httpErr(w, http.StatusUnauthorized, err)
		return
	}
	api.auth.SetSession(w, addr, time.Now(), isHTTPS(r))
	writeJSON(w, map[string]string{"address": addr})
}

// me is what the browser polls: the signed-in wallet, its trading key, farms and pairs.
func (api *server) me(w http.ResponseWriter, r *http.Request) {
	user := api.auth.User(r, time.Now())
	if user == "" {
		writeJSON(w, map[string]any{"address": nil})
		return
	}
	d, err := api.e.Doc(user)
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err)
		return
	}
	d.Lock()
	defer d.Unlock()
	var key map[string]any
	if d.Key != nil {
		reg := int64(0)
		if a := api.e.Account(user); a != nil {
			reg = a.Sessions[d.Key.Addr]
		}
		key = map[string]any{"address": d.Key.Addr, "expiry": d.Key.Expiry, "registeredUntil": reg}
	}
	pairs := []*farm.PairRec{}
	for _, p := range d.Pairs {
		if !p.Archived {
			pairs = append(pairs, p)
		}
	}
	writeJSON(w, map[string]any{"address": user, "key": key, "farms": orEmpty(d.Farms), "pairs": pairs, "board": d.Board})
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// ---- the trading key ----

const keyDays = 7

// newKey creates the wallet's next trading key on the server (it never leaves it) and returns what the
// wallet must sign to register it on Papertrade.
func (api *server) newKey(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	k := paper.NewKey()
	expiry := time.Now().Add(keyDays * 24 * time.Hour).Unix()
	d.Update(func() {
		d.Key = &farm.SealedKey{Sealed: api.seal.Seal([]byte(k.Hex()), d.Address), Addr: k.Addr, Expiry: expiry}
	})
	writeJSON(w, map[string]any{"key": k.Addr, "expiry": expiry, "feeAddress": paper.ZeroAddr})
}

// registerKey forwards the wallet's signed RegisterSessionKey, after checking it names this wallet and
// the key the server holds for it, then starts the wallet's farmer.
func (api *server) registerKey(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	var in struct{ Signed map[string]any }
	if readJSON(r, &in) != nil || in.Signed == nil {
		bad(w, "missing signed registration")
		return
	}
	d.Lock()
	k := d.Key
	d.Unlock()
	str := func(k string) string { s, _ := in.Signed[k].(string); return strings.ToLower(s) }
	switch {
	case k == nil:
		bad(w, "ask for a trading key first")
		return
	case str("user") != d.Address || str("key") != k.Addr || str("expiry") != fmt.Sprint(k.Expiry):
		bad(w, "that registration is not for this wallet's trading key")
		return
	}
	ctx, cancel := ctx30(r)
	defer cancel()
	b, _ := json.Marshal(map[string]any{"action": "registerSessionKey", "signed": in.Signed})
	if out, err := api.paper.Do(ctx, "POST", "/intents", b); err != nil {
		var ae *paper.APIError
		if errors.As(err, &ae) && !strings.Contains(string(ae.Body), "intent_conflict") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(ae.Status)
			w.Write(out) // Papertrade's own answer, for the browser to explain
			return
		} else if !errors.As(err, &ae) {
			httpErr(w, http.StatusBadGateway, err)
			return
		}
	}
	api.e.Start(d.Address)
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- farms ----

// farmIn is a new farm, or a one-off pair (Slots unused, Auto optional).
type farmIn struct {
	Coin     string  `json:"coin"`
	Notional float64 `json:"notional"`
	Lev      float64 `json:"lev"`
	TP       float64 `json:"tp"`
	Slots    int     `json:"slots"`
	Auto     *bool   `json:"auto"`
}

func (api *server) createFarm(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	var in farmIn
	if readJSON(r, &in) != nil {
		bad(w, "bad request")
		return
	}
	in.Coin = strings.ToUpper(in.Coin)
	ctx, cancel := ctx30(r)
	defer cancel()
	if err := api.spec(ctx, in.Coin, in.Notional, in.Lev, in.TP); err != nil {
		bad(w, "%v", err)
		return
	}
	if in.Slots < 1 || in.Slots > 10 {
		bad(w, "pairs at a time must be 1 to 10")
		return
	}
	d.Lock()
	n, hasKey := len(d.Farms), d.Key != nil
	d.Unlock()
	if !hasKey {
		httpErr(w, http.StatusConflict, errString("set up a trading key first"))
		return
	}
	if n >= maxFarms {
		bad(w, "at most %d farms", maxFarms)
		return
	}
	f := &farm.Farm{ID: "f" + paper.NewKey().Addr[2:12], Coin: in.Coin, Notional: in.Notional, Lev: in.Lev, TP: in.TP, Slots: in.Slots, Running: true, CreatedAt: time.Now().UnixMilli()}
	d.Update(func() { d.Farms = append(d.Farms, f) })
	api.e.Start(d.Address)
	writeJSON(w, f)
}

func (api *server) farm(w http.ResponseWriter, r *http.Request, d *farm.Doc) *farm.Farm {
	id := r.PathValue("id")
	d.Lock()
	defer d.Unlock()
	for _, f := range d.Farms {
		if f.ID == id {
			return f
		}
	}
	httpErr(w, http.StatusNotFound, errString("no such farm"))
	return nil
}

func (api *server) patchFarm(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	f := api.farm(w, r, d)
	if f == nil {
		return
	}
	var in struct {
		Running *bool    `json:"running"`
		TP      *float64 `json:"tp"`
		Slots   *int     `json:"slots"`
	}
	if readJSON(r, &in) != nil {
		bad(w, "bad request")
		return
	}
	if in.TP != nil && (*in.TP < 0.001 || *in.TP > 0.05) {
		bad(w, "take-profit must be between 0.1%% and 5%%")
		return
	}
	if in.Slots != nil && (*in.Slots < 1 || *in.Slots > 10) {
		bad(w, "pairs at a time must be 1 to 10")
		return
	}
	d.Update(func() {
		if in.Running != nil {
			f.Running = *in.Running
			if f.Running {
				f.BackoffUntil, f.Fails, f.Status = 0, 0, ""
			}
		}
		if in.TP != nil {
			f.TP = *in.TP
			for _, p := range d.Pairs { // its open pairs follow at once
				if p.Farm == f.ID && !p.Counted {
					p.TP = *in.TP
				}
			}
		}
		if in.Slots != nil {
			f.Slots = *in.Slots
		}
	})
	writeJSON(w, f)
}

// stopFarm stops opening and closes every pair the farm has open.
func (api *server) stopFarm(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	f := api.farm(w, r, d)
	if f == nil {
		return
	}
	d.Update(func() { f.Running = false })
	t := api.trader(w, d)
	if t == nil {
		return
	}
	a := api.e.Account(d.Address)
	if a == nil {
		httpErr(w, http.StatusServiceUnavailable, errString("the account is not streaming yet; try again"))
		return
	}
	ctx, cancel := ctx30(r)
	defer cancel()
	now := time.Now().UnixMilli()
	d.Lock()
	var views []farm.PairView
	for _, p := range d.Pairs {
		if p.Farm == f.ID && !p.Archived {
			views = append(views, farm.Derive(p, a, now))
		}
	}
	d.Unlock()
	n := 0
	for _, v := range views {
		if v.Long.Pos != nil || v.Short.Pos != nil {
			if err := t.ClosePair(ctx, d, v); err != nil {
				httpErr(w, http.StatusBadGateway, err)
				return
			}
			n++
		}
	}
	writeJSON(w, map[string]int{"closing": n})
}

func (api *server) deleteFarm(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	f := api.farm(w, r, d)
	if f == nil {
		return
	}
	if f.Running {
		bad(w, "pause or stop the farm first")
		return
	}
	d.Update(func() {
		out := d.Farms[:0]
		for _, x := range d.Farms {
			if x != f {
				out = append(out, x)
			}
		}
		d.Farms = out
	})
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- pairs ----

func (api *server) openPair(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	var in farmIn
	if readJSON(r, &in) != nil {
		bad(w, "bad request")
		return
	}
	in.Coin = strings.ToUpper(in.Coin)
	ctx, cancel := ctx30(r)
	defer cancel()
	if err := api.spec(ctx, in.Coin, in.Notional, in.Lev, in.TP); err != nil {
		bad(w, "%v", err)
		return
	}
	t := api.trader(w, d)
	if t == nil {
		return
	}
	if m, err := api.e.Market(ctx); err == nil { // the check Papertrade's own order form makes before sending
		if room := m.PairRoom(in.Coin, api.e.Mid(in.Coin)); in.Notional > room {
			bad(w, "Papertrade's open interest limit leaves room for $%.0f a leg right now", room)
			return
		}
	}
	auto := in.Auto == nil || *in.Auto
	p, err := t.OpenPair(ctx, d, in.Coin, in.Notional, in.Lev, in.TP, auto, "")
	if err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	api.e.Start(d.Address)
	writeJSON(w, p)
}

func (api *server) pair(w http.ResponseWriter, r *http.Request, d *farm.Doc) *farm.PairRec {
	id := r.PathValue("id")
	d.Lock()
	defer d.Unlock()
	for _, p := range d.Pairs {
		if p.ID == id {
			return p
		}
	}
	httpErr(w, http.StatusNotFound, errString("no such pair"))
	return nil
}

func (api *server) patchPair(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	p := api.pair(w, r, d)
	if p == nil {
		return
	}
	var in struct {
		TP       *float64 `json:"tp"`
		Auto     *bool    `json:"auto"`
		Archived *bool    `json:"archived"`
	}
	if readJSON(r, &in) != nil {
		bad(w, "bad request")
		return
	}
	if in.TP != nil && (*in.TP < 0.001 || *in.TP > 0.05) {
		bad(w, "take-profit must be between 0.1%% and 5%%")
		return
	}
	d.Update(func() {
		if in.TP != nil {
			p.TP = *in.TP
		}
		if in.Auto != nil {
			p.Auto = *in.Auto
		}
		if in.Archived != nil {
			p.Archived = *in.Archived
		}
	})
	writeJSON(w, p)
}

// view derives a pair against the live account.
func (api *server) view(w http.ResponseWriter, d *farm.Doc, p *farm.PairRec) (farm.PairView, bool) {
	a := api.e.Account(d.Address)
	if a == nil {
		httpErr(w, http.StatusServiceUnavailable, errString("the account is not streaming yet; try again"))
		return farm.PairView{}, false
	}
	d.Lock()
	defer d.Unlock()
	return farm.Derive(p, a, time.Now().UnixMilli()), true
}

func (api *server) closePair(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	p := api.pair(w, r, d)
	if p == nil {
		return
	}
	t := api.trader(w, d)
	if t == nil {
		return
	}
	v, ok := api.view(w, d, p)
	if !ok {
		return
	}
	ctx, cancel := ctx30(r)
	defer cancel()
	if err := t.ClosePair(ctx, d, v); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (api *server) hedgePair(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	p := api.pair(w, r, d)
	if p == nil {
		return
	}
	t := api.trader(w, d)
	if t == nil {
		return
	}
	v, ok := api.view(w, d, p)
	if !ok {
		return
	}
	side := ""
	switch {
	case v.State != "broken":
	case v.Long.Pos != nil && v.Short.Pos == nil:
		side = "short"
	case v.Short.Pos != nil && v.Long.Pos == nil:
		side = "long"
	}
	if side == "" {
		bad(w, "only a pair with one leg open alone can be re-hedged")
		return
	}
	ctx, cancel := ctx30(r)
	defer cancel()
	if err := t.HedgeLeg(ctx, d, p, side); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]string{"opening": side})
}

// ---- positions opened elsewhere ----

func (api *server) positions(w http.ResponseWriter, d *farm.Doc, ids ...string) ([]paper.Position, bool) {
	a := api.e.Account(d.Address)
	if a == nil {
		httpErr(w, http.StatusServiceUnavailable, errString("the account is not streaming yet; try again"))
		return nil, false
	}
	var out []paper.Position
	for _, id := range ids {
		p, ok := a.Positions[id]
		if !ok {
			bad(w, "position %s is not open on this account", id)
			return nil, false
		}
		out = append(out, p)
	}
	return out, true
}

func (api *server) closePositions(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	var in struct{ IDs []string }
	if readJSON(r, &in) != nil || len(in.IDs) == 0 || len(in.IDs) > 20 {
		bad(w, "name 1 to 20 positions")
		return
	}
	if _, ok := api.positions(w, d, in.IDs...); !ok {
		return
	}
	t := api.trader(w, d)
	if t == nil {
		return
	}
	ctx, cancel := ctx30(r)
	defer cancel()
	if err := t.ClosePositions(ctx, in.IDs, nil); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// hedgePosition turns a lone position into a tracked pair by opening its opposite leg.
func (api *server) hedgePosition(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	var in struct{ ID string }
	if readJSON(r, &in) != nil {
		bad(w, "bad request")
		return
	}
	ps, ok := api.positions(w, d, in.ID)
	if !ok {
		return
	}
	t := api.trader(w, d)
	if t == nil {
		return
	}
	p := ps[0]
	side, other := "long", "short"
	if !p.Long {
		side, other = "short", "long"
	}
	rec := &farm.PairRec{ID: "h" + p.ID, Coin: p.Coin, Notional: p.Margin * p.Leverage, Lev: p.Leverage, TP: 0.005, CreatedAt: p.OpenedAt,
		Intents: map[string]string{side: p.Intent}, Legs: map[string]string{side: p.ID}, Found: true}
	d.Add(rec)
	ctx, cancel := ctx30(r)
	defer cancel()
	if err := t.HedgeLeg(ctx, d, rec, other); err != nil {
		httpErr(w, http.StatusBadGateway, err)
		return
	}
	api.e.Start(d.Address)
	writeJSON(w, rec)
}

// trackPositions adopts a long and a short opened elsewhere as a pair.
func (api *server) trackPositions(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	var in struct{ Long, Short string }
	if readJSON(r, &in) != nil {
		bad(w, "bad request")
		return
	}
	ps, ok := api.positions(w, d, in.Long, in.Short)
	if !ok {
		return
	}
	l, s := ps[0], ps[1]
	if !l.Long || s.Long || l.Coin != s.Coin {
		bad(w, "track a long and a short of the same coin")
		return
	}
	rec := &farm.PairRec{ID: "t" + l.ID, Coin: l.Coin, Notional: l.Margin * l.Leverage, Lev: l.Leverage, TP: 0.005, CreatedAt: min(l.OpenedAt, s.OpenedAt),
		Intents: map[string]string{"long": l.Intent, "short": s.Intent}, Legs: map[string]string{"long": l.ID, "short": s.ID}, Found: true}
	d.Add(rec)
	api.e.Start(d.Address)
	writeJSON(w, rec)
}

func (api *server) cancelIntent(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	id := strings.ToLower(r.PathValue("id"))
	if len(id) != 66 || !strings.HasPrefix(id, "0x") {
		bad(w, "not an intent id")
		return
	}
	a := api.e.Account(d.Address)
	if a == nil || a.Ops[id].ID == "" {
		bad(w, "that intent is not waiting in this account's queue")
		return
	}
	t := api.trader(w, d)
	if t == nil {
		return
	}
	ctx, cancel := ctx30(r)
	defer cancel()
	if err := t.Cancel(ctx, id); err != nil {
		httpErr(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// putBoard keeps the wallet's window layout so it follows the wallet to any browser.
func (api *server) putBoard(w http.ResponseWriter, r *http.Request, d *farm.Doc) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 16<<10+1))
	if err != nil || len(b) > 16<<10 || !json.Valid(b) || len(b) == 0 || b[0] != '{' {
		bad(w, "bad layout")
		return
	}
	d.Update(func() { d.Board = b })
	writeJSON(w, map[string]any{"ok": true})
}
