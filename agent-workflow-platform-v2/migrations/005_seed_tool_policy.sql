INSERT INTO tool_registry(tool_id, display_name, risk_class, adapter, input_schema, status)
VALUES
  ('filesystem.read', 'Read scoped files', 'READ', 'HERMES', '{}'::jsonb, 'ACTIVE'),
  ('filesystem.write', 'Write scoped files', 'LOW_WRITE', 'HERMES', '{}'::jsonb, 'ACTIVE'),
  ('powershell.execute', 'Execute bounded PowerShell', 'HIGH_WRITE', 'HERMES', '{}'::jsonb, 'ACTIVE'),
  ('scheduled-task.manage', 'Manage scoped Scheduled Tasks', 'HIGH_WRITE', 'HERMES', '{}'::jsonb, 'ACTIVE'),
  ('runtime.inspect', 'Inspect process, logs and health', 'READ', 'HERMES', '{}'::jsonb, 'ACTIVE'),
  ('git.inspect', 'Inspect repository state', 'READ', 'CODEX', '{}'::jsonb, 'ACTIVE'),
  ('code.modify', 'Modify source code in scoped repository', 'HIGH_WRITE', 'CODEX', '{}'::jsonb, 'ACTIVE'),
  ('test.run', 'Run tests and build checks', 'LOW_WRITE', 'CODEX', '{}'::jsonb, 'ACTIVE'),
  ('deploy.execute', 'Deploy or rollback a runtime', 'DEEP_INTERVENTION', 'CODEX', '{}'::jsonb, 'ACTIVE'),
  ('review.perform', 'Perform independent review', 'READ', 'CLAUDE_REVIEW', '{}'::jsonb, 'ACTIVE'),
  ('specialist.analyze', 'Perform bounded AI analysis', 'READ', 'SPECIALIST_AGENT', '{}'::jsonb, 'ACTIVE')
ON CONFLICT(tool_id) DO NOTHING;

INSERT INTO agent_tool_grants(agent_id, tool_id, owner_scope, workspace_scope)
VALUES
  ('hermes', 'filesystem.read', '*', '*'),
  ('hermes', 'filesystem.write', '*', '*'),
  ('hermes', 'powershell.execute', '*', '*'),
  ('hermes', 'scheduled-task.manage', '*', '*'),
  ('hermes', 'runtime.inspect', '*', '*'),
  ('codex', 'git.inspect', '*', '*'),
  ('codex', 'code.modify', '*', '*'),
  ('codex', 'test.run', '*', '*'),
  ('codex', 'deploy.execute', '*', '*'),
  ('claude-review', 'review.perform', '*', '*'),
  ('specialist', 'specialist.analyze', '*', '*'),
  ('manager', 'specialist.analyze', '*', '*')
ON CONFLICT(agent_id, tool_id, owner_scope, workspace_scope) DO NOTHING;
