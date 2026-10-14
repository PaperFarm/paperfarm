package stats

import "testing"

func TestSummarize(t *testing.T) {
	ts := []Trade{ // newest first
		{PositionID: "4", Coin: "BTC", Long: true, Margin: 100, Leverage: 10, PnL: 4.1, Paper: 0, Tx: "0xb", ClosedAt: 4e12},
		{PositionID: "3", Coin: "BTC", Long: false, Margin: 100, Leverage: 10, PnL: -5, Paper: 490, Tx: "0xb", ClosedAt: 4e12},
		{PositionID: "2", Coin: "ETH", Long: true, Margin: 10, Leverage: 100, PnL: -10, Paper: 1000, Liquidated: true, Tx: "0xa", ClosedAt: 1e12},
	}
	s := summarize(ts)
	if s.Closes != 3 || s.Pairs != 1 || s.Liquidations != 1 || s.Wins != 1 || s.Volume != 3000 {
		t.Fatalf("%+v", s)
	}
	if s.Paper != 1490 || s.PnL != -10.9 || s.CostPer1k < 7.31 || s.CostPer1k > 7.32 {
		t.Fatalf("paper %v pnl %v cost/1k %v", s.Paper, s.PnL, s.CostPer1k)
	}
	if len(s.Curve) != 3 || s.Curve[0].Paper != 1000 || s.Curve[2].Paper != 1490 || len(s.Days) != 2 {
		t.Fatalf("curve %+v days %+v", s.Curve, s.Days)
	}
	r := rawTrade{Kind: "Liquidated", PriceScaleRaw: "100", EntryPriceRaw: "250795", MarginRaw: "200000000000000000000", AdjustedPnlRaw: "-200000000000000000000", PaperMintedRaw: "4422612895192274676000"}.trade()
	if r.Entry != 2507.95 || r.Margin != 200 || r.PnL != -200 || r.Paper < 4422.6 || r.Paper > 4422.7 {
		t.Fatalf("%+v", r)
	}
}
