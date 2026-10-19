import type { BlobStorageMetadata } from './blob-store';
import { parseBlobLocator } from './blob-store';
import type { CreationMode, ImageProviderId, Theme } from './domain';
import {
  createBlankWorkspace,
  isLocalProjectId,
  persistWorkspace,
  PROJECT_ID,
  workspaceStorageKey,
} from './domain';

export type PortalRoute = 'home' | 'community' | 'projects' | 'assets' | 'workspace';

export interface PortalProjectSummary {
  id: string;
  title: string;
  theme: Theme;
  objectCount: number;
  imageCount: number;
  videoCount: number;
  versionCount: number;
  updatedAt?: string;
  hasLocalContent: boolean;
}

export interface CommunityItem {
  id: string;
  title: string;
  category: '产品视觉' | '品牌海报' | '空间灵感';
  description: string;
  prompt: string;
  accent: string;
  localDemo: true;
}

const ROUTES = new Set<PortalRoute>(['home', 'community', 'projects', 'assets', 'workspace']);
const PORTAL_DRAFT_KEY = 'elyra-core-010-portal-draft-v1';
export const HOME_WORKSPACE_HANDOFF_KEY = 'elyra-core-011-home-workspace-handoff-v1';
export const HOME_WORKSPACE_HANDOFF_TTL_MS = 5 * 60 * 1_000;
export const HOME_WORKSPACE_HANDOFF_SCHEMA_VERSION = 1 as const;
const MAX_DRAFT_LENGTH = 4_000;
const DEFAULT_PROJECT_TITLE = '便携式无线音箱视觉创作';

const HOME_HANDOFF_SOURCES = new Set<HomeWorkspaceHandoffSource>(['home-composer', 'inspiration-preset', 'recent-project']);
const CREATION_MODES = new Set<CreationMode>(['agent', 'image', 'video']);
const IMAGE_PROVIDER_IDS = new Set<ImageProviderId>(['deterministic-mock', 'evolink-gpt-image-2']);
const VIDEO_PROVIDER_ID = 'evolink-sora-2-preview' as const;
const HANDOFF_ACTION = 'prefill' as const;
const MAX_HANDOFF_ID_LENGTH = 128;
const MAX_PRESET_VALUE_LENGTH = 128;
const MAX_ASSET_ID_LENGTH = 160;
const MAX_BLOB_KEY_LENGTH = 180;
const MAX_STAGED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_STAGED_IMAGE_EDGE = 8_192;
const MAX_STAGED_IMAGE_PIXELS = 25_000_000;

export type HomeWorkspaceHandoffSource = 'home-composer' | 'inspiration-preset' | 'recent-project';

export interface HomeWorkspacePresetV1 {
  id: string;
  category: string;
}

export interface HomeWorkspaceStagedReferenceV1 {
  assetId: string;
  width: number;
  height: number;
  storage: BlobStorageMetadata;
}

/**
 * The only schema allowed across the CORE-011 Home -> Workspace boundary.
 * It contains metadata only: image bytes remain in the current project's
 * IndexedDB Blob store and are reverified by Workspace before publication.
 */
export interface HomeWorkspaceHandoffV1 {
  schemaVersion: typeof HOME_WORKSPACE_HANDOFF_SCHEMA_VERSION;
  handoffId: string;
  projectId: string;
  source: HomeWorkspaceHandoffSource;
  action: typeof HANDOFF_ACTION;
  prompt: string;
  creationMode: CreationMode;
  imageProviderId: ImageProviderId;
  videoProviderId: typeof VIDEO_PROVIDER_ID;
  preset?: HomeWorkspacePresetV1;
  stagedReference?: HomeWorkspaceStagedReferenceV1;
  /** A Home send is explicit permission to prefill, never to submit. */
  explicitSend: true;
  createdAt: string;
  expiresAt: string;
}

export type NewHomeWorkspaceHandoffV1 = Pick<
  HomeWorkspaceHandoffV1,
  'source' | 'prompt' | 'creationMode' | 'imageProviderId'
> & Partial<Pick<HomeWorkspaceHandoffV1, 'handoffId' | 'projectId' | 'preset' | 'stagedReference'>>;

const consumedHomeHandoffIds = new Set<string>();

export const COMMUNITY_ITEMS: readonly CommunityItem[] = Object.freeze([
  {
    id: 'local-demo-product-studio',
    title: '静物产品棚拍',
    category: '产品视觉',
    description: '用克制光影突出材质、轮廓与产品细节。',
    prompt: '为产品创建一张高级静物棚拍主视觉，保持主体轮廓，使用柔和侧光、深灰背景与克制的青柠色点缀。',
    accent: '#b8ff00',
    localDemo: true,
  },
  {
    id: 'local-demo-editorial-poster',
    title: '现代编辑海报',
    category: '品牌海报',
    description: '清晰层级、大留白与具有设计感的视觉焦点。',
    prompt: '创建一张现代编辑风品牌海报，以产品为唯一视觉焦点，使用大留白、清晰网格和高对比黑白排版。',
    accent: '#ff8fa3',
    localDemo: true,
  },
  {
    id: 'local-demo-architectural-light',
    title: '建筑光影场景',
    category: '空间灵感',
    description: '借助几何空间和自然光建立高级氛围。',
    prompt: '将产品置于极简建筑空间中，加入几何阴影与自然天光，画面安静、精致，并保留产品真实比例。',
    accent: '#8ea7ff',
    localDemo: true,
  },
] satisfies readonly CommunityItem[]);

/** Only exact, allowlisted hash routes are accepted. Unknown input returns Home. */
export const parsePortalRoute = (hash: string): PortalRoute => {
  const normalized = hash.trim().replace(/^#\/?/, '').replace(/\/$/, '');
  return ROUTES.has(normalized as PortalRoute) ? normalized as PortalRoute : 'home';
};

export const writePortalRoute = (route: PortalRoute): void => {
  if (typeof window === 'undefined') return;
  const safeRoute = ROUTES.has(route) ? route : 'home';
  window.location.hash = `#/${safeRoute}`;
};

type PersistedPortalWorkspace = {
  schemaVersion?: unknown;
  projectId?: unknown;
  theme?: unknown;
  nodes?: unknown;
  assets?: unknown;
  versions?: unknown;
  jobs?: unknown;
};

type PortalStorageReader = Pick<Storage, 'getItem'>;
type PortalStorageWriter = Pick<Storage, 'getItem' | 'setItem'>;

const readWorkspaceRecord = (
  projectId: string,
  storage?: PortalStorageReader,
): PersistedPortalWorkspace | undefined => {
  if (!isLocalProjectId(projectId) || (!storage && typeof window === 'undefined')) return undefined;
  try {
    const target = storage ?? window.localStorage;
    const raw = target.getItem(workspaceStorageKey(projectId));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as PersistedPortalWorkspace;
    return record.projectId === projectId ? record : undefined;
  } catch {
    return undefined;
  }
};

const safeList = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
  : [];

const latestIso = (...groups: readonly (readonly Record<string, unknown>[])[]): string | undefined => {
  let latest: string | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const record of groups.flat()) {
    for (const key of ['updatedAt', 'createdAt'] as const) {
      const value = record[key];
      if (typeof value !== 'string') continue;
      const time = Date.parse(value);
      if (Number.isFinite(time) && time > latestTime) {
        latest = new Date(time).toISOString();
        latestTime = time;
      }
    }
  }
  return latest;
};

/**
 * Returns a read-only, privacy-safe summary of one catalog-bound local project.
 * It never hydrates Blobs and never exposes prompts, messages or Provider URLs.
 */
export const getPortalProjectSummary = (
  projectId = PROJECT_ID,
  title = DEFAULT_PROJECT_TITLE,
  storage?: PortalStorageReader,
): PortalProjectSummary => {
  if (!isLocalProjectId(projectId)) throw new Error('PORTAL_PROJECT_ID_INVALID');
  const safeProjectId = projectId;
  const safeTitle = typeof title === 'string' && title.trim().length > 0 && title.length <= 80
    ? title.trim().replace(/\s+/g, ' ')
    : safeProjectId === PROJECT_ID ? DEFAULT_PROJECT_TITLE : '未命名项目';
  const record = readWorkspaceRecord(safeProjectId, storage);
  const nodes = safeList(record?.nodes);
  const assets = safeList(record?.assets);
  const versions = safeList(record?.versions);
  const jobs = safeList(record?.jobs);
  const imageCount = assets.filter((asset) => asset.kind === 'image').length;
  const videoCount = assets.filter((asset) => asset.kind === 'video').length;

  return {
    id: safeProjectId,
    title: safeTitle,
    theme: record?.theme === 'light' ? 'light' : 'dark',
    objectCount: nodes.length,
    imageCount,
    videoCount,
    versionCount: versions.length,
    updatedAt: latestIso(nodes, assets, versions, jobs),
    hasLocalContent: nodes.length > 0 || assets.length > 0 || versions.length > 0,
  };
};

export const getPortalProjectSummaries = (
  projects: readonly { id: string; title: string }[],
  storage?: PortalStorageReader,
): PortalProjectSummary[] => projects
  .filter((project) => isLocalProjectId(project.id))
  .map((project) => getPortalProjectSummary(project.id, project.title, storage));

/**
 * Reuses the existing allowlisted Workspace record instead of creating a
 * second theme preference. Invalid/corrupt records fail closed and are not
 * overwritten from the frontstage.
 */
export const setPortalTheme = (
  theme: Theme,
  projectId = PROJECT_ID,
  storage?: PortalStorageWriter,
): boolean => {
  if ((!storage && typeof window === 'undefined') || !isLocalProjectId(projectId) || (theme !== 'light' && theme !== 'dark')) return false;
  try {
    const target = storage ?? window.localStorage;
    const storageKey = workspaceStorageKey(projectId);
    const raw = target.getItem(storageKey);
    if (!raw) {
      const workspace = createBlankWorkspace();
      workspace.theme = theme;
      persistWorkspace(workspace, target, projectId);
      return true;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const workspace = parsed as PersistedPortalWorkspace;
    if (workspace.projectId !== projectId || !Array.isArray(workspace.nodes)) return false;
    target.setItem(storageKey, JSON.stringify({ ...workspace, theme }));
    return true;
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
};

const validCanonicalIso = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const validBoundedText = (value: unknown, maxLength: number) => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
);

const isHomeWorkspacePresetV1 = (value: unknown): value is HomeWorkspacePresetV1 => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'category'])) return false;
  return validBoundedText(value.id, MAX_PRESET_VALUE_LENGTH)
    && validBoundedText(value.category, MAX_PRESET_VALUE_LENGTH)
    && COMMUNITY_ITEMS.some((item) => item.id === value.id && item.category === value.category);
};

const isHomeWorkspaceStagedReferenceV1 = (
  value: unknown,
  expectedProjectId: string,
): value is HomeWorkspaceStagedReferenceV1 => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['assetId', 'width', 'height', 'storage'])) return false;
  if (
    !validBoundedText(value.assetId, MAX_ASSET_ID_LENGTH)
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(value.assetId as string)
    || !Number.isInteger(value.width)
    || !Number.isInteger(value.height)
    || (value.width as number) <= 0
    || (value.height as number) <= 0
    || (value.width as number) > MAX_STAGED_IMAGE_EDGE
    || (value.height as number) > MAX_STAGED_IMAGE_EDGE
    || (value.width as number) * (value.height as number) > MAX_STAGED_IMAGE_PIXELS
    || !isRecord(value.storage)
    || !hasOnlyKeys(value.storage, ['locator', 'projectId', 'blobKey', 'sha256', 'bytes', 'mimeType', 'createdAt'])
  ) return false;

  const storage = value.storage;
  if (
    storage.projectId !== expectedProjectId
    || !validBoundedText(storage.blobKey, MAX_BLOB_KEY_LENGTH)
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(storage.blobKey as string)
    || typeof storage.locator !== 'string'
    || typeof storage.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(storage.sha256)
    || !Number.isInteger(storage.bytes)
    || (storage.bytes as number) <= 0
    || (storage.bytes as number) > MAX_STAGED_IMAGE_BYTES
    || storage.mimeType !== 'image/png'
    || !validCanonicalIso(storage.createdAt)
  ) return false;

  try {
    const parsed = parseBlobLocator(storage.locator);
    return parsed.projectId === expectedProjectId && parsed.blobKey === storage.blobKey;
  } catch {
    return false;
  }
};

/** Structural validator. Exact object keys and every enum are allowlisted. */
export const isHomeWorkspaceHandoffV1 = (
  value: unknown,
  expectedProjectId?: string,
): value is HomeWorkspaceHandoffV1 => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion',
    'handoffId',
    'projectId',
    'source',
    'action',
    'prompt',
    'creationMode',
    'imageProviderId',
    'videoProviderId',
    'explicitSend',
    'createdAt',
    'expiresAt',
  ], ['preset', 'stagedReference'])) return false;

  if (
    value.schemaVersion !== HOME_WORKSPACE_HANDOFF_SCHEMA_VERSION
    || !validBoundedText(value.handoffId, MAX_HANDOFF_ID_LENGTH)
    || !/^[a-z0-9][a-z0-9_-]*$/i.test(value.handoffId as string)
    || !isLocalProjectId(value.projectId)
    || (expectedProjectId !== undefined && (!isLocalProjectId(expectedProjectId) || value.projectId !== expectedProjectId))
    || !HOME_HANDOFF_SOURCES.has(value.source as HomeWorkspaceHandoffSource)
    || value.action !== HANDOFF_ACTION
    || typeof value.prompt !== 'string'
    || value.prompt.trim().length === 0
    || value.prompt.length > MAX_DRAFT_LENGTH
    || !CREATION_MODES.has(value.creationMode as CreationMode)
    || !IMAGE_PROVIDER_IDS.has(value.imageProviderId as ImageProviderId)
    || value.videoProviderId !== VIDEO_PROVIDER_ID
    || value.explicitSend !== true
    || !validCanonicalIso(value.createdAt)
    || !validCanonicalIso(value.expiresAt)
    || (value.preset !== undefined && !isHomeWorkspacePresetV1(value.preset))
    || (value.stagedReference !== undefined && !isHomeWorkspaceStagedReferenceV1(value.stagedReference, value.projectId as string))
  ) return false;

  const createdAt = Date.parse(value.createdAt as string);
  const expiresAt = Date.parse(value.expiresAt as string);
  if (expiresAt <= createdAt || expiresAt - createdAt > HOME_WORKSPACE_HANDOFF_TTL_MS) return false;
  if (value.stagedReference && Date.parse(value.stagedReference.storage.createdAt) > createdAt) return false;
  return true;
};

const isNewHomeWorkspaceHandoffV1 = (
  value: unknown,
  expectedProjectId: string,
): value is NewHomeWorkspaceHandoffV1 => {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ['source', 'prompt', 'creationMode', 'imageProviderId'],
    ['handoffId', 'projectId', 'preset', 'stagedReference'],
  )) return false;
  return HOME_HANDOFF_SOURCES.has(value.source as HomeWorkspaceHandoffSource)
    && isLocalProjectId(expectedProjectId)
    && (value.projectId === undefined || value.projectId === expectedProjectId)
    && typeof value.prompt === 'string'
    && value.prompt.trim().length > 0
    && value.prompt.length <= MAX_DRAFT_LENGTH
    && CREATION_MODES.has(value.creationMode as CreationMode)
    && IMAGE_PROVIDER_IDS.has(value.imageProviderId as ImageProviderId)
    && (value.handoffId === undefined || (
      typeof value.handoffId === 'string'
      && validBoundedText(value.handoffId, MAX_HANDOFF_ID_LENGTH)
      && /^[a-z0-9][a-z0-9_-]*$/i.test(value.handoffId)
    ))
    && (value.preset === undefined || isHomeWorkspacePresetV1(value.preset))
    && (value.stagedReference === undefined || isHomeWorkspaceStagedReferenceV1(value.stagedReference, expectedProjectId));
};

export const createHomeWorkspaceHandoff = (
  input: NewHomeWorkspaceHandoffV1,
  nowMs = Date.now(),
  expectedProjectId = input.projectId ?? PROJECT_ID,
): HomeWorkspaceHandoffV1 | undefined => {
  if (!isNewHomeWorkspaceHandoffV1(input, expectedProjectId) || !Number.isFinite(nowMs)) return undefined;
  const handoffId = input.handoffId ?? globalThis.crypto?.randomUUID?.();
  if (!handoffId) return undefined;
  const createdAt = new Date(nowMs).toISOString();
  const handoff: HomeWorkspaceHandoffV1 = {
    schemaVersion: HOME_WORKSPACE_HANDOFF_SCHEMA_VERSION,
    handoffId,
    projectId: expectedProjectId,
    source: input.source,
    action: HANDOFF_ACTION,
    prompt: input.prompt,
    creationMode: input.creationMode,
    imageProviderId: input.imageProviderId,
    videoProviderId: VIDEO_PROVIDER_ID,
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.stagedReference ? { stagedReference: input.stagedReference } : {}),
    explicitSend: true,
    createdAt,
    expiresAt: new Date(nowMs + HOME_WORKSPACE_HANDOFF_TTL_MS).toISOString(),
  };
  return isHomeWorkspaceHandoffV1(handoff, expectedProjectId) ? handoff : undefined;
};

/** Writes only the strict V1 JSON record; image bytes never enter sessionStorage. */
export const saveHomeWorkspaceHandoff = (
  input: NewHomeWorkspaceHandoffV1 | HomeWorkspaceHandoffV1,
  nowMs = Date.now(),
  expectedProjectId = input.projectId ?? PROJECT_ID,
): boolean => {
  if (typeof window === 'undefined' || !Number.isFinite(nowMs) || !isLocalProjectId(expectedProjectId)) return false;
  const handoff = isHomeWorkspaceHandoffV1(input, expectedProjectId)
    ? input
    : createHomeWorkspaceHandoff(input, nowMs, expectedProjectId);
  if (!handoff) return false;
  const createdAt = Date.parse(handoff.createdAt);
  const expiresAt = Date.parse(handoff.expiresAt);
  if (createdAt > nowMs || expiresAt <= nowMs) return false;
  try {
    window.sessionStorage.setItem(HOME_WORKSPACE_HANDOFF_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
};

const clearStoredHomeWorkspaceHandoff = (expectedHandoffId?: string): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    if (expectedHandoffId) {
      const raw = window.sessionStorage.getItem(HOME_WORKSPACE_HANDOFF_KEY);
      if (!raw) return true;
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.handoffId !== expectedHandoffId) return false;
    }
    window.sessionStorage.removeItem(HOME_WORKSPACE_HANDOFF_KEY);
    return true;
  } catch {
    return false;
  }
};

export const clearHomeWorkspaceHandoff = (): void => {
  clearStoredHomeWorkspaceHandoff();
};

/** Render-safe repeatable read. Invalid, expired and already consumed records fail closed. */
export const peekHomeWorkspaceHandoff = (
  nowMs = Date.now(),
  expectedProjectId = PROJECT_ID,
): HomeWorkspaceHandoffV1 | undefined => {
  if (typeof window === 'undefined' || !Number.isFinite(nowMs) || !isLocalProjectId(expectedProjectId)) return undefined;
  try {
    const raw = window.sessionStorage.getItem(HOME_WORKSPACE_HANDOFF_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isHomeWorkspaceHandoffV1(parsed)) {
      clearStoredHomeWorkspaceHandoff();
      return undefined;
    }
    // A valid handoff owned by another project is not corrupt. Leave it intact
    // and fail closed so a project switch cannot consume or erase its intent.
    if (parsed.projectId !== expectedProjectId) return undefined;
    if (
      consumedHomeHandoffIds.has(parsed.handoffId)
      || Date.parse(parsed.createdAt) > nowMs
      || Date.parse(parsed.expiresAt) <= nowMs
    ) {
      clearStoredHomeWorkspaceHandoff(parsed.handoffId);
      return undefined;
    }
    return parsed;
  } catch {
    clearStoredHomeWorkspaceHandoff();
    return undefined;
  }
};

/**
 * Atomically removes and returns one exact handoff. Repeated StrictMode effects,
 * refreshes and Back/Forward mounts cannot consume the same id twice.
 */
export const consumeHomeWorkspaceHandoff = (
  expectedHandoffId?: string,
  nowMs = Date.now(),
  expectedProjectId = PROJECT_ID,
): HomeWorkspaceHandoffV1 | undefined => {
  const handoff = peekHomeWorkspaceHandoff(nowMs, expectedProjectId);
  if (!handoff || (expectedHandoffId && handoff.handoffId !== expectedHandoffId)) return undefined;
  if (!clearStoredHomeWorkspaceHandoff(handoff.handoffId)) return undefined;
  consumedHomeHandoffIds.add(handoff.handoffId);
  return handoff;
};

/** Session-only handoff: the prompt is consumed once and is never auto-sent. */
export const savePortalDraft = (text: string): boolean => {
  if (typeof window === 'undefined') return false;
  const draft = text.trim().slice(0, MAX_DRAFT_LENGTH);
  if (!draft) return false;
  try {
    window.sessionStorage.setItem(PORTAL_DRAFT_KEY, draft);
    return true;
  } catch {
    return false;
  }
};

/** Pure render-safe read. Consumption happens only after Workspace commits. */
export const peekPortalDraft = (): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    const draft = window.sessionStorage.getItem(PORTAL_DRAFT_KEY);
    if (!draft) return undefined;
    const normalized = draft.trim().slice(0, MAX_DRAFT_LENGTH);
    return normalized || undefined;
  } catch {
    return undefined;
  }
};

export const clearPortalDraft = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(PORTAL_DRAFT_KEY);
  } catch {
    // A blocked sessionStorage is already represented by an absent draft.
  }
};

export const consumePortalDraft = (): string | undefined => {
  const draft = peekPortalDraft();
  clearPortalDraft();
  return draft;
};
