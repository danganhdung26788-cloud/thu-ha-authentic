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
        `Specialist target: ${result.target}`,
        `Status: ${result.status}`,
        result.summary,
        result.warnings.length ? `Warnings: ${result.warnings.join(' | ')}` : '',
        'Evaluate this specialist result yourself before presenting or acting on it. ChatGPT remains responsible for the final answer.',
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
  });

  server.registerTool(
    'delegation_health',
    {
      title: 'Check specialist delegation availability',
      description: 'Use only to verify which specialist delegation targets are available. This does not answer user questions and does not create a task.',
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

  if (config.hermes.enabled) {
    server.registerTool(
      'inspect_with_hermes',
      {
        title: 'Inspect the local runtime with Hermes',
        description: 'Use only when ChatGPT needs bounded inspection of the allowlisted Windows/runtime environment. This tool is read-only.',
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
      async (input) => resultForModel(await service.inspectWithHermes(input)),
    );

    server.registerTool(
      'execute_with_hermes',
      {
        title: 'Execute bounded local operations with Hermes',
        description: [
          'Call only after explicit user approval for the exact bounded local operations.',
          'Every operation, read path, and write path must be supplied explicitly.',
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
      async (input) => resultForModel(await service.executeWithHermes(input)),
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
