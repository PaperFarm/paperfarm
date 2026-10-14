// Package canary is `paperfarm canary`: one real hedged pair, end to end, from a key in an env file.
package canary

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"paperfarm/internal/dotenv"
	"paperfarm/internal/farm"
	"paperfarm/internal/paper"
)

// Run runs one real pair end to end through the same code the farms use (Watcher, Trader, derive):
// register a trading key if needed, open a long and a short together, wait for both through Papertrade's
// queue, hold, close both in one intent, and print what it cost and minted. It spends real money (cents
// at the defaults) and asks before sending anything.
func Run(args []string) {
	fl := flag.NewFlagSet("canary", flag.ExitOnError)
	envFile := fl.String("env", "", "env file holding the wallet key")
	keyVar := fl.String("key-var", "WALLET_KEY", "variable in that file (or the environment) holding the key")
	coin := fl.String("coin", "BTC", "BTC or ETH")
	notional := fl.Float64("notional", 1000, "size per leg, USD")
	lev := fl.Float64("lev", 100, "leverage")
	hold := fl.Duration("hold", 30*time.Second, "how long to hold once both legs are open")
	sessFile := fl.String("session", "data/canary-session.json", "where the trading key is kept between runs")
	yes := fl.Bool("yes", false, "skip the confirmation")
	fl.Parse(args)

	keyHex := os.Getenv(*keyVar)
	if *envFile != "" {
		if v := dotenv.Load(*envFile)[*keyVar]; v != "" {
			keyHex = v
		}
	}
	wallet, err := paper.ParseKey(keyHex)
	if err != nil {
		log.Fatalf("%s: %v (pass -env and -key-var)", *keyVar, err)
	}
	ctx := context.Background()
	p := paper.New()
	m, err := p.Market(ctx)
	if err != nil {
		log.Fatal(err)
	}
	c := strings.ToUpper(*coin)
	info, ok := m.Coins[c]
	switch {
	case !ok:
		log.Fatalf("no %s market", c)
	case !info.Openable || len(m.Paused) > 0:
		log.Fatalf("Papertrade is not taking opens on %s right now (paused: %v)", c, m.Paused)
	case *notional / *lev < m.MinMargin || *notional < m.MinNotional:
		log.Fatalf("a leg needs at least $%.0f margin and $%.0f size", m.MinMargin, m.MinNotional)
	}

	w := &paper.Watcher{Addr: wallet.Addr}
	go w.Run(ctx)
	a := waitFor(w, "the account stream", func(*paper.Acct) bool { return true })
	margin := *notional / *lev
	fmt.Printf("wallet    %s\navailable $%.2f, %d open positions, %d queued intents\n", wallet.Addr, a.Avail, len(a.Positions), len(a.Ops))
	if a.Avail < 2*margin {
		log.Fatalf("needs $%.2f available for two legs", 2*margin)
	}
	fmt.Printf("\nplan: %s long + short, $%.0f each at %.0fx ($%.2f margin each), hold %s, close both\n", c, *notional, *lev, margin, *hold)
	if !*yes {
		fmt.Print("type yes to send real intents: ")
		var s string
		fmt.Scanln(&s)
		if s != "yes" {
			return
		}
	}

	key := canaryKey(ctx, p, w, wallet, *sessFile)
	tr := &farm.Trader{Paper: p, Key: key, User: wallet.Addr, Lease: func(context.Context) error { return nil }}
	d := &farm.Doc{Address: wallet.Addr}
	r, err := tr.OpenPair(ctx, d, c, *notional, *lev, 0.005, false, "")
	if err != nil {
		log.Fatalf("open: %v", err)
	}
	fmt.Println("both legs sent; waiting for Papertrade's queue")
	var v farm.PairView
	for {
		a, _ = w.Account()
		farm.SyncLegs(d.Pairs, a)
		v = farm.Derive(r, a, time.Now().UnixMilli())
		fmt.Printf("\r%-8s long %-7s short %-7s", v.State, v.Long.Status, v.Short.Status)
		if v.State == "open" {
			break
		}
		if v.State == "broken" || v.State == "failed" {
			fmt.Println()
			if v.Long.Pos != nil || v.Short.Pos != nil {
				must(tr.ClosePair(ctx, d, v))
				log.Fatal("one leg did not open; the other was closed")
			}
			if v.Long.Status == "queued" {
				tr.Cancel(ctx, r.Intents["long"])
			}
			log.Fatal("the pair did not open")
		}
		time.Sleep(time.Second)
	}
	fmt.Printf("\nlong  #%s entry %.2f bust %.2f\nshort #%s entry %.2f bust %.2f\n", v.Long.Pos.ID, v.Long.Pos.Entry, v.Long.Pos.Bust, v.Short.Pos.ID, v.Short.Pos.Entry, v.Short.Pos.Bust)
	time.Sleep(*hold)
	must(tr.ClosePair(ctx, d, v))
	fmt.Println("close sent")
	a = waitFor(w, "the close", func(a *paper.Acct) bool { return farm.Derive(r, a, time.Now().UnixMilli()).State == "closed" })
	v = farm.Derive(r, a, time.Now().UnixMilli())
	var pnl, minted float64
	for _, side := range farm.Sides {
		if l := v.Leg(side); l.Closed != nil {
			fmt.Printf("%-5s pnl %+.4f  PAPER %.2f\n", side, l.Closed.PnL, l.Closed.Paper)
			pnl += l.Closed.PnL
			minted += l.Closed.Paper
		}
	}
	fmt.Printf("\npair: net %+.4f USD, %.2f PAPER", pnl, minted)
	if minted > 0 {
		fmt.Printf(", $%.2f per 1k PAPER", -pnl/minted*1000)
	}
	fmt.Println()
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func waitFor(w *paper.Watcher, what string, ok func(*paper.Acct) bool) *paper.Acct {
	for range 600 {
		if a, at := w.Account(); a != nil && time.Since(at) < time.Minute && ok(a) {
			return a
		}
		time.Sleep(500 * time.Millisecond)
	}
	log.Fatalf("timed out waiting for %s", what)
	return nil
}

// canaryKey returns a registered trading key, registering one when the saved one is missing or has under an hour left.
func canaryKey(ctx context.Context, p *paper.Client, w *paper.Watcher, wallet *paper.Key, file string) *paper.Key {
	var saved struct{ Key string }
	if b, err := os.ReadFile(file); err == nil {
		json.Unmarshal(b, &saved)
	}
	a, _ := w.Account()
	if k, err := paper.ParseKey(saved.Key); err == nil && time.Until(time.Unix(a.Sessions[k.Addr], 0)) > time.Hour {
		return k
	}
	k := paper.NewKey()
	os.MkdirAll(dirOf(file), 0o700)
	b, _ := json.Marshal(map[string]string{"key": k.Hex()})
	must(os.WriteFile(file, b, 0o600))
	signed, id, err := paper.Sign(wallet, "exchange", "RegisterSessionKey", wallet.Addr, map[string]any{
		"key": k.Addr, "expiry": time.Now().Add(7 * 24 * time.Hour).Unix(), "feeAddress": paper.ZeroAddr, "deadline": time.Now().Add(10 * time.Minute).Unix()})
	must(err)
	must(p.Submit(ctx, "registerSessionKey", signed, id))
	fmt.Printf("trading key %s registering…", k.Addr)
	waitFor(w, "the key registration", func(a *paper.Acct) bool { return a.Sessions[k.Addr] > time.Now().Unix() })
	fmt.Println(" done")
	return k
}

func dirOf(p string) string {
	if i := strings.LastIndex(p, "/"); i > 0 {
		return p[:i]
	}
	return "."
}
