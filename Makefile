.PHONY: demo demo-down test-e2e-examples test-e2e-analyst help lima-up lima-image lima-e2e lima-broker-e2e lima-measurement-e2e lima-down lima-clean dev build test check-launchd-env deploy-local test-db test-e2e test-e2e-llm e2e-clean e2e-lint smoke-dataplane loadtest-runs validate-docs-live lint slo-rules ci-local clean proto local-dev local-kind k8s-validate validate-cluster rls-validate seed docker-build run-scheduler run-runtime-manager run-api-runtime bridge-setup

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Auto-load .env.local for run-* targets. Keeps secrets (GOOGLE_CLIENT_ID,
# OAUTH_CLIENT_ID_*, third-party tokens) out of the Makefile + out of the
# shell history. The file is .gitignored — see .gitignore.
ifneq (,$(wildcard .env.local))
include .env.local
export
endif

# ---------- Dev ----------

dev: ## Start the full dev stack (Postgres, Redis, MinIO, services)
	docker compose -f infra/docker/docker-compose.yml up --build

# Kiosk demo (ADR 0029): full stack, ephemeral workspaces, recorded LLM answers.
demo:
	KIOSK_JWT_SECRET=$${KIOSK_JWT_SECRET:-$$(openssl rand -hex 32)} docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.kiosk.yml -p pal-demo up -d --build postgres redis control-plane dashboard llm-replay
	@echo "demo: http://localhost:3001/kiosk"

demo-down:
	KIOSK_JWT_SECRET=unused-for-down docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.kiosk.yml -p pal-demo down -v

dev-infra: ## Start only infrastructure (Postgres, Redis; no MinIO)
	docker compose -f infra/docker/docker-compose.yml up -d postgres redis

dev-doctor: ## Health-check every service + infra (run this when things feel weird)
	@bash scripts/dev-doctor.sh

check-launchd-env: ## Verify LaunchAgent plists carry the wiring their services need
	@bash scripts/launchd/check-env-drift.sh

whatsapp-reset: ## Nuclear reset for stuck WhatsApp 'Waiting for this message' loops
	@bash scripts/whatsapp-nuclear-reset.sh

run-api: ## Run the control-plane API server locally
	@bash scripts/kill-port.sh 8080 50051
	if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi; \
	cd services/control-plane && \
	DATABASE_URL="postgres://pal:pal@localhost:5432/pal?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
	S3_ENDPOINT="http://localhost:9000" \
	LOG_LEVEL="debug" \
	go run ./cmd/server

run-scheduler: ## Run the runtime-scheduler locally on :50055 (gRPC) and :8085 (REST)
	@bash scripts/kill-port.sh 50055 8085
	. scripts/launchd/service-env.sh; \
	cd services/runtime-scheduler && \
	LOG_LEVEL="debug" \
	go run ./cmd/scheduler

run-runtime-manager: ## Run the Rust runtime-manager locally on :50054 (Docker backend)
	@bash scripts/kill-port.sh 50054
	. scripts/launchd/service-env.sh; \
	cd services/runtime-manager && \
	LISTEN_ADDR="0.0.0.0:50054" \
	RUNTIME_BACKEND="docker" \
	LOG_LEVEL="debug" \
	cargo run

run-api-runtime: ## Run the control-plane API wired to the real runtime-scheduler at :50055
	@bash scripts/kill-port.sh 8080 50051
	. scripts/launchd/service-env.sh; \
	cd services/control-plane && \
	DATABASE_URL="postgres://pal:pal@localhost:5432/pal?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
	S3_ENDPOINT="http://localhost:9000" \
	LOG_LEVEL="debug" \
	go run ./cmd/server

run-api-free: ## Run the API but route LLM calls through local `claude` CLI ($0 — uses Claude Max subscription)
	@bash scripts/kill-port.sh 8080 50051
	cd services/control-plane && \
	DATABASE_URL="postgres://pal:pal@localhost:5432/pal?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
	S3_ENDPOINT="http://localhost:9000" \
	LOG_LEVEL="debug" \
	PAL_USE_CLAUDE_CODE=1 \
	go run ./cmd/server

bridge-setup: ## Interactive setup wizard for the personal-assistant bridges (WhatsApp / iMessage)
	@bash scripts/bridge-setup.sh

run-whatsapp-bridge: ## Start the WhatsApp bridge service
	@bash scripts/kill-port.sh 3100
	cd services/whatsapp-bridge && npm install --no-audit --no-fund && npm run dev

run-whatsapp: run-whatsapp-bridge ## Alias: start the WhatsApp bridge service

run-imessage-bridge: ## Start the iMessage bridge (macOS only)
	@bash scripts/kill-port.sh 3200
	cd services/imessage-bridge && npm install --no-audit --no-fund && npm run dev

run-imessage: run-imessage-bridge ## Alias: start the iMessage bridge

autostart-install: ## Install PAL Runtime as macOS LaunchAgents (auto-start at login, auto-restart on crash)
	@bash scripts/launchd/install.sh

autostart-uninstall: ## Remove all PAL Runtime LaunchAgents
	@bash scripts/launchd/install.sh --uninstall

autostart-status: ## Show currently-loaded PAL Runtime LaunchAgents + recent log lines
	@launchctl list | grep -iE "dev\.pal" || echo "(no PAL launchagents loaded — run 'make autostart-install')"
	@echo ""
	@for s in infra api dashboard whatsapp-bridge imessage-bridge; do \
		echo "—— $$s last 3 lines ——"; \
		tail -3 "$$HOME/Library/Logs/PAL/$$s.err.log" 2>/dev/null || echo "(no log yet)"; \
	done

regression: ## Run the full alpha-readiness regression test suite
	@bash scripts/regression.sh

regression-quiet: ## Same but only print failures (good for cron)
	@bash scripts/regression.sh --quiet

site-dev: ## Start the website (Astro + Starlight) in dev mode
	cd site && npm run dev


deploy-local: ## Make the running LaunchAgents match origin/master and PROVE it (FORCE=1 restarts all)
	@bash scripts/launchd/deploy-local.sh

dashboard-dev: ## Start the dashboard in dev mode
	@bash scripts/kill-port.sh 3001
	cd apps/web && npm run dev

local-dev: ## One-command local dev setup (docker-compose)
	./scripts/local-dev.sh docker

local-kind: ## Set up a local Kind cluster with Helm
	./scripts/local-dev.sh kind

k8s-validate: ## Validate K8s Job isolation end-to-end on a throwaway kind cluster (Calico-enforced default-deny + seccomp + cap-drop)
	@bash infra/k8s/validate.sh

validate-cluster: ## Run gVisor/Kata cluster validation against KUBECONFIG=<path> (operator harness; closes README "live Kata" gap)
	@bash scripts/validate-cluster.sh

seed: ## Seed sample data into running services
	./scripts/seed-data.sh

# ---------- Build ----------

build: build-go build-rust build-ts ## Build everything

build-go: ## Build Go services
	cd services/control-plane && go build -o ../../bin/control-plane ./cmd/server

build-rust: ## Build Rust services
	cd services/gateway && cargo build --release
	cd services/model-router && cargo build --release
	cd services/runtime-manager && cargo build --release

build-ts: ## Build TypeScript packages
	cd packages/sdk-ts && npm run build
	cd site && npm run build
	cd apps/web && npm run build

docker-build: ## Build all Docker images
	docker build -t pal-control-plane -f services/control-plane/Dockerfile .
	docker build -t pal-gateway -f services/gateway/Dockerfile .
	docker build -t pal-model-router -f services/model-router/Dockerfile .
	docker build -t pal-workflow-engine -f services/workflow-engine/Dockerfile .
	docker build -t pal-web apps/web
	
# ---------- Proto ----------

proto: ## Regenerate code from proto definitions
	@echo "Generating Go code..."
	protoc --proto_path=packages/proto \
		--go_out=gen/go --go_opt=paths=source_relative \
		--go-grpc_out=gen/go --go-grpc_opt=paths=source_relative \
		packages/proto/pal/v1/*.proto
	@echo "Generating TypeScript types..."
	npx ts-proto --out=gen/ts packages/proto/pal/v1/*.proto
	@echo "Done."

# ---------- Test ----------

test: test-go test-rust test-ts test-python ## Run all tests

test-go: ## Run Go tests
	cd services/control-plane && go test -race -count=1 ./...
	cd services/workflow-engine && go test -race -count=1 ./...
	cd services/scheduler && go test -race -count=1 ./...
	cd services/runtime-scheduler && CGO_ENABLED=0 go test ./...

test-rust: ## Run Rust tests
	cd services/gateway && cargo test
	cd services/model-router && cargo test
	cd services/runtime-manager && cargo test

test-ts: ## Run TypeScript tests
	cd packages/sdk-ts && npx vitest run
	cd packages/bridge-core && npm test

test-python: ## Run Python tests
	cd packages/sdk-python && python3 -m pytest tests/ -v

test-e2e: ## Run live-stack e2e suites (FAILS when stack is down; set E2E_ALLOW_SKIP=1 to skip instead). Set PAL_E2E_API_URL or PAL_API_URL to target a non-default stack — see e2e/README.md
	$(MAKE) e2e-lint
	cd e2e/runtime && go test -tags e2e -count=1 -v ./...
	cd e2e/quickstart && go test -tags e2e -count=1 -p 1 -v ./...
	cd e2e/examples && go test -tags e2e -count=1 -p 1 -v ./...
	cd e2e/deploy && go test -tags e2e -count=1 -v ./...

test-e2e-examples: ## All fixture-tier examples (support desk, PR triage, incident, digest, Telegram, voice) on a throwaway stack - no keys, own DB
	bash scripts/e2e-examples.sh

test-e2e-analyst: ## Data-analyst sandbox example; needs a runtime stack (scheduler + manager) - see examples/data-analyst/README.md
	cd e2e/examples && go test -tags e2e -count=1 -v -run TestDataAnalystSandbox ./...

test-e2e-llm: ## Alias for test-e2e (real-LLM e2e suite under §0 spend caps)
	$(MAKE) test-e2e

e2e-clean: ## Delete all e2e-* agents from the dev tenant (manual recovery after interrupted runs)
	cd e2e/internal/e2ekit && go run ./cmd/sweep

e2e-lint: ## Grep-check that /v1/budgets/tenant is never called from e2e/ (§0 invariant)
	@if grep -rn '"/v1/budgets/tenant' e2e/ 2>/dev/null; then \
	  echo "ERROR: e2e/ must never call /v1/budgets/tenant (§0 spend policy)"; exit 1; \
	fi
	@echo "e2e-lint OK: no call to /v1/budgets/tenant in e2e/"

smoke-dataplane: ## Live two-process proof: boots the real control-plane + data-plane-agent binaries and routes a run to the plane over the tunnel
	@bash scripts/e2e-dataplane-smoke.sh

loadtest-runs: ## Basic concurrency load test: fire N run-creates at concurrency C against a freshly-booted control-plane (N=120 C=24 by default)
	@bash scripts/loadtest-runs.sh

validate-docs-live: ## Hit every deployed docs route on GitHub Pages and assert 200 + real content
	@bash scripts/validate-docs-live.sh

test-db: ## Start dev Postgres if needed, then run Go tests that require a live DB
	@echo "==> Ensuring Postgres is up..."
	@docker compose -f infra/docker/docker-compose.yml up -d postgres minio-init redis || true
	@echo "==> Waiting for Postgres to be ready (up to 30s)..."
	@for i in $$(seq 1 30); do \
		docker compose -f infra/docker/docker-compose.yml exec -T postgres \
			pg_isready -U pal -d pal -q 2>/dev/null && break; \
		echo "  attempt $$i/30 — not ready yet"; sleep 1; \
	done
	@docker compose -f infra/docker/docker-compose.yml exec -T postgres \
		pg_isready -U pal -d pal -q || (echo "ERROR: Postgres never became ready" && exit 1)
	@echo "==> Running Go tests with DATABASE_URL..."
	cd services/control-plane && \
		DATABASE_URL="postgres://pal:pal@localhost:5432/pal?sslmode=disable" \
		go test -race -count=1 ./...
	cd services/runtime-scheduler && \
		DATABASE_URL="postgres://pal:pal@localhost:5432/pal?sslmode=disable" \
		go test -race -count=1 ./...

rls-validate: ## Validate RLS policies + handler cutover before flipping PAL_RLS_ENFORCE=1
	@bash scripts/rls-validate.sh

# ---------- Lint ----------

lint: lint-go lint-rust lint-ts ## Lint everything
	bash scripts/brand-check.sh --enforce

lint-go: ## Lint Go code (same modules as CI sdlc-lint)
	cd services/control-plane && golangci-lint run ./...
	cd services/workflow-engine && golangci-lint run ./...
	cd services/runtime-scheduler && golangci-lint run ./...
	cd services/scheduler && golangci-lint run ./...

lint-rust: lint-rust-fmt ## Lint Rust code
	cd services/gateway && cargo clippy -- -D warnings
	cd services/model-router && cargo clippy -- -D warnings
	cd services/runtime-manager && cargo clippy -- -D warnings
	cd services/surface-gateway && cargo clippy -- -D warnings
	cd services/harness && cargo clippy -- -D warnings

lint-rust-fmt: ## Check rustfmt on every Rust crate (matches CI sdlc-lint)
	@fail=0; for m in services/*/Cargo.toml packages/*/Cargo.toml; do \
		cargo fmt --manifest-path $$m --check || { \
			echo "  ↳ fix with: cargo fmt --manifest-path $$m"; fail=1; }; \
	done; exit $$fail

fmt-rust: ## Format every Rust crate in place
	@for m in services/*/Cargo.toml packages/*/Cargo.toml; do cargo fmt --manifest-path $$m; done

lint-ts: ## Lint TypeScript code
	cd packages/sdk-ts && npm run lint
	cd services/whatsapp-bridge && npm run typecheck
	cd services/imessage-bridge && npm run typecheck

# ---------- Security ----------

audit: ## Run security audits on all dependencies
	cd services/control-plane && govulncheck ./...
	cd services/gateway && cargo audit
	cd services/model-router && cargo audit
	cd services/runtime-manager && cargo audit
	cd packages/sdk-ts && npm audit --omit=dev  # production deps only — dev-tool advisories (vitest/esbuild) aren't shipped

# ---------- Firecracker on a Mac (Lima, M3+ / macOS 15+) ----------

lima-up: ## Create/start the firecracker-dev Lima VM; verify /dev/kvm + firecracker + jailer
	@bash infra/lima/lima.sh up

lima-image: ## Build the microVM kernel + rootfs (harness as PID 1) inside the VM, cached
	@bash infra/lima/lima.sh image

lima-e2e: ## Real Firecracker lifecycle e2e (jailed, mTLS VendSecret) inside the VM + timing table
	@bash infra/lima/lima.sh e2e

lima-broker-e2e: ## Broker egress mode (ADR 0026) e2e inside the VM
	@bash infra/lima/lima.sh broker-e2e

lima-measurement-e2e: ## Software measurement (ADR 0031) e2e inside the VM: reproducible, enforce, resume/fork
	@bash infra/lima/lima.sh measurement-e2e

lima-runtime: ## Long-running jailed Firecracker runtime-manager in the VM on :52054 for `dev` (foreground)
	@bash infra/lima/lima.sh runtime

lima-down: ## Stop the firecracker-dev VM
	@bash infra/lima/lima.sh down

lima-clean: ## Drop the VM's cached cargo target + microVM image
	@bash infra/lima/lima.sh clean

# ---------- CI ----------

slo-rules: ## Render + promtool check/test the SLO PrometheusRule (needs helm, promtool, PyYAML)
	infra/monitoring/prometheus/check-slo-rules.sh

ci-local: lint test audit ## Run the same checks as CI, locally
	@echo "All CI checks passed."

# ---------- Clean ----------

clean: ## Remove build artifacts
	rm -rf bin/ gen/ dist/
	docker compose -f infra/docker/docker-compose.yml down -v
