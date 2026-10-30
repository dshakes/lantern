package region

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		name, region, epoch, ro string
		want                    Config
		wantErr                 bool
	}{
		{name: "all unset is single-region", want: Config{}},
		{name: "full", region: "us-east-1", epoch: "3", ro: "on", want: Config{Region: "us-east-1", FenceEpoch: 3, ReadOnly: true}},
		{name: "ro off spelled 0", ro: "0", want: Config{}},
		{name: "ro TRUE", ro: "TRUE", want: Config{ReadOnly: true}},
		{name: "uppercase region", region: "US-EAST", wantErr: true},
		{name: "region with GUC injection", region: "a' ; drop", wantErr: true},
		{name: "region too long", region: "a234567890123456789012345678901234567890123456789012345678901234", wantErr: true},
		{name: "zero epoch", epoch: "0", wantErr: true},
		{name: "negative epoch", epoch: "-1", wantErr: true},
		{name: "garbage epoch", epoch: "1x", wantErr: true},
		{name: "garbage read-only", ro: "yes please", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parse(tc.region, tc.epoch, tc.ro)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestApplyPgSession(t *testing.T) {
	cc, err := pgx.ParseConfig("postgres://u@localhost/db")
	if err != nil {
		t.Fatal(err)
	}
	before := len(cc.RuntimeParams)
	Config{}.ApplyPgSession(cc)
	if len(cc.RuntimeParams) != before {
		t.Fatalf("single-region config must not add startup params: %v", cc.RuntimeParams)
	}
	Config{Region: "eu-west-1", FenceEpoch: 42}.ApplyPgSession(cc)
	if cc.RuntimeParams["pal.region"] != "eu-west-1" || cc.RuntimeParams["pal.fence_epoch"] != "42" {
		t.Fatalf("runtime params = %v", cc.RuntimeParams)
	}
}

func TestResourceAttrs(t *testing.T) {
	if a := (Config{}).ResourceAttrs(); len(a) != 0 {
		t.Fatalf("unset region must add no attrs, got %v", a)
	}
	a := Config{Region: "us-west-2"}.ResourceAttrs()
	if len(a) != 2 || a[0].Value.AsString() != "us-west-2" || string(a[0].Key) != "cloud.region" {
		t.Fatalf("attrs = %v", a)
	}
}

func TestReadOnlyHTTP(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	serve := func(c Config, method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		c.ReadOnlyHTTP(ok).ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec
	}
	// Off: everything passes, including mutations.
	if rec := serve(Config{}, http.MethodDelete, "/v1/agents/x"); rec.Code != http.StatusTeapot {
		t.Fatalf("read-only off must not intercept, got %d", rec.Code)
	}
	ro := Config{ReadOnly: true}
	for _, tc := range []struct {
		method, path string
		pass         bool
	}{
		{http.MethodGet, "/v1/runs", true},
		{http.MethodHead, "/healthz", true},
		{http.MethodOptions, "/v1/runs", true},
		{http.MethodPost, "/auth/login", true},
		{http.MethodPost, "/v1/runs/receipts/verify", true},
		{http.MethodPost, "/internal/auth/introspect-key", true},
		{http.MethodPost, "/v1/runs", false},
		{http.MethodPost, "/auth/signup", false},
		{http.MethodPut, "/v1/agents/x/budget", false},
		{http.MethodPatch, "/v1/agents/x", false},
		{http.MethodDelete, "/v1/agents/x", false},
		{http.MethodPost, "/auth/login/../../v1/runs", false}, // allowlist is exact-path
	} {
		rec := serve(ro, tc.method, tc.path)
		if tc.pass && rec.Code != http.StatusTeapot {
			t.Errorf("%s %s: want pass-through, got %d", tc.method, tc.path, rec.Code)
		}
		if !tc.pass {
			if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
				t.Errorf("%s %s: want 503 + Retry-After, got %d %q", tc.method, tc.path, rec.Code, rec.Header().Get("Retry-After"))
			}
		}
	}
}

func TestReadOnlyGRPC(t *testing.T) {
	handler := func(context.Context, any) (any, error) { return "ok", nil }
	call := func(c Config, method string) error {
		_, err := c.UnaryReadOnly()(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: method}, handler)
		return err
	}
	stream := func(c Config, method string) error {
		return c.StreamReadOnly()(nil, nil, &grpc.StreamServerInfo{FullMethod: method}, func(any, grpc.ServerStream) error { return nil })
	}
	if err := call(Config{}, "/pal.v1.RunService/CreateRun"); err != nil {
		t.Fatalf("off must pass mutations: %v", err)
	}
	ro := Config{ReadOnly: true}
	for _, m := range []string{"/pal.v1.RunService/GetRun", "/pal.v1.AgentService/ListAgents", "/grpc.health.v1.Health/Check"} {
		if err := call(ro, m); err != nil {
			t.Errorf("%s should pass on standby: %v", m, err)
		}
	}
	if err := stream(ro, "/pal.v1.RunService/StreamRunEvents"); err != nil {
		t.Errorf("StreamRunEvents should pass on standby: %v", err)
	}
	for _, m := range []string{"/pal.v1.RunService/CreateRun", "/pal.v1.RunService/CancelRun", "/pal.v1.DataPlaneService/Register", "/pal.v1.AgentService/PromoteAgentVersion"} {
		if status.Code(call(ro, m)) != codes.Unavailable {
			t.Errorf("%s should be UNAVAILABLE on standby", m)
		}
	}
	if status.Code(stream(ro, "/pal.v1.DataPlaneService/RunStream")) != codes.Unavailable {
		t.Errorf("RunStream should be UNAVAILABLE on standby")
	}
}
