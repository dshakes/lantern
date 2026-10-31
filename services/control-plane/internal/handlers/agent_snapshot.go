package handlers

// Immutable agent versions (ADR 0054). `pal deploy` updates the agent's mutable
// working copy (the "draft"); freezing it writes an agent_versions row whose
// manifest carries the executable definition (prompt, model, workflow) and whose
// digest is the SHA-256 of that definition. The run executor and the eval
// runner execute the frozen snapshot of the version a run/eval is bound to, so
// a promoted version cannot change under a canary, and eval evidence is bound
// to content rather than to a label a caller could choose.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"

	"github.com/jackc/pgx/v5"
)

type agentSnapshot struct {
	SystemPrompt string          `json:"systemPrompt,omitempty"`
	Model        string          `json:"model,omitempty"`
	Workflow     json.RawMessage `json:"workflow,omitempty"`
}

// digest hashes a canonical encoding: struct field order is fixed and the
// workflow JSON is re-encoded through a map so key order cannot change the hash.
func (s agentSnapshot) digest() []byte {
	var wf any
	if len(s.Workflow) > 0 {
		_ = json.Unmarshal(s.Workflow, &wf)
	}
	b, _ := json.Marshal(struct {
		P string `json:"p"`
		M string `json:"m"`
		W any    `json:"w"`
	}{s.SystemPrompt, s.Model, wf})
	sum := sha256.Sum256(b)
	return sum[:]
}

func (s agentSnapshot) digestHex() string { return hex.EncodeToString(s.digest()) }

// loadDraftSnapshot reads the agent's working copy (raw columns only: no
// template fallbacks, so the digest reflects exactly what is stored).
func loadDraftSnapshot(ctx context.Context, tx pgx.Tx, tenant, agent string) (agentSnapshot, string, error) {
	var s agentSnapshot
	var id string
	var prompt *string
	var wf []byte
	err := tx.QueryRow(ctx, `SELECT id::text, system_prompt, COALESCE(model,''), COALESCE(workflow,'{}'::jsonb)::text
		FROM agents WHERE tenant_id=$1 AND name=$2 AND archived_at IS NULL`, tenant, agent).Scan(&id, &prompt, &s.Model, &wf)
	if err != nil {
		return s, "", err
	}
	if prompt != nil {
		s.SystemPrompt = *prompt
	}
	if string(wf) != "{}" && len(wf) > 0 {
		s.Workflow = wf
	}
	return s, id, nil
}

// versionSnapshot returns the frozen definition of (agent, version label), or nil
// when the version predates snapshots (legacy rows execute the working copy).
func versionSnapshot(ctx context.Context, tx pgx.Tx, tenant, agent, version string) (*agentSnapshot, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT COALESCE(av.manifest->'snapshot','null'::jsonb)::text
		FROM agent_versions av JOIN agents a ON a.id = av.agent_id
		WHERE a.tenant_id=$1 AND a.name=$2 AND av.version=$3`, tenant, agent, version).Scan(&raw)
	if err != nil {
		return nil, err
	}
	return parseSnapshot(raw), nil
}

func parseSnapshot(raw []byte) *agentSnapshot {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var s agentSnapshot
	if json.Unmarshal(raw, &s) != nil {
		return nil
	}
	return &s
}

// runSnapshot is the frozen definition of the version a run is bound to (nil = legacy).
// agent_versions is RLS-exempt; the run id comes from an already-authorized run.
func (h *RESTHandler) runSnapshot(ctx context.Context, runID string) *agentSnapshot {
	var raw []byte
	// rls-exempt: inline executor — agent_versions has no tenant_id; reached through an authorized run id.
	if err := h.srv.Pool.QueryRow(ctx, `SELECT COALESCE(av.manifest->'snapshot','null'::jsonb)::text
		FROM runs r JOIN agent_versions av ON av.id = r.agent_version_id WHERE r.id::text = $1`, runID).Scan(&raw); err != nil {
		return nil
	}
	return parseSnapshot(raw)
}

var versionLabelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$`)

// CreateVersion handles POST /v1/agents/{name}/versions {label?}: freeze the
// working copy. Idempotent by content: the same definition returns the existing
// version (created:false). It never changes which version serves traffic.
func (h *PromotionHandler) CreateVersion(w http.ResponseWriter, r *http.Request) {
	ctx, tenant, a, code := h.actorFrom(r)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": http.StatusText(code)})
		return
	}
	agent := r.PathValue("name")
	var req struct {
		Label string `json:"label"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req)
	if req.Label != "" && !versionLabelRe.MatchString(req.Label) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "label must match " + versionLabelRe.String()})
		return
	}
	var version string
	var created bool
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		snap, agentID, err := loadDraftSnapshot(ctx, tx, tenant, agent)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		if snap.SystemPrompt == "" && len(snap.Workflow) == 0 {
			return fmt.Errorf("%w: agent has no system prompt or workflow to freeze (template-backed agents must be given an explicit prompt first)", errConflict)
		}
		dg := snap.digest()
		// Serialize concurrent freezes of one agent.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM agents WHERE id::text=$1 FOR UPDATE`, agentID); err != nil {
			return err
		}
		err = tx.QueryRow(ctx, `SELECT version FROM agent_versions WHERE agent_id::text=$1 AND digest=$2`, agentID, dg).Scan(&version)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if req.Label == "" {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_versions WHERE agent_id::text=$1`, agentID).Scan(&n); err != nil {
				return err
			}
			req.Label = fmt.Sprintf("v%d", n+1)
		}
		man, _ := json.Marshal(map[string]any{"snapshot": snap, "frozenBy": a.ID})
		if _, err := tx.Exec(ctx, `INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
			VALUES ($1::uuid,$2,$3,'snapshot://inline',$4::jsonb)`, agentID, req.Label, dg, string(man)); err != nil {
			var pe interface{ SQLState() string }
			if errors.As(err, &pe) && pe.SQLState() == "23505" {
				return fmt.Errorf("%w: version label %q already exists with different content", errConflict, req.Label)
			}
			return err
		}
		version, created = req.Label, true
		return h.audit(ctx, tx, tenant, agent, "", "", a, "version_frozen", map[string]any{"version": version, "digest": snap.digestHex()})
	})
	if err != nil {
		h.fail(w, err)
		return
	}
	st := http.StatusOK
	if created {
		st = http.StatusCreated
	}
	writeJSON(w, st, map[string]any{"agentName": agent, "version": version, "created": created})
}
