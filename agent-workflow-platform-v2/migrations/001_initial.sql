BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id text PRIMARY KEY,
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  owner_id text NOT NULL,
  workspace_id text NOT NULL,
  objective text NOT NULL,
  read_scope jsonb NOT NULL,
  write_scope jsonb NOT NULL,
  autonomy_mode text NOT NULL CHECK (autonomy_mode IN ('READ_ONLY','SANDBOX_HIGH','UAT_HIGH','PRODUCTION_GUARDED')),
  risk_level text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','WAITING_APPROVAL','RETRY_WAIT','COMPLETED','FAILED','CANCELLED')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_run_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_next_run ON tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_workspace ON tasks(owner_id, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS executions (
  execution_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  owner_id text NOT NULL,
  workspace_id text NOT NULL,
  executor text NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED','INTERRUPTED')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result jsonb,
  error text,
  UNIQUE(task_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id, started_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  owner_id text NOT NULL,
  workspace_id text NOT NULL,
  action jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_approval_per_task
  ON approvals(task_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS audit_events (
  sequence_id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  task_id text,
  execution_id text,
  correlation_id text NOT NULL,
  owner_id text NOT NULL,
  workspace_id text NOT NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_task_sequence ON audit_events(task_id, sequence_id);
CREATE INDEX IF NOT EXISTS idx_audit_owner_workspace ON audit_events(owner_id, workspace_id, sequence_id);

CREATE TABLE IF NOT EXISTS evidence_objects (
  evidence_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  execution_id text,
  owner_id text NOT NULL,
  workspace_id text NOT NULL,
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  outbox_id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox_events(outbox_id) WHERE published_at IS NULL;

COMMIT;
