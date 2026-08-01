import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REQUIRED_READ_ONLY_TOOLS = Object.freeze([
  'delegation_health',
  'ask_codex',
  'inspect_local_runtime',
]);

const FORBIDDEN_WRITE_TOOLS = Object.freeze([
  'execute_codex',
  'execute_local_operations',
  'prepare_local_operations',
]);

const READ_ONLY_ELIGIBLE_PLANS = new Set(['PRO', 'BUSINESS', 'ENTERPRISE', 'EDU']);
const KNOWN_PLANS = new Set(['FREE', 'GO', 'PLUS', 'PRO', 'BUSINESS', 'ENTERPRISE', 'EDU', 'UNKNOWN']);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boolean(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be boolean.`);
  return value;
}

function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string.`);
  return value.trim();
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    fail(`${name} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function rejectSecrets(raw) {
  const secretPatterns = [
    /sk-[A-Za-z0-9_-]{16,}/u,
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u,
    /"(?:apiKey|authToken|accessToken|refreshToken|password)"\s*:/iu,
  ];
  if (secretPatterns.some((pattern) => pattern.test(raw))) {
    fail('Evidence contains a secret-like value or forbidden credential field.');
  }
  if (/"tunnelId"\s*:/u.test(raw)) {
    fail('Evidence must store tunnelIdSha256, never the raw tunnelId.');
  }
}

export function validateEvidence(document, raw = JSON.stringify(document)) {
  rejectSecrets(raw);
  if (!isObject(document)) fail('Evidence root must be an object.');
  if (document.schemaVersion !== '1.0.0') fail('schemaVersion must be 1.0.0.');
  if (document.phase !== 'CWC-P5') fail('phase must be CWC-P5.');
  const status = string(document.status, 'status').toUpperCase();
  if (!['PASS', 'BLOCKED', 'FAIL'].includes(status)) fail('status must be PASS, BLOCKED, or FAIL.');
  string(document.testedAt, 'testedAt');
  const plan = string(document.workspacePlan, 'workspacePlan').toUpperCase();
  if (!KNOWN_PLANS.has(plan)) fail('workspacePlan is not recognized.');
  if (document.clientSurface !== 'WEB') fail('CWC-P5 is web-only; clientSurface must be WEB.');
  if (!/^[a-f0-9]{64}$/u.test(string(document.tunnelIdSha256, 'tunnelIdSha256'))) {
    fail('tunnelIdSha256 must be a lowercase SHA-256 hex digest.');
  }

  const toolNames = stringArray(document.toolNames, 'toolNames');
  const health = document.delegationHealth;
  if (!isObject(health)) fail('delegationHealth must be an object.');
  const architecture = health.architecture;
  if (!isObject(architecture)) fail('delegationHealth.architecture must be an object.');
  const targets = health.targets;
  if (!isObject(targets)) fail('delegationHealth.targets must be an object.');
  const localExecutor = targets.localExecutor;
  if (!isObject(localExecutor)) fail('delegationHealth.targets.localExecutor must be an object.');

  const normalized = {
    schemaVersion: '1.0.0',
    phase: 'CWC-P5',
    status,
    testedAt: document.testedAt,
    workspacePlan: plan,
    clientSurface: 'WEB',
    developerModeAvailable: boolean(document.developerModeAvailable, 'developerModeAvailable'),
    tunnelReady: boolean(document.tunnelReady, 'tunnelReady'),
    appCreated: boolean(document.appCreated, 'appCreated'),
    tunnelIdSha256: document.tunnelIdSha256,
    toolNames,
    blockReason: typeof document.blockReason === 'string' ? document.blockReason.trim() : '',
    delegationHealth: health,
  };

  if (status === 'PASS') {
    if (!READ_ONLY_ELIGIBLE_PLANS.has(plan)) fail(`Plan ${plan} is not eligible for a CWC-P5 read-only PASS.`);
    if (!normalized.developerModeAvailable) fail('PASS requires developerModeAvailable=true.');
    if (!normalized.tunnelReady) fail('PASS requires tunnelReady=true.');
    if (!normalized.appCreated) fail('PASS requires appCreated=true.');
    for (const tool of REQUIRED_READ_ONLY_TOOLS) {
      if (!toolNames.includes(tool)) fail(`PASS evidence is missing required tool: ${tool}.`);
    }
    for (const tool of FORBIDDEN_WRITE_TOOLS) {
      if (toolNames.includes(tool)) fail(`Read-only P5 evidence exposes forbidden write tool: ${tool}.`);
    }
    if (architecture.chatgptPrimaryBrain !== true) fail('chatgptPrimaryBrain must be true.');
    if (architecture.backendManagerAgent !== false) fail('backendManagerAgent must be false.');
    if (architecture.automaticBackendRouting !== false) fail('automaticBackendRouting must be false.');
    if (architecture.separateChatUi !== false) fail('separateChatUi must be false.');
    if (architecture.v2RuntimeDependency !== false) fail('v2RuntimeDependency must be false.');
    if (architecture.specialistAiMayMutateUserWorkspace !== false) {
      fail('specialistAiMayMutateUserWorkspace must be false.');
    }
    if (localExecutor.readAvailable !== true) fail('Read-only P5 requires localExecutor.readAvailable=true.');
    if (localExecutor.writeAvailable !== false) fail('Read-only P5 requires localExecutor.writeAvailable=false.');
    if (localExecutor.publishedMode !== 'READ_ONLY') fail('Read-only P5 requires publishedMode=READ_ONLY.');
  } else if (!normalized.blockReason) {
    fail(`${status} evidence requires blockReason.`);
  }

  return normalized;
}

export async function validateEvidenceFile(path) {
  const raw = await readFile(path, 'utf8');
  return validateEvidence(JSON.parse(raw), raw);
}

async function main() {
  const args = process.argv.slice(2);
  const requirePass = args.includes('--require-pass');
  const path = args.find((arg) => !arg.startsWith('--'));
  if (!path) throw new Error('Usage: node scripts/validate-cwc-p5-evidence.mjs <evidence.json> [--require-pass]');
  const result = await validateEvidenceFile(path);
  if (requirePass && result.status !== 'PASS') {
    throw new Error(`CWC-P5 evidence is valid but status is ${result.status}: ${result.blockReason || 'no reason supplied'}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, phase: result.phase, status: result.status, workspacePlan: result.workspacePlan, toolNames: result.toolNames }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
