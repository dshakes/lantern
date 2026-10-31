#!/bin/bash
# Sandbox stand-in for `docker compose up -d minio`: recreate the throwaway
# MinIO container on the SAME volume with the root credentials the CURRENT
# checkout's compose file declares — exactly what compose does when the env changes.
set -euo pipefail
f="${REPO_DIR:?}/${COMPOSE_FILE:-infra/docker/docker-compose.yml}"
u="$(sed -nE 's/^ *MINIO_ROOT_USER: *"?([^" ]+)"?.*/\1/p' "$f" | head -1)"
p="$(sed -nE 's/^ *MINIO_ROOT_PASSWORD: *"?([^" ]+)"?.*/\1/p' "$f" | head -1)"
"$STUB_REAL_DOCKER" rm -f "$STUB_MINIO_CONTAINER" >/dev/null
"$STUB_REAL_DOCKER" run -d --name "$STUB_MINIO_CONTAINER" -v "$STUB_MINIO_VOLUME:/data" \
  -e MINIO_ROOT_USER="$u" -e MINIO_ROOT_PASSWORD="$p" "$STUB_MINIO_IMAGE" server /data >/dev/null
