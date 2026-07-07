package scheduler

import (
	"os"
	"time"

	"go.uber.org/zap"
)

// ResolveLocation resolves an IANA timezone string to a *time.Location.
// Priority: tz (if non-empty) → LANTERN_DEFAULT_TIMEZONE env → time.UTC.
// An invalid tz string logs a warning and falls back to the next level.
// Never returns nil.
func ResolveLocation(tz string) *time.Location {
	if tz != "" {
		loc, err := time.LoadLocation(tz)
		if err == nil {
			return loc
		}
		zap.L().Warn("scheduler.ResolveLocation: invalid timezone, falling back",
			zap.String("tz", tz), zap.Error(err))
	}
	if env := os.Getenv("LANTERN_DEFAULT_TIMEZONE"); env != "" {
		loc, err := time.LoadLocation(env)
		if err == nil {
			return loc
		}
		zap.L().Warn("scheduler.ResolveLocation: invalid LANTERN_DEFAULT_TIMEZONE, using UTC",
			zap.String("tz", env), zap.Error(err))
	}
	return time.UTC
}
