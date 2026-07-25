import test from 'node:test';
import assert from 'node:assert/strict';
import { processApprovalDecisions } from '../src/approval-processor.js';

function mockSheets() {
  const updates = [];
  const appends = [];
  const ranges = {
    'APPROVALS!A1:P2000': [
      ['APPROVAL_ID','TASK_ID','ACTION_TYPE','RESOURCE_URI','REQUESTED_BY','APPROVER_ID','REASON','RISK_LEVEL','STATUS','REQUESTED_AT','DECIDED_AT','DECISION_NOTE','EXECUTED_AT','EXECUTION_ID','ROLLBACK_URI','ERROR_CODE'],
      ['APR-1','TASK-1','HERMES_RESULT_APPROVAL','gdrive://result','AI-HERMES','danganhdung','','MEDIUM','APPROVED','','2026-07-25T10:00:00Z','OK','','EXE-1','',''],
    ],
    'DISPATCH_QUEUE!A1:T5000': [
      ['QUEUE_ID','TASK_ID'],
      ['Q-1','TASK-1','danganhdung','10_CA_NHAN/danganhdung','WAITING_APPROVAL','','','','','','','','','','','','','CORR-1','',''],
    ],
    'TASKS!A1:T5000': [
      ['TASK_ID'],
      ['TASK-1','','','','','','','','','','','','','WAITING_APPROVAL','','','','','',''],
    ],
  };
  return {
    updates,
    appends,
    spreadsheets: {
      values: {
        get: async ({ range }) => ({ data: { values: ranges[range] || [] } }),
        update: async request => { updates.push(request); },
        append: async request => { appends.push(request); },
      },
    },
  };
}

test('approved decision finalizes queue and task with audit', async () => {
  const sheets = mockSheets();
  const processed = await processApprovalDecisions(sheets, {
    spreadsheetId: 'sheet',
    ownerId: 'danganhdung',
    targetWorkspace: '10_CA_NHAN/danganhdung',
  });

  assert.equal(processed, 1);
  assert.equal(sheets.updates.length, 3);
  assert.equal(sheets.appends.length, 1);
  const queueUpdate = sheets.updates.find(item => item.range.startsWith('DISPATCH_QUEUE!'));
  assert.equal(queueUpdate.requestBody.values[0][4], 'COMPLETED');
  const audit = sheets.appends[0].requestBody.values[0];
  assert.equal(audit[4], 'APPROVAL_EXECUTED');
});
