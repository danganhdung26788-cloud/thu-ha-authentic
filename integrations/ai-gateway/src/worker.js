import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const RANGES = Object.freeze({
  queue: 'DISPATCH_QUEUE!A2:T5000',
  tasks: 'TASKS!A1:X5000',
  executions: 'EXECUTIONS!A1:V5000',
  audit: 'AUDIT_EVENTS!A:R',
  handoffs: 'HANDOFFS!A:R',
  approvals: 'APPROVALS!A:P',
  runtime: 'RUNTIME_CHECKS!A:N',
});

export const QUEUE_COLUMNS = Object.freeze({
  queueId: 0, taskId: 1, ownerId: 2, targetWorkspace: 3, status: 4,
  primaryAi: 5, reviewMode: 6, approvalRequired: 7, taskFolderId: 8,
  manifestId: 9, lockToken: 10, attemptCount: 11, maxAttempts: 12,
  nextRunAt: 13, claimedAt: 14, completedAt: 15, lastErrorCode: 16,
  correlationId: 17, createdAt: 18, updatedAt: 19,
});

export const EXPECTED_HEADERS = Object.freeze({
  TASKS: ['TASK_ID','OWNER_ID','TARGET_WORKSPACE','REQUEST_TEXT','TASK_CLASS','COMPLEXITY_LEVEL','REVIEW_MODE','PRIMARY_AI','REVIEW_AI','READ_SCOPE','WRITE_SCOPE','OUTPUT_DESTINATION','APPROVAL_REQUIRED','STATUS','PRIORITY','IDEMPOTENCY_KEY','CREATED_AT','UPDATED_AT','FINAL_RESULT_ID','ERROR_CODE'],
  EXECUTIONS: ['EXECUTION_ID','TASK_ID','AI_ACTOR','ADAPTER_ID','ATTEMPT_NO','REVIEW_ROUND','STATUS','INPUT_URI','OUTPUT_URI','INPUT_HASH','OUTPUT_HASH','STARTED_AT','FINISHED_AT','VALIDATION_STATUS','CONFIDENCE_SCORE','ERROR_CODE'],
  AUDIT_EVENTS: ['AUDIT_ID','TASK_ID','EXECUTION_ID','HANDOFF_ID','EVENT_TYPE','ACTOR_TYPE','ACTOR_ID','OWNER_ID','TARGET_WORKSPACE','RESOURCE_URI','BEFORE_HASH','AFTER_HASH','STATUS_FROM','STATUS_TO','EVENT_AT','CORRELATION_ID','ERROR_CODE','DETAILS'],
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
    hermesTimeoutMs: Number(process.env.HERMES_API_TIMEOUT_MS || 600000),
    staleLockMs: Number(process.env.AI_GATEWAY_STALE_LOCK_MS || 900000),
    heartbeatEveryMs: Number(process.env.AI_GATEWAY_HEARTBEAT_MS || 60000),
    resolveManifest: String(process.env.AI_GATEWAY_RESOLVE_MANIFEST || 'true').toLowerCase() === 'true',
    workerVersion: process.env.AI_GATEWAY_WORKER_VERSION || '0.4.0',
    workerCommit: process.env.AI_GATEWAY_WORKER_COMMIT || 'unknown',
    dryRun: process.argv.includes('--dry-run'),
    once: process.argv.includes('--once'),
  };
}

const normalize = value => String(value || '').trim().toUpperCase();

export function validateQueueRow(row, config, now = Date.now()) {
  const errors = [];
  if (!row[QUEUE_COLUMNS.queueId]) errors.push('QUEUE_ID_REQUIRED');
  if (!row[QUEUE_COLUMNS.taskId]) errors.push('TASK_ID_REQUIRED');
  if (row[QUEUE_COLUMNS.ownerId] !== config.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (row[QUEUE_COLUMNS.targetWorkspace] !== config.targetWorkspace) errors.push('WORKSPACE_SCOPE_MISMATCH');
  if (!['HERMES', 'AI-HERMES'].includes(normalize(row[QUEUE_COLUMNS.primaryAi]))) errors.push('PRIMARY_AI_NOT_HERMES');
  if (!row[QUEUE_COLUMNS.manifestId]) errors.push('MANIFEST_ID_REQUIRED');
  if (!['VALIDATED_READY', 'RETRY_WAIT'].includes(row[QUEUE_COLUMNS.status])) errors.push('QUEUE_STATUS_NOT_CLAIMABLE');
  const nextRunAt = row[QUEUE_COLUMNS.nextRunAt];
  if (nextRunAt && Date.parse(nextRunAt) > now) errors.push('NEXT_RUN_NOT_REACHED');
  return errors;
}

export function selectClaimableRows(rows, config, now = Date.now()) {
  return rows
    .map((row, index) => ({ row, sheetRow: index + 2 }))
    .filter(({ row }) => validateQueueRow(row, config, now).length === 0)
    .slice(0, config.maxBatch);
}

export function staleRecovery(rows, config, now = Date.now()) {
  return rows
    .map((row, index) => ({ row: [...row], sheetRow: index + 2 }))
    .filter(({ row }) => ['CLAIMED', 'RUNNING'].includes(row[QUEUE_COLUMNS.status])
      && row[QUEUE_COLUMNS.claimedAt]
      && now - Date.parse(row[QUEUE_COLUMNS.claimedAt]) > config.staleLockMs)
    .map(item => {
      while (item.row.length < 20) item.row.push('');
      item.row[QUEUE_COLUMNS.status] = 'RETRY_WAIT';
      item.row[QUEUE_COLUMNS.lockToken] = '';
      item.row[QUEUE_COLUMNS.nextRunAt] = new Date(now + 60000).toISOString();
      item.row[QUEUE_COLUMNS.lastErrorCode] = 'STALE_LOCK_RECOVERED';
      item.row[QUEUE_COLUMNS.updatedAt] = new Date(now).toISOString();
      return item;
    });
}

export function assertHeader(actual, expected, name) {
  if (JSON.stringify(actual.slice(0, expected.length)) !== JSON.stringify(expected)) {
    const error = new Error(`${name} schema mismatch`);
    error.code = 'SCHEMA_CONTRACT_MISMATCH';
    throw error;
  }
  return true;
}

export function buildHermesPrompt(payload) {
  return [
    'Bạn là Hermes Dispatcher Worker trong AI Gateway Control Plane.',
    'Chỉ thực hiện đúng manifest và phạm vi đã cấp; không tự tìm kiếm Google Drive.',
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
    payload.manifestText ? `MANIFEST_CONTENT:\n${payload.manifestText}` : 'MANIFEST_CONTENT: NOT_RESOLVED',
    '',
    'Khi vượt khả năng, thêm dòng: HANDOFF_REQUIRED: CHATGPT',
    'Dòng cuối: RESULT_URI: <uri hoặc để trống>',
  ].join('\n');
}

export function parseHermesResult(content) {
  const text = String(content || '').trim();
  const uri = text.match(/(?:^|\n)RESULT_URI:\s*(.*)$/i);
  return {
    resultUri: uri ? uri[1].trim() : '',
    summary: text.replace(/(?:^|\n)RESULT_URI:\s*.*$/i, '').trim(),
    handoffRequired: /HANDOFF_REQUIRED:\s*CHATGPT/i.test(text),
  };
}

export function normalizeDispatchError(error) {
  const causeCode = error?.cause?.code || error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(causeCode)) {
    error.code = 'HERMES_DNS_ERROR';
  } else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(causeCode)) {
    error.code = 'HERMES_NETWORK_ERROR';
  } else if (['AbortError', 'TimeoutError'].includes(error?.name) || ['ABORT_ERR', 23].includes(error?.code)) {
    error.code = 'HERMES_TIMEOUT';
  }
  return error;
}

export function executionRow(values) {
  return [
    values.executionId,
    values.taskId,
    'AI-HERMES-DISPATCHER',
    values.adapterId,
    values.attemptNo,
    0,
    values.status,
    values.inputUri || '',
    values.outputUri || '',
    values.inputHash || '',
    values.outputHash || '',
    values.startedAt,
    values.finishedAt,
    values.validationStatus || '',
    values.confidenceScore ?? '',
    values.errorCode || '',
  ];
}

export function shouldSkipForIdempotency(executionRows, taskId) {
  return executionRows.slice(1).some(row => row[1] === taskId && row[6] === 'SUCCESS');
}

async function getClients() {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  return {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
  };
}

async function getValues(sheets, config, range) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range });
  return response.data.values || [];
}

async function updateRow(sheets, config, range, row) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function appendRow(sheets, config, range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function appendAudit(sheets, config, event) {
  await appendRow(sheets, config, RANGES.audit, [
    event.auditId, event.taskId, event.executionId || '', event.handoffId || '', event.eventType,
    'SYSTEM', 'AI-HERMES-DISPATCHER', config.ownerId, config.targetWorkspace,
    event.resourceUri || '', '', '', event.statusFrom || '', event.statusTo || '',
    event.at, event.correlationId || '', event.errorCode || '', event.details || '',
  ]);
}

async function resolveManifest(drive, manifestId) {
  const metadata = await drive.files.get({ fileId: manifestId, fields: 'id,name,mimeType' });
  if (metadata.data.mimeType === 'application/vnd.google-apps.document') {
    const response = await drive.files.export({ fileId: manifestId, mimeType: 'text/plain' }, { responseType: 'text' });
    return String(response.data).slice(0, 30000);
  }
  const response = await drive.files.get({ fileId: manifestId, alt: 'media' }, { responseType: 'text' });
  return String(response.data).slice(0, 30000);
}

async function dispatchToHermes(config, payload) {
  if (!config.hermesApiKey) {
    const error = new Error('Hermes API key is not configured');
    error.code = 'BLOCKED_CONNECTOR';
    throw error;
  }
  const response = await fetch(`${config.hermesApiBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.hermesApiKey}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: config.hermesApiModel,
      messages: [
        { role: 'system', content: 'Bạn là Hermes AI Gateway. Tuân thủ owner, workspace, manifest và phạm vi.' },
        { role: 'user', content: buildHermesPrompt(payload) },
      ],
      stream: false,
    }),
    signal: AbortSignal.timeout(config.hermesTimeoutMs),
  });
  if (!response.ok) {
    const error = new Error(`Hermes API HTTP ${response.status}`);
    error.code = [401, 403].includes(response.status) ? 'BLOCKED_CONNECTOR' : 'HERMES_HTTP_ERROR';
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

async function syncTask(sheets, config, taskId, status, finalResultId = '', errorCode = '') {
  const rows = await getValues(sheets, config, RANGES.tasks);
  assertHeader(rows[0] || [], EXPECTED_HEADERS.TASKS, 'TASKS');
  const index = rows.findIndex((row, rowIndex) => rowIndex > 0 && row[0] === taskId);
  if (index < 1) return;
  const row = [...rows[index]];
  while (row.length < 20) row.push('');
  row[13] = status;
  row[17] = new Date().toISOString();
  row[18] = finalResultId;
  row[19] = errorCode;
  await updateRow(sheets, config, `TASKS!A${index + 1}:T${index + 1}`, row);
}

async function writeHandoff(sheets, config, payload, result, executionId) {
  const handoffId = `HO-${crypto.randomUUID()}`;
  await appendRow(sheets, config, RANGES.handoffs, [
    handoffId, payload.taskId, executionId, 'AI-HERMES', 'AI-CHATGPT',
    config.ownerId, config.targetWorkspace, payload.manifestId,
    'THIS_MANIFEST_ONLY', 'CHATGPT_REVIEW_ONLY', '', result.resultUri || '',
    result.summary.slice(0, 2000), 'Review and continue task', 1, 'OPEN',
    new Date().toISOString(), '',
  ]);
  return handoffId;
}

async function writeApproval(sheets, config, payload, result, executionId) {
  const approvalId = `APR-${crypto.randomUUID()}`;
  await appendRow(sheets, config, RANGES.approvals, [
    approvalId, payload.taskId, 'HERMES_RESULT_APPROVAL',
    result.resultUri || `gdrive://${payload.manifestId}`, 'AI-HERMES-DISPATCHER',
    config.ownerId, 'Approval required by task policy', 'MEDIUM', 'PENDING',
    new Date().toISOString(), '', '', '', executionId, '', '',
  ]);
  return approvalId;
}

export function buildHeartbeatRow(config, stats, at = new Date().toISOString()) {
  const checkId = 'CHK-HERMES-HEARTBEAT';
  const lastError = String(stats.lastError || '').trim();
  const actual = lastError ? 'DEGRADED' : 'ALIVE';
  return [
    checkId, 'HERMES_WORKER_HEARTBEAT', 'RUNTIME', 'Hermes AI Gateway Dispatcher',
    'ALIVE', actual, lastError ? 'FAIL' : 'PASS', 'TRUE', at, lastError, '',
    'AI-HERMES-DISPATCHER', 'CORR-HERMES-HEARTBEAT',
    `version=${config.workerVersion};commit=${config.workerCommit};queue_depth=${stats.queueDepth};last_error=${lastError}`,
  ];
}

async function heartbeat(sheets, config, stats) {
  const rows = await getValues(sheets, config, 'RUNTIME_CHECKS!A1:N1000');
  const row = buildHeartbeatRow(config, stats);
  const checkId = row[0];
  const index = rows.findIndex(existing => existing[0] === checkId);
  if (index >= 1) await updateRow(sheets, config, `RUNTIME_CHECKS!A${index + 1}:N${index + 1}`, row);
  else await appendRow(sheets, config, RANGES.runtime, row);
}

async function processItem(sheets, drive, config, item, executionRows) {
  const row = [...item.row];
  while (row.length < 20) row.push('');
  const startedAt = new Date().toISOString();
  const executionId = `EXE-${row[QUEUE_COLUMNS.taskId]}-${Date.now()}`;

  if (shouldSkipForIdempotency(executionRows, row[QUEUE_COLUMNS.taskId])) {
    row[QUEUE_COLUMNS.status] = 'COMPLETED';
    row[QUEUE_COLUMNS.completedAt] = startedAt;
    row[QUEUE_COLUMNS.lastErrorCode] = '';
    row[QUEUE_COLUMNS.updatedAt] = startedAt;
    await updateRow(sheets, config, `DISPATCH_QUEUE!A${item.sheetRow}:T${item.sheetRow}`, row);
    await syncTask(sheets, config, row[QUEUE_COLUMNS.taskId], 'COMPLETED', 'IDEMPOTENT_EXISTING_EXECUTION', '');
    return { status: 'COMPLETED', errorCode: '' };
  }

  const lockToken = crypto.randomUUID();
  row[QUEUE_COLUMNS.status] = 'CLAIMED';
  row[QUEUE_COLUMNS.lockToken] = lockToken;
  row[QUEUE_COLUMNS.attemptCount] = String(Number(row[QUEUE_COLUMNS.attemptCount] || 0) + 1);
  row[QUEUE_COLUMNS.claimedAt] = startedAt;
  row[QUEUE_COLUMNS.updatedAt] = startedAt;
  await updateRow(sheets, config, `DISPATCH_QUEUE!A${item.sheetRow}:T${item.sheetRow}`, row);
  await appendAudit(sheets, config, {
    auditId: `AUD-${crypto.randomUUID()}`,
    taskId: row[QUEUE_COLUMNS.taskId], executionId, eventType: 'DISPATCH_CLAIMED',
    statusFrom: item.row[QUEUE_COLUMNS.status], statusTo: 'CLAIMED', at: startedAt,
    correlationId: row[QUEUE_COLUMNS.correlationId], details: `lock_token=${lockToken}`,
  });

  try {
    row[QUEUE_COLUMNS.status] = 'RUNNING';
    row[QUEUE_COLUMNS.updatedAt] = new Date().toISOString();
    await updateRow(sheets, config, `DISPATCH_QUEUE!A${item.sheetRow}:T${item.sheetRow}`, row);
    await syncTask(sheets, config, row[QUEUE_COLUMNS.taskId], 'RUNNING');

    const payload = {
      queueId: row[QUEUE_COLUMNS.queueId], taskId: row[QUEUE_COLUMNS.taskId],
      ownerId: row[QUEUE_COLUMNS.ownerId], targetWorkspace: row[QUEUE_COLUMNS.targetWorkspace],
      primaryAi: row[QUEUE_COLUMNS.primaryAi], reviewMode: row[QUEUE_COLUMNS.reviewMode],
      approvalRequired: normalize(row[QUEUE_COLUMNS.approvalRequired]) === 'TRUE',
      taskFolderId: row[QUEUE_COLUMNS.taskFolderId], manifestId: row[QUEUE_COLUMNS.manifestId],
      correlationId: row[QUEUE_COLUMNS.correlationId],
      manifestText: config.resolveManifest ? await resolveManifest(drive, row[QUEUE_COLUMNS.manifestId]) : '',
    };

    const result = await dispatchToHermes(config, payload);
    const finishedAt = new Date().toISOString();
    let finalStatus = 'COMPLETED';
    let handoffId = '';
    let approvalId = '';

    if (result.handoffRequired) {
      finalStatus = 'HANDOFF_TO_CHATGPT';
      handoffId = await writeHandoff(sheets, config, payload, result, executionId);
    } else if (payload.approvalRequired) {
      finalStatus = 'WAITING_APPROVAL';
      approvalId = await writeApproval(sheets, config, payload, result, executionId);
    }

    row[QUEUE_COLUMNS.status] = finalStatus;
    row[QUEUE_COLUMNS.lockToken] = '';
    row[QUEUE_COLUMNS.completedAt] = finalStatus === 'COMPLETED' ? finishedAt : '';
    row[QUEUE_COLUMNS.nextRunAt] = '';
    row[QUEUE_COLUMNS.lastErrorCode] = '';
    row[QUEUE_COLUMNS.updatedAt] = finishedAt;
    await updateRow(sheets, config, `DISPATCH_QUEUE!A${item.sheetRow}:T${item.sheetRow}`, row);

    await appendRow(sheets, config, RANGES.executions, executionRow({
      executionId,
      taskId: row[QUEUE_COLUMNS.taskId],
      adapterId: config.hermesApiModel,
      attemptNo: row[QUEUE_COLUMNS.attemptCount],
      status: 'SUCCESS',
      inputUri: `gdrive://${row[QUEUE_COLUMNS.manifestId]}`,
      outputUri: result.resultUri,
      startedAt,
      finishedAt,
      validationStatus: 'PASS',
      confidenceScore: 1,
    }));

    await syncTask(
      sheets,
      config,
      row[QUEUE_COLUMNS.taskId],
      finalStatus,
      result.resultUri || handoffId || approvalId,
      '',
    );

    await appendAudit(sheets, config, {
      auditId: `AUD-${crypto.randomUUID()}`,
      taskId: row[QUEUE_COLUMNS.taskId], executionId, handoffId,
      eventType: finalStatus === 'COMPLETED' ? 'DISPATCH_COMPLETED' : finalStatus,
      resourceUri: result.resultUri,
      statusFrom: 'RUNNING', statusTo: finalStatus, at: finishedAt,
      correlationId: row[QUEUE_COLUMNS.correlationId], details: result.summary,
    });
    return { status: finalStatus, errorCode: '' };
  } catch (rawError) {
    const error = normalizeDispatchError(rawError);
    const attempts = Number(row[QUEUE_COLUMNS.attemptCount] || 1);
    const maxAttempts = Number(row[QUEUE_COLUMNS.maxAttempts] || 3);
    const retryable = error.code !== 'BLOCKED_CONNECTOR' && attempts < maxAttempts;
    const failedAt = new Date().toISOString();

    row[QUEUE_COLUMNS.status] = retryable
      ? 'RETRY_WAIT'
      : (error.code === 'BLOCKED_CONNECTOR' ? 'BLOCKED_CONNECTOR' : 'FAILED_FINALIZATION');
    row[QUEUE_COLUMNS.lockToken] = '';
    row[QUEUE_COLUMNS.nextRunAt] = retryable ? new Date(Date.now() + attempts * 60000).toISOString() : '';
    row[QUEUE_COLUMNS.lastErrorCode] = error.code || 'UNEXPECTED_ERROR';
    row[QUEUE_COLUMNS.updatedAt] = failedAt;
    await updateRow(sheets, config, `DISPATCH_QUEUE!A${item.sheetRow}:T${item.sheetRow}`, row);

    await appendRow(sheets, config, RANGES.executions, executionRow({
      executionId,
      taskId: row[QUEUE_COLUMNS.taskId],
      adapterId: config.hermesApiModel,
      attemptNo: row[QUEUE_COLUMNS.attemptCount],
      status: 'FAILED',
      inputUri: `gdrive://${row[QUEUE_COLUMNS.manifestId]}`,
      startedAt,
      finishedAt: failedAt,
      validationStatus: 'FAIL',
      confidenceScore: 0,
      errorCode: row[QUEUE_COLUMNS.lastErrorCode],
    }));

    await syncTask(
      sheets,
      config,
      row[QUEUE_COLUMNS.taskId],
      row[QUEUE_COLUMNS.status],
      '',
      row[QUEUE_COLUMNS.lastErrorCode],
    );

    await appendAudit(sheets, config, {
      auditId: `AUD-${crypto.randomUUID()}`,
      taskId: row[QUEUE_COLUMNS.taskId], executionId, eventType: 'DISPATCH_FAILED',
      statusFrom: 'RUNNING', statusTo: row[QUEUE_COLUMNS.status], at: failedAt,
      correlationId: row[QUEUE_COLUMNS.correlationId],
      errorCode: row[QUEUE_COLUMNS.lastErrorCode], details: error.message,
    });
    return { status: row[QUEUE_COLUMNS.status], errorCode: row[QUEUE_COLUMNS.lastErrorCode] };
  }
}

export async function runCycle(sheets, drive, config) {
  const [queueRows, executionRows] = await Promise.all([
    getValues(sheets, config, RANGES.queue),
    getValues(sheets, config, RANGES.executions),
  ]);
  if (executionRows.length) assertHeader(executionRows[0], EXPECTED_HEADERS.EXECUTIONS, 'EXECUTIONS');

  const recovered = staleRecovery(queueRows, config);
  if (!config.dryRun) {
    for (const item of recovered) {
      await updateRow(sheets, config, `DISPATCH_QUEUE!A${item.sheetRow}:T${item.sheetRow}`, item.row);
      await appendAudit(sheets, config, {
        auditId: `AUD-${crypto.randomUUID()}`,
        taskId: item.row[QUEUE_COLUMNS.taskId],
        eventType: 'STALE_LOCK_RECOVERED',
        statusFrom: 'RUNNING', statusTo: 'RETRY_WAIT', at: new Date().toISOString(),
        correlationId: item.row[QUEUE_COLUMNS.correlationId],
        errorCode: 'STALE_LOCK_RECOVERED',
      });
    }
  }

  const items = selectClaimableRows(queueRows, config);
  if (config.dryRun) return { processed: 0, claimable: items.length, recovered: recovered.length, lastError: '' };
  let lastError = '';
  for (const item of items) {
    const outcome = await processItem(sheets, drive, config, item, executionRows);
    if (!lastError && outcome?.errorCode) lastError = outcome.errorCode;
  }
  return { processed: items.length, claimable: items.length, recovered: recovered.length, lastError };
}

async function main() {
  const config = loadConfig();
  const { sheets, drive } = await getClients();
  let lastHeartbeat = 0;
  do {
    let lastError = '';
    let result = { processed: 0, claimable: 0, recovered: 0, lastError: '' };
    try {
      result = await runCycle(sheets, drive, config);
      lastError = result.lastError || '';
    } catch (error) {
      lastError = error.code || error.message;
      throw error;
    } finally {
      if (!config.dryRun && Date.now() - lastHeartbeat >= config.heartbeatEveryMs) {
        await heartbeat(sheets, config, { queueDepth: result.claimable, lastError });
        lastHeartbeat = Date.now();
      }
    }
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      ...result,
      dryRun: config.dryRun,
      version: config.workerVersion,
      commit: config.workerCommit,
    }));
    if (config.once) break;
    await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
  } while (true);
}

const modulePath = path.resolve(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath && modulePath === entryPath) {
  main().catch(error => {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: error.message, code: error.code || 'UNEXPECTED_ERROR' }));
    process.exitCode = 1;
  });
}
