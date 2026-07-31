import { Codex } from '@openai/codex-sdk';
import { ExecutorRequestSchema, type ExecutorResult } from '../executors/contracts.js';
import type { HostAdapterEnv } from './config.js';
import { runProcess } from './process-runner.js';
import { stripToolCallEnvelope } from './tool-calls.js';
import { WorkspaceRegistry } from './workspace-registry.js';

const CODEX_TOOLS = new Set(['git.inspect', 'code.modify', 'test.run', 'deploy.execute']);

function resultEvidence(payload: unknown) {
  return {
    name: 'codex-host-result.json',
    mediaType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
  };
}

async function gitSnapshot(
  root: string,
  maxOutputBytes: number,
): Promise<Record<string, unknown>> {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git';
  const head = await runProcess({
    executable,
    args: ['rev-parse', 'HEAD'],
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes,
  });
  const status = await runProcess({
    executable,
    args: ['status', '--porcelain=v1'],
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes,
  });
  const diff = await runProcess({
    executable,
    args: ['diff', '--stat'],
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes,
  });
  return { head, status, diff };
}

export class CodexHostExecutor {
  constructor(
    readonly registry: WorkspaceRegistry,
    readonly env: HostAdapterEnv,
  ) {}

  async execute(rawRequest: unknown): Promise<ExecutorResult> {
    const request = ExecutorRequestSchema.parse(rawRequest);
    if (request.executor !== 'CODEX') throw new Error(`Codex adapter cannot execute ${request.executor}`);
    const workspace = this.registry.get(request.context.ownerId, request.context.workspaceId);
    for (const tool of request.requestedTools) {
      if (!CODEX_TOOLS.has(tool)) throw new Error(`Codex tool is not allowed: ${tool}`);
    }
    const gitExecutable = process.platform === 'win32' ? 'git.exe' : 'git';
    this.registry.assertExecutable(workspace, gitExecutable);

    const before = await gitSnapshot(workspace.root, this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES);
    if ((before.head as { exitCode?: number }).exitCode !== 0) {
      throw new Error('Codex workspace must be a valid Git repository.');
    }

    const codex = new Codex({});
    const thread = codex.startThread({
      workingDirectory: workspace.root,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: false,
      networkAccessEnabled: this.env.CODEX_NETWORK_ACCESS,
      webSearchMode: 'disabled',
      modelReasoningEffort: this.env.CODEX_REASONING_EFFORT,
      ...(this.env.CODEX_MODEL ? { model: this.env.CODEX_MODEL } : {}),
    });
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Codex execution timed out.')),
      this.env.HOST_ADAPTER_DEFAULT_TIMEOUT_MS,
    );
    timer.unref();

    const prompt = [
      'You are the Codex executor inside Workflow AI V2.',
      `TASK_ID: ${request.context.taskId}`,
      `OWNER_ID: ${request.context.ownerId}`,
      `WORKSPACE_ID: ${request.context.workspaceId}`,
      `OBJECTIVE: ${request.objective}`,
      `INSTRUCTIONS: ${stripToolCallEnvelope(request.instructions)}`,
      `AUTHORIZED_TOOLS: ${request.requestedTools.join(', ')}`,
      'Work only inside the current repository.',
      'Do not change credentials, permissions, remote repository visibility, billing, or operating-system configuration.',
      'Do not force-push, rewrite history, or deploy production unless the task explicitly carries an approved deep-intervention record.',
      'Run relevant tests and report exact evidence. Leave the repository in a reviewable state.',
    ].join('\n');

    try {
      const turn = await thread.run(prompt, { signal: controller.signal });
      const after = await gitSnapshot(workspace.root, this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES);
      const payload = {
        threadId: thread.id,
        finalResponse: turn.finalResponse,
        usage: turn.usage,
        itemCount: turn.items.length,
        before,
        after,
      };
      return {
        status: 'SUCCEEDED',
        summary: turn.finalResponse.trim() || 'Codex completed the repository task.',
        output: payload,
        evidence: [resultEvidence(payload)],
        retryable: false,
      };
    } catch (error) {
      const after = await gitSnapshot(workspace.root, this.env.HOST_ADAPTER_MAX_OUTPUT_BYTES)
        .catch(() => ({ unavailable: true }));
      const message = error instanceof Error ? error.message : String(error);
      const payload = { error: message, before, after };
      return {
        status: 'FAILED',
        summary: message,
        output: payload,
        evidence: [resultEvidence(payload)],
        errorCode: 'CODEX_EXECUTION_FAILED',
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
