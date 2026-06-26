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
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/scheduler/internal/cron"
	"github.com/dshakes/lantern/services/scheduler/internal/middleware"
	"github.com/dshakes/lantern/services/scheduler/internal/server"
)

var tracer = otel.Tracer("lantern.scheduler")

// SchedulerService implements the lantern.v1.SchedulerService gRPC server.
// Wire types come from gen/go (the proto is the source of truth); tenant is
// read from gRPC metadata (invariant #7), never the request body. A fired
// schedule creates a run via the control-plane RunService (invariant #2).
type SchedulerService struct {
	lanternv1.UnimplementedSchedulerServiceServer

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
func (s *SchedulerService) RegisterSchedule(ctx context.Context, req *lanternv1.RegisterScheduleRequest) (*lanternv1.RegisterScheduleResponse, error) {
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

	inputTemplate, err := structToJSON(req.InputTemplate)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid input_template: %v", err)
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

	return &lanternv1.RegisterScheduleResponse{
		ScheduleId: scheduleID,
		NextFireAt: timestamppb.New(nextFire),
	}, nil
}

// ListSchedules returns all schedules for a tenant.
func (s *SchedulerService) ListSchedules(ctx context.Context, _ *lanternv1.ListSchedulesRequest) (*lanternv1.ListSchedulesResponse, error) {
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

	var schedules []*lanternv1.Schedule
	for rows.Next() {
		var (
			id, tenantIDCol, agentName, cronExpr, timezone string
			inputTemplate                                  json.RawMessage
			enabled                                        bool
			nextFireAt, lastFireAt                         *time.Time
			createdAt                                      time.Time
		)
		if err := rows.Scan(
			&id, &tenantIDCol, &agentName, &cronExpr,
			&timezone, &inputTemplate, &enabled,
			&nextFireAt, &lastFireAt, &createdAt,
		); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}

		tmpl, err := jsonToStruct(inputTemplate)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "decode input_template: %v", err)
		}

		schedules = append(schedules, &lanternv1.Schedule{
			Id:            id,
			TenantId:      tenantIDCol,
			AgentName:     agentName,
			CronExpr:      cronExpr,
			Timezone:      timezone,
			InputTemplate: tmpl,
			Enabled:       enabled,
			NextFireAt:    timestampOrNil(nextFireAt),
			LastFireAt:    timestampOrNil(lastFireAt),
			CreatedAt:     timestamppb.New(createdAt),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	return &lanternv1.ListSchedulesResponse{Schedules: schedules}, nil
}

// DeleteSchedule removes a schedule.
func (s *SchedulerService) DeleteSchedule(ctx context.Context, req *lanternv1.DeleteScheduleRequest) (*lanternv1.DeleteScheduleResponse, error) {
	ctx, span := tracer.Start(ctx, "SchedulerService.DeleteSchedule")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("schedule_id", req.ScheduleId),
	)

	if req.ScheduleId == "" {
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
	`, req.ScheduleId, tenantID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "delete failed: %v", err)
	}

	if tag.RowsAffected() == 0 {
		return nil, status.Errorf(codes.NotFound, "schedule %q not found", req.ScheduleId)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("schedule deleted",
		zap.String("tenant_id", tenantID),
		zap.String("schedule_id", req.ScheduleId),
	)

	return &lanternv1.DeleteScheduleResponse{Deleted: true}, nil
}

// Trigger creates a one-shot trigger, optionally with a delay.
func (s *SchedulerService) Trigger(ctx context.Context, req *lanternv1.TriggerRequest) (*lanternv1.TriggerResponse, error) {
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

	input, err := structToJSON(req.Input)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid input: %v", err)
	}

	// If there's a delay, create a delayed run.
	if req.DelayMs > 0 {
		fireAt := time.Now().UTC().Add(time.Duration(req.DelayMs) * time.Millisecond)

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

		return &lanternv1.TriggerResponse{
			DelayedRunId: delayedRunID,
			FireAt:       timestamppb.New(fireAt),
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

	return &lanternv1.TriggerResponse{RunId: runID}, nil
}

// structToJSON converts an optional protobuf Struct into the JSONB bytes the
// schedules/delayed_runs tables store. A nil struct becomes an empty object.
func structToJSON(s *structpb.Struct) (json.RawMessage, error) {
	if s == nil {
		return json.RawMessage("{}"), nil
	}
	b, err := s.MarshalJSON()
	if err != nil {
		return nil, err
	}
	return json.RawMessage(b), nil
}

// jsonToStruct converts JSONB bytes from the DB back into a protobuf Struct.
// Empty/NULL input yields a nil struct (omitted on the wire).
func jsonToStruct(b json.RawMessage) (*structpb.Struct, error) {
	if len(b) == 0 || string(b) == "{}" {
		return nil, nil
	}
	s := &structpb.Struct{}
	if err := s.UnmarshalJSON(b); err != nil {
		return nil, err
	}
	return s, nil
}

// timestampOrNil converts an optional time into a protobuf Timestamp.
func timestampOrNil(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}
