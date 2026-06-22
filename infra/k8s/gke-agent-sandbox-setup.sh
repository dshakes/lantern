#!/usr/bin/env bash
# gke-agent-sandbox-setup.sh — provision a GKE cluster that can run Lantern's
# gVisor/Kata EXECUTION legs (validate.sh --execution).
#
# GitHub-hosted CI cannot run these legs (no runsc, no nested virt). This script
# stands up a real cluster with:
#   - a gVisor (GKE Sandbox) node pool, labelled lantern.dev/runtimeclass=gvisor
#   - a Kata node pool (or a second sandbox pool), labelled & TAINTED for hostile
#   - the gvisor + kata RuntimeClass objects
#   - the lantern-t-validate namespace (PSA restricted)
# then prints the KUBECONFIG you feed to the cluster-e2e execution job.
#
# Usage:
#   PROJECT=my-gcp-project REGION=us-central1 ./gke-agent-sandbox-setup.sh
#   # then:  KUBECONFIG=... infra/k8s/validate.sh --ci --execution
#
# Notes:
#   - GKE Sandbox provides gVisor (runsc) as a first-class node-pool feature
#     (--sandbox type=gvisor). Kata on GKE is not GA; on clusters without a Kata
#     handler the (h)/(i) legs will correctly fail-closed — run them on a
#     self-hosted cluster with kata-deploy if you need the Kata path. The gVisor
#     leg (g) runs on stock GKE Sandbox today.
#   - This script only CREATES infra; it never runs the assertions. It is not
#     run by CI — an operator runs it once, stores the kubeconfig as a secret.
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT=<gcp-project-id>}"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-lantern-sandbox-e2e}"
GVISOR_POOL="${GVISOR_POOL:-gvisor-pool}"
KATA_POOL="${KATA_POOL:-kata-pool}"
MACHINE="${MACHINE:-e2-standard-4}"

echo "==> Creating GKE cluster '$CLUSTER' in $PROJECT/$REGION"
gcloud container clusters create "$CLUSTER" \
  --project "$PROJECT" --region "$REGION" \
  --release-channel regular \
  --num-nodes 1 --machine-type "$MACHINE" \
  --enable-network-policy \
  --workload-pool "${PROJECT}.svc.id.goog"

echo "==> Adding gVisor (GKE Sandbox) node pool '$GVISOR_POOL'"
gcloud container node-pools create "$GVISOR_POOL" \
  --project "$PROJECT" --region "$REGION" --cluster "$CLUSTER" \
  --machine-type "$MACHINE" --num-nodes 1 \
  --sandbox type=gvisor \
  --node-labels "lantern.dev/runtimeclass=gvisor"

echo "==> Adding dedicated Kata/hostile node pool '$KATA_POOL' (labelled + tainted)"
# On GKE this pool also runs gVisor sandbox; on a self-hosted cluster swap in a
# kata-deploy node. The taint makes it a dedicated pool (no co-tenancy).
gcloud container node-pools create "$KATA_POOL" \
  --project "$PROJECT" --region "$REGION" --cluster "$CLUSTER" \
  --machine-type "$MACHINE" --num-nodes 1 \
  --sandbox type=gvisor \
  --node-labels "lantern.dev/runtimeclass=kata" \
  --node-taints "lantern.dev/runtimeclass=kata:NoSchedule"

echo "==> Fetching cluster credentials"
gcloud container clusters get-credentials "$CLUSTER" \
  --project "$PROJECT" --region "$REGION"

echo "==> Installing RuntimeClasses (gvisor + kata)"
# GKE Sandbox registers the 'gvisor' handler; we create the RuntimeClass objects
# Lantern's pods reference. For a real Kata cluster, set handler: kata-qemu.
kubectl apply -f - <<'YAML'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: gvisor
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata
# On GKE Sandbox this maps to gvisor; on a kata-deploy cluster use handler: kata-qemu.
handler: gvisor
scheduling:
  nodeSelector:
    lantern.dev/runtimeclass: kata
  tolerations:
    - key: lantern.dev/runtimeclass
      operator: Equal
      value: kata
      effect: NoSchedule
YAML

echo "==> Creating the validation namespace (PSA restricted)"
kubectl apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: lantern-t-validate
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
YAML

cat <<EOF

==> Done. The cluster is ready for the execution legs.

Run them locally:
  infra/k8s/validate.sh --ci --execution

Wire them into CI (runtime-cluster-e2e.yml, execution job):
  1. Export a kubeconfig limited to this cluster, base64 it:
       gcloud container clusters get-credentials $CLUSTER --project $PROJECT --region $REGION
       base64 -w0 ~/.kube/config   # (macOS: base64 ~/.kube/config | tr -d '\n')
  2. Store it as the repo secret  CLUSTER_E2E_KUBECONFIG_B64
  3. Run the workflow:  gh workflow run "runtime · cluster e2e (kind + calico)"
     (the execution job runs only when that secret is present)

Tear down when finished:
  gcloud container clusters delete $CLUSTER --project $PROJECT --region $REGION
EOF
