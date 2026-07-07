package handlers

import (
	"time"

	"github.com/dshakes/lantern/services/control-plane/internal/scheduler"
)

// usageDate returns today's date string ("2006-01-02") in the deployment
// timezone (LANTERN_DEFAULT_TIMEZONE, UTC when unset). All agent_usage_daily
// reads and writes MUST call this so bucket keys stay consistent.
func usageDate(now time.Time) string {
	return now.In(scheduler.ResolveLocation("")).Format("2006-01-02")
}
