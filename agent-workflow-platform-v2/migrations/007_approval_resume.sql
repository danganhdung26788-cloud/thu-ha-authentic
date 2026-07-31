ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS resume_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resume_claimed_by text,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_approved_actions_ready
  ON approvals(task_id, decided_at, resume_claimed_at)
  WHERE status = 'APPROVED' AND executed_at IS NULL;
