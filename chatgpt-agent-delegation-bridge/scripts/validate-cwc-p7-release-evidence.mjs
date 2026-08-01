import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const HEX64 = /^[a-f0-9]{64}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const STATUSES = new Set(['BLOCKED', 'CANDIDATE_READY_NOT_ACTIVATED', 'ACTIVATED', 'ROLLED_BACK']);

function fail(message) {
  throw new Error(message);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}

function bool(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be boolean.`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string.`);
  return value.trim();
}

function rejectSecrets(raw) {
  const patterns = [
    /sk-[A-Za-z0-9_-]{16,}/u,
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u,
    /"(?:apiKey|authToken|accessToken|refreshToken|password|tunnelId)"\s*:/iu,
  ];
  if (patterns.some((pattern) => pattern.test(raw))) {
    fail('Release evidence contains a secret-like field or raw tunnel ID.');
  }
}

export function validateReleaseEvidence(document, raw = JSON.stringify(document)) {
  rejectSecrets(raw);
  object(document, 'root');
  if (document.schemaVersion !== '1.0.0') fail('schemaVersion must be 1.0.0.');
  if (document.phase !== 'CWC-P7') fail('phase must be CWC-P7.');
  const status = text(document.status, 'status').toUpperCase();
  if (!STATUSES.has(status)) fail('Unsupported CWC-P7 status.');
  text(document.recordedAt, 'recordedAt');
  const repositoryCommit = text(document.repositoryCommit, 'repositoryCommit');
  if (!HEX40.test(repositoryCommit)) fail('repositoryCommit must be a 40-character lowercase Git SHA.');
  const gates = object(document.gates, 'gates');
  const artifacts = object(document.artifacts, 'artifacts');
  for (const [name, hash] of Object.entries(artifacts)) {
    if (!HEX64.test(text(hash, `artifacts.${name}`))) fail(`artifacts.${name} must be SHA-256.`);
  }
  const blockReason = typeof document.blockReason === 'string' ? document.blockReason.trim() : '';

  if (status === 'BLOCKED') {
    if (!blockReason) fail('BLOCKED evidence requires blockReason.');
    if (document.production === true) fail('BLOCKED evidence cannot claim production=true.');
    return { status, repositoryCommit, blockReason };
  }

  for (const gate of ['p3', 'p4', 'p5', 'p6']) {
    if (gates[gate] !== 'PASS') fail(`${status} requires gates.${gate}=PASS.`);
  }
  if (bool(document.rollbackReady, 'rollbackReady') !== true) fail('rollbackReady must be true.');
  if (bool(document.monitoringReady, 'monitoringReady') !== true) fail('monitoringReady must be true.');
  if (bool(document.backupReady, 'backupReady') !== true) fail('backupReady must be true.');

  if (status === 'CANDIDATE_READY_NOT_ACTIVATED') {
    if (bool(document.ownerApproval, 'ownerApproval') !== false) fail('Candidate must not claim owner approval.');
    if (bool(document.production, 'production') !== false) fail('Candidate must not claim production activation.');
    if (document.activationId) fail('Candidate must not contain activationId.');
  }

  if (status === 'ACTIVATED') {
    if (bool(document.ownerApproval, 'ownerApproval') !== true) fail('ACTIVATED requires ownerApproval=true.');
    if (bool(document.production, 'production') !== true) fail('ACTIVATED requires production=true.');
    text(document.activationId, 'activationId');
    text(document.activatedAt, 'activatedAt');
    if (document.smokeTest !== 'PASS') fail('ACTIVATED requires smokeTest=PASS.');
    if (document.readBack !== 'PASS') fail('ACTIVATED requires readBack=PASS.');
  }

  if (status === 'ROLLED_BACK') {
    if (bool(document.production, 'production') !== false) fail('ROLLED_BACK requires production=false.');
    text(document.rollbackId, 'rollbackId');
    text(document.rolledBackAt, 'rolledBackAt');
    if (document.rollbackVerification !== 'PASS') fail('ROLLED_BACK requires rollbackVerification=PASS.');
  }

  return { status, repositoryCommit, blockReason };
}

async function main() {
  const args = process.argv.slice(2);
  const requireActivated = args.includes('--require-activated');
  const path = args.find((value) => !value.startsWith('--'));
  if (!path) throw new Error('Usage: node scripts/validate-cwc-p7-release-evidence.mjs <evidence.json> [--require-activated]');
  const raw = await readFile(path, 'utf8');
  const result = validateReleaseEvidence(JSON.parse(raw), raw);
  if (requireActivated && result.status !== 'ACTIVATED') {
    throw new Error(`CWC-P7 evidence is valid but status is ${result.status}.`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
