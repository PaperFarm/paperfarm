// Package paper is Papertrade: its API client, the browser proxy, intent signing, the market and its
// economics, and the live account stream.
package paper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Papertrade's API, used the way its own frontend uses it: JSON, the frontend's build id in a header,
// never following redirects. It refuses browser origins other than its own, so the browser reaches it
// through Proxy() below.

const paperAPI = "https://exchange.papertrade.xyz"

var paperHTTP = &http.Client{Transport: paperTransport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

type Client struct {
	mu      sync.Mutex
	build   string
	buildAt time.Time
	cache   map[string]cached
}

type cached struct {
	at time.Time
	b  []byte
}

func New() *Client { return &Client{cache: map[string]cached{}} }

// Get fetches path, decoding into out, served from a cache up to ttl old. A failed fetch serves the
// last good copy rather than nothing.
func (p *Client) Get(ctx context.Context, path string, ttl time.Duration, out any) error {
	p.mu.Lock()
	c, ok := p.cache[path]
	p.mu.Unlock()
	if !ok || time.Since(c.at) > ttl {
		b, err := p.Do(ctx, "GET", path, nil)
		switch {
		case err == nil:
			c = cached{time.Now(), b}
			p.mu.Lock()
			p.cache[path] = c
			if len(p.cache) > 5000 { // a crude bound; an LRU if many wallets use it
				p.cache = map[string]cached{path: c}
			}
			p.mu.Unlock()
		case !ok:
			return err
		}
	}
	return json.Unmarshal(c.b, out)
}

// Do calls Papertrade and returns the body. A non-2xx answer is an error carrying the body.
func (p *Client) Do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, paperAPI+path, r)
	if err != nil {
		return nil, err
	}
	p.headers(ctx, req.Header)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := paperHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if res.StatusCode >= 300 {
		return b, &APIError{res.StatusCode, b}
	}
	return b, nil
}

// DoJSON is an uncached GET decoded into out.
func (p *Client) DoJSON(ctx context.Context, path string, out any) ([]byte, error) {
	b, err := p.Do(ctx, "GET", path, nil)
	if err != nil {
		return b, err
	}
	return b, json.Unmarshal(b, out)
}

type APIError struct {
	Status int
	Body   []byte
}

func (e *APIError) Error() string { return fmt.Sprintf("papertrade http %d: %.300s", e.Status, e.Body) }

func (p *Client) headers(ctx context.Context, h http.Header) {
	h.Set("Accept", "application/json")
	h.Set("User-Agent", "paperfarm/1")
	if id := p.buildID(ctx); id != "" {
		h.Set("X-Papertrade-Build", id)
	}
}

var (
	reIndex = regexp.MustCompile(`/assets/index-[\w-]+\.js`)
	reBuild = regexp.MustCompile(`build-[\w-]+\.js`)
	reLit   = regexp.MustCompile("var \\w+=`([0-9a-f]{8,})`")
)

// buildID is the live frontend's build id, re-read every 10 minutes; a failed read keeps the last one.
func (p *Client) buildID(ctx context.Context) string {
	p.mu.Lock()
	id, at := p.build, p.buildAt
	if time.Since(at) < 10*time.Minute {
		p.mu.Unlock()
		return id
	}
	p.buildAt = time.Now() // one fetch at a time; others use the old id meanwhile
	p.mu.Unlock()
	fetch := func(path string) string {
		req, _ := http.NewRequestWithContext(ctx, "GET", paperAPI+path, nil)
		req.Header.Set("Accept", "text/html,application/javascript,*/*;q=0.8") // it answers 404 to a request that refuses HTML
		res, err := paperHTTP.Do(req)
		if err != nil {
			return ""
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
		return string(b)
	}
	if idx := reIndex.FindString(fetch("/")); idx != "" {
		if bf := reBuild.FindString(fetch(idx)); bf != "" {
			if m := reLit.FindStringSubmatch(fetch("/assets/" + bf)); m != nil {
				id = m[1]
			}
		}
	}
	p.mu.Lock()
	p.build = id
	p.mu.Unlock()
	return id
}

// proxyRoutes is everything the browser may reach. Anything else is refused.
var proxyRoutes = []struct {
	method string
	re     *regexp.Regexp
}{
	{"GET", regexp.MustCompile(`^/state/(trading|user/live)$`)},
	{"GET", regexp.MustCompile(`^/query/accounts/0x[0-9a-f]{40}/(trades|cashflows|staking|queue-balances)$`)},
	{"GET", regexp.MustCompile(`^/query/protocol/(summary|queue-summary|market-stats|history)$`)},
	{"GET", regexp.MustCompile(`^/queue-rank/accounts/0x[0-9a-f]{40}$`)},
	{"POST", regexp.MustCompile(`^/intents$`)},
	{"POST", regexp.MustCompile(`^/intents/0x[0-9a-f]{64}/cancel$`)},
}

// Proxy forwards /paper/<path> to Papertrade: public reads, and the intents a wallet signs itself (stake, claim).
func (p *Client) Proxy() http.Handler {
	target, _ := url.Parse(paperAPI)
	rp := &httputil.ReverseProxy{
		Transport:     paperTransport,
		FlushInterval: -1, // the account stream is SSE
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
			r.Out.Header = http.Header{}
			p.headers(r.In.Context(), r.Out.Header)
			if ct := r.In.Header.Get("Content-Type"); ct != "" {
				r.Out.Header.Set("Content-Type", ct)
			}
			if a := r.In.Header.Get("Accept"); a == "text/event-stream" {
				r.Out.Header.Set("Accept", a)
			}
		},
		ModifyResponse: func(res *http.Response) error {
			res.Header.Del("Set-Cookie")
			res.Header.Del("Access-Control-Allow-Origin")
			return nil
		},
	}
	return http.StripPrefix("/paper", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.ToLower(r.URL.Path)
		ok := false
		for _, rt := range proxyRoutes {
			if rt.method == r.Method && rt.re.MatchString(path) {
				ok = true
			}
		}
		if !ok {
			http.Error(w, `{"error":"route not allowed"}`, http.StatusForbidden)
			return
		}
		if r.Method == "POST" {
			body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
			if err != nil {
				http.Error(w, `{"error":"bad body"}`, http.StatusBadRequest)
				return
			}
			out, err := p.Do(r.Context(), "POST", r.URL.Path, body)
			status := 200
			if e, ok := err.(*APIError); ok {
				status = e.Status
			} else if err != nil {
				http.Error(w, fmt.Sprintf(`{"error":"upstream","message":%q}`, err.Error()), http.StatusBadGateway)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			w.Write(out)
			return
		}
		r.URL.Path = path
		rp.ServeHTTP(w, r)
	}))
}

// Raw parses a decimal integer string scaled by 10^dec into a float.
func Raw(s string, dec int) float64 {
	f, ok := new(big.Float).SetString(s)
	if !ok {
		return 0
	}
	v, _ := f.Quo(f, new(big.Float).SetFloat64(pow10(dec))).Float64()
	return v
}

func pow10(n int) float64 {
	f := 1.0
	for range n {
		f *= 10
	}
	return f
}

// Ticks returns one minute of Papertrade's 125 ms price history for a market, the samples its own chart
// draws. Every visitor asks for the same minutes, so they are cached here: a finished minute for good
// (an hour), the current one for a second.
func (p *Client) Ticks(ctx context.Context, market, minute string, now time.Time) ([]byte, error) {
	id, err1 := strconv.Atoi(market)
	from, err2 := strconv.ParseInt(minute, 10, 64)
	switch {
	case err1 != nil || err2 != nil || id < 0 || id > 31:
		return nil, errors.New("bad market or minute")
	case from%60000 != 0 || from > now.UnixMilli() || from < now.Add(-30*time.Minute).UnixMilli():
		return nil, errors.New("minute must be a whole minute within the last 30")
	}
	ttl := time.Hour
	if from+60000 > now.UnixMilli()-2000 {
		ttl = time.Second
	}
	var out json.RawMessage
	err := p.Get(ctx, fmt.Sprintf("/query/markets/%d/price-history?fromMs=%d&intervalMs=125&toMs=%d", id, from, from+60000), ttl, &out)
	return out, err
}
