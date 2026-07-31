CREATE TABLE IF NOT EXISTS shadow_runs (
  shadow_run_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  owner_id text NOT NULL,
  workspace_id text NOT NULL,
  v1_result jsonb NOT NULL,
  v2_result jsonb NOT NULL,
  comparison jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('MATCH','ACCEPTABLE_DIFFERENCE','MISMATCH','ERROR')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_owner_workspace
  ON shadow_runs(owner_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cutover_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  phase text NOT NULL CHECK (phase IN ('V1_ONLY','SHADOW','DUAL_RUN','V2_PRIMARY','V1_DECOMMISSIONED')),
  changed_by text NOT NULL,
  reason text NOT NULL,
  rollback_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cutover_state(singleton, phase, changed_by, reason)
VALUES(true, 'V1_ONLY', 'SYSTEM', 'Initial state: V1 remains authoritative.')
ON CONFLICT(singleton) DO NOTHING;
