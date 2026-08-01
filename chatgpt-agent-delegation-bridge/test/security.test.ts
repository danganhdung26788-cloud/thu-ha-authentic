import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfig, resetConfigForTests } from '../src/config.js';
import { redactSecrets } from '../src/redaction.js';
import { AgentsSdkSpecialist } from '../src/specialists/agents-sdk.js';

function config(source: NodeJS.ProcessEnv) {
  resetConfigForTests();
  return getConfig(source);
}

test('production bridge refuses unauthenticated access', () => {
  assert.throws(
    () => config({ NODE_ENV: 'production', MCP_AUTH_MODE: 'none' }),
    /authenticated MCP access/,
  );
  resetConfigForTests();
});

test('unauthenticated bridge cannot bind to all interfaces', () => {
  assert.throws(
    () => config({ NODE_ENV: 'development', MCP_BIND: '0.0.0.0', MCP_AUTH_MODE: 'none' }),
    /localhost/,
  );
  resetConfigForTests();
});

test('enabled specialist requires explicit model and key with no silent fallback', () => {
  assert.throws(
    () => config({ SPECIALIST_AGENT_ENABLED: 'true', SPECIALIST_MODEL: '', SPECIALIST_API_KEY: '' }),
    /explicit SPECIALIST_MODEL/,
  );
  resetConfigForTests();
});

test('disabled Agents SDK specialist returns BLOCKED and never falls back', async () => {
  const bridgeConfig = config({
    NODE_ENV: 'test',
    SPECIALIST_AGENT_ENABLED: 'false',
    CODEX_ENABLED: 'false',
    LOCAL_EXECUTOR_ENABLED: 'false',
  });
  const result = await new AgentsSdkSpecialist(bridgeConfig).run({
    objective: 'Ask another model.',
    outputLanguage: 'vi',
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorCode, 'SPECIALIST_AGENT_DISABLED');
  resetConfigForTests();
});

test('redaction removes representative credentials from errors', () => {
  const apiKey = 'sk-' + 'a'.repeat(32);
  const bearer = 'Bearer very-secret-token-value';
  const database = 'postgresql://agent:database-password@localhost:5432/db';
  const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----';
  const output = redactSecrets([apiKey, bearer, database, privateKey].join('\n'));
  assert.equal(output.includes(apiKey), false);
  assert.equal(output.includes('very-secret-token-value'), false);
  assert.equal(output.includes('database-password'), false);
  assert.equal(output.includes('private-material'), false);
  assert.match(output, /\[REDACTED\]|\[PRIVATE_KEY_REDACTED\]/);
});
