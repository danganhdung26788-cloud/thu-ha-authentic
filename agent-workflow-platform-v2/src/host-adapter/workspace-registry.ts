import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

const WorkspaceRegistrationSchema = z.object({
  ownerId: z.string().min(1),
  workspaceId: z.string().min(1),
  root: z.string().min(1),
  readRoots: z.array(z.string().min(1)).default([]),
  writeRoots: z.array(z.string().min(1)).default([]),
  allowedExecutables: z.array(z.string().min(1)).default([]),
  allowedScripts: z.array(z.string().min(1)).default([]),
  scheduledTaskPrefix: z.string().min(1).default('Hermes-V2-'),
});

const WorkspaceRegistrySchema = z.object({
  version: z.literal(1),
  workspaces: z.array(WorkspaceRegistrationSchema).min(1),
});

export type WorkspaceRegistration = z.infer<typeof WorkspaceRegistrationSchema>;

function normalizePath(pathValue: string, root: string): string {
  return resolve(isAbsolute(pathValue) ? pathValue : resolve(root, pathValue));
}

export function pathInside(candidate: string, root: string): boolean {
  const candidatePath = resolve(candidate);
  const rootPath = resolve(root);
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class WorkspaceRegistry {
  readonly #entries = new Map<string, WorkspaceRegistration>();

  private constructor(entries: WorkspaceRegistration[]) {
    for (const raw of entries) {
      const root = resolve(raw.root);
      const entry: WorkspaceRegistration = {
        ...raw,
        root,
        readRoots: (raw.readRoots.length ? raw.readRoots : [root]).map((item) => normalizePath(item, root)),
        writeRoots: (raw.writeRoots.length ? raw.writeRoots : [root]).map((item) => normalizePath(item, root)),
        allowedScripts: raw.allowedScripts.map((item) => normalizePath(item, root)),
        allowedExecutables: raw.allowedExecutables.map((item) => item.toLowerCase()),
      };
      const key = WorkspaceRegistry.key(entry.ownerId, entry.workspaceId);
      if (this.#entries.has(key)) throw new Error(`Duplicate workspace registry key: ${key}`);
      this.#entries.set(key, entry);
    }
  }

  static async load(path: string): Promise<WorkspaceRegistry> {
    const content = await readFile(path, 'utf8');
    const parsed = WorkspaceRegistrySchema.parse(JSON.parse(content));
    return new WorkspaceRegistry(parsed.workspaces);
  }

  static key(ownerId: string, workspaceId: string): string {
    return `${ownerId}\u0000${workspaceId}`;
  }

  get(ownerId: string, workspaceId: string): WorkspaceRegistration {
    const entry = this.#entries.get(WorkspaceRegistry.key(ownerId, workspaceId));
    if (!entry) throw new Error(`Workspace is not registered: owner=${ownerId}, workspace=${workspaceId}`);
    return entry;
  }

  resolveReadPath(entry: WorkspaceRegistration, inputPath: string): string {
    const candidate = normalizePath(inputPath, entry.root);
    if (!entry.readRoots.some((root) => pathInside(candidate, root))) {
      throw new Error(`Read path outside registered scope: ${inputPath}`);
    }
    return candidate;
  }

  resolveWritePath(entry: WorkspaceRegistration, inputPath: string): string {
    const candidate = normalizePath(inputPath, entry.root);
    if (!entry.writeRoots.some((root) => pathInside(candidate, root))) {
      throw new Error(`Write path outside registered scope: ${inputPath}`);
    }
    return candidate;
  }

  assertExecutable(entry: WorkspaceRegistration, executable: string): void {
    const normalized = executable.toLowerCase();
    if (!entry.allowedExecutables.includes(normalized)) {
      throw new Error(`Executable is not allowlisted for workspace: ${executable}`);
    }
  }

  assertScript(entry: WorkspaceRegistration, scriptPath: string): string {
    const candidate = this.resolveReadPath(entry, scriptPath);
    if (!entry.allowedScripts.some((allowed) => resolve(allowed) === candidate)) {
      throw new Error(`Script is not allowlisted for workspace: ${scriptPath}`);
    }
    return candidate;
  }
}
