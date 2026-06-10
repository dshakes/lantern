#!/usr/bin/env bash
# validate.sh — end-to-end validation of the K8s Job isolation class against
# a REAL local kind cluster (SECURITY.md "must-close" item / the
# "K8s Job isolation validated end-to-end" beta gate in docs/LAUNCH-CHECKLIST.md).
#
# Usage:   make k8s-validate          (or: bash infra/k8s/validate.sh)
# Exits:   0 if every assertion passes, 1 if any fails.
# Env:     KEEP_CLUSTER=1     skip teardown (debugging)
#          CALICO_MANIFEST=…  override the pinned Calico manifest URL
#
# What it proves, with live probes (not unit tests):
#   (a) the fenced workload pod CANNOT reach the internet (egress default-deny)
#   (b) the fenced pod CAN still resolve DNS (the one allowed egress)
#   (c) the running pod's securityContext really carries seccomp
#       RuntimeDefault + cap drop ALL + non-root + no-priv-esc + RO rootfs
#   (d) a pod requesting runAsRoot/privilege-escalation is REJECTED
#
# kind's default CNI (kindnet) does NOT enforce NetworkPolicy — the cluster is
# created with disableDefaultCNI and Calico is installed so (a) is real, and a
# positive-control pod (no fence) must reach the internet to prove the block
# is the policy, not broken networking.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="lantern-k8s-validate" # must match kind-cluster.yaml `name:`
KCTX="kind-${CLUSTER_NAME}"
NS="lantern-t-validate"
RUN_LABEL="lantern.dev/run-id=run-validate-00000001"
CALICO_MANIFEST="${CALICO_MANIFEST:-https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml}"

# Colors. Disable if NO_COLOR=1 or stdout isn't a terminal.
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RED=$'\033[0;31m'
  GRN=$'\033[0;32m'
  YLW=$'\033[0;33m'
  DIM=$'\033[2m'
  BLD=$'\033[1m'
  RST=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; DIM=''; BLD=''; RST=''
fi

OK_ICON="${GRN}✓ PASS${RST}"
FAIL_ICON="${RED}✗ FAIL${RST}"

FAILS=0

# section <title> — group header
section() {
  printf "\n${BLD}%s${RST}\n" "$1"
}

# pass <name> <detail?>
pass() {
  printf "  %s %s" "$OK_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
}

# fail <name> <detail> <hint>
fail() {
  printf "  %s %s" "$FAIL_ICON" "$1"
  [[ -n "${2:-}" ]] && printf " ${DIM}— %s${RST}" "$2"
  printf "\n"
  [[ -n "${3:-}" ]] && printf "    ${DIM}→ %s${RST}\n" "$3"
  FAILS=$((FAILS + 1))
}

# step <msg> — progress line for non-assertion setup work
step() {
  printf "  ${DIM}… %s${RST}\n" "$1"
}

# die <msg> — unrecoverable setup error (distinct from an assertion FAIL)
die() {
  printf "  ${RED}✗ %s${RST}\n" "$1"
  exit 1
}

kc() { kubectl --context "$KCTX" "$@"; }

# pod_field <jsonpath> — read a field off the fenced workload pod
pod_field() {
  kc -n "$NS" get pod -l "$RUN_LABEL" -o "jsonpath=$1" 2>/dev/null
}

# assert_field <name> <jsonpath> <expected>
assert_field() {
  local got
  got=$(pod_field "$2")
  if [[ "$got" == "$3" ]]; then
    pass "$1" "$2 = $got"
  else
    fail "$1" "expected '$3', got '${got:-<unset>}'" "Compare with build_job() in services/runtime-manager/src/backends/k8s.rs"
  fi
}

# ---- Prerequisites ----------------------------------------------------------

check_tools() {
  section "Prerequisites"
  if ! command -v kind >/dev/null 2>&1; then
    die "kind not found — install with: brew install kind"
  fi
  pass "kind" "$(kind version 2>/dev/null | head -1)"
  if ! command -v kubectl >/dev/null 2>&1; then
    die "kubectl not found — install with: brew install kubectl"
  fi
  pass "kubectl" "$(kubectl version --client -o yaml 2>/dev/null | sed -nE 's/^ *gitVersion: (.*)/\1/p' | head -1)"
  if ! docker info >/dev/null 2>&1; then
    die "docker daemon not running — start Docker Desktop (kind nodes run in Docker)"
  fi
  pass "docker daemon" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
}

# ---- Cluster lifecycle --------------------------------------------------------

teardown() {
  if [[ -n "${KEEP_CLUSTER:-}" ]]; then
    printf "\n${YLW}KEEP_CLUSTER set — leaving cluster '%s' running.${RST}\n" "$CLUSTER_NAME"
    printf "${DIM}Delete later with: kind delete cluster --name %s${RST}\n" "$CLUSTER_NAME"
    return
  fi
  printf "\n${DIM}Tearing down kind cluster '%s'…${RST}\n" "$CLUSTER_NAME"
  kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
}

create_cluster() {
  section "Cluster"
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    step "deleting stale cluster '$CLUSTER_NAME'"
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1
  fi
  step "creating kind cluster '$CLUSTER_NAME' (default CNI disabled)"
  kind create cluster --config "$SCRIPT_DIR/kind-cluster.yaml" >/dev/null 2>&1 \
    || die "kind create cluster failed — re-run with KEEP_CLUSTER=1 and inspect"
  pass "kind cluster" "$CLUSTER_NAME"

  step "installing Calico (real NetworkPolicy enforcement — kindnet does not enforce)"
  kc apply -f "$CALICO_MANIFEST" >/dev/null 2>&1 \
    || die "failed to apply Calico manifest ($CALICO_MANIFEST) — offline? override with CALICO_MANIFEST="
  kc -n kube-system rollout status ds/calico-node --timeout=300s >/dev/null 2>&1 \
    || die "calico-node DaemonSet never became ready"
  pass "calico-node" "DaemonSet ready (NetworkPolicy enforcement live)"
  kc wait node --all --for=condition=Ready --timeout=120s >/dev/null 2>&1 \
    || die "node never became Ready after CNI install"
  kc -n kube-system rollout status deploy/coredns --timeout=180s >/dev/null 2>&1 \
    || die "coredns never became ready"
  pass "cluster networking" "node Ready, coredns up"
}

deploy_workload() {
  section "Workload"
  step "applying namespace + ServiceAccount + NetworkPolicy + Job"
  kc apply -f "$SCRIPT_DIR/manifests/00-namespace.yaml" >/dev/null \
    || die "apply 00-namespace.yaml failed"
  kc apply -f "$SCRIPT_DIR/manifests/10-networkpolicy.yaml" >/dev/null \
    || die "apply 10-networkpolicy.yaml failed"
  kc apply -f "$SCRIPT_DIR/manifests/20-job.yaml" >/dev/null \
    || die "apply 20-job.yaml failed (PSA 'restricted' rejection would mean a hardening regression)"
  step "waiting for the fenced workload pod to be Ready"
  kc -n "$NS" wait pod -l "$RUN_LABEL" --for=condition=Ready --timeout=240s >/dev/null 2>&1 \
    || die "fenced workload pod never became Ready — kubectl --context $KCTX -n $NS describe pod -l $RUN_LABEL"
  pass "fenced workload pod" "Running in $NS"

  step "starting positive-control pod (NO network fence, default namespace)"
  kc run egress-control --image=busybox:1.36 --restart=Never -- sleep 1800 >/dev/null \
    || die "failed to create control pod"
  kc wait pod/egress-control --for=condition=Ready --timeout=180s >/dev/null 2>&1 \
    || die "control pod never became Ready"
  pass "control pod" "Running in default (no NetworkPolicy)"
}

# ---- Assertions ---------------------------------------------------------------

POD="" # resolved fenced pod name

assert_egress() {
  section "(a) Egress default-deny (Calico-enforced, with positive control)"
  POD=$(pod_field '{.items[0].metadata.name}')

  # Positive control FIRST: an unfenced pod must reach the internet, proving
  # the cluster has a working egress path. Without this, (a) could pass
  # vacuously on a box with no internet.
  if kc exec egress-control -- timeout 15 wget -T 5 -q -O /dev/null http://example.com >/dev/null 2>&1; then
    pass "control pod reaches internet" "wget http://example.com OK — egress path works"
  else
    fail "control pod reaches internet" "unfenced pod could not fetch http://example.com" \
      "No internet from pods — the egress-block assertions below would be vacuous. Check Mac connectivity."
  fi

  if kc exec -n "$NS" "$POD" -- timeout 15 wget -T 5 -q -O /dev/null http://example.com >/dev/null 2>&1; then
    fail "fenced pod blocked from internet (domain)" "wget http://example.com SUCCEEDED" \
      "NetworkPolicy not enforced — is Calico running? kubectl --context $KCTX -n kube-system get ds calico-node"
  else
    pass "fenced pod blocked from internet (domain)" "wget http://example.com failed as required"
  fi

  if kc exec -n "$NS" "$POD" -- timeout 15 wget -T 5 -q -O /dev/null http://1.1.1.1 >/dev/null 2>&1; then
    fail "fenced pod blocked from internet (direct IP)" "wget http://1.1.1.1 SUCCEEDED" \
      "Direct-IP egress escaped the fence — DNS-bypass hole in the policy"
  else
    pass "fenced pod blocked from internet (direct IP)" "wget http://1.1.1.1 failed as required"
  fi
}

assert_dns() {
  section "(b) DNS still allowed (the one permitted egress)"
  if kc exec -n "$NS" "$POD" -- timeout 15 nslookup kubernetes.default.svc.cluster.local >/dev/null 2>&1; then
    pass "fenced pod resolves cluster DNS" "nslookup kubernetes.default.svc.cluster.local OK"
  else
    fail "fenced pod resolves cluster DNS" "nslookup failed" \
      "Port-53 egress allow is broken — pod can't even fail cleanly. Check 10-networkpolicy.yaml DNS rule."
  fi
}

assert_security_context() {
  section "(c) securityContext hardening (live pod spec + runtime probes)"
  assert_field "seccomp RuntimeDefault" \
    '{.items[0].spec.securityContext.seccompProfile.type}' "RuntimeDefault"
  assert_field "pod runAsNonRoot" \
    '{.items[0].spec.securityContext.runAsNonRoot}' "true"
  assert_field "capabilities drop ALL" \
    '{.items[0].spec.containers[0].securityContext.capabilities.drop[0]}' "ALL"
  assert_field "allowPrivilegeEscalation false" \
    '{.items[0].spec.containers[0].securityContext.allowPrivilegeEscalation}' "false"
  assert_field "readOnlyRootFilesystem true" \
    '{.items[0].spec.containers[0].securityContext.readOnlyRootFilesystem}' "true"
  assert_field "runAsUser 1000" \
    '{.items[0].spec.containers[0].securityContext.runAsUser}' "1000"
  assert_field "no SA token automount" \
    '{.items[0].spec.automountServiceAccountToken}' "false"

  # Runtime probes — assert the kernel actually enforces what the spec says.
  local uid
  uid=$(kc exec -n "$NS" "$POD" -- id -u 2>/dev/null)
  if [[ "$uid" == "1000" ]]; then
    pass "process runs as uid 1000" "id -u = $uid"
  else
    fail "process runs as uid 1000" "id -u = ${uid:-<exec failed>}"
  fi

  if kc exec -n "$NS" "$POD" -- touch /probe-write >/dev/null 2>&1; then
    fail "root filesystem is read-only" "touch /probe-write SUCCEEDED"
  else
    pass "root filesystem is read-only" "write to / refused"
  fi

  if kc exec -n "$NS" "$POD" -- cat /var/run/secrets/kubernetes.io/serviceaccount/token >/dev/null 2>&1; then
    fail "no service-account token in pod" "token file readable" \
      "automountServiceAccountToken must stay false (k8s.rs sets it)"
  else
    pass "no service-account token in pod" "token file absent"
  fi
}

assert_escalation_rejected() {
  section "(d) Privilege-escalation workload rejected at admission"
  local out rc
  out=$(kc apply -f "$SCRIPT_DIR/manifests/90-escalation-probe.yaml" 2>&1)
  rc=$?
  if [[ $rc -ne 0 && "$out" == *"violates PodSecurity"* ]]; then
    pass "runAsRoot+privileged pod REJECTED" "PSA 'restricted' refused admission"
  elif [[ $rc -ne 0 ]]; then
    fail "runAsRoot+privileged pod REJECTED" "apply failed but not via PodSecurity: ${out:0:120}"
  else
    # Pod was admitted — only acceptable if it actually runs unprivileged.
    fail "runAsRoot+privileged pod REJECTED" "pod was ADMITTED" \
      "Namespace is missing the pod-security.kubernetes.io/enforce=restricted label (see 00-namespace.yaml)"
    kc -n "$NS" delete pod escalation-probe --ignore-not-found >/dev/null 2>&1
  fi
}

# ---- Main ---------------------------------------------------------------------

main() {
  printf "${BLD}Lantern K8s isolation validation${RST} ${DIM}— $(date '+%H:%M:%S')${RST}\n"

  check_tools
  trap teardown EXIT
  create_cluster
  deploy_workload

  assert_egress
  assert_dns
  assert_security_context
  assert_escalation_rejected

  section "Summary"
  if [[ $FAILS -eq 0 ]]; then
    printf "  ${GRN}All assertions passed — K8s Job isolation class validated end-to-end.${RST}\n"
    printf "  ${DIM}Close the corresponding LAUNCH-CHECKLIST.md beta item with this run's output.${RST}\n"
    exit 0
  fi
  printf "  ${RED}%d assertion(s) failed${RST} — follow the → hints above.\n" "$FAILS"
  exit 1
}

main "$@"
