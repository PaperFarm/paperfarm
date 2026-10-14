package paper

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// Papertrade's own wording for why it refused an intent: the same table its exchange shows traders.
// Admission refusals come as {"code":"admission_rejected","reason":...}; a queued intent that fails later
// carries the same reason in the account stream's intent outcomes.
var refusals = map[string]string{
	"tradingPaused":        "Trading is paused. Please try again once trading resumes.",
	"marketPaused":         "This market is paused. Please try again once it reopens.",
	"inactiveInstrument":   "This market is no longer available for trading.",
	"belowMinimum":         "Your margin is below the minimum trade size. Increase it and try again.",
	"belowMinimumNotional": "Position value (margin × leverage) is below the minimum. Increase your margin or leverage and try again.",
	"leverageTooHigh":      "Leverage exceeds this market's limit. Lower it and try again.",
	"positionTooLarge":     "This position exceeds the market's size limit. Reduce your margin or leverage.",
	"openInterest":         "This market has reached its open interest limit. Reduce your position size or try again later.",
	"funding":              "Your available collateral has changed. Review your balance and reduce the trade size.",
	"noOpenPositions":      "These positions are already closed or have a close request pending.",
	"paperBalance":         "You do not have enough available PAPER to stake this amount.",
	"stakedBalance":        "You do not have enough staked PAPER to unstake this amount.",
	"sessionKeyLimit":      "This wallet has reached its trading session limit. Reuse an existing session or wait for one to expire.",
	"noDeposit":            "Deposit funds to enable trading.",
	"noRewards":            "You have no rewards to claim right now.",
}

// And for requests it could not take at all.
var requestErrors = map[string]string{
	"invalid_intent":           "This request could not be validated. Review it and try again.",
	"deadline_expired":         "This request expired before it was accepted. Review it and try again.",
	"unauthorized_intent":      "Your trading authorization is no longer valid. Authenticate again to continue.",
	"intent_not_found":         "This request could not be found. Check your activity for its latest status.",
	"below_minimum_withdrawal": "Withdraw at least 10 USDC to HyperCore.",
	"rate_limited":             "Too many requests. Please try again shortly.",
}

// Reason is Papertrade's sentence for a refusal reason, or the reason itself when it has none.
func Reason(r string) string {
	if m := refusals[r]; m != "" {
		return m
	}
	return r
}

// Explain turns an error from Papertrade into the sentence its exchange would show; any other error is
// returned as it is.
func Explain(err error) string {
	var ae *APIError
	if !errors.As(err, &ae) {
		return err.Error()
	}
	type body struct{ Code, Reason, Error string }
	var b struct {
		body
		Payload *body
	}
	json.Unmarshal(ae.Body, &b)
	if b.Payload != nil && b.Code == "" {
		b.body = *b.Payload
	}
	switch {
	case b.Code == "admission_rejected" && refusals[b.Reason] != "":
		return refusals[b.Reason]
	case requestErrors[b.Code] != "":
		return requestErrors[b.Code]
	case ae.Status == http.StatusTooManyRequests:
		return requestErrors["rate_limited"]
	case b.Reason != "":
		return "This request could not be accepted (" + b.Reason + "). Review your account and try again."
	case b.Code != "" || b.Error != "":
		return fmt.Sprintf("This request could not be accepted (%s%s). Review your account and try again.", b.Code, b.Error)
	}
	return fmt.Sprintf("Papertrade answered %d. Review your account and try again.", ae.Status)
}
