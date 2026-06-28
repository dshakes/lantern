package handlers

// GET /v1/usage — accurate spend + run-health for the Lantern dashboard.
//
// Two sources by design:
//   - cost + tokens  → agent_usage_daily (authoritative; includes bridge /
//     agentless spend that never touches the runs table)
//   - run status counts → runs table (has the per-status breakdown)
//
// We aggregate both inside a single WithTenant transaction so the GUC is set
// once and RLS applies to every query in the block.

import (
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// UsageHandler serves GET /v1/usage.
type UsageHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewUsageHandler constructs a UsageHandler.
func NewUsageHandler(srv *server.Server, auth *AuthHandler) *UsageHandler {
	return &UsageHandler{srv: srv, auth: auth}
}

func (h *UsageHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("usage")
}

// periodMetrics is one bucket in the "periods" map.
type periodMetrics struct {
	CostUsd   float64 `json:"costUsd"`
	Runs      int64   `json:"runs"`
	Succeeded int64   `json:"succeeded"`
	Failed    int64   `json:"failed"`
	Running   int64   `json:"running"`
	TokensIn  int64   `json:"tokensIn"`
	TokensOut int64   `json:"tokensOut"`
}

// agentMetrics is one row in the "byAgent" list.
type agentMetrics struct {
	AgentName string  `json:"agentName"`
	CostUsd   float64 `json:"costUsd"`
	Runs      int64   `json:"runs"`
	Succeeded int64   `json:"succeeded"`
	Failed    int64   `json:"failed"`
}

// usageResponse is the wire shape of GET /v1/usage.
type usageResponse struct {
	Periods map[string]periodMetrics `json:"periods"`
	ByAgent []agentMetrics           `json:"byAgent"`
}

// GetUsage handles GET /v1/usage.
func (h *UsageHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	now := time.Now().UTC()
	todayStr := now.Format("2006-01-02")
	weekStr := now.AddDate(0, 0, -6).Format("2006-01-02")
	monthStr := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).Format("2006-01-02")

	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	weekStart := todayStart.AddDate(0, 0, -6)
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)

	resp := usageResponse{
		Periods: make(map[string]periodMetrics),
		ByAgent: []agentMetrics{},
	}

	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		// dailyCost aggregates agent_usage_daily.
		// since / until are YYYY-MM-DD strings; "" means unbounded on that end.
		dailyCost := func(since, until string) (cost float64, tokIn, tokOut int64, e error) {
			q := `SELECT COALESCE(SUM(cost_usd)::float8,0),
			             COALESCE(SUM(tokens_in),0),
			             COALESCE(SUM(tokens_out),0)
			      FROM agent_usage_daily WHERE tenant_id=$1`
			args := []any{tenantID}
			if since != "" {
				args = append(args, since)
				q += fmt.Sprintf(" AND usage_date>=$%d", len(args))
			}
			if until != "" {
				args = append(args, until)
				q += fmt.Sprintf(" AND usage_date<=$%d", len(args))
			}
			e = tx.QueryRow(ctx, q, args...).Scan(&cost, &tokIn, &tokOut)
			return
		}

		// runCounts aggregates the runs table.
		// since: nil → all-time; non-nil → runs created at or after that time.
		runCounts := func(since *time.Time) (total, succeeded, failed, running int64, e error) {
			q := `SELECT COUNT(*),
			             COUNT(*) FILTER (WHERE status='succeeded'),
			             COUNT(*) FILTER (WHERE status='failed'),
			             COUNT(*) FILTER (WHERE status='running')
			      FROM runs WHERE tenant_id=$1`
			args := []any{tenantID}
			if since != nil {
				args = append(args, *since)
				q += fmt.Sprintf(" AND created_at>=$%d", len(args))
			}
			e = tx.QueryRow(ctx, q, args...).Scan(&total, &succeeded, &failed, &running)
			return
		}

		fill := func(key, since, until string, rs *time.Time) error {
			cost, ti, to, err := dailyCost(since, until)
			if err != nil {
				return fmt.Errorf("dailyCost(%s): %w", key, err)
			}
			rt, rs2, rf, rr, err := runCounts(rs)
			if err != nil {
				return fmt.Errorf("runCounts(%s): %w", key, err)
			}
			resp.Periods[key] = periodMetrics{
				CostUsd: cost, TokensIn: ti, TokensOut: to,
				Runs: rt, Succeeded: rs2, Failed: rf, Running: rr,
			}
			return nil
		}

		if err := fill("today", todayStr, todayStr, &todayStart); err != nil {
			return err
		}
		if err := fill("week", weekStr, "", &weekStart); err != nil {
			return err
		}
		if err := fill("month", monthStr, "", &monthStart); err != nil {
			return err
		}
		if err := fill("total", "", "", nil); err != nil {
			return err
		}

		// ---- byAgent (ordered by total cost desc, capped at 20 agents) ----
		// ponytail: agents with $0 cost won't appear; add when needed.

		type agCost struct {
			cost float64
			// runs_count from the daily rollup (less accurate than runs table,
			// used only to drive the merge order here — the merge below takes
			// run counts from runs JOIN agents instead).
		}
		costMap := make(map[string]agCost)
		var orderedNames []string

		rows, err := tx.Query(ctx, `
			SELECT agent_name, COALESCE(SUM(cost_usd)::float8,0)
			FROM agent_usage_daily WHERE tenant_id=$1
			GROUP BY agent_name ORDER BY SUM(cost_usd) DESC LIMIT 20
		`, tenantID)
		if err != nil {
			return fmt.Errorf("byAgent cost: %w", err)
		}
		for rows.Next() {
			var name string
			var c agCost
			if scanErr := rows.Scan(&name, &c.cost); scanErr != nil {
				continue
			}
			costMap[name] = c
			orderedNames = append(orderedNames, name)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("byAgent cost rows: %w", err)
		}

		type agStatus struct{ total, succeeded, failed int64 }
		statusMap := make(map[string]agStatus)

		rows2, err := tx.Query(ctx, `
			SELECT a.name,
			       COUNT(*),
			       COUNT(*) FILTER (WHERE r.status='succeeded'),
			       COUNT(*) FILTER (WHERE r.status='failed')
			FROM runs r
			JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
			WHERE r.tenant_id=$1
			GROUP BY a.name
		`, tenantID)
		if err != nil {
			return fmt.Errorf("byAgent status: %w", err)
		}
		for rows2.Next() {
			var name string
			var s agStatus
			if scanErr := rows2.Scan(&name, &s.total, &s.succeeded, &s.failed); scanErr != nil {
				continue
			}
			statusMap[name] = s
		}
		rows2.Close()
		if err := rows2.Err(); err != nil {
			return fmt.Errorf("byAgent status rows: %w", err)
		}

		for _, name := range orderedNames {
			s := statusMap[name]
			resp.ByAgent = append(resp.ByAgent, agentMetrics{
				AgentName: name,
				CostUsd:   costMap[name].cost,
				Runs:      s.total,
				Succeeded: s.succeeded,
				Failed:    s.failed,
			})
		}

		return nil
	})
	if err != nil {
		h.logger().Error("GetUsage failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load usage"})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
