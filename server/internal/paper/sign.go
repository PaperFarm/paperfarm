package paper

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	gmath "github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// Papertrade intents, as its frontend signs them (typed-data chunk of the live build, 2026-10-14).
// The browser signs the same way (web/src/lib/paper.ts); sign_test.go pins a vector both must match.

var (
	exchangeAddr = "0x6cd5661646289fb6e65ea5c032310fded797d0a2"
	stakingAddr  = "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016"

	domains = map[string]apitypes.TypedDataDomain{
		"exchange": domain("String", "1", exchangeAddr), // the exchange's domain name really is "String"
		"staking":  domain("PaperStaking", "1", stakingAddr),
		"cancel":   domain("PaperTrade Intent Cancel", "2", exchangeAddr),
	}
	intentIDPrefix = crypto.Keccak256([]byte("papertrade:intent-id:v2"))

	intentTypes = apitypes.Types{
		"RegisterSessionKey": {{Name: "user", Type: "address"}, {Name: "key", Type: "address"}, {Name: "expiry", Type: "uint64"}, {Name: "feeAddress", Type: "address"}, {Name: "nonce", Type: "uint256"}, {Name: "deadline", Type: "uint64"}},
		"OpenPosition": {{Name: "user", Type: "address"}, {Name: "instrumentId", Type: "uint32"}, {Name: "isLong", Type: "bool"}, {Name: "size", Type: "uint128"},
			{Name: "leverage", Type: "uint32"}, {Name: "useDebt", Type: "bool"}, {Name: "nonce", Type: "uint256"}, {Name: "deadline", Type: "uint64"}},
		"Close":        {{Name: "user", Type: "address"}, {Name: "positionIds", Type: "uint256[]"}, {Name: "nonce", Type: "uint256"}, {Name: "deadline", Type: "uint64"}},
		"CancelIntent": {{Name: "user", Type: "address"}, {Name: "intentId", Type: "bytes32"}, {Name: "deadline", Type: "uint256"}},
	}
)

func domain(name, version, c string) apitypes.TypedDataDomain {
	return apitypes.TypedDataDomain{Name: name, Version: version, ChainId: gmath.NewHexOrDecimal256(999), VerifyingContract: c}
}

type Key struct {
	priv *ecdsa.PrivateKey
	Addr string // lowercase hex
}

func ParseKey(hex string) (*Key, error) {
	k, err := crypto.HexToECDSA(strings.TrimPrefix(strings.TrimSpace(hex), "0x"))
	if err != nil {
		return nil, fmt.Errorf("not a private key")
	}
	return &Key{k, strings.ToLower(crypto.PubkeyToAddress(k.PublicKey).Hex())}, nil
}

func NewKey() *Key {
	k, _ := crypto.GenerateKey()
	return &Key{k, strings.ToLower(crypto.PubkeyToAddress(k.PublicKey).Hex())}
}

func (k *Key) Hex() string { return hexutil.Encode(crypto.FromECDSA(k.priv)) }

// randomNonce: nonces are single-use; any unused one works.
func randomNonce() string {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	return n.String()
}

// Sign signs one intent for `user` with key k and returns it in the wire form (integers as decimal
// strings, lowercase hex, v/r/s) and its id: keccak256(keccak256("papertrade:intent-id:v2") ‖ digest ‖ signer).
func Sign(k *Key, dom, primary, user string, msg map[string]any) (map[string]any, string, error) {
	msg["user"] = user
	if _, ok := msg["nonce"]; !ok && primary != "CancelIntent" {
		msg["nonce"] = randomNonce()
	}
	wire := map[string]any{}
	for _, f := range intentTypes[primary] {
		v, ok := msg[f.Name]
		if !ok {
			return nil, "", fmt.Errorf("%s: no %s", primary, f.Name)
		}
		switch {
		case f.Type == "uint256[]":
			var l []any
			for _, x := range v.([]string) {
				l = append(l, x)
			}
			v = l
		case strings.HasPrefix(f.Type, "uint"):
			v = fmt.Sprint(v)
		case f.Type == "address" || strings.HasPrefix(f.Type, "bytes"):
			v = strings.ToLower(fmt.Sprint(v))
		}
		wire[f.Name] = v
	}
	digest, err := typedHash(domains[dom], primary, wire)
	if err != nil {
		return nil, "", err
	}
	sig, err := crypto.Sign(digest, k.priv)
	if err != nil {
		return nil, "", err
	}
	wire["v"], wire["r"], wire["s"] = strconv.Itoa(27+int(sig[64])), hexutil.Encode(sig[:32]), hexutil.Encode(sig[32:64])
	return wire, hexutil.Encode(crypto.Keccak256(intentIDPrefix, digest, common.HexToAddress(k.Addr).Bytes())), nil
}

func typedHash(d apitypes.TypedDataDomain, primary string, wire map[string]any) ([]byte, error) {
	types := apitypes.Types{
		"EIP712Domain": {{Name: "name", Type: "string"}, {Name: "version", Type: "string"}, {Name: "chainId", Type: "uint256"}, {Name: "verifyingContract", Type: "address"}},
		primary:        intentTypes[primary],
	}
	msg := apitypes.TypedDataMessage{}
	for _, f := range intentTypes[primary] {
		msg[f.Name] = wire[f.Name]
	}
	hash, _, err := apitypes.TypedDataAndHash(apitypes.TypedData{Types: types, PrimaryType: primary, Domain: d, Message: msg})
	return hash, err
}

// USDRaw is usd at 18 decimals, rounded down to the cent.
func USDRaw(usd float64) string {
	c := big.NewInt(int64(usd*100 + 1e-6))
	return c.Mul(c, new(big.Int).Exp(big.NewInt(10), big.NewInt(16), nil)).String()
}

// CancelIntent withdraws a queued intent; Papertrade refuses (intent_conflict) once it is executing it.
func (p *Client) CancelIntent(ctx context.Context, sk *Key, user, id string) error {
	signed, _, err := Sign(sk, "cancel", "CancelIntent", user, map[string]any{"intentId": id, "deadline": time.Now().Add(time.Hour).Unix()})
	if err != nil {
		return err
	}
	delete(signed, "intentId") // it travels in the path
	b, _ := json.Marshal(signed)
	_, err = p.Do(ctx, "POST", "/intents/"+id+"/cancel", b)
	return err
}

// Submit posts one signed intent. Papertrade already knowing it (intent_conflict) counts as accepted.
func (p *Client) Submit(ctx context.Context, action string, signed map[string]any, id string) error {
	b, _ := json.Marshal(map[string]any{"action": action, "signed": signed})
	out, err := p.Do(ctx, "POST", "/intents", b)
	var ae *APIError
	if errors.As(err, &ae) && strings.Contains(string(ae.Body), "intent_conflict") {
		return nil
	}
	if err != nil {
		return err
	}
	var ack struct{ IntentID string }
	json.Unmarshal(out, &ack)
	if ack.IntentID != "" && !strings.EqualFold(ack.IntentID, id) {
		return fmt.Errorf("Papertrade acknowledged %s, we signed %s", ack.IntentID, id)
	}
	return nil
}

const ZeroAddr = "0x0000000000000000000000000000000000000000"
