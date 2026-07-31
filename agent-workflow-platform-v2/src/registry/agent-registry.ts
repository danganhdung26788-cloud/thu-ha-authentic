import { z } from 'zod';
import { ExecutorSchema } from '../contracts/execution-context.js';
import { getPool } from '../db/pool.js';

export const AgentStatusSchema = z.enum(['DRAFT', 'TESTING', 'ACTIVE', 'DISABLED', 'DEPRECATED']);

export const AgentRegistrationSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  executor: ExecutorSchema,
  provider: z.string().min(1),
  model: z.string().min(1).nullable().default(null),
  status: AgentStatusSchema,
  capabilities: z.array(z.string().min(1)).default([]),
  configuration: z.record(z.string(), z.unknown()).default({}),
  version: z.number().int().min(1).default(1),
});

export type AgentRegistrationInput = z.input<typeof AgentRegistrationSchema>;
export type AgentRegistration = z.output<typeof AgentRegistrationSchema>;

type AgentRow = Readonly<{
  agent_id: string;
  display_name: string;
  executor: string;
  provider: string;
  model: string | null;
  status: string;
  capabilities: unknown;
  configuration: unknown;
  version: number;
}>;

function mapAgent(row: AgentRow): AgentRegistration {
  return AgentRegistrationSchema.parse({
    agentId: row.agent_id,
    displayName: row.display_name,
    executor: row.executor,
    provider: row.provider,
    model: row.model,
    status: row.status,
    capabilities: row.capabilities,
    configuration: row.configuration,
    version: row.version,
  });
}

export class AgentRegistryStore {
  async list(): Promise<AgentRegistration[]> {
    const result = await getPool().query<AgentRow>('SELECT * FROM agent_registry ORDER BY agent_id');
    return result.rows.map(mapAgent);
  }

  async get(agentId: string): Promise<AgentRegistration | null> {
    const result = await getPool().query<AgentRow>('SELECT * FROM agent_registry WHERE agent_id = $1', [agentId]);
    const row = result.rows[0];
    return row ? mapAgent(row) : null;
  }

  async upsert(rawInput: AgentRegistrationInput): Promise<AgentRegistration> {
    const input = AgentRegistrationSchema.parse(rawInput);
    const result = await getPool().query<AgentRow>(
      `INSERT INTO agent_registry(
        agent_id, display_name, executor, provider, model, status,
        capabilities, configuration, version
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
      ON CONFLICT(agent_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        executor = EXCLUDED.executor,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        status = EXCLUDED.status,
        capabilities = EXCLUDED.capabilities,
        configuration = EXCLUDED.configuration,
        version = agent_registry.version + 1,
        updated_at = now()
      RETURNING *`,
      [input.agentId, input.displayName, input.executor, input.provider, input.model,
        input.status, JSON.stringify(input.capabilities), JSON.stringify(input.configuration), input.version],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Agent upsert failed: ${input.agentId}`);
    return mapAgent(row);
  }
}
