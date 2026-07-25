import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function config() {
  return {
    spreadsheetId: required('AI_GATEWAY_SPREADSHEET_ID'),
    ownerId: process.env.AI_GATEWAY_OWNER_ID || 'danganhdung',
    targetWorkspace: process.env.AI_GATEWAY_TARGET_WORKSPACE || '10_CA_NHAN/danganhdung',
  };
}

async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getValues(sheets, cfg, range) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: cfg.spreadsheetId, range });
  return response.data.values || [];
}

async function updateRow(sheets, cfg, range, row) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: cfg.spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function appendRow(sheets, cfg, range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function syncTask(sheets, cfg, taskRows, taskId, status, finalResultId, errorCode) {
  const index = taskRows.findIndex((row, rowIndex) => rowIndex > 0 && row[0] === taskId);
  if (index < 1) return;
  const row = [...taskRows[index]];
  while (row.length < 20) row.push('');
  row[13] = status;
  row[17] = new Date().toISOString();
  row[18] = finalResultId || '';
  row[19] = errorCode || '';
  await updateRow(sheets, cfg, `TASKS!A${index + 1}:T${index + 1}`, row);
}

export async function processApprovalDecisions(sheets, cfg) {
  const [approvalRows, queueRows, taskRows] = await Promise.all([
    getValues(sheets, cfg, 'APPROVALS!A1:P2000'),
    getValues(sheets, cfg, 'DISPATCH_QUEUE!A1:T5000'),
    getValues(sheets, cfg, 'TASKS!A1:T5000'),
  ]);

  let processed = 0;
  for (let index = 1; index < approvalRows.length; index += 1) {
    const approval = [...approvalRows[index]];
    while (approval.length < 16) approval.push('');

    const decision = String(approval[8] || '').trim().toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision) || approval[12]) continue;

    const taskId = approval[1];
    const queueIndex = queueRows.findIndex((row, rowIndex) =>
      rowIndex > 0 && row[1] === taskId && row[4] === 'WAITING_APPROVAL');

    const decidedAt = approval[10] || new Date().toISOString();
    const finalStatus = decision === 'APPROVED' ? 'COMPLETED' : 'REJECTED';
    const errorCode = decision === 'REJECTED' ? 'APPROVAL_REJECTED' : '';

    if (queueIndex > 0) {
      const queue = [...queueRows[queueIndex]];
      while (queue.length < 20) queue.push('');
      queue[4] = finalStatus;
      queue[10] = '';
      queue[15] = finalStatus === 'COMPLETED' ? decidedAt : '';
      queue[16] = errorCode;
      queue[19] = decidedAt;
      await updateRow(sheets, cfg, `DISPATCH_QUEUE!A${queueIndex + 1}:T${queueIndex + 1}`, queue);

      await syncTask(
        sheets,
        cfg,
        taskRows,
        taskId,
        finalStatus,
        approval[3] || approval[0],
        errorCode,
      );

      await appendRow(sheets, cfg, 'AUDIT_EVENTS!A:R', [
        `AUD-${crypto.randomUUID()}`,
        taskId,
        approval[13] || '',
        '',
        decision === 'APPROVED' ? 'APPROVAL_EXECUTED' : 'APPROVAL_REJECTED',
        'SYSTEM',
        'AI-HERMES-APPROVAL-PROCESSOR',
        cfg.ownerId,
        cfg.targetWorkspace,
        approval[3] || '',
        '', '',
        'WAITING_APPROVAL',
        finalStatus,
        decidedAt,
        queue[17] || '',
        errorCode,
        approval[11] || '',
      ]);
    }

    approval[12] = decidedAt;
    await updateRow(sheets, cfg, `APPROVALS!A${index + 1}:P${index + 1}`, approval);
    processed += 1;
  }

  return processed;
}

async function main() {
  const cfg = config();
  const sheets = await sheetsClient();
  const processed = await processApprovalDecisions(sheets, cfg);
  console.log(JSON.stringify({ at: new Date().toISOString(), approvalsProcessed: processed }));
}

const modulePath = path.resolve(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath && modulePath === entryPath) {
  main().catch(error => {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      error: error.message,
      code: error.code || 'UNEXPECTED_ERROR',
    }));
    process.exitCode = 1;
  });
}
