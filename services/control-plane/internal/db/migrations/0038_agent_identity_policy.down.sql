-- Reverts 0038 (ADR 0055). Drops the audit trail too: take a backup first if
-- it must be retained.
ALTER TABLE runtime_vms DROP COLUMN IF EXISTS agent_id;
DROP TRIGGER IF EXISTS agents_default_deny_policy ON agents;
DROP FUNCTION IF EXISTS agent_policies_default_deny();
DROP FUNCTION IF EXISTS agent_identity_audit_verify(UUID);
DROP TABLE IF EXISTS agent_identity_audit CASCADE; -- CASCADE: agent_identity_audit_digest takes its rowtype
DROP FUNCTION IF EXISTS agent_identity_audit_chain();
DROP FUNCTION IF EXISTS agent_identity_audit_immutable();
DROP TABLE IF EXISTS agent_policies;
DROP TABLE IF EXISTS agent_identities;
DROP TABLE IF EXISTS agent_policy_cutover;
