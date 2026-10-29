FROM golang:1.23-alpine AS builder
WORKDIR /app

# Build context is the repo root (docker build -f services/memory/Dockerfile .):
# the module replaces local modules under ../../ that must be in the context.
COPY packages/palenv/ /app/packages/palenv/
COPY services/memory/ /app/services/memory/
WORKDIR /app/services/memory
RUN go mod download

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /memory ./cmd/server

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /memory /usr/local/bin/memory

EXPOSE 50055 8085
ENTRYPOINT ["memory"]
