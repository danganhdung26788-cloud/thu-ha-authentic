import { BadRequestException, Controller, Get, NotFoundException, Param, Put, Body, UseGuards } from '@nestjs/common';
import { ZodError } from 'zod';
import { AgentRegistryService } from './agent-registry.service.js';
import { ApiTokenGuard } from './api-token.guard.js';

@Controller('/v1/agents')
@UseGuards(ApiTokenGuard)
export class AgentController {
  constructor(private readonly agents: AgentRegistryService) {}

  @Get()
  list() {
    return this.agents.list();
  }

  @Get(':agentId')
  async get(@Param('agentId') agentId: string) {
    const agent = await this.agents.get(agentId);
    if (!agent) throw new NotFoundException(`Agent not found: ${agentId}`);
    return agent;
  }

  @Put(':agentId')
  async upsert(@Param('agentId') agentId: string, @Body() body: unknown) {
    try {
      return await this.agents.upsert(agentId, body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid agent registration.', issues: error.issues });
      }
      throw error;
    }
  }
}
