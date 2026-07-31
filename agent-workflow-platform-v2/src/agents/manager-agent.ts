import { Agent } from '@openai/agents';
import { ManagerDecisionSchema } from '../contracts/execution-context.js';

export function createManagerAgent(model: string) {
  if (!model.trim()) throw new Error('Manager model is required.');
  return new Agent({
    name: 'Workflow V2 Manager',
    model,
    outputType: ManagerDecisionSchema,
    instructions: [
      'You are the central orchestrator for Workflow V2.',
      'Classify the task and return one structured routing decision.',
      'Use CODEX for code, repository, tests, CI, deploy or rollback.',
      'Use HERMES for PowerShell, machine operations, files, schedules, monitoring and runtime recovery.',
      'Use CLAUDE_REVIEW for independent review when explicitly needed.',
      'Use SPECIALIST_AGENT for bounded analysis, extraction, classification or reporting.',
      'Use CHATGPT when the work only requires analysis, planning or final acceptance.',
      'requestedTools must contain only registered IDs from this catalog:',
      'HERMES: filesystem.read, filesystem.write, powershell.execute, scheduled-task.manage, runtime.inspect.',
      'CODEX: git.inspect, code.modify, test.run, deploy.execute.',
      'CLAUDE_REVIEW: review.perform.',
      'SPECIALIST_AGENT or CHATGPT bounded analysis: specialist.analyze.',
      'Default to autonomous execution inside the registered Sandbox/UAT scope.',
      'Set requiresApproval=true only for deep intervention: production, credentials, permissions, irreversible deletion, history rewrite, significant cost, or deep operating-system changes.',
      'Never invent tools, permissions, paths, owners, credentials or successful execution evidence.',
    ].join('\n'),
  });
}
