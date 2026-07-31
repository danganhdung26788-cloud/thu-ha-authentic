import { z } from 'zod';
import { PlannedToolCallSchema } from '../contracts/execution-context.js';
import type { ParsedExecutorRequest } from '../executors/contracts.js';

const MARKER_START = '<workflow-v2-tool-calls>';
const MARKER_END = '</workflow-v2-tool-calls>';
const ToolCallsSchema = z.array(PlannedToolCallSchema);

export function extractToolCalls(request: ParsedExecutorRequest) {
  if (request.toolCalls.length) return request.toolCalls;
  const start = request.instructions.lastIndexOf(MARKER_START);
  const end = request.instructions.lastIndexOf(MARKER_END);
  if (start < 0 || end <= start) return [];
  const json = request.instructions.slice(start + MARKER_START.length, end);
  return ToolCallsSchema.parse(JSON.parse(json));
}

export function stripToolCallEnvelope(instructions: string): string {
  const start = instructions.lastIndexOf(`\n\n${MARKER_START}`);
  return start >= 0 ? instructions.slice(0, start) : instructions;
}
