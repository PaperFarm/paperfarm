package paper

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Every request to Papertrade (reads, the account streams, intents) can go out through a pool of proxies,
// one after another, so many users behind one server do not share one IP's rate limit.
//
//	PAPER_PROXIES=http://user:pass@1.2.3.4:8080,socks5://5.6.7.8:1080,9.9.9.9:3128:user:pass
//
// Accepted forms: a URL (http, https, socks5), host:port, or host:port:user:pass. Empty means direct.

type proxyPool struct {
	urls []*url.URL
	next atomic.Uint64
}

func parseProxy(s string) (*url.URL, error) {
	s = strings.TrimSpace(s)
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil || u.Host == "" {
			return nil, fmt.Errorf("proxy %q: not a URL", s)
		}
		return u, nil
	}
	parts := strings.Split(s, ":")
	switch len(parts) {
	case 2:
		return &url.URL{Scheme: "http", Host: s}, nil
	case 4:
		return &url.URL{Scheme: "http", Host: parts[0] + ":" + parts[1], User: url.UserPassword(parts[2], parts[3])}, nil
	}
	return nil, fmt.Errorf("proxy %q: want a URL, host:port or host:port:user:pass", s)
}

func newProxyPool(list string) (*proxyPool, error) {
	p := &proxyPool{}
	for _, s := range strings.Split(list, ",") {
		if strings.TrimSpace(s) == "" {
			continue
		}
		u, err := parseProxy(s)
		if err != nil {
			return nil, err
		}
		p.urls = append(p.urls, u)
	}
	return p, nil
}

// pick is the transport's Proxy func: round robin over the pool, or direct when it is empty.
func (p *proxyPool) pick(*http.Request) (*url.URL, error) {
	if len(p.urls) == 0 {
		return nil, nil
	}
	return p.urls[(p.next.Add(1)-1)%uint64(len(p.urls))], nil
}

func (p *proxyPool) String() string {
	if len(p.urls) == 0 {
		return "direct"
	}
	hosts := make([]string, len(p.urls))
	for i, u := range p.urls {
		hosts[i] = u.Host // never log credentials
	}
	return fmt.Sprintf("%d proxies (%s)", len(p.urls), strings.Join(hosts, ", "))
}

// Proxies is the pool from PAPER_PROXIES, read on first use (after main has loaded .env).
var Proxies = sync.OnceValue(func() *proxyPool {
	p, err := newProxyPool(os.Getenv("PAPER_PROXIES"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "PAPER_PROXIES:", err)
		os.Exit(2)
	}
	return p
})

// paperTransport is shared by every client that talks to Papertrade.
var paperTransport = &http.Transport{
	Proxy:                 func(r *http.Request) (*url.URL, error) { return Proxies().pick(r) },
	DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	ForceAttemptHTTP2:     true,
	MaxIdleConnsPerHost:   32,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ResponseHeaderTimeout: 20 * time.Second,
}
