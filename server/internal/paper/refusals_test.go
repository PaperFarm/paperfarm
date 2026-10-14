package paper

import (
	"errors"
	"strings"
	"testing"
)

func TestExplain(t *testing.T) {
	for body, want := range map[string]string{
		`{"code":"admission_rejected","reason":"openInterest"}`:          "open interest limit",
		`{"payload":{"code":"admission_rejected","reason":"noDeposit"}}`: "Deposit funds",
		`{"code":"deadline_expired"}`:                                    "expired before it was accepted",
		`{"code":"admission_rejected","reason":"somethingNew"}`:          "(somethingNew)",
		`not json`: "answered 400",
	} {
		if got := Explain(&APIError{Status: 400, Body: []byte(body)}); !strings.Contains(got, want) {
			t.Errorf("%s: %q", body, got)
		}
	}
	if got := Explain(errors.New("dial tcp: timeout")); got != "dial tcp: timeout" {
		t.Errorf("non-Papertrade error changed: %q", got)
	}
}
