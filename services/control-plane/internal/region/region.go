// Package region holds the control-plane's multi-region identity and the
// standby read-only switch (ADR 0046).
//
// Everything here is OFF by default: with PAL_REGION, PAL_FENCE_EPOCH and
// PAL_READ_ONLY unset, Load returns the zero Config and every helper is a
// no-op, so a single-region deployment behaves exactly as before.
//
//   - PAL_REGION       region identity ("us-east-1"). Stamped on runs,
//     run_locks and journal_events (via the `pal.region` session GUC the
//     migration's column DEFAULT reads) and on the OTel resource.
//   - PAL_FENCE_EPOCH  this deployment's fencing epoch. Sent as the
//     `pal.fence_epoch` session GUC; once the fence is armed in the DB, writes
//     to the run-execution tables from any other epoch are rejected.
//   - PAL_READ_ONLY    standby mode: HTTP mutations get 503 + Retry-After,
//     mutating gRPC methods get UNAVAILABLE, migrations and background
//     writers do not start.
//
// The env vars are PAL_* names; palenv.Bridge() (called first in main) makes
// the PAL_* spellings visible under these names too (ADR 0032).
package region

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Config is the process's region identity. The zero value is single-region.
type Config struct {
	Region     string // "" = unset
	FenceEpoch int64  // 0 = unset
	ReadOnly   bool
}

var regionRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Load reads the config from the environment. A malformed value is an error
// (the caller fails startup): a typo in a fencing epoch must not silently run
// the process unfenced.
func Load() (Config, error) {
	return parse(os.Getenv("PAL_REGION"), os.Getenv("PAL_FENCE_EPOCH"), os.Getenv("PAL_READ_ONLY"))
}

func parse(regionName, epoch, readOnly string) (Config, error) {
	var c Config
	if regionName != "" {
		if !regionRE.MatchString(regionName) {
			return Config{}, fmt.Errorf("PAL_REGION %q: want lowercase [a-z0-9-], 1-63 chars", regionName)
		}
		c.Region = regionName
	}
	if epoch != "" {
		n, err := strconv.ParseInt(epoch, 10, 64)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("PAL_FENCE_EPOCH %q: want a positive integer", epoch)
		}
		c.FenceEpoch = n
	}
	switch strings.ToLower(readOnly) {
	case "", "0", "false", "off":
	case "1", "true", "on":
		c.ReadOnly = true
	default:
		return Config{}, fmt.Errorf("PAL_READ_ONLY %q: want 1/true/on or 0/false/off", readOnly)
	}
	return c, nil
}

// ApplyPgSession sets the region/epoch session GUCs on every connection the
// pool opens. Unset values add nothing, so the startup packet is unchanged
// for single-region deployments. (A pooler in transaction mode must pass
// these through — see the runbook.)
func (c Config) ApplyPgSession(cc *pgx.ConnConfig) {
	if c.Region != "" {
		cc.RuntimeParams["pal.region"] = c.Region
	}
	if c.FenceEpoch > 0 {
		cc.RuntimeParams["pal.fence_epoch"] = strconv.FormatInt(c.FenceEpoch, 10)
	}
}

// ResourceAttrs are the OTel resource attributes for this region (none when unset).
func (c Config) ResourceAttrs() []attribute.KeyValue {
	if c.Region == "" {
		return nil
	}
	return []attribute.KeyValue{
		attribute.String("cloud.region", c.Region),
		attribute.String("pal.region", c.Region),
	}
}

// retryAfterSeconds is what a standby tells clients; failover RTO target is
// minutes (ADR 0046), so a client retry storm every second helps nobody.
const retryAfterSeconds = "30"

// readOnlyAllowedPOST are non-GET routes that only read (or only write
// best-effort) and so must keep working on a standby: logging in, verifying a
// receipt, and the gateway's API-key introspection.
var readOnlyAllowedPOST = map[string]bool{
	"/auth/login":                   true,
	"/v1/runs/receipts/verify":      true,
	"/internal/auth/introspect-key": true,
}

// ReadOnlyHTTP wraps next so that, in read-only mode, every request that could
// mutate state is refused with 503 + Retry-After. Allowlist, not denylist: a
// new mutating route is refused on a standby until someone decides otherwise.
func (c Config) ReadOnlyHTTP(next http.Handler) http.Handler {
	if !c.ReadOnly {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodPost && readOnlyAllowedPOST[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Retry-After", retryAfterSeconds)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"this region is a read-only standby","code":"region_read_only"}`))
	})
}

// readOnlyAllowedGRPC are the gRPC methods that do not mutate state. Anything
// else — including every DataPlaneService method, since Register/Heartbeat
// write — is UNAVAILABLE on a standby, which makes a data-plane agent move on
// to its next control-plane endpoint.
var readOnlyAllowedGRPC = map[string]bool{
	"/pal.v1.AgentService/GetAgent":          true,
	"/pal.v1.AgentService/ListAgents":        true,
	"/pal.v1.AgentService/GetAgentVersion":   true,
	"/pal.v1.AgentService/ListAgentVersions": true,
	"/pal.v1.RunService/GetRun":              true,
	"/pal.v1.RunService/ListRuns":            true,
	"/pal.v1.RunService/StreamRunEvents":     true,
	"/pal.v1.RunService/QueryRun":            true,
}

func (c Config) grpcAllowed(method string) bool {
	return !c.ReadOnly ||
		readOnlyAllowedGRPC[method] ||
		strings.HasPrefix(method, "/grpc.health.v1.Health/") ||
		strings.HasPrefix(method, "/grpc.reflection.")
}

var errReadOnly = status.Error(codes.Unavailable, "this region is a read-only standby")

// UnaryReadOnly refuses mutating unary RPCs in read-only mode.
func (c Config) UnaryReadOnly() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
		if !c.grpcAllowed(info.FullMethod) {
			return nil, errReadOnly
		}
		return h(ctx, req)
	}
}

// StreamReadOnly refuses mutating streaming RPCs in read-only mode.
func (c Config) StreamReadOnly() grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, h grpc.StreamHandler) error {
		if !c.grpcAllowed(info.FullMethod) {
			return errReadOnly
		}
		return h(srv, ss)
	}
}
