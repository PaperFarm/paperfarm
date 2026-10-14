package farm

import (
	"context"
	"os"
	"testing"
	"time"

	"paperfarm/internal/paper"
)

// LIVE_WALLET=0x... go test -run TestLiveStream -v: follows a real account's stream for a few seconds
// (read-only) and checks the engine reads it, and that Hyperliquid prices arrive.
func TestLiveStream(t *testing.T) {
	addr := os.Getenv("LIVE_WALLET")
	if addr == "" {
		t.Skip("set LIVE_WALLET to a Papertrade address")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	w := &paper.Watcher{Addr: addr}
	go w.Run(ctx)
	m := &Mids{}
	go m.Run(ctx)
	for ctx.Err() == nil {
		if a, at := w.Account(); a != nil && m.Get("BTC") > 0 {
			t.Logf("available $%.2f, %d positions, %d queued, %d session keys, BTC %.1f, stream %s old", a.Avail, len(a.Positions), len(a.Ops), len(a.Sessions), m.Get("BTC"), time.Since(at).Round(time.Millisecond))
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("no account snapshot or prices within 30 s")
}
