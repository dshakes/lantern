.PHONY: help dev build test lint ci-local clean proto local-dev local-kind seed docker-build

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
	cd services/control-plane && \
	DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable" \
	REDIS_URL="redis://localhost:6379" \
	S3_ENDPOINT="http://localhost:9000" \
	LOG_LEVEL="debug" \
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

run-whatsapp-bridge: ## Start the WhatsApp bridge service
	@bash scripts/kill-port.sh 3100
	cd services/whatsapp-bridge && npm run dev

run-whatsapp: run-whatsapp-bridge ## Alias: start the WhatsApp bridge service

run-imessage-bridge: ## Start the iMessage bridge (macOS only)
	@bash scripts/kill-port.sh 3200
	cd services/imessage-bridge && npm run dev

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

# ---------- Security ----------

audit: ## Run security audits on all dependencies
	cd services/control-plane && govulncheck ./...
	cd services/gateway && cargo audit
	cd services/model-router && cargo audit
	cd services/runtime-manager && cargo audit
	cd packages/sdk-ts && npm audit

# ---------- CI ----------

ci-local: lint test audit ## Run the same checks as CI, locally
	@echo "All CI checks passed."

# ---------- Clean ----------

clean: ## Remove build artifacts
	rm -rf bin/ gen/ dist/
	docker compose -f infra/docker/docker-compose.yml down -v
