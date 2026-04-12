#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# seed-data.sh -- Seed a running Lantern environment with sample data.
#
# Inserts a test tenant, three agents with versions, and sample runs in
# various states directly into Postgres. Designed to be idempotent -- safe
# to run multiple times.
#
# Usage:
#   ./scripts/seed-data.sh                     # default: localhost:5432
#   DATABASE_URL=postgres://... ./scripts/seed-data.sh
# ---------------------------------------------------------------------------

# -- Colors ----------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()    { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
success() { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error()   { printf "${RED}[ERR]${NC}   %s\n" "$*"; exit 1; }

# -- Config ----------------------------------------------------------------
DATABASE_URL="${DATABASE_URL:-postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable}"

# -- Prerequisites ---------------------------------------------------------
if ! command -v psql &>/dev/null; then
    error "psql is required but not found. Install postgresql-client and retry."
fi

info "Seeding data into ${DATABASE_URL%%@*}@<redacted>"

# -- Helper: run SQL -------------------------------------------------------
run_sql() {
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 --no-psqlrc -q -t -A "$@"
}

# -- Fixed UUIDs for idempotency -------------------------------------------
TENANT_ID="a0000000-0000-0000-0000-000000000001"
USER_ID="b0000000-0000-0000-0000-000000000001"

AGENT_RESEARCH_ID="c0000000-0000-0000-0000-000000000001"
AGENT_REVIEWER_ID="c0000000-0000-0000-0000-000000000002"
AGENT_HELLO_ID="c0000000-0000-0000-0000-000000000003"

VER_RESEARCH_1_ID="d0000000-0000-0000-0000-000000000001"
VER_RESEARCH_2_ID="d0000000-0000-0000-0000-000000000002"
VER_REVIEWER_1_ID="d0000000-0000-0000-0000-000000000003"
VER_HELLO_1_ID="d0000000-0000-0000-0000-000000000004"

RUN_1_ID="e0000000-0000-0000-0000-000000000001"
RUN_2_ID="e0000000-0000-0000-0000-000000000002"
RUN_3_ID="e0000000-0000-0000-0000-000000000003"
RUN_4_ID="e0000000-0000-0000-0000-000000000004"
RUN_5_ID="e0000000-0000-0000-0000-000000000005"

# -- Seed ------------------------------------------------------------------
info "Creating test tenant..."
run_sql <<SQL
INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
VALUES ('${TENANT_ID}', 'dev-team', 'Development Team', 'team', 'lantern-t-dev-team')
ON CONFLICT (id) DO NOTHING;
SQL
success "Tenant: dev-team (${TENANT_ID})"

info "Creating test user..."
run_sql <<SQL
INSERT INTO users (id, tenant_id, email, display_name, auth_provider, auth_subject)
VALUES ('${USER_ID}', '${TENANT_ID}', 'dev@lantern.run', 'Dev User', 'local', 'dev-local-001')
ON CONFLICT (id) DO NOTHING;
SQL
success "User: dev@lantern.run (${USER_ID})"

info "Creating agents..."
run_sql <<SQL
INSERT INTO agents (id, tenant_id, name, description, created_by, labels)
VALUES
    ('${AGENT_RESEARCH_ID}', '${TENANT_ID}', 'research-agent',
     'Autonomous research agent that searches the web, reads papers, and synthesizes findings.',
     '${USER_ID}', '{"category": "research", "tier": "premium"}'::jsonb),
    ('${AGENT_REVIEWER_ID}', '${TENANT_ID}', 'code-reviewer',
     'Reviews pull requests, leaves inline comments, and suggests improvements.',
     '${USER_ID}', '{"category": "devtools", "tier": "standard"}'::jsonb),
    ('${AGENT_HELLO_ID}', '${TENANT_ID}', 'hello-world',
     'A minimal hello-world agent for testing the platform.',
     '${USER_ID}', '{"category": "example", "tier": "free"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
SQL
success "Agents: research-agent, code-reviewer, hello-world"

info "Creating agent versions..."
run_sql <<SQL
INSERT INTO agent_versions (id, agent_id, version, digest, bundle_uri, manifest)
VALUES
    ('${VER_RESEARCH_1_ID}', '${AGENT_RESEARCH_ID}', '0.1.0',
     E'\\\\xdeadbeef01', 's3://lantern-bundles/research-agent/0.1.0.tar.gz',
     '{"entrypoint": "index.ts", "model": "reasoning-large", "tools": ["web-search", "pdf-reader"]}'::jsonb),
    ('${VER_RESEARCH_2_ID}', '${AGENT_RESEARCH_ID}', '0.2.0',
     E'\\\\xdeadbeef02', 's3://lantern-bundles/research-agent/0.2.0.tar.gz',
     '{"entrypoint": "index.ts", "model": "reasoning-large", "tools": ["web-search", "pdf-reader", "citation-formatter"]}'::jsonb),
    ('${VER_REVIEWER_1_ID}', '${AGENT_REVIEWER_ID}', '1.0.0',
     E'\\\\xdeadbeef03', 's3://lantern-bundles/code-reviewer/1.0.0.tar.gz',
     '{"entrypoint": "review.ts", "model": "auto", "tools": ["git-diff", "ast-parser"]}'::jsonb),
    ('${VER_HELLO_1_ID}', '${AGENT_HELLO_ID}', '1.0.0',
     E'\\\\xdeadbeef04', 's3://lantern-bundles/hello-world/1.0.0.tar.gz',
     '{"entrypoint": "hello.ts", "model": "fast-small"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
SQL
success "Agent versions: research-agent@0.1.0, research-agent@0.2.0, code-reviewer@1.0.0, hello-world@1.0.0"

info "Promoting current versions..."
run_sql <<SQL
UPDATE agents SET current_version_id = '${VER_RESEARCH_2_ID}' WHERE id = '${AGENT_RESEARCH_ID}' AND current_version_id IS NULL;
UPDATE agents SET current_version_id = '${VER_REVIEWER_1_ID}' WHERE id = '${AGENT_REVIEWER_ID}' AND current_version_id IS NULL;
UPDATE agents SET current_version_id = '${VER_HELLO_1_ID}'    WHERE id = '${AGENT_HELLO_ID}'    AND current_version_id IS NULL;

UPDATE agent_versions SET promoted_at = now() WHERE id IN (
    '${VER_RESEARCH_2_ID}', '${VER_REVIEWER_1_ID}', '${VER_HELLO_1_ID}'
) AND promoted_at IS NULL;
SQL
success "Promoted latest versions"

info "Creating sample runs..."
run_sql <<SQL
INSERT INTO runs (id, tenant_id, agent_id, agent_version_id, status, trigger_kind, input, output, cost_usd, tokens_in, tokens_out, started_at, finished_at)
VALUES
    -- Succeeded run for research-agent
    ('${RUN_1_ID}', '${TENANT_ID}', '${AGENT_RESEARCH_ID}', '${VER_RESEARCH_2_ID}',
     'succeeded', 'api',
     '{"query": "What are the latest advances in protein folding?"}'::jsonb,
     '{"summary": "AlphaFold 3 extended to complexes...", "sources": 12}'::jsonb,
     0.042300, 3200, 1850,
     now() - interval '2 hours', now() - interval '1 hour 55 minutes'),

    -- Running run for research-agent
    ('${RUN_2_ID}', '${TENANT_ID}', '${AGENT_RESEARCH_ID}', '${VER_RESEARCH_2_ID}',
     'running', 'api',
     '{"query": "Compare RISC-V and ARM architectures for edge ML inference"}'::jsonb,
     NULL,
     0.018700, 1500, 620,
     now() - interval '5 minutes', NULL),

    -- Succeeded run for code-reviewer
    ('${RUN_3_ID}', '${TENANT_ID}', '${AGENT_REVIEWER_ID}', '${VER_REVIEWER_1_ID}',
     'succeeded', 'webhook',
     '{"pr_url": "https://github.com/acme/app/pull/142", "repo": "acme/app"}'::jsonb,
     '{"comments": 3, "approved": true, "summary": "LGTM with minor nits"}'::jsonb,
     0.008100, 4200, 980,
     now() - interval '30 minutes', now() - interval '28 minutes'),

    -- Failed run for code-reviewer
    ('${RUN_4_ID}', '${TENANT_ID}', '${AGENT_REVIEWER_ID}', '${VER_REVIEWER_1_ID}',
     'failed', 'api',
     '{"pr_url": "https://github.com/acme/app/pull/999", "repo": "acme/app"}'::jsonb,
     NULL,
     0.001200, 800, 50,
     now() - interval '1 hour', now() - interval '59 minutes'),

    -- Queued run for hello-world
    ('${RUN_5_ID}', '${TENANT_ID}', '${AGENT_HELLO_ID}', '${VER_HELLO_1_ID}',
     'queued', 'manual',
     '{"name": "World"}'::jsonb,
     NULL,
     0, 0, 0,
     NULL, NULL)
ON CONFLICT (id) DO NOTHING;
SQL

# Add error detail for the failed run.
run_sql <<SQL
UPDATE runs
SET error = '{"code": "GITHUB_API_ERROR", "message": "PR #999 not found (404)", "step_id": "fetch-pr-diff"}'::jsonb
WHERE id = '${RUN_4_ID}' AND error IS NULL;
SQL
success "Runs: 1 succeeded (research), 1 running, 1 succeeded (reviewer), 1 failed, 1 queued"

# -- Summary ---------------------------------------------------------------
echo ""
printf "${GREEN}========================================${NC}\n"
printf "${GREEN} Seed data loaded successfully          ${NC}\n"
printf "${GREEN}========================================${NC}\n"
echo ""
info "Tenant:  dev-team (${TENANT_ID})"
info "User:    dev@lantern.run (${USER_ID})"
echo ""
info "Agents:"
info "  research-agent  -- 2 versions (0.1.0, 0.2.0), current: 0.2.0"
info "  code-reviewer   -- 1 version  (1.0.0)"
info "  hello-world     -- 1 version  (1.0.0)"
echo ""
info "Runs:"
info "  ${RUN_1_ID}  research-agent  succeeded"
info "  ${RUN_2_ID}  research-agent  running"
info "  ${RUN_3_ID}  code-reviewer   succeeded"
info "  ${RUN_4_ID}  code-reviewer   failed"
info "  ${RUN_5_ID}  hello-world     queued"
echo ""
info "Connect to Postgres:  psql '${DATABASE_URL}'"
info "List agents:          grpcurl -plaintext localhost:50051 lantern.v1.AgentService/ListAgents"
