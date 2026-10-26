package handlers

// Sandbox lifecycle REST surface (Wave 2): pause / resume / fork a microVM.
//
//	POST /v1/runtime/vms/{id}/pause   → {"vmId","snapshotId","state":"paused"}
//	POST /v1/runtime/vms/{id}/resume  → {"vmId","snapshotId","state":"running"}
//	POST /v1/runtime/vms/{id}/fork    → {"sourceVmId","snapshotId","forks":[...]}
//
// The scheduler owns the state machine and its quota slot accounting; this
// layer authenticates, gates ownership on runtime_vms (tenant from the JWT
// only — a foreign vm_id is 404), applies the runtime_quotas policy (402) for
// anything that adds live VMs, mirrors the outcome into runtime_vms, and
// audits. Scheduler gRPC codes map to HTTP: NotFound→404,
// FailedPrecondition→409, ResourceExhausted→402, InvalidArgument→400.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

// maxForkCountDefault and maxForkCountCeiling mirror the scheduler's defaults.
// LANTERN_MAX_FORK_COUNT (default 100, ceiling 1000).
const (
	maxForkCountDefault = 100
	maxForkCountCeiling = 1000
)

// maxForkCount returns the configured per-call fork limit for this process.
func maxForkCount() int {
	s := os.Getenv("LANTERN_MAX_FORK_COUNT")
	if s == "" {
		return maxForkCountDefault
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return maxForkCountDefault
	}
	if n > maxForkCountCeiling {
		return maxForkCountCeiling
	}
	return n
}

// ForkChildResult is one child of a Fork call.
type ForkChildResult struct {
	VMID  string `json:"vmId"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
	// AgentInstanceID is the child's own freshly minted identity.
	AgentInstanceID string `json:"-"`
}

// ForkIdentity is a freshly minted agent identity for one fork child. Token is
// a live bearer credential — never logged or persisted.
type ForkIdentity struct {
	InstanceID string
	Token      string
}

// ForkResult is the scheduler's answer to a Fork call.
type ForkResult struct {
	SnapshotID string
	Forks      []ForkChildResult
}

// ---------- stub scheduler (dashboard-only dev) ----------

func (s *stubSchedulerClient) Pause(_ context.Context, _, vmID string) (string, error) {
	snap, _ := s.paused.LoadOrStore(vmID, "snap-stub-"+newID())
	s.logger.Info("stub scheduler: pause", zap.String("vm_id", vmID))
	return snap.(string), nil
}

func (s *stubSchedulerClient) Resume(_ context.Context, _, vmID string) (string, error) {
	snap, ok := s.paused.LoadAndDelete(vmID)
	if !ok {
		return "", status.Errorf(grpccodes.FailedPrecondition, "vm %q is not paused", vmID)
	}
	s.logger.Info("stub scheduler: resume", zap.String("vm_id", vmID))
	return snap.(string), nil
}

func (s *stubSchedulerClient) Fork(_ context.Context, _, vmID string, identities []ForkIdentity) (ForkResult, error) {
	count := len(identities)
	snap, ok := s.paused.Load(vmID)
	if !ok {
		snap = "snap-stub-" + newID()
	}
	res := ForkResult{SnapshotID: snap.(string)}
	for i := 0; i < count; i++ {
		res.Forks = append(res.Forks, ForkChildResult{VMID: "vm-" + newID(), State: "running", AgentInstanceID: identities[i].InstanceID})
	}
	s.logger.Info("stub scheduler: fork", zap.String("vm_id", vmID), zap.Int("count", count))
	return res, nil
}

// ---------- real gRPC scheduler ----------

func (c *grpcSchedulerClient) Pause(ctx context.Context, tenantID, vmID string) (string, error) {
	resp, err := c.client.Pause(withTenant(ctx, tenantID), &lanternv1.PauseRequest{VmId: vmID})
	if err != nil {
		return "", err
	}
	return resp.GetSnapshotId(), nil
}

func (c *grpcSchedulerClient) Resume(ctx context.Context, tenantID, vmID string) (string, error) {
	resp, err := c.client.Resume(withTenant(ctx, tenantID), &lanternv1.ResumeRequest{VmId: vmID})
	if err != nil {
		return "", err
	}
	return resp.GetSnapshotId(), nil
}

func (c *grpcSchedulerClient) Fork(ctx context.Context, tenantID, vmID string, identities []ForkIdentity) (ForkResult, error) {
	req := &lanternv1.ForkRequest{VmId: vmID, Count: int32(len(identities))}
	for _, id := range identities {
		req.Identities = append(req.Identities, &lanternv1.ForkIdentity{AgentInstanceId: id.InstanceID, AgentInstanceToken: id.Token})
	}
	resp, err := c.client.Fork(withTenant(ctx, tenantID), req)
	if err != nil {
		return ForkResult{}, err
	}
	res := ForkResult{SnapshotID: resp.GetSnapshotId()}
	for _, f := range resp.GetForks() {
		res.Forks = append(res.Forks, ForkChildResult{
			VMID: f.GetVmId(), State: vmStateString(f.GetState()), Error: f.GetError(), AgentInstanceID: f.GetAgentInstanceId(),
		})
	}
	return res, nil
}

// ---------- HTTP handlers ----------

// lifecycleTarget authenticates, enforces the runtime write scope, and
// confirms the caller's tenant owns the VM. ok=false means a response was
// already written.
func (h *RuntimeHandler) lifecycleTarget(w http.ResponseWriter, r *http.Request) (claims *LanternClaims, ctx context.Context, vmID string, ok bool) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, nil, "", false
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeWrite) {
		return nil, nil, "", false
	}
	vmID = r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return nil, nil, "", false
	}
	ctx = middleware.InjectTenantID(r.Context(), claims.TenantID)
	var state string
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`, vmID, claims.TenantID).Scan(&state)
	}); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return nil, nil, "", false
	}
	if state == "terminated" || state == "failed" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "conflict", "reason": "vm is " + state})
		return nil, nil, "", false
	}
	return claims, ctx, vmID, true
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// writeLifecycleErr maps a scheduler error onto an HTTP response.
func (h *RuntimeHandler) writeLifecycleErr(w http.ResponseWriter, op, vmID string, err error) {
	msg := status.Convert(err).Message()
	switch status.Code(err) {
	case grpccodes.NotFound, grpccodes.PermissionDenied:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
	case grpccodes.FailedPrecondition:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "conflict", "reason": msg})
	case grpccodes.ResourceExhausted:
		writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": "quota exceeded", "reason": msg})
	case grpccodes.InvalidArgument:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
	default:
		h.logger().Error("scheduler."+op+" failed", zap.String("vm_id", vmID), zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "scheduler error"})
	}
}

// quotaGate applies the runtime_quotas policy for adding n live VMs. Returns
// false (402 written) when a hard-fail quota denies it.
func (h *RuntimeHandler) quotaGate(ctx context.Context, w http.ResponseWriter, claims *LanternClaims, vmID, action string, n int) bool {
	q := h.checkRuntimeQuotaN(ctx, claims.TenantID, n)
	if q.Allowed {
		return true
	}
	h.auditRuntime(ctx, claims.TenantID, vmID, action+"_denied", map[string]any{"reason": q.Reason}, claims.Subject, "")
	if q.HardFail {
		writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": "quota exceeded", "reason": q.Reason})
		return false
	}
	h.logger().Warn("quota exceeded but hard_fail=false", zap.String("tenant_id", claims.TenantID), zap.String("reason", q.Reason))
	return true
}

// setVMState mirrors a lifecycle outcome into the runtime_vms shadow row.
func (h *RuntimeHandler) setVMState(ctx context.Context, tenantID, vmID, state, snapshotID string) {
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE runtime_vms SET state = $3, snapshot_id = COALESCE(NULLIF($4, ''), snapshot_id)
			WHERE vm_id = $1 AND tenant_id = $2
		`, vmID, tenantID, state, snapshotID)
		return e
	}); err != nil {
		// The scheduler is authoritative and the reconciler converges the row.
		h.logger().Error("runtime_vms lifecycle update failed", zap.String("vm_id", vmID), zap.String("state", state), zap.Error(err))
	}
}

// ensureVMRunning transparently resumes a PAUSED VM that has idle_timeout_secs > 0
// (i.e. was auto-suspended) before the caller proceeds with an exec or file-API
// operation.
//
//   - RUNNING → return true immediately (no-op).
//   - PAUSED + idle_timeout_secs > 0 → Resume; update runtime_vms; return true.
//   - PAUSED + idle_timeout_secs == 0 → 409; the VM was manually paused (not
//     auto-suspended); the caller must explicitly resume. Return false.
//   - Resume returns FailedPrecondition → another concurrent request already
//     resumed it; treat as RUNNING, return true.
//   - Resume returns ResourceExhausted → 402 (tenant quota), return false.
//   - Any other scheduler error → 502, return false.
//
// ctx must already carry the tenant_id.
func (h *RuntimeHandler) ensureVMRunning(w http.ResponseWriter, ctx context.Context, tenantID, vmID string) bool {
	var state string
	var idleTimeoutSecs int32
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT state, idle_timeout_secs FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`,
			vmID, tenantID,
		).Scan(&state, &idleTimeoutSecs)
	}); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return false
	}

	// The shadow row only becomes "paused" through PauseVM (an operator /
	// API pause) — the scheduler's idle sweeper pauses WITHOUT touching it.
	// So "paused" here means manual: never auto-resume, whatever the timeout.
	if state == "paused" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":  "conflict",
			"reason": "vm is paused; resume it first",
		})
		return false
	}
	if idleTimeoutSecs <= 0 {
		return true // never auto-suspended — let the operation proceed
	}

	// Idle-suspend eligible: the scheduler (authoritative) may have
	// auto-paused it while the shadow still says running. Ask it to resume;
	// FailedPrecondition means it is already running.
	// ponytail: one extra RPC per call for idle-enabled VMs; a scheduler
	// GetVM / state push to the shadow avoids it if it shows up in latency.
	snap, err := h.scheduler.Resume(ctx, tenantID, vmID)
	if err != nil {
		switch status.Code(err) {
		case grpccodes.FailedPrecondition:
			// Already running (never suspended, or a concurrent request's
			// resume won the scheduler CAS).
			return true
		case grpccodes.ResourceExhausted:
			writeJSON(w, http.StatusPaymentRequired, map[string]string{
				"error":  "quota exceeded",
				"reason": status.Convert(err).Message(),
			})
		default:
			h.logger().Error("auto-resume failed", zap.String("vm_id", vmID), zap.Error(err))
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "auto-resume failed"})
		}
		return false
	}
	h.setVMState(ctx, tenantID, vmID, "running", snap)
	h.auditRuntime(ctx, tenantID, vmID, "auto_resume", map[string]any{"snapshot_id": snap}, "", "")
	return true
}

// PauseVM handles POST /v1/runtime/vms/{id}/pause.
func (h *RuntimeHandler) PauseVM(w http.ResponseWriter, r *http.Request) {
	claims, ctx, vmID, ok := h.lifecycleTarget(w, r)
	if !ok {
		return
	}
	snap, err := h.scheduler.Pause(ctx, claims.TenantID, vmID)
	if err != nil {
		h.writeLifecycleErr(w, "Pause", vmID, err)
		return
	}
	h.setVMState(ctx, claims.TenantID, vmID, "paused", snap)
	h.auditRuntime(ctx, claims.TenantID, vmID, "pause", map[string]any{"snapshot_id": snap}, claims.Subject, "")
	writeJSON(w, http.StatusOK, map[string]any{"vmId": vmID, "snapshotId": snap, "state": "paused"})
}

// ResumeVM handles POST /v1/runtime/vms/{id}/resume.
func (h *RuntimeHandler) ResumeVM(w http.ResponseWriter, r *http.Request) {
	claims, ctx, vmID, ok := h.lifecycleTarget(w, r)
	if !ok {
		return
	}
	if !h.quotaGate(ctx, w, claims, vmID, "resume", 1) {
		return
	}
	snap, err := h.scheduler.Resume(ctx, claims.TenantID, vmID)
	if err != nil {
		h.writeLifecycleErr(w, "Resume", vmID, err)
		return
	}
	h.setVMState(ctx, claims.TenantID, vmID, "running", snap)
	h.auditRuntime(ctx, claims.TenantID, vmID, "resume", map[string]any{"snapshot_id": snap}, claims.Subject, "")
	writeJSON(w, http.StatusOK, map[string]any{"vmId": vmID, "snapshotId": snap, "state": "running"})
}

// ForkVM handles POST /v1/runtime/vms/{id}/fork with body {"count":N}
// (default 1, 1..LANTERN_MAX_FORK_COUNT).
func (h *RuntimeHandler) ForkVM(w http.ResponseWriter, r *http.Request) {
	// Validate count before the DB lookup — auth is still required but the
	// range check is pure and cheap.
	body := struct {
		Count *int `json:"count"`
	}{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	count := 1
	if body.Count != nil {
		count = *body.Count
	}
	max := maxForkCount()
	if count < 1 || count > max {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("count must be between 1 and %d", max)})
		return
	}

	claims, ctx, vmID, ok := h.lifecycleTarget(w, r)
	if !ok {
		return
	}
	if !h.quotaGate(ctx, w, claims, vmID, "fork", count) {
		return
	}
	// Every child gets its OWN agent identity, minted exactly like
	// scheduleAgentSpec does — never the source's (N sandboxes sharing one
	// identity would be indistinguishable to secret vending and audit).
	var runID, agentVersionID *string
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT run_id::text, agent_version_id::text FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`,
			vmID, claims.TenantID).Scan(&runID, &agentVersionID)
	}); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return
	}
	identities := make([]ForkIdentity, 0, count)
	for i := 0; i < count; i++ {
		id, tok, err := h.identity.Issue(ctx, claims.TenantID, derefStr(runID), derefStr(agentVersionID))
		if err != nil {
			h.logger().Error("fork: mint agent identity failed", zap.String("vm_id", vmID), zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not mint agent identity"})
			return
		}
		identities = append(identities, ForkIdentity{InstanceID: id, Token: tok})
	}

	res, err := h.scheduler.Fork(ctx, claims.TenantID, vmID, identities)
	if err != nil {
		h.writeLifecycleErr(w, "Fork", vmID, err)
		return
	}

	ids := make([]string, 0, len(res.Forks))
	instanceIDs := make([]string, 0, len(res.Forks))
	for _, f := range res.Forks {
		ids = append(ids, f.VMID)
		instanceIDs = append(instanceIDs, f.AgentInstanceID)
	}
	// Every live child must be tracked: all rows go in ONE transaction, and if
	// it fails the children the scheduler already spawned are terminated rather
	// than left running with no runtime_vms row (invisible to GET/DELETE, quota
	// and secret binding).
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		for _, f := range res.Forks {
			// The child inherits the source's placement, isolation, (redacted)
			// spec and idle timeout (the scheduler copies the spec, so a fork can
			// be auto-suspended and must be auto-resumable); it is linked back via
			// parent_vm_id + snapshot_id.
			if _, e := tx.Exec(ctx, `
				INSERT INTO runtime_vms
				  (vm_id, tenant_id, agent_version_id, run_id, node, az, region, isolation_class,
				   state, state_reason, spec, agent_instance_id, confidential, parent_vm_id, snapshot_id,
				   idle_timeout_secs, created_at)
				SELECT $1, tenant_id, agent_version_id, run_id, node, az, region, isolation_class,
				       $2, NULLIF($3, ''),
				       jsonb_set(spec, '{env,LANTERN_AGENT_INSTANCE_ID}', to_jsonb($7::text)),
				       NULLIF($7, ''), confidential, vm_id, $4,
				       idle_timeout_secs, now()
				FROM runtime_vms WHERE vm_id = $5 AND tenant_id = $6
				ON CONFLICT (vm_id) DO NOTHING
			`, f.VMID, f.State, f.Error, res.SnapshotID, vmID, claims.TenantID, f.AgentInstanceID); e != nil {
				return fmt.Errorf("insert fork child %s: %w", f.VMID, e)
			}
		}
		return nil
	}); err != nil {
		h.logger().Error("runtime_vms fork insert failed; terminating untracked children",
			zap.String("vm_id", vmID), zap.Strings("fork_vm_ids", ids), zap.Error(err))
		for _, id := range ids {
			if id == "" {
				continue
			}
			if tErr := h.scheduler.Terminate(ctx, id, "fork_untracked"); tErr != nil {
				h.logger().Error("fork compensation: terminate child failed",
					zap.String("vm_id", id), zap.Error(tErr))
			}
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "fork failed: could not record child VMs"})
		return
	}
	h.auditRuntime(ctx, claims.TenantID, vmID, "fork", map[string]any{
		"snapshot_id": res.SnapshotID, "count": count, "fork_vm_ids": ids, "agent_instance_ids": instanceIDs,
	}, claims.Subject, "")

	forks := res.Forks
	if forks == nil {
		forks = []ForkChildResult{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sourceVmId": vmID, "snapshotId": res.SnapshotID, "forks": forks})
}
