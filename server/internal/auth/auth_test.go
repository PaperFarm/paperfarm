package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"

	"paperfarm/internal/paper"
)

func TestSignIn(t *testing.T) {
	s, err := NewSealer("0123456789abcdef0123456789abcdef-test")
	if err != nil {
		t.Fatal(err)
	}
	a, now := New(s), time.Now()
	k := paper.NewKey()
	sign := func(key *paper.Key, msg string) string {
		priv, _ := crypto.HexToECDSA(key.Hex()[2:])
		sig, _ := crypto.Sign(accounts.TextHash([]byte(msg)), priv)
		sig[64] += 27 // wallets send v as 27/28
		return hexutil.Encode(sig)
	}
	msg := a.Challenge(k.Addr, "paperfarm.test", now)
	if err := a.Verify(k.Addr, sign(k, msg), now); err != nil {
		t.Fatal(err)
	}
	if a.Verify(k.Addr, sign(k, msg), now) == nil {
		t.Fatal("a challenge was accepted twice")
	}
	other := paper.NewKey()
	msg = a.Challenge(k.Addr, "paperfarm.test", now)
	if a.Verify(k.Addr, sign(other, msg), now) == nil {
		t.Fatal("another wallet's signature was accepted")
	}
	msg = a.Challenge(k.Addr, "paperfarm.test", now)
	if a.Verify(k.Addr, sign(k, msg), now.Add(6*time.Minute)) == nil {
		t.Fatal("an expired challenge was accepted")
	}

	// The cookie round-trips, and a tampered or expired one is refused.
	w := httptest.NewRecorder()
	a.SetSession(w, k.Addr, now, false)
	c := w.Result().Cookies()[0]
	req := func(v string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.AddCookie(&http.Cookie{Name: "pf_s", Value: v})
		return r
	}
	if a.User(req(c.Value), now) != k.Addr || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Fatal("session cookie does not round-trip or is not locked down")
	}
	tampered := other.Addr + c.Value[len(k.Addr):]
	if a.User(req(tampered), now) != "" {
		t.Fatal("a cookie moved to another address was accepted")
	}
	if a.User(req(c.Value), now.Add(sessionTTL+time.Minute)) != "" {
		t.Fatal("an expired session was accepted")
	}

	// Sealed keys open only for the wallet they were sealed for.
	box := s.Seal([]byte("secret key"), k.Addr)
	if got, err := s.Open(box, k.Addr); err != nil || string(got) != "secret key" {
		t.Fatal("seal does not round-trip")
	}
	if _, err := s.Open(box, other.Addr); err == nil {
		t.Fatal("a sealed key opened for another wallet")
	}
}
