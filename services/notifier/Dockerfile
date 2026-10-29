FROM golang:1.23-alpine AS builder
WORKDIR /app

# Build context is the repo root (docker build -f services/notifier/Dockerfile .):
# the module replaces local modules under ../../ that must be in the context.
COPY packages/palenv/ /app/packages/palenv/
COPY services/notifier/ /app/services/notifier/
WORKDIR /app/services/notifier
RUN go mod download

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /notifier ./cmd/server

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /notifier /usr/local/bin/notifier

EXPOSE 50056 8086
ENTRYPOINT ["notifier"]
