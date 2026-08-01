import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const validator = fileURLToPath(new URL('scripts/validate-cwc-p5-evidence.mjs', ROOT));
const workingDirectory = fileURLToPath(ROOT);

function fixture(name: string): string {
  return fileURLToPath(new URL(`test/fixtures/${name}`, ROOT));
}

function run(path: string, requirePass = false) {
  return spawnSync(process.execPath, [validator, path, ...(requirePass ? ['--require-pass'] : [])], {
    cwd: workingDirectory,
    encoding: 'utf8',
  });
}

test('CWC-P5 validator accepts complete read-only ChatGPT connection evidence', () => {
  const result = run(fixture('cwc-p5-pass.json'), true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "PASS"/);
  assert.match(result.stdout, /inspect_local_runtime/);
});

test('CWC-P5 validator records a Plus plan as BLOCKED and refuses PASS enforcement', () => {
  const path = fixture('cwc-p5-blocked-plus.json');
  const valid = run(path);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /"status": "BLOCKED"/);
  const enforced = run(path, true);
  assert.notEqual(enforced.status, 0);
  assert.match(enforced.stderr, /status is BLOCKED/);
});

test('CWC-P5 validator rejects a write tool in read-only evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cwc-p5-evidence-'));
  try {
    const document = JSON.parse(await readFile(fixture('cwc-p5-pass.json'), 'utf8')) as Record<string, unknown>;
    document.toolNames = [
      'delegation_health',
      'ask_codex',
      'inspect_local_runtime',
      'execute_local_operations',
    ];
    const path = join(directory, 'invalid.json');
    await writeFile(path, JSON.stringify(document), 'utf8');
    const result = run(path, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden write tool/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CWC-P5 validator rejects raw tunnel IDs and secret-like fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cwc-p5-secret-'));
  try {
    const document = JSON.parse(await readFile(fixture('cwc-p5-pass.json'), 'utf8')) as Record<string, unknown>;
    document.tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
    const path = join(directory, 'invalid.json');
    await writeFile(path, JSON.stringify(document), 'utf8');
    const result = run(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /never the raw tunnelId/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
