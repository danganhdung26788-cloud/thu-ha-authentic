import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ZodError } from 'zod';
import type { ChatAuthenticatedRequest } from './chat-session.js';
import { ChatSessionGuard } from './chat-session.js';
import { ChatService } from './chat.service.js';

function badRequest(error: unknown): never {
  if (error instanceof ZodError) {
    throw new BadRequestException({ message: 'Dữ liệu chat không hợp lệ.', issues: error.issues });
  }
  if (error instanceof Error) throw new BadRequestException(error.message);
  throw error;
}

@Controller('/v1/chat')
@UseGuards(ChatSessionGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('/bootstrap')
  async bootstrap(@Req() request: ChatAuthenticatedRequest): Promise<Record<string, unknown>> {
    return this.chat.bootstrap(request.chatIdentity);
  }

  @Get('/conversations')
  async list(@Req() request: ChatAuthenticatedRequest): Promise<Record<string, unknown>> {
    return this.chat.listConversations(request.chatIdentity);
  }

  @Post('/conversations')
  async create(@Req() request: ChatAuthenticatedRequest): Promise<Record<string, unknown>> {
    return this.chat.createConversation(request.chatIdentity);
  }

  @Get('/conversations/:conversationId')
  async get(
    @Req() request: ChatAuthenticatedRequest,
    @Param('conversationId') conversationId: string,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.chat.getConversation(request.chatIdentity, conversationId);
    } catch (error) {
      return badRequest(error);
    }
  }

  @Post('/conversations/:conversationId/messages')
  async message(
    @Req() request: ChatAuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.chat.submitMessage(request.chatIdentity, conversationId, body);
    } catch (error) {
      return badRequest(error);
    }
  }

  @Post('/conversations/:conversationId/attachments')
  async attachment(
    @Req() request: ChatAuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.chat.uploadAttachment(request.chatIdentity, conversationId, body);
    } catch (error) {
      return badRequest(error);
    }
  }

  @Post('/conversations/:conversationId/clarifications/:clarificationId')
  async clarify(
    @Req() request: ChatAuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Param('clarificationId') clarificationId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.chat.answerClarification(
        request.chatIdentity,
        conversationId,
        clarificationId,
        body,
      );
    } catch (error) {
      return badRequest(error);
    }
  }

  @Post('/conversations/:conversationId/approvals/:approvalId')
  async approval(
    @Req() request: ChatAuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.chat.decideApproval(
        request.chatIdentity,
        conversationId,
        approvalId,
        body,
      );
    } catch (error) {
      return badRequest(error);
    }
  }
}
