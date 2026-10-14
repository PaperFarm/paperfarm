package httpapi

import (
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// limiter is a per-IP token bucket: every client gets `burst` requests, refilled at `perMin` a minute.
// It keeps one client from spending the server's Papertrade rate limit (and proxy pool) for everyone.
type limiter struct {
	mu      sync.Mutex
	perMin  float64
	burst   float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	at     time.Time
}

func newLimiter(perMin, burst float64) *limiter {
	l := &limiter{perMin: perMin, burst: burst, buckets: map[string]*bucket{}}
	go func() { // forget idle clients
		for range time.Tick(5 * time.Minute) {
			l.mu.Lock()
			for k, b := range l.buckets {
				if time.Since(b.at) > 10*time.Minute {
					delete(l.buckets, k)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.at).Minutes()*l.perMin)
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// trustProxy is read on first use, after main has loaded .env.
var trustProxy = sync.OnceValue(func() bool { return os.Getenv("PAPERFARM_TRUST_PROXY") == "1" })

// clientIP is the peer address, or the first X-Forwarded-For hop when PAPERFARM_TRUST_PROXY=1 (behind
// Railway, Caddy or another proxy that sets it). Never trust the header otherwise: anyone can send it.
func clientIP(r *http.Request) string {
	if trustProxy() {
		if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
			return strings.TrimSpace(ip) // behind Cloudflare: the visitor, as Cloudflare saw them (it overwrites any sent)
		}
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			hops := strings.Split(f, ",")
			return strings.TrimSpace(hops[len(hops)-1]) // the hop our host's proxy added; earlier ones are the client's say-so
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// limited rate-limits a handler per client IP; writes (intents) get their own, tighter bucket.
func limited(reads, writes *limiter, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		l := reads
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			l = writes
		}
		if !l.allow(clientIP(r), time.Now()) {
			w.Header().Set("Retry-After", "10")
			httpErr(w, http.StatusTooManyRequests, errString("too many requests; slow down"))
			return
		}
		h.ServeHTTP(w, r)
	})
}
