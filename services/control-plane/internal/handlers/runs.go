package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// RunService implements lanternv1.RunServiceServer.
type RunService struct {
	lanternv1.UnimplementedRunServiceServer
	srv *server.Server
}

// NewRunService creates a new RunService handler.
func NewRunService(srv *server.Server) *RunService {
	return &RunService{srv: srv}
}

func (s *RunService) logger() *zap.Logger {
	return s.srv.Logger.Named("run_service")
}

// CreateRun validates the request, inserts a run row with status=queued, and
// returns the Run proto. Workflow engine dispatch is not implemented yet.
//
// Uses TenantPool() — the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1
// (lantern_app role, subject to the tenant_isolation_runs policy); otherwise
// Pool (zero behaviour change). The WHERE tenant_id = $1 clause remains the
// primary correctness guard; RLS is defence-in-depth.
func (s *RunService) CreateRun(ctx context.Context, req *lanternv1.CreateRunRequest) (*lanternv1.Run, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetAgentName() == "" {
		return nil, status.Error(codes.InvalidArgument, "agent_name is required")
	}

	// TenantPool: routes to lantern_app (non-superuser, RLS-enforced) when
	// LANTERN_RLS_ENFORCE=1, otherwise aliases to Pool (zero behaviour change).
	tx, err := s.srv.TenantPool().Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	// Resolve agent_id and current_version_id from agent name.
	var agentID string
	var agentVersionID *string
	err = tx.QueryRow(ctx, `
		SELECT id, current_version_id
		FROM agents
		WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
	`, tenantID, req.GetAgentName()).Scan(&agentID, &agentVersionID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, status.Errorf(codes.NotFound, "agent %q not found", req.GetAgentName())
		}
		return nil, status.Errorf(codes.Internal, "failed to resolve agent: %v", err)
	}

	if agentVersionID == nil || *agentVersionID == "" {
		return nil, status.Error(codes.FailedPrecondition, "agent has no promoted version")
	}
	resolvedVersionID := *agentVersionID

	// Marshal input and trigger_meta to JSONB.
	inputJSON, err := structToJSON(req.GetInput())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid input: %v", err)
	}

	triggerMetaJSON, err := structToJSON(req.GetTriggerMeta())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid trigger_meta: %v", err)
	}

	triggerKind := triggerKindToString(req.GetTriggerKind())

	labelsJSON, err := json.Marshal(req.GetLabels())
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to marshal labels: %v", err)
	}

	// session_id: use caller-supplied value when valid UUID, else NULL.
	var sessionIDArg *string
	if sid := req.GetSessionId(); sid != "" {
		// Validate it looks like a UUID to avoid storing garbage.
		if isValidUUID(sid) {
			sessionIDArg = &sid
		}
	}

	var (
		runID     string
		createdAt time.Time
	)
	err = tx.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, trigger_meta, input, labels, session_id)
		VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
		RETURNING id, created_at
	`, tenantID, agentID, resolvedVersionID, triggerKind, triggerMetaJSON, inputJSON, labelsJSON, sessionIDArg,
	).Scan(&runID, &createdAt)
	if err != nil {
		s.logger().Error("insert run failed", zap.Error(err), zap.String("tenant_id", tenantID))
		return nil, status.Errorf(codes.Internal, "failed to insert run: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("run created",
		zap.String("tenant_id", tenantID),
		zap.String("run_id", runID),
		zap.String("agent_name", req.GetAgentName()),
	)

	run := &lanternv1.Run{
		Id:             runID,
		TenantId:       tenantID,
		AgentId:        agentID,
		AgentVersionId: resolvedVersionID,
		Status:         lanternv1.RunStatus_RUN_STATUS_QUEUED,
		TriggerKind:    req.GetTriggerKind(),
		TriggerMeta:    req.GetTriggerMeta(),
		Input:          req.GetInput(),
		Labels:         req.GetLabels(),
		CreatedAt:      timestamppb.New(createdAt),
	}
	if sessionIDArg != nil {
		run.SessionId = *sessionIDArg
	}
	return run, nil
}

// GetRun queries a run by ID.
//
// Uses srv.TenantPool() (the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1;
// otherwise the privileged pool — zero behaviour change).
func (s *RunService) GetRun(ctx context.Context, req *lanternv1.GetRunRequest) (*lanternv1.Run, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	// TenantPool: when LANTERN_RLS_ENFORCE=1 this is the lantern_app pool and RLS
	// is enforced at the DB level. Otherwise it aliases Pool — no change.
	tx, err := s.srv.TenantPool().Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	return s.scanRun(ctx, tx, tenantID, `
		SELECT id, tenant_id, agent_id, agent_version_id, status, trigger_kind,
		       trigger_meta, input, output, error, cost_usd, tokens_in, tokens_out,
		       started_at, finished_at, created_at, parent_run_id, labels, session_id
		FROM runs
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, req.GetId())
}

// ListRuns returns a paginated list of runs, filtered by agent_name and status.
//
// Uses srv.TenantPool() (the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1;
// otherwise the privileged pool — zero behaviour change).
func (s *RunService) ListRuns(ctx context.Context, req *lanternv1.ListRunsRequest) (*lanternv1.ListRunsResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	pageSize := int32(50)
	if req.GetPageSize() > 0 && req.GetPageSize() <= 100 {
		pageSize = req.GetPageSize()
	}

	// TenantPool: when LANTERN_RLS_ENFORCE=1 this is the lantern_app pool and RLS
	// is enforced at the DB level. Otherwise it aliases Pool — no change.
	tx, err := s.srv.TenantPool().Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	// Decode page token (base64-encoded created_at).
	var cursorTime time.Time
	if token := req.GetPageToken(); token != "" {
		decoded, err := base64.StdEncoding.DecodeString(token)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "invalid page_token")
		}
		if err := cursorTime.UnmarshalText(decoded); err != nil {
			return nil, status.Error(codes.InvalidArgument, "invalid page_token")
		}
	}

	query := `
		SELECT r.id, r.tenant_id, r.agent_id, r.agent_version_id, r.status, r.trigger_kind,
		       r.trigger_meta, r.input, r.output, r.error, r.cost_usd, r.tokens_in, r.tokens_out,
		       r.started_at, r.finished_at, r.created_at, r.parent_run_id, r.labels, r.session_id
		FROM runs r
		WHERE r.tenant_id = $1
	`
	args := []any{tenantID}
	argIdx := 2

	if req.GetAgentName() != "" {
		query += fmt.Sprintf(`
			AND r.agent_id = (
				SELECT id FROM agents WHERE tenant_id = $1 AND name = $%d AND archived_at IS NULL
			)`, argIdx)
		args = append(args, req.GetAgentName())
		argIdx++
	}

	if req.GetStatusFilter() != lanternv1.RunStatus_RUN_STATUS_UNSPECIFIED {
		query += fmt.Sprintf(" AND r.status = $%d", argIdx)
		args = append(args, runStatusToString(req.GetStatusFilter()))
		argIdx++
	}

	if sid := req.GetSessionId(); sid != "" && isValidUUID(sid) {
		query += fmt.Sprintf(" AND r.session_id = $%d", argIdx)
		args = append(args, sid)
		argIdx++
	}

	if !cursorTime.IsZero() {
		query += fmt.Sprintf(" AND r.created_at < $%d", argIdx)
		args = append(args, cursorTime)
		argIdx++
	}

	query += fmt.Sprintf(" ORDER BY r.created_at DESC LIMIT $%d", argIdx)
	args = append(args, pageSize+1)

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}
	defer rows.Close()

	var runs []*lanternv1.Run
	for rows.Next() {
		run, err := s.scanRunFromRow(rows)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	resp := &lanternv1.ListRunsResponse{}

	if int32(len(runs)) > pageSize {
		runs = runs[:pageSize]
		last := runs[len(runs)-1]
		tokenBytes, _ := last.CreatedAt.AsTime().MarshalText()
		resp.NextPageToken = base64.StdEncoding.EncodeToString(tokenBytes)
	}

	resp.Runs = runs

	// Total count.
	var totalCount int32
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM runs WHERE tenant_id = $1`, tenantID).Scan(&totalCount); err != nil {
		s.logger().Warn("count query failed", zap.Error(err))
	}
	resp.TotalCount = totalCount

	return resp, nil
}

// CancelRun sets a run's status to cancelled.
//
// Uses TenantPool() — the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1;
// otherwise Pool (zero behaviour change).
func (s *RunService) CancelRun(ctx context.Context, req *lanternv1.CancelRunRequest) (*lanternv1.Run, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "id is required")
	}

	// TenantPool: routes to lantern_app (non-superuser, RLS-enforced) when
	// LANTERN_RLS_ENFORCE=1, otherwise aliases to Pool (zero behaviour change).
	tx, err := s.srv.TenantPool().Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE runs SET status = 'cancelled', finished_at = now()
		WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running', 'paused')
	`, tenantID, req.GetId())
	if err != nil {
		return nil, status.Errorf(codes.Internal, "update failed: %v", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, status.Error(codes.FailedPrecondition, "run not found or not in a cancellable state")
	}

	// Re-read the updated row.
	run, err := s.scanRun(ctx, tx, tenantID, `
		SELECT id, tenant_id, agent_id, agent_version_id, status, trigger_kind,
		       trigger_meta, input, output, error, cost_usd, tokens_in, tokens_out,
		       started_at, finished_at, created_at, parent_run_id, labels, session_id
		FROM runs
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, req.GetId())
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("run cancelled",
		zap.String("tenant_id", tenantID),
		zap.String("run_id", req.GetId()),
		zap.String("reason", req.GetReason()),
	)

	return run, nil
}

// StreamRunEvents replays a run's journal_events over gRPC and then tails for
// new events until the run reaches a terminal status or the client cancels.
//
// This mirrors the REST SSE handler GetRunEvents (run_events.go): same
// journal_events query, same (run_id, seq) ordering, same tail-poll +
// terminal-status stop condition, same tenant-ownership gate. The difference
// is purely the wire shape — each journal row is mapped to the proto
// StreamEvent the SDK/dashboard gRPC client expects, and a Heartbeat is sent
// as a keepalive between events.
func (s *RunService) StreamRunEvents(req *lanternv1.StreamRunEventsRequest, stream lanternv1.RunService_StreamRunEventsServer) error {
	ctx := stream.Context()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return err
	}

	runID := req.GetRunId()
	if runID == "" {
		return status.Error(codes.InvalidArgument, "run_id is required")
	}

	// Ownership gate — the run must belong to the caller's tenant. We also read
	// the current status so we know whether a tail is needed after replay.
	var runStatus string
	// rls-exempt: ownership gate inside a long-lived gRPC stream (no per-row
	// transaction). The explicit `tenant_id = $2` filter is the authoritative
	// tenant gate here; RLS would only be defence-in-depth and a per-iteration
	// WithTenant tx in the tail loop adds no isolation the filter doesn't.
	if err := s.srv.Pool.QueryRow(ctx, `
		SELECT status FROM runs WHERE id = $1 AND tenant_id = $2
	`, runID, tenantID).Scan(&runStatus); err != nil {
		// pgx.ErrNoRows → not found or owned by another tenant. Don't leak which.
		return status.Error(codes.NotFound, "run not found")
	}

	s.logger().Info("stream started",
		zap.String("tenant_id", tenantID),
		zap.String("run_id", runID),
	)

	// -----------------------------------------------------------------------
	// Phase 1 — replay all existing journal_events in seq order. The run was
	// already confirmed to belong to this tenant, so journal_events.run_id is
	// a sufficient filter (no second tenant check needed — same reasoning as
	// the REST handler).
	// -----------------------------------------------------------------------
	lastSeq, err := s.replayJournalEvents(ctx, runID, 0, stream)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return status.Errorf(codes.Internal, "replay journal_events: %v", err)
	}

	// If the run was already terminal, replay is the whole stream.
	if isRunTerminal(runStatus) {
		return nil
	}

	// -----------------------------------------------------------------------
	// Phase 2 — tail: poll for new rows until the run is terminal or the
	// client cancels. Heartbeat keepalive runs between events.
	// -----------------------------------------------------------------------
	heartbeat := time.NewTicker(runEventsHeartbeatInterval)
	poll := time.NewTicker(runEventsTailPollInterval)
	defer heartbeat.Stop()
	defer poll.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-heartbeat.C:
			if err := stream.Send(&lanternv1.StreamEvent{
				RunId:   runID,
				Seq:     lastSeq,
				Ts:      timestamppb.Now(),
				Payload: &lanternv1.StreamEvent_Heartbeat{Heartbeat: &lanternv1.Heartbeat{}},
			}); err != nil {
				return err
			}

		case <-poll.C:
			newLast, err := s.replayJournalEvents(ctx, runID, lastSeq, stream)
			if err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				s.logger().Warn("stream tail poll failed",
					zap.String("run_id", runID), zap.Error(err))
				continue
			}
			lastSeq = newLast

			// Re-check status to detect terminal state.
			var currentStatus string
			// rls-exempt: terminal-status recheck in the stream tail loop; the
			// explicit `tenant_id = $2` filter is the tenant gate (see the
			// initial ownership gate above).
			if err := s.srv.Pool.QueryRow(ctx, `
				SELECT status FROM runs WHERE id = $1 AND tenant_id = $2
			`, runID, tenantID).Scan(&currentStatus); err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				s.logger().Warn("stream status recheck failed",
					zap.String("run_id", runID), zap.Error(err))
				return status.Errorf(codes.Internal, "status recheck: %v", err)
			}
			if isRunTerminal(currentStatus) {
				return nil
			}
		}
	}
}

// replayJournalEvents streams every journal_events row for runID with
// seq > afterSeq, in ascending seq order, mapping each to a proto StreamEvent.
// Returns the highest seq sent (or afterSeq when there were none).
func (s *RunService) replayJournalEvents(
	ctx context.Context,
	runID string,
	afterSeq uint64,
	stream lanternv1.RunService_StreamRunEventsServer,
) (uint64, error) {
	// rls-exempt: journal_events is an RLS-exempt child table (no tenant_id
	// column; scoped by run_id). The caller already verified run ownership via
	// the tenant-scoped gate on `runs`, so run_id is a sufficient filter.
	rows, err := s.srv.Pool.Query(ctx, `
		SELECT seq, kind, step_id, attempt, payload, created_at
		FROM   journal_events
		WHERE  run_id = $1 AND seq > $2
		ORDER  BY seq ASC
	`, runID, afterSeq)
	if err != nil {
		return afterSeq, err
	}
	defer rows.Close()

	lastSeq := afterSeq
	for rows.Next() {
		var (
			seq       int64
			kind      string
			stepID    *string
			attempt   int32
			payload   []byte
			createdAt time.Time
		)
		if err := rows.Scan(&seq, &kind, &stepID, &attempt, &payload, &createdAt); err != nil {
			s.logger().Warn("stream scan journal row",
				zap.String("run_id", runID), zap.Error(err))
			continue
		}
		ev := journalRowToStreamEvent(runID, uint64(seq), kind, stepID, attempt, payload, createdAt)
		if err := stream.Send(ev); err != nil {
			return lastSeq, err
		}
		if uint64(seq) > lastSeq {
			lastSeq = uint64(seq)
		}
	}
	if err := rows.Err(); err != nil {
		return lastSeq, err
	}
	return lastSeq, nil
}

// journalRowToStreamEvent maps one journal_events row onto the proto
// StreamEvent oneof the gRPC client consumes. The journal stores the typed
// detail in the JSONB payload; we surface the common step lifecycle kinds as
// their dedicated proto messages and fall back to a structured LogLine for
// everything else so no event is dropped on the wire.
func journalRowToStreamEvent(
	runID string,
	seq uint64,
	kind string,
	stepID *string,
	attempt int32,
	payload []byte,
	createdAt time.Time,
) *lanternv1.StreamEvent {
	ev := &lanternv1.StreamEvent{
		RunId: runID,
		Seq:   seq,
		Ts:    timestamppb.New(createdAt),
	}
	step := ""
	if stepID != nil {
		step = *stepID
		ev.StepId = step
	}

	switch kind {
	case "step_started":
		ev.Payload = &lanternv1.StreamEvent_StepStarted{StepStarted: &lanternv1.StepStarted{
			StepId:  step,
			Attempt: attempt,
			Kind:    journalPayloadString(payload, "type"),
		}}
	case "step_completed":
		ev.Payload = &lanternv1.StreamEvent_StepCompleted{StepCompleted: &lanternv1.StepCompleted{
			StepId:  step,
			Attempt: attempt,
		}}
	case "step_failed":
		ev.Payload = &lanternv1.StreamEvent_StepFailed{StepFailed: &lanternv1.StepFailed{
			StepId:       step,
			Attempt:      attempt,
			ErrorMessage: journalPayloadString(payload, "error"),
		}}
	default:
		// run_completed, run_failed, anomalies, and any other kind ride through
		// as a structured Log so gRPC subscribers see the full journal, exactly
		// like the SSE path forwards every row.
		ev.Payload = &lanternv1.StreamEvent_Log{Log: &lanternv1.LogLine{
			Level:   "info",
			Message: kind,
			Fields:  journalPayloadStruct(payload),
		}}
	}
	return ev
}

// journalPayloadString pulls a single string field out of a journal payload,
// returning "" when absent or unparseable (best-effort; never errors).
func journalPayloadString(payload []byte, key string) string {
	if len(payload) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// journalPayloadStruct converts a journal JSONB payload into a structpb.Struct
// for the LogLine.fields, returning nil on any parse failure so a malformed
// payload never aborts the stream.
func journalPayloadStruct(payload []byte) *structpb.Struct {
	if len(payload) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil
	}
	st, err := structpb.NewStruct(m)
	if err != nil {
		return nil
	}
	return st
}

// ReplayRun is not yet implemented for the spike.
func (s *RunService) ReplayRun(ctx context.Context, req *lanternv1.ReplayRunRequest) (*lanternv1.Run, error) {
	return nil, status.Error(codes.Unimplemented, "ReplayRun not yet implemented")
}

// SignalRun is not yet implemented for the spike.
func (s *RunService) SignalRun(ctx context.Context, req *lanternv1.SignalRunRequest) (*lanternv1.SignalRunResponse, error) {
	return nil, status.Error(codes.Unimplemented, "SignalRun not yet implemented")
}

// QueryRun is not yet implemented for the spike.
func (s *RunService) QueryRun(ctx context.Context, req *lanternv1.QueryRunRequest) (*lanternv1.QueryRunResponse, error) {
	return nil, status.Error(codes.Unimplemented, "QueryRun not yet implemented")
}

// ---------- helpers ----------

// scanRun executes a single-row query and returns a Run proto.
func (s *RunService) scanRun(ctx context.Context, tx pgx.Tx, tenantID, query string, args ...any) (*lanternv1.Run, error) {
	row := tx.QueryRow(ctx, query, args...)

	var (
		id             string
		tid            string
		agentID        string
		agentVersionID string
		statusStr      string
		triggerKind    string
		triggerMeta    []byte
		inputJSON      []byte
		outputJSON     []byte
		errorJSON      []byte
		costUSD        float64
		tokensIn       int64
		tokensOut      int64
		startedAt      *time.Time
		finishedAt     *time.Time
		createdAt      time.Time
		parentRunID    *string
		labelsJSON     []byte
		sessionID      *string
	)

	err := row.Scan(
		&id, &tid, &agentID, &agentVersionID, &statusStr, &triggerKind,
		&triggerMeta, &inputJSON, &outputJSON, &errorJSON, &costUSD, &tokensIn, &tokensOut,
		&startedAt, &finishedAt, &createdAt, &parentRunID, &labelsJSON, &sessionID,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, status.Error(codes.NotFound, "run not found")
		}
		return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
	}

	return buildRunProto(id, tid, agentID, agentVersionID, statusStr, triggerKind,
		triggerMeta, inputJSON, outputJSON, errorJSON, costUSD, tokensIn, tokensOut,
		startedAt, finishedAt, createdAt, parentRunID, labelsJSON, sessionID), nil
}

// scanRunFromRow scans a Run from an already-iterated pgx.Rows.
func (s *RunService) scanRunFromRow(rows pgx.Rows) (*lanternv1.Run, error) {
	var (
		id             string
		tid            string
		agentID        string
		agentVersionID string
		statusStr      string
		triggerKind    string
		triggerMeta    []byte
		inputJSON      []byte
		outputJSON     []byte
		errorJSON      []byte
		costUSD        float64
		tokensIn       int64
		tokensOut      int64
		startedAt      *time.Time
		finishedAt     *time.Time
		createdAt      time.Time
		parentRunID    *string
		labelsJSON     []byte
		sessionID      *string
	)

	err := rows.Scan(
		&id, &tid, &agentID, &agentVersionID, &statusStr, &triggerKind,
		&triggerMeta, &inputJSON, &outputJSON, &errorJSON, &costUSD, &tokensIn, &tokensOut,
		&startedAt, &finishedAt, &createdAt, &parentRunID, &labelsJSON, &sessionID,
	)
	if err != nil {
		return nil, err
	}

	return buildRunProto(id, tid, agentID, agentVersionID, statusStr, triggerKind,
		triggerMeta, inputJSON, outputJSON, errorJSON, costUSD, tokensIn, tokensOut,
		startedAt, finishedAt, createdAt, parentRunID, labelsJSON, sessionID), nil
}

func buildRunProto(
	id, tenantID, agentID, agentVersionID, statusStr, triggerKind string,
	triggerMeta, inputJSON, outputJSON, errorJSON []byte,
	costUSD float64, tokensIn, tokensOut int64,
	startedAt, finishedAt *time.Time,
	createdAt time.Time,
	parentRunID *string,
	labelsJSON []byte,
	sessionID *string,
) *lanternv1.Run {
	run := &lanternv1.Run{
		Id:             id,
		TenantId:       tenantID,
		AgentId:        agentID,
		AgentVersionId: agentVersionID,
		Status:         parseRunStatus(statusStr),
		TriggerKind:    parseTriggerKind(triggerKind),
		CostUsd:        costUSD,
		TokensIn:       tokensIn,
		TokensOut:      tokensOut,
		CreatedAt:      timestamppb.New(createdAt),
	}

	if startedAt != nil {
		run.StartedAt = timestamppb.New(*startedAt)
	}
	if finishedAt != nil {
		run.FinishedAt = timestamppb.New(*finishedAt)
	}
	if parentRunID != nil {
		run.ParentRunId = *parentRunID
	}
	if sessionID != nil {
		run.SessionId = *sessionID
	}

	run.TriggerMeta = jsonToStruct(triggerMeta)
	run.Input = jsonToStruct(inputJSON)
	run.Output = jsonToStruct(outputJSON)

	if len(errorJSON) > 0 {
		var re lanternv1.RunError
		var raw map[string]any
		if json.Unmarshal(errorJSON, &raw) == nil {
			if c, ok := raw["code"].(string); ok {
				re.Code = c
			}
			if m, ok := raw["message"].(string); ok {
				re.Message = m
			}
			if sid, ok := raw["step_id"].(string); ok {
				re.StepId = sid
			}
			run.Error = &re
		}
	}

	labels := make(map[string]string)
	if json.Unmarshal(labelsJSON, &labels) == nil {
		run.Labels = labels
	}

	return run
}

func structToJSON(s *structpb.Struct) ([]byte, error) {
	if s == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(s.AsMap())
}

func jsonToStruct(data []byte) *structpb.Struct {
	if len(data) == 0 {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	s, err := structpb.NewStruct(m)
	if err != nil {
		return nil
	}
	return s
}

func parseRunStatus(s string) lanternv1.RunStatus {
	switch s {
	case "queued":
		return lanternv1.RunStatus_RUN_STATUS_QUEUED
	case "running":
		return lanternv1.RunStatus_RUN_STATUS_RUNNING
	case "paused":
		return lanternv1.RunStatus_RUN_STATUS_PAUSED
	case "succeeded":
		return lanternv1.RunStatus_RUN_STATUS_SUCCEEDED
	case "failed":
		return lanternv1.RunStatus_RUN_STATUS_FAILED
	case "cancelled":
		return lanternv1.RunStatus_RUN_STATUS_CANCELLED
	default:
		return lanternv1.RunStatus_RUN_STATUS_UNSPECIFIED
	}
}

func runStatusToString(s lanternv1.RunStatus) string {
	switch s {
	case lanternv1.RunStatus_RUN_STATUS_QUEUED:
		return "queued"
	case lanternv1.RunStatus_RUN_STATUS_RUNNING:
		return "running"
	case lanternv1.RunStatus_RUN_STATUS_PAUSED:
		return "paused"
	case lanternv1.RunStatus_RUN_STATUS_SUCCEEDED:
		return "succeeded"
	case lanternv1.RunStatus_RUN_STATUS_FAILED:
		return "failed"
	case lanternv1.RunStatus_RUN_STATUS_CANCELLED:
		return "cancelled"
	default:
		return "unspecified"
	}
}

func parseTriggerKind(s string) lanternv1.TriggerKind {
	switch s {
	case "api":
		return lanternv1.TriggerKind_TRIGGER_KIND_API
	case "schedule":
		return lanternv1.TriggerKind_TRIGGER_KIND_SCHEDULE
	case "webhook":
		return lanternv1.TriggerKind_TRIGGER_KIND_WEBHOOK
	case "surface":
		return lanternv1.TriggerKind_TRIGGER_KIND_SURFACE
	case "a2a":
		return lanternv1.TriggerKind_TRIGGER_KIND_A2A
	case "connector":
		return lanternv1.TriggerKind_TRIGGER_KIND_CONNECTOR
	case "manual":
		return lanternv1.TriggerKind_TRIGGER_KIND_MANUAL
	default:
		return lanternv1.TriggerKind_TRIGGER_KIND_UNSPECIFIED
	}
}

func triggerKindToString(k lanternv1.TriggerKind) string {
	switch k {
	case lanternv1.TriggerKind_TRIGGER_KIND_API:
		return "api"
	case lanternv1.TriggerKind_TRIGGER_KIND_SCHEDULE:
		return "schedule"
	case lanternv1.TriggerKind_TRIGGER_KIND_WEBHOOK:
		return "webhook"
	case lanternv1.TriggerKind_TRIGGER_KIND_SURFACE:
		return "surface"
	case lanternv1.TriggerKind_TRIGGER_KIND_A2A:
		return "a2a"
	case lanternv1.TriggerKind_TRIGGER_KIND_CONNECTOR:
		return "connector"
	case lanternv1.TriggerKind_TRIGGER_KIND_MANUAL:
		return "manual"
	default:
		return "api"
	}
}

// uuidRE matches the canonical 8-4-4-4-12 UUID form (case-insensitive).
var uuidRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// isValidUUID returns true when s is a well-formed UUID string.
// Used to reject obviously invalid session_id values before they reach Postgres.
func isValidUUID(s string) bool { return uuidRE.MatchString(s) }
