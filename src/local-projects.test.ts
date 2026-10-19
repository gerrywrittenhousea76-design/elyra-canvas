import { describe, expect, it } from 'vitest';
import {
  PROJECT_ID,
  STORAGE_KEY,
  createBlankWorkspace,
  readWorkspace,
  serializeWorkspace,
  workspaceStorageKey,
} from './domain';
import * as projectApi from './local-projects';
import {
  LEGACY_AGENT_RUN_STORAGE_KEY,
  LOCAL_PROJECT_CATALOG_KEY,
  LocalProjectError,
  createLocalProject,
  ensureLocalProjectCatalog,
  listLocalProjects,
  loadLocalProjectWorkspace,
  projectAgentRunStorageKey,
  readLocalProjectCatalog,
  renameLocalProject,
  restoreLocalProject,
  saveLocalProjectWorkspace,
  setActiveLocalProject,
  trashLocalProject,
  type LocalProjectStorage,
} from './local-projects';

class MemoryStorage implements LocalProjectStorage {
  readonly values = new Map<string, string>();
  readonly setKeys: string[] = [];
  readonly removedKeys: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.setKeys.push(key);
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.removedKeys.push(key);
    this.values.delete(key);
  }
}

const T0 = '2026-08-15T08:00:00.000Z';
const T1 = '2026-08-15T08:01:00.000Z';
const T2 = '2026-08-15T08:02:00.000Z';

describe('CORE-012 local project catalog migration', () => {
  it('registers the sealed singleton exactly once without moving or rewriting it', () => {
    const legacy = createBlankWorkspace();
    legacy.nodes.push({
      id: 'legacy-object', kind: 'generated', name: 'legacy', x: 1, y: 2, width: 100, height: 100,
      status: 'ready', version: 1, prompt: 'private', createdAt: '2026-08-15T07:00:00.000Z',
      assetId: 'legacy-asset', versionId: 'legacy-version',
    });
    legacy.assets.push({
      id: 'legacy-asset', kind: 'image', source: 'local-upload', providerId: 'local-upload',
      mimeType: 'image/png', prompt: 'private', createdAt: '2026-08-15T07:00:00.000Z',
      metadata: { deterministic: false, width: 10, height: 10 },
      storage: {
        locator: `indexeddb://elyra-assets/${PROJECT_ID}/legacy-blob`, projectId: PROJECT_ID, blobKey: 'legacy-blob',
        sha256: 'a'.repeat(64), bytes: 12, mimeType: 'image/png', createdAt: '2026-08-15T07:00:00.000Z',
      },
    });
    legacy.versions.push({ id: 'legacy-version', canvasObjectId: 'legacy-object', sequence: 1, status: 'ready', createdAt: '2026-08-15T07:00:00.000Z' });
    const legacyBytes = serializeWorkspace(legacy);
    const storage = new MemoryStorage({ [STORAGE_KEY]: legacyBytes });

    const first = ensureLocalProjectCatalog(storage, T0);
    expect(first).toMatchObject({ status: 'ready', registeredLegacy: true });
    expect(storage.getItem(STORAGE_KEY)).toBe(legacyBytes);
    expect(storage.setKeys.filter((key) => key === STORAGE_KEY)).toEqual([]);
    expect(storage.removedKeys).toEqual([]);

    const second = ensureLocalProjectCatalog(storage, T1);
    expect(second).toMatchObject({ status: 'ready', registeredLegacy: false });
    expect(storage.setKeys.filter((key) => key === LOCAL_PROJECT_CATALOG_KEY)).toHaveLength(1);
    expect(storage.getItem(STORAGE_KEY)).toBe(legacyBytes);
    const restored = readWorkspace(PROJECT_ID, storage);
    expect(restored.status).toBe('ready');
    if (restored.status === 'ready') {
      expect(restored.workspace.nodes.map((node) => node.id)).toEqual(['legacy-object']);
      expect(restored.workspace.assets[0].storage?.locator).toContain('/legacy-blob');
      expect(restored.workspace.versions.map((version) => version.id)).toEqual(['legacy-version']);
    }
  });

  it('preserves corrupt or cross-project legacy bytes and refuses to create a catalog', () => {
    const wrong = JSON.parse(serializeWorkspace(createBlankWorkspace()));
    wrong.projectId = 'another-project';
    const raw = JSON.stringify(wrong);
    const storage = new MemoryStorage({ [STORAGE_KEY]: raw });

    expect(ensureLocalProjectCatalog(storage, T0)).toEqual({
      status: 'corrupt',
      code: 'LOCAL_PROJECT_LEGACY_WORKSPACE_PROJECT_BOUNDARY_MISMATCH',
    });
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(LOCAL_PROJECT_CATALOG_KEY)).toBeNull();
    expect(storage.setKeys).toEqual([]);
    expect(storage.removedKeys).toEqual([]);
  });

  it('fails closed for an invalid catalog instead of silently rebuilding it', () => {
    const storage = new MemoryStorage({ [LOCAL_PROJECT_CATALOG_KEY]: '{broken' });
    expect(readLocalProjectCatalog(storage)).toEqual({ status: 'corrupt', code: 'LOCAL_PROJECT_CATALOG_JSON_INVALID' });
    expect(ensureLocalProjectCatalog(storage, T0)).toEqual({ status: 'corrupt', code: 'LOCAL_PROJECT_CATALOG_JSON_INVALID' });
    expect(storage.getItem(LOCAL_PROJECT_CATALOG_KEY)).toBe('{broken');
    expect(storage.setKeys).toEqual([]);
  });
});

describe('CORE-012 local project lifecycle', () => {
  it('keeps legacy storage keys and namespaces only newly created projects', () => {
    expect(workspaceStorageKey(PROJECT_ID)).toBe(STORAGE_KEY);
    expect(workspaceStorageKey('project-a')).toBe('elyra-core-012-workspace-v1:project-a');
    expect(projectAgentRunStorageKey(PROJECT_ID)).toBe(LEGACY_AGENT_RUN_STORAGE_KEY);
    expect(projectAgentRunStorageKey('project-a')).toBe('elyra-core-012-agent-run-v1:project-a');
  });

  it('creates, opens and isolates multiple blank workspaces with stable IDs', () => {
    const storage = new MemoryStorage();
    expect(ensureLocalProjectCatalog(storage, T0).status).toBe('ready');
    const first = createLocalProject({ storage, nowIso: T1, projectId: 'project-a', title: ' 项目   A ' });
    const second = createLocalProject({ storage, nowIso: T2, projectId: 'project-b', title: '项目 B' });

    expect(first.project).toMatchObject({ id: 'project-a', title: '项目 A' });
    expect(second.catalog.activeProjectId).toBe('project-b');
    expect(new Set(second.catalog.projects.map((project) => project.id)).size).toBe(3);
    expect(readWorkspace('project-a', storage).status).toBe('ready');
    expect(readWorkspace('project-b', storage).status).toBe('ready');
    expect(storage.getItem(STORAGE_KEY)).toBeNull();

    const a = loadLocalProjectWorkspace('project-a', storage);
    a.viewport = { x: 10, y: 20, scale: 1.2 };
    a.nodes.push({ id: 'only-a', kind: 'generated', name: 'A', x: 0, y: 0, width: 100, height: 100, status: 'ready', version: 1, prompt: '', createdAt: T1 });
    saveLocalProjectWorkspace('project-a', a, { storage, nowIso: T2 });
    expect(loadLocalProjectWorkspace('project-a', storage).nodes.map((node) => node.id)).toEqual(['only-a']);
    expect(loadLocalProjectWorkspace('project-b', storage).nodes).toEqual([]);
    expect(loadLocalProjectWorkspace('project-b', storage).viewport).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('renames only the target and updates recency with bounded non-empty text', () => {
    const storage = new MemoryStorage();
    ensureLocalProjectCatalog(storage, T0);
    createLocalProject({ storage, nowIso: T1, projectId: 'project-a', title: '旧名称' });
    createLocalProject({ storage, nowIso: T1, projectId: 'project-b', title: '保持不变' });
    const renamed = renameLocalProject('project-a', '  新   名称  ', { storage, nowIso: T2 });

    expect(renamed.projects.find((project) => project.id === 'project-a')).toMatchObject({ title: '新 名称', updatedAt: T2 });
    expect(renamed.projects.find((project) => project.id === 'project-b')?.title).toBe('保持不变');
    expect(listLocalProjects(renamed)[0].id).toBe('project-a');
    expect(() => renameLocalProject('project-a', '   ', { storage, nowIso: T2 })).toThrowError(LocalProjectError);
    expect(() => renameLocalProject('project-a', 'x'.repeat(81), { storage, nowIso: T2 })).toThrow('LOCAL_PROJECT_TITLE_INVALID');
  });

  it('moves a project to recoverable trash without deleting metadata, run state or Blob references, then restores it', () => {
    const storage = new MemoryStorage();
    ensureLocalProjectCatalog(storage, T0);
    createLocalProject({ storage, nowIso: T1, projectId: 'project-a', title: '可恢复项目' });
    setActiveLocalProject('project-a', { storage, nowIso: T1 });
    const workspaceBytes = storage.getItem(workspaceStorageKey('project-a'));
    storage.setItem(projectAgentRunStorageKey('project-a'), '{"state":"COMPLETED"}');
    storage.setKeys.length = 0;

    expect(() => trashLocalProject('project-a', { storage, nowIso: T2, confirmed: false })).toThrow('LOCAL_PROJECT_TRASH_CONFIRMATION_REQUIRED');
    const trashed = trashLocalProject('project-a', { storage, nowIso: T2, confirmed: true, replacementProjectId: PROJECT_ID });
    expect(trashed.activeProjectId).toBe(PROJECT_ID);
    expect(trashed.projects.find((project) => project.id === 'project-a')?.trashedAt).toBe(T2);
    expect(listLocalProjects(trashed).some((project) => project.id === 'project-a')).toBe(false);
    expect(listLocalProjects(trashed, { includeTrashed: true }).some((project) => project.id === 'project-a')).toBe(true);
    expect(storage.getItem(workspaceStorageKey('project-a'))).toBe(workspaceBytes);
    expect(storage.getItem(projectAgentRunStorageKey('project-a'))).toBe('{"state":"COMPLETED"}');
    expect(storage.removedKeys).toEqual([]);
    expect(() => loadLocalProjectWorkspace('project-a', storage)).toThrow('LOCAL_PROJECT_TRASHED');

    const restored = restoreLocalProject('project-a', { storage, nowIso: '2026-08-15T08:03:00.000Z', activate: true });
    expect(restored.activeProjectId).toBe('project-a');
    expect(restored.projects.find((project) => project.id === 'project-a')?.trashedAt).toBeUndefined();
    expect(storage.getItem(workspaceStorageKey('project-a'))).toBe(workspaceBytes);
    expect(loadLocalProjectWorkspace('project-a', storage).nodes).toEqual([]);
  });

  it('does not expose a permanent project purge operation', () => {
    expect('purgeLocalProject' in projectApi).toBe(false);
    expect('deleteLocalProject' in projectApi).toBe(false);
  });
});
