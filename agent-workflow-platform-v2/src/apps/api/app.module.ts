import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminQueryService } from './admin-query.service.js';
import { AdminWebController } from './admin-web.controller.js';
import { AgentController } from './agent.controller.js';
import { AgentRegistryService } from './agent-registry.service.js';
import { ApiTokenGuard } from './api-token.guard.js';
import { ApprovalController } from './approval.controller.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ChatSessionGuard } from './chat-session.js';
import { ChatWebController } from './chat-web.controller.js';
import { CutoverController } from './cutover.controller.js';
import { HealthController } from './health.controller.js';
import { PlatformService } from './platform.service.js';
import { TaskController } from './task.controller.js';
import { ToolController } from './tool.controller.js';

@Module({
  controllers: [
    HealthController,
    ChatWebController,
    ChatController,
    AdminWebController,
    AdminController,
    TaskController,
    ApprovalController,
    AgentController,
    ToolController,
    CutoverController,
  ],
  providers: [
    PlatformService,
    ChatService,
    AdminQueryService,
    AgentRegistryService,
    ApiTokenGuard,
    ChatSessionGuard,
  ],
})
export class AppModule {}
