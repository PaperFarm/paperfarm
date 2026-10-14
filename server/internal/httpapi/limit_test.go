package httpapi

import (
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

func TestLimiter(t *testing.T) {
	l := newLimiter(60, 3) // a token a second, bursts of three
	now := time.Now()
	for i := range 3 {
		if !l.allow("a", now) {
			t.Fatalf("request %d refused inside the burst", i)
		}
	}
	if l.allow("a", now) {
		t.Fatal("fourth request allowed with an empty bucket")
	}
	if !l.allow("b", now) {
		t.Fatal("one client's limit applied to another")
	}
	if !l.allow("a", now.Add(1100*time.Millisecond)) {
		t.Fatal("bucket did not refill")
	}
}

func TestIndexPage(t *testing.T) {
	site := fstest.MapFS{"index.html": {Data: []byte(`<meta property="og:title" content="paperfarm"><meta property="og:image" content="/og.png">`)}}
	if got := string(indexPage(site, "")); strings.Contains(got, "og:url") || !strings.Contains(got, `content="/og.png"`) {
		t.Fatalf("without an address the page must stay as built: %s", got)
	}
	got := string(indexPage(site, "https://example.test/"))
	if !strings.Contains(got, `content="https://example.test/og.png"`) || !strings.Contains(got, `og:url" content="https://example.test/"`) {
		t.Fatalf("preview tags not absolute: %s", got)
	}
}

func TestClientIP(t *testing.T) {
	trustProxy = func() bool { return true }
	defer func() { trustProxy = sync.OnceValue(func() bool { return os.Getenv("PAPERFARM_TRUST_PROXY") == "1" }) }()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 1.2.3.4") // a client-sent entry, then our host's proxy
	if got := clientIP(r); got != "1.2.3.4" {
		t.Fatalf("a client-sent X-Forwarded-For entry was trusted: %s", got)
	}
	r.Header.Set("CF-Connecting-IP", "5.6.7.8")
	if got := clientIP(r); got != "5.6.7.8" {
		t.Fatalf("Cloudflare's visitor address ignored: %s", got)
	}
}
