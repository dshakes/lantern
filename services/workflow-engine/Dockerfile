FROM golang:1.23-alpine AS builder
WORKDIR /app

# Copy the gen/go module that we depend on via the replace directive.
# (Build context is the repo root — see infra/docker/docker-compose.yml.)
COPY gen/go/ /app/gen/go/

# Copy the workflow-engine service source.
COPY services/workflow-engine/ /app/services/workflow-engine/

WORKDIR /app/services/workflow-engine

# Download dependencies.
RUN go mod download

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /workflow-engine ./cmd/server

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /workflow-engine /usr/local/bin/workflow-engine

EXPOSE 50052 8081
ENTRYPOINT ["workflow-engine"]
