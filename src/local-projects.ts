import {
  PROJECT_ID,
  STORAGE_KEY,
  createBlankWorkspace,
  loadWorkspace,
  persistWorkspace,
  readWorkspace,
  workspaceStorageKey,
  type Workspace,
} from './domain';

export { workspaceStorageKey };

export const LOCAL_PROJECT_CATALOG_KEY = 'elyra-core-012-project-catalog-v1';
export const LOCAL_PROJECT_CATALOG_SCHEMA_VERSION = 1 as const;
export const LOCAL_PROJECT_TITLE_MAX_LENGTH = 80;
export const LEGACY_AGENT_RUN_STORAGE_KEY = 'elyra-core-008-agent-run-v1';
export const PROJECT_AGENT_RUN_STORAGE_PREFIX = 'elyra-core-012-agent-run-v1:';
export const DEFAULT_LOCAL_PROJECT_TITLE = '便携式无线音箱视觉创作';
export const NEW_LOCAL_PROJECT_TITLE = '未命名项目';

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface LocalProjectRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  trashedAt?: string;
}

export interface LocalProjectCatalogV1 {
  schemaVersion: typeof LOCAL_PROJECT_CATALOG_SCHEMA_VERSION;
  activeProjectId: string;
  migration: {
    legacyProjectRegistered: true;
    legacyProjectId: typeof PROJECT_ID;
    sourceStorageKey: typeof STORAGE_KEY;
    registeredAt: string;
  };
  projects: LocalProjectRecord[];
}

export type LocalProjectCatalogReadResult =
  | { status: 'missing' }
  | { status: 'ready'; catalog: LocalProjectCatalogV1 }
  | { status: 'corrupt'; code: string };

export type LocalProjectCatalogRegistrationResult =
  | { status: 'ready'; catalog: LocalProjectCatalogV1; registeredLegacy: boolean }
  | { status: 'corrupt'; code: string };

export type LocalProjectStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class LocalProjectError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LocalProjectError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasOnlyKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};

const isCanonicalIso = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

export const isLocalProjectId = (value: unknown): value is string => (
  typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
);

export const normalizeLocalProjectTitle = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > LOCAL_PROJECT_TITLE_MAX_LENGTH || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new LocalProjectError('LOCAL_PROJECT_TITLE_INVALID');
  }
  return normalized;
};

const isLocalProjectRecord = (value: unknown): value is LocalProjectRecord => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'title', 'createdAt', 'updatedAt'], ['trashedAt'])) return false;
  if (
    !isLocalProjectId(value.id)
    || typeof value.title !== 'string'
    || !isCanonicalIso(value.createdAt)
    || !isCanonicalIso(value.updatedAt)
    || (value.trashedAt !== undefined && !isCanonicalIso(value.trashedAt))
  ) return false;
  try {
    if (normalizeLocalProjectTitle(value.title) !== value.title) return false;
  } catch {
    return false;
  }
  const createdAt = Date.parse(value.createdAt);
  const updatedAt = Date.parse(value.updatedAt);
  if (updatedAt < createdAt) return false;
  const trashedAt = value.trashedAt;
  return trashedAt === undefined || (typeof trashedAt === 'string' && Date.parse(trashedAt) >= createdAt);
};

export const isLocalProjectCatalogV1 = (value: unknown): value is LocalProjectCatalogV1 => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'activeProjectId', 'migration', 'projects'])) return false;
  if (
    value.schemaVersion !== LOCAL_PROJECT_CATALOG_SCHEMA_VERSION
    || !isLocalProjectId(value.activeProjectId)
    || !Array.isArray(value.projects)
    || value.projects.length === 0
    || !value.projects.every(isLocalProjectRecord)
  ) return false;
  const ids = value.projects.map((project) => project.id);
  if (new Set(ids).size !== ids.length) return false;
  const active = value.projects.find((project) => project.id === value.activeProjectId);
  if (!active || active.trashedAt !== undefined) return false;
  if (!isRecord(value.migration) || !hasOnlyKeys(value.migration, [
    'legacyProjectRegistered',
    'legacyProjectId',
    'sourceStorageKey',
    'registeredAt',
  ])) return false;
  return value.migration.legacyProjectRegistered === true
    && value.migration.legacyProjectId === PROJECT_ID
    && value.migration.sourceStorageKey === STORAGE_KEY
    && isCanonicalIso(value.migration.registeredAt);
};

const cloneCatalog = (catalog: LocalProjectCatalogV1): LocalProjectCatalogV1 => ({
  ...catalog,
  migration: { ...catalog.migration },
  projects: catalog.projects.map((project) => ({ ...project })),
});

const storageOrWindow = (storage?: LocalProjectStorage): LocalProjectStorage => storage ?? window.localStorage;

export const readLocalProjectCatalog = (storage?: Pick<Storage, 'getItem'>): LocalProjectCatalogReadResult => {
  const target = storage ?? window.localStorage;
  let raw: string | null;
  try {
    raw = target.getItem(LOCAL_PROJECT_CATALOG_KEY);
  } catch {
    return { status: 'corrupt', code: 'LOCAL_PROJECT_CATALOG_READ_FAILED' };
  }
  if (raw === null) return { status: 'missing' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isLocalProjectCatalogV1(parsed)) return { status: 'corrupt', code: 'LOCAL_PROJECT_CATALOG_INVALID' };
    return { status: 'ready', catalog: cloneCatalog(parsed) };
  } catch {
    return { status: 'corrupt', code: 'LOCAL_PROJECT_CATALOG_JSON_INVALID' };
  }
};

const requireCanonicalIso = (value: string): string => {
  if (!isCanonicalIso(value)) throw new LocalProjectError('LOCAL_PROJECT_TIME_INVALID');
  return value;
};

const latestWorkspaceIso = (workspace: Workspace | undefined, fallback: string): string => {
  if (!workspace) return fallback;
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of [
    ...workspace.nodes.map((item) => item.createdAt),
    ...workspace.assets.map((item) => item.createdAt),
    ...workspace.versions.map((item) => item.createdAt),
    ...workspace.jobs.flatMap((item) => [item.createdAt, item.updatedAt]),
  ]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : fallback;
};

const writeCatalog = (storage: LocalProjectStorage, catalog: LocalProjectCatalogV1): LocalProjectCatalogV1 => {
  if (!isLocalProjectCatalogV1(catalog)) throw new LocalProjectError('LOCAL_PROJECT_CATALOG_INVALID');
  try {
    storage.setItem(LOCAL_PROJECT_CATALOG_KEY, JSON.stringify(catalog));
  } catch {
    throw new LocalProjectError('LOCAL_PROJECT_CATALOG_WRITE_FAILED');
  }
  const reread = readLocalProjectCatalog(storage);
  if (reread.status !== 'ready') throw new LocalProjectError('LOCAL_PROJECT_CATALOG_VERIFY_FAILED');
  return reread.catalog;
};

/**
 * Registers the sealed singleton as the default project exactly once. It never
 * writes or removes the legacy workspace key and never touches IndexedDB.
 */
export const ensureLocalProjectCatalog = (
  storage?: LocalProjectStorage,
  nowIso = new Date().toISOString(),
): LocalProjectCatalogRegistrationResult => {
  const target = storageOrWindow(storage);
  const existing = readLocalProjectCatalog(target);
  if (existing.status === 'ready') return { status: 'ready', catalog: existing.catalog, registeredLegacy: false };
  if (existing.status === 'corrupt') return existing;
  try {
    requireCanonicalIso(nowIso);
    const legacy = readWorkspace(PROJECT_ID, target);
    if (legacy.status === 'corrupt') return { status: 'corrupt', code: `LOCAL_PROJECT_LEGACY_${legacy.code}` };
    const updatedAt = latestWorkspaceIso(legacy.status === 'missing' ? undefined : legacy.workspace, nowIso);
    const createdAt = updatedAt <= nowIso ? updatedAt : nowIso;
    const catalog: LocalProjectCatalogV1 = {
      schemaVersion: LOCAL_PROJECT_CATALOG_SCHEMA_VERSION,
      activeProjectId: PROJECT_ID,
      migration: {
        legacyProjectRegistered: true,
        legacyProjectId: PROJECT_ID,
        sourceStorageKey: STORAGE_KEY,
        registeredAt: nowIso,
      },
      projects: [{ id: PROJECT_ID, title: DEFAULT_LOCAL_PROJECT_TITLE, createdAt, updatedAt }],
    };
    return { status: 'ready', catalog: writeCatalog(target, catalog), registeredLegacy: true };
  } catch (error) {
    return { status: 'corrupt', code: error instanceof LocalProjectError ? error.code : 'LOCAL_PROJECT_CATALOG_REGISTRATION_FAILED' };
  }
};

const requireCatalog = (storage: LocalProjectStorage, nowIso: string): LocalProjectCatalogV1 => {
  const result = ensureLocalProjectCatalog(storage, nowIso);
  if (result.status !== 'ready') throw new LocalProjectError(result.code);
  return result.catalog;
};

const requireProject = (catalog: LocalProjectCatalogV1, projectId: string): LocalProjectRecord => {
  if (!isLocalProjectId(projectId)) throw new LocalProjectError('LOCAL_PROJECT_ID_INVALID');
  const project = catalog.projects.find((item) => item.id === projectId);
  if (!project) throw new LocalProjectError('LOCAL_PROJECT_NOT_FOUND');
  return project;
};

export const listLocalProjects = (
  catalog: LocalProjectCatalogV1,
  options: { includeTrashed?: boolean } = {},
): LocalProjectRecord[] => catalog.projects
  .filter((project) => options.includeTrashed || project.trashedAt === undefined)
  .map((project) => ({ ...project }))
  .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id, 'en'));

export const projectAgentRunStorageKey = (projectId: string): string => {
  if (!isLocalProjectId(projectId)) throw new LocalProjectError('LOCAL_PROJECT_ID_INVALID');
  return projectId === PROJECT_ID ? LEGACY_AGENT_RUN_STORAGE_KEY : `${PROJECT_AGENT_RUN_STORAGE_PREFIX}${projectId}`;
};

export interface LocalProjectMutationOptions {
  storage?: LocalProjectStorage;
  nowIso?: string;
}

export interface CreateLocalProjectOptions extends LocalProjectMutationOptions {
  title?: string;
  projectId?: string;
}

export const createLocalProject = (options: CreateLocalProjectOptions = {}): { catalog: LocalProjectCatalogV1; project: LocalProjectRecord } => {
  const storage = storageOrWindow(options.storage);
  const nowIso = requireCanonicalIso(options.nowIso ?? new Date().toISOString());
  const catalog = requireCatalog(storage, nowIso);
  const generatedId = options.projectId ?? `elyra-project-${globalThis.crypto?.randomUUID?.() ?? ''}`;
  if (!isLocalProjectId(generatedId) || generatedId === PROJECT_ID) throw new LocalProjectError('LOCAL_PROJECT_ID_INVALID');
  if (catalog.projects.some((project) => project.id === generatedId)) throw new LocalProjectError('LOCAL_PROJECT_ID_CONFLICT');
  const project: LocalProjectRecord = {
    id: generatedId,
    title: normalizeLocalProjectTitle(options.title ?? NEW_LOCAL_PROJECT_TITLE),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const blank = createBlankWorkspace();
  persistWorkspace(blank, storage, generatedId);
  try {
    const next = writeCatalog(storage, {
      ...catalog,
      activeProjectId: generatedId,
      projects: [...catalog.projects, project],
    });
    return { catalog: next, project: { ...project } };
  } catch (error) {
    try { storage.removeItem(workspaceStorageKey(generatedId)); } catch { /* unregistered blank rollback only */ }
    throw error;
  }
};

export const setActiveLocalProject = (
  projectId: string,
  options: LocalProjectMutationOptions = {},
): LocalProjectCatalogV1 => {
  const storage = storageOrWindow(options.storage);
  const nowIso = requireCanonicalIso(options.nowIso ?? new Date().toISOString());
  const catalog = requireCatalog(storage, nowIso);
  const project = requireProject(catalog, projectId);
  if (project.trashedAt !== undefined) throw new LocalProjectError('LOCAL_PROJECT_TRASHED');
  return writeCatalog(storage, {
    ...catalog,
    activeProjectId: projectId,
    projects: catalog.projects.map((item) => item.id === projectId ? { ...item, updatedAt: nowIso } : item),
  });
};

export const renameLocalProject = (
  projectId: string,
  title: string,
  options: LocalProjectMutationOptions = {},
): LocalProjectCatalogV1 => {
  const storage = storageOrWindow(options.storage);
  const nowIso = requireCanonicalIso(options.nowIso ?? new Date().toISOString());
  const catalog = requireCatalog(storage, nowIso);
  requireProject(catalog, projectId);
  const normalized = normalizeLocalProjectTitle(title);
  return writeCatalog(storage, {
    ...catalog,
    projects: catalog.projects.map((project) => project.id === projectId
      ? { ...project, title: normalized, updatedAt: nowIso }
      : project),
  });
};

export interface TrashLocalProjectOptions extends LocalProjectMutationOptions {
  confirmed: boolean;
  replacementProjectId?: string;
}

/** Recoverable trash only. No permanent purge function is intentionally exported. */
export const trashLocalProject = (
  projectId: string,
  options: TrashLocalProjectOptions,
): LocalProjectCatalogV1 => {
  if (options.confirmed !== true) throw new LocalProjectError('LOCAL_PROJECT_TRASH_CONFIRMATION_REQUIRED');
  const storage = storageOrWindow(options.storage);
  const nowIso = requireCanonicalIso(options.nowIso ?? new Date().toISOString());
  let catalog = requireCatalog(storage, nowIso);
  const target = requireProject(catalog, projectId);
  if (target.trashedAt !== undefined) return catalog;

  let replacementId = catalog.activeProjectId;
  let stagedReplacementId: string | undefined;
  if (catalog.activeProjectId === projectId) {
    const requested = options.replacementProjectId
      ? catalog.projects.find((project) => project.id === options.replacementProjectId && project.trashedAt === undefined && project.id !== projectId)
      : undefined;
    const existing = requested ?? listLocalProjects(catalog).find((project) => project.id !== projectId);
    if (existing) replacementId = existing.id;
    else {
      stagedReplacementId = `elyra-project-${globalThis.crypto?.randomUUID?.() ?? ''}`;
      if (!isLocalProjectId(stagedReplacementId)) throw new LocalProjectError('LOCAL_PROJECT_ID_INVALID');
      persistWorkspace(createBlankWorkspace(), storage, stagedReplacementId);
      const replacement: LocalProjectRecord = {
        id: stagedReplacementId,
        title: NEW_LOCAL_PROJECT_TITLE,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      catalog = { ...catalog, projects: [...catalog.projects, replacement] };
      replacementId = stagedReplacementId;
    }
  }

  try {
    return writeCatalog(storage, {
      ...catalog,
      activeProjectId: replacementId,
      projects: catalog.projects.map((project) => project.id === projectId
        ? { ...project, updatedAt: nowIso, trashedAt: nowIso }
        : project),
    });
  } catch (error) {
    if (stagedReplacementId) {
      try { storage.removeItem(workspaceStorageKey(stagedReplacementId)); } catch { /* unregistered blank rollback only */ }
    }
    throw error;
  }
};

export const restoreLocalProject = (
  projectId: string,
  options: LocalProjectMutationOptions & { activate?: boolean } = {},
): LocalProjectCatalogV1 => {
  const storage = storageOrWindow(options.storage);
  const nowIso = requireCanonicalIso(options.nowIso ?? new Date().toISOString());
  const catalog = requireCatalog(storage, nowIso);
  const target = requireProject(catalog, projectId);
  if (target.trashedAt === undefined) return catalog;
  return writeCatalog(storage, {
    ...catalog,
    activeProjectId: options.activate ? projectId : catalog.activeProjectId,
    projects: catalog.projects.map((project) => project.id === projectId
      ? { id: project.id, title: project.title, createdAt: project.createdAt, updatedAt: nowIso }
      : project),
  });
};

export const loadLocalProjectWorkspace = (
  projectId: string,
  storage?: LocalProjectStorage,
): Workspace => {
  const target = storageOrWindow(storage);
  const catalogResult = readLocalProjectCatalog(target);
  if (catalogResult.status !== 'ready') throw new LocalProjectError(
    catalogResult.status === 'missing' ? 'LOCAL_PROJECT_CATALOG_MISSING' : catalogResult.code,
  );
  const project = requireProject(catalogResult.catalog, projectId);
  if (project.trashedAt !== undefined) throw new LocalProjectError('LOCAL_PROJECT_TRASHED');
  return loadWorkspace(projectId, target);
};

export const saveLocalProjectWorkspace = (
  projectId: string,
  workspace: Workspace,
  options: LocalProjectMutationOptions = {},
): LocalProjectCatalogV1 => {
  const storage = storageOrWindow(options.storage);
  const nowIso = requireCanonicalIso(options.nowIso ?? new Date().toISOString());
  const catalog = requireCatalog(storage, nowIso);
  const project = requireProject(catalog, projectId);
  if (project.trashedAt !== undefined) throw new LocalProjectError('LOCAL_PROJECT_TRASHED');
  persistWorkspace(workspace, storage, projectId);
  return writeCatalog(storage, {
    ...catalog,
    projects: catalog.projects.map((item) => item.id === projectId ? { ...item, updatedAt: nowIso } : item),
  });
};
