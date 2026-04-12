FROM golang:1.23-alpine AS builder
WORKDIR /app

# Copy dependency files first for layer caching.
COPY go.mod go.sum ./
RUN go mod download

# Copy the rest of the source.
COPY . .

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /control-plane ./cmd/server

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /control-plane /usr/local/bin/control-plane

EXPOSE 50051 8080
ENTRYPOINT ["control-plane"]
