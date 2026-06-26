-- P0.4: agents are private by default. Only agents explicitly marked is_public
-- are exposed to non-owners via the A2A card / well-known directory / invoke
-- endpoints. Without this column those endpoints leaked every tenant's agents
-- to anonymous callers (unauthenticated cross-tenant disclosure).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;
