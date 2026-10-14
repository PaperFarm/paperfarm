// Package httpapi is the HTTP side of paperfarm: the signed-in JSON API, Papertrade's proxy and data,
// the web app, per-IP rate limits and the security headers on every response.
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"html"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"paperfarm/internal/auth"
	"paperfarm/internal/farm"
	"paperfarm/internal/paper"
	"paperfarm/internal/stats"
)

var reAddr = regexp.MustCompile(`^0x[0-9a-f]{40}$`)

// Handler is the whole site. site is the built web app; the app routes on the client.
func Handler(e *farm.Engine, p *paper.Client, hist *stats.History, seal *auth.Sealer, site fs.FS) http.Handler {
	api := &server{e: e, paper: p, auth: auth.New(seal), seal: seal}

	mux := http.NewServeMux()
	// Per-IP limits: generous for reads (a page polls a few endpoints), tight for intents.
	reads, writes := newLimiter(300, 120), newLimiter(40, 20)
	mux.Handle("/paper/", limited(reads, writes, p.Proxy()))
	apiMux := http.NewServeMux()
	api.routes(apiMux)
	mux.Handle("/api/auth/", limited(reads, writes, apiMux))
	mux.Handle("/api/me", limited(reads, writes, apiMux))
	mux.Handle("/api/me/", limited(reads, writes, apiMux))
	mux.HandleFunc("GET /api/market", func(w http.ResponseWriter, r *http.Request) {
		m, err := p.Market(r.Context())
		if err != nil {
			httpErr(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, m)
	})
	mux.Handle("GET /api/ticks/{market}/{minute}", limited(reads, writes, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := p.Ticks(r.Context(), r.PathValue("market"), r.PathValue("minute"), time.Now())
		if err != nil {
			httpErr(w, http.StatusBadRequest, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	})))
	statsLimit := newLimiter(20, 10) // a full history read can page Papertrade a lot
	mux.Handle("GET /api/stats/{addr}", limited(statsLimit, statsLimit, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := strings.ToLower(r.PathValue("addr"))
		if !reAddr.MatchString(a) {
			httpErr(w, http.StatusBadRequest, errString("not an address"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		s, err := hist.Stats(ctx, a)
		if err != nil {
			httpErr(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, s)
	})))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	files := http.FileServerFS(site)
	page := sync.OnceValue(func() []byte { return indexPage(site, os.Getenv("PAPERFARM_PUBLIC_URL")) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if _, err := fs.Stat(site, path); err != nil || path == "" || path == "index.html" { // the app routes on the client
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(page())
			return
		}
		if strings.HasPrefix(path, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // named by their content
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600") // icons and the preview image keep their names
		}
		files.ServeHTTP(w, r)
	})
	return security(mux)
}

// csp lets the page load only its own files and talk only to this server and Hyperliquid's public price
// API. No third-party script, style or font can run in the page that holds the trading key.
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
	"connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz; " +
	"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func security(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Security-Policy", csp)
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Cross-Origin-Opener-Policy", "same-origin")
		hd.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if isHTTPS(r) {
			hd.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		h.ServeHTTP(w, r)
	})
}

// isHTTPS: the request came over TLS, or through a trusted proxy that says it did.
func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || (trustProxy() && r.Header.Get("X-Forwarded-Proto") == "https")
}

type errString string

func (e errString) Error() string { return string(e) }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, status int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": paper.Explain(err)}) // Papertrade's refusals in its own words
}

// indexPage is the app's page. Given the site's public address, its link-preview tags name it in full, as
// X, Discord and Telegram need; without one they stay relative.
func indexPage(site fs.FS, publicURL string) []byte {
	b, err := fs.ReadFile(site, "index.html")
	if err != nil {
		return []byte("<!doctype html><title>paperfarm</title><p>The web app is not built into this binary.")
	}
	if u := html.EscapeString(strings.TrimRight(publicURL, "/")); u != "" {
		b = bytes.Replace(b, []byte(`content="/og.png"`), []byte(`content="`+u+`/og.png"`), 1)
		b = bytes.Replace(b, []byte(`<meta property="og:title"`), []byte(`<meta property="og:url" content="`+u+`/">`+"\n"+`<meta property="og:title"`), 1)
	}
	return b
}
