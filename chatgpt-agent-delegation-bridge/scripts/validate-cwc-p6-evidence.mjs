import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const HEX64 = /^[a-f0-9]{64}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const WRITE_PLANS = new Set(['BUSINESS', 'ENTERPRISE', 'EDU']);
const CORE_SCENARIOS = Object.freeze([
  'fileWriteReadBack',
  'wrongHashBlocked',
  'singleUseBlocked',
  'idempotentRetry',
  'expirationBlocked',
  'pathEscapeBlocked',
]);

function fail(message) { throw new Error(message); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string.`);
  return value.trim();
}
function bool(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be boolean.`);
  return value;
}
function rejectSecrets(raw) {
  const patterns = [
    /sk-[A-Za-z0-9_-]{16,}/u,
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u,
    /"(?:apiKey|authToken|accessToken|refreshToken|password|tunnelId)"\s*:/iu,
  ];
  if (patterns.some((pattern) => pattern.test(raw))) fail('CWC-P6 evidence contains a secret-like field or raw tunnel ID.');
}

export function validateP6Evidence(document, raw = JSON.stringify(document)) {
  rejectSecrets(raw);
  object(document, 'root');
  if (document.schemaVersion !== '1.0.0') fail('schemaVersion must be 1.0.0.');
  if (document.phase !== 'CWC-P6') fail('phase must be CWC-P6.');
  const status = text(document.status, 'status').toUpperCase();
  if (!['PASS', 'BLOCKED', 'FAIL'].includes(status)) fail('status must be PASS, BLOCKED, or FAIL.');
  text(document.testedAt, 'testedAt');
  const plan = text(document.workspacePlan, 'workspacePlan').toUpperCase();
  const repositoryCommit = text(document.repositoryCommit, 'repositoryCommit');
  if (!HEX40.test(repositoryCommit)) fail('repositoryCommit must be a lowercase 40-character Git SHA.');
  for (const name of ['p5EvidenceSha256', 'writeProfileSha256']) {
    if (!HEX64.test(text(document[name], name))) fail(`${name} must be SHA-256.`);
  }
  const scenarios = object(document.scenarios, 'scenarios');
  const blockReason = typeof document.blockReason === 'string' ? document.blockReason.trim() : '';

  if (status === 'PASS') {
    if (!WRITE_PLANS.has(plan)) fail(`Plan ${plan} is not eligible for CWC-P6 write PASS.`);
    if (bool(document.p5PassVerified, 'p5PassVerified') !== true) fail('PASS requires p5PassVerified=true.');
    if (bool(document.sandboxOnly, 'sandboxOnly') !== true) fail('PASS requires sandboxOnly=true.');
    if (bool(document.teardownComplete, 'teardownComplete') !== true) fail('PASS requires teardownComplete=true.');
    if (bool(document.localWriteActivated, 'localWriteActivated') !== false) fail('PASS receipt must be captured after local write is disabled.');
    if (bool(document.connectedWriteApp, 'connectedWriteApp') !== false) fail('PASS receipt must be captured after write app disconnection.');
    if (bool(document.production, 'production') !== false) fail('P6 PASS cannot claim production=true.');
    for (const scenario of CORE_SCENARIOS) {
      if (scenarios[scenario] !== 'PASS') fail(`PASS requires scenarios.${scenario}=PASS.`);
    }
  } else if (!blockReason) {
    fail(`${status} evidence requires blockReason.`);
  }

  return { status, workspacePlan: plan, repositoryCommit, blockReason };
}

async function main() {
  const args = process.argv.slice(2);
  const requirePass = args.includes('--require-pass');
  const path = args.find((value) => !value.startsWith('--'));
  if (!path) throw new Error('Usage: node scripts/validate-cwc-p6-evidence.mjs <evidence.json> [--require-pass]');
  const raw = await readFile(path, 'utf8');
  const result = validateP6Evidence(JSON.parse(raw), raw);
  if (requirePass && result.status !== 'PASS') throw new Error(`CWC-P6 evidence is valid but status is ${result.status}.`);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
