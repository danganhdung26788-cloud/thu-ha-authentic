import assert from 'node:assert/strict';
import { basename, isAbsolute } from 'node:path';
import test from 'node:test';
import { WorkspaceRegistry } from '../src/workspace-registry.js';

test('workspace registry resolves allowlisted executable from system PATH to absolute path', () => {
  const executableName = basename(process.execPath);
  const registry = WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'test',
    workspaces: [{
      workspaceId: 'test',
      root: process.cwd(),
      readRoots: ['.'],
      writeRoots: [],
      allowedExecutables: [executableName],
      allowedScripts: [],
      scheduledTaskPrefix: 'TEST-',
      allowCodexRead: false,
      allowLocalRead: true,
      allowLocalWrite: false,
    }],
  });
  const resolved = registry.assertExecutable(registry.get(), executableName);
  assert.equal(isAbsolute(resolved), true);
  assert.equal(basename(resolved).toLowerCase(), executableName.toLowerCase());
});

test('workspace registry rejects executable paths and non-allowlisted names', () => {
  assert.throws(() => WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'test',
    workspaces: [{
      workspaceId: 'test',
      root: process.cwd(),
      readRoots: ['.'],
      writeRoots: [],
      allowedExecutables: ['./node'],
      allowedScripts: [],
      scheduledTaskPrefix: 'TEST-',
      allowCodexRead: false,
      allowLocalRead: true,
      allowLocalWrite: false,
    }],
  }), /command names, not paths/);

  const registry = WorkspaceRegistry.fromDocument({
    defaultWorkspaceId: 'test',
    workspaces: [{
      workspaceId: 'test',
      root: process.cwd(),
      readRoots: ['.'],
      writeRoots: [],
      allowedExecutables: [],
      allowedScripts: [],
      scheduledTaskPrefix: 'TEST-',
      allowCodexRead: false,
      allowLocalRead: true,
      allowLocalWrite: false,
    }],
  });
  assert.throws(() => registry.assertExecutable(registry.get(), basename(process.execPath)), /not allowlisted/);
});
