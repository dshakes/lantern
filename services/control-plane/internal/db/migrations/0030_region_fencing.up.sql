-- 0030_region_fencing — multi-region enablers (ADR 0046).
--
-- APPEND-ONLY and INERT BY DEFAULT. Nothing here changes behaviour for a
-- single-region deployment:
--   * the new `region` columns default to the session GUC `pal.region`, which
--     is only set when PAL_REGION is configured — otherwise NULL;
--   * the fence trigger is a no-op until an operator ARMS it by inserting the
--     single region_fence row (docs/runbooks/region-failover.md).
--
-- Fencing model. region_fence holds the cluster's current epoch. Every service
-- process connects with the session GUC `pal.fence_epoch` (from
-- PAL_FENCE_EPOCH). Once armed, any write to the run-execution tables from a
-- session whose epoch is missing or differs from the current epoch is REJECTED
-- in the database (SQLSTATE 55000, message prefix "pal_fence:"). After a
-- failover the operator bumps the epoch, so a stale primary that can still
-- reach the promoted database cannot renew a lease, append to a journal, or
-- move a run's state: its writes fail at the DB, not in application code it
-- may be running an old version of.

ALTER TABLE runs           ADD COLUMN IF NOT EXISTS region TEXT DEFAULT NULLIF(current_setting('pal.region', true), '');
ALTER TABLE journal_events ADD COLUMN IF NOT EXISTS region TEXT DEFAULT NULLIF(current_setting('pal.region', true), '');
ALTER TABLE run_locks      ADD COLUMN IF NOT EXISTS region TEXT DEFAULT NULLIF(current_setting('pal.region', true), '');
ALTER TABLE run_locks      ADD COLUMN IF NOT EXISTS fence_epoch BIGINT;

CREATE TABLE IF NOT EXISTS region_fence (
    singleton     BOOLEAN     PRIMARY KEY DEFAULT true CHECK (singleton),
    epoch         BIGINT      NOT NULL CHECK (epoch > 0),
    active_region TEXT        NOT NULL CHECK (active_region ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pal_current_fence_epoch returns the armed epoch, or NULL when unarmed.
-- SECURITY DEFINER so the restricted lantern_app role (RLS enforcement) can
-- evaluate it without a grant on region_fence; search_path pinned.
CREATE OR REPLACE FUNCTION pal_current_fence_epoch() RETURNS BIGINT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT epoch FROM public.region_fence WHERE singleton
$$;

CREATE OR REPLACE FUNCTION pal_fence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    cur  BIGINT := public.pal_current_fence_epoch();
    mine TEXT   := NULLIF(current_setting('pal.fence_epoch', true), '');
BEGIN
    IF cur IS NULL THEN
        -- Unarmed (single-region default): allow, stamp nothing.
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF mine IS NULL OR mine !~ '^[0-9]{1,18}$' OR mine::BIGINT <> cur THEN
        RAISE EXCEPTION 'pal_fence: write to % rejected: session epoch % is not the current epoch %',
            TG_TABLE_NAME, COALESCE(mine, '<unset>'), cur
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF TG_TABLE_NAME = 'run_locks' THEN
        NEW.fence_epoch := cur;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS pal_fence_guard ON runs;
CREATE TRIGGER pal_fence_guard BEFORE INSERT OR UPDATE ON runs
    FOR EACH ROW EXECUTE FUNCTION pal_fence_guard();

DROP TRIGGER IF EXISTS pal_fence_guard ON journal_events;
CREATE TRIGGER pal_fence_guard BEFORE INSERT OR UPDATE ON journal_events
    FOR EACH ROW EXECUTE FUNCTION pal_fence_guard();

DROP TRIGGER IF EXISTS pal_fence_guard ON run_locks;
CREATE TRIGGER pal_fence_guard BEFORE INSERT OR UPDATE OR DELETE ON run_locks
    FOR EACH ROW EXECUTE FUNCTION pal_fence_guard();
