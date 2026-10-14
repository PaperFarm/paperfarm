// Package auth is wallet sign-in, session cookies, and the sealer that encrypts trading keys at rest.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

// Sign-in: the wallet signs a one-time message (personal_sign), which proves it owns the address. The
// server answers with an httpOnly, SameSite=Strict cookie carrying the address, an expiry and an HMAC.
// Every farm action needs that cookie plus an X-PF header, which a cross-site form cannot send.

const sessionTTL = 7 * 24 * time.Hour

type Auth struct {
	seal       *Sealer
	mu         sync.Mutex
	challenges map[string]challenge // address -> outstanding challenge
}

type challenge struct {
	msg string
	exp time.Time
}

func New(s *Sealer) *Auth { return &Auth{seal: s, challenges: map[string]challenge{}} }

func (a *Auth) Challenge(addr, host string, now time.Time) string {
	nonce := make([]byte, 16)
	rand.Read(nonce)
	msg := fmt.Sprintf("Sign in to paperfarm at %s\n\nWallet: %s\nNonce: %s\nIssued: %s\n\nThis only proves you own this wallet. It cannot move funds or place trades.",
		host, addr, hex.EncodeToString(nonce), now.UTC().Format(time.RFC3339))
	a.mu.Lock()
	defer a.mu.Unlock()
	for k, c := range a.challenges { // forget stale ones
		if now.After(c.exp) {
			delete(a.challenges, k)
		}
	}
	a.challenges[addr] = challenge{msg, now.Add(5 * time.Minute)}
	return msg
}

// Verify checks the signature over the outstanding challenge, once.
func (a *Auth) Verify(addr, sigHex string, now time.Time) error {
	a.mu.Lock()
	c, ok := a.challenges[addr]
	delete(a.challenges, addr)
	a.mu.Unlock()
	if !ok || now.After(c.exp) {
		return errors.New("no sign-in request for this wallet, or it expired; try again")
	}
	sig, err := hexutil.Decode(sigHex)
	if err != nil || len(sig) != 65 {
		return errors.New("malformed signature")
	}
	if sig[64] >= 27 {
		sig[64] -= 27
	}
	pub, err := crypto.SigToPub(accounts.TextHash([]byte(c.msg)), sig)
	if err != nil {
		return errors.New("bad signature")
	}
	if !strings.EqualFold(crypto.PubkeyToAddress(*pub).Hex(), addr) {
		return errors.New("the signature is not from this wallet")
	}
	return nil
}

func (a *Auth) cookieValue(addr string, exp time.Time) string {
	body := addr + "." + strconv.FormatInt(exp.Unix(), 10)
	return body + "." + hex.EncodeToString(a.seal.mac(body))
}

// SetSession sets the session cookie; secure when the request came over HTTPS.
func (a *Auth) SetSession(w http.ResponseWriter, addr string, now time.Time, secure bool) {
	exp := now.Add(sessionTTL)
	http.SetCookie(w, &http.Cookie{Name: "pf_s", Value: a.cookieValue(addr, exp), Path: "/", Expires: exp, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: secure})
}

func (a *Auth) ClearSession(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: "pf_s", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
}

// User returns the signed-in wallet, or "".
func (a *Auth) User(r *http.Request, now time.Time) string {
	c, err := r.Cookie("pf_s")
	if err != nil {
		return ""
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 || !common.IsHexAddress(parts[0]) {
		return ""
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || now.Unix() > exp {
		return ""
	}
	want := a.seal.mac(parts[0] + "." + parts[1])
	got, err := hex.DecodeString(parts[2])
	if err != nil || !hmac.Equal(want, got) {
		return ""
	}
	return strings.ToLower(parts[0])
}
