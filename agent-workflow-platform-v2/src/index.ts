import { parseExecutionContext } from './contracts/execution-context.js';
import { runManagerDecision } from './runtime/run-manager.js';

async function main(): Promise<void> {
  const request = process.argv.slice(2).join(' ').trim();
  if (!request) {
    throw new Error('Usage: npm run dev -- "<task request>"');
  }

  const context = parseExecutionContext({
    taskId: process.env.TASK_ID,
    correlationId: process.env.CORRELATION_ID,
    ownerId: process.env.OWNER_ID,
    workspaceId: process.env.WORKSPACE_ID,
    readScope: JSON.parse(process.env.READ_SCOPE_JSON ?? '[]'),
    writeScope: JSON.parse(process.env.WRITE_SCOPE_JSON ?? '[]'),
    autonomyMode: process.env.AUTONOMY_MODE ?? 'SANDBOX_HIGH',
    riskLevel: process.env.RISK_LEVEL ?? 'LOW',
  });

  const decision = await runManagerDecision(context, request);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: 'FAIL', error: message })}\n`);
  process.exitCode = 1;
});
