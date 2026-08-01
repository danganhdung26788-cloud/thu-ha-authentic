import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTING_SCENARIOS } from '../src/benchmark/routing-scenarios.js';
import { compileChatTask } from '../src/chat/task-compiler.js';
import { getEnv, resetEnvForTests } from '../src/config/env.js';
import { ManagerDecisionSchema } from '../src/contracts/execution-context.js';
import { redactSecrets } from '../src/diagnostics/redaction.js';
import {
  modelProviderHealthCheck,
  resetModelProviderForTests,
  resolveModelConfiguration,
} from '../src/models/model-provider.js';
import { CHAT_PAGE } from '../src/apps/api/chat-page.js';
import { issueChatSession, verifyChatSession } from '../src/apps/api/chat-session.js';

function resetConfiguration(): void {
  resetModelProviderForTests();
  resetEnvForTests();
}

test('local Ollama provider needs no OpenAI API key and never silently selects paid OpenAI', () => {
  resetConfiguration();
  getEnv({
    MODEL_PROVIDER: 'ollama',
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_API_KEY: 'ollama-local',
    MANAGER_MODEL: 'qwen3:4b',
    SPECIALIST_MODEL: 'qwen3:4b',
    OPENAI_API_KEY: '',
  });
  const config = resolveModelConfiguration();
  assert.equal(config.provider, 'ollama');
  assert.equal(config.managerModel, 'qwen3:4b');
  assert.equal(config.apiKey, 'ollama-local');
  assert.equal(config.useResponses, false);
  resetConfiguration();
});

test('OpenAI provider requires an explicit non-placeholder key', () => {
  resetConfiguration();
  getEnv({
    MODEL_PROVIDER: 'openai',
    MODEL_BASE_URL: 'https://api.openai.com/v1',
    MODEL_API_KEY: 'ollama-local',
    MANAGER_MODEL: 'example-manager',
    SPECIALIST_MODEL: 'example-specialist',
    OPENAI_API_KEY: '',
  });
  assert.throws(() => resolveModelConfiguration(), /OPENAI_API_KEY/);
  resetConfiguration();
});

test('model readiness verifies that the configured Manager model is listed', async () => {
  resetConfiguration();
  getEnv({
    MODEL_PROVIDER: 'ollama',
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_API_KEY: 'ollama-local',
    MANAGER_MODEL: 'qwen3:4b',
    SPECIALIST_MODEL: 'qwen3:4b',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ id: 'qwen3:4b' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const health = await modelProviderHealthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.modelAvailable, true);
  } finally {
    globalThis.fetch = originalFetch;
    resetConfiguration();
  }
});

test('one-message task compiler defaults analysis to read-only', () => {
  const compiled = compileChatTask('Phân tích báo cáo này và nêu các điểm chưa rõ.', []);
  assert.equal(compiled.autonomyMode, 'READ_ONLY');
  assert.equal(compiled.riskLevel, 'LOW');
  assert.deepEqual(compiled.writeScope, []);
  assert.equal(compiled.payload.estimatedCostUsd, 0);
});

test('one-message task compiler detects mutation and critical guarded operations', () => {
  const ordinaryWrite = compileChatTask('Sửa file README và chạy kiểm thử.', []);
  assert.equal(ordinaryWrite.autonomyMode, 'SANDBOX_HIGH');
  assert.equal(ordinaryWrite.riskLevel, 'MEDIUM');
  assert.deepEqual(ordinaryWrite.writeScope, ['.']);

  const critical = compileChatTask(
    'Đổi API key và mật khẩu trên production rồi sửa quyền administrator.',
    [],
  );
  assert.equal(critical.riskLevel, 'CRITICAL');
  assert.equal(critical.payload.touchesProduction, true);
  assert.equal(critical.payload.changesCredentials, true);
  assert.equal(critical.payload.changesPermissions, true);
});

test('attachments are added to deterministic read scope without client-provided privilege fields', () => {
  const compiled = compileChatTask('Nghiên cứu tài liệu đính kèm.', [{
    attachmentId: 'ATT-1',
    relativePath: 'runtime/chat-attachments/a/report.pdf',
    originalName: 'report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 120,
    sha256: 'a'.repeat(64),
  }]);
  assert.ok(compiled.readScope.includes('runtime/chat-attachments/a/report.pdf'));
  assert.deepEqual(compiled.writeScope, []);
});

test('diagnostic redaction removes representative credentials while retaining structure', () => {
  const fakeOpenAiKey = 'sk-' + 'a'.repeat(32);
  const fakeGoogleKey = 'AI' + 'za' + '1'.repeat(32);
  const fakeBearer = 'very-secret-' + 'token-value';
  const fakeDatabasePassword = 'database-' + 'password';
  const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'signature'].join('.');
  const pemHeader = '-----BEGIN ' + 'PRIVATE KEY-----';
  const pemFooter = '-----END ' + 'PRIVATE KEY-----';
  const secretValues = [
    fakeOpenAiKey,
    fakeBearer,
    fakeDatabasePassword,
    fakeJwt,
    fakeGoogleKey,
    'private-material',
  ];
  const raw = [
    `OPENAI_API_KEY=${fakeOpenAiKey}`,
    `Authorization: Bearer ${fakeBearer}`,
    `DATABASE_URL=postgresql://agent:${fakeDatabasePassword}@postgres:5432/agent_v2`,
    `jwt=${fakeJwt}`,
    `GOOGLE_API_KEY=${fakeGoogleKey}`,
    `${pemHeader}\nprivate-material\n${pemFooter}`,
  ].join('\n');
  const result = redactSecrets(raw);
  for (const value of secretValues) assert.equal(result.text.includes(value), false);
  assert.equal(result.text.includes('[REDACTED]'), true);
  assert.equal(result.text.includes('OPENAI_API_KEY='), true);
  assert.ok(result.redactionCount >= 5);
});

test('diagnostic reports are bounded without cutting into invalid UTF-8 sequences', () => {
  const result = redactSecrets('á'.repeat(20_000), 1_001);
  assert.ok(Buffer.byteLength(result.text, 'utf8') < 1_100);
  assert.equal(result.text.includes('�'), false);
  assert.equal(result.text.includes('TRUNCATED_BY_DIAGNOSTIC_LIMIT'), true);
});

test('local chat session is signed, scoped and rejects tampering', () => {
  resetConfiguration();
  getEnv({
    API_AUTH_TOKEN: 'test-chat-session-secret',
    DEFAULT_OWNER_ID: 'owner-one',
    DEFAULT_WORKSPACE_ID: 'workspace-one',
    CHAT_SESSION_TTL_SECONDS: '3600',
  });
  const session = issueChatSession();
  assert.deepEqual(verifyChatSession(session), {
    ownerId: 'owner-one',
    workspaceId: 'workspace-one',
  });
  assert.equal(verifyChatSession(`${session}x`), null);
  resetConfiguration();
});

test('chat UI is the simple default surface and hides technical task fields', () => {
  assert.match(CHAT_PAGE, /Giao việc bằng một câu chat/);
  assert.match(CHAT_PAGE, /Sao chép để hỏi ChatGPT/);
  assert.match(CHAT_PAGE, /kéo thả tài liệu/i);
  assert.doesNotMatch(CHAT_PAGE, /Dán API_AUTH_TOKEN/);
  assert.doesNotMatch(CHAT_PAGE, /taskRisk/);
  assert.doesNotMatch(CHAT_PAGE, /taskRead/);
  assert.doesNotMatch(CHAT_PAGE, /taskWrite/);
});

test('Manager schema supports genuine business clarification without technical fields', () => {
  const decision = ManagerDecisionSchema.parse({
    executor: 'CHATGPT',
    rationale: 'The requested source version is ambiguous.',
    nextAction: 'Anh muốn sửa tệp gốc hay tạo một bản sao?',
    requestedTools: [],
    toolCalls: [],
    clarification: {
      question: 'Anh muốn sửa tệp gốc hay tạo một bản sao?',
      options: ['Sửa tệp gốc', 'Tạo bản sao'],
      reason: 'Thiếu lựa chọn nghiệp vụ về phiên bản đầu ra.',
    },
    requiresApproval: false,
  });
  assert.equal(decision.clarification?.options.length, 2);
});

test('routing benchmark is versioned, unique and exactly 100 Vietnamese scenarios', () => {
  assert.equal(ROUTING_SCENARIOS.length, 100);
  assert.equal(new Set(ROUTING_SCENARIOS.map((item) => item.id)).size, 100);
  assert.equal(ROUTING_SCENARIOS.filter((item) => item.expectApproval).length, 20);
  assert.equal(ROUTING_SCENARIOS.filter((item) => item.expectClarification).length, 10);
  const executors = new Set(ROUTING_SCENARIOS.map((item) => item.expectedExecutor));
  for (const executor of ['CODEX', 'HERMES', 'NOTEBOOKLM', 'CANVA', 'SPECIALIST_AGENT', 'CHATGPT']) {
    assert.equal(executors.has(executor as never), true);
  }
});
