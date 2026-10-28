#!/usr/bin/env bash
# check-app-grants.sh -- fail if the RLS role `lantern_app` lacks the table grants the
# control-plane and workflow-engine need. Missing grants don't restrict rows, they fail
# ordinary work with permission errors once LANTERN_RLS_ENFORCE=1 (CLAUDE.md, "Workflow-engine RLS").
#
#   DATABASE_URL=postgres://lantern:...@host/lantern scripts/check-app-grants.sh
#
# step_state is created by the workflow-engine's own migrations, so it is only checked when it exists.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL (superuser/owner connection)}"

missing="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtAX <<'SQL'
SELECT t.name || ' lacks ' || p.priv
FROM (VALUES ('agents'), ('runs'), ('journal_events'), ('run_locks'), ('step_state')) AS t(name)
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
WHERE (to_regclass('public.' || t.name) IS NOT NULL OR t.name <> 'step_state')
  AND NOT COALESCE(has_table_privilege('lantern_app', 'public.' || t.name, p.priv), false)
ORDER BY 1;
SQL
)"
if [ -n "$missing" ]; then
  echo "lantern_app grant check FAILED:" >&2
  echo "$missing" >&2
  exit 1
fi
echo "lantern_app grant check: ok"
