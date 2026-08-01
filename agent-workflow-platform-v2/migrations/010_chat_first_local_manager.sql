ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('QUEUED','RUNNING','WAITING_INPUT','WAITING_APPROVAL','RETRY_WAIT','COMPLETED','FAILED','CANCELLED'));

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id text PRIMARY KEY,
  owner_id text NOT NULL,
  workspace_id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner_workspace
  ON conversations(owner_id, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  client_message_id text,
  role text NOT NULL CHECK (role IN ('USER','ASSISTANT','SYSTEM')),
  content text NOT NULL,
  task_id text,
  status text NOT NULL DEFAULT 'FINAL' CHECK (status IN ('PENDING','FINAL','FAILED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_client_id
  ON chat_messages(conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages(conversation_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_task
  ON chat_messages(task_id) WHERE task_id IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS conversation_id text REFERENCES conversations(conversation_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_message_id text REFERENCES chat_messages(message_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_conversation
  ON tasks(conversation_id, updated_at DESC) WHERE conversation_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_task_fk'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_task_fk
      FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_attachments (
  attachment_id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  message_id text REFERENCES chat_messages(message_id) ON DELETE SET NULL,
  original_name text NOT NULL,
  safe_name text NOT NULL,
  relative_path text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('UPLOADING','READY','REJECTED','DELETED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_conversation
  ON chat_attachments(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS clarification_requests (
  clarification_id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ANSWERED','CANCELLED')),
  answer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_clarification_per_task
  ON clarification_requests(task_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS progress_events (
  progress_id bigserial PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  task_id text REFERENCES tasks(task_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('STATUS','ROUTE','EXECUTION','APPROVAL','CLARIFICATION','RESULT','ERROR','RECOVERY')),
  stage text NOT NULL,
  message text NOT NULL,
  percent integer CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_progress_conversation
  ON progress_events(conversation_id, progress_id);
CREATE INDEX IF NOT EXISTS idx_progress_task
  ON progress_events(task_id, progress_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS diagnostic_reports (
  diagnostic_id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  task_id text REFERENCES tasks(task_id) ON DELETE CASCADE,
  error_code text NOT NULL,
  summary text NOT NULL,
  report_text text NOT NULL,
  redaction_count integer NOT NULL DEFAULT 0 CHECK (redaction_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_diagnostics_conversation
  ON diagnostic_reports(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diagnostics_task
  ON diagnostic_reports(task_id, created_at DESC) WHERE task_id IS NOT NULL;

UPDATE agent_registry
SET provider = 'ollama',
    model = COALESCE(NULLIF(model, ''), 'qwen3:4b'),
    updated_at = now(),
    version = version + 1
WHERE agent_id IN ('manager','specialist')
  AND provider = 'openai';
