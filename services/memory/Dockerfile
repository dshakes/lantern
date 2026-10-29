FROM golang:1.26.10-alpine AS builder
# Build context is the repo root (replace ../../gen/go lives outside the service dir).
COPY gen/go/ /app/gen/go/
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
