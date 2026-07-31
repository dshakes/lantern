FROM rust:1.94-slim AS builder
# openssl-sys needs the system OpenSSL headers + pkg-config; tonic-build/prost
# need protoc (protobuf-compiler). libprotobuf-dev ships the well-known
# google/protobuf/*.proto files under /usr/include that runtime.proto imports.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev protobuf-compiler libprotobuf-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# build.rs reads ../../packages/proto/lantern/v1/runtime.proto, so the build
# context is the repo root (see build-images.yml) and we preserve that layout.
COPY packages/proto/ /app/packages/proto/
COPY services/runtime-manager/ /app/services/runtime-manager/
WORKDIR /app/services/runtime-manager
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/services/runtime-manager/target/release/lantern-runtime-manager /usr/local/bin/
EXPOSE 50054
CMD ["lantern-runtime-manager"]
