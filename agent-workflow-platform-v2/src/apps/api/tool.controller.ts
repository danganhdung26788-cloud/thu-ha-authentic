import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ZodError } from 'zod';
import { ToolRegistryStore, ToolRegistrationSchema } from '../../registry/tool-registry.js';
import { ApiTokenGuard } from './api-token.guard.js';

@Controller('/v1/tools')
@UseGuards(ApiTokenGuard)
export class ToolController {
  readonly #tools = new ToolRegistryStore();

  @Get()
  list() {
    return this.#tools.list();
  }

  @Put(':toolId')
  async upsert(@Param('toolId') toolId: string, @Body() body: unknown) {
    try {
      return await this.#tools.upsert(ToolRegistrationSchema.parse({
        ...(typeof body === 'object' && body !== null ? body : {}),
        toolId,
      }));
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid tool registration.', issues: error.issues });
      }
      throw error;
    }
  }

  @Post(':toolId/grants/:agentId')
  async grant(
    @Param('toolId') toolId: string,
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ) {
    try {
      return await this.#tools.grant({
        ...(typeof body === 'object' && body !== null ? body : {}),
        toolId,
        agentId,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid tool grant.', issues: error.issues });
      }
      throw error;
    }
  }
}
