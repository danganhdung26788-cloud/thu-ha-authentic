import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const self = 'agent-workflow-platform-v2/scripts/secret-scan.mjs';
const files = execFileSync('git', ['ls-files', '-z', 'agent-workflow-platform-v2', '.github/workflows/agent-v2-ci.yml'])
  .toString('utf8')
  .split('\0')
  .filter((file) => file && file !== self);

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['telegram-bot-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
];

const findings = [];
for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [name, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push({ file, pattern: name });
  }
}

if (findings.length) {
  console.error(JSON.stringify({ status: 'FAIL', findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'PASS', scannedFiles: files.length, findings: 0 }));
}
