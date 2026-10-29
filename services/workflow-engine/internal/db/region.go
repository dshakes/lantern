package db

import (
	"fmt"
	"os"
	"regexp"
	"strconv"

	"github.com/jackc/pgx/v5"
)

var regionRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// ApplyRegionSession stamps the multi-region session GUCs (ADR 0046) on every
// connection opened with cc: `pal.region` from PAL_REGION and
// `pal.fence_epoch` from PAL_FENCE_EPOCH. Both unset (single-region) adds
// nothing. It mirrors the control-plane's region.Config.ApplyPgSession.
//
// The engine needs this whenever it shares the control-plane's database: once
// the region fence is armed there, the database rejects the engine's writes to
// runs / run_locks / journal_events unless they carry the current epoch. A
// malformed value is an error so a typo can't run the engine unfenced.
func ApplyRegionSession(cc *pgx.ConnConfig) error {
	if r := os.Getenv("PAL_REGION"); r != "" {
		if !regionRE.MatchString(r) {
			return fmt.Errorf("PAL_REGION %q: want lowercase [a-z0-9-], 1-63 chars", r)
		}
		cc.RuntimeParams["pal.region"] = r
	}
	if e := os.Getenv("PAL_FENCE_EPOCH"); e != "" {
		n, err := strconv.ParseInt(e, 10, 64)
		if err != nil || n <= 0 {
			return fmt.Errorf("PAL_FENCE_EPOCH %q: want a positive integer", e)
		}
		cc.RuntimeParams["pal.fence_epoch"] = strconv.FormatInt(n, 10)
	}
	return nil
}
