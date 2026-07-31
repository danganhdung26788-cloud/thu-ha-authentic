import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

const SandboxRequestSchema = z.object({
  image: z.string().regex(/^[a-zA-Z0-9./:@_-]+$/),
  workspacePath: z.string().min(1),
  allowedRoots: z.array(z.string().min(1)).min(1),
  command: z.array(z.string().max(8_192)).min(1).max(64),
  timeoutMs: z.number().int().min(1_000).max(30 * 60_000).default(300_000),
  maxOutputBytes: z.number().int().min(1_024).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  networkEnabled: z.boolean().default(false),
  writableWorkspace: z.boolean().default(false),
  allowUnpinnedImage: z.boolean().default(false),
  environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(8_192)).default({}),
});

export type SandboxRequest = z.input<typeof SandboxRequestSchema>;
export type SandboxResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}>;

const ALLOWED_EXECUTABLES = new Set([
  'git',
  'node',
  'npm',
  'npx',
  'python',
  'python3',
  'pytest',
  'pwsh',
]);

function normalizedHostPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(target: string, root: string): boolean {
  const normalizedRoot = normalizedHostPath(root);
  const normalizedTarget = normalizedHostPath(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class DockerSandbox {
  async execute(rawRequest: SandboxRequest): Promise<SandboxResult> {
    const request = SandboxRequestSchema.parse(rawRequest);
    if (!request.allowedRoots.some((root) => isWithinRoot(request.workspacePath, root))) {
      throw new Error('Sandbox workspace is outside the registered path allowlist.');
    }
    const workspacePath = path.resolve(request.workspacePath);
    if (workspacePath.includes(',')) {
      throw new Error('Sandbox workspace path must not contain a comma.');
    }
    const executable = path.basename(request.command[0] ?? '').toLowerCase();
    if (!ALLOWED_EXECUTABLES.has(executable)) {
      throw new Error(`Executable is not allowlisted: ${executable}`);
    }
    if (!request.allowUnpinnedImage && !/@sha256:[a-f0-9]{64}$/i.test(request.image)) {
      throw new Error('Sandbox image must be pinned by SHA-256 digest.');
    }

    const mount = [
      'type=bind',
      `source=${workspacePath}`,
      'target=/workspace',
      ...(request.writableWorkspace ? [] : ['readonly']),
    ].join(',');
    const args = [
      'run', '--rm',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=256',
      '--cpus=2',
      '--memory=2g',
      '--tmpfs=/tmp:rw,noexec,nosuid,size=256m',
      request.networkEnabled ? '--network=bridge' : '--network=none',
      '--mount', mount,
      '--workdir=/workspace',
    ];
    for (const [key, value] of Object.entries(request.environment)) {
      if (/TOKEN|SECRET|PASSWORD|KEY/i.test(key)) {
        throw new Error(`Sensitive environment variable cannot be passed inline: ${key}`);
      }
      args.push('--env', `${key}=${value}`);
    }
    args.push(request.image, ...request.command);

    return new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn('docker', args, { windowsHide: true, shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let outputTruncated = false;
      let outputBytes = 0;

      const collect = (target: 'stdout' | 'stderr', chunk: string): void => {
        const bytes = Buffer.byteLength(chunk);
        const remaining = request.maxOutputBytes - outputBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          child.kill('SIGKILL');
          return;
        }
        const accepted = bytes <= remaining
          ? chunk
          : Buffer.from(chunk).subarray(0, remaining).toString('utf8');
        outputBytes += Buffer.byteLength(accepted);
        if (target === 'stdout') stdout += accepted;
        else stderr += accepted;
        if (bytes > remaining) {
          outputTruncated = true;
          child.kill('SIGKILL');
        }
      };

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => collect('stdout', chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => collect('stderr', chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          timedOut,
          outputTruncated,
        });
      });
    });
  }
}
