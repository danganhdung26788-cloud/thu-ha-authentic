import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PlatformService } from './platform.service.js';
import { TaskController } from './task.controller.js';

@Module({
  controllers: [HealthController, TaskController],
  providers: [PlatformService],
})
export class AppModule {}
