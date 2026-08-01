import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { freemem, platform, release, totalmem, uptime } from 'node:os';
import { z } from 'zod';
import type { BridgeConfig } from '../config.js';
import type {
  DelegationResult,
  LocalExecuteInput,
  LocalInspectInput,
  WorkspaceRegistration,
} from '../contracts.js';
import { runProcess } from '../host/process-runner.js';
import { redactSecrets } from '../redaction.js';
import { pathInside, WorkspaceRegistry } from '../workspace-registry.js';

const FileReadSchema = z.object({
  path: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
});
const FileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  createDirectories: z.boolean().default(true),
});
const PowerShellSchema = z.object({
  scriptPath: z.string().min(1),
  args: z.array(z.string().max(2_000)).max(100).default([]),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
});
const InspectSchema = z.object({
  kind: z.enum(['system', 'process', 'service', 'scheduled-task', 'docker', 'git']),
  names: z.array(z.string().min(1).max(200)).max(100).default([]),
  cwd: z.string().optional(),
});
const ScheduledTaskSchema = z.object({
  operation: z.enum(['query', 'run', 'end', 'delete', 'create']),
  taskName: z.string().min(1).max(240),
  executable: z.string().optional(),
  args: z.array(z.string().max(2_000)).max(100).default([]),
  schedule: z.enum(['ONLOGON', 'DAILY', 'MINUTE']).optional(),
  modifier: z.number().int().min(1).max(1_440).optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sanitizeObject(value: unknown, maxBytes: number): Record<string, unknown> {
  const redacted = redactSecrets(JSON.stringify(value), maxBytes);
  try {
    const parsed = JSON.parse(redacted) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { text: redacted };
  }
}

function evidence(payload: unknown) {
  return {
    name: 'local-executor-result.json',
    mediaType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
  };
}

export class LocalExecutor {
  constructor(
    readonly config: BridgeConfig,
    readonly registry: WorkspaceRegistry,
  ) {}

  async inspect(
    workspace: WorkspaceRegistration,
    input: LocalInspectInput,
  ): Promise<DelegationResult> {
    const requestId = input.idempotencyKey ?? `LOCAL-${randomUUID()}`;
    if (!this.config.localExecutor.enabled) {
      return this.blocked(requestId, 'LOCAL_EXECUTOR_DISABLED', 'Local runtime execution is disabled.');
    }
    if (!workspace.allowLocalRead) {
      return this.blocked(requestId, 'LOCAL_READ_NOT_ALLOWED', 'Local read access is not allowed for this workspace.');
    }
    try {
      const output = await this.inspectInternal(workspace, {
        kind: input.kind,
        names: input.names,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
      const safe = sanitizeObject(output, this.config.maxOutputBytes);
      return {
        requestId,
        target: 'LOCAL_EXECUTOR',
        status: 'SUCCEEDED',
        summary: `The local executor completed the requested read-only ${input.kind} inspection.`,
        result: safe,
        warnings: [],
        evidence: [evidence(safe)],
        retryable: false,
      };
    } catch (error) {
      return this.failed(requestId, error);
    }
  }

  async execute(
    workspace: WorkspaceRegistration,
    input: LocalExecuteInput,
  ): Promise<DelegationResult> {
    const requestId = input.idempotencyKey ?? `LOCAL-${randomUUID()}`;
    if (!this.config.localExecutor.enabled) {
      return this.blocked(requestId, 'LOCAL_EXECUTOR_DISABLED', 'Local runtime execution is disabled.');
    }
    if (!workspace.allowLocalWrite) {
      return this.blocked(requestId, 'LOCAL_WRITE_NOT_ALLOWED', 'Local write access is not allowed for this workspace.');
    }
    const outputs: Array<Record<string, unknown>> = [];
    try {
      for (const operation of input.operations) {
        outputs.push(await this.executeOperation(workspace, input, operation.toolId, operation.input));
      }
      const safe = sanitizeObject({ objective: input.objective, actions: outputs }, this.config.maxOutputBytes);
      return {
        requestId,
        target: 'LOCAL_EXECUTOR',
        status: 'SUCCEEDED',
        summary: `The local executor completed ${outputs.length} explicitly approved bounded operation(s).`,
        result: safe,
        warnings: [],
        evidence: [evidence(safe)],
        retryable: false,
      };
    } catch (error) {
      const safe = sanitizeObject({ objective: input.objective, completedActions: outputs }, this.config.maxOutputBytes);
      const failure = this.failed(requestId, error);
      return {
        ...failure,
        result: safe,
        evidence: [evidence(safe)],
      };
    }
  }

  health(): Record<string, unknown> {
    return {
      enabled: this.config.localExecutor.enabled,
      ready: this.config.localExecutor.enabled,
      mode: 'DIRECT_BOUNDED_HOST_EXECUTION',
      platform: process.platform,
    };
  }

  private async executeOperation(
    workspace: WorkspaceRegistration,
    request: LocalExecuteInput,
    toolId: LocalExecuteInput['operations'][number]['toolId'],
    rawInput: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (toolId) {
      case 'filesystem.read': {
        const input = FileReadSchema.parse(rawInput);
        const path = this.registry.resolveReadPath(workspace, input.path);
        this.assertDeclaredScope(path, request.readPaths, workspace, 'read');
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`Read target is not a file: ${input.path}`);
        if (info.size > this.config.maxOutputBytes) throw new Error(`File exceeds bridge output limit: ${input.path}`);
        const data = await readFile(path);
        return {
          toolId,
          ok: true,
          path: input.path,
          sizeBytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          encoding: input.encoding,
          content: input.encoding === 'base64'
            ? data.toString('base64')
            : redactSecrets(data.toString('utf8'), this.config.maxOutputBytes),
        };
      }
      case 'filesystem.write': {
        const input = FileWriteSchema.parse(rawInput);
        let path = this.registry.resolveWritePath(workspace, input.path);
        this.assertDeclaredScope(path, request.writePaths, workspace, 'write');
        const data = Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8');
        if (data.length > this.config.maxOutputBytes) throw new Error(`Write payload exceeds bridge limit: ${input.path}`);
        if (input.createDirectories) await mkdir(dirname(path), { recursive: true });
        path = this.registry.resolveWritePath(workspace, input.path);
        this.assertDeclaredScope(path, request.writePaths, workspace, 'write');
        await writeFile(path, data, { flag: 'w' });
        const verifiedPath = this.registry.resolveWritePath(workspace, input.path);
        const readBack = await readFile(verifiedPath);
        return {
          toolId,
          ok: verifiedPath === path && readBack.equals(data),
          path: input.path,
          bytesWritten: data.length,
          sha256: createHash('sha256').update(readBack).digest('hex'),
          readBackVerified: verifiedPath === path && readBack.equals(data),
        };
      }
      case 'powershell.execute': {
        if (process.platform !== 'win32') throw new Error('PowerShell execution requires Windows.');
        const input = PowerShellSchema.parse(rawInput);
        const scriptPath = this.registry.assertScript(workspace, input.scriptPath);
        this.assertDeclaredScope(scriptPath, request.readPaths, workspace, 'read');
        const cwd = input.cwd
          ? this.registry.resolveReadPath(workspace, input.cwd)
          : workspace.root;
        this.assertDeclaredScope(cwd, request.readPaths, workspace, 'read');
        const executableName = workspace.allowedExecutables.includes('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
        const executable = this.registry.assertExecutable(workspace, executableName);
        const result = await runProcess({
          executable,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...input.args],
          cwd,
          timeoutMs: input.timeoutMs ?? this.config.defaultTimeoutSeconds * 1_000,
          maxOutputBytes: this.config.maxOutputBytes,
        });
        return { toolId, ok: result.exitCode === 0 && !result.timedOut, scriptPath: input.scriptPath, result };
      }
      case 'runtime.inspect': {
        const input = InspectSchema.parse(rawInput);
        return this.inspectInternal(workspace, input);
      }
      case 'scheduled-task.manage':
        return this.manageScheduledTask(workspace, ScheduledTaskSchema.parse(rawInput));
    }
  }

  private async inspectInternal(
    workspace: WorkspaceRegistration,
    input: z.infer<typeof InspectSchema>,
  ): Promise<Record<string, unknown>> {
    if (input.kind === 'system') {
      return {
        toolId: 'runtime.inspect',
        ok: true,
        kind: 'system',
        platform: platform(),
        release: release(),
        node: process.version,
        uptimeSeconds: uptime(),
        totalMemory: totalmem(),
        freeMemory: freemem(),
      };
    }
    const cwd = input.cwd
      ? this.registry.resolveReadPath(workspace, input.cwd)
      : workspace.root;

    if (input.kind === 'git') {
      const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
      const executable = this.registry.assertExecutable(workspace, executableName);
      const [head, status] = await Promise.all([
        runProcess({ executable, args: ['rev-parse', 'HEAD'], cwd, timeoutMs: 30_000, maxOutputBytes: this.config.maxOutputBytes }),
        runProcess({ executable, args: ['status', '--porcelain=v1'], cwd, timeoutMs: 30_000, maxOutputBytes: this.config.maxOutputBytes }),
      ]);
      return { toolId: 'runtime.inspect', ok: head.exitCode === 0 && status.exitCode === 0, kind: 'git', head, status };
    }
    if (input.kind === 'docker') {
      const executableName = process.platform === 'win32' ? 'docker.exe' : 'docker';
      const executable = this.registry.assertExecutable(workspace, executableName);
      const [version, compose] = await Promise.all([
        runProcess({ executable, args: ['version', '--format', '{{json .}}'], cwd, timeoutMs: 30_000, maxOutputBytes: this.config.maxOutputBytes }),
        runProcess({ executable, args: ['compose', 'version'], cwd, timeoutMs: 30_000, maxOutputBytes: this.config.maxOutputBytes }),
      ]);
      return { toolId: 'runtime.inspect', ok: version.exitCode === 0 && compose.exitCode === 0, kind: 'docker', version, compose };
    }
    if (process.platform !== 'win32') throw new Error(`${input.kind} inspection requires Windows.`);
    const executableName = workspace.allowedExecutables.includes('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
    const executable = this.registry.assertExecutable(workspace, executableName);
    const names = input.names.map(quotePowerShell).join(',');
    const command = input.kind === 'process'
      ? `$n=@(${names}); Get-Process -ErrorAction SilentlyContinue | Where-Object { $n.Count -eq 0 -or $n -contains $_.ProcessName } | Select-Object ProcessName,Id,Path,StartTime | ConvertTo-Json -Depth 4`
      : input.kind === 'service'
        ? `$n=@(${names}); Get-Service | Where-Object { $n.Count -eq 0 -or $n -contains $_.Name } | Select-Object Name,Status,StartType | ConvertTo-Json -Depth 4`
        : `$n=@(${names}); Get-ScheduledTask | Where-Object { $n.Count -eq 0 -or $n -contains $_.TaskName } | Select-Object TaskName,TaskPath,State | ConvertTo-Json -Depth 4`;
    const result = await runProcess({
      executable,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      cwd,
      timeoutMs: 60_000,
      maxOutputBytes: this.config.maxOutputBytes,
    });
    return { toolId: 'runtime.inspect', ok: result.exitCode === 0, kind: input.kind, result };
  }

  private async manageScheduledTask(
    workspace: WorkspaceRegistration,
    input: z.infer<typeof ScheduledTaskSchema>,
  ): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32') throw new Error('Scheduled Task management requires Windows.');
    this.registry.assertScheduledTask(workspace, input.taskName);
    const schtasks = this.registry.assertExecutable(workspace, 'schtasks.exe');
    const args = ['/TN', input.taskName];
    if (input.operation === 'query') args.unshift('/Query');
    if (input.operation === 'run') args.unshift('/Run');
    if (input.operation === 'end') args.unshift('/End');
    if (input.operation === 'delete') args.unshift('/Delete', '/F');
    if (input.operation === 'create') {
      if (!input.executable || !input.schedule) throw new Error('Create requires executable and schedule.');
      const targetExecutable = this.registry.assertExecutable(workspace, input.executable);
      const command = [targetExecutable, ...input.args]
        .map((part) => `"${part.replaceAll('"', '\\"')}"`)
        .join(' ');
      args.unshift('/Create', '/F', '/TR', command, '/SC', input.schedule);
      if (input.modifier) args.push('/MO', String(input.modifier));
      if (input.startTime) args.push('/ST', input.startTime);
    }
    const result = await runProcess({
      executable: schtasks,
      args,
      cwd: workspace.root,
      timeoutMs: this.config.defaultTimeoutSeconds * 1_000,
      maxOutputBytes: this.config.maxOutputBytes,
    });
    return {
      toolId: 'scheduled-task.manage',
      ok: result.exitCode === 0,
      operation: input.operation,
      taskName: input.taskName,
      result,
    };
  }

  private assertDeclaredScope(
    candidate: string,
    scopes: readonly string[],
    workspace: WorkspaceRegistration,
    kind: 'read' | 'write',
  ): void {
    const resolved = scopes.map((scope) => kind === 'read'
      ? this.registry.resolveReadPath(workspace, scope)
      : this.registry.resolveWritePath(workspace, scope));
    if (!resolved.some((scope) => pathInside(candidate, scope))) {
      throw new Error(`${kind} target is outside the approved request scope.`);
    }
  }

  private failed(requestId: string, error: unknown): DelegationResult {
    const message = redactSecrets(error, this.config.maxOutputBytes);
    return {
      requestId,
      target: 'LOCAL_EXECUTOR',
      status: 'FAILED',
      summary: message,
      result: {},
      warnings: [],
      evidence: [],
      retryable: /timeout|temporar|unavailable|connection|econn/iu.test(message),
      errorCode: 'LOCAL_EXECUTOR_FAILED',
    };
  }

  private blocked(requestId: string, errorCode: string, summary: string): DelegationResult {
    return {
      requestId,
      target: 'LOCAL_EXECUTOR',
      status: 'BLOCKED',
      summary,
      result: {},
      warnings: [],
      evidence: [],
      retryable: false,
      errorCode,
    };
  }
}
