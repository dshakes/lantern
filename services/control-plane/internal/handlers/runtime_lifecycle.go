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
	"io"
	"net/http"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

// maxForkCount mirrors the scheduler's per-call fork ceiling.
const maxForkCount = 10

// ForkChildResult is one child of a Fork call.
type ForkChildResult struct {
	VMID  string `json:"vmId"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
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

func (s *stubSchedulerClient) Fork(_ context.Context, _, vmID string, count int) (ForkResult, error) {
	snap, ok := s.paused.Load(vmID)
	if !ok {
		snap = "snap-stub-" + newID()
	}
	res := ForkResult{SnapshotID: snap.(string)}
	for i := 0; i < count; i++ {
		res.Forks = append(res.Forks, ForkChildResult{VMID: "vm-" + newID(), State: "running"})
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

func (c *grpcSchedulerClient) Fork(ctx context.Context, tenantID, vmID string, count int) (ForkResult, error) {
	resp, err := c.client.Fork(withTenant(ctx, tenantID), &lanternv1.ForkRequest{VmId: vmID, Count: int32(count)})
	if err != nil {
		return ForkResult{}, err
	}
	res := ForkResult{SnapshotID: resp.GetSnapshotId()}
	for _, f := range resp.GetForks() {
		res.Forks = append(res.Forks, ForkChildResult{VMID: f.GetVmId(), State: vmStateString(f.GetState()), Error: f.GetError()})
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
// (default 1, 1..10).
func (h *RuntimeHandler) ForkVM(w http.ResponseWriter, r *http.Request) {
	claims, ctx, vmID, ok := h.lifecycleTarget(w, r)
	if !ok {
		return
	}
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
	if count < 1 || count > maxForkCount {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "count must be between 1 and 10"})
		return
	}
	if !h.quotaGate(ctx, w, claims, vmID, "fork", count) {
		return
	}
	res, err := h.scheduler.Fork(ctx, claims.TenantID, vmID, count)
	if err != nil {
		h.writeLifecycleErr(w, "Fork", vmID, err)
		return
	}

	ids := make([]string, 0, len(res.Forks))
	for _, f := range res.Forks {
		ids = append(ids, f.VMID)
		// The child inherits the source's placement, isolation and (redacted)
		// spec; it is linked back via parent_vm_id + snapshot_id.
		if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				INSERT INTO runtime_vms
				  (vm_id, tenant_id, agent_version_id, run_id, node, az, region, isolation_class,
				   state, state_reason, spec, agent_instance_id, confidential, parent_vm_id, snapshot_id, created_at)
				SELECT $1, tenant_id, agent_version_id, run_id, node, az, region, isolation_class,
				       $2, NULLIF($3, ''), spec, agent_instance_id, confidential, vm_id, $4, now()
				FROM runtime_vms WHERE vm_id = $5 AND tenant_id = $6
				ON CONFLICT (vm_id) DO NOTHING
			`, f.VMID, f.State, f.Error, res.SnapshotID, vmID, claims.TenantID)
			return e
		}); err != nil {
			h.logger().Error("runtime_vms fork insert failed", zap.String("vm_id", f.VMID), zap.Error(err))
		}
	}
	h.auditRuntime(ctx, claims.TenantID, vmID, "fork", map[string]any{
		"snapshot_id": res.SnapshotID, "count": count, "fork_vm_ids": ids,
	}, claims.Subject, "")

	forks := res.Forks
	if forks == nil {
		forks = []ForkChildResult{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sourceVmId": vmID, "snapshotId": res.SnapshotID, "forks": forks})
}
