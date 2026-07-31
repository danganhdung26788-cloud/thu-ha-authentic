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
  current: Buffer,
  chunk: Buffer,
  maxBytes: number,
): { value: Buffer; truncated: boolean } {
  if (current.length >= maxBytes) return { value: current, truncated: true };
  const remaining = maxBytes - current.length;
  if (chunk.length <= remaining) return { value: Buffer.concat([current, chunk]), truncated: false };
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
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
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
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
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
