import type { AgentPlan, Asset, GenerationJob, ProviderOutputSlot, UserIntent, VersionRecord } from './agent';
import type { PlannerEvidence } from './planner';
import { persistWorkflowData, validateWorkflowGraph, type WorkflowData } from './workflow-graph';

export type ImageProviderId = 'deterministic-mock' | 'evolink-gpt-image-2';
export type CreationMode = 'agent' | 'image' | 'video';

export type Theme = 'light' | 'dark';
export type NodeStatus = 'ready' | 'generating' | 'failed' | 'user_cancelled';
export type NodeKind = 'reference' | 'generated' | 'workflow';

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: NodeStatus;
  parentId?: string;
  version: number;
  prompt: string;
  createdAt: string;
  /** A ready generated object points at the immutable asset created by its job. */
  assetId?: string;
  jobId?: string;
  versionId?: string;
  workflow?: WorkflowData;
  workflowOriginId?: string;
}

export interface Message {
  id: string;
  role: 'agent' | 'user' | 'system';
  body: string;
  time: string;
  auditCode?: WorkspaceAuditCode;
}

export type WorkspaceAuditCode =
  | 'CORE007_SOFT_CANCELLED'
  | 'CORE007_DELETE_SOFT_CANCELLED'
  | 'CORE007_DELETE_BLOCKED_LINEAGE'
  | 'CORE007_DELETE_STORAGE_FAILED';

export interface Workspace {
  theme: Theme;
  creationMode: CreationMode;
  imageProviderId: ImageProviderId;
  viewport: { x: number; y: number; scale: number };
  nodes: CanvasNode[];
  selectedIds: string[];
  messages: Message[];
  /** Persisted local domain records. They are intentionally independent from UI state. */
  intents: UserIntent[];
  plans: AgentPlan[];
  pendingPlanId?: string;
  plannerEvidence: PlannerEvidence[];
  jobs: GenerationJob[];
  assets: Asset[];
  versions: VersionRecord[];
  referenceTransferConsent?: { version: 'CORE-007-DATA-BOUNDARY-V1'; acceptedAt: string };
}

export const STORAGE_KEY = 'elyra-core-001-workspace-v1';
export const PROJECT_ID = 'elyra-local-project-v1';
export const PROJECT_WORKSPACE_STORAGE_PREFIX = 'elyra-core-012-workspace-v1:';
export const GENERATED_ASSET = '/assets/elyra-speaker.png';
/** Dimensions of the bundled fixed demo; checked against decoded browser output. */
export const GENERATED_ASSET_DIMENSIONS = { width: 1254, height: 1254 } as const;
export const REFERENCE_TRANSFER_CONSENT_VERSION = 'CORE-007-DATA-BOUNDARY-V1' as const;
export const PERSISTED_WORKSPACE_SCHEMA_VERSION = 3 as const;
const LEGACY_ALLOWLISTED_WORKSPACE_SCHEMA_VERSION = 2 as const;

const REDACTED_PROMPT = '[已脱敏本地记录]';
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const AUDIT_MESSAGES: Readonly<Record<WorkspaceAuditCode, string>> = {
  CORE007_SOFT_CANCELLED: '已执行软取消：仅停止本地等待并忽略迟到结果；不代表远端任务已取消、退款或提前删除。',
  CORE007_DELETE_SOFT_CANCELLED: '删除生成中对象前已执行软取消；Job 审计记录仍保留。',
  CORE007_DELETE_BLOCKED_LINEAGE: '该对象仍有子版本。请先保留版本谱系，父节点未被删除。',
  CORE007_DELETE_STORAGE_FAILED: '本地 Blob 清理失败，对象未被删除。',
};
const isProviderOutputSlot = (value: unknown): value is ProviderOutputSlot => (
  value === 'left45' || value === 'front' || value === 'right45'
);

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const isLocalProjectId = (value: unknown): value is string => (
  typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
);

/**
 * CORE-012 keeps the sealed single-project key byte-for-byte for the legacy
 * project. Only newly created projects receive a namespaced key, so migration
 * registers the existing record instead of copying or rewriting it.
 */
export const workspaceStorageKey = (projectId: string): string => {
  if (!isLocalProjectId(projectId)) throw new Error('WORKSPACE_INVALID_PROJECT_ID');
  return projectId === PROJECT_ID
    ? STORAGE_KEY
    : `${PROJECT_WORKSPACE_STORAGE_PREFIX}${projectId}`;
};

/**
 * Canvas layer order is semantic but must not depend on incidental array
 * ordering in restored JSON. Earlier creation times render first (behind),
 * with the stable object ID as the deterministic tie-breaker.
 */
export const orderCanvasNodesByLayer = (nodes: readonly CanvasNode[]): CanvasNode[] => [...nodes].sort((left, right) => {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id, 'en');
});

export const nowLabel = () =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

export const createBlankWorkspace = (): Workspace => ({
  theme: 'light',
  creationMode: 'agent',
  imageProviderId: 'deterministic-mock',
  viewport: { x: 0, y: 0, scale: 1 },
  nodes: [],
  selectedIds: [],
  intents: [],
  plans: [],
  plannerEvidence: [],
  jobs: [],
  assets: [],
  versions: [],
  messages: [
    {
      id: 'welcome',
      role: 'agent',
      body: '我是 ELYRA。告诉我你的设计想法，或选中画布上的对象继续修改。你也可以让我排列对象、移动选区，或调整尺寸。',
      time: nowLabel(),
    },
  ],
});

type PersistedWorkspace = ReturnType<typeof workspacePersistenceRecord>;
type PersistedWorkspaceV2 = Omit<PersistedWorkspace, 'schemaVersion' | 'creationMode'> & {
  schemaVersion: typeof LEGACY_ALLOWLISTED_WORKSPACE_SCHEMA_VERSION;
};

type PersistableAssetShape = Omit<Asset, 'kind' | 'mimeType' | 'metadata'> & {
  kind: 'image' | 'video';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
  metadata: {
    deterministic: boolean;
    width: number;
    height: number;
    durationSeconds?: number;
    outputSlot?: Asset['metadata']['outputSlot'];
  };
};

const persistAsset = (asset: Asset) => {
  const mediaAsset = asset as unknown as PersistableAssetShape;
  return {
    id: mediaAsset.id,
    kind: mediaAsset.kind === 'video' ? 'video' as const : 'image' as const,
    source: mediaAsset.source,
    providerId: mediaAsset.providerId,
    ...(mediaAsset.jobId ? { jobId: mediaAsset.jobId } : {}),
    ...(mediaAsset.kind === 'image' && mediaAsset.uri === GENERATED_ASSET ? { localAssetUri: GENERATED_ASSET } : {}),
    ...(mediaAsset.storage ? { storage: {
      locator: mediaAsset.storage.locator,
      projectId: mediaAsset.storage.projectId,
      blobKey: mediaAsset.storage.blobKey,
      sha256: mediaAsset.storage.sha256,
      bytes: mediaAsset.storage.bytes,
      mimeType: mediaAsset.storage.mimeType,
      createdAt: mediaAsset.storage.createdAt,
    } } : {}),
    mimeType: mediaAsset.mimeType,
    createdAt: mediaAsset.createdAt,
    metadata: {
      deterministic: Boolean(mediaAsset.metadata.deterministic),
      width: mediaAsset.metadata.width,
      height: mediaAsset.metadata.height,
      ...(mediaAsset.kind === 'video' ? { durationSeconds: mediaAsset.metadata.durationSeconds } : {}),
      ...(mediaAsset.kind === 'image' && isProviderOutputSlot(mediaAsset.metadata.outputSlot)
        ? { outputSlot: mediaAsset.metadata.outputSlot }
        : {}),
    },
  };
};

const expectedBlobLocator = (projectId: string, blobKey: string) => (
  `indexeddb://elyra-assets/${encodeURIComponent(projectId)}/${encodeURIComponent(blobKey)}`
);

/**
 * Every persisted Blob locator is owned by exactly one project. Rejecting a
 * mixed record here prevents a corrupt project from hydrating or deleting
 * bytes that belong to another local project.
 */
export const workspaceMatchesProjectBoundary = (workspace: Pick<Workspace, 'assets'>, projectId: string): boolean => {
  if (!isLocalProjectId(projectId)) return false;
  return workspace.assets.every((asset) => {
    if (!asset.storage) return true;
    const { storage } = asset;
    return storage.projectId === projectId
      && storage.locator === expectedBlobLocator(projectId, storage.blobKey);
  });
};

/**
 * Explicit persistence allowlist. Blob/data/provider URLs, file names/paths,
 * raw prompts, chat messages, and complete Planner evidence have no route into
 * this object. Domain IDs and redacted relations remain available so CORE-003
 * Intent -> Plan -> Job -> Asset -> Canvas Object -> Version can be restored.
 */
export const workspacePersistenceRecord = (workspace: Workspace, projectId = PROJECT_ID) => {
  if (!workspaceMatchesProjectBoundary(workspace, projectId)) throw new Error('WORKSPACE_PROJECT_BOUNDARY_MISMATCH');
  return ({
  schemaVersion: PERSISTED_WORKSPACE_SCHEMA_VERSION,
  projectId,
  theme: workspace.theme === 'light' ? 'light' as const : 'dark' as const,
  creationMode: isCreationMode(workspace.creationMode) ? workspace.creationMode : 'agent' as const,
  imageProviderId: workspace.imageProviderId === 'evolink-gpt-image-2' ? 'evolink-gpt-image-2' as const : 'deterministic-mock' as const,
  viewport: {
    x: Number.isFinite(workspace.viewport.x) ? workspace.viewport.x : 0,
    y: Number.isFinite(workspace.viewport.y) ? workspace.viewport.y : 0,
    scale: Number.isFinite(workspace.viewport.scale) ? clampScale(workspace.viewport.scale) : 1,
  },
  nodes: workspace.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    name: node.kind === 'workflow' ? node.name : node.kind === 'reference' ? '本地参考图' : `v${node.version} · 生成版本`,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    status: node.status,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    version: node.version,
    createdAt: node.createdAt,
    ...(node.assetId ? { assetId: node.assetId } : {}),
    ...(node.jobId ? { jobId: node.jobId } : {}),
    ...(node.versionId ? { versionId: node.versionId } : {}),
    ...(node.workflow ? { workflow: persistWorkflowData(node.workflow) } : {}),
    ...(node.workflowOriginId ? { workflowOriginId: node.workflowOriginId } : {}),
  })),
  selectedIds: workspace.selectedIds.filter((id) => workspace.nodes.some((node) => node.id === id)),
  auditMessages: workspace.messages.flatMap((message) => message.auditCode && AUDIT_MESSAGES[message.auditCode]
    ? [{ id: message.id, role: 'system' as const, auditCode: message.auditCode, time: message.time }]
    : []),
  intents: workspace.intents.map((intent) => ({
    id: intent.id,
    kind: intent.kind,
    operation: intent.operation,
    source: intent.source,
    ...(intent.targetCanvasObjectId ? { targetCanvasObjectId: intent.targetCanvasObjectId } : {}),
    createdAt: intent.createdAt,
  })),
  plans: workspace.plans.map((plan) => ({
    id: plan.id,
    intentId: plan.intentId,
    providerId: plan.providerId,
    status: plan.status,
    operation: plan.operation,
    source: plan.source,
    ...(plan.plannerModel ? { plannerModel: plan.plannerModel } : {}),
    shouldFail: Boolean(plan.shouldFail),
    createdAt: plan.createdAt,
  })),
  jobs: workspace.jobs.map((job) => ({
    id: job.id,
    intentId: job.intentId,
    planId: job.planId,
    providerId: job.providerId,
    operation: job.operation,
    ...(job.targetCanvasObjectId ? { targetCanvasObjectId: job.targetCanvasObjectId } : {}),
    status: job.status,
    ...(Number.isFinite(job.progress) ? { progress: job.progress } : {}),
    attempt: job.attempt,
    ...(job.error ? { error: {
      code: job.error.code,
      retryable: Boolean(job.error.retryable),
      ...(job.error.retryScope ? { retryScope: job.error.retryScope } : {}),
    } } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  })),
  assets: workspace.assets.map(persistAsset),
  versions: workspace.versions.map((version) => ({
    id: version.id,
    canvasObjectId: version.canvasObjectId,
    ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}),
    ...(version.parentCanvasObjectId ? { parentCanvasObjectId: version.parentCanvasObjectId } : {}),
    ...(version.jobId ? { jobId: version.jobId } : {}),
    sequence: version.sequence,
    status: version.status,
    createdAt: version.createdAt,
  })),
  ...(workspace.referenceTransferConsent?.version === REFERENCE_TRANSFER_CONSENT_VERSION ? {
    referenceTransferConsent: {
      version: REFERENCE_TRANSFER_CONSENT_VERSION,
      acceptedAt: workspace.referenceTransferConsent.acceptedAt,
    },
  } : {}),
  });
};

export const serializeWorkspace = (workspace: Workspace, projectId = PROJECT_ID) => (
  JSON.stringify(workspacePersistenceRecord(workspace, projectId))
);

export const persistWorkspace = (
  workspace: Workspace,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
  projectId = PROJECT_ID,
) => storage.setItem(workspaceStorageKey(projectId), serializeWorkspace(workspace, projectId));

export type WorkspaceReadResult =
  | { status: 'missing'; projectId: string; storageKey: string }
  | { status: 'ready' | 'migrated'; projectId: string; storageKey: string; workspace: Workspace }
  | { status: 'corrupt'; projectId: string; storageKey?: string; code: string };

export class WorkspacePersistenceError extends Error {
  constructor(readonly code: string, readonly projectId: string) {
    super(code);
    this.name = 'WorkspacePersistenceError';
  }
}

const persistedCollectionsArePresent = (value: Record<string, unknown>): boolean => (
  ['nodes', 'selectedIds', 'intents', 'plans', 'jobs', 'assets', 'versions']
    .every((key) => Array.isArray(value[key]))
  && (!Object.hasOwn(value, 'auditMessages') || Array.isArray(value.auditMessages))
);

const persistedAssetsMatchProject = (assets: unknown, projectId: string): boolean => (
  Array.isArray(assets) && assets.every((asset) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
    const storage = (asset as { storage?: unknown }).storage;
    if (storage === undefined) return true;
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return false;
    const record = storage as { projectId?: unknown; blobKey?: unknown; locator?: unknown };
    return record.projectId === projectId
      && typeof record.blobKey === 'string'
      && record.locator === expectedBlobLocator(projectId, record.blobKey);
  })
);

const migrateLegacyWorkspace = (legacy: Workspace): Workspace => {
  // Legacy records may contain raw prompts/messages/provider URLs. Migrate
  // only their graph relations into memory; the next persist overwrites them
  // with the current allowlist rather than propagating legacy sensitive fields.
  const safeLegacy = {
    ...legacy,
    messages: [],
    plannerEvidence: [],
    pendingPlanId: undefined,
    nodes: legacy.nodes.map((node) => ({ ...node, prompt: REDACTED_PROMPT })),
    intents: Array.isArray(legacy.intents) ? legacy.intents.map((intent) => ({ ...intent, prompt: REDACTED_PROMPT, normalizedPrompt: REDACTED_PROMPT, goal: REDACTED_PROMPT, constraints: ['已脱敏约束'] })) : [],
    plans: Array.isArray(legacy.plans) ? legacy.plans.map((plan) => ({ ...plan, summary: '已脱敏 Agent Plan', bullets: ['已脱敏执行步骤'], constraints: ['已脱敏约束'], visualDirection: redactedVisualDirection() })) : [],
    jobs: Array.isArray(legacy.jobs) ? legacy.jobs.map((job) => ({ ...job, error: job.error ? { code: job.error.code, message: '已脱敏任务错误', retryable: job.error.retryable } : undefined })) : [],
    assets: Array.isArray(legacy.assets) ? legacy.assets.map((asset) => ({ ...asset, prompt: REDACTED_PROMPT, uri: asset.uri === GENERATED_ASSET ? GENERATED_ASSET : undefined })) : [],
  } satisfies Workspace;
  const intents = safeLegacy.intents.map(migrateIntent);
  const intentsById = new Map(intents.map((intent) => [intent.id, intent]));
  const plans = safeLegacy.plans.map((plan) => migratePlan(plan, intentsById.get(plan.intentId)));
  return reconcileRestoredInFlightJobs(ensureFixedDemoLineage({
    theme: safeLegacy.theme === 'light' ? 'light' : 'dark',
    creationMode: isCreationMode(safeLegacy.creationMode) ? safeLegacy.creationMode : 'agent',
    imageProviderId: safeLegacy.imageProviderId === 'evolink-gpt-image-2' ? 'evolink-gpt-image-2' : 'deterministic-mock',
    viewport: {
      x: Number.isFinite(safeLegacy.viewport?.x) ? safeLegacy.viewport.x : 0,
      y: Number.isFinite(safeLegacy.viewport?.y) ? safeLegacy.viewport.y : 0,
      scale: Number.isFinite(safeLegacy.viewport?.scale) ? safeLegacy.viewport.scale : 1,
    },
    nodes: safeLegacy.nodes,
    selectedIds: Array.isArray(safeLegacy.selectedIds) ? safeLegacy.selectedIds : [],
    messages: createBlankWorkspace().messages,
    intents,
    plans,
    pendingPlanId: undefined,
    plannerEvidence: [],
    jobs: safeLegacy.jobs,
    assets: safeLegacy.assets,
    versions: Array.isArray(safeLegacy.versions) ? safeLegacy.versions : [],
    referenceTransferConsent: safeLegacy.referenceTransferConsent?.version === REFERENCE_TRANSFER_CONSENT_VERSION && Number.isFinite(Date.parse(safeLegacy.referenceTransferConsent.acceptedAt)) ? safeLegacy.referenceTransferConsent : undefined,
  }));
};

/**
 * Read-only, fail-closed project loader. A corrupt or cross-project record is
 * reported explicitly; callers must never replace it with a blank workspace.
 */
export const readWorkspace = (
  projectId = PROJECT_ID,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): WorkspaceReadResult => {
  if (!isLocalProjectId(projectId)) return { status: 'corrupt', projectId, code: 'WORKSPACE_INVALID_PROJECT_ID' };
  const storageKey = workspaceStorageKey(projectId);
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_STORAGE_READ_FAILED' };
  }
  if (raw === null) return { status: 'missing', projectId, storageKey };

  try {
    const parsedUnknown: unknown = JSON.parse(raw);
    if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
      return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_JSON_INVALID' };
    }
    const parsedRecord = parsedUnknown as Record<string, unknown>;
    if (!Array.isArray(parsedRecord.nodes)) {
      return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_COLLECTIONS_INVALID' };
    }

    if (Object.hasOwn(parsedRecord, 'schemaVersion')) {
      if (
        parsedRecord.projectId !== projectId
        || !persistedCollectionsArePresent(parsedRecord)
        || !persistedAssetsMatchProject(parsedRecord.assets, projectId)
      ) return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_PROJECT_BOUNDARY_MISMATCH' };

      if (parsedRecord.schemaVersion === PERSISTED_WORKSPACE_SCHEMA_VERSION) {
        const workspace = loadAllowlistedWorkspace(parsedUnknown as PersistedWorkspace);
        return { status: 'ready', projectId, storageKey, workspace: reconcileRestoredInFlightJobs(ensureFixedDemoLineage(workspace)) };
      }
      if (parsedRecord.schemaVersion !== LEGACY_ALLOWLISTED_WORKSPACE_SCHEMA_VERSION) {
        return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_SCHEMA_UNSUPPORTED' };
      }
      const parsed = parsedUnknown as PersistedWorkspaceV2;
      const migrated = {
        ...parsed,
        schemaVersion: PERSISTED_WORKSPACE_SCHEMA_VERSION,
        creationMode: 'agent' as const,
      } satisfies PersistedWorkspace;
      return {
        status: 'migrated',
        projectId,
        storageKey,
        workspace: reconcileRestoredInFlightJobs(ensureFixedDemoLineage(loadAllowlistedWorkspace(migrated))),
      };
    }

    // Raw pre-schema workspaces are accepted only for the sealed legacy
    // project. New project keys never inherit ambiguous records.
    if (projectId !== PROJECT_ID) return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_LEGACY_RECORD_WRONG_PROJECT' };
    if (
      (Object.hasOwn(parsedRecord, 'projectId') && parsedRecord.projectId !== PROJECT_ID)
      || !persistedAssetsMatchProject(parsedRecord.assets ?? [], PROJECT_ID)
    ) return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_PROJECT_BOUNDARY_MISMATCH' };
    return { status: 'migrated', projectId, storageKey, workspace: migrateLegacyWorkspace(parsedUnknown as Workspace) };
  } catch {
    return { status: 'corrupt', projectId, storageKey, code: 'WORKSPACE_RECORD_INVALID' };
  }
};

export const loadWorkspace = (
  projectId = PROJECT_ID,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): Workspace => {
  const result = readWorkspace(projectId, storage);
  if (result.status === 'missing') return createBlankWorkspace();
  if (result.status === 'corrupt') throw new WorkspacePersistenceError(result.code, result.projectId);
  return result.workspace;
};

const IN_FLIGHT_JOB_STATUSES = new Set(['queued', 'validating', 'uploading', 'submitted', 'processing', 'running']);

/**
 * A page reload destroys browser-only AbortControllers and the text/fixed-image
 * Provider task-handle map. Never restore an in-flight record as if its local
 * executor still existed: that would leave a permanent spinner or tempt a
 * duplicate paid submission. Remote jobs move to an explicit status-only
 * recovery state; the local server must prove a matching existing task before
 * any query, and a missing binding fails closed without a new paid submit.
 * Historical CORE008_RESULT_INVALID failures happened only after Provider
 * completion, so they receive the narrower local-result recovery state.
 */
export const reconcileRestoredInFlightJobs = (workspace: Workspace): Workspace => {
  const intentsById = new Map(workspace.intents.map((intent) => [intent.id, intent]));
  const decisions = new Map<string, { status: 'failed' | 'local_result_pending'; error: NonNullable<GenerationJob['error']> }>();

  for (const job of workspace.jobs) {
    const intent = intentsById.get(job.intentId);
    if (job.providerId === 'evolink-sora-2-preview' && IN_FLIGHT_JOB_STATUSES.has(job.status)) {
      decisions.set(job.id, { status: 'failed', error: {
        code: 'CORE009_RELOAD_STATUS_CHECK_REQUIRED',
        message: '页面已刷新；只可重查同一本机绑定的 Sora 任务，不会重新提交付费生成。',
        retryable: true,
        retryScope: 'status-only',
      } });
      continue;
    }
    if (job.providerId === 'evolink-sora-2-preview' && job.status === 'failed' && ['CORE009_RESULT_INVALID', 'CORE009_VIDEO_RESULT_INVALID'].includes(job.error?.code ?? '')) {
      decisions.set(job.id, { status: 'local_result_pending', error: {
        code: job.error!.code,
        message: 'Provider 已完成视频生成；可只恢复并重取同一 MP4，不会再次提交或计费。',
        retryable: true,
        retryScope: 'local-result',
      } });
      continue;
    }
    const remoteInFlight = job.providerId === 'evolink-gpt-image-2'
      && intent?.operation !== 'image_edit_user_reference'
      && IN_FLIGHT_JOB_STATUSES.has(job.status);
    if (remoteInFlight) {
      decisions.set(job.id, { status: 'failed', error: {
        code: 'CORE008_RELOAD_STATUS_CHECK_REQUIRED',
        message: '页面已刷新；只可重查同一本机绑定的 Provider 任务，不会重新提交付费生成。',
        retryable: true,
        retryScope: 'status-only',
      } });
      continue;
    }
    if (job.providerId === 'evolink-gpt-image-2' && job.status === 'failed' && job.error?.code === 'CORE008_RESULT_INVALID') {
      decisions.set(job.id, { status: 'local_result_pending', error: {
        code: 'CORE008_RESULT_INVALID',
        message: 'Provider 已完成生成；可只恢复并重取同一结果，不会再次提交或计费。',
        retryable: true,
        retryScope: 'local-result',
      } });
      continue;
    }
    if (job.providerId === 'evolink-gpt-image-2' && intent?.operation === 'image_edit_user_reference' && IN_FLIGHT_JOB_STATUSES.has(job.status)) {
      decisions.set(job.id, { status: 'failed', error: {
        code: 'CORE007_RELOAD_STATUS_CHECK_REQUIRED',
        message: '页面已刷新；可手动重查同一本机任务，不会再次提交付费生成。',
        retryable: true,
        retryScope: 'status-only',
      } });
      continue;
    }
    if (job.providerId === 'deterministic-mock' && IN_FLIGHT_JOB_STATUSES.has(job.status)) {
      decisions.set(job.id, { status: 'failed', error: {
        code: 'CORE008_LOCAL_EXECUTION_INTERRUPTED',
        message: '本地确定性任务因页面刷新中断；可由用户明确重试。',
        retryable: true,
        retryScope: 'new-provider-job',
      } });
    }
  }

  if (!decisions.size) return workspace;
  const updatedAt = new Date().toISOString();
  return {
    ...workspace,
    jobs: workspace.jobs.map((job) => {
      const decision = decisions.get(job.id);
      return decision ? { ...job, status: decision.status, progress: undefined, error: decision.error, updatedAt } : job;
    }),
    nodes: workspace.nodes.map((node) => node.jobId && decisions.has(node.jobId) && node.status === 'generating'
      ? { ...node, status: 'failed' as const }
      : node),
    versions: workspace.versions.map((version) => version.jobId && decisions.has(version.jobId) && version.status === 'pending'
      ? { ...version, status: 'failed' as const }
      : version),
  };
};

const redactedVisualDirection = () => ({ subject: '已脱敏主体', style: '已脱敏风格', lighting: '已脱敏光影', composition: '已脱敏构图' });

const loadAllowlistedWorkspace = (parsed: PersistedWorkspace): Workspace => {
  const intents: UserIntent[] = parsed.intents.map((intent) => ({
    ...intent,
    prompt: REDACTED_PROMPT,
    normalizedPrompt: REDACTED_PROMPT,
    goal: REDACTED_PROMPT,
    constraints: ['已脱敏约束'],
  }));
  const plans: AgentPlan[] = parsed.plans.map((plan) => ({
    ...plan,
    summary: '已脱敏 Agent Plan',
    bullets: ['已脱敏执行步骤'],
    constraints: ['已脱敏约束'],
    visualDirection: redactedVisualDirection(),
  }));
  const workspace: Workspace = {
    theme: parsed.theme,
    creationMode: isCreationMode(parsed.creationMode) ? parsed.creationMode : 'agent',
    imageProviderId: parsed.imageProviderId,
    viewport: parsed.viewport,
    nodes: parsed.nodes.map((node) => ({ ...node, prompt: REDACTED_PROMPT, ...(node.workflow ? { workflow: persistWorkflowData(node.workflow) } : {}) })),
    selectedIds: parsed.selectedIds.filter((id) => parsed.nodes.some((node) => node.id === id)),
    messages: [
      ...createBlankWorkspace().messages,
      ...parsed.auditMessages.map((message) => ({ ...message, body: AUDIT_MESSAGES[message.auditCode] })),
    ],
    intents,
    plans,
    pendingPlanId: undefined,
    plannerEvidence: [],
    jobs: parsed.jobs.map((job) => ({ ...job, error: job.error ? { ...job.error, message: '已脱敏任务错误' } : undefined })),
    assets: parsed.assets.map((asset) => {
      const { outputSlot: _outputSlot, ...metadata } = asset.metadata;
      return {
        ...asset,
        ...(asset.localAssetUri === GENERATED_ASSET ? { uri: GENERATED_ASSET } : {}),
        prompt: REDACTED_PROMPT,
        metadata: {
          ...metadata,
          ...(asset.kind === 'image' && isProviderOutputSlot(asset.metadata.outputSlot)
            ? { outputSlot: asset.metadata.outputSlot }
            : {}),
        },
      };
    }),
    versions: parsed.versions,
    referenceTransferConsent: parsed.referenceTransferConsent,
  };
  validateWorkflowGraph(workspace);
  return workspace;
};

const ensureFixedDemoLineage = (workspace: Workspace): Workspace => {
  const demo = workspace.nodes.find((node) => node.id === 'reference-demo');
  if (!demo) return workspace;
  const versionId = demo.versionId ?? 'version-reference-demo';
  const versionExists = workspace.versions.some((version) => version.id === versionId && version.canvasObjectId === demo.id);
  return {
    ...workspace,
    nodes: workspace.nodes.map((node) => node.id === demo.id ? { ...node, versionId } : node),
    versions: [
      ...workspace.versions.map((version) => version.parentCanvasObjectId === demo.id && !version.parentVersionId ? { ...version, parentVersionId: versionId } : version),
      ...(versionExists ? [] : [{ id: versionId, canvasObjectId: demo.id, sequence: 0, status: 'ready' as const, createdAt: demo.createdAt }]),
    ],
  };
};

const migrateIntent = (intent: UserIntent): UserIntent => {
  const operation = intent.targetCanvasObjectId ? 'image_edit_fixed_demo_reference' as const : 'image_generate' as const;
  return {
    ...intent,
    operation: isPlannerOperation(intent.operation) ? intent.operation : operation,
    source: intent.source ?? 'legacy-deterministic',
    normalizedPrompt: intent.normalizedPrompt ?? intent.prompt,
    goal: intent.goal ?? intent.prompt,
    constraints: Array.isArray(intent.constraints) ? intent.constraints : ['历史记录：保留既有画布与版本边界'],
  };
};

const migratePlan = (plan: AgentPlan, intent?: UserIntent): AgentPlan => {
  const operation = intent?.operation ?? 'image_generate';
  return {
    ...plan,
    operation: isPlannerOperation(plan.operation) ? plan.operation : operation,
    source: plan.source ?? intent?.source ?? 'legacy-deterministic',
    constraints: Array.isArray(plan.constraints) ? plan.constraints : intent?.constraints ?? [],
    visualDirection: plan.visualDirection ?? { subject: '历史产品主体', style: '历史视觉方案', lighting: '历史光影', composition: '历史构图' },
  };
};

const isPlannerOperation = (value: unknown): value is UserIntent['operation'] => [
  'image_generate',
  'image_edit_fixed_demo_reference',
  'image_edit_user_reference',
  'video_image_to_video',
  'clarify',
].includes(String(value));

export const analyzePrompt = (prompt: string) => {
  const normalized = prompt.trim();
  return {
    prompt: normalized,
    shouldFail: /(^|\s)(fail|error)(\s|$)|失败|出错/i.test(normalized),
    summary: normalized
      ? `已识别「${normalized}」中的主体、材质与光影约束。将保留参考图的产品轮廓，并输出一张可继续迭代的视觉版本。`
      : '请先描述视觉需求，我会返回结构化的 mock 生成方案。',
    bullets: ['主体与比例：保留产品轮廓', '质感与光线：低调棚拍、细节清晰', '版本策略：生成结果保留父版本'],
  };
};

export const makeReferenceNode = (): CanvasNode => ({
  id: 'reference-demo',
  kind: 'reference',
  name: '演示参考图 · Portable Speaker',
  x: 170,
  y: 255,
  width: 260,
  height: 260,
  status: 'ready',
  version: 0,
  prompt: '本地静态演示参考图',
  createdAt: new Date().toISOString(),
  versionId: 'version-reference-demo',
});

export const makeReferenceVersion = (): VersionRecord => ({
  id: 'version-reference-demo',
  canvasObjectId: 'reference-demo',
  sequence: 0,
  status: 'ready',
  createdAt: new Date().toISOString(),
});

export const makeUploadedReferenceNode = ({ id, assetId, versionId, width, height, index = 0 }: { id: string; assetId: string; versionId: string; width: number; height: number; index?: number }): CanvasNode => {
  const maxDisplay = 340;
  const ratio = Math.min(1, maxDisplay / Math.max(width, height));
  return {
    id,
    kind: 'reference',
    name: '用户参考图 · 本地安全副本',
    x: 170 + index * 36,
    y: 255 + index * 36,
    width: Math.max(120, Math.round(width * ratio)),
    height: Math.max(120, Math.round(height * ratio)),
    status: 'ready',
    version: 0,
    prompt: '用户有权使用的非敏感本地参考图',
    createdAt: new Date().toISOString(),
    assetId,
    versionId,
  };
};

export const makeMockNode = (
  id: string,
  prompt: string,
  parent?: CanvasNode,
  links?: Pick<CanvasNode, 'jobId' | 'versionId'>,
): CanvasNode => ({
  id,
  kind: 'generated',
  name: parent ? `v${parent.version + 1} · 子版本` : 'v1 · 生成版本',
  x: parent ? parent.x + parent.width + 150 : 420,
  y: parent ? parent.y + 18 : 185,
  width: 390,
  height: 390,
  status: 'generating',
  parentId: parent?.id,
  version: parent ? parent.version + 1 : 1,
  prompt,
  createdAt: new Date().toISOString(),
  ...links,
});

export type WorkspaceNodeDeletionResult =
  | { ok: false; reason: 'NO_MATCHING_NODES' | 'HAS_CHILDREN' }
  | { ok: true; workspace: Workspace; orphanedAssets: Asset[]; cancelledJobIds: string[] };

/**
 * Computes a graph-safe deletion without touching browser storage. Callers
 * first clean `orphanedAssets[].storage`, then commit `workspace`. Jobs remain
 * as audit records; a generating placeholder is soft-cancelled before its
 * Canvas Object and pending Version are removed.
 */
export const deleteWorkspaceNodes = (
  workspace: Workspace,
  requestedIds: string[],
  options: { reason?: 'delete' | 'soft-cancel'; atIso?: string; timeLabel?: string } = {},
): WorkspaceNodeDeletionResult => {
  const ids = [...new Set(requestedIds)].filter((id) => workspace.nodes.some((node) => node.id === id));
  if (!ids.length) return { ok: false, reason: 'NO_MATCHING_NODES' };
  if (ids.some((id) => workspace.nodes.some((node) => node.parentId === id))) return { ok: false, reason: 'HAS_CHILDREN' };

  const idSet = new Set(ids);
  const targets = workspace.nodes.filter((node) => idSet.has(node.id));
  const cancelledJobIds = targets.flatMap((node) => node.status === 'generating' && node.jobId ? [node.jobId] : []);
  const cancelledJobIdSet = new Set(cancelledJobIds);
  const remainingNodes = workspace.nodes.filter((node) => !idSet.has(node.id)).map(node => ({
    ...node,
    ...(node.workflow ? { workflow: { ...node.workflow, inputs: node.workflow.inputs.filter(input => !idSet.has(input.sourceId)) } } : {}),
    ...(node.workflowOriginId && idSet.has(node.workflowOriginId) ? { workflowOriginId: undefined } : {}),
  }));
  const remainingAssetIds = new Set(remainingNodes.flatMap((node) => node.assetId ? [node.assetId] : []));
  const removedAssetIds = new Set(targets.flatMap((node) => node.assetId ? [node.assetId] : []));
  const orphanedAssets = workspace.assets.filter((asset) => removedAssetIds.has(asset.id) && !remainingAssetIds.has(asset.id));
  const orphanedAssetIds = new Set(orphanedAssets.map((asset) => asset.id));
  const atIso = options.atIso ?? new Date().toISOString();
  const auditCode: WorkspaceAuditCode = options.reason === 'soft-cancel' ? 'CORE007_SOFT_CANCELLED' : 'CORE007_DELETE_SOFT_CANCELLED';
  const auditMessages = cancelledJobIds.length ? [{
    id: `audit-${auditCode.toLowerCase()}-${Date.parse(atIso) || Date.now()}`,
    role: 'system' as const,
    body: AUDIT_MESSAGES[auditCode],
    time: options.timeLabel ?? nowLabel(),
    auditCode,
  }] : [];
  const pendingIntentIds = new Set(workspace.intents.filter((intent) => intent.targetCanvasObjectId && idSet.has(intent.targetCanvasObjectId)).map((intent) => intent.id));
  const pendingPlanIds = new Set(workspace.plans.filter((plan) => pendingIntentIds.has(plan.intentId)).map((plan) => plan.id));

  return {
    ok: true,
    orphanedAssets,
    cancelledJobIds,
    workspace: {
      ...workspace,
      nodes: remainingNodes,
      selectedIds: workspace.selectedIds.filter((id) => !idSet.has(id)),
      versions: workspace.versions.filter((version) => !idSet.has(version.canvasObjectId)),
      assets: workspace.assets.filter((asset) => !orphanedAssetIds.has(asset.id)),
      jobs: workspace.jobs.map((job) => cancelledJobIdSet.has(job.id) ? {
        ...job,
        status: 'user_cancelled',
        updatedAt: atIso,
        error: {
          code: 'CORE007_USER_CANCELLED',
          message: AUDIT_MESSAGES[auditCode],
          retryable: false,
        },
      } : job),
      pendingPlanId: workspace.pendingPlanId && pendingPlanIds.has(workspace.pendingPlanId) ? undefined : workspace.pendingPlanId,
      messages: [...workspace.messages, ...auditMessages],
    },
  };
};

export const workspaceAuditMessage = (
  auditCode: WorkspaceAuditCode,
  id = `audit-${auditCode.toLowerCase()}-${Date.now()}`,
): Message => ({ id, role: 'system', body: AUDIT_MESSAGES[auditCode], time: nowLabel(), auditCode });

const isCreationMode = (value: unknown): value is CreationMode => value === 'agent' || value === 'image' || value === 'video';

export const clampScale = (scale: number) => Math.max(0.45, Math.min(1.55, Number(scale.toFixed(4))));

export const zoomViewportAtPoint = (
  viewport: Workspace['viewport'],
  deltaY: number,
  point: { x: number; y: number },
): Workspace['viewport'] => {
  const oldScale = clampScale(viewport.scale);
  const normalizedDelta = Math.max(-120, Math.min(120, deltaY));
  const scale = clampScale(oldScale * Math.exp(-normalizedDelta * 0.0004));
  const scaleRatio = scale / oldScale;

  return {
    x: point.x - (point.x - viewport.x) * scaleRatio,
    y: point.y - (point.y - viewport.y) * scaleRatio,
    scale,
  };
};

export const selectableNodes = (nodes: CanvasNode[]) => nodes.filter((node) => node.status !== 'generating');
