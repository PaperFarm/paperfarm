package farm

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"testing"

	"paperfarm/internal/paper"
)

// The same lifecycle the browser checks (web/src/lib/pairs.check.ts), on the server's engine.

const (
	iL = "0x" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	iS = "0x" + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	iC = "0x" + "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

func posRow(id string, long bool, intent string) string {
	bust := "760000"
	if !long {
		bust = "910000"
	}
	return fmt.Sprintf(`["%s",0,%v,false,"834995","100000000000000000000",10,"%s",1791969000000,"%s"]`, id, long, bust, intent)
}

func opRow(id string) string {
	return fmt.Sprintf(`["%s","openPosition",0,true,false,"100000000000000000000",10,1791969000000,"1791969300",null]`, id)
}

func snapshot(t *testing.T, pos []string, ops []string) *paper.Acct {
	t.Helper()
	b := fmt.Sprintf(`{"accountRevision":1,"funds":{"availableBalance":"1000000000000000000000"},"openPositions":[%s],"operations":[%s]}`, join(pos), join(ops))
	a, err := paper.ApplyFrame(nil, []byte(b))
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func join(xs []string) string {
	s := ""
	for i, x := range xs {
		if i > 0 {
			s += ","
		}
		s += x
	}
	return s
}

func rec() *PairRec {
	return &PairRec{ID: "x", Coin: "BTC", Notional: 1000, Lev: 10, TP: 0.005, Auto: true, Deadline: 300_000,
		Intents: map[string]string{"long": iL, "short": iS}, Legs: map[string]string{}}
}

const now = 100_000

func TestPairLifecycle(t *testing.T) {
	eq := func(name string, got, want any) {
		t.Helper()
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s: got %v want %v", name, got, want)
		}
	}
	eq("both queued", Derive(rec(), snapshot(t, nil, []string{opRow(iL), opRow(iS)}), now).State, "queued")
	eq("one filled", Derive(rec(), snapshot(t, []string{posRow("1", true, iL)}, []string{opRow(iS)}), now).State, "partial")

	a := snapshot(t, []string{posRow("1", true, iL), posRow("2", false, iS)}, nil)
	r := rec()
	eq("sync records legs", SyncLegs([]*PairRec{r}, a), true)
	eq("legs", r.Legs["long"]+"/"+r.Legs["short"], "1/2")
	v := Derive(r, a, now)
	eq("open", v.State, "open")
	eq("entry", v.Entry, 83499.5)
	eq("below TP holds", decide(v, a, 83499.5*1.004, now), "")
	eq("at TP closes", decide(v, a, 83499.5*1.0051, now), "close")
	eq("no price, no decision", decide(v, a, 0, now), "")

	alone := snapshot(t, []string{posRow("1", true, iL)}, nil)
	eq("expired short → broken", Derive(rec(), alone, 400_000).State, "broken")
	eq("broken closes the survivor", decide(Derive(rec(), alone, 400_000), alone, 1, 400_000), "close")
	failed := &PairRec{ID: "y", Coin: "BTC", Auto: true, Deadline: 300_000, Intents: map[string]string{"long": iL}, Legs: map[string]string{}, Error: "refused"}
	eq("failed short, queued long → cancel", decide(Derive(failed, snapshot(t, nil, []string{opRow(iL)}), now), a, 1, now), "cancel")

	// A patch: the close executes and both positions leave with their results.
	patch := fmt.Sprintf(`{"accountRevision":2,"baseAccountRevision":1,"removedPositionIds":["1","2"],"intentOutcomes":[["%s","succeeded"]],
		"closedPositions":[["1",0,true,"100000000000000000000",10,false,"4100000000000000000","0"],["2",0,false,"100000000000000000000",10,false,"-5000000000000000000","110500000000000000000"]]}`, iC)
	a2, err := paper.ApplyFrame(a, []byte(patch))
	if err != nil {
		t.Fatal(err)
	}
	r.Close = &CloseRec{ID: iC}
	done := Derive(r, a2, now)
	eq("closed", done.State, "closed")
	eq("results", fmt.Sprint(done.Long.Closed.PnL, done.Short.Closed.Paper), "4.1 110.5")
	if _, err := paper.ApplyFrame(a2, []byte(`{"accountRevision":9,"baseAccountRevision":7}`)); err == nil {
		t.Error("a patch out of order was applied")
	}
	if len(a.Positions) != 2 {
		t.Error("applying a patch changed the previous account")
	}

	// Re-hedging: the long open alone, a new short intent queued, then filled.
	rh := &PairRec{ID: "z", Coin: "BTC", Auto: true, Deadline: 900_000, Intents: map[string]string{"long": iL, "short": iC}, Legs: map[string]string{"long": "1"}}
	eq("re-hedge queued", Derive(rh, snapshot(t, []string{posRow("1", true, iL)}, []string{opRow(iC)}), now).State, "partial")
	eq("re-hedge filled", Derive(rh, snapshot(t, []string{posRow("1", true, iL), posRow("9", false, iC)}, nil), now).State, "open")

	// Farms: fill empty slots, wait between opens, book finished pairs once, back off on failure.
	f := &Farm{ID: "F", Slots: 2, Running: true}
	live := rec()
	live.Farm = "F"
	lv := Derive(live, a, now)
	eq("farm fills its empty slot", farmNeeds(f, []PairView{lv}, now), 1)
	eq("farm waits 5 s between opens", farmNeeds(&Farm{ID: "F", Slots: 2, Running: true, LastOpen: now - 1000}, []PairView{lv}, now), 0)
	eq("a stopped farm opens nothing", farmNeeds(&Farm{ID: "F", Slots: 2}, nil, now), 0)
	r.Farm = "F"
	dv := Derive(r, a2, now)
	eq("a closed pair frees its slot", farmNeeds(f, []PairView{dv}, now), 2)
	eq("tally books once", fmt.Sprint(tally(f, dv, now), tally(f, dv, now), f.Closed, math.Round(f.PnL*10)/10, f.Paper), "true false 1 -0.9 110.5")
	ff := &Farm{ID: "F", Slots: 1, Running: true}
	bad := &PairRec{ID: "w", Farm: "F", Intents: map[string]string{}, Legs: map[string]string{}, Error: "refused"}
	tally(ff, Derive(bad, snapshot(t, nil, nil), now), now)
	eq("a failed pair backs the farm off", fmt.Sprint(ff.Fails, ff.BackoffUntil-now, farmNeeds(ff, nil, now+1000)), "1 30000 0")
}

// A crash or redeploy at any moment of an open must leave the pair known: both intents are saved before
// either is sent. A leg Papertrade certainly refused is dropped; one that may have landed is kept.
func TestOpenPairSavesBeforeSending(t *testing.T) {
	key, _ := paper.ParseKey("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318") // well-known public example key; test fixture only
	newDoc := func() *Doc { return &Doc{Address: "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23"} }
	var saved []byte
	save := func(d *Doc) error { b, err := json.Marshal(d); saved = b; return err }
	onDisk := func() *PairRec { // what a restarted server would load
		var d Doc
		if err := json.Unmarshal(saved, &d); err != nil || len(d.Pairs) != 1 {
			t.Fatalf("nothing saved: %v", err)
		}
		return d.Pairs[0]
	}

	// Every send finds the pair, with both intents, already on disk.
	d, sends := newDoc(), 0
	tr := &Trader{Key: key, User: d.Address, Save: save, Submit: func(_ context.Context, _ string, _ map[string]any, id string) error {
		sends++
		if r := onDisk(); r.Intents["long"] == "" || r.Intents["short"] == "" {
			t.Fatalf("send %d before both intents were saved: %v", sends, r.Intents)
		}
		return nil
	}}
	if _, err := tr.OpenPair(context.Background(), d, "BTC", 1000, 10, 0.005, true, ""); err != nil || sends != 2 {
		t.Fatalf("open: %v after %d sends", err, sends)
	}

	// Papertrade refuses the long: neither leg can exist, so the pair is failed at once.
	d = newDoc()
	tr.Submit = func(context.Context, string, map[string]any, string) error {
		return &paper.APIError{Status: 400, Body: []byte(`{"code":"tooLarge"}`)}
	}
	r, _ := tr.OpenPair(context.Background(), d, "BTC", 1000, 10, 0.005, true, "")
	if v := Derive(r, snapshot(t, nil, nil), r.CreatedAt); v.State != "failed" || len(r.Intents) != 0 {
		t.Fatalf("refused long: state %s, intents %v", v.State, r.Intents)
	}

	// The long times out: it may have landed, so it stays known (and the short, never sent, does not).
	d = newDoc()
	tr.Submit = func(context.Context, string, map[string]any, string) error { return context.DeadlineExceeded }
	r, _ = tr.OpenPair(context.Background(), d, "BTC", 1000, 10, 0.005, true, "")
	if r.Intents["long"] == "" || r.Intents["short"] != "" {
		t.Fatalf("timed-out long: intents %v", r.Intents)
	}
	if v := Derive(r, snapshot(t, nil, nil), r.CreatedAt); v.Long.Status != "sending" || v.Short.Status != "failed" {
		t.Fatalf("timed-out long: long %s short %s", v.Long.Status, v.Short.Status)
	}
}
