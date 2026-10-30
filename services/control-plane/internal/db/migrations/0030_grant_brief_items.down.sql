-- Reverse of 0030_grant_brief_items.up.sql
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE brief_items FROM lantern_app;
