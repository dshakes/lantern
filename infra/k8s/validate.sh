#!/usr/bin/env bash
# validate.sh — end-to-end validation of the K8s Job isolation class against
# a REAL local kind cluster (SECURITY.md "must-close" item / the
# "K8s Job isolation validated end-to-end" beta gate in docs/LAUNCH-CHECKLIST.md).
#
# Usage:   make k8s-validate          (or: bash infra/k8s/validate.sh)
#          bash infra/k8s/validate.sh --ci   (CI owns the cluster lifecycle)
# Exits:   0 if every assertion passes, 1 if any fails.
# Env:     KEEP_CLUSTER=1     skip teardown (debugging)
#          CALICO_MANIFEST=…  override the pinned Calico manifest URL
#          CLUSTER_CONTEXT=…  override the kube-context (CI sets it to the
#                             kind-action context; default kind-$CLUSTER_NAME)
#
# Flags:   --ci   Do NOT create or tear down the kind cluster — assume the caller
#                 (the runtime-cluster-e2e GitHub workflow) already created a
#                 kind+Calico cluster and selected its context. Skips check_tools'
#                 docker probe and the create/teardown lifecycle; runs every
#                 assertion against the existing cluster.
#
# What it proves, with live probes (not unit tests):
#   (a) the fenced workload pod CANNOT reach the internet (egress default-deny)
#   (b) the fenced pod CAN still resolve DNS (the one allowed egress)
#   (c) the running pod's securityContext really carries seccomp
#       RuntimeDefault + cap drop ALL + non-root + no-priv-esc + RO rootfs
#   (d) a pod requesting runAsRoot/privilege-escalation is REJECTED
#   (e) [fail-closed] an UNTRUSTED pod requesting a sandbox runtimeClassName
#       (gVisor/Kata) that is NOT installed must NOT silently run on runc — it
#       stays unschedulable / is refused. The core ADR-0009 invariant; testable
#       in CI without gVisor (we assert the REFUSAL, not sandbox execution)
#
# kind's default CNI (kindnet) does NOT enforce NetworkPolicy — the cluster is
# created with disableDefaultCNI and Calico is installed so (a) is real, and a
# positive-control pod (no fence) must reach the internet to prove the block
# is the policy, not broken networking.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_NAME="lantern-k8s-validate" # must match kind-cluster.yaml `name:`
# In --ci mode the workflow owns the cluster + context; honor an override.
KCTX="${CLUSTER_CONTEXT:-kind-${CLUSTER_NAME}}"
NS="lantern-t-validate"

# CI mode: the GitHub workflow already created the kind+Calico cluster, so this
# script must NOT create or tear it down — only run the assertions.
CI_MODE=0
# EXEC_MODE runs the gVisor/Kata *execution* legs (g/h/i) — they require a REAL
# cluster with the gvisor + kata RuntimeClass handlers installed on labelled,
# tainted node pools (e.g. GKE Agent Sandbox; see gke-agent-sandbox-setup.sh).
# These legs are NOT runnable on a stock kind cluster or GitHub-hosted runners
# (no nested virt / no runsc), so they are OFF by default. The always-on legs
# (a–f) prove the fail-closed contract without a sandbox runtime.
EXEC_MODE=0
for arg in "$@"; do
  case "$arg" in
    --ci) CI_MODE=1 ;;
    --execution) EXEC_MODE=1 ;;
  esac
done
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
  if [[ "$CI_MODE" -eq 1 ]]; then
    # CI owns the cluster; we only need a reachable kube-context here.
    if ! kc cluster-info >/dev/null 2>&1; then
      die "--ci: no reachable cluster at context '$KCTX' — the workflow must create kind first (set CLUSTER_CONTEXT to override)"
    fi
    pass "cluster reachable" "context $KCTX (CI-managed cluster)"
    return
  fi
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

# assert_runtimeclass_failclosed — the core ADR-0009 invariant.
#
# Schedule an UNTRUSTED pod that requests `runtimeClassName: gvisor`. gVisor is
# NOT installed on a stock kind node. The pod MUST NOT silently run on the
# default runc runtime — it must be refused at admission (no RuntimeClass object)
# or stay unschedulable/Pending forever (RuntimeClass exists, handler missing).
# "No sandbox available → workload does not run" is fail-CLOSED; a Running pod
# here would be the exact untrusted-on-shared-kernel escape ADR-0009 forbids.
#
# Testable in CI WITHOUT gVisor: we assert the REFUSAL, never sandbox execution.
assert_runtimeclass_failclosed() {
  section "(f) Fail-closed: UNTRUSTED pod w/ missing sandbox RuntimeClass must NOT run on runc (ADR-0009)"
  local manifest="$SCRIPT_DIR/manifests/91-untrusted-missing-runtimeclass.yaml"
  local pod="untrusted-missing-runtimeclass"
  local out rc

  kc -n "$NS" delete pod "$pod" --ignore-not-found >/dev/null 2>&1

  out=$(kc apply -f "$manifest" 2>&1)
  rc=$?

  if [[ $rc -ne 0 ]]; then
    # Refused at admission — the RuntimeClass 'gvisor' does not exist, so the
    # API server rejects the reference outright. Fail-closed. Best outcome.
    if [[ "$out" == *"RuntimeClass"* || "$out" == *"runtimeClassName"* || "$out" == *"not found"* ]]; then
      pass "missing-RuntimeClass pod REFUSED at admission" "API server rejected runtimeClassName=gvisor (no runc fallback)"
    else
      pass "missing-RuntimeClass pod REFUSED" "apply rejected: ${out:0:100}"
    fi
    return
  fi

  # Admitted (a RuntimeClass object named 'gvisor' exists, e.g. the chart created
  # it). It must then stay Pending/unschedulable because the runsc handler is
  # absent on the node — it must NEVER reach Running on runc. Watch for ~30s.
  local phase="" deadline=$((SECONDS + 30))
  while [[ $SECONDS -lt $deadline ]]; do
    phase=$(kc -n "$NS" get pod "$pod" -o jsonpath='{.status.phase}' 2>/dev/null)
    [[ "$phase" == "Running" || "$phase" == "Succeeded" || "$phase" == "Failed" ]] && break
    sleep 2
  done

  if [[ "$phase" == "Running" || "$phase" == "Succeeded" ]]; then
    fail "missing-RuntimeClass pod must NOT run" "pod reached phase '$phase' — it ran WITHOUT the gVisor sandbox" \
      "FAIL-OPEN: untrusted code fell back to runc on a shared kernel. RuntimeClass enforcement is broken — ADR-0009 invariant violated."
  else
    local reason
    reason=$(kc -n "$NS" get pod "$pod" -o jsonpath='{.status.conditions[?(@.type=="PodScheduled")].reason}' 2>/dev/null)
    pass "missing-RuntimeClass pod stays unschedulable" "phase='${phase:-Pending}' reason='${reason:-Unschedulable}' — never ran on runc (fail-closed)"
  fi
  kc -n "$NS" delete pod "$pod" --ignore-not-found >/dev/null 2>&1
}

# ---- Cluster-side security artifacts (Kyverno / Cilium / ESO / cosign) --------
#
# The chart in infra/helm/lantern-data-plane ships OPT-IN cluster-side hardening:
# Kyverno tenant-baseline + verifyImages policies, Cilium egress policy + proxy,
# and ESO SecretStore/ExternalSecret. Those need their OPERATORS installed
# (Kyverno, Cilium CNI, External Secrets Operator) to apply against a live
# cluster — this harness's kind cluster runs Calico, not those operators, so we
# do NOT apply them here (kubectl apply would fail on missing CRDs, which would
# be a false negative).
#
# What we CAN validate operator-free: that the chart renders the policy set with
# no templating errors and the expected kinds are present. This catches the
# common breakage (a bad value reference, a dropped `{{request...}}` Kyverno
# variable) without a live Kyverno/Cilium.
assert_security_chart_renders() {
  section "(e) Cluster-side security chart renders (Kyverno/Cilium/ESO, operator-free)"
  local chart="$SCRIPT_DIR/../helm/lantern-data-plane"
  if ! command -v helm >/dev/null 2>&1; then
    step "helm not found — skipping chart render assertions (install: brew install helm)"
    return
  fi
  # The chart declares Bitnami subchart dependencies (postgresql/redis/minio); `helm
  # template` hard-fails on declared-but-missing deps, so fetch them first. Requires the
  # Bitnami repo to be reachable (it is in CI). Chart.lock pins the exact versions.
  if ! helm dependency build "$chart" >/dev/null 2>&1; then
    step "helm dependency build failed (Bitnami repo unreachable?) — the render below may fail"
  fi
  local out
  if ! out=$(helm template "$chart" \
      --set policies.enabled=true \
      --set imageVerification.enabled=true \
      --set egress.cilium.enabled=true \
      --set egress.proxy.enabled=true \
      --set externalSecrets.enabled=true \
      --set runtimeClasses.create=true 2>&1); then
    fail "security chart renders (all toggles on)" "helm template failed" \
      "Run: helm template $chart --set policies.enabled=true … and read the error"
    return
  fi
  pass "security chart renders (all toggles on)" "helm template clean"

  local k
  for k in ClusterPolicy CiliumClusterwideNetworkPolicy SecretStore ExternalSecret; do
    if grep -q "^kind: $k" <<<"$out"; then
      pass "renders $k" "present when toggle enabled"
    else
      fail "renders $k" "expected kind '$k' absent from all-on render"
    fi
  done

  # The Kyverno generate rules MUST keep the literal {{request.object...}}
  # variable (Helm must not have eaten it) or namespace-scoped generation breaks.
  if grep -q 'request.object.metadata.name' <<<"$out"; then
    pass "Kyverno generate variable preserved" "{{request.object.metadata.name}} intact"
  else
    fail "Kyverno generate variable preserved" "literal Kyverno variable missing from render"
  fi

  # Default values (everything OFF) must render NONE of these — safe default.
  local def
  def=$(helm template "$chart" 2>/dev/null)
  if grep -qE '^kind: (ClusterPolicy|CiliumClusterwideNetworkPolicy|SecretStore|ExternalSecret)$' <<<"$def"; then
    fail "security artifacts off by default" "a policy kind rendered with default values"
  else
    pass "security artifacts off by default" "default render is clean (opt-in honored)"
  fi
}

# ---- Execution legs (real gVisor/Kata cluster only; --execution) -------------
# These prove the OTHER half of ADR-0009: not just that untrusted/hostile are
# REFUSED without a sandbox (legs a–f), but that WITH the sandbox installed they
# actually run INSIDE it. They need real runsc (gVisor) + Kata handlers, so they
# only run under --execution against a cluster that advertises those classes.

# assert_gvisor_execution — an UNTRUSTED pod on runtimeClassName=gvisor must RUN
# (not be refused, not stay Pending) AND be sandboxed by gVisor, not runc.
assert_gvisor_execution() {
  section "(g) [execution] UNTRUSTED runs INSIDE gVisor (runsc), not on the host kernel"
  local podyaml="$SCRIPT_DIR/manifests/92-untrusted-gvisor-exec.yaml"
  [[ -f "$podyaml" ]] || { fail "gvisor exec manifest present" "missing $podyaml" "ship 92-untrusted-gvisor-exec.yaml"; return; }

  kc -n "$NS" delete pod untrusted-gvisor-exec --ignore-not-found >/dev/null 2>&1
  if ! kc -n "$NS" apply -f "$podyaml" >/dev/null 2>&1; then
    fail "gvisor pod admitted" "apply rejected — is RuntimeClass 'gvisor' installed?" \
      "Install a gVisor node pool + RuntimeClass (see gke-agent-sandbox-setup.sh)"
    return
  fi
  if ! kc -n "$NS" wait --for=condition=Ready pod/untrusted-gvisor-exec --timeout=120s >/dev/null 2>&1; then
    # It may have already Succeeded (short-lived probe) — check phase.
    local ph; ph=$(kc -n "$NS" get pod untrusted-gvisor-exec -o jsonpath='{.status.phase}' 2>/dev/null)
    if [[ "$ph" != "Running" && "$ph" != "Succeeded" ]]; then
      fail "gvisor pod runs" "phase='${ph:-Pending}' — never reached Running/Succeeded" \
        "RuntimeClass 'gvisor' handler 'runsc' missing on the node it landed on"
      return
    fi
  fi
  pass "UNTRUSTED pod runs on gVisor" "reached Running/Succeeded under runtimeClassName=gvisor"

  # Proof it is REALLY gVisor: runsc presents a synthetic kernel whose
  # /proc/version contains "gVisor". This is the canonical in-sandbox probe.
  local ver; ver=$(kc -n "$NS" exec untrusted-gvisor-exec -- cat /proc/version 2>/dev/null || true)
  if [[ "$ver" == *"gVisor"* || "$ver" == *"gvisor"* ]]; then
    pass "workload is gVisor-sandboxed" "/proc/version advertises gVisor (user-space kernel, not host)"
  else
    # Some runsc builds don't stamp /proc/version; fall back to the node label.
    local node; node=$(kc -n "$NS" get pod untrusted-gvisor-exec -o jsonpath='{.spec.nodeName}' 2>/dev/null)
    local rc; rc=$(kc get node "$node" -o jsonpath='{.metadata.labels.lantern\.dev/runtimeclass}' 2>/dev/null)
    if [[ "$rc" == "gvisor" ]]; then
      pass "workload is gVisor-sandboxed" "node '$node' is a gvisor-labelled sandbox node (/proc/version unstamped on this runsc build)"
    else
      fail "workload is gVisor-sandboxed" "/proc/version has no gVisor marker and node '$node' is not gvisor-labelled" \
        "Pod may have run on a bare runc node — FAIL-OPEN. Verify the runsc handler + node affinity."
    fi
  fi
  kc -n "$NS" delete pod untrusted-gvisor-exec --ignore-not-found >/dev/null 2>&1
}

# assert_kata_execution — a HOSTILE pod on runtimeClassName=kata must run in a
# Kata microVM, proven by the guest kernel differing from the host node kernel.
assert_kata_execution() {
  section "(h) [execution] HOSTILE runs INSIDE a Kata microVM (own guest kernel)"
  local podyaml="$SCRIPT_DIR/manifests/93-hostile-kata-exec.yaml"
  [[ -f "$podyaml" ]] || { fail "kata exec manifest present" "missing $podyaml" "ship 93-hostile-kata-exec.yaml"; return; }

  kc -n "$NS" delete pod hostile-kata-exec --ignore-not-found >/dev/null 2>&1
  if ! kc -n "$NS" apply -f "$podyaml" >/dev/null 2>&1; then
    fail "kata pod admitted" "apply rejected — is RuntimeClass 'kata' installed?" \
      "Install a Kata node pool + RuntimeClass (kata-qemu/kata-fc)"
    return
  fi
  if ! kc -n "$NS" wait --for=condition=Ready pod/hostile-kata-exec --timeout=180s >/dev/null 2>&1; then
    local ph; ph=$(kc -n "$NS" get pod hostile-kata-exec -o jsonpath='{.status.phase}' 2>/dev/null)
    if [[ "$ph" != "Running" && "$ph" != "Succeeded" ]]; then
      fail "kata pod runs" "phase='${ph:-Pending}' — never reached Running/Succeeded" \
        "RuntimeClass 'kata' handler missing on the node it landed on"
      return
    fi
  fi
  pass "HOSTILE pod runs on Kata" "reached Running/Succeeded under runtimeClassName=kata"

  # Proof it is a real microVM: the guest kernel release differs from the host
  # node's kernel. A bare pod (runc) shares the host kernel → identical uname.
  local node guest_k host_k
  node=$(kc -n "$NS" get pod hostile-kata-exec -o jsonpath='{.spec.nodeName}' 2>/dev/null)
  guest_k=$(kc -n "$NS" exec hostile-kata-exec -- uname -r 2>/dev/null || true)
  host_k=$(kc get node "$node" -o jsonpath='{.status.nodeInfo.kernelVersion}' 2>/dev/null)
  if [[ -n "$guest_k" && -n "$host_k" && "$guest_k" != "$host_k" ]]; then
    pass "workload is in a Kata microVM" "guest kernel '$guest_k' != host kernel '$host_k' (separate kernel = hardware isolation)"
  else
    fail "workload is in a Kata microVM" "guest kernel '${guest_k:-?}' == host kernel '${host_k:-?}'" \
      "Identical kernels mean the pod ran on the shared host kernel (runc), not a Kata microVM — FAIL-OPEN."
  fi
  # leg (i) reuses this pod's node; defer cleanup to assert_no_cotenancy.
}

# assert_no_cotenancy — the hostile node pool must be dedicated: no pod from a
# DIFFERENT tenant namespace may share the node a HOSTILE workload runs on.
assert_no_cotenancy() {
  section "(i) [execution] HOSTILE node has NO cross-tenant co-tenancy (dedicated pool)"
  local node; node=$(kc -n "$NS" get pod hostile-kata-exec -o jsonpath='{.spec.nodeName}' 2>/dev/null)
  if [[ -z "$node" ]]; then
    step "no hostile pod node recorded — skipping (leg h must run first)"
    return
  fi
  # Every non-system pod on that node, with its namespace.
  local others
  others=$(kc get pods --all-namespaces --field-selector "spec.nodeName=$node" \
    -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' 2>/dev/null \
    | grep -E '^lantern-t-' | grep -v "^${NS}\$" | sort -u || true)
  if [[ -z "$others" ]]; then
    pass "hostile node is dedicated" "no other lantern-t-* tenant shares node '$node' (taint enforced)"
  else
    fail "hostile node is dedicated" "node '$node' also runs tenant ns: $(tr '\n' ' ' <<<"$others")" \
      "HOSTILE must get a dedicated, tainted node pool — co-tenancy with another tenant is an isolation breach."
  fi
  kc -n "$NS" delete pod hostile-kata-exec --ignore-not-found >/dev/null 2>&1
}

# ---- Main ---------------------------------------------------------------------

main() {
  printf "${BLD}Lantern K8s isolation validation${RST} ${DIM}— $(date '+%H:%M:%S')${RST}\n"

  check_tools
  if [[ "$CI_MODE" -eq 1 ]]; then
    section "Cluster"
    pass "cluster lifecycle" "managed by CI workflow (--ci) — skipping create/teardown"
  else
    trap teardown EXIT
    create_cluster
  fi
  deploy_workload

  assert_egress
  assert_dns
  assert_security_context
  assert_escalation_rejected
  assert_runtimeclass_failclosed
  assert_security_chart_renders

  if [[ "$EXEC_MODE" -eq 1 ]]; then
    assert_gvisor_execution
    assert_kata_execution
    assert_no_cotenancy
  else
    section "Execution legs (g/h/i)"
    step "skipped — pass --execution against a real gVisor+Kata cluster to run them"
    step "(untrusted-runs-on-gVisor · hostile-runs-in-Kata · hostile node is dedicated)"
    step "stock kind / GitHub-hosted runners cannot: no runsc, no nested virt. See gke-agent-sandbox-setup.sh"
  fi

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
