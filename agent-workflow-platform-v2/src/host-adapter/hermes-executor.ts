import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { platform, release, totalmem, freemem, uptime } from 'node:os';
import { z } from 'zod';
import { ExecutorRequestSchema, type ExecutorResult } from '../executors/contracts.js';
import type { HostAdapterEnv } from './config.js';
import { runProcess } from './process-runner.js';
import { extractToolCalls } from './tool-calls.js';
import { pathInside, type WorkspaceRegistration, WorkspaceRegistry } from './workspace-registry.js';

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
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
});
const InspectSchema = z.object({
  kind: z.enum(['system', 'process', 'service', 'scheduled-task', 'docker', 'git']),
  names: z.array(z.string().min(1)).default([]),
  cwd: z.string().optional(),
});
const ScheduledTaskSchema = z.object({
  operation: z.enum(['query', 'run', 'end', 'delete', 'create']),
  taskName: z.string().min(1),
  executable: z.string().optional(),
  args: z.array(z.string()).default([]),
  schedule: z.enum(['ONLOGON', 'DAILY', 'MINUTE']).optional(),
  modifier: z.number().int().min(1).max(1440).optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

function scopePaths(scopes: string[], root: string): string[] {
  return scopes
    .filter((scope) => !scope.includes('://'))
    .map((scope) => resolve(root, scope));
}

function assertRequestScope(candidate: string, scopes: string[], root: string, kind: 'read' | 'write'): void {
  const paths = scopePaths(scopes, root);
  if (!paths.length || !paths.some((scope) => pathInside(candidate, scope))) {
    throw new Error(`${kind} target is outside task scope: ${candidate}`);
  }
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function evidence(name: string, payload: unknown) {
  return {
    name,
    mediaType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
  };
}

export class HermesHostExecutor {
  constructor(
    readonly registry: WorkspaceRegistry,
    readonly env: HostAdapterEnv,
  ) {}

  async execute(rawRequest: unknown): Promise<ExecutorResult> {
    const request = ExecutorRequestSchema.parse(rawRequest);
    if (request.executor !== 'HERMES') throw new Error(`Hermes adapter cannot execute ${request.executor}`);
    const workspace = this.registry.get(request.context.ownerId, request.context.workspaceId);
    const calls = extractToolCalls(request);
    if (!calls.length && request.requestedTools.length) {
      throw new Error('Hermes requires structured toolCalls; free-form shell execution is disabled.');
    }
    const requested = new Set(request.requestedTools);
    const outputs: Array<Record<string, unknown>> = [];

    for (const call of calls) {
      if (!requested.has(call.toolId)) throw new Error(`Tool call was not requested: ${call.toolId}`);
      outputs.push(await this.executeCall(workspace, request.context, call.toolId, call.input));
    }

    const failed = outputs.some((item) => item.ok === false);
    const result: ExecutorResult = {
      status: failed ? 'FAILED' : 'SUCCEEDED',
      summary: failed
        ? 'Hermes completed with one or more failed bounded actions.'
        : `Hermes completed ${outputs.length} bounded action(s).`,
      output: { actions: outputs },
      evidence: [evidence('hermes-host-result.json', {
        taskId: request.context.taskId,
        ownerId: request.context.ownerId,
        workspaceId: request.context.workspaceId,
        actions: outputs,
      })],
      errorCode: failed ? 'HERMES_ACTION_FAILED' : undefined,
      retryable: failed,
    };
    return result;
  }

  private async executeCall(
    workspace: WorkspaceRegistration,
    context: z.infer<typeof ExecutorRequestSchema>['context'],
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (toolId) {
      case 'filesystem.read': {
        const parsed = FileReadSchema.parse(input);
        const path = this.registry.resolveReadPath(workspace, parsed.path);
        assertRequestScope(path, context.readScope, workspace.root, 'read');
        const data = await readFile(path);
        return {
          toolId,
          ok: true,
          path,
          size: data.length,
          content: parsed.encoding === 'base64' ? data.toString('base64') : data.toString('utf8'),
          encoding: parsed.encoding,
        };
      }
      case 'filesystem.write': {
        const parsed = FileWriteSchema.parse(input);
        const path = this.registry.resolveWritePath(workspace, parsed.path);
        assertRequestScope(path, context.writeScope, workspace.root, 'write');
        const data = Buffer.from(parsed.content, parsed.encoding === 'base64' ? 'base64' : 'utf8');
        if (data.length > this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES) {
          throw new Error(`Write payload exceeds limit: ${data.length}`);
        }
        if (parsed.createDirectories) await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
        const readBack = await readFile(path);
        return { toolId, ok: true, path, bytesWritten: data.length, readBackBytes: readBack.length };
      }
      case 'powershell.execute': {
        if (process.platform !== 'win32') throw new Error('PowerShell host execution requires Windows.');
        const parsed = PowerShellSchema.parse(input);
        const scriptPath = this.registry.assertScript(workspace, parsed.scriptPath);
        assertRequestScope(scriptPath, context.readScope, workspace.root, 'read');
        const cwd = parsed.cwd
          ? this.registry.resolveReadPath(workspace, parsed.cwd)
          : workspace.root;
        assertRequestScope(cwd, context.readScope, workspace.root, 'read');
        const executable = workspace.allowedExecutables.includes('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
        this.registry.assertExecutable(workspace, executable);
        const run = await runProcess({
          executable,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath, ...parsed.args],
          cwd,
          timeoutMs: parsed.timeoutMs ?? this.env.HOST_ADAPTER_DEFAULT_TIMEOUT_MS,
          maxOutputBytes: this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES,
        });
        return { toolId, ok: run.exitCode === 0 && !run.timedOut, ...run };
      }
      case 'runtime.inspect': {
        const parsed = InspectSchema.parse(input);
        return this.inspect(workspace, context, parsed);
      }
      case 'scheduled-task.manage': {
        if (process.platform !== 'win32') throw new Error('Scheduled Task management requires Windows.');
        return this.manageScheduledTask(workspace, context, ScheduledTaskSchema.parse(input));
      }
      default:
        throw new Error(`Hermes tool is not implemented by host adapter: ${toolId}`);
    }
  }

  private async inspect(
    workspace: WorkspaceRegistration,
    context: z.infer<typeof ExecutorRequestSchema>['context'],
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
    assertRequestScope(cwd, context.readScope, workspace.root, 'read');

    if (input.kind === 'git') {
      this.registry.assertExecutable(workspace, 'git.exe');
      const head = await runProcess({ executable: 'git.exe', args: ['rev-parse', 'HEAD'], cwd, timeoutMs: 30_000, maxOutputBytes: this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES });
      const status = await runProcess({ executable: 'git.exe', args: ['status', '--porcelain=v1'], cwd, timeoutMs: 30_000, maxOutputBytes: this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES });
      return { toolId: 'runtime.inspect', ok: head.exitCode === 0 && status.exitCode === 0, kind: 'git', head, status };
    }
    if (input.kind === 'docker') {
      this.registry.assertExecutable(workspace, 'docker.exe');
      const version = await runProcess({ executable: 'docker.exe', args: ['version', '--format', '{{json .}}'], cwd, timeoutMs: 30_000, maxOutputBytes: this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES });
      const compose = await runProcess({ executable: 'docker.exe', args: ['compose', 'version'], cwd, timeoutMs: 30_000, maxOutputBytes: this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES });
      return { toolId: 'runtime.inspect', ok: version.exitCode === 0 && compose.exitCode === 0, kind: 'docker', version, compose };
    }

    const executable = workspace.allowedExecutables.includes('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
    this.registry.assertExecutable(workspace, executable);
    const names = input.names.map(quotePowerShell).join(',');
    const command = input.kind === 'process'
      ? `$n=@(${names}); Get-Process -ErrorAction SilentlyContinue | Where-Object { $n.Count -eq 0 -or $n -contains $_.ProcessName } | Select-Object ProcessName,Id,Path,StartTime | ConvertTo-Json -Depth 4`
      : input.kind === 'service'
        ? `$n=@(${names}); Get-Service | Where-Object { $n.Count -eq 0 -or $n -contains $_.Name } | Select-Object Name,Status,StartType | ConvertTo-Json -Depth 4`
        : `$n=@(${names}); Get-ScheduledTask | Where-Object { $n.Count -eq 0 -or $n -contains $_.TaskName } | Select-Object TaskName,TaskPath,State | ConvertTo-Json -Depth 4`;
    const run = await runProcess({
      executable,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      cwd,
      timeoutMs: 60_000,
      maxOutputBytes: this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES,
    });
    return { toolId: 'runtime.inspect', ok: run.exitCode === 0, kind: input.kind, run };
  }

  private async manageScheduledTask(
    workspace: WorkspaceRegistration,
    context: z.infer<typeof ExecutorRequestSchema>['context'],
    input: z.infer<typeof ScheduledTaskSchema>,
  ): Promise<Record<string, unknown>> {
    if (!input.taskName.startsWith(workspace.scheduledTaskPrefix)) {
      throw new Error(`Scheduled Task must use prefix ${workspace.scheduledTaskPrefix}`);
    }
    this.registry.assertExecutable(workspace, 'schtasks.exe');
    const args = ['/TN', input.taskName];
    if (input.operation === 'query') args.unshift('/Query');
    if (input.operation === 'run') args.unshift('/Run');
    if (input.operation === 'end') args.unshift('/End');
    if (input.operation === 'delete') args.unshift('/Delete', '/F');
    if (input.operation === 'create') {
      if (!input.executable || !input.schedule) throw new Error('Create requires executable and schedule.');
      this.registry.assertExecutable(workspace, basename(input.executable));
      const command = [input.executable, ...input.args].map((part) => `"${part.replaceAll('"', '\\"')}"`).join(' ');
      args.unshift('/Create', '/F', '/TR', command, '/SC', input.schedule);
      if (input.modifier) args.push('/MO', String(input.modifier));
      if (input.startTime) args.push('/ST', input.startTime);
    }
    const run = await runProcess({
      executable: 'schtasks.exe',
      args,
      cwd: workspace.root,
      timeoutMs: this.env.HOST_ADAPTER_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES,
    });
    return { toolId: 'scheduled-task.manage', ok: run.exitCode === 0, operation: input.operation, taskName: input.taskName, run };
  }
}
