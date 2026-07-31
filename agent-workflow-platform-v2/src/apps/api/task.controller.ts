import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { PlatformService } from './platform.service.js';

@Controller('/v1/tasks')
export class TaskController {
  constructor(private readonly platform: PlatformService) {}

  @Post()
  async create(@Body() body: unknown): Promise<Record<string, unknown>> {
    try {
      return await this.platform.submitTask(body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid task contract.', issues: error.issues });
      }
      throw error;
    }
  }

  @Get(':taskId')
  async get(@Param('taskId') taskId: string): Promise<Record<string, unknown>> {
    const task = await this.platform.getTask(taskId);
    if (!task) throw new NotFoundException(`Task not found: ${taskId}`);
    return task;
  }
}
