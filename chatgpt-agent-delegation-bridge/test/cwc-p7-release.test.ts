import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateP6Evidence } from '../scripts/validate-cwc-p6-evidence.mjs';
import { validateReleaseEvidence } from '../scripts/validate-cwc-p7-release-evidence.mjs';

const ROOT = new URL('../', import.meta.url);
async function json(path: string) {
  return JSON.parse(await readFile(new URL(path, ROOT), 'utf8')) as Record<string, unknown>;
}
async function source(path: string) {
  return readFile(new URL(path, ROOT), 'utf8');
}

test('CWC-P6 PASS requires complete teardown and core controlled-write scenarios', async () => {
  const fixture = await json('test/fixtures/cwc-p6-pass.json');
  assert.equal(validateP6Evidence(fixture).status, 'PASS');
  fixture.localWriteActivated = true;
  assert.throws(() => validateP6Evidence(fixture), /after local write is disabled/);
});

test('CWC-P7 candidate is valid but cannot satisfy activated enforcement', async () => {
  const fixture = await json('test/fixtures/cwc-p7-candidate.json');
  assert.equal(validateReleaseEvidence(fixture).status, 'CANDIDATE_READY_NOT_ACTIVATED');
  delete (fixture.artifacts as Record<string, unknown>).p6Evidence;
  assert.throws(() => validateReleaseEvidence(fixture), /artifacts\.p6Evidence/);
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
