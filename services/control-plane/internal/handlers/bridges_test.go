package handlers

// Tests for PAL device tenancy (ADR 0047): pairing-code generation, the pair
// rate limiter, the legacy-tenant flag, and — against a genuinely
// RLS-enforced server (newEnforcedServer) — the full enroll → pair → signals →
// rotate → revoke lifecycle, cross-tenant isolation, token hashing at rest,
// scope checks, and the legacy shared-token path.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- pure unit tests (no DB) ----------

func TestPairingCode_FormatAndNormalize(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		c, err := newPairingCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(c) != pairingCodeLen+1 || c[pairingCodeLen/2] != '-' {
			t.Fatalf("code %q: want XXXXX-XXXXX", c)
		}
		n := normalizePairingCode(c)
		if n == "" || len(n) != pairingCodeLen {
			t.Fatalf("normalize(%q) = %q", c, n)
		}
		if seen[n] {
			t.Fatalf("duplicate code %q in 200 draws", n)
		}
		seen[n] = true
	}
	cases := map[string]string{
		"abcde-fghjk":   "ABCDEFGHJK",
		" ABCDE FGHJK ": "ABCDEFGHJK",
		"0O1IL-23456":   "0011123456", // Crockford look-alikes fold
		"ABCDE-FGHJ":    "",           // too short
		"ABCDE-FGHJKM":  "",           // too long
		"ABCDE-FGHJU":   "",           // U is not Crockford
		"ABCDE_FGHJK":   "",           // stray separator
	}
	for in, want := range cases {
		if got := normalizePairingCode(in); got != want {
			t.Errorf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPairLimiter_PerIPGlobalAndWindow(t *testing.T) {
	l := newPairLimiter(2, 3, time.Minute)
	t0 := time.Unix(1_000_000, 0)
	if !l.allow("a", t0) || !l.allow("a", t0) {
		t.Fatal("first two attempts from one IP must pass")
	}
	if l.allow("a", t0) {
		t.Fatal("third attempt from the same IP in the window must be refused")
	}
	if !l.allow("b", t0) {
		t.Fatal("a different IP has its own bucket")
	}
	if l.allow("c", t0) {
		t.Fatal("global ceiling (3) must refuse a 4th attempt from any IP")
	}
	if !l.allow("a", t0.Add(time.Minute)) {
		t.Fatal("a new window must reset the buckets")
	}
}

func TestLegacyOwnerTenant(t *testing.T) {
	for in, want := range map[string]string{
		"":                                     legacyOwnerDefaultTenant,
		"off":                                  "",
		"OFF":                                  "",
		"none":                                 "",
		"not-a-uuid":                           "",
		"11111111-1111-1111-1111-111111111111": "11111111-1111-1111-1111-111111111111",
	} {
		t.Setenv("PAL_SIGNALS_LEGACY_OWNER_TENANT", in)
		if got := legacyOwnerTenant(); got != want {
			t.Errorf("PAL_SIGNALS_LEGACY_OWNER_TENANT=%q → %q, want %q", in, got, want)
		}
	}
}

func signalReq(method, body string, hdr map[string]string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/v1/signals", nil)
	} else {
		r = httptest.NewRequest(method, "/v1/signals", strings.NewReader(body))
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

// An Authorization header is always judged on its own merits: a bad bearer
// must NOT fall through to the shared-secret path even when the correct
// legacy header is also present.
func TestSignals_AuthorizationNeverFallsBackToLegacy(t *testing.T) {
	isolateHome(t)
	t.Setenv("PAL_SIGNAL_TOKEN", "legacy-secret")
	logger, _ := zap.NewDevelopment()
	h := NewSignalHandler(&server.Server{Logger: logger}, NewAuthHandler(&server.Server{Logger: logger}, testJWTSecret))
	for _, bearer := range []string{"Bearer pal_brg_deadbeef", "Bearer not-a-jwt"} {
		rr := httptest.NewRecorder()
		h.IngestSignal(rr, signalReq(http.MethodPost, `{"kind":"wake","detail":"x"}`, map[string]string{
			"Authorization":          bearer,
			"x-lantern-signal-token": "legacy-secret",
		}))
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("%s + valid legacy header: got %d, want 401", bearer, rr.Code)
		}
	}
}

func TestSignals_KioskAndScopedKeyRejected(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	h := NewSignalHandler(&server.Server{Logger: logger}, NewAuthHandler(&server.Server{Logger: logger}, testJWTSecret))
	tok := mintTestToken(t, uuid.NewString(), "kiosk-visitor", kioskRole)
	rr := httptest.NewRecorder()
	h.IngestSignal(rr, signalReq(http.MethodPost, `{"kind":"wake","detail":"x"}`, map[string]string{"Authorization": bearerHeader(tok)}))
	if rr.Code != http.StatusForbidden {
		t.Errorf("kiosk JWT write: got %d, want 403", rr.Code)
	}
}

func TestSignals_LegacyDisabledByFlag(t *testing.T) {
	isolateHome(t)
	t.Setenv("PAL_SIGNAL_TOKEN", "legacy-secret")
	t.Setenv("PAL_SIGNALS_LEGACY_OWNER_TENANT", "off")
	h := newSignalHandlerForTest(t)
	rr := httptest.NewRecorder()
	h.IngestSignal(rr, signalReq(http.MethodPost, `{"kind":"wake","detail":"x"}`, map[string]string{"x-lantern-signal-token": "legacy-secret"}))
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("legacy path with flag off: got %d, want 401", rr.Code)
	}
}

func TestSignals_LegacyAcceptsPALHeader(t *testing.T) {
	isolateHome(t)
	t.Setenv("PAL_SIGNAL_TOKEN", "legacy-secret")
	h := newSignalHandlerForTest(t)
	rr := httptest.NewRecorder()
	h.IngestSignal(rr, signalReq(http.MethodPost, `{"kind":"wake","detail":"x"}`, map[string]string{"x-pal-signal-token": "legacy-secret"}))
	if rr.Code != http.StatusOK {
		t.Errorf("x-pal-signal-token: got %d, want 200; body %s", rr.Code, rr.Body.String())
	}
}

// ---------- DB-backed, RLS-enforced lifecycle tests ----------

type bridgeFixture struct {
	e  *enforcedServer
	bh *BridgeHandler
	sh *SignalHandler
}

func newBridgeFixture(t *testing.T) *bridgeFixture {
	t.Helper()
	e := newEnforcedServer(t)
	auth := NewAuthHandler(e.srv, testJWTSecret)
	return &bridgeFixture{e: e, bh: NewBridgeHandler(e.srv, auth), sh: NewSignalHandler(e.srv, auth)}
}

func (f *bridgeFixture) userTok(t *testing.T, tenant string) string {
	return mintTestToken(t, tenant, uuid.NewString(), "owner")
}

func (f *bridgeFixture) enroll(t *testing.T, tenant string, body map[string]any) (*httptest.ResponseRecorder, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, "/v1/bridges/enroll", bytes.NewReader(b))
	r.Header.Set("Authorization", bearerHeader(f.userTok(t, tenant)))
	rr := httptest.NewRecorder()
	f.bh.Enroll(rr, r)
	var out struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr, out.Code
}

type pairResp struct {
	BridgeID string   `json:"bridgeId"`
	TenantID string   `json:"tenantId"`
	Token    string   `json:"token"`
	Scopes   []string `json:"scopes"`
}

func (f *bridgeFixture) pair(t *testing.T, code string) (*httptest.ResponseRecorder, pairResp) {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"code": code, "name": "Test Mac"})
	r := httptest.NewRequest(http.MethodPost, "/v1/bridges/pair", bytes.NewReader(b))
	rr := httptest.NewRecorder()
	f.bh.Pair(rr, r)
	var out pairResp
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr, out
}

func (f *bridgeFixture) enrollAndPair(t *testing.T, tenant string, body map[string]any) pairResp {
	t.Helper()
	rr, code := f.enroll(t, tenant, body)
	if rr.Code != http.StatusCreated || code == "" {
		t.Fatalf("enroll: %d %s", rr.Code, rr.Body.String())
	}
	prr, p := f.pair(t, code)
	if prr.Code != http.StatusCreated || p.Token == "" {
		t.Fatalf("pair: %d %s", prr.Code, prr.Body.String())
	}
	return p
}

func (f *bridgeFixture) postSignal(t *testing.T, authz, body string) int {
	t.Helper()
	rr := httptest.NewRecorder()
	f.sh.IngestSignal(rr, signalReq(http.MethodPost, body, map[string]string{"Authorization": authz}))
	return rr.Code
}

func (f *bridgeFixture) listSignals(t *testing.T, authz string) (int, []signalEntry) {
	t.Helper()
	rr := httptest.NewRecorder()
	f.sh.ListSignals(rr, signalReq(http.MethodGet, "", map[string]string{"Authorization": authz}))
	var out []signalEntry
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func (f *bridgeFixture) listBridges(t *testing.T, authz string) (int, []bridgeJSON) {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/v1/bridges", nil)
	r.Header.Set("Authorization", authz)
	rr := httptest.NewRecorder()
	f.bh.List(rr, r)
	var out struct {
		Bridges []bridgeJSON `json:"bridges"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out.Bridges
}

func (f *bridgeFixture) revoke(t *testing.T, authz, id string) int {
	t.Helper()
	r := httptest.NewRequest(http.MethodDelete, "/v1/bridges/"+id, nil)
	r.SetPathValue("id", id)
	r.Header.Set("Authorization", authz)
	rr := httptest.NewRecorder()
	f.bh.Revoke(rr, r)
	return rr.Code
}

func TestBridges_FullLifecycle(t *testing.T) {
	f := newBridgeFixture(t)
	tenant := seedEnforcedTenant(t, f.e, "pal-brg-"+uuid.NewString()[:8])
	user := bearerHeader(f.userTok(t, tenant))

	p := f.enrollAndPair(t, tenant, map[string]any{"name": "Studio Mac"})
	if p.TenantID != tenant || !strings.HasPrefix(p.Token, bridgeTokenPrefix) {
		t.Fatalf("pair response: %+v", p)
	}

	// Hashed at rest: the stored hash is sha256(token) and the plaintext token
	// appears in no column of the row.
	var hash, prefix string
	var rowText string
	if err := f.e.superPool.QueryRow(context.Background(),
		`SELECT token_hash, token_prefix, b::text FROM bridges b WHERE id = $1`, p.BridgeID).Scan(&hash, &prefix, &rowText); err != nil {
		t.Fatal(err)
	}
	if hash != sha256Hex(p.Token) {
		t.Error("token_hash is not sha256(token)")
	}
	if strings.Contains(rowText, p.Token) || strings.Contains(rowText, p.Token[len(prefix):]) {
		t.Error("SECURITY: plaintext token (or its secret suffix) stored in bridges row")
	}

	// Bridge writes + reads its tenant's signals.
	bridge := "Bearer " + p.Token
	if c := f.postSignal(t, bridge, `{"kind":"app_open","app":"Mail"}`); c != http.StatusOK {
		t.Fatalf("bridge POST signal: %d", c)
	}
	if c := f.postSignal(t, user, `{"kind":"location","detail":"Home"}`); c != http.StatusOK {
		t.Fatalf("user POST signal: %d", c)
	}
	code, got := f.listSignals(t, bridge)
	if code != http.StatusOK || len(got) != 2 || got[0].App != "Mail" || got[1].Detail != "Home" {
		t.Fatalf("bridge GET signals: %d %+v (want oldest-first Mail, Home)", code, got)
	}

	// Listed (prefix only, no secret).
	code, list := f.listBridges(t, user)
	if code != http.StatusOK || len(list) != 1 || list[0].ID != p.BridgeID || list[0].Name != "Studio Mac" {
		t.Fatalf("list bridges: %d %+v", code, list)
	}
	if list[0].LastSeenAt == "" {
		t.Error("lastSeenAt not stamped after authenticated use")
	}

	// Rotation: new token works, old one is dead immediately.
	r := httptest.NewRequest(http.MethodPost, "/v1/bridges/self/rotate", nil)
	r.Header.Set("Authorization", bridge)
	rr := httptest.NewRecorder()
	f.bh.RotateSelf(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", rr.Code, rr.Body.String())
	}
	var rot struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &rot)
	if c := f.postSignal(t, bridge, `{"kind":"wake","detail":"x"}`); c != http.StatusUnauthorized {
		t.Errorf("old token after rotation: %d, want 401", c)
	}
	newBridge := "Bearer " + rot.Token
	if c := f.postSignal(t, newBridge, `{"kind":"wake","detail":"x"}`); c != http.StatusOK {
		t.Errorf("rotated token: %d, want 200", c)
	}

	// Revocation: credential stops working at once; re-revoke is a no-op 200.
	if c := f.revoke(t, user, p.BridgeID); c != http.StatusOK {
		t.Fatalf("revoke: %d", c)
	}
	if c := f.postSignal(t, newBridge, `{"kind":"wake","detail":"x"}`); c != http.StatusUnauthorized {
		t.Errorf("revoked token POST: %d, want 401", c)
	}
	if c, _ := f.listSignals(t, newBridge); c != http.StatusUnauthorized {
		t.Errorf("revoked token GET: %d, want 401", c)
	}
	if c := f.revoke(t, user, p.BridgeID); c != http.StatusOK {
		t.Errorf("re-revoke: %d, want 200", c)
	}
	if _, l := f.listBridges(t, user); len(l) != 0 {
		t.Errorf("revoked bridge still in default list: %+v", l)
	}
}

func TestBridges_PairingCodeSingleUseAndExpiry(t *testing.T) {
	f := newBridgeFixture(t)
	tenant := seedEnforcedTenant(t, f.e, "pal-brg-c-"+uuid.NewString()[:8])

	_, code := f.enroll(t, tenant, nil)
	if rr, _ := f.pair(t, code); rr.Code != http.StatusCreated {
		t.Fatalf("first pair: %d", rr.Code)
	}
	if rr, _ := f.pair(t, code); rr.Code != http.StatusBadRequest {
		t.Errorf("SECURITY: pairing code reused: %d, want 400", rr.Code)
	}

	// Lower-case / no dash still redeems (normalization), but not when expired.
	_, code2 := f.enroll(t, tenant, nil)
	if _, err := f.e.superPool.Exec(context.Background(),
		`UPDATE bridge_pairing_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1`,
		sha256Hex(normalizePairingCode(code2))); err != nil {
		t.Fatal(err)
	}
	if rr, _ := f.pair(t, strings.ToLower(strings.ReplaceAll(code2, "-", ""))); rr.Code != http.StatusBadRequest {
		t.Errorf("expired code redeemed: %d, want 400", rr.Code)
	}
	if rr, _ := f.pair(t, "garbage"); rr.Code != http.StatusBadRequest {
		t.Errorf("malformed code: %d, want 400", rr.Code)
	}

	// Plaintext code never stored.
	var n int
	_ = f.e.superPool.QueryRow(context.Background(),
		`SELECT count(*) FROM bridge_pairing_codes WHERE code_hash = $1 OR code_hash = $2`, code, normalizePairingCode(code)).Scan(&n)
	if n != 0 {
		t.Error("SECURITY: plaintext pairing code stored")
	}
}

func TestBridges_ActiveCodeCap(t *testing.T) {
	f := newBridgeFixture(t)
	tenant := seedEnforcedTenant(t, f.e, "pal-brg-cap-"+uuid.NewString()[:8])
	for i := range maxActivePairingCodes {
		if rr, _ := f.enroll(t, tenant, nil); rr.Code != http.StatusCreated {
			t.Fatalf("enroll %d: %d", i, rr.Code)
		}
	}
	if rr, _ := f.enroll(t, tenant, nil); rr.Code != http.StatusTooManyRequests {
		t.Errorf("enroll past cap: %d, want 429", rr.Code)
	}
}

func TestBridges_CrossTenantIsolation(t *testing.T) {
	f := newBridgeFixture(t)
	a := seedEnforcedTenant(t, f.e, "pal-brg-a-"+uuid.NewString()[:8])
	b := seedEnforcedTenant(t, f.e, "pal-brg-b-"+uuid.NewString()[:8])
	pa := f.enrollAndPair(t, a, nil)
	userA, userB := bearerHeader(f.userTok(t, a)), bearerHeader(f.userTok(t, b))

	if c := f.postSignal(t, "Bearer "+pa.Token, `{"kind":"focus","detail":"Work"}`); c != http.StatusOK {
		t.Fatalf("seed signal: %d", c)
	}
	if _, got := f.listSignals(t, userB); len(got) != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B read %d of tenant A's signals", len(got))
	}
	if _, got := f.listSignals(t, userA); len(got) != 1 {
		t.Errorf("tenant A own signals: %d, want 1", len(got))
	}
	if _, l := f.listBridges(t, userB); len(l) != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B listed tenant A's bridges: %+v", l)
	}
	if c := f.revoke(t, userB, pa.BridgeID); c != http.StatusNotFound {
		t.Errorf("cross-tenant revoke: %d, want 404", c)
	}
	if c := f.revoke(t, userB, "not-a-uuid"); c != http.StatusNotFound {
		t.Errorf("malformed id revoke: %d, want 404", c)
	}
	// A's bridge still works after B's attempt.
	if c := f.postSignal(t, "Bearer "+pa.Token, `{"kind":"wake","detail":"x"}`); c != http.StatusOK {
		t.Errorf("A's bridge after cross-tenant revoke attempt: %d, want 200", c)
	}
	// Under genuine RLS the app role sees none of A's rows with B's GUC.
	var n int
	if err := f.e.srv.WithTenant(injectTenant(context.Background(), b), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT count(*) FROM device_signals`).Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("SECURITY VIOLATION: RLS admitted %d device_signals rows across tenants", n)
	}
}

func TestBridges_ScopeChecks(t *testing.T) {
	f := newBridgeFixture(t)
	tenant := seedEnforcedTenant(t, f.e, "pal-brg-s-"+uuid.NewString()[:8])

	// ios-shortcuts devices write signals but cannot read them back.
	sc := f.enrollAndPair(t, tenant, map[string]any{"platform": "ios-shortcuts"})
	if c := f.postSignal(t, "Bearer "+sc.Token, `{"kind":"app_open","app":"Maps"}`); c != http.StatusOK {
		t.Errorf("shortcuts write: %d, want 200", c)
	}
	if c, _ := f.listSignals(t, "Bearer "+sc.Token); c != http.StatusForbidden {
		t.Errorf("shortcuts read: %d, want 403", c)
	}

	// A platform's scope ceiling cannot be exceeded at enroll time.
	if rr, _ := f.enroll(t, tenant, map[string]any{"platform": "ios-shortcuts", "scopes": []string{"bridge:signals:read"}}); rr.Code != http.StatusBadRequest {
		t.Errorf("scope escalation at enroll: %d, want 400", rr.Code)
	}
	if rr, _ := f.enroll(t, tenant, map[string]any{"platform": "windows"}); rr.Code != http.StatusBadRequest {
		t.Errorf("unknown platform: %d, want 400", rr.Code)
	}

	// A bridge credential can never manage bridges or reach JWT routes.
	mac := f.enrollAndPair(t, tenant, nil)
	r := httptest.NewRequest(http.MethodPost, "/v1/bridges/enroll", nil)
	r.Header.Set("Authorization", "Bearer "+mac.Token)
	rr := httptest.NewRecorder()
	f.bh.Enroll(rr, r)
	if rr.Code != http.StatusForbidden {
		t.Errorf("bridge token enroll: %d, want 403", rr.Code)
	}
	if c, _ := f.listBridges(t, "Bearer "+mac.Token); c != http.StatusForbidden {
		t.Errorf("bridge token list: %d, want 403", c)
	}
	if c := f.revoke(t, "Bearer "+mac.Token, sc.BridgeID); c != http.StatusForbidden {
		t.Errorf("bridge token revoke: %d, want 403", c)
	}
	if _, err := f.bh.auth.validateRequest(func() *http.Request {
		q := httptest.NewRequest(http.MethodGet, "/v1/agents", nil)
		q.Header.Set("Authorization", "Bearer "+mac.Token)
		return q
	}()); err == nil {
		t.Error("SECURITY: bridge token accepted by the generic validateRequest")
	}

	// A read-only API key cannot enroll a device.
	if _, err := f.e.superPool.Exec(context.Background(), `
		INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes)
		VALUES ($1, 'ro', $2, 'hlx_live_ro', '{read}')`, tenant, sha256Hex("hlx_live_readonlykey")); err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequest(http.MethodPost, "/v1/bridges/enroll", nil)
	r.Header.Set("Authorization", "Bearer hlx_live_readonlykey")
	rr = httptest.NewRecorder()
	f.bh.Enroll(rr, r)
	if rr.Code != http.StatusForbidden {
		t.Errorf("read-only API key enroll: %d, want 403", rr.Code)
	}
}

// The legacy shared-token path keeps writing the file the live bridge reads
// (byte-identical contract) and mirrors into the legacy tenant's store.
func TestSignals_LegacyPathWritesFileAndMirrors(t *testing.T) {
	f := newBridgeFixture(t)
	tenant := seedEnforcedTenant(t, f.e, "pal-legacy-"+uuid.NewString()[:8])
	home := isolateHome(t)
	t.Setenv("PAL_SIGNAL_TOKEN", "legacy-secret")
	t.Setenv("PAL_SIGNALS_LEGACY_OWNER_TENANT", tenant)

	rr := httptest.NewRecorder()
	f.sh.IngestSignal(rr, signalReq(http.MethodPost, `{"kind":"app_open","app":"YouTube","ts":1700000000000}`,
		map[string]string{"x-lantern-signal-token": "legacy-secret"}))
	if rr.Code != http.StatusOK || strings.TrimSpace(rr.Body.String()) != `{"ok":true}` {
		t.Fatalf("legacy POST: %d %s", rr.Code, rr.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(home, ".lantern", "device-signals.jsonl"))
	if err != nil {
		t.Fatalf("legacy file not written: %v", err)
	}
	if got := strings.TrimSpace(string(data)); got != `{"app":"YouTube","kind":"app_open","ts":1700000000000}` {
		t.Errorf("legacy file line changed: %s", got)
	}
	_, got := f.listSignals(t, bearerHeader(f.userTok(t, tenant)))
	if len(got) != 1 || got[0].App != "YouTube" {
		t.Errorf("legacy signal not mirrored into tenant store: %+v", got)
	}
	var src string
	_ = f.e.superPool.QueryRow(context.Background(), `SELECT source FROM device_signals WHERE tenant_id = $1`, tenant).Scan(&src)
	if src != "legacy" {
		t.Errorf("mirrored row source = %q, want legacy", src)
	}

	// Legacy GET still reads the file (unchanged contract).
	rr = httptest.NewRecorder()
	f.sh.ListSignals(rr, signalReq(http.MethodGet, "", map[string]string{"x-lantern-signal-token": "legacy-secret"}))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "YouTube") {
		t.Errorf("legacy GET: %d %s", rr.Code, rr.Body.String())
	}
}

// Retention: a tenant write prunes that tenant's rows past the window, and
// only that tenant's.
func TestSignals_RetentionPrunesOwnTenantOnly(t *testing.T) {
	f := newBridgeFixture(t)
	a := seedEnforcedTenant(t, f.e, "pal-ret-a-"+uuid.NewString()[:8])
	b := seedEnforcedTenant(t, f.e, "pal-ret-b-"+uuid.NewString()[:8])
	for _, tid := range []string{a, b} {
		if _, err := f.e.superPool.Exec(context.Background(), `
			INSERT INTO device_signals (tenant_id, source, kind, detail, ts, created_at)
			VALUES ($1, 'user', 'wake', 'old', 1, now() - interval '400 days')`, tid); err != nil {
			t.Fatal(err)
		}
	}
	if c := f.postSignal(t, bearerHeader(f.userTok(t, a)), `{"kind":"wake","detail":"new"}`); c != http.StatusOK {
		t.Fatalf("post: %d", c)
	}
	var na, nb int
	_ = f.e.superPool.QueryRow(context.Background(), `SELECT count(*) FROM device_signals WHERE tenant_id=$1 AND detail='old'`, a).Scan(&na)
	_ = f.e.superPool.QueryRow(context.Background(), `SELECT count(*) FROM device_signals WHERE tenant_id=$1 AND detail='old'`, b).Scan(&nb)
	if na != 0 || nb != 1 {
		t.Errorf("retention: tenant A old rows=%d (want 0), tenant B old rows=%d (want 1)", na, nb)
	}
}
