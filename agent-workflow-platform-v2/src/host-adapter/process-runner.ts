import { spawn } from 'node:child_process';

export type ProcessRunResult = Readonly<{
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}>;

function appendBounded(
  current: Uint8Array,
  chunk: Uint8Array,
  maxBytes: number,
): { value: Uint8Array; truncated: boolean } {
  if (current.length >= maxBytes) return { value: current, truncated: true };
  const remaining = maxBytes - current.length;
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  const value = new Uint8Array(current.length + accepted.length);
  value.set(current, 0);
  value.set(accepted, current.length);
  return { value, truncated: chunk.length > remaining };
}

export async function runProcess(input: {
  executable: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessRunResult> {
  const args = input.args ?? [];
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout: Uint8Array = new Uint8Array(0);
    let stderr: Uint8Array = new Uint8Array(0);
    let truncated = false;
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk, input.maxOutputBytes);
      stdout = appended.value;
      truncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk, input.maxOutputBytes);
      stderr = appended.value;
      truncated ||= appended.truncated;
    });
    child.once('error', reject);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, input.timeoutMs);
    timer.unref();

    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        executable: input.executable,
        args,
        cwd: input.cwd,
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.from(stdout).toString('utf8'),
        stderr: Buffer.from(stderr).toString('utf8'),
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
