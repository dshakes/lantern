# lantern CLI

The `lantern` command-line tool for [Lantern](https://github.com/dshakes/lantern) — the open-source runtime for production AI agents.

```bash
# macOS / Linux
curl -fsSL https://get.lantern.run | sh

# Or from source (the binary's main package lives at cmd/lantern)
go install github.com/dshakes/lantern/packages/cli/cmd/lantern@latest
```

## Common commands

```bash
lantern login                        # authenticate against api.lantern.run (or --api-url)
lantern init my-agent                # scaffold a new agent project
lantern dev                          # boot Postgres + Redis + MinIO + control-plane locally

lantern agents list                  # list agents for the current tenant
lantern agents create --name triage
lantern agents delete triage

lantern runs create --agent=triage --input='{"email":"..."}'
lantern runs list --agent=triage
lantern logs --run=<id> -f           # tail the SSE event stream for a run

lantern test --agent=triage --suite=golden --against=last-green
#   Executes the suite locally, posts results to POST /v1/eval-runs.
#   Exits non-zero on regression so CI blocks the merge.
#   --set-baseline pins this run as the new baseline for the current branch.

lantern deploy --agent=triage --env=production
#   One-click managed-cloud deploy, or data-plane deploy if --data-plane=<id>.
```

## Flags

| Flag | Env | Purpose |
|---|---|---|
| `--api-url` | `LANTERN_API_URL` | Control-plane address (gRPC `:50051` by default, REST `:8080` with `--rest`) |
| `--api-key` | `LANTERN_API_KEY` | API key; falls back to token stored by `lantern login` |
| `--tenant-id` | `LANTERN_TENANT_ID` | Override tenant (multi-tenant enterprise accounts) |
| `-o, --output` | — | `text` (default) or `json` |
| `--rest` | `LANTERN_USE_REST` | Force REST transport instead of gRPC |

## Eval-in-CI example

```yaml
# .github/workflows/agent-ci.yml
- run: lantern test --agent=triage --suite=golden --against=last-green
  env:
    LANTERN_API_KEY: ${{ secrets.LANTERN_API_KEY }}
```

On a regression, the control plane returns HTTP 422 and the CLI exits non-zero — so your pre-merge check fails. Pin a new baseline once a PR lands:

```bash
lantern test --agent=triage --suite=golden --set-baseline
```

## Local development

```bash
lantern dev                # docker-compose up: postgres + redis + minio + control-plane
# visit http://localhost:3000 — admin@lantern.dev / lantern
```

`lantern dev` is a convenience wrapper over `make dev`. Stop with `Ctrl+C`; volumes persist across restarts.

## License

Apache 2.0.
