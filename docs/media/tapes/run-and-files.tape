# TODO: needs (a) a published demo image — 01-hello/agent.yaml pins lantern/demos/hello@sha256:000…1, which does not exist (Docker pull 404); (b) a runtime-manager with an in-guest harness (Firecracker/KVM) for `vm exec`/`ls`/`cat`; (c) a control-plane build that serves the file API — not recorded; output must come from a real run.
# Observed 2026-10-26 against :8080 (real scheduler :50055, manager :50054 Docker backend): `lantern run` scheduled a VM that went `failed` (pull access denied); `vm exec` -> NotFound; `vm cat` -> 404.
Output docs/media/run-and-files.gif
Source docs/media/tapes/_settings.tape
Hide
Type "export PATH=$PWD/bin:$PATH HOME=$(mktemp -d) LANTERN_API_URL=localhost:8080 LANTERN_USE_REST=1" Enter
Type "lantern login --email admin@lantern.dev --password lantern >/dev/null && clear" Enter
Show
Type "lantern run examples/headless-agents/01-hello/agent.yaml" Enter
Sleep 3s
Type "lantern vm list" Enter
Sleep 2s
# then: lantern vm exec <id> -- ls /workspace ; lantern vm ls <id> ; lantern vm cat <id> /workspace/<file>
