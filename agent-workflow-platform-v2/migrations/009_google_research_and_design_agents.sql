ALTER TABLE agent_registry
  DROP CONSTRAINT IF EXISTS agent_registry_executor_check;

ALTER TABLE agent_registry
  ADD CONSTRAINT agent_registry_executor_check
  CHECK (executor IN (
    'CHATGPT',
    'CODEX',
    'HERMES',
    'CLAUDE_REVIEW',
    'SPECIALIST_AGENT',
    'GEMINI',
    'NOTEBOOKLM',
    'CANVA'
  ));

INSERT INTO agent_registry(
  agent_id, display_name, executor, provider, model, status, capabilities, configuration
)
VALUES
  (
    'gemini',
    'Gemini Multimodal Specialist',
    'GEMINI',
    'google',
    NULL,
    'TESTING',
    '["multimodal-analysis","google-workspace-research","cross-checking","long-context"]'::jsonb,
    '{"api":"gemini-v1","activation":"requires_google_api_key_and_contract_test"}'::jsonb
  ),
  (
    'notebooklm',
    'NotebookLM Source-Grounded Research Workspace',
    'NOTEBOOKLM',
    'google',
    NULL,
    'ACTIVE',
    '["source-package","grounded-research-handoff","citation-workspace"]'::jsonb,
    '{"mode":"source_package_only","runtime_api":"not_available"}'::jsonb
  ),
  (
    'canva',
    'Canva Design and Export Executor',
    'CANVA',
    'canva',
    NULL,
    'TESTING',
    '["asset-upload","design-create","template-autofill","design-export"]'::jsonb,
    '{"activation":"requires_oauth_or_adapter_contract_test","publishing":"approval_required"}'::jsonb
  )
ON CONFLICT(agent_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  executor = EXCLUDED.executor,
  provider = EXCLUDED.provider,
  capabilities = EXCLUDED.capabilities,
  configuration = EXCLUDED.configuration,
  updated_at = now();

INSERT INTO tool_registry(tool_id, display_name, risk_class, adapter, input_schema, status)
VALUES
  ('gemini.analyze', 'Analyze text and structured context with Gemini', 'READ', 'GEMINI', '{}'::jsonb, 'ACTIVE'),
  ('gemini.multimodal', 'Analyze multimodal source references with Gemini', 'READ', 'GEMINI', '{}'::jsonb, 'ACTIVE'),
  ('gemini.cross-check', 'Cross-check another agent result with Gemini', 'READ', 'GEMINI', '{}'::jsonb, 'ACTIVE'),
  ('notebooklm.prepare-source-package', 'Prepare a NotebookLM source-grounded research handoff', 'READ', 'NOTEBOOKLM', '{}'::jsonb, 'ACTIVE'),
  ('notebooklm.register-result', 'Register a reviewed NotebookLM result and citations', 'LOW_WRITE', 'NOTEBOOKLM', '{}'::jsonb, 'ACTIVE'),
  ('canva.asset.upload', 'Upload an approved asset to Canva', 'LOW_WRITE', 'CANVA', '{}'::jsonb, 'ACTIVE'),
  ('canva.design.create', 'Create a Canva design draft', 'LOW_WRITE', 'CANVA', '{}'::jsonb, 'ACTIVE'),
  ('canva.template.autofill', 'Autofill an approved Canva brand template', 'LOW_WRITE', 'CANVA', '{}'::jsonb, 'ACTIVE'),
  ('canva.design.export', 'Export an approved Canva design', 'LOW_WRITE', 'CANVA', '{}'::jsonb, 'ACTIVE'),
  ('canva.design.publish', 'Publish or share a Canva design externally', 'DEEP_INTERVENTION', 'CANVA', '{}'::jsonb, 'ACTIVE')
ON CONFLICT(tool_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  risk_class = EXCLUDED.risk_class,
  adapter = EXCLUDED.adapter,
  input_schema = EXCLUDED.input_schema,
  status = EXCLUDED.status,
  updated_at = now();

INSERT INTO agent_tool_grants(agent_id, tool_id, owner_scope, workspace_scope)
VALUES
  ('gemini', 'gemini.analyze', '*', '*'),
  ('gemini', 'gemini.multimodal', '*', '*'),
  ('gemini', 'gemini.cross-check', '*', '*'),
  ('notebooklm', 'notebooklm.prepare-source-package', '*', '*'),
  ('notebooklm', 'notebooklm.register-result', '*', '*'),
  ('canva', 'canva.asset.upload', '*', '*'),
  ('canva', 'canva.design.create', '*', '*'),
  ('canva', 'canva.template.autofill', '*', '*'),
  ('canva', 'canva.design.export', '*', '*'),
  ('canva', 'canva.design.publish', '*', '*')
ON CONFLICT(agent_id, tool_id, owner_scope, workspace_scope) DO NOTHING;
