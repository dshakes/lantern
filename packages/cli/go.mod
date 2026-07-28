module github.com/dshakes/lantern/packages/cli

go 1.25.0

toolchain go1.26.5

require (
	github.com/dshakes/lantern/gen/go v0.0.0
	github.com/spf13/cobra v1.8.1
	golang.org/x/term v0.42.0
	google.golang.org/grpc v1.82.1
	google.golang.org/protobuf v1.36.11
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.5 // indirect
	golang.org/x/net v0.53.0 // indirect
	golang.org/x/sys v0.43.0 // indirect
	golang.org/x/text v0.39.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260414002931-afd174a4e478 // indirect
)

replace github.com/dshakes/lantern/gen/go => ../../gen/go
