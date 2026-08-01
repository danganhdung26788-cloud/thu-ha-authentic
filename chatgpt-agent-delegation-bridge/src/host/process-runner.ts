import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';

export type ProcessRunResult = Readonly<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}>;

function resolveExecutable(executable: string): string {
  if (isAbsolute(executable)) {
    if (!existsSync(executable)) throw new Error(`Executable was not found: ${executable}`);
    return resolve(executable);
  }
  if (!executable || executable !== basename(executable) || /[\\/]/u.test(executable)) {
    throw new Error('Process executable must be an absolute path or a plain command name.');
  }
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidate = resolve(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Executable was not found on the system PATH: ${executable}`);
}

export async function runProcess(input: Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}>): Promise<ProcessRunResult> {
  const started = performance.now();
  const executable = resolveExecutable(input.executable);
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...input.args], {
      cwd: input.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let completed = false;
    let timer: NodeJS.Timeout | undefined;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
    };
    const finishReject = (error: Error) => {
      if (completed) return;
      completed = true;
      clearTimer();
      child.kill();
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > input.maxOutputBytes) {
        finishReject(new Error('Host process output exceeded bridge limit.'));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', finishReject);
    child.once('close', (code, signal) => {
      if (completed) return;
      completed = true;
      clearTimer();
      resolveResult({
        exitCode: code ?? (timedOut ? 124 : 1),
        signal,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        timedOut,
        durationMs: Math.round(performance.now() - started),
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs);
    timer.unref();
  });
}
