import crypto from 'node:crypto';
import process from 'node:process';
import { google } from 'googleapis';

const QUEUE_RANGE = 'DISPATCH_QUEUE!A2:T5000';
const AUDIT_RANGE = 'AUDIT_EVENTS!A:R';
const EXECUTIONS_RANGE = 'EXECUTIONS!A:V';

export const QUEUE_COLUMNS = Object.freeze({
  queueId: 0, taskId: 1, ownerId: 2, targetWorkspace: 3, status: 4,
  primaryAi: 5, reviewMode: 6, approvalRequired: 7, taskFolderId: 8,
  manifestId: 9, lockToken: 10, attemptCount: 11, maxAttempts: 12,
  nextRunAt: 13, claimedAt: 14, completedAt: 15, lastErrorCode: 16,
  correlationId: 17, createdAt: 18, updatedAt: 19,
});

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig() {
  return {
    spreadsheetId: required('AI_GATEWAY_SPREADSHEET_ID'),
    ownerId: process.env.AI_GATEWAY_OWNER_ID || 'danganhdung',
    targetWorkspace: process.env.AI_GATEWAY_TARGET_WORKSPACE || '10_CA_NHAN/danganhdung',
    pollIntervalMs: Number(process.env.AI_GATEWAY_POLL_INTERVAL_MS || 30000),
    maxBatch: Number(process.env.AI_GATEWAY_MAX_BATCH || 5),
    hermesApiBaseUrl: process.env.HERMES_API_BASE_URL || 'http://127.0.0.1:8642',
    hermesApiKey: process.env.HERMES_API_KEY || '',
    hermesApiModel: process.env.HERMES_API_MODEL || 'hermes-agent',
    dryRun: process.argv.includes('--dry-run'),
    once: process.argv.includes('--once'),
  };
}

export function validateQueueRow(row, config) {
  const errors = [];
  if (!row[QUEUE_COLUMNS.queueId]) errors.push('QUEUE_ID_REQUIRED');
  if (!row[QUEUE_COLUMNS.taskId]) errors.push('TASK_ID_REQUIRED');
  if (row[QUEUE_COLUMNS.ownerId] !== config.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (row[QUEUE_COLUMNS.targetWorkspace] !== config.targetWorkspace) errors.push('WORKSPACE_SCOPE_MISMATCH');
  if (!row[QUEUE_COLUMNS.manifestId]) errors.push('MANIFEST_ID_REQUIRED');
  if (!['VALIDATED_READY', 'RETRY_WAIT'].includes(row[QUEUE_COLUMNS.status])) errors.push('QUEUE_STATUS_NOT_CLAIMABLE');
  const nextRunAt = row[QUEUE_COLUMNS.nextRunAt];
  if (nextRunAt && Date.parse(nextRunAt) > Date.now()) errors.push('NEXT_RUN_NOT_REACHED');
  return errors;
}

export function selectClaimableRows(rows, config) {
  return rows
    .map((row, index) => ({ row, sheetRow: index + 2 }))
    .filter(({ row }) => validateQueueRow(row, config).length === 0)
    .slice(0, config.maxBatch);
}

export function buildHermesPrompt(payload) {
  return [
    'Bạn là Hermes Dispatcher Worker trong AI Gateway Control Plane.',
    'Hãy thực hiện nhiệm vụ theo manifest đã được kiểm soát, không tự mở rộng phạm vi.',
    '',
    `TASK_ID: ${payload.taskId}`,
    `QUEUE_ID: ${payload.queueId}`,
    `OWNER_ID: ${payload.ownerId}`,
    `TARGET_WORKSPACE: ${payload.targetWorkspace}`,
    `PRIMARY_AI: ${payload.primaryAi || 'Hermes'}`,
    `REVIEW_MODE: ${payload.reviewMode || 'SINGLE_PASS'}`,
    `APPROVAL_REQUIRED: ${payload.approvalRequired}`,
    `TASK_FOLDER_ID: ${payload.taskFolderId || ''}`,
    `MANIFEST_ID: ${payload.manifestId}`,
    `CORRELATION_ID: ${payload.correlationId || ''}`,
    '',
    'Trả về kết quả ngắn gọn, có cấu trúc. Dòng cuối phải có dạng:',
    'RESULT_URI: <uri hoặc để trống>',
  ].join('\n');
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function appendAudit(sheets, config, event) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: AUDIT_RANGE,
    valueInputOption: 'RAW',
    requestBody: { values: [[
      event.auditId, event.taskId, event.executionId || '', '', event.eventType,
      'SYSTEM', 'AI-HERMES-DISPATCHER', config.ownerId, config.targetWorkspace,
      event.resourceUri || '', '', '', event.statusFrom || '', event.statusTo || '',
      event.at, event.correlationId, event.errorCode || '', event.details || '',
    ]] },
  });
}

async function updateQueueRow(sheets, config, sheetRow, row) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `DISPATCH_QUEUE!A${sheetRow}:T${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function appendExecution(sheets, config, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: EXECUTIONS_RANGE,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
}

function parseHermesResult(content) {
  const text = String(content || '').trim();
  const match = text.match(/(?:^|\n)RESULT_URI:\s*(.*)$/i);
  return {
    status: 'COMPLETED',
    resultUri: match ? match[1].trim() : '',
    summary: text.replace(/(?:^|\n)RESULT_URI:\s*.*$/i, '').trim(),
  };
}

async function dispatchToHermes(config, payload) {
  if (config.dryRun) {
    return { status: 'DRY_RUN_OK', resultUri: '', summary: 'Dispatch skipped in dry-run mode.' };
  }
  if (!config.hermesApiKey) {
    const error = new Error('Hermes API key is not configured');
    error.code = 'BLOCKED_CONNECTOR';
    throw error;
  }

  const endpoint = `${config.hermesApiBaseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.hermesApiKey}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: config.hermesApiModel,
      messages: [
        { role: 'system', content: 'Bạn là Hermes AI Gateway của Đặng Anh Dũng. Tuân thủ chặt phạm vi nhiệm vụ và manifest.' },
        { role: 'user', content: buildHermesPrompt(payload) },
      ],
      stream: false,
    }),
    signal: AbortSignal.timeout(300000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Hermes API failed with HTTP ${response.status}: ${detail.slice(0, 500)}`);
    error.code = response.status === 401 || response.status === 403 ? 'BLOCKED_CONNECTOR' : 'HERMES_HTTP_ERROR';
    throw error;
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    const error = new Error('Hermes API returned no assistant content');
    error.code = 'HERMES_EMPTY_RESPONSE';
    throw error;
  }
  return parseHermesResult(content);
}

async function processItem(sheets, config, item) {
  const row = [...item.row];
  while (row.length < 20) row.push('');
  const now = new Date().toISOString();
  const lockToken = crypto.randomUUID();
  const executionId = `EXE-${row[QUEUE_COLUMNS.taskId]}-${Date.now()}`;

  row[QUEUE_COLUMNS.status] = 'CLAIMED';
  row[QUEUE_COLUMNS.lockToken] = lockToken;
  row[QUEUE_COLUMNS.claimedAt] = now;
  row[QUEUE_COLUMNS.updatedAt] = now;
  row[QUEUE_COLUMNS.attemptCount] = String(Number(row[QUEUE_COLUMNS.attemptCount] || 0) + 1);
  await updateQueueRow(sheets, config, item.sheetRow, row);
  await appendAudit(sheets, config, {
    auditId: `AUD-${crypto.randomUUID()}`, taskId: row[QUEUE_COLUMNS.taskId], executionId,
    eventType: 'DISPATCH_CLAIMED', statusFrom: item.row[QUEUE_COLUMNS.status], statusTo: 'CLAIMED',
    at: now, correlationId: row[QUEUE_COLUMNS.correlationId], details: `lock_token=${lockToken}`,
  });

  try {
    row[QUEUE_COLUMNS.status] = 'RUNNING';
    row[QUEUE_COLUMNS.updatedAt] = new Date().toISOString();
    await updateQueueRow(sheets, config, item.sheetRow, row);

    const payload = {
      queueId: row[QUEUE_COLUMNS.queueId], taskId: row[QUEUE_COLUMNS.taskId],
      ownerId: row[QUEUE_COLUMNS.ownerId], targetWorkspace: row[QUEUE_COLUMNS.targetWorkspace],
      primaryAi: row[QUEUE_COLUMNS.primaryAi], reviewMode: row[QUEUE_COLUMNS.reviewMode],
      approvalRequired: String(row[QUEUE_COLUMNS.approvalRequired]).toUpperCase() === 'TRUE',
      taskFolderId: row[QUEUE_COLUMNS.taskFolderId], manifestId: row[QUEUE_COLUMNS.manifestId],
      correlationId: row[QUEUE_COLUMNS.correlationId],
    };

    const result = await dispatchToHermes(config, payload);
    const completedAt = new Date().toISOString();
    const nextStatus = payload.approvalRequired ? 'WAITING_APPROVAL' : 'COMPLETED';

    row[QUEUE_COLUMNS.status] = nextStatus;
    row[QUEUE_COLUMNS.completedAt] = nextStatus === 'COMPLETED' ? completedAt : '';
    row[QUEUE_COLUMNS.lastErrorCode] = '';
    row[QUEUE_COLUMNS.updatedAt] = completedAt;
    await updateQueueRow(sheets, config, item.sheetRow, row);
    await appendExecution(sheets, config, [
      executionId, row[QUEUE_COLUMNS.taskId], row[QUEUE_COLUMNS.queueId], 'AI-HERMES-DISPATCHER',
      config.hermesApiModel, 'DISPATCH', 'SUCCESS', now, completedAt, '', result.resultUri || '',
      result.summary || '', row[QUEUE_COLUMNS.correlationId],
    ]);
    await appendAudit(sheets, config, {
      auditId: `AUD-${crypto.randomUUID()}`, taskId: row[QUEUE_COLUMNS.taskId], executionId,
      eventType: nextStatus === 'COMPLETED' ? 'DISPATCH_COMPLETED' : 'DISPATCH_WAITING_APPROVAL',
      statusFrom: 'RUNNING', statusTo: nextStatus, at: completedAt,
      correlationId: row[QUEUE_COLUMNS.correlationId], resourceUri: result.resultUri || '',
      details: result.summary || '',
    });
  } catch (error) {
    const attempts = Number(row[QUEUE_COLUMNS.attemptCount] || 1);
    const maxAttempts = Number(row[QUEUE_COLUMNS.maxAttempts] || 3);
    const retryable = error.code !== 'BLOCKED_CONNECTOR' && attempts < maxAttempts;
    const failedAt = new Date().toISOString();
    row[QUEUE_COLUMNS.status] = retryable ? 'RETRY_WAIT' : (error.code === 'BLOCKED_CONNECTOR' ? 'BLOCKED_CONNECTOR' : 'FAILED_FINALIZATION');
    row[QUEUE_COLUMNS.nextRunAt] = retryable ? new Date(Date.now() + attempts * 60000).toISOString() : '';
    row[QUEUE_COLUMNS.lastErrorCode] = error.code || 'UNEXPECTED_ERROR';
    row[QUEUE_COLUMNS.updatedAt] = failedAt;
    await updateQueueRow(sheets, config, item.sheetRow, row);
    await appendAudit(sheets, config, {
      auditId: `AUD-${crypto.randomUUID()}`, taskId: row[QUEUE_COLUMNS.taskId], executionId,
      eventType: 'DISPATCH_FAILED', statusFrom: 'RUNNING', statusTo: row[QUEUE_COLUMNS.status],
      at: failedAt, correlationId: row[QUEUE_COLUMNS.correlationId],
      errorCode: row[QUEUE_COLUMNS.lastErrorCode], details: error.message,
    });
  }
}

export async function runCycle(sheets, config) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range: QUEUE_RANGE });
  const rows = response.data.values || [];
  const items = selectClaimableRows(rows, config);
  for (const item of items) await processItem(sheets, config, item);
  return items.length;
}

async function main() {
  const config = loadConfig();
  const sheets = await getSheetsClient();
  do {
    const processed = await runCycle(sheets, config);
    console.log(JSON.stringify({ at: new Date().toISOString(), processed, dryRun: config.dryRun }));
    if (config.once) break;
    await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
  } while (true);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
