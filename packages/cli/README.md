# pal CLI

The `pal` command-line tool for [PAL Runtime](https://github.com/dshakes/pal) — the open-source runtime for production AI agents.

Config lives in `$PAL_HOME`, else `~/.pal`.

```bash
# macOS / Linux (Homebrew)
brew install dshakes/tap/pal

# Or from source (the binary's main package lives at cmd/pal)
go install github.com/dshakes/pal/packages/cli/cmd/pal@latest
```

## Common commands

```bash
pal login                        # authenticate against api.pal.run (or --api-url)
pal init my-agent                # scaffold a new agent project
pal dev                          # boot Postgres + Redis + MinIO + control-plane locally

pal agents list                  # list agents for the current tenant
pal agents create --name triage
pal agents delete triage

pal runs create --agent=triage --input='{"email":"..."}'
pal runs list --agent=triage
pal logs --run=<id> -f           # tail the SSE event stream for a run

pal test --agent=triage --suite=golden --against=last-green
#   Executes the suite locally, posts results to POST /v1/eval-runs.
#   Exits non-zero on regression so CI blocks the merge.
#   --set-baseline pins this run as the new baseline for the current branch.

pal deploy [--dry-run] [--json]
#   Reads ./agent.yaml, creates/updates the agent, then POST /v1/agents/{name}/deploy.
#   Exit codes: 3 auth, 4 quota/budget (402), 5 not found, 6 server error.
```

## Flags

| Flag | Env | Purpose |
|---|---|---|
| `--api-url` | `PAL_API_URL` | Control-plane address (gRPC `:50051` by default, REST `:8080` with `--rest`) |
| `--api-key` | `PAL_API_KEY` | API key; falls back to token stored by `pal login` |
| `--tenant-id` | `PAL_TENANT_ID` | Override tenant (multi-tenant enterprise accounts) |
| `-o, --output` | — | `text` (default) or `json` |
| `--rest` | `PAL_USE_REST` | Force REST transport instead of gRPC |

## Eval-in-CI example

```yaml
# .github/workflows/agent-ci.yml
- run: pal test --agent=triage --suite=golden --against=last-green
  env:
    PAL_API_KEY: ${{ secrets.PAL_API_KEY }}
```

On a regression, the control plane returns HTTP 422 and the CLI exits non-zero — so your pre-merge check fails. Pin a new baseline once a PR lands:

```bash
pal test --agent=triage --suite=golden --set-baseline
```

## Local development

```bash
pal dev                # docker-compose up: postgres + redis + minio + control-plane
# visit http://localhost:3000 — admin@pal.dev / pal
```

`pal dev` is a convenience wrapper over `make dev`. Stop with `Ctrl+C`; volumes persist across restarts.

## License

Apache 2.0.
