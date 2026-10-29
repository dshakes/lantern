FROM golang:1.23-alpine AS builder
WORKDIR /app

# Build context is the repo root (docker build -f services/billing/Dockerfile .):
# the module replaces local modules under ../../ that must be in the context.
COPY gen/go/ /app/gen/go/
COPY packages/palenv/ /app/packages/palenv/
COPY services/billing/ /app/services/billing/
WORKDIR /app/services/billing
RUN go mod download

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /billing ./cmd/server

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /billing /usr/local/bin/billing

EXPOSE 50057 8087
ENTRYPOINT ["billing"]
