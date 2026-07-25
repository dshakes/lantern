package handlers

import (
	"testing"

	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
)

// SchedulableNodeCount backs /readyz. The failure it guards against is a
// scheduler reporting ready while every Schedule fails FailedPrecondition
// because all nodes are draining (or none ever registered).
func TestSchedulableNodeCount(t *testing.T) {
	t.Run("nil store is not schedulable", func(t *testing.T) {
		if got := SchedulableNodeCount(nil); got != 0 {
			t.Fatalf("nil store: got %d, want 0", got)
		}
	})

	t.Run("no nodes registered", func(t *testing.T) {
		if got := SchedulableNodeCount(cluster.NewInMemoryStore()); got != 0 {
			t.Fatalf("empty store: got %d, want 0", got)
		}
	})

	t.Run("draining nodes do not count", func(t *testing.T) {
		store := cluster.NewInMemoryStore()
		store.UpsertNode(cluster.Node{Name: "a", Draining: true})
		store.UpsertNode(cluster.Node{Name: "b", Draining: true})
		if got := SchedulableNodeCount(store); got != 0 {
			t.Fatalf("all draining: got %d, want 0 — this is the silent-outage case", got)
		}
	})

	t.Run("counts only non-draining", func(t *testing.T) {
		store := cluster.NewInMemoryStore()
		store.UpsertNode(cluster.Node{Name: "a"})
		store.UpsertNode(cluster.Node{Name: "b", Draining: true})
		store.UpsertNode(cluster.Node{Name: "c"})
		if got := SchedulableNodeCount(store); got != 2 {
			t.Fatalf("mixed: got %d, want 2", got)
		}
	})
}
