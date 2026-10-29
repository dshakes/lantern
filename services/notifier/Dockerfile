FROM golang:1.26.10-alpine AS builder
# Build context is the repo root (replace ../../gen/go lives outside the service dir).
COPY gen/go/ /app/gen/go/
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
