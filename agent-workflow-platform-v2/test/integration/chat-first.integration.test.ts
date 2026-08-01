import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ChatStore } from '../../src/chat/chat-store.js';
import { resetEnvForTests } from '../../src/config/env.js';
import { PostgresControlPlaneStore } from '../../src/control-plane/postgres-store.js';
import { closePool, getPool } from '../../src/db/pool.js';

const integrationEnabled = process.env.RUN_INTEGRATION === '1';

test('chat-first persistence links message, task, clarification, progress and diagnostics', { skip: !integrationEnabled }, async () => {
  resetEnvForTests();
  const chat = new ChatStore();
  const tasks = new PostgresControlPlaneStore();
  const suffix = randomUUID();
  const identity = {
    ownerId: `chat-owner-${suffix}`,
    workspaceId: `chat-workspace-${suffix}`,
  };
  let conversationId = '';
  const taskId = `TASK-CHAT-${suffix}`;
  try {
    const conversation = await chat.createConversation(identity);
    conversationId = conversation.conversationId;
    const userMessage = await chat.addUserMessage(
      identity,
      conversationId,
      'Sửa tài liệu này nhưng chưa rõ sửa bản gốc hay bản sao.',
      `CLIENT-${suffix}`,
      [],
    );
    const created = await tasks.createTask({
      taskId,
      correlationId: `CORR-${suffix}`,
      idempotencyKey: `CHAT:${conversationId}:${suffix}`,
      ownerId: identity.ownerId,
      workspaceId: identity.workspaceId,
      conversationId,
      sourceMessageId: userMessage.messageId,
      objective: userMessage.content,
      readScope: ['.'],
      writeScope: ['.'],
      autonomyMode: 'SANDBOX_HIGH',
      riskLevel: 'MEDIUM',
    });
    assert.equal(created.created, true);
    await chat.linkMessageTask(userMessage.messageId, taskId, []);
    await chat.appendProgress({
      conversationId,
      taskId,
      kind: 'STATUS',
      stage: 'QUEUED',
      message: 'Đã nhận yêu cầu.',
      percent: 5,
    });
    await tasks.updateTaskStatus(taskId, 'WAITING_INPUT', { attempt: 1 });
    const clarification = await chat.createClarification({
      conversationId,
      taskId,
      question: 'Anh muốn sửa tệp gốc hay tạo một bản sao?',
      options: ['Sửa tệp gốc', 'Tạo bản sao'],
      reason: 'Thiếu lựa chọn nghiệp vụ.',
    });
    const answer = await chat.answerClarificationAndRequeue(
      identity,
      clarification.clarificationId,
      'Tạo bản sao',
    );
    assert.equal(answer.taskId, taskId);
    const resumed = await tasks.getTask(taskId);
    assert.equal(resumed?.status, 'QUEUED');
    assert.match(resumed?.objective ?? '', /USER_CLARIFICATION/);
    assert.match(resumed?.objective ?? '', /Tạo bản sao/);

    const diagnostic = await chat.createDiagnostic({
      conversationId,
      taskId,
      errorCode: 'TEST_DIAGNOSTIC',
      summary: 'Chẩn đoán kiểm thử.',
      reportText: 'Không chứa bí mật.',
      redactionCount: 0,
    });
    const snapshot = await chat.getSnapshot(identity, conversationId);
    assert.equal(snapshot.messages[0]?.taskId, taskId);
    assert.equal(snapshot.progress.some((item) => item.stage === 'ANSWERED'), true);
    assert.equal(snapshot.clarifications[0]?.status, 'ANSWERED');
    assert.equal(snapshot.diagnostics[0]?.diagnosticId, diagnostic.diagnosticId);

    const outbox = await tasks.claimOutbox();
    assert.equal(outbox.some((item) => (
      item.aggregateId === taskId && item.eventType === 'TASK_CLARIFIED'
    )), true);
  } finally {
    const pool = getPool();
    if (conversationId) {
      await pool.query('DELETE FROM diagnostic_reports WHERE conversation_id = $1', [conversationId]);
      await pool.query('DELETE FROM progress_events WHERE conversation_id = $1', [conversationId]);
      await pool.query('DELETE FROM clarification_requests WHERE conversation_id = $1', [conversationId]);
      await pool.query('DELETE FROM chat_attachments WHERE conversation_id = $1', [conversationId]);
    }
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [taskId]);
    await pool.query('DELETE FROM audit_events WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM evidence_objects WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM approvals WHERE task_id = $1', [taskId]);
    await pool.query('DELETE FROM executions WHERE task_id = $1', [taskId]);
    await pool.query('UPDATE tasks SET source_message_id = NULL WHERE task_id = $1', [taskId]);
    if (conversationId) {
      await pool.query('UPDATE chat_messages SET task_id = NULL WHERE conversation_id = $1', [conversationId]);
    }
    await pool.query('DELETE FROM tasks WHERE task_id = $1', [taskId]);
    if (conversationId) {
      await pool.query('DELETE FROM chat_messages WHERE conversation_id = $1', [conversationId]);
      await pool.query('DELETE FROM conversations WHERE conversation_id = $1', [conversationId]);
    }
    await closePool();
  }
});
