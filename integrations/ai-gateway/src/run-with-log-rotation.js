import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const runtimeDir = path.resolve('runtime');
const logPath = path.join(runtimeDir, 'worker.log');
const maxBytes = Number(process.env.AI_GATEWAY_LOG_MAX_BYTES || 5_000_000);
const keepFiles = Number(process.env.AI_GATEWAY_LOG_KEEP || 7);

fs.mkdirSync(runtimeDir, { recursive: true });

if (fs.existsSync(logPath) && fs.statSync(logPath).size >= maxBytes) {
  for (let index = keepFiles - 1; index >= 1; index -= 1) {
    const source = `${logPath}.${index}`;
    const destination = `${logPath}.${index + 1}`;
    if (fs.existsSync(source)) {
      if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
      fs.renameSync(source, destination);
    }
  }
  fs.renameSync(logPath, `${logPath}.1`);
}

const output = fs.openSync(logPath, 'a');
const child = spawn(
  process.execPath,
  ['--env-file=.env', 'src/worker.js'],
  {
    cwd: process.cwd(),
    detached: false,
    stdio: ['ignore', output, output],
  },
);

child.on('error', error => {
  fs.writeSync(output, `${new Date().toISOString()} launcher_error=${error.message}\n`);
  process.exitCode = 1;
});

child.on('exit', code => {
  fs.closeSync(output);
  process.exit(code ?? 1);
});
