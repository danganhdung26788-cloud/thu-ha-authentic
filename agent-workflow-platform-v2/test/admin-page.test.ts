import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_PAGE } from '../src/apps/api/admin-page.js';

test('admin page is local-token driven and does not embed credentials', () => {
  assert.match(ADMIN_PAGE, /Workflow AI V2/);
  assert.match(ADMIN_PAGE, /sessionStorage/);
  assert.match(ADMIN_PAGE, /API_AUTH_TOKEN/);
  assert.match(ADMIN_PAGE, /LOCAL \/ 0 API COST/);
  assert.doesNotMatch(ADMIN_PAGE, /sk-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(ADMIN_PAGE, /AIza[0-9A-Za-z_-]{20,}/);
});

test('admin page exposes technical task, approval and adapter operations', () => {
  assert.match(ADMIN_PAGE, /\/v1\/admin\/tasks/);
  assert.match(ADMIN_PAGE, /\/v1\/admin\/approvals/);
  assert.match(ADMIN_PAGE, /\/v1\/admin\/adapters/);
  assert.match(ADMIN_PAGE, /\/v1\/approvals\//);
  assert.match(ADMIN_PAGE, /WAITING_INPUT/);
  assert.match(ADMIN_PAGE, /Mở giao diện chat/);
  assert.doesNotMatch(ADMIN_PAGE, /id="newTask"/);
});
