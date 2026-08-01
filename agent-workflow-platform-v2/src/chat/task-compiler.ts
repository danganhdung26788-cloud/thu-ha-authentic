import type { AutonomyMode, RiskLevel } from '../contracts/execution-context.js';

export type AttachmentScope = Readonly<{
  attachmentId: string;
  relativePath: string;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}>;

export type CompiledChatTask = Readonly<{
  readScope: string[];
  writeScope: string[];
  autonomyMode: AutonomyMode;
  riskLevel: RiskLevel;
  payload: Record<string, unknown>;
}>;

const WRITE_TERMS = [
  'sửa', 'chỉnh sửa', 'cập nhật', 'tạo', 'viết', 'thêm', 'xóa', 'xoá',
  'đổi', 'triển khai', 'cài', 'khởi động lại', 'sao lưu', 'phục hồi',
  'fix', 'modify', 'update', 'create', 'write', 'add', 'delete', 'remove',
  'deploy', 'install', 'restart', 'backup', 'restore',
];
const DESTRUCTIVE_TERMS = [
  'xóa sạch', 'xoá sạch', 'xóa toàn bộ', 'xoá toàn bộ', 'format',
  'reset', 'drop database', 'drop table', 'purge', 'wipe',
  'force-push', 'force push', 'rewrite history', 'viết lại lịch sử',
];
const PRODUCTION_TERMS = [
  'production', ' prod ', 'sản xuất', 'hệ thống thật', 'môi trường thật', 'đang vận hành',
];
const CREDENTIAL_TERMS = [
  'api key', 'mật khẩu', 'password', 'credential', 'secret', 'token',
  'private key', 'khóa bí mật', 'khoá bí mật',
];
const PERMISSION_TERMS = [
  'quyền truy cập', 'permission', ' role ', ' admin ', 'administrator',
  'chủ sở hữu', ' owner ',
];
const EXTERNAL_PUBLISH_TERMS = [
  'đăng công khai', 'công khai', 'công bố', 'chia sẻ ra ngoài',
  'external share', 'gửi ra ngoài', 'lên mạng xã hội', 'kênh công cộng',
  'toàn bộ internet', 'ra bên ngoài', 'ra ngoài tổ chức', 'public',
];
const PUBLISH_NEGATIONS = [
  'chưa publish', 'chưa xuất bản', 'không publish', 'không xuất bản',
  'không chia sẻ công khai', 'không đăng công khai', 'chưa chia sẻ',
  'trạng thái nháp', 'bản nháp', 'xuất bản nháp',
];
const DEEP_OS_TERMS = [
  'registry', 'group policy', 'chính sách nhóm', 'driver', 'bios', 'firmware',
  'tường lửa', 'firewall', 'windows defender', 'wdac',
];

function normalize(value: string): string {
  return ` ${value.normalize('NFKC').trim().toLowerCase()} `;
}

function containsAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function detectsExternalPublishing(value: string): boolean {
  const explicitlyExternal = containsAny(value, EXTERNAL_PUBLISH_TERMS);
  const genericPublish = containsAny(value, [' publish ', 'xuất bản']);
  const negatedOrDraft = containsAny(value, PUBLISH_NEGATIONS);
  return explicitlyExternal || (genericPublish && !negatedOrDraft);
}

export function compileChatTask(
  objective: string,
  attachments: readonly AttachmentScope[],
): CompiledChatTask {
  const normalized = objective.normalize('NFKC').trim();
  if (!normalized) throw new Error('Chat objective is empty.');
  const value = normalize(normalized);

  const destructive = containsAny(value, DESTRUCTIVE_TERMS);
  const touchesProduction = containsAny(value, PRODUCTION_TERMS);
  const changesCredentials = containsAny(value, CREDENTIAL_TERMS);
  const changesPermissions = containsAny(value, PERMISSION_TERMS);
  const externalPublishing = detectsExternalPublishing(value);
  const deepOperatingSystemChange = containsAny(value, DEEP_OS_TERMS);
  const mutating = containsAny(value, WRITE_TERMS)
    || destructive
    || touchesProduction
    || changesCredentials
    || changesPermissions
    || externalPublishing
    || deepOperatingSystemChange;

  let riskLevel: RiskLevel = 'LOW';
  if (mutating) riskLevel = 'MEDIUM';
  if (destructive || externalPublishing) riskLevel = 'HIGH';
  if (touchesProduction || changesCredentials || changesPermissions || deepOperatingSystemChange) {
    riskLevel = 'CRITICAL';
  }

  const attachmentPaths = attachments.map((attachment) => attachment.relativePath);
  const readScope = [...new Set(['.', ...attachmentPaths])];
  const writeScope = mutating ? ['.'] : [];
  const autonomyMode: AutonomyMode = mutating ? 'SANDBOX_HIGH' : 'READ_ONLY';

  return {
    readScope,
    writeScope,
    autonomyMode,
    riskLevel,
    payload: {
      source: 'CHAT_FIRST_UI',
      attachmentIds: attachments.map((attachment) => attachment.attachmentId),
      attachmentPaths,
      attachmentManifest: attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        originalName: attachment.originalName,
        relativePath: attachment.relativePath,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
      })),
      mutating,
      touchesProduction,
      changesCredentials,
      changesPermissions,
      rewritesHistory: containsAny(value, ['force-push', 'force push', 'rewrite history', 'viết lại lịch sử']),
      deepOperatingSystemChange,
      destructive,
      externalPublishing,
      backupVerified: false,
      estimatedCostUsd: 0,
    },
  };
}
