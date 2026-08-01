import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
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

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing ancestor was found for path: ${candidate}`);
    current = parent;
  }
  return current;
}

function assertNoLinkedSegments(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`Path is outside the allowlisted workspace: ${candidate}`);
  }
  let current = root;
  for (const segment of relation.split(/[\\/]/u).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symbolic links and junctions are not allowed in delegated paths: ${candidate}`);
    }
  }
}

function canonicalizeWithinRoot(root: string, candidate: string): string {
  assertNoLinkedSegments(root, candidate);
  const existing = nearestExistingAncestor(candidate);
  const canonicalExisting = realpathSync.native(existing);
  const canonical = resolve(canonicalExisting, relative(existing, candidate));
  if (!pathInside(canonical, root)) {
    throw new Error(`Resolved path escapes the allowlisted workspace: ${candidate}`);
  }
  return canonical;
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
      const configuredRoot = resolve(workspace.root);
      if (!isAbsolute(configuredRoot)) throw new Error(`Workspace root must be absolute: ${workspace.workspaceId}`);
      if (!existsSync(configuredRoot) || !lstatSync(configuredRoot).isDirectory()) {
        throw new Error(`Workspace root must be an existing directory: ${workspace.workspaceId}`);
      }
      const root = realpathSync.native(configuredRoot);
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
    return canonicalizeWithinRoot(workspace.root, absolute);
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
      if (!existsSync(candidate)) continue;
      const canonical = realpathSync.native(candidate);
      if (pathInside(canonical, workspace.root)) continue;
      this.#executableCache.set(cacheKey, canonical);
      return canonical;
    }
    throw new Error(`Allowlisted executable was not found outside the workspace on the system PATH: ${name}`);
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
    return canonicalizeWithinRoot(root, absolute);
  }
}

export { pathInside };
