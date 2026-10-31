package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/structpb"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
)

// toolSched is a recScheduler that also serves ExecTool (the file API's path
// to the runtime-manager), recording the last request.
type toolSched struct {
	recScheduler
	resp *palv1.ExecToolResponse
	err  error
	got  *palv1.ExecToolRequest
	node string
}

func (s *toolSched) ExecTool(_ context.Context, node string, req *palv1.ExecToolRequest) (*palv1.ExecToolResponse, error) {
	s.got, s.node = req, node
	return s.resp, s.err
}

func toolOK(t *testing.T, result map[string]any) *palv1.ExecToolResponse {
	t.Helper()
	st, err := structpb.NewStruct(result)
	if err != nil {
		t.Fatal(err)
	}
	return &palv1.ExecToolResponse{Status: palv1.ToolStatus_TOOL_STATUS_OK, Result: st}
}

func toolErr(st palv1.ToolStatus, msg string) *palv1.ExecToolResponse {
	return &palv1.ExecToolResponse{Status: st, Error: msg}
}

// doFiles fires a file-API request at the matching handler.
func doFiles(h *RuntimeHandler, tok, method, sub, vmID, path, body string) *httptest.ResponseRecorder {
	url := "/v1/runtime/vms/" + vmID + "/files" + sub + "?path=" + path
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.SetPathValue("id", vmID)
	if tok != "" {
		req.Header.Set("Authorization", bearerHeader(tok))
	}
	w := httptest.NewRecorder()
	switch {
	case sub == "":
		h.ListFiles(w, req)
	case method == http.MethodGet:
		h.ReadFile(w, req)
	default:
		h.WriteFile(w, req)
	}
	return w
}

func TestFiles_AuthAndScope(t *testing.T) {
	h := newTestRuntimeHandler(t, &toolSched{})
	h.srv.Pool = nil
	if w := doFiles(h, "", http.MethodGet, "", "vm-1", "a", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("list without token: %d, want 401", w.Code)
	}
	// member is runtime:read only — writing a file needs runtime:admin (like exec).
	member := mintTestToken(t, "00000000-0000-0000-0000-0000000000aa", "u1", "member")
	if w := doFiles(h, member, http.MethodPut, "/content", "vm-1", "a", "x"); w.Code != http.StatusForbidden {
		t.Errorf("write as member: %d, want 403", w.Code)
	}
	// Content endpoints require a path (checked before any DB access).
	if w := doFiles(h, member, http.MethodGet, "/content", "vm-1", "", ""); w.Code != http.StatusBadRequest {
		t.Errorf("read without path: %d, want 400", w.Code)
	}
}

func TestFileToolErrStatus(t *testing.T) {
	cases := []struct {
		msg  string
		want int
	}{
		{"read_file: ../etc/passwd: outside the workspace root", 400},
		{"write_file: ..: not a file path", 400},
		{"read_file: x: not a regular file", 400},
		{"read_file: missing.txt: No such file or directory (os error 2)", 404},
		{"exec_tool: harness output exceeded the 1048576-byte cap", 413},
		{"read_file: x: Permission denied (os error 13)", 400},
	}
	for _, tc := range cases {
		if got := fileToolErrStatus(tc.msg); got != tc.want {
			t.Errorf("%q → %d, want %d", tc.msg, got, tc.want)
		}
	}
}

// runFileTool status mapping, DB-free.
func TestRunFileTool_StatusMapping(t *testing.T) {
	cases := []struct {
		name string
		resp *palv1.ExecToolResponse
		err  error
		want int
	}{
		{"path escape", toolErr(palv1.ToolStatus_TOOL_STATUS_ERROR, "read_file: ../x: outside the workspace root"), nil, 400},
		{"missing", toolErr(palv1.ToolStatus_TOOL_STATUS_ERROR, "read_file: x: No such file or directory (os error 2)"), nil, 404},
		{"unavailable", toolErr(palv1.ToolStatus_TOOL_STATUS_UNAVAILABLE, "harness not connected"), nil, 503},
		{"manager not found", nil, status.Error(grpccodes.NotFound, "vm x not found"), 404},
		{"manager down", nil, status.Error(grpccodes.Unavailable, "dial"), 503},
		{"manager internal", nil, status.Error(grpccodes.Internal, "boom"), 502},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestRuntimeHandler(t, &toolSched{resp: tc.resp, err: tc.err})
			w := httptest.NewRecorder()
			if _, ok := h.runFileTool(context.Background(), w, "t1", "", "vm-1", "read_file", map[string]any{"path": "x"}, ""); ok {
				t.Fatal("ok=true, want failure")
			}
			if w.Code != tc.want {
				t.Errorf("got %d, want %d (body %s)", w.Code, tc.want, w.Body.String())
			}
		})
	}
	t.Run("scheduler without ExecTool", func(t *testing.T) {
		h := newTestRuntimeHandler(t, &recScheduler{})
		w := httptest.NewRecorder()
		if _, ok := h.runFileTool(context.Background(), w, "t1", "", "vm-1", "list_dir", map[string]any{"path": "."}, ""); ok || w.Code != 503 {
			t.Errorf("got ok=%v code=%d, want 503", ok, w.Code)
		}
	})
}

func TestFileWriteIdemKey(t *testing.T) {
	a := fileWriteIdemKey("vm-1", "a.txt", []byte("hi"))
	if a != fileWriteIdemKey("vm-1", "a.txt", []byte("hi")) {
		t.Error("idempotency key must be deterministic")
	}
	for _, other := range []string{
		fileWriteIdemKey("vm-2", "a.txt", []byte("hi")),
		fileWriteIdemKey("vm-1", "b.txt", []byte("hi")),
		fileWriteIdemKey("vm-1", "a.txt", []byte("ho")),
		fileWriteIdemKey("vm-1a", ".txt", []byte("hi")), // separator prevents splice collisions
	} {
		if other == a {
			t.Errorf("distinct writes share key %s", a)
		}
	}
}

// ---------------------------------------------------------------------------
// DB-backed: ownership, happy paths, oversize.
// ---------------------------------------------------------------------------

func TestFiles_DB(t *testing.T) {
	pool := openTestPool(t)
	migrateRuntimeTables(t, pool)
	tenant := uniqueTenantID("files")
	other := uniqueTenantID("files-other")
	seedTestTenant(t, pool, tenant)
	seedTestTenant(t, pool, other)
	t.Cleanup(func() { cleanupTenant(t, pool, tenant); cleanupTenant(t, pool, other) })

	sched := &toolSched{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenant, "00000000-0000-0000-0000-0000000000c1", "owner")
	otherTok := mintTestToken(t, other, "00000000-0000-0000-0000-0000000000c2", "owner")
	vm := "vm-files-" + tenant[:8]
	seedLifecycleVM(t, h, tenant, vm, "running") // node-a

	t.Run("cross-tenant VM is 404 and the manager is never called", func(t *testing.T) {
		sched.got = nil
		for _, c := range []struct{ method, sub, body string }{
			{http.MethodGet, "", ""}, {http.MethodGet, "/content", ""}, {http.MethodPut, "/content", "x"},
		} {
			if w := doFiles(h, otherTok, c.method, c.sub, vm, "a.txt", c.body); w.Code != http.StatusNotFound {
				t.Errorf("%s files%s cross-tenant: %d, want 404", c.method, c.sub, w.Code)
			}
		}
		if sched.got != nil {
			t.Errorf("ExecTool called for a cross-tenant request: %+v", sched.got)
		}
	})

	t.Run("list", func(t *testing.T) {
		sched.resp = toolOK(t, map[string]any{
			"entries":   []any{map[string]any{"name": "a.txt", "type": "file", "size": 2}},
			"truncated": false,
		})
		w := doFiles(h, tok, http.MethodGet, "", vm, "", "")
		if w.Code != http.StatusOK {
			t.Fatalf("list: %d %s", w.Code, w.Body.String())
		}
		var got struct {
			Path    string           `json:"path"`
			Entries []map[string]any `json:"entries"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &got)
		if got.Path != "." || len(got.Entries) != 1 || got.Entries[0]["name"] != "a.txt" {
			t.Errorf("list body = %s", w.Body.String())
		}
		if sched.got.GetToolName() != "list_dir" || sched.got.GetTenantId() != tenant || sched.got.GetVmId() != vm ||
			sched.got.GetArgs().AsMap()["path"] != "." || sched.node != "node-a" {
			t.Errorf("ExecTool got %+v on node %q", sched.got, sched.node)
		}
	})

	t.Run("read", func(t *testing.T) {
		sched.resp = toolOK(t, map[string]any{"content": "hello" + harnessTruncatedMarker, "truncated": true})
		w := doFiles(h, tok, http.MethodGet, "/content", vm, "a.txt", "")
		if w.Code != http.StatusOK || w.Body.String() != "hello" || w.Header().Get("X-Pal-Truncated") != "true" {
			t.Errorf("read: %d %q truncated=%q", w.Code, w.Body.String(), w.Header().Get("X-Pal-Truncated"))
		}
		if sched.got.GetToolName() != "read_file" || sched.got.GetTenantId() != tenant || sched.got.GetArgs().AsMap()["path"] != "a.txt" {
			t.Errorf("ExecTool got %+v", sched.got)
		}
	})

	t.Run("write", func(t *testing.T) {
		sched.resp = toolOK(t, map[string]any{"bytes_written": 5})
		w := doFiles(h, tok, http.MethodPut, "/content", vm, "dir/b.txt", "hello")
		if w.Code != http.StatusOK {
			t.Fatalf("write: %d %s", w.Code, w.Body.String())
		}
		args := sched.got.GetArgs().AsMap()
		if sched.got.GetToolName() != "write_file" || sched.got.GetTenantId() != tenant ||
			args["path"] != "dir/b.txt" || args["content"] != "hello" ||
			sched.got.GetIdempotencyKey() != fileWriteIdemKey(vm, "dir/b.txt", []byte("hello")) {
			t.Errorf("ExecTool got %+v", sched.got)
		}
	})

	t.Run("path escape is 400", func(t *testing.T) {
		sched.resp = toolErr(palv1.ToolStatus_TOOL_STATUS_ERROR, "write_file: ../x: parent: outside the workspace root")
		if w := doFiles(h, tok, http.MethodPut, "/content", vm, "../x", "y"); w.Code != http.StatusBadRequest {
			t.Errorf("escape: %d, want 400", w.Code)
		}
	})

	t.Run("unavailable is 503", func(t *testing.T) {
		sched.resp = toolErr(palv1.ToolStatus_TOOL_STATUS_UNAVAILABLE, "harness not connected")
		if w := doFiles(h, tok, http.MethodGet, "/content", vm, "a.txt", ""); w.Code != http.StatusServiceUnavailable {
			t.Errorf("unavailable: %d, want 503", w.Code)
		}
	})

	t.Run("oversize and non-UTF-8 writes never reach the manager", func(t *testing.T) {
		sched.got = nil
		if w := doFiles(h, tok, http.MethodPut, "/content", vm, "big", strings.Repeat("a", fileAPIMaxBytes+1)); w.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("oversize: %d, want 413", w.Code)
		}
		if w := doFiles(h, tok, http.MethodPut, "/content", vm, "bin", "\xff\xfe"); w.Code != http.StatusBadRequest {
			t.Errorf("non-utf8: %d, want 400", w.Code)
		}
		if sched.got != nil {
			t.Errorf("ExecTool called: %+v", sched.got)
		}
	})
}
