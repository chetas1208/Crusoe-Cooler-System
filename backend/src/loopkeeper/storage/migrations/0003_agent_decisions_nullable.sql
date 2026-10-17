-- Codifies the relaxations that were applied by hand to the live Neon database (DECISIONS 31): PgDecisionStore writes the full decision
-- record, so the columns it fills later (or never) must be nullable. Idempotent: DROP NOT NULL on a nullable column is a no-op.
ALTER TABLE agent_decisions ALTER COLUMN decision DROP NOT NULL;
ALTER TABLE agent_decisions ALTER COLUMN evidence_ids DROP NOT NULL;
ALTER TABLE agent_decisions ALTER COLUMN model DROP NOT NULL;
ALTER TABLE agent_decisions ALTER COLUMN tick DROP NOT NULL;
ALTER TABLE agent_state_blobs ALTER COLUMN updated_at DROP NOT NULL;
