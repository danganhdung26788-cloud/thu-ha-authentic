import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';
import type { DelegationResult } from './contracts.js';
import { DelegationService } from './delegation-service.js';
import { redactSecrets } from './redaction.js';

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function resultForModel(result: DelegationResult) {
  return {
    content: [{
      type: 'text' as const,
      text: [
        `Delegation target: ${result.target}`,
        `Status: ${result.status}`,
        result.summary,
        result.warnings.length ? `Warnings: ${result.warnings.join(' | ')}` : '',
        'Evaluate this result yourself before presenting or acting on it. ChatGPT remains responsible for the final answer.',
      ].filter(Boolean).join('\n'),
    }],
    structuredContent: result,
    isError: result.status !== 'SUCCEEDED',
  };
}

const codexInputShape = {
  objective: z.string().trim().min(1).max(50_000).describe('The exact bounded coding task ChatGPT wants Codex to perform.'),
  context: z.string().trim().max(50_000).optional().describe('Only the relevant context already known by ChatGPT. Never include secrets.'),
  workspaceId: z.string().trim().min(1).max(120).optional().describe('An allowlisted workspace ID. Omit to use the server default.'),
  paths: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]).describe('Optional repository paths Codex should focus on.'),
  outputLanguage: z.enum(['vi', 'en']).optional().describe('Language for the specialist result. Vietnamese is the default.'),
  timeoutSeconds: z.number().int().min(10).max(1_800).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional().describe('Stable key to prevent duplicate specialist execution.'),
};

export function createMcpServer(service: DelegationService, config: BridgeConfig): McpServer {
  const server = new McpServer({
    name: 'system-ai-workflow-delegation-bridge',
    version: '0.1.0',
  }, {
    instructions: [
      'ChatGPT is the primary brain and owns the conversation, context, follow-ups, approvals, and final answer.',
      'Use this server only for explicit specialist delegation or bounded local execution when native ChatGPT reasoning or connected tools are insufficient.',
      'Do not use this server for current weather, web search, email, calendar, Drive search, ordinary writing, or status questions about the conversation.',
      'Select the target by choosing the explicit MCP tool. There is no backend router or Manager Agent.',
      'Treat delegated output as evidence or advice to evaluate, not as an automatic final answer.',
      'Read-only tools must not mutate state. Mutating tools require user-facing confirmation and must stay within the supplied scope.',
      'The local runtime executor is not an AI specialist and must never be described as Hermes or another model.',
    ].join(' '),
  });

  server.registerTool(
    'delegation_health',
    {
      title: 'Check delegation availability',
      description: 'Use only to verify which delegation targets and local capabilities are available. This does not answer user questions and does not create a task.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const health = await service.health();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(health) }],
        structuredContent: health,
      };
    },
  );

  if (config.codex.enabled) {
    server.registerTool(
      'ask_codex',
      {
        title: 'Ask Codex to inspect or advise on code',
        description: [
          'Call only when ChatGPT intentionally needs Codex-specific repository expertise.',
          'This tool is read-only and must not be used for weather, web research, email, calendar, general writing, or questions ChatGPT can answer directly.',
          'ChatGPT remains the primary brain and must evaluate the returned specialist result.',
        ].join(' '),
        inputSchema: codexInputShape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input) => resultForModel(await service.askCodex(input)),
    );

    server.registerTool(
      'execute_codex',
      {
        title: 'Ask Codex to modify an allowlisted repository',
        description: [
          'Call only after the user has approved a bounded code change and ChatGPT has selected Codex.',
          'This tool may modify files inside an allowlisted repository and run tests.',
          'It never grants itself broader permissions and never replaces ChatGPT conversation control.',
        ].join(' '),
        inputSchema: codexInputShape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) => resultForModel(await service.executeCodex(input)),
    );
  }

  if (config.localExecutor.enabled) {
    server.registerTool(
      'inspect_local_runtime',
      {
        title: 'Inspect the allowlisted local runtime',
        description: [
          'Use only when ChatGPT needs bounded inspection of the allowlisted local Windows/runtime environment.',
          'This is a read-only execution capability, not an AI model or specialist.',
        ].join(' '),
        inputSchema: {
          workspaceId: z.string().trim().min(1).max(120).optional(),
          kind: z.enum(['system', 'process', 'service', 'scheduled-task', 'docker', 'git']),
          names: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
          cwd: z.string().trim().min(1).max(1_000).optional(),
          idempotencyKey: z.string().trim().min(8).max(200).optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input) => resultForModel(await service.inspectLocalRuntime(input)),
    );

    server.registerTool(
      'execute_local_operations',
      {
        title: 'Execute bounded local operations',
        description: [
          'Call only after explicit user approval for the exact bounded local operations.',
          'Every operation, read path, and write path must be supplied explicitly.',
          'This is a controlled executor, not an AI specialist.',
          'Do not use this tool for general questions or tasks ChatGPT can perform directly.',
        ].join(' '),
        inputSchema: {
          objective: z.string().trim().min(1).max(50_000),
          context: z.string().trim().max(50_000).optional(),
          workspaceId: z.string().trim().min(1).max(120).optional(),
          operations: z.array(z.object({
            toolId: z.enum(['filesystem.read', 'filesystem.write', 'powershell.execute', 'runtime.inspect', 'scheduled-task.manage']),
            input: z.record(z.string(), z.unknown()),
          })).min(1).max(20),
          readPaths: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
          writePaths: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
          outputLanguage: z.enum(['vi', 'en']).optional(),
          timeoutSeconds: z.number().int().min(10).max(1_800).optional(),
          idempotencyKey: z.string().trim().min(8).max(200).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) => resultForModel(await service.executeLocalOperations(input)),
    );
  }

  if (config.specialist.enabled) {
    server.registerTool(
      'ask_specialist_agent',
      {
        title: 'Ask the configured Agents SDK specialist',
        description: [
          'Use only when ChatGPT determines that the configured specialist AI adds material value beyond ChatGPT and native tools.',
          'The target model is fixed by server configuration; this tool cannot select or silently switch providers.',
          'ChatGPT must evaluate the result and remains responsible for the final response.',
        ].join(' '),
        inputSchema: {
          objective: z.string().trim().min(1).max(50_000),
          context: z.string().trim().max(50_000).optional(),
          outputLanguage: z.enum(['vi', 'en']).optional(),
          timeoutSeconds: z.number().int().min(10).max(600).optional(),
          idempotencyKey: z.string().trim().min(8).max(200).optional(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (input) => resultForModel(await service.askSpecialist(input)),
    );
  }

  return server;
}

export function createHttpApp(service: DelegationService, config: BridgeConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.maxRequestBytes }));

  app.use((request: Request, response: Response, next: NextFunction) => {
    const host = (request.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    if (!config.allowedHosts.has(host)) {
      response.status(421).json({ error: 'host_not_allowed' });
      return;
    }
    if (config.authMode === 'bearer' && !tokenMatches(request.headers.authorization, config.authToken ?? '')) {
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  app.get('/health', async (_request, response) => {
    const health = await service.health();
    response.json({ ok: true, bridge: 'chatgpt-primary-delegation', targets: health.targets });
  });

  app.all(config.mcpPath, async (request, response) => {
    const server = createMcpServer(service, config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error('MCP bridge error:', redactSecrets(error, 8_192));
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal delegation bridge error' },
          id: null,
        });
      }
    }
  });

  return app;
}
