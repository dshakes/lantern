//go:build e2e

package examples_e2e

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dshakes/lantern/e2e/internal/e2ekit"
)

const (
	devTenant   = "00000000-0000-0000-0000-000000000001"
	twilioToken = "e2e-twilio-auth-token"
)

// twilioSig is Twilio's X-Twilio-Signature: base64(HMAC-SHA1(token, url + k1v1k2v2...)).
func twilioSig(token, fullURL string, form url.Values) string {
	keys := make([]string, 0, len(form))
	for k := range form {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(fullURL)
	for _, k := range keys {
		for _, v := range form[k] {
			b.WriteString(k + v)
		}
	}
	mac := hmac.New(sha1.New, []byte(token))
	mac.Write([]byte(b.String()))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// X7: signed Twilio webhooks -> TwiML, over-budget -> <Reject>, status
// callback reconciles the connect-time estimate into agent_usage_daily.
func TestVoice_InboundBudgetAndCostReconcile(t *testing.T) {
	k := connect(t).kit
	db := openDB(t)
	base := e2ekit.DefaultBase()
	ctx := context.Background()

	agentFromManifest(t, k, "e2e-voice", "voice-receptionist")

	number := fmt.Sprintf("+1555%07d", time.Now().UnixNano()%10_000_000)
	var created struct {
		ID string `json:"id"`
	}
	numCfg := readJSON(t, "voice-receptionist/number.json")
	numCfg["agentName"] = "e2e-voice"
	numCfg["phoneNumber"] = number
	numCfg["providerConfig"] = map[string]any{"accountSid": "ACe2e", "authToken": twilioToken}
	if st, raw := k.DoAuth(t, http.MethodPost, "/v1/voice/numbers", numCfg, &created); st != http.StatusCreated {
		t.Fatalf("create voice number: HTTP %d: %s", st, raw)
	}
	t.Cleanup(func() { k.DoAuth(t, http.MethodDelete, "/v1/voice/numbers/"+created.ID, nil, nil) })

	webhook := base + "/v1/voice/webhook/twilio"
	status := base + "/v1/voice/calls/status/twilio"
	callSID := func(tag string) string { return fmt.Sprintf("CA%s%d", tag, time.Now().UnixNano()) }
	inbound := func(sid string, sign bool) (int, string) {
		form := url.Values{"CallSid": {sid}, "From": {"+14155550123"}, "To": {number}, "CallStatus": {"ringing"}}
		sig := ""
		if sign {
			sig = twilioSig(twilioToken, webhook, form)
		}
		return postForm(t, webhook, form, sig)
	}
	callback := func(sid, state, secs, token string) int {
		form := url.Values{"CallSid": {sid}, "CallStatus": {state}, "CallDuration": {secs}}
		st, _ := postForm(t, status, form, twilioSig(token, status, form))
		return st
	}
	spend := func() float64 {
		var v float64
		if err := db.QueryRow(ctx,
			`SELECT COALESCE(SUM(cost_usd), 0)::float8 FROM agent_usage_daily WHERE tenant_id = $1 AND agent_name = 'e2e-voice'`,
			devTenant).Scan(&v); err != nil {
			t.Fatalf("read agent_usage_daily: %v", err)
		}
		return v
	}
	calls := func() int {
		var n int
		_ = db.QueryRow(ctx, `SELECT count(*) FROM voice_calls WHERE tenant_id = $1 AND agent_name = 'e2e-voice'`, devTenant).Scan(&n)
		return n
	}
	near := func(got, want float64, what string) {
		t.Helper()
		if math.Abs(got-want) > 1e-6 {
			t.Fatalf("%s = %.4f, want %.4f", what, got, want)
		}
	}
	start := spend()

	// 1. Forged / unsigned webhooks are refused and leave no trace.
	if st, _ := inbound(callSID("bad"), false); st != http.StatusForbidden {
		t.Fatalf("unsigned inbound: HTTP %d, want 403", st)
	}
	forged := url.Values{"CallSid": {callSID("forged")}, "To": {number}}
	if st, _ := postForm(t, webhook, forged, twilioSig("wrong-token", webhook, forged)); st != http.StatusForbidden {
		t.Fatalf("wrong-token inbound: HTTP %d, want 403", st)
	}
	if calls() != 0 {
		t.Fatalf("rejected webhooks recorded %d calls", calls())
	}
	near(spend(), start, "spend after forged webhooks")

	// 2. A signed inbound call gets TwiML and reserves the flat estimate (0.05).
	sidA := callSID("A")
	st, body := inbound(sidA, true)
	if st != http.StatusOK || !strings.Contains(body, "<Response>") || !strings.Contains(body, "<Say") || strings.Contains(body, "<Reject") {
		t.Fatalf("inbound: HTTP %d body %q, want TwiML with <Say>", st, body)
	}
	near(spend()-start, 0.05, "reserved spend after connect")

	// 3. A status callback with the wrong token cannot move the budget.
	if st := callback(sidA, "completed", "61", "wrong-token"); st != http.StatusForbidden {
		t.Fatalf("forged status callback: HTTP %d, want 403", st)
	}
	near(spend()-start, 0.05, "spend after forged status callback")

	// 4. The real callback: 61s = 2 started minutes * $0.03 = $0.06, reconciled
	// from the 0.05 reservation; replaying it is a no-op.
	if st := callback(sidA, "completed", "61", twilioToken); st != http.StatusNoContent {
		t.Fatalf("status callback: HTTP %d, want 204", st)
	}
	near(spend()-start, 0.06, "reconciled spend")
	var callStatus string
	var cost float64
	var durMs int64
	if err := db.QueryRow(ctx,
		`SELECT status, cost_usd::float8, duration_ms FROM voice_calls WHERE provider_call_id = $1`, sidA).Scan(&callStatus, &cost, &durMs); err != nil {
		t.Fatalf("read voice_calls: %v", err)
	}
	if callStatus != "completed" || durMs != 61000 {
		t.Fatalf("voice_calls = %s/%dms, want completed/61000", callStatus, durMs)
	}
	near(cost, 0.06, "voice_calls.cost_usd")
	callback(sidA, "completed", "61", twilioToken)
	near(spend()-start, 0.06, "spend after replayed callback")

	// 5. A call that never connects refunds its reservation in full.
	sidB := callSID("B")
	if st, _ := inbound(sidB, true); st != http.StatusOK {
		t.Fatalf("second inbound: HTTP %d", st)
	}
	near(spend()-start, 0.11, "spend with second reservation")
	if st := callback(sidB, "no-answer", "0", twilioToken); st != http.StatusNoContent {
		t.Fatalf("no-answer callback: HTTP %d", st)
	}
	near(spend()-start, 0.06, "spend after refund")

	// 6. Over a hard-fail budget the call is declined with <Reject> before it
	// connects: no TwiML to speak, no reservation, no call row.
	callsBefore := calls()
	if st, raw := k.DoAuth(t, http.MethodPut, "/v1/agents/e2e-voice/budget", map[string]any{
		"maxCostUsdPerDay": 0.01, "maxRunsPerDay": e2ekit.MaxRunsPerDay, "hardFail": true,
	}, nil); st != http.StatusOK && st != http.StatusCreated && st != http.StatusNoContent {
		t.Fatalf("tighten budget: HTTP %d: %s", st, raw)
	}
	st, body = inbound(callSID("C"), true)
	if st != http.StatusOK || !strings.Contains(body, "<Reject") || strings.Contains(body, "<Say") {
		t.Fatalf("over-budget inbound: HTTP %d body %q, want <Reject/>", st, body)
	}
	near(spend()-start, 0.06, "spend after rejected call")
	if calls() != callsBefore {
		t.Fatalf("rejected call was recorded (%d -> %d rows)", callsBefore, calls())
	}
}
