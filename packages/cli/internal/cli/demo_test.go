package cli

import (
	"reflect"
	"testing"
)

func TestDemoComposeArgs(t *testing.T) {
	got := demoComposeArgs("/r", "up", "-d")
	want := []string{"compose",
		"-f", "/r/infra/docker/docker-compose.yml",
		"-f", "/r/infra/docker/docker-compose.kiosk.yml",
		"-p", "lantern-demo", "up", "-d"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestDemoCommandRegistered(t *testing.T) {
	for _, c := range NewRootCommand("t", "c", "d").Commands() {
		if c.Name() == "demo" {
			return
		}
	}
	t.Fatal("demo not registered on root")
}
