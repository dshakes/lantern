FROM golang:1.23-alpine AS builder
WORKDIR /app

# Build context is the repo root (docker build -f services/data-plane-agent/Dockerfile .):
# the module replaces local modules under ../../ that must be in the context.
COPY gen/go/ /app/gen/go/
COPY packages/palenv/ /app/packages/palenv/
COPY services/data-plane-agent/ /app/services/data-plane-agent/
WORKDIR /app/services/data-plane-agent
RUN go mod download

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /data-plane-agent ./cmd/agent

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /data-plane-agent /usr/local/bin/data-plane-agent

EXPOSE 8090
ENTRYPOINT ["data-plane-agent"]
