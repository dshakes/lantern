FROM rust:1.94-slim AS builder
# openssl-sys needs the system OpenSSL headers + pkg-config to compile.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Context is the repo root (see build-images.yml): pal_env is a path dependency
# at ../../packages/pal-env-rs, so the repo layout is preserved.
COPY packages/pal-env-rs packages/pal-env-rs
COPY services/gateway services/gateway
WORKDIR /app/services/gateway
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/services/gateway/target/release/lantern-gateway /usr/local/bin/
EXPOSE 8443
CMD ["lantern-gateway"]
