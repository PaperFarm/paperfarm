package paper

import "math"

// Papertrade's settlement economics (docs.papertrade.xyz: Asymmetric impact PnL, Mint curve, Liquidations),
// fed with the live parameters from /state/trading and /query/protocol/summary.
//
//	winning close: move' = move - 0.2 bps (deadband); kept = move' x (1-base)/(1 + K/move') x (1 - 2% win fee)
//	K = 1/rateMultiplier + (referenceNotional/1e6)/positionMultiplier
//	losing close:  mint basis = loss x (1 - 2% LP-side fee) while the queue is empty
//	bust:          adverse move of 1/leverage - 5 bps
//	mint rate:     flat below the LP cliff, else flat x (S/(S+tailProgress))^2

const (
	deadband  = 1.0 / 50000
	liqBuffer = 0.0005
	winFee    = 0.02
	lossFee   = 0.02
)

type Impact struct {
	Base float64 `json:"base"` // haircut as move -> inf
	K    float64 `json:"k"`
}

func impactFrom(base, rateMult, refNotional, posMult float64) (Impact, bool) {
	if !(base >= 0 && base < 1) || rateMult <= 0 || refNotional <= 0 || posMult <= 0 {
		return Impact{}, false
	}
	return Impact{Base: base, K: 1/rateMult + refNotional/1e6/posMult}, true
}

// WinPayout is what a winning close credits for notional n that moved `move` (fraction) in its favour.
func (p Impact) WinPayout(n, move float64) float64 {
	eff := math.Abs(move) - deadband
	if eff <= 0 {
		return 0
	}
	return n * eff * (1 - p.Base) / (1 + p.K/eff) * (1 - winFee)
}

type Mint struct {
	TrackedLP float64 `json:"trackedLp"`
	Cliff     float64 `json:"cliff"`
	Flat      float64 `json:"flat"`
	Decay     float64 `json:"decay"`
	Tail      float64 `json:"tail"`
}

// Rate is PAPER per $1 of mint basis right now.
func (m Mint) Rate() float64 {
	if m.TrackedLP < m.Cliff || m.Decay <= 0 {
		return m.Flat
	}
	r := m.Decay / (m.Decay + m.Tail)
	return m.Flat * r * r
}

func bustMove(lev float64) float64 { return 1/lev - liqBuffer }

// Cycle is one pair round trip: two legs of notional n each, price moves `move`, both close.
// When the loser busts before `move`, it loses its whole margin and mints on it.
type Cycle struct {
	TP        float64 `json:"tp"`
	Loss      float64 `json:"loss"`
	WinPaid   float64 `json:"winPaid"`
	Cost      float64 `json:"cost"`
	Paper     float64 `json:"paper"`
	CostPer1k float64 `json:"costPer1k"`
	Busts     bool    `json:"busts"`
}

func cycle(p Impact, m Mint, n, lev, move float64) Cycle {
	c := Cycle{TP: move, Loss: n * move}
	basis, won := c.Loss*(1-lossFee), move
	if bm := bustMove(lev); move >= bm {
		// The loser is liquidated first: it loses and mints on its whole margin, and the survivor is
		// closed right then, at the bust move.
		c.Busts, c.Loss, basis, won = true, n/lev, n/lev, bm
	}
	c.WinPaid = p.WinPayout(n, won)
	c.Cost = c.Loss - c.WinPaid
	c.Paper = basis * m.Rate()
	if c.Paper > 0 {
		c.CostPer1k = c.Cost / c.Paper * 1000
	}
	return c
}
