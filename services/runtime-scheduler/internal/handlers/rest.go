// REST gateway for the RuntimeScheduler. Thin shim that translates
// HTTP/JSON into the in-process gRPC handlers — same auth (Bearer JWT),
// same tenant scoping, no parallel business logic.
//
// Endpoints:
//
//	POST   /v1/schedule          -> Schedule
//	GET    /v1/vms               -> List
//	DELETE /v1/vms/{id}          -> Terminate
//	GET    /v1/cluster           -> Cluster
//	POST   /v1/nodes/heartbeat   -> upsert node state (manager -> scheduler)
package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"go.uber.org/zap"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/middleware"
)

// RESTHandler exposes the REST gateway.
type RESTHandler struct {
	Service *SchedulerService
	Store   cluster.ClusterStore
	Secret  []byte
	Logger  *zap.Logger
}

// NewRESTHandler constructs the gateway.
func NewRESTHandler(svc *SchedulerService, store cluster.ClusterStore, secret []byte, logger *zap.Logger) *RESTHandler {
	return &RESTHandler{
		Service: svc,
		Store:   store,
		Secret:  secret,
		Logger:  logger.Named("rest"),
	}
}

// authedContext validates the bearer token and returns a context with
// the tenant_id injected (so the gRPC handlers can pull it out via the
// shared middleware helper).
func (h *RESTHandler) authedContext(r *http.Request) (string, error) {
	return middleware.ResolveTenantHTTP(r, h.Secret)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// scheduleBody is the REST projection of ScheduleRequest. Mirrors the
// proto field names in snake_case so SDK / curl users get the same
// shape they see in proto.
type scheduleBody struct {
	Spec            *lanternv1.AgentSpec     `json:"spec"`
	Hint            *lanternv1.PlacementHint `json:"hint,omitempty"`
	ColdStartBudget string                   `json:"cold_start_budget,omitempty"` // e.g. "10s"
	ReserveOnly     bool                     `json:"reserve_only,omitempty"`
}

// POST /v1/schedule
func (h *RESTHandler) Schedule(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authedContext(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	var body scheduleBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	handle, err := h.Service.Schedule(ctx, &lanternv1.ScheduleRequest{
		Spec:        body.Spec,
		Hint:        body.Hint,
		ReserveOnly: body.ReserveOnly,
	})
	if err != nil {
		h.Logger.Warn("schedule failed", zap.Error(err))
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, handle)
}

// GET /v1/vms
func (h *RESTHandler) ListVMs(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authedContext(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	resp, err := h.Service.List(ctx, &lanternv1.ListRequest{
		LabelSelector: r.URL.Query().Get("labels"),
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// DELETE /v1/vms/{id}
func (h *RESTHandler) TerminateVM(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authedContext(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing vm id")
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	resp, err := h.Service.Terminate(ctx, &lanternv1.TerminateRequest{
		VmId:   id,
		Reason: r.URL.Query().Get("reason"),
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// GET /v1/cluster
func (h *RESTHandler) GetCluster(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authedContext(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	resp, err := h.Service.Cluster(ctx, &lanternv1.ClusterRequest{})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// heartbeatBody is the runtime-manager -> scheduler heartbeat payload.
// Tenant-agnostic; authenticated via the shared SCHEDULER_NODE_TOKEN
// header (same pattern as the WhatsApp bridge heartbeat).
type heartbeatBody struct {
	Name              string           `json:"name"`
	Address           string           `json:"address"`
	Region            string           `json:"region"`
	Continent         string           `json:"continent"`
	AvailabilityZone  string           `json:"availability_zone"`
	IsSpot            bool             `json:"is_spot"`
	IsARM             bool             `json:"is_arm"`
	FreeVcpuMillis    int64            `json:"free_vcpu_millis"`
	FreeMemoryBytes   int64            `json:"free_memory_bytes"`
	WarmPoolExact     map[string]int32 `json:"warm_pool_exact"`
	WarmPoolImageOnly map[string]int32 `json:"warm_pool_image_only"`
	RecentOOMCount    int              `json:"recent_oom_count"`
	RecentKernelEvts  int              `json:"recent_kernel_events"`
}

// POST /v1/nodes/heartbeat
func (h *RESTHandler) NodeHeartbeat(w http.ResponseWriter, r *http.Request, expectedToken string) {
	if expectedToken != "" {
		if r.Header.Get("X-Scheduler-Token") != expectedToken {
			writeErr(w, http.StatusUnauthorized, "invalid X-Scheduler-Token")
			return
		}
	}
	var body heartbeatBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	h.Store.UpsertNode(cluster.Node{
		Name:               body.Name,
		Address:            body.Address,
		Region:             body.Region,
		Continent:          body.Continent,
		AvailabilityZone:   body.AvailabilityZone,
		IsSpot:             body.IsSpot,
		IsARM:              body.IsARM,
		FreeVcpuMillis:     body.FreeVcpuMillis,
		FreeMemoryBytes:    body.FreeMemoryBytes,
		WarmPoolExact:      body.WarmPoolExact,
		WarmPoolImageOnly:  body.WarmPoolImageOnly,
		LastHeartbeat:      time.Now().UTC(),
		RecentOOMCount:     body.RecentOOMCount,
		RecentKernelEvents: body.RecentKernelEvts,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
