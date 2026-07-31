import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller.js';
import { HealthController } from './health.controller.js';
import { PlatformService } from './platform.service.js';
import { TaskController } from './task.controller.js';

@Module({
  controllers: [HealthController, TaskController, ApprovalController],
  providers: [PlatformService],
})
export class AppModule {}
