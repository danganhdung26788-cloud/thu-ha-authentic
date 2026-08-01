import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ChatStore } from '../../chat/chat-store.js';
import { compileChatTask, type AttachmentScope } from '../../chat/task-compiler.js';
import type { ChatIdentity, ConversationSnapshot } from '../../chat/types.js';
import { getEnv } from '../../config/env.js';
import { modelProviderHealthCheck } from '../../models/model-provider.js';
import { PlatformService } from './platform.service.js';

const MessageInputSchema = z.object({
  content: z.string().trim().min(1).max(50_000),
  attachmentIds: z.array(z.string().min(1)).max(20).default([]),
  clientMessageId: z.string().min(1).max(200).optional(),
});

const AttachmentInputSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(200).default('application/octet-stream'),
  contentBase64: z.string().min(1),
});

const ClarificationAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
});

const ApprovalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().min(1).max(5_000).optional(),
});

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv',
  '.png', '.jpg', '.jpeg', '.webp', '.json', '.xml', '.yaml', '.yml',
  '.zip', '.html', '.htm', '.js', '.ts', '.tsx', '.jsx', '.css', '.sql',
]);

function safeFileName(input: string): string {
  const base = path.basename(input.normalize('NFKC'));
  const safe = base.replace(/[^\p{L}\p{N}._() -]/gu, '_').replace(/\s+/g, ' ').trim();
  return safe.slice(0, 180) || 'attachment.bin';
}

function assertPathInside(candidate: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Attachment path escaped the configured storage root.');
  }
}

@Injectable()
export class ChatService {
  readonly #store = new ChatStore();

  constructor(private readonly platform: PlatformService) {}

  async bootstrap(identity: ChatIdentity): Promise<Record<string, unknown>> {
    const env = getEnv();
    const model = await modelProviderHealthCheck();
    return {
      identity,
      localOnly: true,
      cutoverPhase: 'V1_ONLY',
      provider: {
        kind: model.provider,
        managerModel: model.managerModel,
        ready: model.ok,
        apiCostUsd: 0,
      },
      limits: {
        maxAttachmentBytes: env.CHAT_MAX_ATTACHMENT_BYTES,
        maxAttachmentsPerMessage: 20,
      },
    };
  }

  async createConversation(identity: ChatIdentity): Promise<Record<string, unknown>> {
    return this.#store.createConversation(identity);
  }

  async listConversations(identity: ChatIdentity): Promise<Record<string, unknown>> {
    return { items: await this.#store.listConversations(identity) };
  }

  async getConversation(identity: ChatIdentity, conversationId: string): Promise<ConversationSnapshot> {
    return this.#store.getSnapshot(identity, conversationId);
  }

  async uploadAttachment(
    identity: ChatIdentity,
    conversationId: string,
    rawInput: unknown,
  ): Promise<Record<string, unknown>> {
    const input = AttachmentInputSchema.parse(rawInput);
    await this.#store.getConversation(identity, conversationId);
    const safeName = safeFileName(input.fileName);
    const extension = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`Loại tệp chưa được phép: ${extension || 'không có phần mở rộng'}`);
    }
    const content = Buffer.from(input.contentBase64, 'base64');
    if (!content.length) throw new Error('Tệp đính kèm rỗng hoặc base64 không hợp lệ.');
    const env = getEnv();
    if (content.length > env.CHAT_MAX_ATTACHMENT_BYTES) {
      throw new Error(`Tệp vượt giới hạn ${env.CHAT_MAX_ATTACHMENT_BYTES} byte.`);
    }
    const storageToken = `FILE-${randomUUID()}`;
    const ownerSegment = identity.ownerId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const workspaceSegment = identity.workspaceId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const conversationSegment = conversationId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const directory = path.join(
      env.CHAT_ATTACHMENT_ROOT,
      ownerSegment,
      workspaceSegment,
      conversationSegment,
      storageToken,
    );
    const absolutePath = path.join(directory, safeName);
    assertPathInside(absolutePath, env.CHAT_ATTACHMENT_ROOT);
    await mkdir(directory, { recursive: true });
    await writeFile(absolutePath, content, { flag: 'wx' });
    const relativePath = path.posix.join(
      env.CHAT_ATTACHMENT_SCOPE_ROOT.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
      ownerSegment,
      workspaceSegment,
      conversationSegment,
      storageToken,
      safeName,
    );
    const sha256 = createHash('sha256').update(content).digest('hex');
    const attachment = await this.#store.registerAttachment({
      identity,
      conversationId,
      originalName: input.fileName,
      safeName,
      relativePath,
      mediaType: input.mediaType,
      sizeBytes: content.length,
      sha256,
      metadata: { extension, storage: 'WORKSPACE_BIND_MOUNT' },
    });
    return { attachment };
  }

  async submitMessage(
    identity: ChatIdentity,
    conversationId: string,
    rawInput: unknown,
  ): Promise<ConversationSnapshot> {
    const input = MessageInputSchema.parse(rawInput);
    const attachments = await this.#store.getReadyAttachments(
      identity,
      conversationId,
      input.attachmentIds,
    );
    const clientMessageId = input.clientMessageId ?? `CLIENT-${randomUUID()}`;
    const userMessage = await this.#store.addUserMessage(
      identity,
      conversationId,
      input.content,
      clientMessageId,
      input.attachmentIds,
    );
    if (userMessage.taskId) return this.#store.getSnapshot(identity, conversationId);

    const attachmentScopes: AttachmentScope[] = attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      relativePath: attachment.relativePath,
      originalName: attachment.originalName,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
    }));
    const compiled = compileChatTask(input.content, attachmentScopes);
    const submitted = await this.platform.submitTask({
      idempotencyKey: `CHAT:${conversationId}:${clientMessageId}`,
      ownerId: identity.ownerId,
      workspaceId: identity.workspaceId,
      conversationId,
      sourceMessageId: userMessage.messageId,
      objective: input.content,
      readScope: compiled.readScope,
      writeScope: compiled.writeScope,
      autonomyMode: compiled.autonomyMode,
      riskLevel: compiled.riskLevel,
      payload: {
        ...compiled.payload,
        conversationId,
        sourceMessageId: userMessage.messageId,
      },
      maxAttempts: 3,
    });
    const task = submitted.task as { taskId?: unknown };
    if (typeof task.taskId !== 'string') throw new Error('Task creation did not return a taskId.');
    await this.#store.linkMessageTask(userMessage.messageId, task.taskId, input.attachmentIds);
    await this.#store.appendProgress({
      conversationId,
      taskId: task.taskId,
      kind: 'STATUS',
      stage: 'QUEUED',
      message: 'Đã nhận yêu cầu. Hệ thống đang phân tích và chọn tuyến xử lý.',
      percent: 5,
      metadata: { clientMessageId },
    });
    return this.#store.getSnapshot(identity, conversationId);
  }

  async answerClarification(
    identity: ChatIdentity,
    conversationId: string,
    clarificationId: string,
    rawInput: unknown,
  ): Promise<ConversationSnapshot> {
    const input = ClarificationAnswerSchema.parse(rawInput);
    const result = await this.#store.answerClarificationAndRequeue(identity, clarificationId, input.answer);
    if (result.conversationId !== conversationId) throw new Error('Clarification does not belong to this conversation.');
    await this.#store.addAssistantMessage(
      conversationId,
      result.taskId,
      `Đã nhận câu trả lời: ${input.answer}`,
      { clarificationId, acknowledgement: true },
    );
    return this.#store.getSnapshot(identity, conversationId);
  }

  async decideApproval(
    identity: ChatIdentity,
    conversationId: string,
    approvalId: string,
    rawInput: unknown,
  ): Promise<ConversationSnapshot> {
    const input = ApprovalDecisionSchema.parse(rawInput);
    const snapshot = await this.#store.getSnapshot(identity, conversationId);
    const approval = snapshot.approvals.find((item) => item.approvalId === approvalId);
    if (!approval) throw new Error('Approval does not belong to this conversation.');
    await this.platform.decideApproval(approvalId, {
      decision: input.decision,
      actor: identity.ownerId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    await this.#store.appendProgress({
      conversationId,
      taskId: approval.taskId,
      kind: 'APPROVAL',
      stage: input.decision,
      message: input.decision === 'APPROVED'
        ? 'Đã phê duyệt. Nhiệm vụ sẽ tiếp tục.'
        : 'Đã từ chối. Nhiệm vụ dừng an toàn.',
      percent: input.decision === 'APPROVED' ? 45 : 100,
      metadata: { approvalId, reason: input.reason ?? null },
    });
    return this.#store.getSnapshot(identity, conversationId);
  }
}
