import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  WorkspaceRegistrySchema,
  type WorkspaceRegistration,
  type WorkspaceRegistryDocument,
} from './contracts.js';

export class WorkspaceRegistry {
  readonly #document: WorkspaceRegistryDocument;
  readonly #byId: ReadonlyMap<string, WorkspaceRegistration>;

  private constructor(document: WorkspaceRegistryDocument) {
    const seen = new Set<string>();
    const normalized = document.workspaces.map((workspace) => {
      if (seen.has(workspace.workspaceId)) {
        throw new Error(`Duplicate workspaceId: ${workspace.workspaceId}`);
      }
      seen.add(workspace.workspaceId);
      const root = resolve(workspace.root);
      if (!isAbsolute(root)) throw new Error(`Workspace root must be absolute: ${workspace.workspaceId}`);
      return { ...workspace, root };
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
    const relation = relative(workspace.root, absolute);
    if (relation.startsWith('..') || isAbsolute(relation)) {
      throw new Error(`Path is outside the allowlisted workspace: ${candidate}`);
    }
    return absolute;
  }

  list(): ReadonlyArray<Readonly<{
    workspaceId: string;
    codexRead: boolean;
    codexWrite: boolean;
    hermesRead: boolean;
    hermesWrite: boolean;
  }>> {
    return this.#document.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      codexRead: workspace.allowCodexRead,
      codexWrite: workspace.allowCodexWrite,
      hermesRead: workspace.allowHermesRead,
      hermesWrite: workspace.allowHermesWrite,
    }));
  }
}
