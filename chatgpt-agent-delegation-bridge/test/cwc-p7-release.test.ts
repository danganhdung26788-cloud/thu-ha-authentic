import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const cwd = fileURLToPath(ROOT);
const p6Validator = fileURLToPath(new URL('scripts/validate-cwc-p6-evidence.mjs', ROOT));
const p7Validator = fileURLToPath(new URL('scripts/validate-cwc-p7-release-evidence.mjs', ROOT));
function fixture(path: string) { return fileURLToPath(new URL(`test/fixtures/${path}`, ROOT)); }
function run(script: string, path: string) {
  return spawnSync(process.execPath, [script, path], { cwd, encoding: 'utf8' });
}
async function source(path: string) { return readFile(new URL(path, ROOT), 'utf8'); }

test('CWC-P6 PASS requires complete teardown and core controlled-write scenarios', async () => {
  const valid = run(p6Validator, fixture('cwc-p6-pass.json'));
  assert.equal(valid.status, 0, valid.stderr);
  const directory = await mkdtemp(join(tmpdir(), 'cwc-p6-invalid-'));
  try {
    const document = JSON.parse(await readFile(fixture('cwc-p6-pass.json'), 'utf8')) as Record<string, unknown>;
    document.localWriteActivated = true;
    const path = join(directory, 'invalid.json');
    await writeFile(path, JSON.stringify(document), 'utf8');
    const invalid = run(p6Validator, path);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /after local write is disabled/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CWC-P7 candidate requires all immutable artifact hashes', async () => {
  const valid = run(p7Validator, fixture('cwc-p7-candidate.json'));
  assert.equal(valid.status, 0, valid.stderr);
  const directory = await mkdtemp(join(tmpdir(), 'cwc-p7-invalid-'));
  try {
    const document = JSON.parse(await readFile(fixture('cwc-p7-candidate.json'), 'utf8')) as Record<string, unknown>;
    delete ((document.artifacts as Record<string, unknown>).p6Evidence);
    const path = join(directory, 'invalid.json');
    await writeFile(path, JSON.stringify(document), 'utf8');
    const invalid = run(p7Validator, path);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /artifacts\.p6Evidence/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production candidate generator never activates or starts runtime', async () => {
  const script = await source('scripts/windows/New-ProductionReleaseCandidate.ps1');
  assert.match(script, /CANDIDATE_READY_NOT_ACTIVATED/);
  assert.match(script, /ownerApproval=\$false/);
  assert.match(script, /production=\$false/);
  assert.doesNotMatch(script, /Start-Bridge|Start-SecureMcpTunnel|Start-Process/);
});

test('operational status is read-only', async () => {
  const script = await source('scripts/windows/Get-BridgeOperationalStatus.ps1');
  assert.match(script, /mutationPerformed=\$false/);
  assert.doesNotMatch(script, /Copy-Item|Remove-Item|Stop-Process|Start-Process|Set-Content/);
});

test('rollback stops verified runtime before replacing configuration and does not restart', async () => {
  const script = await source('scripts/windows/Invoke-BridgeSafeRollback.ps1');
  const stopIndex = script.indexOf('Stop-SecureMcpTunnel.ps1');
  const copyIndex = script.indexOf('Copy-Item $ReadOnlyConfigPath $active');
  assert.ok(stopIndex >= 0 && copyIndex > stopIndex);
  assert.match(script, /Explicit owner approval is required/);
  assert.match(script, /Rollback config is not strict read-only/);
  assert.match(script, /RUNTIME_RESTARTED=false/);
  assert.doesNotMatch(script, /Start-Bridge|Start-SecureMcpTunnel/);
});
