package paper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"
)

type Coin struct {
	ID          int     `json:"id"`
	Coin        string  `json:"coin"`
	Scale       float64 `json:"scale"` // Papertrade prices are integers x scale
	Openable    bool    `json:"openable"`
	MaxLeverage int     `json:"maxLeverage"`
	MaxNotional float64 `json:"maxNotional"`
	Impact      Impact  `json:"impact"`
	LongOI      float64 `json:"longOi"` // in coins
	ShortOI     float64 `json:"shortOi"`
	LongCap     float64 `json:"longCap"` // open-interest caps, in coins; 0 when uncapped
	ShortCap    float64 `json:"shortCap"`
	Volume24h   float64 `json:"volume24h"`
	Table       []Cycle `json:"table"` // a $100K pair at 10x, by TP
}

type Market struct {
	At            int64           `json:"at"`
	TradingPaused bool            `json:"tradingPaused"`
	Paused        []string        `json:"paused"` // intake actions Papertrade refuses right now
	MinMargin     float64         `json:"minMargin"`
	MinNotional   float64         `json:"minNotional"`
	MinStake      float64         `json:"minStake"`
	NetOICap      float64         `json:"netOiCap"` // longest the long and short sides may differ, in USD; 0 when uncapped
	Coins         map[string]Coin `json:"coins"`
	Mint          Mint            `json:"mint"`
	Rate          float64         `json:"rate"` // PAPER per $1 of loss basis now
	LPCash        float64         `json:"lpCash"`
	QueueTotal    float64         `json:"queueTotal"`
	QueueCount    int             `json:"queueCount"`
	PaperSupply   float64         `json:"paperSupply"`
	PaperStaked   float64         `json:"paperStaked"`
	TVL           float64         `json:"tvl"`
	OpenPositions int             `json:"openPositions"`
}

var tableTPs = []float64{0.001, 0.002, 0.003, 0.005, 0.0075, 0.01}

func (p *Client) Market(ctx context.Context) (Market, error) {
	var t struct {
		TradingPaused          bool
		MinimumTradeSizeRaw    string
		MinimumOpenNotionalRaw string
		Instruments            [][]any
		Intake                 []json.RawMessage
	}
	if err := p.Get(ctx, "/state/trading", 10*time.Second, &t); err != nil {
		return Market{}, err
	}
	var s struct {
		Balances struct{ TVL, LP, Queue string }
		Activity struct{ Open int }
		Paper    struct{ Supply, Staked, TrackedLp, TailProgress, Cliff, Rate, Decay string }
	}
	if err := p.Get(ctx, "/query/protocol/summary", 10*time.Second, &s); err != nil {
		return Market{}, err
	}
	var q struct {
		Total string
		Count int
	}
	p.Get(ctx, "/query/protocol/queue-summary", 10*time.Second, &q)
	var ms struct {
		Markets map[string]struct {
			Volume24h string `json:"volume_24h"`
		}
	}
	p.Get(ctx, "/query/protocol/market-stats", time.Minute, &ms)

	m := Market{At: time.Now().UnixMilli(), TradingPaused: t.TradingPaused, Paused: []string{},
		MinMargin: Raw(t.MinimumTradeSizeRaw, 18), MinNotional: Raw(t.MinimumOpenNotionalRaw, 18), Coins: map[string]Coin{},
		Mint: Mint{TrackedLP: Raw(s.Paper.TrackedLp, 18), Cliff: Raw(s.Paper.Cliff, 18), Flat: Raw(s.Paper.Rate, 18),
			Decay: Raw(s.Paper.Decay, 18), Tail: Raw(s.Paper.TailProgress, 18)},
		LPCash: Raw(s.Balances.LP, 18), QueueTotal: Raw(q.Total, 18), QueueCount: q.Count,
		PaperSupply: Raw(s.Paper.Supply, 18), PaperStaked: Raw(s.Paper.Staked, 18), TVL: Raw(s.Balances.TVL, 18), OpenPositions: s.Activity.Open}
	if m.Mint.Flat == 0 || m.Mint.Cliff == 0 {
		return Market{}, errors.New("protocol summary: no mint curve")
	}
	m.Rate = m.Mint.Rate()
	if len(t.Intake) == 4 { // [revision, minimum PAPER stake, max net open interest, paused actions]
		var minStake, netCap string
		json.Unmarshal(t.Intake[1], &minStake)
		json.Unmarshal(t.Intake[2], &netCap)
		m.MinStake, m.NetOICap = Raw(minStake, 18), Raw(netCap, 18)
		json.Unmarshal(t.Intake[3], &m.Paused)
	}
	for _, a := range t.Instruments {
		if len(a) < 23 {
			continue
		}
		str := func(i int) string { v, _ := a[i].(string); return v }
		b := func(i int) bool { v, _ := a[i].(bool); return v }
		n := func(i int) float64 { v, _ := a[i].(float64); return v }
		scale, _ := strconv.ParseFloat(str(3), 64)
		c := Coin{ID: int(n(0)), Coin: str(1), Scale: scale, Openable: b(4) && !b(5) && !b(6) && !b(7) && !b(8) && !t.TradingPaused,
			MaxLeverage: int(n(14)), MaxNotional: Raw(str(15), 18), LongOI: Raw(str(19), 18), ShortOI: Raw(str(20), 18),
			LongCap: capOf(Raw(str(21), 18)), ShortCap: capOf(Raw(str(22), 18))}
		var ok bool
		if c.Impact, ok = impactFrom(Raw(str(17), 18), Raw(str(12), 18), Raw(str(18), 18), Raw(str(13), 18)); !ok || scale <= 0 {
			return Market{}, fmt.Errorf("/state/trading: %s has unreadable parameters", c.Coin)
		}
		c.Volume24h = Raw(ms.Markets[strconv.Itoa(c.ID)].Volume24h, 18)
		for _, tp := range tableTPs {
			c.Table = append(c.Table, cycle(c.Impact, m.Mint, 100_000, 10, tp))
		}
		m.Coins[c.Coin] = c
	}
	if len(m.Coins) == 0 {
		return Market{}, errors.New("/state/trading: no instruments")
	}
	return m, nil
}

// capOf reads an open-interest cap; Papertrade marks "no cap" with an absurdly large value.
func capOf(coins float64) float64 {
	if coins <= 0 || coins > 1e15 {
		return 0
	}
	return coins
}

// Room is the largest position (notional, USD) Papertrade would accept on one side right now at price
// mid: the limit its own order form applies. It is the least of the market's maximum position, what is
// left under that side's open-interest cap, and what the net cap allows that side to grow to. +Inf when
// nothing limits it.
func (c Coin) Room(long bool, mid, netCap float64) float64 {
	room := math.Inf(1)
	if c.MaxNotional > 0 {
		room = c.MaxNotional
	}
	if mid <= 0 {
		return room
	}
	oi, other, limit := c.LongOI, c.ShortOI, c.LongCap
	if !long {
		oi, other, limit = c.ShortOI, c.LongOI, c.ShortCap
	}
	if limit == 0 {
		limit = math.Inf(1)
	}
	if netCap > 0 {
		limit = math.Min(limit, other+netCap/mid)
	}
	if !math.IsInf(limit, 1) {
		room = math.Min(room, math.Max(0, limit-oi)*mid)
	}
	return room
}

// PairRoom is the largest leg a pair can open now: both of its sides must fit.
func (m Market) PairRoom(coin string, mid float64) float64 {
	c := m.Coins[coin]
	return math.Min(c.Room(true, mid, m.NetOICap), c.Room(false, mid, m.NetOICap))
}
