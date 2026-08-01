import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, relative, resolve } from 'node:path';
import {
  WorkspaceRegistrySchema,
  type WorkspaceRegistration,
  type WorkspaceRegistryDocument,
} from './contracts.js';

function pathInside(candidate: string, parent: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function executableName(value: string): string {
  const trimmed = value.trim();
  const name = basename(trimmed).toLowerCase();
  if (!trimmed || trimmed !== basename(trimmed) || /[\\/]/u.test(trimmed)) {
    throw new Error(`Executable allowlist entries must be command names, not paths: ${value}`);
  }
  return name;
}

function systemPathEntries(): string[] {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

export class WorkspaceRegistry {
  readonly #document: WorkspaceRegistryDocument;
  readonly #byId: ReadonlyMap<string, WorkspaceRegistration>;
  readonly #executableCache = new Map<string, string>();

  private constructor(document: WorkspaceRegistryDocument) {
    const seen = new Set<string>();
    const normalized = document.workspaces.map((workspace) => {
      if (seen.has(workspace.workspaceId)) {
        throw new Error(`Duplicate workspaceId: ${workspace.workspaceId}`);
      }
      seen.add(workspace.workspaceId);
      const root = resolve(workspace.root);
      if (!isAbsolute(root)) throw new Error(`Workspace root must be absolute: ${workspace.workspaceId}`);
      const readRoots = workspace.readRoots.map((entry) => this.normalizeChild(root, entry, 'read root'));
      const writeRoots = workspace.writeRoots.map((entry) => this.normalizeChild(root, entry, 'write root'));
      const allowedScripts = workspace.allowedScripts.map((entry) => this.normalizeChild(root, entry, 'script'));
      return {
        ...workspace,
        root,
        readRoots,
        writeRoots,
        allowedScripts,
        allowedExecutables: workspace.allowedExecutables.map(executableName),
      };
    });
    if (!seen.has(document.defaultWorkspaceId)) {
      throw new Error(`Default workspace is not registered: ${document.defaultWorkspaceId}`);
    }
    this.#document = { ...document, workspaces: normalized };
    this.#byId = new Map(normalized.map((workspace) => [workspace.workspaceId, workspace]));
  }

  static async load(path: string): Promise<WorkspaceRegistry> {
    const raw = await readFile(path, 'utf8');
    return new WorkspaceRegistry(WorkspaceRegistrySchema.parse(JSON.parse(raw)));
  }

  static fromDocument(document: unknown): WorkspaceRegistry {
    return new WorkspaceRegistry(WorkspaceRegistrySchema.parse(document));
  }

  get(workspaceId?: string): WorkspaceRegistration {
    const selectedId = workspaceId ?? this.#document.defaultWorkspaceId;
    const workspace = this.#byId.get(selectedId);
    if (!workspace) throw new Error(`Workspace is not allowlisted: ${selectedId}`);
    return workspace;
  }

  resolvePath(workspace: WorkspaceRegistration, candidate: string): string {
    const absolute = resolve(workspace.root, candidate);
    if (!pathInside(absolute, workspace.root)) {
      throw new Error(`Path is outside the allowlisted workspace: ${candidate}`);
    }
    return absolute;
  }

  resolveReadPath(workspace: WorkspaceRegistration, candidate: string): string {
    const absolute = this.resolvePath(workspace, candidate);
    if (!workspace.readRoots.some((root) => pathInside(absolute, root))) {
      throw new Error(`Read path is outside registered read roots: ${candidate}`);
    }
    return absolute;
  }

  resolveWritePath(workspace: WorkspaceRegistration, candidate: string): string {
    const absolute = this.resolvePath(workspace, candidate);
    if (!workspace.writeRoots.some((root) => pathInside(absolute, root))) {
      throw new Error(`Write path is outside registered write roots: ${candidate}`);
    }
    return absolute;
  }

  hasExecutable(workspace: WorkspaceRegistration, executable: string): boolean {
    try {
      this.assertExecutable(workspace, executable);
      return true;
    } catch {
      return false;
    }
  }

  assertExecutable(workspace: WorkspaceRegistration, executable: string): string {
    const name = executableName(executable);
    if (!workspace.allowedExecutables.includes(name)) {
      throw new Error(`Executable is not allowlisted: ${name}`);
    }
    const cacheKey = `${workspace.workspaceId}\u0000${name}`;
    const cached = this.#executableCache.get(cacheKey);
    if (cached && existsSync(cached)) return cached;

    for (const directory of systemPathEntries()) {
      const candidate = resolve(directory, name);
      if (existsSync(candidate)) {
        this.#executableCache.set(cacheKey, candidate);
        return candidate;
      }
    }
    throw new Error(`Allowlisted executable was not found on the system PATH: ${name}`);
  }

  assertScript(workspace: WorkspaceRegistration, candidate: string): string {
    const absolute = this.resolveReadPath(workspace, candidate);
    if (!workspace.allowedScripts.includes(absolute)) {
      throw new Error(`Script is not allowlisted: ${candidate}`);
    }
    return absolute;
  }

  assertScheduledTask(workspace: WorkspaceRegistration, taskName: string): void {
    if (!taskName.startsWith(workspace.scheduledTaskPrefix)) {
      throw new Error(`Scheduled Task must use prefix ${workspace.scheduledTaskPrefix}`);
    }
  }

  list(): ReadonlyArray<Readonly<{
    workspaceId: string;
    codexRead: boolean;
    localRead: boolean;
    localWrite: boolean;
  }>> {
    return this.#document.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      codexRead: workspace.allowCodexRead,
      localRead: workspace.allowLocalRead,
      localWrite: workspace.allowLocalWrite,
    }));
  }

  private normalizeChild(root: string, candidate: string, kind: string): string {
    const absolute = resolve(root, candidate);
    if (!pathInside(absolute, root)) {
      throw new Error(`Registered ${kind} is outside workspace root: ${candidate}`);
    }
    return absolute;
  }
}

export { pathInside };
