import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ChatStore } from '../../chat/chat-store.js';
import { compileChatTask, type AttachmentScope } from '../../chat/task-compiler.js';
import type { ChatIdentity, ConversationSnapshot } from '../../chat/types.js';
import { getEnv } from '../../config/env.js';
import { redactSecrets } from '../../diagnostics/redaction.js';
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
  '.html', '.htm', '.js', '.ts', '.tsx', '.jsx', '.css', '.sql',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.js', '.ts', '.tsx', '.jsx', '.css', '.sql',
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

function hasPrefix(content: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => content[index] === value);
}

function assertAttachmentSignature(extension: string, content: Buffer): void {
  if (TEXT_EXTENSIONS.has(extension)) {
    if (content.includes(0)) throw new Error('Tệp văn bản chứa byte nhị phân không hợp lệ.');
    return;
  }
  if (extension === '.pdf' && !content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('Nội dung tệp không khớp định dạng PDF.');
  }
  if (extension === '.png' && !hasPrefix(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    throw new Error('Nội dung tệp không khớp định dạng PNG.');
  }
  if ((extension === '.jpg' || extension === '.jpeg') && !hasPrefix(content, [0xff, 0xd8, 0xff])) {
    throw new Error('Nội dung tệp không khớp định dạng JPEG.');
  }
  if (extension === '.webp') {
    const valid = content.subarray(0, 4).toString('ascii') === 'RIFF'
      && content.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) throw new Error('Nội dung tệp không khớp định dạng WebP.');
  }
  if (['.docx', '.xlsx', '.pptx'].includes(extension) && !hasPrefix(content, [0x50, 0x4b])) {
    throw new Error('Nội dung tệp Office không phải gói Open XML hợp lệ.');
  }
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Dữ liệu tệp không phải base64 hợp lệ.');
  }
  const content = Buffer.from(normalized, 'base64');
  if (!content.length) throw new Error('Tệp đính kèm rỗng hoặc base64 không hợp lệ.');
  return content;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeApprovalAction(action: Record<string, unknown>): Record<string, unknown> {
  const manager = record(action.manager);
  const policy = record(action.policy);
  const executor = typeof manager.executor === 'string' ? manager.executor : 'CHƯA_XÁC_ĐỊNH';
  const nextAction = typeof manager.nextAction === 'string' ? manager.nextAction : 'Thao tác được bảo vệ.';
  const reason = typeof policy.reason === 'string' ? policy.reason : 'Cần phê duyệt theo chính sách an toàn.';
  const outcome = typeof policy.outcome === 'string' ? policy.outcome : 'REQUIRE_APPROVAL';
  return {
    manager: {
      executor,
      nextAction: redactSecrets(nextAction, 4_096).text,
    },
    policy: {
      outcome,
      reason: redactSecrets(reason, 4_096).text,
    },
  };
}

function sanitizeSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  return {
    ...snapshot,
    approvals: snapshot.approvals.map((approval) => ({
      ...approval,
      action: safeApprovalAction(approval.action),
    })),
  };
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
    return sanitizeSnapshot(await this.#store.getSnapshot(identity, conversationId));
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
    const content = decodeBase64(input.contentBase64);
    const env = getEnv();
    if (content.length > env.CHAT_MAX_ATTACHMENT_BYTES) {
      throw new Error(`Tệp vượt giới hạn ${env.CHAT_MAX_ATTACHMENT_BYTES} byte.`);
    }
    assertAttachmentSignature(extension, content);
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
      metadata: { extension, storage: 'WORKSPACE_BIND_MOUNT', signatureChecked: true },
    });
    return { attachment };
  }

  async submitMessage(
    identity: ChatIdentity,
    conversationId: string,
    rawInput: unknown,
  ): Promise<ConversationSnapshot> {
    const input = MessageInputSchema.parse(rawInput);
    const attachments = await this.#store.getReadyAttachments(identity, conversationId, input.attachmentIds);
    const clientMessageId = input.clientMessageId ?? `CLIENT-${randomUUID()}`;
    const userMessage = await this.#store.addUserMessage(
      identity,
      conversationId,
      input.content,
      clientMessageId,
      input.attachmentIds,
    );
    if (userMessage.taskId) return this.getConversation(identity, conversationId);

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
    return this.getConversation(identity, conversationId);
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
    return this.getConversation(identity, conversationId);
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
    return this.getConversation(identity, conversationId);
  }
}
