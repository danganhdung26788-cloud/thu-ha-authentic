import { BadRequestException, Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ZodError } from 'zod';
import { AdminQueryService } from './admin-query.service.js';
import { ApiTokenGuard } from './api-token.guard.js';

@Controller('/v1/admin')
@UseGuards(ApiTokenGuard)
export class AdminController {
  constructor(private readonly admin: AdminQueryService) {}

  @Get('/overview')
  async overview(@Query() query: Record<string, string | undefined>) {
    return this.withValidation(() => this.admin.overview(query));
  }

  @Get('/tasks')
  async tasks(@Query() query: Record<string, string | undefined>) {
    return this.withValidation(() => this.admin.listTasks(query));
  }

  @Get('/tasks/:taskId')
  async task(@Param('taskId') taskId: string) {
    const details = await this.admin.taskDetails(taskId);
    if (!details) throw new NotFoundException(`Task not found: ${taskId}`);
    return details;
  }

  @Get('/approvals')
  async approvals(@Query() query: Record<string, string | undefined>) {
    return this.withValidation(() => this.admin.listApprovals(query));
  }

  @Get('/adapters')
  adapters() {
    return this.admin.adapterStatus();
  }

  private async withValidation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid admin query.', issues: error.issues });
      }
      throw error;
    }
  }
}
