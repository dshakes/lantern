#!/usr/bin/env bash
# validate-cluster.sh — one-command gVisor/Kata cluster validation harness.
#
# Closes the README gap "live Kata execution needs operator-run cluster
# validation" by giving an operator a single command that:
#   1. Runs preflight checks (kubectl present, cluster reachable, RuntimeClasses
#      gvisor/kata enumerated, node pool capabilities listed).
#   2. Runs the always-on isolation legs (a–f) from infra/k8s/validate.sh --ci:
#      egress default-deny, DNS carve-out, securityContext hardening, PSA
#      rejection, fail-closed RuntimeClass refusal, and Helm chart render.
#   3. Runs the gVisor execution leg (g) against the real cluster, but SKIPS it
#      (with a clear message) when the gvisor RuntimeClass is absent — absent
#      means the operator still needs to provision that node pool, not a failure.
#   4. Runs the Kata execution legs (h/i) similarly — SKIPPED if kata is absent.
#   5. Writes a structured markdown report to --report (default:
#      cluster-validation-report.md) AND echoes results to stdout.
#
# Usage:
#   KUBECONFIG=/path/to/kubeconfig.yaml bash scripts/validate-cluster.sh
#   bash scripts/validate-cluster.sh --kubeconfig ~/.kube/config --context my-ctx
#   bash scripts/validate-cluster.sh --report /tmp/report.md
#
# Exit codes:
#   0  All runnable legs passed (SKIPPED legs due to absent RuntimeClass are not failures).
#   1  One or more runnable legs failed.
#   2  Preflight error (kubectl absent, cluster unreachable, etc.).
#
# Requires: bash (3.2+), kubectl.
# Optional: helm (for the Helm chart render assertion in leg e).

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------- Argument parsing -------------------------------------------------

KUBECONFIG_ARG=""
CONTEXT_ARG=""
REPORT_FILE="cluster-validation-report.md"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kubeconfig) KUBECONFIG_ARG="$2"; shift 2 ;;
    --context)    CONTEXT_ARG="$2";    shift 2 ;;
    --report)     REPORT_FILE="$2";    shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ -n "$KUBECONFIG_ARG" ]]; then
  export KUBECONFIG="$KUBECONFIG_ARG"
fi

# ---------- Colors -----------------------------------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[0;33m'
  CYN=$'\033[0;36m'; DIM=$'\033[2m'; BLD=$'\033[1m'; RST=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; CYN=''; DIM=''; BLD=''; RST=''
fi

# ---------- State ------------------------------------------------------------

FAILS=0
SKIPS=0
KCTX=""            # resolved in preflight()
GVISOR_PRESENT=0   # set in preflight()
KATA_PRESENT=0     # set in preflight()
KATA_POD_NODE=""   # set by assert_kata()

# REPORT_TABLE_ROWS accumulates markdown table rows (| leg | icon | detail |).
# Written as a single string, one row per line.
REPORT_TABLE_ROWS=""

# REPORT_NOTES accumulates extra markdown paragraphs appended after the table.
REPORT_NOTES=""

# ---------- Output helpers ---------------------------------------------------

section() {
  printf '\n%s%s%s\n' "$BLD" "$1" "$RST"
}

pass_leg() {
  local leg="$1" detail="${2:-}"
  printf '  %s✓ PASS%s %s' "$GRN" "$RST" "$leg"
  [[ -n "$detail" ]] && printf ' %s— %s%s' "$DIM" "$detail" "$RST"
  printf '\n'
  REPORT_TABLE_ROWS="${REPORT_TABLE_ROWS}| ${leg} | ✅ PASS | ${detail} |
"
}

fail_leg() {
  local leg="$1" detail="${2:-}" hint="${3:-}"
  printf '  %s✗ FAIL%s %s' "$RED" "$RST" "$leg"
  [[ -n "$detail" ]] && printf ' %s— %s%s' "$DIM" "$detail" "$RST"
  printf '\n'
  [[ -n "$hint" ]] && printf '    %s→ %s%s\n' "$DIM" "$hint" "$RST"
  local cell="${detail}"
  [[ -n "$hint" ]] && cell="${detail}. Hint: ${hint}"
  REPORT_TABLE_ROWS="${REPORT_TABLE_ROWS}| ${leg} | ❌ FAIL | ${cell} |
"
  FAILS=$((FAILS + 1))
}

skip_leg() {
  local leg="$1" reason="${2:-RuntimeClass absent}"
  printf '  %s~ SKIP%s %s %s— %s%s\n' "$YLW" "$RST" "$leg" "$DIM" "$reason" "$RST"
  REPORT_TABLE_ROWS="${REPORT_TABLE_ROWS}| ${leg} | ⏭ SKIP | ${reason} |
"
  SKIPS=$((SKIPS + 1))
}

step() { printf '  %s… %s%s\n' "$DIM" "$1" "$RST"; }

die() {
  printf '%s✗ preflight: %s%s\n' "$RED" "$1" "$RST" >&2
  exit 2
}

kc() { kubectl --context "$KCTX" "$@"; }

# ---------- 1. Preflight checks ----------------------------------------------

preflight() {
  section "Preflight"

  # kubectl present
  if ! command -v kubectl >/dev/null 2>&1; then
    die "kubectl not found — install: https://kubernetes.io/docs/tasks/tools/"
  fi
  local kver; kver=$(kubectl version --client -o yaml 2>/dev/null \
    | sed -nE 's/^ *gitVersion: (.*)/\1/p' | head -1)
  pass_leg "kubectl present" "${kver}"

  # Resolve context
  if [[ -n "${CONTEXT_ARG:-}" ]]; then
    KCTX="$CONTEXT_ARG"
  else
    KCTX=$(kubectl config current-context 2>/dev/null) \
      || die "No current kube-context — set KUBECONFIG or pass --kubeconfig / --context"
  fi

  # Cluster reachability
  if ! kc cluster-info >/dev/null 2>&1; then
    die "Cluster at context '${KCTX}' is not reachable. Check KUBECONFIG / VPN / kubeconfig expiry."
  fi
  local srv; srv=$(kc cluster-info 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' | tr -d '\r')
  pass_leg "cluster reachable" "${srv:-context=${KCTX}}"

  # RuntimeClass enumeration — PRESENT or ABSENT, never an error
  if kc get runtimeclass gvisor >/dev/null 2>&1; then
    GVISOR_PRESENT=1
    pass_leg "RuntimeClass gvisor" "PRESENT — leg (g) will run"
  else
    skip_leg "RuntimeClass gvisor" "ABSENT — provision a gVisor node pool to enable leg (g)"
  fi

  if kc get runtimeclass kata >/dev/null 2>&1; then
    KATA_PRESENT=1
    pass_leg "RuntimeClass kata" "PRESENT — legs (h/i) will run"
  else
    skip_leg "RuntimeClass kata" "ABSENT — provision a Kata node pool to enable legs (h/i)"
  fi

  # Node summary (informational)
  printf '\n%sNode summary%s\n' "$CYN" "$RST"
  kc get nodes -o wide --no-headers 2>/dev/null \
    | while IFS= read -r line; do printf '  %s%s%s\n' "$DIM" "$line" "$RST"; done \
    || printf '  %s(could not list nodes)%s\n' "$DIM" "$RST"

  if [[ "$GVISOR_PRESENT" -eq 0 && "$KATA_PRESENT" -eq 0 ]]; then
    printf '\n%s⚠  Neither gvisor nor kata RuntimeClass found.%s\n' "$YLW" "$RST"
    printf '  All execution legs (g/h/i) will be SKIPPED.\n'
    printf '  Set up a sandbox cluster first: %sinfra/k8s/gke-agent-sandbox-setup.sh%s\n' "$CYN" "$RST"
    REPORT_NOTES="${REPORT_NOTES}
> **Note:** Neither \`gvisor\` nor \`kata\` RuntimeClass is installed. Provision a sandbox
> cluster with \`infra/k8s/gke-agent-sandbox-setup.sh\` (GKE) to run the execution legs.
"
  fi
}

# ---------- 2. Always-on legs (a–f) via validate.sh --ci --------------------
#
# validate.sh --ci manages workload lifecycle against the existing cluster and
# runs assertions a–f. Stream its output live so the operator sees progress;
# capture the exit code.

run_always_on_legs() {
  section "Always-on legs (a–f) — infra/k8s/validate.sh --ci"

  local validate_sh="${REPO_ROOT}/infra/k8s/validate.sh"
  if [[ ! -f "$validate_sh" ]]; then
    fail_leg "validate.sh present" "not found at ${validate_sh}" "check out the full repo"
    return
  fi

  printf '  %s(streaming validate.sh --ci output)%s\n\n' "$DIM" "$RST"

  local rc=0
  CLUSTER_CONTEXT="$KCTX" bash "$validate_sh" --ci || rc=$?

  printf '\n'
  if [[ "$rc" -eq 0 ]]; then
    pass_leg "always-on legs (a–f)" "validate.sh --ci exited 0 — all always-on assertions passed"
  else
    fail_leg "always-on legs (a–f)" \
      "validate.sh --ci exited ${rc} — see output above for the failing assertion" \
      "Fix the failing assertion in infra/k8s/ before the execution legs matter"
  fi
}

# ---------- 3. Execution leg (g): gVisor -----------------------------------

NS="lantern-t-validate"

assert_gvisor() {
  section "(g) [execution] UNTRUSTED runs INSIDE gVisor (runsc)"

  if [[ "$GVISOR_PRESENT" -eq 0 ]]; then
    skip_leg "(g) gVisor execution" "RuntimeClass 'gvisor' not installed on this cluster"
    return
  fi

  local manifest="${REPO_ROOT}/infra/k8s/manifests/92-untrusted-gvisor-exec.yaml"
  if [[ ! -f "$manifest" ]]; then
    fail_leg "(g) gVisor exec manifest" "missing ${manifest}" "ship 92-untrusted-gvisor-exec.yaml"
    return
  fi

  kc -n "$NS" delete pod untrusted-gvisor-exec --ignore-not-found >/dev/null 2>&1

  local apply_out apply_rc=0
  apply_out=$(kc -n "$NS" apply -f "$manifest" 2>&1) || apply_rc=$?
  if [[ "$apply_rc" -ne 0 ]]; then
    fail_leg "(g) gVisor pod admitted" \
      "apply rejected: ${apply_out:0:160}" \
      "RuntimeClass 'gvisor' exists but handler may be missing — check node pool"
    return
  fi

  step "waiting for gVisor pod (up to 120s)…"
  local phase=""
  if ! kc -n "$NS" wait --for=condition=Ready pod/untrusted-gvisor-exec --timeout=120s >/dev/null 2>&1; then
    phase=$(kc -n "$NS" get pod untrusted-gvisor-exec \
      -o jsonpath='{.status.phase}' 2>/dev/null)
    if [[ "$phase" != "Running" && "$phase" != "Succeeded" ]]; then
      fail_leg "(g) gVisor pod runs" \
        "phase='${phase:-Pending}' after 120s" \
        "RuntimeClass 'gvisor' handler 'runsc' missing or node not labelled lantern.dev/runtimeclass=gvisor"
      kc -n "$NS" delete pod untrusted-gvisor-exec --ignore-not-found >/dev/null 2>&1
      return
    fi
  fi
  pass_leg "(g) gVisor pod runs" "reached Running/Succeeded under runtimeClassName=gvisor"

  # Proof: /proc/version in the user-space kernel contains "gVisor".
  local ver; ver=$(kc -n "$NS" exec untrusted-gvisor-exec -- cat /proc/version 2>/dev/null || true)
  if [[ "$ver" == *"gVisor"* || "$ver" == *"gvisor"* ]]; then
    pass_leg "(g) gVisor sandbox confirmed" "/proc/version advertises gVisor (user-space kernel)"
  else
    # Fallback: check node label when runsc build doesn't stamp /proc/version.
    local node; node=$(kc -n "$NS" get pod untrusted-gvisor-exec \
      -o jsonpath='{.spec.nodeName}' 2>/dev/null)
    local rc_label; rc_label=$(kc get node "$node" \
      -o jsonpath='{.metadata.labels.lantern\.dev/runtimeclass}' 2>/dev/null)
    if [[ "$rc_label" == "gvisor" ]]; then
      pass_leg "(g) gVisor sandbox confirmed" \
        "node '$node' is gvisor-labelled (/proc/version unstamped on this runsc build)"
    else
      fail_leg "(g) gVisor sandbox confirmed" \
        "/proc/version has no gVisor marker and node '$node' not gvisor-labelled" \
        "Pod may have run on a bare runc node — FAIL-OPEN. Check runsc handler + node affinity."
    fi
  fi
  kc -n "$NS" delete pod untrusted-gvisor-exec --ignore-not-found >/dev/null 2>&1
}

# ---------- 4. Execution legs (h/i): Kata ----------------------------------

assert_kata() {
  section "(h) [execution] HOSTILE runs INSIDE a Kata microVM"

  if [[ "$KATA_PRESENT" -eq 0 ]]; then
    skip_leg "(h) Kata execution" "RuntimeClass 'kata' not installed on this cluster"
    return
  fi

  local manifest="${REPO_ROOT}/infra/k8s/manifests/93-hostile-kata-exec.yaml"
  if [[ ! -f "$manifest" ]]; then
    fail_leg "(h) Kata exec manifest" "missing ${manifest}" "ship 93-hostile-kata-exec.yaml"
    return
  fi

  kc -n "$NS" delete pod hostile-kata-exec --ignore-not-found >/dev/null 2>&1

  local apply_out apply_rc=0
  apply_out=$(kc -n "$NS" apply -f "$manifest" 2>&1) || apply_rc=$?
  if [[ "$apply_rc" -ne 0 ]]; then
    fail_leg "(h) Kata pod admitted" \
      "apply rejected: ${apply_out:0:160}" \
      "RuntimeClass 'kata' exists but handler may be missing — check node pool"
    return
  fi

  step "waiting for Kata pod (up to 180s)…"
  local phase=""
  if ! kc -n "$NS" wait --for=condition=Ready pod/hostile-kata-exec --timeout=180s >/dev/null 2>&1; then
    phase=$(kc -n "$NS" get pod hostile-kata-exec \
      -o jsonpath='{.status.phase}' 2>/dev/null)
    if [[ "$phase" != "Running" && "$phase" != "Succeeded" ]]; then
      fail_leg "(h) Kata pod runs" \
        "phase='${phase:-Pending}' after 180s" \
        "RuntimeClass 'kata' handler missing or node not labelled lantern.dev/runtimeclass=kata"
      kc -n "$NS" delete pod hostile-kata-exec --ignore-not-found >/dev/null 2>&1
      return
    fi
  fi
  pass_leg "(h) Kata pod runs" "reached Running/Succeeded under runtimeClassName=kata"

  # Proof: guest kernel differs from host kernel.
  KATA_POD_NODE=$(kc -n "$NS" get pod hostile-kata-exec \
    -o jsonpath='{.spec.nodeName}' 2>/dev/null)
  local guest_k host_k
  guest_k=$(kc -n "$NS" exec hostile-kata-exec -- uname -r 2>/dev/null || true)
  host_k=$(kc get node "$KATA_POD_NODE" \
    -o jsonpath='{.status.nodeInfo.kernelVersion}' 2>/dev/null)

  if [[ -n "$guest_k" && -n "$host_k" && "$guest_k" != "$host_k" ]]; then
    pass_leg "(h) Kata microVM confirmed" \
      "guest kernel '$guest_k' != host kernel '$host_k' (separate kernel = hardware isolation)"
  else
    fail_leg "(h) Kata microVM confirmed" \
      "guest kernel '${guest_k:-?}' = host kernel '${host_k:-?}'" \
      "Identical kernels: pod ran on shared host kernel (runc), not a Kata microVM — FAIL-OPEN."
  fi
  # Pod stays for leg (i); assert_no_cotenancy deletes it.
}

assert_no_cotenancy() {
  section "(i) [execution] HOSTILE node has NO cross-tenant co-tenancy"

  if [[ "$KATA_PRESENT" -eq 0 ]]; then
    skip_leg "(i) co-tenancy check" "depends on leg (h); RuntimeClass 'kata' absent"
    return
  fi

  if [[ -z "$KATA_POD_NODE" ]]; then
    skip_leg "(i) co-tenancy check" "no Kata pod node recorded (leg h must have passed)"
    return
  fi

  local others
  others=$(kc get pods --all-namespaces \
    --field-selector "spec.nodeName=${KATA_POD_NODE}" \
    -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' 2>/dev/null \
    | grep -E '^lantern-t-' | grep -v "^${NS}\$" | sort -u || true)

  if [[ -z "$others" ]]; then
    pass_leg "(i) dedicated Kata node" \
      "no other lantern-t-* tenant shares node '$KATA_POD_NODE' (taint enforced)"
  else
    fail_leg "(i) dedicated Kata node" \
      "node '$KATA_POD_NODE' also runs: $(printf '%s' "$others" | tr '\n' ' ')" \
      "HOSTILE must get a dedicated, tainted node pool — co-tenancy is an isolation breach."
  fi
  kc -n "$NS" delete pod hostile-kata-exec --ignore-not-found >/dev/null 2>&1
}

# ---------- 5. Report generation --------------------------------------------

write_report() {
  local ts; ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  # Determine overall status for the summary prose.
  if [[ "$FAILS" -eq 0 && "$SKIPS" -eq 0 ]]; then
    local status_prose="**Fully validated** — all legs passed, including gVisor and Kata execution."
  elif [[ "$FAILS" -eq 0 ]]; then
    local status_prose="**Partially validated** — all runnable legs passed. ${SKIPS} leg(s) SKIPPED due to absent RuntimeClass. See the SKIP rows for what to provision next."
  else
    local status_prose="**${FAILS} leg(s) FAILED** — see the FAIL rows above and the terminal output for hints."
  fi

  {
    printf '# Lantern cluster validation report\n\n'
    printf 'Generated: %s  \n' "$ts"
    printf 'Context: `%s`  \n' "$KCTX"
    printf 'Script: `scripts/validate-cluster.sh`\n\n'
    printf '## Summary\n\n'
    printf '%s\n\n' "$status_prose"
    printf '## Results\n\n'
    printf '| Leg | Result | Detail |\n'
    printf '|-----|--------|--------|\n'
    printf '%s' "$REPORT_TABLE_ROWS"
    if [[ -n "$REPORT_NOTES" ]]; then
      printf '\n%s\n' "$REPORT_NOTES"
    fi
    printf '\n---\n'
    printf '_Generated by `scripts/validate-cluster.sh`. '
    printf 'Kata is NOT claimed as validated unless leg (h) shows ✅ PASS._\n'
  } > "$REPORT_FILE"

  printf '\n%sReport written → %s%s%s\n' "$CYN" "$BLD" "$REPORT_FILE" "$RST"
}

# ---------- 6. Final summary ------------------------------------------------

print_summary() {
  section "Summary"
  if [[ "$FAILS" -eq 0 && "$SKIPS" -eq 0 ]]; then
    printf '  %sAll legs passed — cluster fully validated.%s\n' "$GRN" "$RST"
  elif [[ "$FAILS" -eq 0 ]]; then
    printf '  %sAll runnable legs passed · %d leg(s) SKIPPED (RuntimeClass absent — not a failure).%s\n' \
      "$GRN" "$SKIPS" "$RST"
    printf '  %sProvision the missing sandbox node pools and re-run to validate the remaining legs.%s\n' \
      "$DIM" "$RST"
  else
    printf '  %s%d leg(s) FAILED · %d SKIPPED%s\n' "$RED" "$FAILS" "$SKIPS" "$RST"
    printf '  Follow the hints in the output above or see %s\n' "$REPORT_FILE"
  fi
}

# ---------- Main ------------------------------------------------------------

main() {
  printf '%s%sLantern cluster validation harness%s %s— %s%s\n' \
    "$BLD" "$CYN" "$RST" "$DIM" "$(date '+%Y-%m-%d %H:%M:%S')" "$RST"
  printf '  %sRepo: %s%s\n\n' "$DIM" "$REPO_ROOT" "$RST"

  preflight
  run_always_on_legs
  assert_gvisor
  assert_kata
  assert_no_cotenancy
  print_summary
  write_report

  [[ "$FAILS" -gt 0 ]] && exit 1
  exit 0
}

main "$@"
