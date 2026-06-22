module github.com/dshakes/lantern/services/data-plane-agent

go 1.23

toolchain go1.26.4

require (
	github.com/grpc-ecosystem/go-grpc-middleware/v2 v2.3.1
	go.opentelemetry.io/otel v1.35.0
	go.opentelemetry.io/otel/trace v1.35.0
	go.uber.org/zap v1.27.0
	google.golang.org/grpc v1.72.0
	google.golang.org/protobuf v1.36.6
)

require (
	github.com/dshakes/lantern/gen/go v0.0.0
)
