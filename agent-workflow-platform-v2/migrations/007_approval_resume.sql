ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_approved_actions_ready
  ON approvals(task_id, decided_at)
  WHERE status = 'APPROVED' AND executed_at IS NULL;
