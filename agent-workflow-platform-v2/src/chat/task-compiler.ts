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

const WRITE_PATTERNS = [
  /\b(sửa|chỉnh sửa|cập nhật|tạo|viết|thêm|xóa|xoá|đổi|triển khai|cài|khởi động lại|sao lưu|phục hồi)\b/iu,
  /\b(fix|modify|update|create|write|add|delete|remove|deploy|install|restart|backup|restore)\b/iu,
];

const DESTRUCTIVE_PATTERNS = [
  /\b(xóa sạch|xoá sạch|xóa toàn bộ|xoá toàn bộ|format|reset|drop database|drop table|purge|wipe)\b/iu,
  /\b(force[- ]?push|rewrite history|viết lại lịch sử)\b/iu,
];

const PRODUCTION_PATTERNS = [
  /\b(production|prod|sản xuất|hệ thống thật|môi trường thật|đang vận hành)\b/iu,
];

const CREDENTIAL_PATTERNS = [
  /\b(api key|mật khẩu|password|credential|secret|token|private key|khóa bí mật|khoá bí mật)\b/iu,
];

const PERMISSION_PATTERNS = [
  /\b(quyền truy cập|permission|role|admin|administrator|chủ sở hữu|owner)\b/iu,
];

const EXTERNAL_PUBLISH_PATTERNS = [
  /\b(đăng công khai|công bố|publish|public|chia sẻ ra ngoài|external share|gửi ra ngoài)\b/iu,
];

const DEEP_OS_PATTERNS = [
  /\b(registry|group policy|chính sách nhóm|driver|bios|firmware|tường lửa|firewall|windows defender|wdac)\b/iu,
];

function anyMatch(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function compileChatTask(
  objective: string,
  attachments: readonly AttachmentScope[],
): CompiledChatTask {
  const normalized = objective.normalize('NFKC').trim();
  if (!normalized) throw new Error('Chat objective is empty.');

  const destructive = anyMatch(normalized, DESTRUCTIVE_PATTERNS);
  const touchesProduction = anyMatch(normalized, PRODUCTION_PATTERNS);
  const changesCredentials = anyMatch(normalized, CREDENTIAL_PATTERNS);
  const changesPermissions = anyMatch(normalized, PERMISSION_PATTERNS);
  const externalPublishing = anyMatch(normalized, EXTERNAL_PUBLISH_PATTERNS);
  const deepOperatingSystemChange = anyMatch(normalized, DEEP_OS_PATTERNS);
  const mutating = anyMatch(normalized, WRITE_PATTERNS)
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
      rewritesHistory: /\b(force[- ]?push|rewrite history|viết lại lịch sử)\b/iu.test(normalized),
      deepOperatingSystemChange,
      destructive,
      externalPublishing,
      backupVerified: false,
      estimatedCostUsd: 0,
    },
  };
}
