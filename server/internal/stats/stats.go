// Package stats summarizes a wallet's settled Papertrade trades.
package stats

import (
	"context"
	"net/url"
	"sort"
	"sync"
	"time"

	"paperfarm/internal/paper"
)

// Trade is one settled position from /query/accounts/:a/trades.
type Trade struct {
	PositionID string  `json:"positionId"`
	Coin       string  `json:"coin"`
	Long       bool    `json:"long"`
	Margin     float64 `json:"margin"`
	Leverage   float64 `json:"leverage"`
	Entry      float64 `json:"entry"`
	Exit       float64 `json:"exit"`
	PnL        float64 `json:"pnl"` // after impact and fee
	Fee        float64 `json:"fee"`
	Paper      float64 `json:"paper"`
	Liquidated bool    `json:"liquidated"`
	OpenedAt   int64   `json:"openedAt"`
	ClosedAt   int64   `json:"closedAt"`
	Tx         string  `json:"tx"`
}

func (t Trade) Notional() float64 { return t.Margin * t.Leverage }

type rawTrade struct {
	TimestampMs, OpenedAtMs                    int64
	TxHash, PositionID, Symbol, Kind           string
	IsLong                                     bool
	Leverage                                   float64
	PriceScaleRaw, EntryPriceRaw, ExitPriceRaw string
	MarginRaw, AdjustedPnlRaw, UserPaidFeeRaw  string
	PaperMintedRaw                             string
}

func (r rawTrade) trade() Trade {
	scale := paper.Raw(r.PriceScaleRaw, 0)
	if scale == 0 {
		scale = 1
	}
	t := Trade{PositionID: r.PositionID, Coin: r.Symbol, Long: r.IsLong, Margin: paper.Raw(r.MarginRaw, 18), Leverage: r.Leverage,
		Entry: paper.Raw(r.EntryPriceRaw, 0) / scale, Exit: paper.Raw(r.ExitPriceRaw, 0) / scale, Fee: paper.Raw(r.UserPaidFeeRaw, 18),
		Paper: paper.Raw(r.PaperMintedRaw, 18), Liquidated: r.Kind == "Liquidated", OpenedAt: r.OpenedAtMs, ClosedAt: r.TimestampMs, Tx: r.TxHash}
	t.PnL = paper.Raw(r.AdjustedPnlRaw, 18) - t.Fee
	if t.Liquidated {
		t.PnL = -t.Margin
	}
	return t
}

type Day struct {
	Day    string  `json:"day"`
	PnL    float64 `json:"pnl"`
	Paper  float64 `json:"paper"`
	Volume float64 `json:"volume"`
	Closes int     `json:"closes"`
}

type Point struct {
	T     int64   `json:"t"`
	Paper float64 `json:"paper"`
	Cost  float64 `json:"cost"` // -cumulative PnL
}

type Stats struct {
	Address      string  `json:"address"`
	Closes       int     `json:"closes"`
	Liquidations int     `json:"liquidations"`
	Wins         int     `json:"wins"`
	Losses       int     `json:"losses"`
	Pairs        int     `json:"pairs"` // closes that settled a long and a short of one coin in one transaction
	Volume       float64 `json:"volume"`
	PnL          float64 `json:"pnl"`
	Fees         float64 `json:"fees"`
	Paper        float64 `json:"paper"`
	CostPer1k    float64 `json:"costPer1k"`
	Days         []Day   `json:"days"`
	Curve        []Point `json:"curve"`
	Recent       []Trade `json:"recent"`
	Truncated    bool    `json:"truncated"` // history longer than we page through
	Deposited    float64 `json:"deposited"`
	Withdrawn    float64 `json:"withdrawn"`
	Claimed      float64 `json:"claimed"`
	At           int64   `json:"at"`
}

// History keeps each wallet's settled trades and fetches only what is new since the last look.
type History struct {
	paper *paper.Client
	mu    sync.Mutex
	by    map[string]*walletHist
}

type walletHist struct {
	mu        sync.Mutex
	trades    []Trade // newest first
	seen      map[string]bool
	truncated bool
	stats     *Stats
	at        time.Time
}

const maxPages = 200 // 15,000 trades

func NewHistory(p *paper.Client) *History { return &History{paper: p, by: map[string]*walletHist{}} }

func (h *History) Stats(ctx context.Context, addr string) (*Stats, error) {
	h.mu.Lock()
	w := h.by[addr]
	if w == nil {
		w = &walletHist{seen: map[string]bool{}}
		h.by[addr] = w
	}
	h.mu.Unlock()
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stats != nil && time.Since(w.at) < 15*time.Second {
		return w.stats, nil
	}
	var fresh []Trade
	cursor := ""
	for page := 0; ; page++ {
		if page == maxPages {
			w.truncated = true
			break
		}
		q := url.Values{"filter": {"all"}, "limit": {"75"}} // Papertrade wants its parameters in this order: cursor, filter, limit
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var res struct {
			Items      []rawTrade
			NextCursor *string
		}
		if _, err := h.paper.DoJSON(ctx, "/query/accounts/"+addr+"/trades?"+q.Encode(), &res); err != nil {
			return nil, err
		}
		known := false
		for _, r := range res.Items {
			if w.seen[r.PositionID] {
				known = true
				break
			}
			if r.Kind == "PositionClosed" || r.Kind == "Liquidated" {
				fresh = append(fresh, r.trade())
			}
		}
		if known || res.NextCursor == nil || *res.NextCursor == "" || *res.NextCursor == cursor {
			break
		}
		cursor = *res.NextCursor
	}
	for _, t := range fresh {
		w.seen[t.PositionID] = true
	}
	w.trades = append(fresh, w.trades...)
	s := summarize(w.trades)
	s.Address, s.Truncated, s.At = addr, w.truncated, time.Now().UnixMilli()
	h.flows(ctx, addr, s)
	w.stats, w.at = s, time.Now()
	return s, nil
}

func (h *History) flows(ctx context.Context, addr string, s *Stats) {
	var cf, st struct {
		Items []struct {
			AmountRaw, Kind  string
			WithdrawalStatus *string
		}
	}
	if err := h.paper.Get(ctx, "/query/accounts/"+addr+"/cashflows?limit=75", 15*time.Second, &cf); err == nil {
		for _, it := range cf.Items {
			switch {
			case it.Kind == "Deposit":
				s.Deposited += paper.Raw(it.AmountRaw, 18)
			case it.Kind == "Withdrawal" && (it.WithdrawalStatus == nil || *it.WithdrawalStatus == "settled"):
				s.Withdrawn += paper.Raw(it.AmountRaw, 18)
			}
		}
	}
	if err := h.paper.Get(ctx, "/query/accounts/"+addr+"/staking?limit=75", 15*time.Second, &st); err == nil {
		for _, it := range st.Items {
			if it.Kind == "claimed" {
				s.Claimed += paper.Raw(it.AmountRaw, 18)
			}
		}
	}
}

// summarize turns trades (newest first) into the farm numbers.
func summarize(ts []Trade) *Stats {
	s := &Stats{Days: []Day{}, Curve: []Point{}, Recent: []Trade{}}
	byTx := map[string][2]map[string]bool{} // tx -> coins with a long, coins with a short
	days := map[string]*Day{}
	for _, t := range ts {
		s.Closes++
		if t.Liquidated {
			s.Liquidations++
		}
		if t.PnL > 0 {
			s.Wins++
		} else {
			s.Losses++
		}
		s.Volume += t.Notional()
		s.PnL += t.PnL
		s.Fees += t.Fee
		s.Paper += t.Paper
		sides, ok := byTx[t.Tx]
		if !ok {
			sides = [2]map[string]bool{{}, {}}
			byTx[t.Tx] = sides
		}
		if t.Long {
			sides[0][t.Coin] = true
		} else {
			sides[1][t.Coin] = true
		}
		d := time.UnixMilli(t.ClosedAt).UTC().Format("2006-01-02")
		if days[d] == nil {
			days[d] = &Day{Day: d}
		}
		days[d].PnL += t.PnL
		days[d].Paper += t.Paper
		days[d].Volume += t.Notional()
		days[d].Closes++
	}
	for _, sides := range byTx {
		for c := range sides[0] {
			if sides[1][c] {
				s.Pairs++
			}
		}
	}
	if s.Paper > 0 {
		s.CostPer1k = -s.PnL / s.Paper * 1000
	}
	for _, d := range days {
		s.Days = append(s.Days, *d)
	}
	sort.Slice(s.Days, func(i, j int) bool { return s.Days[i].Day > s.Days[j].Day })
	// The curve runs oldest -> newest, at most ~400 points.
	step := len(ts)/400 + 1
	var minted, pnl float64
	for i := len(ts) - 1; i >= 0; i-- {
		minted += ts[i].Paper
		pnl += ts[i].PnL
		if i%step == 0 {
			s.Curve = append(s.Curve, Point{T: ts[i].ClosedAt, Paper: minted, Cost: -pnl})
		}
	}
	s.Recent = append(s.Recent, ts[:min(len(ts), 100)]...)
	return s
}
