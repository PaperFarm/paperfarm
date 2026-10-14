package paper

import (
	"encoding/json"
	"os"
	"testing"
)

// The vector the browser signer must reproduce (web/src/lib/sign.check.ts reads testdata/vector.json).
// UPDATE=1 rewrites it. The key below is the well-known public example key from the ethers.js docs
// (address 0x2c7536e3605d9c16a7a3d7b1898e529396a65c23): a fixture only, it holds nothing.
func TestSignVector(t *testing.T) {
	k, err := ParseKey("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318")
	if err != nil {
		t.Fatal(err)
	}
	user := "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23"
	cases := []struct {
		Dom, Primary string
		Msg          map[string]any
	}{
		{"exchange", "RegisterSessionKey", map[string]any{"key": "0x00000000000000000000000000000000000000AA", "expiry": 1794111270, "feeAddress": "0x0000000000000000000000000000000000000000", "nonce": "123456789", "deadline": 1791969775}},
		{"exchange", "OpenPosition", map[string]any{"instrumentId": 0, "isLong": true, "size": USDRaw(12.34), "leverage": 777, "useDebt": false, "nonce": "340282366920938463463374607431768211455", "deadline": 1791969775}},
		{"exchange", "Close", map[string]any{"positionIds": []string{"577598", "577599"}, "nonce": "42", "deadline": 1791969775}},
		{"cancel", "CancelIntent", map[string]any{"intentId": "0x0489a09da2b02ee4bf417ddc2b9a15f3ab609d5a7a4ebd5b20fe2f70ca2176ae", "deadline": 1791969775}},
	}
	type out struct {
		Dom, Primary string
		Msg          map[string]any
		Signed       map[string]any
		ID           string
	}
	var got []out
	for _, c := range cases {
		in := map[string]any{}
		for k, v := range c.Msg {
			in[k] = v
		}
		signed, id, err := Sign(k, c.Dom, c.Primary, user, in)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, out{c.Dom, c.Primary, c.Msg, signed, id})
	}
	b, _ := json.MarshalIndent(map[string]any{"key": "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", "user": user, "cases": got}, "", " ")
	if os.Getenv("UPDATE") == "1" {
		os.MkdirAll("testdata", 0o755)
		os.WriteFile("testdata/vector.json", b, 0o644)
	}
	want, err := os.ReadFile("testdata/vector.json")
	if err != nil {
		t.Fatal("no vector; run with UPDATE=1 once")
	}
	if string(want) != string(b) {
		t.Fatal("signing changed: the vector no longer matches")
	}
	if USDRaw(12.34) != "12340000000000000000" || USDRaw(0.019) != "10000000000000000" {
		t.Fatal("USDRaw")
	}
}
