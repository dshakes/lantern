package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// AgentService implements lanternv1.AgentServiceServer.
type AgentService struct {
	lanternv1.UnimplementedAgentServiceServer
	srv *server.Server
}

// NewAgentService creates a new AgentService handler.
func NewAgentService(srv *server.Server) *AgentService {
	return &AgentService{srv: srv}
}

func (s *AgentService) logger() *zap.Logger {
	return s.srv.Logger.Named("agent_service")
}

// setRLSTenantID sets the session variable used by Postgres RLS policies.
// The tenant ID is passed as a bound parameter to set_config to prevent
// GUC injection; true means the setting is transaction-local (SET LOCAL).
func setRLSTenantID(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID)
	return err
}

// CreateAgent inserts a new agent row and returns the Agent proto.
//
// Uses TenantPool() — the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1 (lantern_app
// role, subject to the tenant_isolation_agents policy); otherwise Pool (no change).
// The WHERE tenant_id = $1 clause is the primary correctness guard; RLS is defence-in-depth.
func (s *AgentService) CreateAgent(ctx context.Context, req *lanternv1.CreateAgentRequest) (*lanternv1.Agent, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}

	labelsJSON, err := json.Marshal(req.GetLabels())
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to marshal labels: %v", err)
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

	var (
		id        string
		createdAt time.Time
	)
	err = tx.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description, labels)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (tenant_id, name) DO UPDATE SET
			description = EXCLUDED.description,
			labels = EXCLUDED.labels,
			archived_at = NULL
		RETURNING id, created_at
	`, tenantID, req.GetName(), req.GetDescription(), labelsJSON).Scan(&id, &createdAt)
	if err != nil {
		s.logger().Error("insert agent failed", zap.Error(err), zap.String("tenant_id", tenantID))
		return nil, status.Errorf(codes.Internal, "failed to insert agent: %v", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("agent created",
		zap.String("tenant_id", tenantID),
		zap.String("agent_id", id),
		zap.String("name", req.GetName()),
	)

	return &lanternv1.Agent{
		Id:          id,
		TenantId:    tenantID,
		Name:        req.GetName(),
		Description: req.GetDescription(),
		Labels:      req.GetLabels(),
		CreatedAt:   timestamppb.New(createdAt),
	}, nil
}

// GetAgent queries an agent by (tenant_id, name).
//
// Uses TenantPool() — the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1;
// otherwise Pool (zero behaviour change).
func (s *AgentService) GetAgent(ctx context.Context, req *lanternv1.GetAgentRequest) (*lanternv1.Agent, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
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

	var (
		id               string
		description      *string
		currentVersionID *string
		createdBy        *string
		createdAt        time.Time
		archivedAt       *time.Time
		labelsJSON       []byte
	)
	err = tx.QueryRow(ctx, `
		SELECT id, description, current_version_id, created_by, created_at, archived_at, labels
		FROM agents
		WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
	`, tenantID, req.GetName()).Scan(
		&id, &description, &currentVersionID, &createdBy, &createdAt, &archivedAt, &labelsJSON,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, status.Errorf(codes.NotFound, "agent %q not found", req.GetName())
		}
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}

	agent := &lanternv1.Agent{
		Id:        id,
		TenantId:  tenantID,
		Name:      req.GetName(),
		CreatedAt: timestamppb.New(createdAt),
	}

	if description != nil {
		agent.Description = *description
	}
	if currentVersionID != nil {
		agent.CurrentVersionId = *currentVersionID
	}
	if createdBy != nil {
		agent.CreatedBy = *createdBy
	}
	if archivedAt != nil {
		agent.ArchivedAt = timestamppb.New(*archivedAt)
	}

	labels := make(map[string]string)
	if err := json.Unmarshal(labelsJSON, &labels); err != nil {
		s.logger().Warn("failed to unmarshal labels", zap.Error(err), zap.String("agent_id", id))
	}
	agent.Labels = labels

	return agent, nil
}

// ListAgents returns a paginated list of agents, optionally filtered by labels.
//
// Uses TenantPool() — the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1;
// otherwise Pool (zero behaviour change).
func (s *AgentService) ListAgents(ctx context.Context, req *lanternv1.ListAgentsRequest) (*lanternv1.ListAgentsResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	pageSize := int32(50)
	if req.GetPageSize() > 0 && req.GetPageSize() <= 100 {
		pageSize = req.GetPageSize()
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

	// Decode cursor: the page token is a base64-encoded created_at timestamp.
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

	// Build query. Label filter is applied via JSONB containment (@>).
	query := `
		SELECT id, name, description, current_version_id, created_by, created_at, labels
		FROM agents
		WHERE tenant_id = $1
		  AND archived_at IS NULL
	`
	args := []any{tenantID}
	argIdx := 2

	if len(req.GetLabelFilter()) > 0 {
		filterJSON, err := json.Marshal(req.GetLabelFilter())
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to marshal label filter: %v", err)
		}
		query += fmt.Sprintf(" AND labels @> $%d", argIdx)
		args = append(args, filterJSON)
		argIdx++
	}

	if !cursorTime.IsZero() {
		query += fmt.Sprintf(" AND created_at < $%d", argIdx)
		args = append(args, cursorTime)
		argIdx++
	}

	query += fmt.Sprintf(" ORDER BY created_at DESC LIMIT $%d", argIdx)
	args = append(args, pageSize+1) // fetch one extra to detect next page

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "query failed: %v", err)
	}
	defer rows.Close()

	var agents []*lanternv1.Agent
	for rows.Next() {
		var (
			id               string
			name             string
			description      *string
			currentVersionID *string
			createdBy        *string
			createdAt        time.Time
			labelsJSON       []byte
		)
		if err := rows.Scan(&id, &name, &description, &currentVersionID, &createdBy, &createdAt, &labelsJSON); err != nil {
			return nil, status.Errorf(codes.Internal, "scan failed: %v", err)
		}

		agent := &lanternv1.Agent{
			Id:        id,
			TenantId:  tenantID,
			Name:      name,
			CreatedAt: timestamppb.New(createdAt),
		}
		if description != nil {
			agent.Description = *description
		}
		if currentVersionID != nil {
			agent.CurrentVersionId = *currentVersionID
		}
		if createdBy != nil {
			agent.CreatedBy = *createdBy
		}

		labels := make(map[string]string)
		if err := json.Unmarshal(labelsJSON, &labels); err == nil {
			agent.Labels = labels
		}

		agents = append(agents, agent)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Errorf(codes.Internal, "row iteration failed: %v", err)
	}

	resp := &lanternv1.ListAgentsResponse{}

	// If we got more than pageSize, there's a next page.
	if int32(len(agents)) > pageSize {
		agents = agents[:pageSize]
		last := agents[len(agents)-1]
		tokenBytes, _ := last.CreatedAt.AsTime().MarshalText()
		resp.NextPageToken = base64.StdEncoding.EncodeToString(tokenBytes)
	}

	resp.Agents = agents

	// Total count (separate query for accuracy).
	var totalCount int32
	countQuery := `SELECT COUNT(*) FROM agents WHERE tenant_id = $1 AND archived_at IS NULL`
	if err := tx.QueryRow(ctx, countQuery, tenantID).Scan(&totalCount); err != nil {
		s.logger().Warn("count query failed", zap.Error(err))
	}
	resp.TotalCount = totalCount

	return resp, nil
}

// DeleteAgent soft-deletes an agent by setting archived_at.
//
// Uses TenantPool() — the RLS-enforcing pool when LANTERN_RLS_ENFORCE=1;
// otherwise Pool (zero behaviour change).
func (s *AgentService) DeleteAgent(ctx context.Context, req *lanternv1.DeleteAgentRequest) (*lanternv1.DeleteAgentResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	if req.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
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
		UPDATE agents SET archived_at = now()
		WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
	`, tenantID, req.GetName())
	if err != nil {
		return nil, status.Errorf(codes.Internal, "update failed: %v", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, status.Errorf(codes.NotFound, "agent %q not found", req.GetName())
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to commit: %v", err)
	}

	s.logger().Info("agent deleted",
		zap.String("tenant_id", tenantID),
		zap.String("name", req.GetName()),
	)

	return &lanternv1.DeleteAgentResponse{}, nil
}

// UpdateAgent is not yet implemented for the spike.
func (s *AgentService) UpdateAgent(ctx context.Context, req *lanternv1.UpdateAgentRequest) (*lanternv1.Agent, error) {
	return nil, status.Error(codes.Unimplemented, "UpdateAgent not yet implemented")
}

// CreateAgentVersion is not yet implemented for the spike.
func (s *AgentService) CreateAgentVersion(ctx context.Context, req *lanternv1.CreateAgentVersionRequest) (*lanternv1.AgentVersion, error) {
	return nil, status.Error(codes.Unimplemented, "CreateAgentVersion not yet implemented")
}

// GetAgentVersion is not yet implemented for the spike.
func (s *AgentService) GetAgentVersion(ctx context.Context, req *lanternv1.GetAgentVersionRequest) (*lanternv1.AgentVersion, error) {
	return nil, status.Error(codes.Unimplemented, "GetAgentVersion not yet implemented")
}

// ListAgentVersions is not yet implemented for the spike.
func (s *AgentService) ListAgentVersions(ctx context.Context, req *lanternv1.ListAgentVersionsRequest) (*lanternv1.ListAgentVersionsResponse, error) {
	return nil, status.Error(codes.Unimplemented, "ListAgentVersions not yet implemented")
}

// PromoteAgentVersion is not yet implemented for the spike.
func (s *AgentService) PromoteAgentVersion(ctx context.Context, req *lanternv1.PromoteAgentVersionRequest) (*lanternv1.Agent, error) {
	return nil, status.Error(codes.Unimplemented, "PromoteAgentVersion not yet implemented")
}
