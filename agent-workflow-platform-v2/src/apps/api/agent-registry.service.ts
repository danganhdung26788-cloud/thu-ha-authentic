import { Injectable } from '@nestjs/common';
import { AgentRegistrationSchema, AgentRegistryStore } from '../../registry/agent-registry.js';

@Injectable()
export class AgentRegistryService {
  readonly #store = new AgentRegistryStore();

  list() {
    return this.#store.list();
  }

  get(agentId: string) {
    return this.#store.get(agentId);
  }

  upsert(agentId: string, body: unknown) {
    const parsed = AgentRegistrationSchema.parse({
      ...(typeof body === 'object' && body !== null ? body : {}),
      agentId,
    });
    return this.#store.upsert(parsed);
  }
}
