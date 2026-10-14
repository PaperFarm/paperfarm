package paper

import (
	"math"
	"testing"
)

func TestEcon(t *testing.T) {
	btc, ok := impactFrom(0.1, 15000, 100000, 814.598)
	if !ok || math.Abs(btc.K-1.894e-4) > 1e-7 {
		t.Fatalf("K = %v", btc.K)
	}
	// docs: on BTC, counting the deadband, a 1% move keeps about 88% of the raw gain, a 0.1% move about 74%.
	if k := btc.WinPayout(1, 0.01) / 0.01 / (1 - winFee); math.Abs(k-0.88) > 0.01 {
		t.Errorf("1%% keeps %.3f", k)
	}
	if k := btc.WinPayout(1, 0.001) / 0.001 / (1 - winFee); math.Abs(k-0.74) > 0.015 {
		t.Errorf("0.1%% keeps %.3f", k)
	}
	if btc.WinPayout(1e6, 0.00001) != 0 {
		t.Error("a move inside the deadband pays")
	}
	m := Mint{TrackedLP: 4.9e6, Cliff: 2e6, Flat: 100, Decay: 120e6, Tail: 100e6}
	if r := m.Rate(); math.Abs(r-29.75) > 0.1 { // docs: $100M tail -> ~30/$
		t.Errorf("rate %v", r)
	}
	if (Mint{TrackedLP: -1, Cliff: 2e6, Flat: 100, Decay: 120e6, Tail: 5e6}).Rate() != 100 {
		t.Error("underwater LP mints flat")
	}
	c := cycle(btc, m, 100000, 10, 0.005)
	if c.Busts || c.Cost <= 0 || c.Cost >= c.Loss || c.Paper <= 0 {
		t.Errorf("cycle %+v", c)
	}
	if b := cycle(btc, m, 100000, 1000, 0.005); !b.Busts || b.Loss != 100 {
		t.Errorf("1000x at 0.5%% must bust on its $100 margin: %+v", b)
	}
}

// Room mirrors Papertrade's order form: the least of the max position, the side's OI cap and the net cap.
func TestRoom(t *testing.T) {
	btc := Coin{MaxNotional: 10_000_000, LongOI: 2295.3, ShortOI: 1523.35, LongCap: 2395.27, ShortCap: 1587.77}
	mid := 80_000.0
	near := func(a, b float64) bool { return math.Abs(a-b) < 1 }
	if r := btc.Room(true, mid, 0); !near(r, (2395.27-2295.3)*mid) {
		t.Fatalf("long room under its cap: %f", r)
	}
	if r := btc.Room(false, mid, 0); !near(r, (1587.77-1523.35)*mid) {
		t.Fatalf("short room under its cap: %f", r)
	}
	// a net cap of $1M lets the long side reach only short OI + $1M worth of coins
	if r := btc.Room(true, mid, 1_000_000); !near(r, math.Max(0, 1523.35+1_000_000/mid-2295.3)*mid) {
		t.Fatalf("long room under the net cap: %f", r)
	}
	if r := (Coin{MaxNotional: 500}).Room(true, mid, 0); r != 500 {
		t.Fatalf("max position: %f", r)
	}
	m := Market{Coins: map[string]Coin{"BTC": btc}}
	if r := m.PairRoom("BTC", mid); !near(r, (1587.77-1523.35)*mid) {
		t.Fatalf("a pair fits the tighter side: %f", r)
	}
}
