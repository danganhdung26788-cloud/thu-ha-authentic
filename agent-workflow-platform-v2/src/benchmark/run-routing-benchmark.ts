import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compileChatTask } from '../chat/task-compiler.js';
import { ManagerDecisionSchema, type ExecutionContext } from '../contracts/execution-context.js';
import { closePool } from '../db/pool.js';
import { runManagerDecision } from '../runtime/run-manager.js';
import { ROUTING_SCENARIOS } from './routing-scenarios.js';

const ALLOWED_TOOLS = new Set([
  'filesystem.read',
  'filesystem.write',
  'powershell.execute',
  'scheduled-task.manage',
  'runtime.inspect',
  'git.inspect',
  'code.modify',
  'test.run',
  'deploy.execute',
  'review.perform',
  'specialist.analyze',
  'gemini.analyze',
  'gemini.multimodal',
  'gemini.cross-check',
  'notebooklm.prepare-source-package',
  'notebooklm.register-result',
  'canva.asset.upload',
  'canva.design.create',
  'canva.template.autofill',
  'canva.design.export',
  'canva.design.publish',
]);

type ScenarioResult = Readonly<{
  id: string;
  prompt: string;
  expectedExecutor: string;
  actualExecutor: string | null;
  schemaValid: boolean;
  routeCorrect: boolean;
  approvalCorrect: boolean;
  clarificationCorrect: boolean;
  toolsValid: boolean;
  durationMs: number;
  error: string | null;
}>;

async function runScenario(index: number): Promise<ScenarioResult> {
  const scenario = ROUTING_SCENARIOS[index];
  if (!scenario) throw new Error(`Missing scenario at index ${index}.`);
  const compiled = compileChatTask(scenario.prompt, []);
  const context: ExecutionContext = {
    taskId: `BENCH-${scenario.id}`,
    correlationId: `BENCH-CORR-${scenario.id}`,
    ownerId: process.env.DEFAULT_OWNER_ID?.trim() || 'danganhdung',
    workspaceId: process.env.DEFAULT_WORKSPACE_ID?.trim() || 'workflow-v2-sandbox',
    readScope: compiled.readScope,
    writeScope: compiled.writeScope,
    autonomyMode: compiled.autonomyMode,
    riskLevel: compiled.riskLevel,
  };
  const started = performance.now();
  try {
    const raw = await runManagerDecision(context, scenario.prompt);
    const decision = ManagerDecisionSchema.parse(raw);
    return {
      id: scenario.id,
      prompt: scenario.prompt,
      expectedExecutor: scenario.expectedExecutor,
      actualExecutor: decision.executor,
      schemaValid: true,
      routeCorrect: decision.executor === scenario.expectedExecutor,
      approvalCorrect: decision.requiresApproval === scenario.expectApproval,
      clarificationCorrect: Boolean(decision.clarification) === scenario.expectClarification,
      toolsValid: decision.requestedTools.every((tool) => ALLOWED_TOOLS.has(tool))
        && (decision.toolCalls ?? []).every((call) => ALLOWED_TOOLS.has(call.toolId)),
      durationMs: Math.round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    return {
      id: scenario.id,
      prompt: scenario.prompt,
      expectedExecutor: scenario.expectedExecutor,
      actualExecutor: null,
      schemaValid: false,
      routeCorrect: false,
      approvalCorrect: false,
      clarificationCorrect: false,
      toolsValid: false,
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];
  for (let index = 0; index < ROUTING_SCENARIOS.length; index += 1) {
    const result = await runScenario(index);
    results.push(result);
    process.stdout.write(
      `[${String(index + 1).padStart(3, '0')}/100] ${result.id} `
      + `schema=${result.schemaValid} route=${result.routeCorrect} `
      + `approval=${result.approvalCorrect} clarification=${result.clarificationCorrect}\n`,
    );
  }

  const schemaValid = results.filter((item) => item.schemaValid).length;
  const routeCorrect = results.filter((item) => item.routeCorrect).length;
  const approvalIndexes = ROUTING_SCENARIOS
    .map((item, index) => item.expectApproval ? index : -1)
    .filter((index) => index >= 0);
  const clarificationIndexes = ROUTING_SCENARIOS
    .map((item, index) => item.expectClarification ? index : -1)
    .filter((index) => index >= 0);
  const approvalCorrect = approvalIndexes.filter((index) => results[index]?.approvalCorrect).length;
  const clarificationCorrect = clarificationIndexes
    .filter((index) => results[index]?.clarificationCorrect).length;
  const toolsValid = results.filter((item) => item.toolsValid).length;
  const summary = {
    total: results.length,
    schemaValid,
    schemaRate: schemaValid / results.length,
    routeCorrect,
    routeAccuracy: routeCorrect / results.length,
    approvalCases: approvalIndexes.length,
    approvalCorrect,
    approvalRecall: approvalIndexes.length ? approvalCorrect / approvalIndexes.length : 1,
    clarificationCases: clarificationIndexes.length,
    clarificationCorrect,
    clarificationRecall: clarificationIndexes.length
      ? clarificationCorrect / clarificationIndexes.length
      : 1,
    toolsValid,
    toolsValidRate: toolsValid / results.length,
  };

  const outputDirectory = path.resolve(process.cwd(), 'runtime', 'benchmark');
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(
    outputDirectory,
    `routing-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(outputPath, JSON.stringify({ summary, results }, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`Benchmark report: ${outputPath}\n`);

  const accepted = summary.schemaRate === 1
    && summary.routeAccuracy >= 0.95
    && summary.approvalRecall === 1
    && summary.clarificationRecall === 1
    && summary.toolsValidRate === 1;
  if (!accepted) throw new Error('Local Manager routing benchmark did not meet the acceptance gate.');
}

main()
  .then(() => closePool())
  .catch(async (error: unknown) => {
    console.error(error);
    await closePool();
    process.exitCode = 1;
  });
