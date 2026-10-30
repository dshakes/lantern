FROM rust:1.94-slim AS builder
# openssl-sys needs the system OpenSSL headers + pkg-config to compile.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/pal-grpc-tls-rs packages/pal-grpc-tls-rs
COPY services/gateway services/gateway
WORKDIR /app/services/gateway
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/services/gateway/target/release/pal-gateway /usr/local/bin/
EXPOSE 8443
CMD ["pal-gateway"]
