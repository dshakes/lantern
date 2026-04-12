FROM golang:1.23-alpine AS builder
WORKDIR /app

# Copy the gen/go module that we depend on via replace directive.
COPY gen/go/ /app/gen/go/

# Copy the control-plane service source.
COPY services/control-plane/ /app/services/control-plane/

WORKDIR /app/services/control-plane

# Download dependencies.
RUN go mod download

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /control-plane ./cmd/server

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /control-plane /usr/local/bin/control-plane

EXPOSE 50051 8080
ENTRYPOINT ["control-plane"]
