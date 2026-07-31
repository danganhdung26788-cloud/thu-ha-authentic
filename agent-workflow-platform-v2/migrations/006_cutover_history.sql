CREATE TABLE IF NOT EXISTS cutover_history (
  transition_id text PRIMARY KEY,
  from_phase text NOT NULL CHECK (from_phase IN ('V1_ONLY','SHADOW','DUAL_RUN','V2_PRIMARY','V1_DECOMMISSIONED')),
  to_phase text NOT NULL CHECK (to_phase IN ('V1_ONLY','SHADOW','DUAL_RUN','V2_PRIMARY','V1_DECOMMISSIONED')),
  changed_by text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  rollback_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cutover_history_created_at
  ON cutover_history(created_at DESC);
