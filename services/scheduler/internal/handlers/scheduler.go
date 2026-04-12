package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/dshakes/lantern/services/scheduler/internal/cron"
	"github.com/dshakes/lantern/services/scheduler/internal/middleware"
	"github.com/dshakes/lantern/services/scheduler/internal/server"
)

var tracer = otel.Tracer("lantern.scheduler")

// RegisterScheduleRequest represents a request to register a cron schedule.
type RegisterScheduleRequest struct {
	TenantID      string          `json:"tenant_id"`
	AgentName     string          `json:"agent_name"`
	CronExpr      string          `json:"cron_expr"`
	Timezone      string          `json:"timezone"`
	InputTemplate json.RawMessage `json:"input_template"`
}

// RegisterScheduleResponse represents the result of registering a schedule.
type RegisterScheduleResponse struct {
	ScheduleID string    `json:"schedule_id"`
	NextFireAt time.Time `json:"next_fire_at"`
}

// Schedule represents a cron schedule.
type Schedule struct {
	ID            string          `json:"id"`
	TenantID      string          `json:"tenant_id"`
	AgentName     string          `json:"agent_name"`
	CronExpr      string          `json:"cron_expr"`
	Timezone      string          `json:"timezone"`
	InputTemplate json.RawMessage `json:"input_template"`
	Enabled       bool            `json:"enabled"`
	NextFireAt    *time.Time      `json:"next_fire_at"`
	LastFireAt    *time.Time      `json:"last_fire_at"`
	CreatedAt     time.Time       `json:"created_at"`
}

// ListSchedulesRequest represents a request to list schedules.
type ListSchedulesRequest struct {
	TenantID string `json:"tenant_id"`
}

// ListSchedulesResponse represents the result of listing schedules.
type ListSchedulesResponse struct {
	Schedules []*Schedule `json:"schedules"`
}

// DeleteScheduleRequest represents a request to delete a schedule.
type DeleteScheduleRequest struct {
	TenantID   string `json:"tenant_id"`
	ScheduleID string `json:"schedule_id"`
}

// DeleteScheduleResponse represents the result of deleting a schedule.
type DeleteScheduleResponse struct {
	Deleted bool `json:"deleted"`
}

// TriggerRequest represents a request to trigger a one-shot run.
type TriggerRequest struct {
	TenantID  string          `json:"tenant_id"`
	AgentName string          `json:"agent_name"`
	Input     json.RawMessage `json:"input"`
	Delay     time.Duration   `json:"delay"`
}

// TriggerResponse represents the result of a trigger.
type TriggerResponse struct {
	RunID        string    `json:"run_id,omitempty"`
	DelayedRunID string    `json:"delayed_run_id,omitempty"`
	FireAt       time.Time `json:"fire_at,omitempty"`
}

// SchedulerService implements the scheduler gRPC handlers.
type SchedulerService struct {
	srv       *server.Server
	createRun cron.RunCreator
}

// NewSchedulerService creates a new SchedulerService handler.
func NewSchedulerService(srv *server.Server, createRun cron.RunCreator) *SchedulerService {
	return &SchedulerService{srv: srv, createRun: createRun}
}

func (s *SchedulerService) logger() *zap.Logger {
	return s.srv.Logger.Named("scheduler_service")
}

// setRLSTenantID sets the session variable used by Postgres RLS policies.
func setRLSTenantID(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL app.tenant_id = '%s'", tenantID))
	return err
}

// RegisterSchedule creates a new cron schedule.
func (s *SchedulerService) RegisterSchedule(ctx context.Context, req *RegisterScheduleRequest) (*RegisterScheduleResponse, error) {
	ctx, span := tracer.Start(ctx, "SchedulerService.RegisterSchedule")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("agent_name", req.AgentName),
		attribute.String("cron_expr", req.CronExpr),
	)

	if req.AgentName == "" {
		return nil, status.Error(codes.InvalidArgument, "agent_name is required")
	}
	if req.CronExpr == "" {
		return nil, status.Error(codes.InvalidArgument, "cron_expr is required")
	}

	// Validate cron expression.
	sched, err := cron.Parse(req.CronExpr)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid cron expression: %v", err)
	}

	tz := req.Timezone
	if tz == "" {
		tz = "UTC"
	}

	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid timezone: %s", tz)
	}

	// Calculate first fire time.
	now := time.Now().In(loc)
	nextFire := cron.NextFireTime(sched, now)

	inputTemplate := req.InputTemplate
	if inputTemplate == nil {
		inputTemplate = json.RawMessage("{}")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	var scheduleID string
	err = tx.QueryRow(ctx, `
		INSERT INTO schedules (tenant_id, agent_name, cron_expr, timezone, input_template, enabled, next_fire_at)
		VALUES ($1, $2, $3, $4, $5, true, $6)
		ON CONFLICT (tenant_id, agent_name, cron_expr)
		DO UPDATE SET timezone = EXCLUDED.timezone, input_template = EXCLUDED.input_template,
			enabled = true, next_fire_at = EXCLUDED.next_fire_at
		RETURNING id
	`, tenantID, req.AgentName, req.CronExpr, tz, inputTemplate, nextFire.UTC()).Scan(&scheduleID)
	if err != nil {
		s.logger().Error("insert schedule failed", zap.Error(err))
		return nil, status.Errorf(codes.Internal, "failed to insert schedule: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("schedule registered",
		zap.String("schedule_id", scheduleID),
		zap.String("tenant_id", tenantID),
		zap.String("agent_name", req.AgentName),
		zap.String("cron_expr", req.CronExpr),
		zap.Time("next_fire_at", nextFire),
	)

	return &RegisterScheduleResponse{
		ScheduleID: scheduleID,
		NextFireAt: nextFire,
	}, nil
}

// ListSchedules returns all schedules for a tenant.
func (s *SchedulerService) ListSchedules(ctx context.Context, req *ListSchedulesRequest) (*ListSchedulesResponse, error) {
	ctx, span := tracer.Start(ctx, "SchedulerService.ListSchedules")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(attribute.String("tenant_id", tenantID))

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT id, tenant_id, agent_name, cron_expr, timezone, input_template,
		       enabled, next_fire_at, last_fire_at, created_at
		FROM schedules
		WHERE tenant_id = $1
		ORDER BY created_at DESC
	`, tenantID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}
	defer rows.Close()

	var schedules []*Schedule
	for rows.Next() {
		var sched Schedule
		if err := rows.Scan(
			&sched.ID, &sched.TenantID, &sched.AgentName, &sched.CronExpr,
			&sched.Timezone, &sched.InputTemplate, &sched.Enabled,
			&sched.NextFireAt, &sched.LastFireAt, &sched.CreatedAt,
		); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}
		schedules = append(schedules, &sched)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	return &ListSchedulesResponse{Schedules: schedules}, nil
}

// DeleteSchedule removes a schedule.
func (s *SchedulerService) DeleteSchedule(ctx context.Context, req *DeleteScheduleRequest) (*DeleteScheduleResponse, error) {
	ctx, span := tracer.Start(ctx, "SchedulerService.DeleteSchedule")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("schedule_id", req.ScheduleID),
	)

	if req.ScheduleID == "" {
		return nil, status.Error(codes.InvalidArgument, "schedule_id is required")
	}

	tx, err := s.srv.Pool.Begin(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
	}

	tag, err := tx.Exec(ctx, `
		DELETE FROM schedules
		WHERE id = $1 AND tenant_id = $2
	`, req.ScheduleID, tenantID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "delete failed: %v", err)
	}

	if tag.RowsAffected() == 0 {
		return nil, status.Errorf(codes.NotFound, "schedule %q not found", req.ScheduleID)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("schedule deleted",
		zap.String("tenant_id", tenantID),
		zap.String("schedule_id", req.ScheduleID),
	)

	return &DeleteScheduleResponse{Deleted: true}, nil
}

// Trigger creates a one-shot trigger, optionally with a delay.
func (s *SchedulerService) Trigger(ctx context.Context, req *TriggerRequest) (*TriggerResponse, error) {
	ctx, span := tracer.Start(ctx, "SchedulerService.Trigger")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("agent_name", req.AgentName),
	)

	if req.AgentName == "" {
		return nil, status.Error(codes.InvalidArgument, "agent_name is required")
	}

	input := req.Input
	if input == nil {
		input = json.RawMessage("{}")
	}

	// If there's a delay, create a delayed run.
	if req.Delay > 0 {
		fireAt := time.Now().UTC().Add(req.Delay)

		tx, err := s.srv.Pool.Begin(ctx)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to begin transaction: %v", err)
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		if err := setRLSTenantID(ctx, tx, tenantID); err != nil {
			return nil, status.Errorf(codes.Internal, "failed to set tenant_id: %v", err)
		}

		var delayedRunID string
		err = tx.QueryRow(ctx, `
			INSERT INTO delayed_runs (tenant_id, agent_name, input, fire_at, status)
			VALUES ($1, $2, $3, $4, 'pending')
			RETURNING id
		`, tenantID, req.AgentName, input, fireAt).Scan(&delayedRunID)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to insert delayed run: %v", err)
		}

		if err := tx.Commit(ctx); err != nil {
			return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
		}

		s.logger().Info("delayed run created",
			zap.String("delayed_run_id", delayedRunID),
			zap.String("tenant_id", tenantID),
			zap.String("agent_name", req.AgentName),
			zap.Time("fire_at", fireAt),
		)

		return &TriggerResponse{
			DelayedRunID: delayedRunID,
			FireAt:       fireAt,
		}, nil
	}

	// Immediate trigger — create run now.
	runID, err := s.createRun(ctx, tenantID, req.AgentName, input)
	if err != nil {
		s.logger().Error("failed to create run from trigger",
			zap.String("agent_name", req.AgentName),
			zap.Error(err),
		)
		return nil, status.Errorf(codes.Internal, "failed to create run: %v", err)
	}

	s.logger().Info("immediate trigger fired",
		zap.String("tenant_id", tenantID),
		zap.String("agent_name", req.AgentName),
		zap.String("run_id", runID),
	)

	return &TriggerResponse{RunID: runID}, nil
}
