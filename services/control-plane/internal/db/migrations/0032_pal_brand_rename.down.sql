-- Reverses pal_brand_rename.up.sql (ADR 0032). The value rewrite (envelope
-- marker, secret refs, env keys) is not reversed: the PAL-era code is the only
-- reader of those rows, and a blind reverse replace could touch values written
-- after the rename.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pal_app')
	   AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lantern_app') THEN
		ALTER ROLE pal_app RENAME TO lantern_app;
	END IF;
END
$$;

UPDATE tenants
SET k8s_namespace = 'lantern-t-' || substr(k8s_namespace, length('pal-t-') + 1)
WHERE k8s_namespace LIKE 'pal-t-%';
