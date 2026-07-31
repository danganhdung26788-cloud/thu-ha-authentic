import { z } from 'zod';
import { getPool } from '../db/pool.js';

export const ToolStatusSchema = z.enum(['DRAFT', 'TESTING', 'ACTIVE', 'DISABLED', 'DEPRECATED']);
export const ToolRiskClassSchema = z.enum(['READ', 'LOW_WRITE', 'HIGH_WRITE', 'DEEP_INTERVENTION']);

export const ToolRegistrationSchema = z.object({
  toolId: z.string().min(1),
  displayName: z.string().min(1),
  riskClass: ToolRiskClassSchema,
  adapter: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  status: ToolStatusSchema,
});

export const ToolGrantSchema = z.object({
  agentId: z.string().min(1),
  toolId: z.string().min(1),
  ownerScope: z.string().min(1).default('*'),
  workspaceScope: z.string().min(1).default('*'),
});

export type ToolRegistrationInput = z.infer<typeof ToolRegistrationSchema>;
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

type ToolRow = Readonly<{
  tool_id: string;
  display_name: string;
  risk_class: string;
  adapter: string;
  input_schema: unknown;
  status: string;
}>;

function mapTool(row: ToolRow): ToolRegistrationInput {
  return ToolRegistrationSchema.parse({
    toolId: row.tool_id,
    displayName: row.display_name,
    riskClass: row.risk_class,
    adapter: row.adapter,
    inputSchema: row.input_schema,
    status: row.status,
  });
}

export class ToolRegistryStore {
  async list(): Promise<ToolRegistrationInput[]> {
    const result = await getPool().query<ToolRow>('SELECT * FROM tool_registry ORDER BY tool_id');
    return result.rows.map(mapTool);
  }

  async get(toolId: string): Promise<ToolRegistrationInput | null> {
    const result = await getPool().query<ToolRow>(
      'SELECT * FROM tool_registry WHERE tool_id = $1',
      [toolId],
    );
    const row = result.rows[0];
    return row ? mapTool(row) : null;
  }

  async upsert(rawInput: unknown): Promise<ToolRegistrationInput> {
    const input = ToolRegistrationSchema.parse(rawInput);
    const result = await getPool().query<ToolRow>(
      `INSERT INTO tool_registry(tool_id, display_name, risk_class, adapter, input_schema, status)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT(tool_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         risk_class = EXCLUDED.risk_class,
         adapter = EXCLUDED.adapter,
         input_schema = EXCLUDED.input_schema,
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING *`,
      [
        input.toolId,
        input.displayName,
        input.riskClass,
        input.adapter,
        JSON.stringify(input.inputSchema),
        input.status,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Tool upsert failed: ${input.toolId}`);
    return mapTool(row);
  }

  async grant(rawInput: unknown): Promise<ToolGrant> {
    const input = ToolGrantSchema.parse(rawInput);
    await getPool().query(
      `INSERT INTO agent_tool_grants(agent_id, tool_id, owner_scope, workspace_scope)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(agent_id, tool_id, owner_scope, workspace_scope) DO NOTHING`,
      [input.agentId, input.toolId, input.ownerScope, input.workspaceScope],
    );
    return input;
  }

  async authorize(
    agentId: string,
    toolIds: readonly string[],
    ownerId: string,
    workspaceId: string,
  ): Promise<ToolRegistrationInput[]> {
    const unique = [...new Set(toolIds)];
    if (!unique.length) return [];
    const result = await getPool().query<ToolRow>(
      `SELECT DISTINCT tools.*
       FROM agent_tool_grants grants
       JOIN tool_registry tools ON tools.tool_id = grants.tool_id
       JOIN agent_registry agents ON agents.agent_id = grants.agent_id
       WHERE grants.agent_id = $1
         AND grants.tool_id = ANY($2::text[])
         AND grants.owner_scope IN ('*', $3)
         AND grants.workspace_scope IN ('*', $4)
         AND tools.status = 'ACTIVE'
         AND agents.status = 'ACTIVE'`,
      [agentId, unique, ownerId, workspaceId],
    );
    const byId = new Map(result.rows.map((row) => {
      const tool = mapTool(row);
      return [tool.toolId, tool] as const;
    }));
    const missing = unique.filter((toolId) => !byId.has(toolId));
    if (missing.length) {
      throw new Error(
        `Tool grant denied: agent=${agentId}, owner=${ownerId}, workspace=${workspaceId}, tools=${missing.join(',')}`,
      );
    }
    return unique.map((toolId) => byId.get(toolId) as ToolRegistrationInput);
  }

  async isGranted(agentId: string, toolId: string, ownerId: string, workspaceId: string): Promise<boolean> {
    try {
      await this.authorize(agentId, [toolId], ownerId, workspaceId);
      return true;
    } catch {
      return false;
    }
  }
}
