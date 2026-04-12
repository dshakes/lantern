#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# local-dev.sh -- One-command local development setup for Lantern.
#
# Usage:
#   ./scripts/local-dev.sh [docker|kind]
#
#   docker (default): Starts everything via docker-compose
#   kind:             Creates a Kind cluster and deploys via Helm
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-docker}"

# -- Colors ----------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
success() { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error()   { printf "${RED}[ERR]${NC}   %s\n" "$*"; exit 1; }
header()  { printf "\n${BOLD}${CYAN}--- %s ---${NC}\n\n" "$*"; }

# -- Cleanup on exit (docker mode) ----------------------------------------
PIDS=()
cleanup() {
    if [[ ${#PIDS[@]} -gt 0 ]]; then
        info "Stopping background processes..."
        for pid in "${PIDS[@]}"; do
            kill "$pid" 2>/dev/null || true
        done
    fi
}
trap cleanup EXIT

# =========================================================================
# Prerequisite checks
# =========================================================================
check_command() {
    local cmd="$1"
    local install_hint="${2:-}"
    if ! command -v "$cmd" &>/dev/null; then
        error "'$cmd' is required but not found.${install_hint:+ Install: $install_hint}"
    fi
}

check_common_prereqs() {
    info "Checking prerequisites..."
    check_command docker "https://docs.docker.com/get-docker/"
}

check_docker_prereqs() {
    check_common_prereqs
    check_command docker "https://docs.docker.com/get-docker/"

    # Verify Docker daemon is running.
    if ! docker info &>/dev/null; then
        error "Docker daemon is not running. Start Docker Desktop or dockerd and retry."
    fi
    success "Docker is running"

    # Check for docker compose (v2 plugin or standalone).
    if docker compose version &>/dev/null; then
        COMPOSE_CMD="docker compose"
    elif command -v docker-compose &>/dev/null; then
        COMPOSE_CMD="docker-compose"
    else
        error "docker compose (v2 plugin) or docker-compose is required."
    fi
    success "Compose: ${COMPOSE_CMD}"

    # Optional but helpful: check for tools used in dev.
    for tool in go cargo node psql; do
        if command -v "$tool" &>/dev/null; then
            success "$tool found"
        else
            warn "$tool not found -- some dev workflows may not work"
        fi
    done
}

check_kind_prereqs() {
    check_common_prereqs
    check_command kind "go install sigs.k8s.io/kind@latest"
    check_command kubectl "https://kubernetes.io/docs/tasks/tools/"
    check_command helm "https://helm.sh/docs/intro/install/"

    if ! docker info &>/dev/null; then
        error "Docker daemon is not running. Start Docker Desktop or dockerd and retry."
    fi
    success "All Kind prerequisites met"
}

# =========================================================================
# Wait for a service to become healthy
# =========================================================================
wait_for_healthy() {
    local name="$1"
    local check_cmd="$2"
    local max_retries="${3:-30}"
    local delay="${4:-2}"

    info "Waiting for ${name}..."
    local attempt=0
    while ! eval "$check_cmd" &>/dev/null; do
        attempt=$((attempt + 1))
        if [[ $attempt -ge $max_retries ]]; then
            error "${name} failed to become healthy after $((max_retries * delay))s"
        fi
        sleep "$delay"
    done
    success "${name} is healthy"
}

# =========================================================================
# Docker mode
# =========================================================================
mode_docker() {
    header "Lantern Local Dev (Docker Compose)"
    check_docker_prereqs

    COMPOSE_FILE="${REPO_ROOT}/infra/docker/docker-compose.yml"

    # -- Step 1: Start infrastructure --------------------------------------
    header "Starting infrastructure (Postgres, Redis, MinIO)"
    ${COMPOSE_CMD} -f "${COMPOSE_FILE}" up -d postgres redis minio minio-init

    wait_for_healthy "PostgreSQL" "docker exec \$(${COMPOSE_CMD} -f ${COMPOSE_FILE} ps -q postgres) pg_isready -U lantern" 30 2
    wait_for_healthy "Redis"      "docker exec \$(${COMPOSE_CMD} -f ${COMPOSE_FILE} ps -q redis) redis-cli ping" 30 2
    wait_for_healthy "MinIO"      "curl -sf http://localhost:9000/minio/health/live" 30 2

    # -- Step 2: Run control-plane migrations ------------------------------
    header "Running control-plane migrations"
    info "Starting control-plane to run migrations..."
    ${COMPOSE_CMD} -f "${COMPOSE_FILE}" up -d control-plane
    wait_for_healthy "Control-plane HTTP" "curl -sf http://localhost:8080/healthz" 60 2
    success "Control-plane is running and migrations are complete"

    # -- Step 3: Start remaining services ----------------------------------
    header "Starting all services"
    ${COMPOSE_CMD} -f "${COMPOSE_FILE}" up -d
    success "All compose services started"

    # Wait for gateway if available.
    if ${COMPOSE_CMD} -f "${COMPOSE_FILE}" ps --services | grep -q gateway; then
        wait_for_healthy "Gateway" "curl -sf http://localhost:8443/healthz" 60 2 || warn "Gateway health check did not pass (service may still be starting)"
    fi

    # -- Step 4: Seed sample data ------------------------------------------
    header "Seeding sample data"
    if command -v psql &>/dev/null; then
        DATABASE_URL="postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable" \
            "${REPO_ROOT}/scripts/seed-data.sh"
    else
        warn "psql not found -- skipping seed data. Run later: make seed"
    fi

    # -- Step 5: Start dashboard in dev mode (foreground-ish) ---------------
    header "Starting dashboard"
    if command -v node &>/dev/null && [[ -d "${REPO_ROOT}/apps/web" ]]; then
        info "Installing dashboard dependencies..."
        (cd "${REPO_ROOT}/apps/web" && npm install --silent 2>/dev/null) || warn "npm install had warnings"
        info "Starting Next.js dashboard in dev mode (port 3001)..."
        (cd "${REPO_ROOT}/apps/web" && npm run dev) &
        PIDS+=($!)
        success "Dashboard starting on http://localhost:3001"
    else
        warn "Node.js not found or apps/web missing -- skipping dashboard dev server"
        info "You can start it manually: cd apps/web && npm run dev"
    fi

    # -- Summary -----------------------------------------------------------
    print_docker_summary
    wait_for_interrupt
}

print_docker_summary() {
    echo ""
    printf "${BOLD}${GREEN}================================================================${NC}\n"
    printf "${BOLD}${GREEN}  Lantern local dev environment is ready!                       ${NC}\n"
    printf "${BOLD}${GREEN}================================================================${NC}\n"
    echo ""
    printf "${BOLD}Services:${NC}\n"
    printf "  %-24s %s\n" "Control-plane gRPC:" "localhost:50051"
    printf "  %-24s %s\n" "Control-plane HTTP:" "http://localhost:8080"
    printf "  %-24s %s\n" "Gateway:" "http://localhost:8443"
    printf "  %-24s %s\n" "Dashboard:" "http://localhost:3001"
    echo ""
    printf "${BOLD}Infrastructure:${NC}\n"
    printf "  %-24s %s\n" "PostgreSQL:" "localhost:5432 (lantern/lantern)"
    printf "  %-24s %s\n" "Redis:" "localhost:6379"
    printf "  %-24s %s\n" "MinIO Console:" "http://localhost:9001 (lantern/lanternsecret)"
    printf "  %-24s %s\n" "MinIO API:" "http://localhost:9000"
    echo ""
    printf "${BOLD}Useful commands:${NC}\n"
    printf "  %-40s %s\n" "make seed" "Re-seed sample data"
    printf "  %-40s %s\n" "make dev" "Restart all compose services"
    printf "  %-40s %s\n" "make dev-infra" "Start infra only"
    printf "  %-40s %s\n" "grpcurl -plaintext localhost:50051 list" "List gRPC services"
    printf "  %-40s %s\n" "psql postgres://lantern:lantern@localhost:5432/lantern" "Connect to DB"
    echo ""
    printf "${BOLD}Logs:${NC}\n"
    printf "  docker compose -f infra/docker/docker-compose.yml logs -f [service]\n"
    echo ""
    printf "${YELLOW}Press Ctrl+C to stop all services.${NC}\n"
    echo ""
}

wait_for_interrupt() {
    # Keep the script alive so Ctrl+C triggers cleanup.
    while true; do
        sleep 60 &
        wait $! 2>/dev/null || break
    done
}

# =========================================================================
# Kind mode
# =========================================================================
mode_kind() {
    header "Lantern Local Dev (Kind + Helm)"
    check_kind_prereqs

    KIND_CONFIG="${REPO_ROOT}/infra/kind/kind-config.yaml"
    HELM_CHART="${REPO_ROOT}/infra/helm/lantern"
    VALUES_DEV="${HELM_CHART}/values-dev.yaml"
    CLUSTER_NAME="lantern-dev"

    # -- Step 1: Create or reuse Kind cluster ------------------------------
    header "Kind cluster"
    if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
        info "Kind cluster '${CLUSTER_NAME}' already exists, reusing"
    else
        info "Creating Kind cluster '${CLUSTER_NAME}'..."
        kind create cluster --config "${KIND_CONFIG}"
        success "Kind cluster created"
    fi

    kubectl cluster-info --context "kind-${CLUSTER_NAME}" || error "Cannot reach Kind cluster"
    success "Connected to kind-${CLUSTER_NAME}"

    # -- Step 2: Build Docker images ---------------------------------------
    header "Building Docker images"
    local images=(
        "lantern-control-plane:${REPO_ROOT}/services/control-plane"
        "lantern-gateway:${REPO_ROOT}/services/gateway"
        "lantern-model-router:${REPO_ROOT}/services/model-router"
        "lantern-web:${REPO_ROOT}/apps/web"
    )

    for entry in "${images[@]}"; do
        local img="${entry%%:*}"
        local ctx="${entry#*:}"
        if [[ -f "${ctx}/Dockerfile" ]]; then
            info "Building ${img}..."
            docker build -t "${img}:dev" "${ctx}" || { warn "Failed to build ${img}, skipping"; continue; }
            success "Built ${img}:dev"
        else
            warn "No Dockerfile for ${img} at ${ctx}/Dockerfile, skipping"
        fi
    done

    # -- Step 3: Load images into Kind -------------------------------------
    header "Loading images into Kind"
    for entry in "${images[@]}"; do
        local img="${entry%%:*}"
        local ctx="${entry#*:}"
        if docker image inspect "${img}:dev" &>/dev/null; then
            info "Loading ${img}:dev..."
            kind load docker-image "${img}:dev" --name "${CLUSTER_NAME}"
            success "Loaded ${img}:dev"
        fi
    done

    # -- Step 4: Deploy via Helm -------------------------------------------
    header "Deploying with Helm"
    kubectl create namespace lantern 2>/dev/null || true

    if helm status lantern -n lantern &>/dev/null; then
        info "Upgrading existing Helm release..."
        helm upgrade lantern "${HELM_CHART}" \
            -n lantern \
            -f "${HELM_CHART}/values.yaml" \
            -f "${VALUES_DEV}" \
            --wait --timeout 5m
    else
        info "Installing Helm chart..."
        helm install lantern "${HELM_CHART}" \
            -n lantern \
            -f "${HELM_CHART}/values.yaml" \
            -f "${VALUES_DEV}" \
            --wait --timeout 5m
    fi
    success "Helm deployment complete"

    # -- Step 5: Port-forward key services ---------------------------------
    header "Setting up port-forwards"
    info "Port-forwarding will run in the background..."

    # Kill any stale port-forwards from previous runs.
    pkill -f "kubectl port-forward.*lantern" 2>/dev/null || true
    sleep 1

    # Control-plane gRPC.
    kubectl port-forward -n lantern svc/lantern-control-plane 50051:50051 &>/dev/null &
    PIDS+=($!)
    info "Control-plane gRPC: localhost:50051"

    # Control-plane HTTP.
    kubectl port-forward -n lantern svc/lantern-control-plane 8080:8080 &>/dev/null &
    PIDS+=($!)
    info "Control-plane HTTP: localhost:8080"

    # Gateway.
    kubectl port-forward -n lantern svc/lantern-gateway 8443:8443 &>/dev/null &
    PIDS+=($!)
    info "Gateway: localhost:8443"

    # Dashboard.
    kubectl port-forward -n lantern svc/lantern-web 3001:3000 &>/dev/null &
    PIDS+=($!)
    info "Dashboard: localhost:3001"

    success "Port-forwards active"

    # -- Step 6: Wait for control-plane, then seed -------------------------
    header "Waiting for services"
    wait_for_healthy "Control-plane" "curl -sf http://localhost:8080/healthz" 90 3

    header "Seeding sample data"
    if command -v psql &>/dev/null; then
        # Port-forward Postgres too for seeding.
        kubectl port-forward -n lantern svc/lantern-postgresql 5432:5432 &>/dev/null &
        PIDS+=($!)
        sleep 3
        DATABASE_URL="postgres://lantern:lantern-dev@localhost:5432/lantern?sslmode=disable" \
            "${REPO_ROOT}/scripts/seed-data.sh"
    else
        warn "psql not found -- skipping seed data"
        info "Port-forward Postgres and run: make seed"
    fi

    # -- Summary -----------------------------------------------------------
    print_kind_summary
    wait_for_interrupt
}

print_kind_summary() {
    echo ""
    printf "${BOLD}${GREEN}================================================================${NC}\n"
    printf "${BOLD}${GREEN}  Lantern Kind cluster is ready!                                ${NC}\n"
    printf "${BOLD}${GREEN}================================================================${NC}\n"
    echo ""
    printf "${BOLD}Cluster:${NC} kind-lantern-dev\n"
    echo ""
    printf "${BOLD}Port-forwards:${NC}\n"
    printf "  %-24s %s\n" "Control-plane gRPC:" "localhost:50051"
    printf "  %-24s %s\n" "Control-plane HTTP:" "http://localhost:8080"
    printf "  %-24s %s\n" "Gateway:" "http://localhost:8443"
    printf "  %-24s %s\n" "Dashboard:" "http://localhost:3001"
    echo ""
    printf "${BOLD}Useful commands:${NC}\n"
    printf "  %-50s %s\n" "kubectl get pods -n lantern" "List pods"
    printf "  %-50s %s\n" "kubectl logs -n lantern -l app=control-plane -f" "Stream control-plane logs"
    printf "  %-50s %s\n" "helm upgrade lantern infra/helm/lantern -n lantern -f infra/helm/lantern/values-dev.yaml" "Redeploy"
    printf "  %-50s %s\n" "kind delete cluster --name lantern-dev" "Tear down cluster"
    echo ""
    printf "${YELLOW}Press Ctrl+C to stop port-forwards.${NC}\n"
    echo ""
}

# =========================================================================
# Main
# =========================================================================
case "${MODE}" in
    docker)
        mode_docker
        ;;
    kind)
        mode_kind
        ;;
    *)
        echo "Usage: $0 [docker|kind]"
        echo ""
        echo "  docker (default)  Start everything via docker-compose"
        echo "  kind              Create a Kind cluster and deploy via Helm"
        exit 1
        ;;
esac
