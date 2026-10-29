FROM golang:1.23-alpine AS builder
WORKDIR /app

# Build context is the repo root (docker build -f services/scheduler/Dockerfile .):
# the module replaces local modules under ../../ that must be in the context.
COPY gen/go/ /app/gen/go/
COPY packages/palenv/ /app/packages/palenv/
COPY services/scheduler/ /app/services/scheduler/
WORKDIR /app/services/scheduler
RUN go mod download

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /scheduler ./cmd/server

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /scheduler /usr/local/bin/scheduler

EXPOSE 50058 8088
ENTRYPOINT ["scheduler"]
