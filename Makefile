.PHONY: help dev build test test-db test-e2e lint ci-local clean proto local-dev local-kind k8s-validate seed docker-build run-scheduler run-runtime-manager run-api-runtime bridge-setup

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

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

dev-infra: ## Start only infrastructure (Postgres, Redis, MinIO)
	docker compose -f infra/docker/docker-compose.yml up -d postgres redis minio minio-init

dev-doctor: ## Health-check every service + infra (run this when things feel weird)
	@bash scripts/dev-doctor.sh

whatsapp-reset: ## Nuclear reset for stuck WhatsApp 'Waiting for this message' loops
	@bash scripts/whatsapp-nuclear-reset.sh

run-api: ## Run the control-plane API server locally
	@bash scripts/kill-port.sh 8080 50051
	if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi; \
	cd services/control-plane && \
	DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
	S3_ENDPOINT="http://localhost:9000" \
	LOG_LEVEL="debug" \
	go run ./cmd/server

run-scheduler: ## Run the runtime-scheduler locally on :50055 (gRPC) and :8085 (REST)
	@bash scripts/kill-port.sh 50055 8085
	cd services/runtime-scheduler && \
	LANTERN_DEFAULT_MANAGER_ADDR="localhost:50054" \
	JWT_SECRET="lantern-dev-jwt-secret-do-not-use-in-production" \
	LOG_LEVEL="debug" \
	go run ./cmd/scheduler

run-runtime-manager: ## Run the Rust runtime-manager locally on :50054 (Docker backend)
	@bash scripts/kill-port.sh 50054
	cd services/runtime-manager && \
	LISTEN_ADDR="0.0.0.0:50054" \
	RUNTIME_BACKEND="docker" \
	LOG_LEVEL="debug" \
	cargo run

run-api-runtime: ## Run the control-plane API wired to the real runtime-scheduler at :50055
	@bash scripts/kill-port.sh 8080 50051
	cd services/control-plane && \
	DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
	S3_ENDPOINT="http://localhost:9000" \
	LOG_LEVEL="debug" \
	LANTERN_SCHEDULER_GRPC_ADDR="localhost:50055" \
	go run ./cmd/server

run-api-free: ## Run the API but route LLM calls through local `claude` CLI ($0 — uses Claude Max subscription)
	@bash scripts/kill-port.sh 8080 50051
	cd services/control-plane && \
	DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
	S3_ENDPOINT="http://localhost:9000" \
	LOG_LEVEL="debug" \
	LANTERN_USE_CLAUDE_CODE=1 \
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

autostart-install: ## Install Lantern as macOS LaunchAgents (auto-start at login, auto-restart on crash)
	@bash scripts/launchd/install.sh

autostart-uninstall: ## Remove all Lantern LaunchAgents
	@bash scripts/launchd/install.sh --uninstall

autostart-status: ## Show currently-loaded Lantern LaunchAgents + recent log lines
	@launchctl list | grep -i lantern || echo "(no lantern launchagents loaded — run 'make autostart-install')"
	@echo ""
	@for s in infra api dashboard whatsapp-bridge imessage-bridge; do \
		echo "—— $$s last 3 lines ——"; \
		tail -3 "$$HOME/Library/Logs/Lantern/$$s.err.log" 2>/dev/null || echo "(no log yet)"; \
	done

regression: ## Run the full alpha-readiness regression test suite
	@bash scripts/regression.sh

regression-quiet: ## Same but only print failures (good for cron)
	@bash scripts/regression.sh --quiet

landing-dev: ## Start the landing page in dev mode
	cd apps/landing && npm run dev

docs-dev: ## Start the docs site in dev mode
	cd apps/docs && npm run dev

dashboard-dev: ## Start the dashboard in dev mode
	@bash scripts/kill-port.sh 3001
	cd apps/web && npm run dev

local-dev: ## One-command local dev setup (docker-compose)
	./scripts/local-dev.sh docker

local-kind: ## Set up a local Kind cluster with Helm
	./scripts/local-dev.sh kind

k8s-validate: ## Validate K8s Job isolation end-to-end on a throwaway kind cluster (Calico-enforced default-deny + seccomp + cap-drop)
	@bash infra/k8s/validate.sh

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
	cd apps/landing && npm run build
	cd apps/docs && npm run build
	cd apps/web && npm run build

docker-build: ## Build all Docker images
	docker build -t lantern-control-plane services/control-plane
	docker build -t lantern-gateway services/gateway
	docker build -t lantern-model-router services/model-router
	docker build -t lantern-workflow-engine services/workflow-engine
	docker build -t lantern-web apps/web
	docker build -t lantern-landing apps/landing

# ---------- Proto ----------

proto: ## Regenerate code from proto definitions
	@echo "Generating Go code..."
	protoc --proto_path=packages/proto \
		--go_out=gen/go --go_opt=paths=source_relative \
		--go-grpc_out=gen/go --go-grpc_opt=paths=source_relative \
		packages/proto/lantern/v1/*.proto
	@echo "Generating TypeScript types..."
	npx ts-proto --out=gen/ts packages/proto/lantern/v1/*.proto
	@echo "Done."

# ---------- Test ----------

test: test-go test-rust test-ts test-python ## Run all tests

test-go: ## Run Go tests
	cd services/control-plane && go test -race -count=1 ./...
	cd services/workflow-engine && go test -race -count=1 ./...
	cd services/scheduler && go test -race -count=1 ./...

test-rust: ## Run Rust tests
	cd services/gateway && cargo test
	cd services/model-router && cargo test
	cd services/runtime-manager && cargo test

test-ts: ## Run TypeScript tests
	cd packages/sdk-ts && npx vitest run

test-python: ## Run Python tests
	cd packages/sdk-python && python3 -m pytest tests/ -v

test-e2e: ## Run live-stack e2e suites (needs `make dev-infra` + control-plane on :8080; skips green when down) — see e2e/README.md
	cd e2e/runtime && go test -tags e2e -count=1 -v ./...

test-db: ## Start dev Postgres if needed, then run Go tests that require a live DB
	@echo "==> Ensuring Postgres is up..."
	@docker compose -f infra/docker/docker-compose.yml up -d postgres minio-init redis || true
	@echo "==> Waiting for Postgres to be ready (up to 30s)..."
	@for i in $$(seq 1 30); do \
		docker compose -f infra/docker/docker-compose.yml exec -T postgres \
			pg_isready -U lantern -d lantern -q 2>/dev/null && break; \
		echo "  attempt $$i/30 — not ready yet"; sleep 1; \
	done
	@docker compose -f infra/docker/docker-compose.yml exec -T postgres \
		pg_isready -U lantern -d lantern -q || (echo "ERROR: Postgres never became ready" && exit 1)
	@echo "==> Running Go tests with DATABASE_URL..."
	cd services/control-plane && \
		DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable" \
		go test -race -count=1 ./...
	cd services/runtime-scheduler && \
		DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable" \
		go test -race -count=1 ./...

# ---------- Lint ----------

lint: lint-go lint-rust lint-ts ## Lint everything

lint-go: ## Lint Go code
	cd services/control-plane && golangci-lint run ./...

lint-rust: ## Lint Rust code
	cd services/gateway && cargo clippy -- -D warnings
	cd services/model-router && cargo clippy -- -D warnings
	cd services/runtime-manager && cargo clippy -- -D warnings

lint-ts: ## Lint TypeScript code
	cd packages/sdk-ts && npm run lint
	cd apps/landing && npm run lint
	cd services/whatsapp-bridge && npm run typecheck
	cd services/imessage-bridge && npm run typecheck

# ---------- Security ----------

audit: ## Run security audits on all dependencies
	cd services/control-plane && govulncheck ./...
	cd services/gateway && cargo audit
	cd services/model-router && cargo audit
	cd services/runtime-manager && cargo audit
	cd packages/sdk-ts && npm audit --omit=dev  # production deps only — dev-tool advisories (vitest/esbuild) aren't shipped

# ---------- CI ----------

ci-local: lint test audit ## Run the same checks as CI, locally
	@echo "All CI checks passed."

# ---------- Clean ----------

clean: ## Remove build artifacts
	rm -rf bin/ gen/ dist/
	docker compose -f infra/docker/docker-compose.yml down -v
