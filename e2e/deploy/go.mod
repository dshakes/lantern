module github.com/dshakes/lantern/e2e/deploy

go 1.23

toolchain go1.26.6

require github.com/dshakes/lantern/e2e/internal/e2ekit v0.0.0

replace github.com/dshakes/lantern/e2e/internal/e2ekit => ../internal/e2ekit
