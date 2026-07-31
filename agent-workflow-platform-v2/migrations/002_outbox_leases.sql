ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

CREATE INDEX IF NOT EXISTS idx_outbox_claimable
  ON outbox_events(outbox_id, locked_at)
  WHERE published_at IS NULL;
