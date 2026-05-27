FROM golang:1.23-alpine AS builder
WORKDIR /app

# The scheduler module replaces ../../gen/go locally, so the build
# context needs to include both the gen/go module and this service.
# We expect the build to be run from the repo root with:
#   docker build -f services/runtime-scheduler/Dockerfile .
COPY gen/go /workspace/gen/go
COPY services/runtime-scheduler /workspace/services/runtime-scheduler

WORKDIR /workspace/services/runtime-scheduler
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /scheduler ./cmd/scheduler

# -------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /scheduler /usr/local/bin/runtime-scheduler

EXPOSE 50055 8085
ENTRYPOINT ["runtime-scheduler"]
