package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"

	"paperfarm/internal/auth"
	"paperfarm/internal/farm"
	"paperfarm/internal/paper"
	"paperfarm/internal/store"
)

func testAPI(t *testing.T) (*httptest.Server, *farm.Engine, store.Store, *auth.Sealer) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	seal, _ := auth.NewSealer("test-secret-test-secret-test-secret-0123")
	market := paper.Market{MinMargin: 10, MinNotional: 1000, Coins: map[string]paper.Coin{"BTC": {Coin: "BTC", Openable: true, MaxLeverage: 1000, MaxNotional: 1e7}}}
	e := farm.NewEngine(context.Background(), st, nil, seal) // never Run: no trading lease, no farmers, no network
	e.Market = func(context.Context) (paper.Market, error) { return market, nil }
	mux := http.NewServeMux()
	(&server{e: e, auth: auth.New(seal), seal: seal}).routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, e, st, seal
}

type client struct {
	t      *testing.T
	srv    *httptest.Server
	cookie string
}

func (c *client) do(method, path string, body any, csrf bool) (int, map[string]any) {
	c.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, c.srv.URL+path, bytes.NewReader(b))
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	if csrf {
		req.Header.Set("X-PF", "1")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	for _, ck := range res.Cookies() {
		if ck.Name == "pf_s" {
			c.cookie = "pf_s=" + ck.Value
		}
	}
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func signIn(t *testing.T, srv *httptest.Server, k *paper.Key) *client {
	c := &client{t: t, srv: srv}
	_, ch := c.do("POST", "/api/auth/challenge", map[string]string{"address": k.Addr}, false)
	priv, _ := crypto.HexToECDSA(k.Hex()[2:])
	sig, _ := crypto.Sign(accounts.TextHash([]byte(ch["message"].(string))), priv)
	sig[64] += 27
	if code, _ := c.do("POST", "/api/auth/verify", map[string]string{"address": k.Addr, "signature": hexutil.Encode(sig)}, false); code != 200 {
		t.Fatalf("sign-in: %d", code)
	}
	return c
}

func TestAPI(t *testing.T) {
	srv, e, st, seal := testAPI(t)
	anon := &client{t: t, srv: srv}
	if code, _ := anon.do("POST", "/api/me/farms", map[string]any{}, true); code != 401 {
		t.Fatalf("signed out create: %d", code)
	}
	if _, me := anon.do("GET", "/api/me", nil, false); me["address"] != nil {
		t.Fatal("signed out /api/me named a wallet")
	}

	alice, bob := paper.NewKey(), paper.NewKey()
	a := signIn(t, srv, alice)
	if code, _ := a.do("POST", "/api/me/key", nil, false); code != 403 {
		t.Fatalf("a mutation without the CSRF header: %d", code)
	}
	newFarm := map[string]any{"coin": "btc", "notional": 5000, "lev": 20, "tp": 0.005, "slots": 1}
	if code, _ := a.do("POST", "/api/me/farms", newFarm, true); code != 409 {
		t.Fatalf("a farm before a trading key: %d", code)
	}
	code, key := a.do("POST", "/api/me/key", nil, true)
	if code != 200 || key["feeAddress"] != paper.ZeroAddr {
		t.Fatalf("new key: %d %v", code, key)
	}

	// A registration must name this wallet and the key the server holds for it; checked before anything is sent.
	reg := map[string]any{"user": alice.Addr, "key": bob.Addr, "expiry": fmt.Sprint(int64(key["expiry"].(float64)))}
	if code, _ := a.do("POST", "/api/me/key/register", map[string]any{"signed": reg}, true); code != 400 {
		t.Fatalf("a registration for another key: %d", code)
	}
	reg["key"], reg["user"] = key["key"], bob.Addr
	if code, _ := a.do("POST", "/api/me/key/register", map[string]any{"signed": reg}, true); code != 400 {
		t.Fatalf("a registration for another wallet: %d", code)
	}

	for _, bad := range []map[string]any{
		{"coin": "DOGE", "notional": 5000, "lev": 20, "tp": 0.005, "slots": 1},
		{"coin": "BTC", "notional": 500, "lev": 20, "tp": 0.005, "slots": 1},    // below the minimum size
		{"coin": "BTC", "notional": 5000, "lev": 1000, "tp": 0.005, "slots": 1}, // $5 margin
		{"coin": "BTC", "notional": 5000, "lev": 20.5, "tp": 0.005, "slots": 1},
		{"coin": "BTC", "notional": 5000, "lev": 20, "tp": 0.2, "slots": 1},
		{"coin": "BTC", "notional": 5000, "lev": 20, "tp": 0.005, "slots": 11},
	} {
		if code, out := a.do("POST", "/api/me/farms", bad, true); code != 400 {
			t.Errorf("accepted %v: %d %v", bad, code, out)
		}
	}
	code, f := a.do("POST", "/api/me/farms", newFarm, true)
	if code != 200 || f["coin"] != "BTC" || f["running"] != true {
		t.Fatalf("create farm: %d %v", code, f)
	}
	id := f["id"].(string)
	if code, _ := a.do("DELETE", "/api/me/farms/"+id, nil, true); code != 400 {
		t.Fatalf("deleted a running farm: %d", code)
	}
	if code, f := a.do("PATCH", "/api/me/farms/"+id, map[string]any{"running": false, "tp": 0.01, "slots": 3}, true); code != 200 || f["tp"] != 0.01 || f["slots"] != 3.0 || f["running"] != false {
		t.Fatalf("patch farm: %d %v", code, f)
	}

	// The window layout is kept per wallet, as given; anything but a JSON object is refused.
	if code, _ := a.do("PUT", "/api/me/board", map[string]any{"items": []any{}}, true); code != 200 {
		t.Fatalf("save layout: %d", code)
	}
	if code, _ := a.do("PUT", "/api/me/board", []any{1}, true); code != 400 {
		t.Fatalf("saved a non-object layout: %d", code)
	}
	if _, me := a.do("GET", "/api/me", nil, false); me["board"] == nil {
		t.Fatal("layout not returned")
	}

	// Another wallet sees none of it and cannot touch it.
	b := signIn(t, srv, bob)
	if _, me := b.do("GET", "/api/me", nil, false); len(me["farms"].([]any)) != 0 || me["board"] != nil {
		t.Fatal("bob sees alice's farms")
	}
	if code, _ := b.do("PATCH", "/api/me/farms/"+id, map[string]any{"running": true}, true); code != 404 {
		t.Fatalf("bob patched alice's farm: %d", code)
	}
	if code, _ := a.do("DELETE", "/api/me/farms/"+id, nil, true); code != 200 {
		t.Fatalf("delete a paused farm: %d", code)
	}

	// The trading key is stored sealed and opens as a key for alice only.
	d, _ := e.Doc(alice.Addr)
	if strings.Contains(d.Key.Sealed, "0x") || d.Key.Addr != key["key"] {
		t.Fatal("trading key not sealed, or not the one returned")
	}
	tr, err := e.Trader(d)
	if err != nil || tr.Key.Addr != key["key"] {
		t.Fatalf("trader: %v", err)
	}
	if _, err := seal.Open(d.Key.Sealed, bob.Addr); err == nil {
		t.Fatal("alice's key opened for bob")
	}

	// It all survives a restart.
	e2 := farm.NewEngine(context.Background(), st, nil, seal)
	d2, err := e2.Doc(alice.Addr)
	if err != nil || d2.Key == nil || d2.Key.Addr != d.Key.Addr {
		t.Fatalf("reload: %v", err)
	}
}
