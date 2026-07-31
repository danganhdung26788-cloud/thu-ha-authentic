import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

const SandboxRequestSchema = z.object({
  image: z.string().regex(/^[a-zA-Z0-9./:_-]+$/),
  workspacePath: z.string().min(1),
  allowedRoots: z.array(z.string().min(1)).min(1),
  command: z.array(z.string()).min(1),
  timeoutMs: z.number().int().min(1_000).max(30 * 60_000).default(300_000),
  networkEnabled: z.boolean().default(false),
  environment: z.record(z.string(), z.string()).default({}),
});

export type SandboxRequest = z.input<typeof SandboxRequestSchema>;
export type SandboxResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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

function isWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class DockerSandbox {
  async execute(rawRequest: SandboxRequest): Promise<SandboxResult> {
    const request = SandboxRequestSchema.parse(rawRequest);
    if (!request.allowedRoots.some((root) => isWithinRoot(request.workspacePath, root))) {
      throw new Error('Sandbox workspace is outside the registered path allowlist.');
    }
    const executable = path.basename(request.command[0] ?? '').toLowerCase();
    if (!ALLOWED_EXECUTABLES.has(executable)) {
      throw new Error(`Executable is not allowlisted: ${executable}`);
    }

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
      '--mount', `type=bind,source=${path.resolve(request.workspacePath)},target=/workspace`,
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
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
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
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }
}
