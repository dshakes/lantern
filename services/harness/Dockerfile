# pal-harness — statically linked PID 1 for PAL microVMs.
#
# Build a musl-static binary so the harness can run in a minimal rootfs
# (no glibc loader, no shared libs). The final image is alpine-based and
# exposes /run/pal as a mount point for sockets the workload reads.

#
# Build from the REPO ROOT — build.rs compiles ../../packages/proto:
#   docker build -f services/harness/Dockerfile .
# (Dockerfile.dockerignore next to this file trims the context to the two
# directories the build needs.)

# 1.85 cannot build the current Cargo.lock; protoc is required by build.rs.
FROM rust:1.94-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static protobuf-dev protoc
WORKDIR /app
COPY packages/proto packages/proto
COPY services/harness services/harness
WORKDIR /app/services/harness
# musl target is the default on alpine; --release pulls LTO + strip via Cargo.toml.
RUN cargo build --release --bin pal-harness

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && \
    addgroup -S harness && adduser -S harness -G harness && \
    mkdir -p /run/pal && chown harness:harness /run/pal

COPY --from=builder /app/services/harness/target/release/pal-harness /usr/local/bin/pal-harness

# Expose the runtime socket directory as a mount point. The VM image
# builder bind-mounts a tmpfs over this so secrets/otlp sockets are wiped
# on every boot.
VOLUME ["/run/pal"]

# The harness is PID 1 inside the microVM. Caller MUST set:
#   PAL_VM_ID            — globally unique vm id (string)
#   PAL_MANAGER_ADDR     — host:port of runtime-manager (e.g. 10.0.0.1:50054)
#   PAL_WORKLOAD_CMD     — space-separated argv of the workload binary
#                              (or PAL_WORKLOAD_ARGV, a JSON array; in a
#                              Firecracker VM both come from spawn.json)
#   PAL_WORKLOAD_UID     — uid the workload runs as (fatal if unset in prod)
# Optional:
#   PAL_WORKLOAD_GID     — gid for the workload (default: the uid)
#   (file tools are confined to the fixed /workspace; not env-configurable)
#   PAL_DECLARED_SECRETS — JSON array of {env_name, secret_uri}
#   PAL_MAX_RESTARTS     — supervisor restart budget (default 5)
#   PAL_DRAIN_GRACE_SECS — SIGTERM→SIGKILL window (default 25)
#   PAL_EGRESS_BIND      — proxy bind addr (default 127.0.0.1:3128)
#   PAL_SECRETS_SOCKET   — unix socket path (default /run/pal/secrets.sock)
#   PAL_OTLP_SOCKET      — unix socket path (default /run/pal/otlp.sock)
ENTRYPOINT ["/usr/local/bin/pal-harness"]
