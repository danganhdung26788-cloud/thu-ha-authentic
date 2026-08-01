export type ChatIdentity = Readonly<{
  ownerId: string;
  workspaceId: string;
}>;

export type ConversationSummary = Readonly<{
  conversationId: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
}>;

export type ChatMessageRecord = Readonly<{
  messageId: string;
  conversationId: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  taskId: string | null;
  status: 'PENDING' | 'FINAL' | 'FAILED';
  metadata: Record<string, unknown>;
  createdAt: string;
}>;

export type ChatAttachmentRecord = Readonly<{
  attachmentId: string;
  conversationId: string;
  messageId: string | null;
  originalName: string;
  safeName: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  status: 'UPLOADING' | 'READY' | 'REJECTED' | 'DELETED';
  metadata: Record<string, unknown>;
  createdAt: string;
}>;

export type ProgressEventRecord = Readonly<{
  progressId: number;
  conversationId: string;
  taskId: string | null;
  kind: 'STATUS' | 'ROUTE' | 'EXECUTION' | 'APPROVAL' | 'CLARIFICATION' | 'RESULT' | 'ERROR' | 'RECOVERY';
  stage: string;
  message: string;
  percent: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}>;

export type ClarificationRecord = Readonly<{
  clarificationId: string;
  conversationId: string;
  taskId: string;
  question: string;
  options: string[];
  reason: string;
  status: 'PENDING' | 'ANSWERED' | 'CANCELLED';
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}>;

export type ApprovalRecord = Readonly<{
  approvalId: string;
  taskId: string;
  action: Record<string, unknown>;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  requestedAt: string;
}>;

export type DiagnosticRecord = Readonly<{
  diagnosticId: string;
  conversationId: string;
  taskId: string | null;
  errorCode: string;
  summary: string;
  reportText: string;
  redactionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}>;

export type ConversationSnapshot = Readonly<{
  conversation: ConversationSummary;
  messages: ChatMessageRecord[];
  attachments: ChatAttachmentRecord[];
  progress: ProgressEventRecord[];
  clarifications: ClarificationRecord[];
  approvals: ApprovalRecord[];
  diagnostics: DiagnosticRecord[];
}>;
