package handlers

// Sandbox file API: list / read / write files inside a microVM's /workspace.
//
// No new in-VM mechanism: every call is a RuntimeManager.ExecTool dispatch of
// the harness tool runner's list_dir / read_file / write_file
// (services/harness/src/tool_runner.rs), which confines paths to /workspace
// (openat2 RESOLVE_BENEATH), runs as the workload fsuid, and caps content at
// 1 MiB. The control-plane's job is the tenant gate: the VM must belong to
// the caller (404 otherwise, no existence leak) and tenant_id is stamped on
// the ExecTool request so the manager re-checks it (ADR 0025).
//
// File content is UTF-8 text: the tool contract carries it as a JSON string
// (reads are lossy-decoded in the guest), so non-UTF-8 writes are refused.
// File contents are never logged or audited (invariant #10).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/structpb"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
)

// fileAPIMaxBytes mirrors the harness's TOOL_OUTPUT_MAX_BYTES (1 MiB).
const fileAPIMaxBytes = 1 << 20

// harnessTruncatedMarker is what the harness appends to a capped read; the
// REST surface reports truncation via a header instead of in-band.
const harnessTruncatedMarker = "\n<truncated: output exceeded the cap>"

// toolExecer is implemented by schedulers that can reach the runtime-manager's
// ExecTool RPC. The stub scheduler does not — the file API then returns 503.
type toolExecer interface {
	// ExecTool dispatches to the manager on `node` ("" = default manager).
	ExecTool(ctx context.Context, node string, req *palv1.ExecToolRequest) (*palv1.ExecToolResponse, error)
}

func (c *grpcSchedulerClient) ExecTool(ctx context.Context, node string, req *palv1.ExecToolRequest) (*palv1.ExecToolResponse, error) {
	mgr, err := c.managerClient(node)
	if err != nil {
		return nil, err
	}
	return mgr.ExecTool(withTenant(ctx, req.GetTenantId()), req)
}

// ListFiles handles GET /v1/runtime/vms/{id}/files?path=  (default: workspace root).
func (h *RuntimeHandler) ListFiles(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "."
	}
	ctx, claims, node, vmID, ok := h.fileTarget(w, r, ScopeRuntimeRead, path)
	if !ok {
		return
	}
	res, ok := h.runFileTool(ctx, w, claims.TenantID, node, vmID, "list_dir", map[string]any{"path": path}, "")
	if !ok {
		return
	}
	entries := res["entries"]
	if entries == nil {
		entries = []any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":      path,
		"entries":   entries,
		"truncated": res["truncated"] == true,
	})
}

// ReadFile handles GET /v1/runtime/vms/{id}/files/content?path= → raw text.
// A file over 1 MiB is cut at the cap and flagged with X-Pal-Truncated.
func (h *RuntimeHandler) ReadFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	ctx, claims, node, vmID, ok := h.fileTarget(w, r, ScopeRuntimeRead, path)
	if !ok {
		return
	}
	res, ok := h.runFileTool(ctx, w, claims.TenantID, node, vmID, "read_file", map[string]any{"path": path}, "")
	if !ok {
		return
	}
	content, _ := res["content"].(string)
	if res["truncated"] == true {
		content = strings.TrimSuffix(content, harnessTruncatedMarker)
		w.Header().Set("X-Pal-Truncated", "true")
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, content)
}

// WriteFile handles PUT /v1/runtime/vms/{id}/files/content?path= (body = file
// bytes, UTF-8, ≤ 1 MiB). Creates or truncates the file.
func (h *RuntimeHandler) WriteFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	ctx, claims, node, vmID, ok := h.fileTarget(w, r, ScopeRuntimeAdmin, path)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, fileAPIMaxBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file exceeds 1 MiB"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "read body failed"})
		return
	}
	if !utf8.Valid(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content must be UTF-8 text"})
		return
	}
	res, ok := h.runFileTool(ctx, w, claims.TenantID, node, vmID, "write_file",
		map[string]any{"path": path, "content": string(body)}, fileWriteIdemKey(vmID, path, body))
	if !ok {
		return
	}
	h.auditRuntime(ctx, claims.TenantID, vmID, "file_write",
		map[string]any{"path": path, "bytes": len(body)}, claims.Subject, "")
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "bytesWritten": res["bytes_written"]})
}

// fileWriteIdemKey derives the write's idempotency key (invariant #8): a retry
// of the same bytes to the same path on the same VM carries the same key.
func fileWriteIdemKey(vmID, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(vmID))
	h.Write([]byte{0})
	h.Write([]byte(path))
	h.Write([]byte{0})
	h.Write(body)
	return "file-write:" + hex.EncodeToString(h.Sum(nil))
}

// fileTarget authenticates, enforces scope, requires a path, and confirms the
// VM belongs to the caller's tenant, returning its node placement. Writes the
// error response and returns ok=false on any failure.
func (h *RuntimeHandler) fileTarget(w http.ResponseWriter, r *http.Request, scope, path string) (ctx context.Context, claims *PalClaims, node, vmID string, ok bool) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, nil, "", "", false
	}
	if !h.requireRuntimeScope(w, claims, scope) {
		return nil, nil, "", "", false
	}
	vmID = r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return nil, nil, "", "", false
	}
	if path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return nil, nil, "", "", false
	}
	ctx = middleware.InjectTenantID(r.Context(), claims.TenantID)
	// tenant_id predicate + RLS: a cross-tenant vm_id has no row → 404.
	var n *string
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT node FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`, vmID, claims.TenantID).Scan(&n)
	}); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return nil, nil, "", "", false
	}
	if n != nil {
		node = *n
	}
	// Auto-resume: if the VM was auto-suspended (paused + idle_timeout_secs > 0),
	// transparently resume it before the caller invokes the file tool.
	if !h.ensureVMRunning(w, ctx, claims.TenantID, vmID) {
		return nil, nil, "", "", false
	}
	return ctx, claims, node, vmID, true
}

// runFileTool dispatches one file tool via ExecTool and maps the outcome onto
// HTTP. Returns the tool's result object on success.
func (h *RuntimeHandler) runFileTool(ctx context.Context, w http.ResponseWriter, tenantID, node, vmID, tool string, args map[string]any, idemKey string) (map[string]any, bool) {
	te, ok := h.scheduler.(toolExecer)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "file API unavailable: runtime-manager not wired"})
		return nil, false
	}
	argStruct, err := structpb.NewStruct(args)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid arguments"})
		return nil, false
	}
	resp, err := te.ExecTool(ctx, node, &palv1.ExecToolRequest{
		VmId:           vmID,
		ToolName:       tool,
		Args:           argStruct,
		IdempotencyKey: idemKey,
		TenantId:       tenantID,
	})
	if err != nil {
		switch status.Code(err) {
		case grpccodes.NotFound, grpccodes.PermissionDenied:
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		case grpccodes.Unavailable:
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "runtime-manager unavailable"})
		default:
			h.logger().Error("runtime-manager ExecTool failed", zap.String("vm_id", vmID), zap.String("tool", tool), zap.Error(err))
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "runtime-manager error"})
		}
		return nil, false
	}
	switch resp.GetStatus() {
	case palv1.ToolStatus_TOOL_STATUS_OK:
		return resp.GetResult().AsMap(), true
	case palv1.ToolStatus_TOOL_STATUS_UNAVAILABLE:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": resp.GetError()})
	default:
		writeJSON(w, fileToolErrStatus(resp.GetError()), map[string]string{"error": resp.GetError()})
	}
	return nil, false
}

// fileToolErrStatus maps a harness file-tool error message (which names the
// requested path and the OS error, never file contents) onto an HTTP status.
func fileToolErrStatus(msg string) int {
	switch {
	case strings.Contains(msg, "No such file or directory"):
		return http.StatusNotFound
	case strings.Contains(msg, "exceeded the") && strings.Contains(msg, "cap"):
		// Manager-side cap on the whole tool result (content + JSON envelope).
		return http.StatusRequestEntityTooLarge
	default:
		// Path escapes ("outside the workspace root"), not-a-file, permission
		// and validation failures are all caller errors.
		return http.StatusBadRequest
	}
}
