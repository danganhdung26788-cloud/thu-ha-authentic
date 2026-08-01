import {
  ManagerDecisionSchema,
  type ExecutionContext,
  type Executor,
  type ManagerDecision,
} from '../contracts/execution-context.js';

const TOOL_CATALOG: Readonly<Record<Executor, ReadonlySet<string>>> = {
  CHATGPT: new Set(['specialist.analyze']),
  CODEX: new Set(['git.inspect', 'code.modify', 'test.run', 'deploy.execute']),
  HERMES: new Set([
    'filesystem.read',
    'filesystem.write',
    'powershell.execute',
    'scheduled-task.manage',
    'runtime.inspect',
  ]),
  CLAUDE_REVIEW: new Set(['review.perform']),
  SPECIALIST_AGENT: new Set(['specialist.analyze']),
  GEMINI: new Set(['gemini.analyze', 'gemini.multimodal', 'gemini.cross-check']),
  NOTEBOOKLM: new Set(['notebooklm.prepare-source-package', 'notebooklm.register-result']),
  CANVA: new Set([
    'canva.asset.upload',
    'canva.design.create',
    'canva.template.autofill',
    'canva.design.export',
    'canva.design.publish',
  ]),
};

const CLARIFICATION_EXACT = new Set([
  'sửa tài liệu này giúp tôi',
  'làm lại cho tốt hơn',
  'xử lý các file này',
  'đưa nội dung lên hệ thống',
  'tạo bản cuối cùng',
  'dọn dẹp toàn bộ',
  'gửi nó đi',
  'dùng bản đúng để thay thế',
  'chuyển sang nơi phù hợp',
  'làm giống lần trước',
]);

const CANVA_TERMS = [
  'canva', 'infographic', 'poster', 'template', 'thiết kế', 'bìa báo cáo',
  'slide trực quan', 'hình ảnh truyền thông', 'xuất file thiết kế', 'xuất bản tài liệu',
];
const NOTEBOOK_TERMS = [
  'notebooklm', 'notebook', 'gói nguồn', 'manifest nguồn', 'bộ nguồn',
  'workspace notebook', 'nguồn đóng', 'nguồn khép kín', 'gói tài liệu nghiên cứu',
];
const HERMES_PRIORITY_TERMS = [
  'git working tree trên máy', 'trạng thái git working tree', 'cổng adapter',
  'scheduled task', 'docker compose', 'container unhealthy', 'tiến trình node',
  'windows firewall', 'group policy', 'windows defender', 'format ổ',
  'phục hồi backup', 'driver hệ thống', 'quyền administrator', 'tài khoản hệ thống',
];
const CODEX_TERMS = [
  'repository', 'pull request', 'diff', 'typescript', 'source code', 'mã nguồn',
  'migration', ' ci ', 'build', 'unit test', 'test tích hợp', 'endpoint',
  'package lock', 'idempotency', 'branch', 'commit', 'nhánh', 'tag',
  'truy vấn postgresql', 'api cũ', 'lỗ hổng bảo mật', 'finding', 'code',
  'service', 'module', 'readme', 'sơ đồ luồng xử lý',
];
const HERMES_TERMS = [
  'docker', 'scheduled task', 'runtime', 'file log', 'log gần nhất', 'sao lưu',
  'backup', 'khởi động lại dịch vụ', 'dung lượng ổ', 'file cấu hình',
  'bản sao của file', 'file nháp', 'cổng 3201', 'cổng 3202', ' pid',
  'script', 'manifest của bản backup', 'api key', 'mật khẩu',
];
const SPECIALIST_TERMS = [
  'phân loại', 'trích xuất', 'rút trích', 'so sánh hai bảng',
  'báo cáo hành chính', 'chuẩn hóa chính tả', 'danh sách nhiệm vụ',
  'biên bản', 'phân tích dữ liệu khảo sát', 'bảng đối chiếu',
  'tóm tắt tài liệu', 'phân tích tài liệu',
];

function normalizeText(value: string): string {
  return ` ${value.normalize('NFKC').trim().toLowerCase()} `;
}

function containsAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

export function needsBusinessClarification(request: string): boolean {
  const value = normalizeText(request).trim().replace(/[.!?]+$/u, '');
  if (CLARIFICATION_EXACT.has(value)) return true;
  const wordCount = value.split(/\s+/u).filter(Boolean).length;
  if (wordCount > 12) return false;
  const vagueVerb = [
    'sửa ', 'làm lại ', 'xử lý ', 'đưa ', 'tạo ', 'dọn dẹp ',
    'gửi ', 'dùng ', 'chuyển ', 'làm giống ',
  ].some((prefix) => value.startsWith(prefix));
  const vagueReference = [
    ' này', ' nó', 'các file', 'toàn bộ', 'bản đúng',
    'nơi phù hợp', 'lần trước', 'bản cuối cùng', 'tốt hơn',
  ].some((term) => value.includes(term));
  return vagueVerb && vagueReference;
}

export function inferDeterministicExecutor(request: string): Executor | null {
  const value = normalizeText(request);
  if (needsBusinessClarification(value)) return 'CHATGPT';

  if (containsAny(value, CANVA_TERMS)) return 'CANVA';
  if (containsAny(value, NOTEBOOK_TERMS)) return 'NOTEBOOKLM';
  if (containsAny(value, HERMES_PRIORITY_TERMS)) return 'HERMES';
  if (containsAny(value, CODEX_TERMS)
    || (value.includes('triển khai') && containsAny(value, ['production', ' prod ', 'sản xuất']))) {
    return 'CODEX';
  }
  if (containsAny(value, HERMES_TERMS)) return 'HERMES';
  if (containsAny(value, SPECIALIST_TERMS)) return 'SPECIALIST_AGENT';
  return 'CHATGPT';
}

export function requiresDeterministicApproval(
  request: string,
  context: ExecutionContext,
): boolean {
  if (context.riskLevel === 'HIGH' || context.riskLevel === 'CRITICAL') return true;
  const value = normalizeText(request);
  return containsAny(value, [
    'force-push', 'force push', 'xóa repository', 'xoá repository',
    'xóa vĩnh viễn nhánh', 'xoá vĩnh viễn nhánh', 'xóa toàn bộ docker volume',
    'xoá toàn bộ docker volume', 'phục hồi backup đè', 'restore overwrite',
    'bật thanh toán tự động', 'số liệu chưa được phê duyệt',
  ]) || /mua thêm\s+\d+\s*usd/iu.test(value);
}

export function deterministicRoutingHint(
  request: string,
  context: ExecutionContext,
): Readonly<{
  executor: Executor;
  requiresApproval: boolean;
  clarification: boolean;
}> {
  return {
    executor: inferDeterministicExecutor(request) ?? 'CHATGPT',
    requiresApproval: requiresDeterministicApproval(request, context),
    clarification: needsBusinessClarification(request),
  };
}

function inferDefaultTools(executor: Executor, request: string): string[] {
  const value = normalizeText(request);
  switch (executor) {
    case 'CODEX': {
      const tools = ['git.inspect'];
      if (containsAny(value, ['sửa', 'tạo', 'thêm', 'cập nhật', 'khôi phục', 'fix', 'modify', 'create', 'add', 'update'])) {
        tools.push('code.modify');
      }
      if (containsAny(value, ['test', 'kiểm thử', ' ci ', 'build'])) tools.push('test.run');
      if (containsAny(value, ['triển khai', 'deploy'])) tools.push('deploy.execute');
      return tools;
    }
    case 'HERMES': {
      if (value.includes('scheduled task')) return ['runtime.inspect'];
      if (containsAny(value, ['file', 'log', 'manifest', 'cấu hình'])
        && !containsAny(value, ['ghi', 'tạo', 'sửa', 'copy', 'bản sao'])) {
        return ['filesystem.read'];
      }
      if (containsAny(value, ['ghi', 'tạo', 'sửa', 'copy', 'bản sao'])) return ['filesystem.write'];
      if (containsAny(value, ['script', 'khởi động lại', 'sao lưu', 'backup', 'phục hồi'])) {
        return ['powershell.execute'];
      }
      return ['runtime.inspect'];
    }
    case 'CLAUDE_REVIEW': return ['review.perform'];
    case 'SPECIALIST_AGENT':
    case 'CHATGPT': return ['specialist.analyze'];
    case 'GEMINI': return ['gemini.analyze'];
    case 'NOTEBOOKLM': return ['notebooklm.prepare-source-package'];
    case 'CANVA': {
      if (containsAny(value, ['publish', 'đăng công khai', 'chia sẻ ra ngoài', 'xuất bản'])) {
        return ['canva.design.publish'];
      }
      if (containsAny(value, ['template', 'tự động điền'])) return ['canva.template.autofill'];
      if (containsAny(value, ['xuất file', 'export', 'pdf'])) return ['canva.design.export'];
      return ['canva.design.create'];
    }
  }
}

export function normalizeManagerDecision(
  rawDecision: unknown,
  request: string,
  context: ExecutionContext,
): ManagerDecision {
  const parsed = ManagerDecisionSchema.parse(rawDecision);
  const clarificationRequired = needsBusinessClarification(request);
  if (clarificationRequired) {
    const question = 'Anh muốn xử lý đối tượng nào và kết quả cuối cùng cần ở dạng nào?';
    return ManagerDecisionSchema.parse({
      executor: 'CHATGPT',
      rationale: 'Yêu cầu chưa xác định đủ đối tượng hoặc đầu ra nghiệp vụ.',
      nextAction: question,
      requestedTools: [],
      toolCalls: [],
      clarification: {
        question,
        options: [],
        reason: 'Cần bổ sung đối tượng và đầu ra trước khi cấp phạm vi thực hiện.',
      },
      requiresApproval: false,
    });
  }

  const executor = inferDeterministicExecutor(request) ?? parsed.executor;
  const allowedTools = TOOL_CATALOG[executor];
  const requestedTools = [...new Set(
    parsed.requestedTools.filter((tool) => allowedTools.has(tool)),
  )];
  const effectiveTools = requestedTools.length ? requestedTools : inferDefaultTools(executor, request);
  const toolCalls = (parsed.toolCalls ?? []).filter((call) => allowedTools.has(call.toolId));
  const routeChanged = parsed.executor !== executor;
  const nextAction = routeChanged
    ? `Thực hiện yêu cầu bằng ${executor} trong phạm vi đã đăng ký; giữ nguyên mục tiêu người dùng và tuân thủ policy.`
    : parsed.nextAction;

  return ManagerDecisionSchema.parse({
    executor,
    rationale: parsed.rationale,
    nextAction,
    requestedTools: effectiveTools,
    toolCalls,
    requiresApproval: requiresDeterministicApproval(request, context),
  });
}
