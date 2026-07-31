import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecutorResult } from '../executors/contracts.js';

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class ReceiptStore {
  constructor(readonly root: string, readonly role: 'HERMES' | 'CODEX') {}

  pathFor(ownerId: string, workspaceId: string, taskId: string): string {
    return join(
      this.root,
      this.role.toLowerCase(),
      safeSegment(ownerId),
      safeSegment(workspaceId),
      `${safeSegment(taskId)}.json`,
    );
  }

  async read(ownerId: string, workspaceId: string, taskId: string): Promise<ExecutorResult | null> {
    try {
      const content = await readFile(this.pathFor(ownerId, workspaceId, taskId), 'utf8');
      return JSON.parse(content) as ExecutorResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(ownerId: string, workspaceId: string, taskId: string, result: ExecutorResult): Promise<void> {
    const finalPath = this.pathFor(ownerId, workspaceId, taskId);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(tempPath, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, finalPath);
  }
}
