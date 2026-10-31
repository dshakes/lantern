FROM golang:1.26.10-alpine AS builder
# Build context is the repo root (replace ../../gen/go lives outside the service dir).
COPY gen/go/ /app/gen/go/
COPY packages/grpctls/ /app/packages/grpctls/
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
