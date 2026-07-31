import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { PlatformService } from './platform.service.js';

@Controller('/v1/approvals')
export class ApprovalController {
  constructor(private readonly platform: PlatformService) {}

  @Post(':approvalId/decision')
  async decide(
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.platform.decideApproval(approvalId, body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({ message: 'Invalid approval decision.', issues: error.issues });
      }
      if (error instanceof Error && /not found|already decided/i.test(error.message)) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
