CREATE TABLE IF NOT EXISTS agent_registry (
  agent_id text PRIMARY KEY,
  display_name text NOT NULL,
  executor text NOT NULL CHECK (executor IN ('CHATGPT','CODEX','HERMES','CLAUDE_REVIEW','SPECIALIST_AGENT')),
  provider text NOT NULL,
  model text,
  status text NOT NULL CHECK (status IN ('DRAFT','TESTING','ACTIVE','DISABLED','DEPRECATED')),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_registry (
  tool_id text PRIMARY KEY,
  display_name text NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('READ','LOW_WRITE','HIGH_WRITE','DEEP_INTERVENTION')),
  adapter text NOT NULL,
  input_schema jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','TESTING','ACTIVE','DISABLED','DEPRECATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_tool_grants (
  agent_id text NOT NULL REFERENCES agent_registry(agent_id) ON DELETE CASCADE,
  tool_id text NOT NULL REFERENCES tool_registry(tool_id) ON DELETE CASCADE,
  owner_scope text,
  workspace_scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id, tool_id, owner_scope, workspace_scope)
);

INSERT INTO agent_registry(agent_id, display_name, executor, provider, status, capabilities)
VALUES
  ('manager', 'Workflow V2 Manager', 'CHATGPT', 'openai', 'ACTIVE', '["routing","policy-input","delegation"]'::jsonb),
  ('specialist', 'Workflow V2 Specialist', 'SPECIALIST_AGENT', 'openai', 'ACTIVE', '["analysis","extraction","classification","reporting"]'::jsonb),
  ('codex', 'Codex Executor', 'CODEX', 'openai', 'TESTING', '["code","repository","test","ci","deploy","rollback"]'::jsonb),
  ('hermes', 'Hermes Executor', 'HERMES', 'hermes', 'TESTING', '["powershell","files","scheduled-tasks","monitoring","recovery"]'::jsonb),
  ('claude-review', 'Claude Independent Reviewer', 'CLAUDE_REVIEW', 'anthropic', 'TESTING', '["review","architecture","logic","security"]'::jsonb)
ON CONFLICT(agent_id) DO NOTHING;
