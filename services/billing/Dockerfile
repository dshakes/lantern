FROM golang:1.26.10-alpine AS builder
# Build context is the repo root (replace ../../gen/go lives outside the service dir).
COPY gen/go/ /app/gen/go/
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
