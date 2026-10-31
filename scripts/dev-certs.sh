#!/usr/bin/env bash
# dev-certs — local PKI for internal gRPC mTLS (ADR 0043). DEV ONLY.
#
# Two separate CAs, mirroring the Helm chart:
#   service/  the service-mesh CA + one identity per service (serverAuth +
#             clientAuth, DNS SANs for compose/k8s names + localhost, and a
#             SPIFFE URI SAN spiffe://<trust-domain>/svc/<name>).
#             → PAL_GRPC_TLS_CA / _CERT / _KEY
#   manager/  the runtime-manager CA (it also signs per-VM guest certs, so it
#             is deliberately NOT the service CA) + the manager's server cert
#             and a client cert for its callers.
#             → PAL_MANAGER_TLS_* on the manager,
#               PAL_RUNTIME_MANAGER_TLS_* on its callers
#
# Usage: scripts/dev-certs.sh [out-dir]   (default .dev-certs; idempotent: it
# regenerates everything). Prints the env to export for one service.
set -euo pipefail

out="${1:-.dev-certs}"
td="${PAL_TRUST_DOMAIN:-pal.internal}"
days=30
services=(control-plane workflow-engine model-router runtime-scheduler gateway surface-gateway data-plane-agent scheduler)

command -v openssl >/dev/null || { echo "dev-certs: openssl is required" >&2; exit 1; }
rm -rf "$out"
mkdir -p "$out/service" "$out/manager"
chmod 700 "$out"

mkca() { # dir cn
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days "$days" \
    -subj "/O=PAL dev/CN=$2" -keyout "$1/ca.key" -out "$1/ca.crt" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}

mkleaf() { # cadir name san-ext
  local d="$1/$2"
  mkdir -p "$d"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/O=PAL dev/CN=$2" \
    -keyout "$d/tls.key" -out "$d/tls.csr" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=%s\n' "$3" >"$d/ext"
  openssl x509 -req -in "$d/tls.csr" -CA "$1/ca.crt" -CAkey "$1/ca.key" -CAcreateserial \
    -days "$days" -extfile "$d/ext" -out "$d/tls.crt" 2>/dev/null
  cp "$1/ca.crt" "$d/ca.crt"
  rm -f "$d/tls.csr" "$d/ext"
  chmod 600 "$d/tls.key"
}

mkca "$out/service" "PAL dev service CA"
for s in "${services[@]}"; do
  mkleaf "$out/service" "$s" "DNS:$s,DNS:pal-$s,DNS:localhost,IP:127.0.0.1,URI:spiffe://$td/svc/$s"
done

mkca "$out/manager" "PAL dev runtime-manager CA"
mkleaf "$out/manager" runtime-manager "DNS:runtime-manager,DNS:pal-runtime-manager,DNS:localhost,IP:127.0.0.1"
mkleaf "$out/manager" manager-client "DNS:manager-client,URI:spiffe://$td/svc/manager-client"

abs="$(cd "$out" && pwd)"
cat <<EOF
dev-certs: wrote $abs (valid $days days; DEV ONLY — never mount these in a real cluster)

# e.g. the model-router, accepting only the control-plane and workflow-engine:
export PAL_GRPC_TLS_CA=$abs/service/model-router/ca.crt
export PAL_GRPC_TLS_CERT=$abs/service/model-router/tls.crt
export PAL_GRPC_TLS_KEY=$abs/service/model-router/tls.key
export PAL_GRPC_TLS_ALLOWED_PEERS=spiffe://$td/svc/control-plane,spiffe://$td/svc/workflow-engine
EOF
