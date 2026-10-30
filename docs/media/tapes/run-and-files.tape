# TODO: needs (a) a published demo image — 01-hello/agent.yaml pins pal/demos/hello@sha256:000…1, which does not exist (Docker pull 404); (b) a runtime-manager with an in-guest harness (Firecracker/KVM) for `vm exec`/`ls`/`cat`; (c) a control-plane build that serves the file API — not recorded; output must come from a real run.
# Observed 2026-10-26 against :8080 (real scheduler :50055, manager :50054 Docker backend): `pal run` scheduled a VM that went `failed` (pull access denied); `vm exec` -> NotFound; `vm cat` -> 404.
Output docs/media/run-and-files.gif
Source docs/media/tapes/_settings.tape
Hide
Type "export PATH=$PWD/bin:$PATH HOME=$(mktemp -d) PAL_API_URL=localhost:8080 PAL_USE_REST=1" Enter
Type "pal login --email admin@pal.dev --password pal >/dev/null && clear" Enter
Show
Type "pal run examples/headless-agents/01-hello/agent.yaml" Enter
Sleep 3s
Type "pal vm list" Enter
Sleep 2s
# then: pal vm exec <id> -- ls /workspace ; pal vm ls <id> ; pal vm cat <id> /workspace/<file>
