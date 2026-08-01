import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../db/pool.js';
import type {
  ApprovalRecord,
  ChatAttachmentRecord,
  ChatIdentity,
  ChatMessageRecord,
  ClarificationRecord,
  ConversationSnapshot,
  ConversationSummary,
  DiagnosticRecord,
  ProgressEventRecord,
} from './types.js';

type ConversationRow = Readonly<{
  conversation_id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED';
  created_at: Date;
  updated_at: Date;
  last_message: string | null;
}>;

type MessageRow = Readonly<{
  message_id: string;
  conversation_id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  task_id: string | null;
  status: 'PENDING' | 'FINAL' | 'FAILED';
  metadata: Record<string, unknown>;
  created_at: Date;
}>;

type AttachmentRow = Readonly<{
  attachment_id: string;
  conversation_id: string;
  message_id: string | null;
  original_name: string;
  safe_name: string;
  relative_path: string;
  media_type: string;
  size_bytes: string | number;
  sha256: string;
  status: 'UPLOADING' | 'READY' | 'REJECTED' | 'DELETED';
  metadata: Record<string, unknown>;
  created_at: Date;
}>;

type ProgressRow = Readonly<{
  progress_id: string | number;
  conversation_id: string;
  task_id: string | null;
  kind: ProgressEventRecord['kind'];
  stage: string;
  message: string;
  percent: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}>;

type ClarificationRow = Readonly<{
  clarification_id: string;
  conversation_id: string;
  task_id: string;
  question: string;
  options: unknown;
  reason: string;
  status: ClarificationRecord['status'];
  answer: string | null;
  created_at: Date;
  answered_at: Date | null;
}>;

type ApprovalRow = Readonly<{
  approval_id: string;
  task_id: string;
  action: Record<string, unknown>;
  status: ApprovalRecord['status'];
  requested_at: Date;
}>;

type DiagnosticRow = Readonly<{
  diagnostic_id: string;
  conversation_id: string;
  task_id: string | null;
  error_code: string;
  summary: string;
  report_text: string;
  redaction_count: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}>;

function iso(value: Date): string {
  return value.toISOString();
}

function mapConversation(row: ConversationRow): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    title: row.title,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastMessage: row.last_message,
  };
}

function mapMessage(row: MessageRow): ChatMessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    taskId: row.task_id,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

function mapAttachment(row: AttachmentRow): ChatAttachmentRecord {
  return {
    attachmentId: row.attachment_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    originalName: row.original_name,
    safeName: row.safe_name,
    relativePath: row.relative_path,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

function mapProgress(row: ProgressRow): ProgressEventRecord {
  return {
    progressId: Number(row.progress_id),
    conversationId: row.conversation_id,
    taskId: row.task_id,
    kind: row.kind,
    stage: row.stage,
    message: row.message,
    percent: row.percent,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

function mapClarification(row: ClarificationRow): ClarificationRecord {
  const options = Array.isArray(row.options)
    ? row.options.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    clarificationId: row.clarification_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    question: row.question,
    options,
    reason: row.reason,
    status: row.status,
    answer: row.answer,
    createdAt: iso(row.created_at),
    answeredAt: row.answered_at ? iso(row.answered_at) : null,
  };
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    taskId: row.task_id,
    action: row.action ?? {},
    status: row.status,
    requestedAt: iso(row.requested_at),
  };
}

function mapDiagnostic(row: DiagnosticRow): DiagnosticRecord {
  return {
    diagnosticId: row.diagnostic_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    errorCode: row.error_code,
    summary: row.summary,
    reportText: row.report_text,
    redactionCount: row.redaction_count,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

const CONVERSATION_SELECT = `
  SELECT c.conversation_id, c.title, c.status, c.created_at, c.updated_at,
    (SELECT m.content FROM chat_messages m
     WHERE m.conversation_id = c.conversation_id
     ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS last_message
  FROM conversations c
`;

export class ChatStore {
  async createConversation(identity: ChatIdentity, title = 'Cuộc trò chuyện mới'): Promise<ConversationSummary> {
    const conversationId = `CONV-${randomUUID()}`;
    await getPool().query(
      `INSERT INTO conversations(conversation_id, owner_id, workspace_id, title)
       VALUES($1,$2,$3,$4)`,
      [conversationId, identity.ownerId, identity.workspaceId, title.trim().slice(0, 120) || 'Cuộc trò chuyện mới'],
    );
    return this.getConversation(identity, conversationId);
  }

  async listConversations(identity: ChatIdentity, limit = 100): Promise<ConversationSummary[]> {
    const result = await getPool().query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE c.owner_id = $1 AND c.workspace_id = $2
       ORDER BY c.updated_at DESC LIMIT $3`,
      [identity.ownerId, identity.workspaceId, limit],
    );
    return result.rows.map(mapConversation);
  }

  async getConversation(identity: ChatIdentity, conversationId: string): Promise<ConversationSummary> {
    const result = await getPool().query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE c.conversation_id = $1 AND c.owner_id = $2 AND c.workspace_id = $3`,
      [conversationId, identity.ownerId, identity.workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Conversation not found: ${conversationId}`);
    return mapConversation(row);
  }

  async addUserMessage(
    identity: ChatIdentity,
    conversationId: string,
    content: string,
    clientMessageId: string,
    attachmentIds: string[],
  ): Promise<ChatMessageRecord> {
    await this.getConversation(identity, conversationId);
    const messageId = `MSG-${randomUUID()}`;
    const result = await getPool().query<MessageRow>(
      `INSERT INTO chat_messages(
        message_id, conversation_id, client_message_id, role, content, status, metadata
       ) VALUES($1,$2,$3,'USER',$4,'FINAL',$5::jsonb)
       ON CONFLICT(conversation_id, client_message_id)
       WHERE client_message_id IS NOT NULL
       DO UPDATE SET content = chat_messages.content
       RETURNING *`,
      [messageId, conversationId, clientMessageId, content, JSON.stringify({ attachmentIds })],
    );
    await getPool().query(
      `UPDATE conversations SET
        title = CASE WHEN NOT EXISTS(
          SELECT 1 FROM chat_messages WHERE conversation_id = $1 AND role = 'USER' AND message_id <> $2
        ) THEN $3 ELSE title END,
        updated_at = now()
       WHERE conversation_id = $1`,
      [conversationId, result.rows[0]?.message_id ?? messageId, content.replace(/\s+/g, ' ').trim().slice(0, 100)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('User message insert returned no row.');
    return mapMessage(row);
  }

  async linkMessageTask(messageId: string, taskId: string, attachmentIds: string[]): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE chat_messages SET task_id = $2 WHERE message_id = $1`,
        [messageId, taskId],
      );
      if (attachmentIds.length) {
        await client.query(
          `UPDATE chat_attachments SET message_id = $2
           WHERE attachment_id = ANY($1::text[]) AND message_id IS NULL`,
          [attachmentIds, messageId],
        );
      }
    });
  }

  async addAssistantMessage(
    conversationId: string,
    taskId: string | null,
    content: string,
    metadata: Record<string, unknown> = {},
    status: ChatMessageRecord['status'] = 'FINAL',
  ): Promise<ChatMessageRecord> {
    const messageId = `MSG-${randomUUID()}`;
    const result = await getPool().query<MessageRow>(
      `INSERT INTO chat_messages(message_id, conversation_id, role, content, task_id, status, metadata)
       VALUES($1,$2,'ASSISTANT',$3,$4,$5,$6::jsonb) RETURNING *`,
      [messageId, conversationId, content, taskId, status, JSON.stringify(metadata)],
    );
    await getPool().query(
      `UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`,
      [conversationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Assistant message insert returned no row.');
    return mapMessage(row);
  }

  async registerAttachment(input: Readonly<{
    identity: ChatIdentity;
    conversationId: string;
    originalName: string;
    safeName: string;
    relativePath: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    metadata?: Record<string, unknown>;
  }>): Promise<ChatAttachmentRecord> {
    await this.getConversation(input.identity, input.conversationId);
    const attachmentId = `ATT-${randomUUID()}`;
    const result = await getPool().query<AttachmentRow>(
      `INSERT INTO chat_attachments(
        attachment_id, conversation_id, original_name, safe_name, relative_path,
        media_type, size_bytes, sha256, status, metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'READY',$9::jsonb) RETURNING *`,
      [attachmentId, input.conversationId, input.originalName, input.safeName,
        input.relativePath, input.mediaType, input.sizeBytes, input.sha256,
        JSON.stringify(input.metadata ?? {})],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Attachment insert returned no row.');
    return mapAttachment(row);
  }

  async getReadyAttachments(
    identity: ChatIdentity,
    conversationId: string,
    attachmentIds: string[],
  ): Promise<ChatAttachmentRecord[]> {
    if (!attachmentIds.length) return [];
    const result = await getPool().query<AttachmentRow>(
      `SELECT a.* FROM chat_attachments a
       JOIN conversations c ON c.conversation_id = a.conversation_id
       WHERE a.conversation_id = $1
         AND c.owner_id = $2 AND c.workspace_id = $3
         AND a.attachment_id = ANY($4::text[])
         AND a.status = 'READY'`,
      [conversationId, identity.ownerId, identity.workspaceId, attachmentIds],
    );
    if (result.rows.length !== new Set(attachmentIds).size) {
      throw new Error('One or more attachments are missing, rejected or outside the active conversation.');
    }
    return result.rows.map(mapAttachment);
  }

  async appendProgress(input: Readonly<{
    conversationId: string;
    taskId: string | null;
    kind: ProgressEventRecord['kind'];
    stage: string;
    message: string;
    percent?: number | null;
    metadata?: Record<string, unknown>;
  }>): Promise<ProgressEventRecord> {
    const result = await getPool().query<ProgressRow>(
      `INSERT INTO progress_events(
        conversation_id, task_id, kind, stage, message, percent, metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [input.conversationId, input.taskId, input.kind, input.stage, input.message,
        input.percent ?? null, JSON.stringify(input.metadata ?? {})],
    );
    await getPool().query(
      `UPDATE conversations SET updated_at = now() WHERE conversation_id = $1`,
      [input.conversationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Progress event insert returned no row.');
    return mapProgress(row);
  }

  async createClarification(input: Readonly<{
    conversationId: string;
    taskId: string;
    question: string;
    options: string[];
    reason: string;
  }>): Promise<ClarificationRecord> {
    const clarificationId = `CLR-${randomUUID()}`;
    const result = await getPool().query<ClarificationRow>(
      `INSERT INTO clarification_requests(
        clarification_id, conversation_id, task_id, question, options, reason
       ) VALUES($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT(task_id) WHERE status = 'PENDING'
       DO UPDATE SET question = EXCLUDED.question, options = EXCLUDED.options, reason = EXCLUDED.reason
       RETURNING *`,
      [clarificationId, input.conversationId, input.taskId, input.question,
        JSON.stringify(input.options), input.reason],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Clarification insert returned no row.');
    return mapClarification(row);
  }

  async answerClarificationAndRequeue(
    identity: ChatIdentity,
    clarificationId: string,
    answer: string,
  ): Promise<{ conversationId: string; taskId: string }> {
    return withTransaction(async (client) => {
      const selected = await client.query<{
        clarification_id: string;
        conversation_id: string;
        task_id: string;
        status: string;
      }>(
        `SELECT cr.clarification_id, cr.conversation_id, cr.task_id, cr.status
         FROM clarification_requests cr
         JOIN conversations c ON c.conversation_id = cr.conversation_id
         WHERE cr.clarification_id = $1 AND c.owner_id = $2 AND c.workspace_id = $3
         FOR UPDATE`,
        [clarificationId, identity.ownerId, identity.workspaceId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error(`Clarification not found: ${clarificationId}`);
      if (row.status !== 'PENDING') throw new Error(`Clarification already answered: ${clarificationId}`);
      await client.query(
        `UPDATE clarification_requests
         SET status = 'ANSWERED', answer = $2, answered_at = now()
         WHERE clarification_id = $1`,
        [clarificationId, answer],
      );
      await client.query(
        `UPDATE tasks SET
          objective = objective || E'\n\nUSER_CLARIFICATION:\n' || $2,
          payload = jsonb_set(payload, '{clarificationAnswer}', to_jsonb($2::text), true),
          status = 'QUEUED', next_run_at = NULL, last_error = NULL, updated_at = now()
         WHERE task_id = $1 AND status = 'WAITING_INPUT'`,
        [row.task_id, answer],
      );
      await client.query(
        `INSERT INTO outbox_events(event_type, aggregate_id, payload)
         VALUES('TASK_CLARIFIED',$1,$2::jsonb)`,
        [row.task_id, JSON.stringify({ taskId: row.task_id, clarificationId })],
      );
      await client.query(
        `INSERT INTO progress_events(conversation_id, task_id, kind, stage, message, percent, metadata)
         VALUES($1,$2,'CLARIFICATION','ANSWERED','Đã nhận câu trả lời và tiếp tục nhiệm vụ.',35,$3::jsonb)`,
        [row.conversation_id, row.task_id, JSON.stringify({ clarificationId })],
      );
      return { conversationId: row.conversation_id, taskId: row.task_id };
    });
  }

  async createDiagnostic(input: Readonly<{
    conversationId: string;
    taskId: string | null;
    errorCode: string;
    summary: string;
    reportText: string;
    redactionCount: number;
    metadata?: Record<string, unknown>;
  }>): Promise<DiagnosticRecord> {
    const diagnosticId = `DIA-${randomUUID()}`;
    const result = await getPool().query<DiagnosticRow>(
      `INSERT INTO diagnostic_reports(
        diagnostic_id, conversation_id, task_id, error_code, summary,
        report_text, redaction_count, metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [diagnosticId, input.conversationId, input.taskId, input.errorCode,
        input.summary, input.reportText, input.redactionCount,
        JSON.stringify(input.metadata ?? {})],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Diagnostic insert returned no row.');
    return mapDiagnostic(row);
  }

  async getSnapshot(identity: ChatIdentity, conversationId: string): Promise<ConversationSnapshot> {
    const conversation = await this.getConversation(identity, conversationId);
    const [messages, attachments, progress, clarifications, approvals, diagnostics] = await Promise.all([
      getPool().query<MessageRow>(
        `SELECT * FROM chat_messages WHERE conversation_id = $1
         ORDER BY created_at, message_id`,
        [conversationId],
      ),
      getPool().query<AttachmentRow>(
        `SELECT * FROM chat_attachments WHERE conversation_id = $1
         ORDER BY created_at, attachment_id`,
        [conversationId],
      ),
      getPool().query<ProgressRow>(
        `SELECT * FROM progress_events WHERE conversation_id = $1
         ORDER BY progress_id DESC LIMIT 300`,
        [conversationId],
      ),
      getPool().query<ClarificationRow>(
        `SELECT * FROM clarification_requests WHERE conversation_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [conversationId],
      ),
      getPool().query<ApprovalRow>(
        `SELECT a.approval_id, a.task_id, a.action, a.status, a.requested_at
         FROM approvals a JOIN tasks t ON t.task_id = a.task_id
         WHERE t.conversation_id = $1
         ORDER BY a.requested_at DESC LIMIT 50`,
        [conversationId],
      ),
      getPool().query<DiagnosticRow>(
        `SELECT * FROM diagnostic_reports WHERE conversation_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [conversationId],
      ),
    ]);
    return {
      conversation,
      messages: messages.rows.map(mapMessage),
      attachments: attachments.rows.map(mapAttachment),
      progress: progress.rows.reverse().map(mapProgress),
      clarifications: clarifications.rows.map(mapClarification),
      approvals: approvals.rows.map(mapApproval),
      diagnostics: diagnostics.rows.map(mapDiagnostic),
    };
  }
}
