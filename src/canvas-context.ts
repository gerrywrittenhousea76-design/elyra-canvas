import type { AgentPlan, Asset, VersionRecord } from './agent';
import { orderCanvasNodesByLayer, type CanvasNode, type Workspace } from './domain';
import { validateWorkflowGraph } from './workflow-graph';

export const CANVAS_CONTEXT_SCHEMA_VERSION = 1 as const;

export const CANVAS_CONTEXT_HARD_LIMITS = Object.freeze({
  objects: 100,
  assets: 100,
  versions: 200,
});

export const CORE009_VIDEO_DURATION_RANGE_SECONDS = Object.freeze({
  min: 3.5,
  max: 4.5,
});

export type CanvasContextErrorCode =
  | 'CANVAS_CONTEXT_CRYPTO_UNAVAILABLE'
  | 'CANVAS_CONTEXT_DUPLICATE_ID'
  | 'CANVAS_CONTEXT_INVALID_ASSET'
  | 'CANVAS_CONTEXT_INVALID_BOUNDS'
  | 'CANVAS_CONTEXT_INVALID_ID'
  | 'CANVAS_CONTEXT_INVALID_LIMIT'
  | 'CANVAS_CONTEXT_INVALID_OBJECT'
  | 'CANVAS_CONTEXT_INVALID_PLAN'
  | 'CANVAS_CONTEXT_INVALID_VERSION'
  | 'CANVAS_CONTEXT_INVALID_VIEWPORT'
  | 'CANVAS_CONTEXT_LIMIT_EXCEEDED'
  | 'CANVAS_CONTEXT_DANGLING_ASSET'
  | 'CANVAS_CONTEXT_DANGLING_OBJECT'
  | 'CANVAS_CONTEXT_DANGLING_SELECTION'
  | 'CANVAS_CONTEXT_DANGLING_VERSION'
  | 'CANVAS_CONTEXT_LINEAGE_CYCLE'
  | 'CANVAS_CONTEXT_LINEAGE_MISMATCH'
  | 'CANVAS_CONTEXT_INVALID_DELTA';

export class CanvasContextError extends Error {
  readonly code: CanvasContextErrorCode;

  constructor(code: CanvasContextErrorCode) {
    super(code);
    this.name = 'CanvasContextError';
    this.code = code;
  }
}

export interface CanvasContextViewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface CanvasContextBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasContextObjectSummary {
  readonly id: string;
  readonly kind: CanvasNode['kind'];
  readonly status: CanvasNode['status'];
  readonly bounds: CanvasContextBounds;
  /** Canonical stable object rank; independent from incidental input array order. */
  readonly zOrder: number;
  readonly parentObjectId?: string;
  readonly assetId?: string;
  readonly versionId?: string;
  readonly workflow?: { readonly kind: string; readonly model: string; readonly contentSha256: string; readonly inputs: readonly { sourceId: string; role: string; assetId?: string; versionId?: string }[] };
  readonly workflowOriginId?: string;
}

export interface CanvasContextAssetSummary {
  readonly id: string;
  readonly kind: 'image' | 'video';
  readonly source: Asset['source'];
  readonly providerId: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
  readonly width: number;
  readonly height: number;
  readonly deterministic: boolean;
  /** Physical MP4 duration for the approved approximately four-second result. */
  readonly durationSeconds?: number;
}

export interface CanvasContextVersionSummary {
  readonly id: string;
  readonly canvasObjectId: string;
  readonly parentVersionId?: string;
  readonly parentCanvasObjectId?: string;
  readonly sequence: number;
  readonly status: VersionRecord['status'];
}

export interface CanvasContextPlanSummary {
  readonly id: string;
  readonly operation: AgentPlan['operation'];
  readonly source: AgentPlan['source'];
  readonly status: AgentPlan['status'];
  readonly providerId: string;
}

export interface CanvasContextSemanticPayload {
  readonly schemaVersion: typeof CANVAS_CONTEXT_SCHEMA_VERSION;
  readonly viewport: CanvasContextViewport;
  readonly selectedObjectIds: readonly string[];
  readonly objects: readonly CanvasContextObjectSummary[];
  readonly assets: readonly CanvasContextAssetSummary[];
  readonly versions: readonly CanvasContextVersionSummary[];
  readonly currentPlan?: CanvasContextPlanSummary;
  readonly lastVerifiedDeltaSha256?: string;
}

export interface CanvasContextGraphSnapshot extends CanvasContextSemanticPayload {
  readonly semanticSha256: string;
}

export interface CanvasContextBuildOptions {
  /** Limits may only reduce, never expand, the control-plane hard caps. */
  readonly maxObjects?: number;
  readonly maxAssets?: number;
  readonly maxVersions?: number;
  readonly currentPlan?: AgentPlan;
  readonly lastVerifiedDeltaSha256?: string;
  readonly cryptoApi?: Pick<Crypto, 'subtle'>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ALLOWED_NODE_KINDS = new Set<CanvasNode['kind']>(['reference', 'generated', 'workflow']);
const ALLOWED_NODE_STATUSES = new Set<CanvasNode['status']>(['ready', 'generating', 'failed', 'user_cancelled']);
const ALLOWED_ASSET_SOURCES = new Set<Asset['source']>(['deterministic-mock', 'remote-provider', 'local-upload']);
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_VERSION_STATUSES = new Set<VersionRecord['status']>(['pending', 'ready', 'failed', 'user_cancelled']);

type CanvasContextAssetShape = Omit<Asset, 'kind' | 'mimeType' | 'metadata'> & {
  kind: 'image' | 'video';
  mimeType: CanvasContextAssetSummary['mimeType'];
  metadata: {
    deterministic: boolean;
    width: number;
    height: number;
    durationSeconds?: number;
  };
};

/**
 * Builds the only canvas representation that may be passed into CORE-008.
 * Every output property is explicitly allowlisted. In particular, CanvasNode
 * names/prompts, Asset URIs/storage, chat, Planner evidence and Provider data
 * have no route into this value.
 */
export const buildCanvasContextGraphSnapshot = async (
  workspace: Workspace,
  options: CanvasContextBuildOptions = {},
): Promise<CanvasContextGraphSnapshot> => {
  const limits = {
    objects: resolveLimit(options.maxObjects, CANVAS_CONTEXT_HARD_LIMITS.objects),
    assets: resolveLimit(options.maxAssets, CANVAS_CONTEXT_HARD_LIMITS.assets),
    versions: resolveLimit(options.maxVersions, CANVAS_CONTEXT_HARD_LIMITS.versions),
  };

  if (workspace.nodes.length > limits.objects || workspace.assets.length > limits.assets || workspace.versions.length > limits.versions) {
    fail('CANVAS_CONTEXT_LIMIT_EXCEEDED');
  }

  const viewport = validateViewport(workspace.viewport);
  const nodesById = indexByUniqueId(workspace.nodes);
  const assetsById = indexByUniqueId(workspace.assets);
  const versionsById = indexByUniqueId(workspace.versions);

  validateObjectGraph(workspace.nodes, nodesById, assetsById, versionsById);
  validateAssetGraph(workspace.assets);
  validateVersionGraph(workspace.versions, nodesById, versionsById);
  validateWorkflowGraph(workspace);
  const workflowHashes = new Map(await Promise.all(workspace.nodes.filter(node => node.workflow).map(async node => {
    const bytes = new TextEncoder().encode(node.workflow!.text);
    const digest = await (options.cryptoApi ?? globalThis.crypto).subtle.digest('SHA-256', bytes);
    return [node.id, [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')] as const;
  })));

  const selectedObjectIds = [...new Set(workspace.selectedIds)].sort(compareIds);
  for (const id of selectedObjectIds) {
    assertSafeId(id);
    if (!nodesById.has(id)) fail('CANVAS_CONTEXT_DANGLING_SELECTION');
  }

  const zOrderByObjectId = new Map(orderCanvasNodesByLayer(workspace.nodes).map((node, zOrder) => [node.id, zOrder]));
  const objects = [...workspace.nodes].sort((left, right) => compareIds(left.id, right.id)).map((node): CanvasContextObjectSummary => freezeObject({
    id: node.id,
    kind: node.kind,
    status: node.status,
    bounds: freezeObject({
      x: normalizeNumber(node.x),
      y: normalizeNumber(node.y),
      width: normalizeNumber(node.width),
      height: normalizeNumber(node.height),
    }),
    zOrder: zOrderByObjectId.get(node.id)!,
    ...(node.parentId ? { parentObjectId: node.parentId } : {}),
    ...(node.assetId ? { assetId: node.assetId } : {}),
    ...(node.versionId ? { versionId: node.versionId } : {}),
    ...(node.workflow ? { workflow: freezeObject({ kind: node.workflow.kind, model: node.workflow.model, contentSha256: workflowHashes.get(node.id)!, inputs: Object.freeze(node.workflow.inputs.map(input => freezeObject({ sourceId: input.sourceId, role: input.role, ...(input.assetId ? { assetId: input.assetId } : {}), ...(input.versionId ? { versionId: input.versionId } : {}) }))) }) } : {}),
    ...(node.workflowOriginId ? { workflowOriginId: node.workflowOriginId } : {}),
  }));

  const assets = [...workspace.assets]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((asset): CanvasContextAssetSummary => {
      const mediaAsset = asset as unknown as CanvasContextAssetShape;
      return freezeObject({
        id: mediaAsset.id,
        kind: mediaAsset.kind,
        source: mediaAsset.source,
        providerId: mediaAsset.providerId,
        mimeType: mediaAsset.mimeType,
        width: mediaAsset.metadata.width,
        height: mediaAsset.metadata.height,
        deterministic: mediaAsset.metadata.deterministic,
        ...(mediaAsset.kind === 'video' ? { durationSeconds: mediaAsset.metadata.durationSeconds } : {}),
      });
    });

  const versions = [...workspace.versions]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((version): CanvasContextVersionSummary => freezeObject({
      id: version.id,
      canvasObjectId: version.canvasObjectId,
      ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}),
      ...(version.parentCanvasObjectId ? { parentCanvasObjectId: version.parentCanvasObjectId } : {}),
      sequence: version.sequence,
      status: version.status,
    }));

  const currentPlan = options.currentPlan ? summarizePlan(options.currentPlan) : undefined;
  if (options.lastVerifiedDeltaSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.lastVerifiedDeltaSha256)) {
    fail('CANVAS_CONTEXT_INVALID_DELTA');
  }

  const payload: CanvasContextSemanticPayload = freezeObject({
    schemaVersion: CANVAS_CONTEXT_SCHEMA_VERSION,
    viewport,
    selectedObjectIds: Object.freeze(selectedObjectIds),
    objects: Object.freeze(objects),
    assets: Object.freeze(assets),
    versions: Object.freeze(versions),
    ...(currentPlan ? { currentPlan } : {}),
    ...(options.lastVerifiedDeltaSha256 ? { lastVerifiedDeltaSha256: options.lastVerifiedDeltaSha256 } : {}),
  });
  const semanticSha256 = await computeCanvasContextSemanticSha256(payload, options.cryptoApi);

  return freezeObject({ ...payload, semanticSha256 });
};

const summarizePlan = (plan: AgentPlan): CanvasContextPlanSummary => {
  assertSafeId(plan.id);
  assertSafeId(plan.providerId);
  if (!['image_generate', 'image_edit_fixed_demo_reference', 'image_edit_user_reference', 'video_image_to_video', 'clarify'].includes(plan.operation)) fail('CANVAS_CONTEXT_INVALID_PLAN');
  if (!['remote-agent', 'fallback', 'legacy-deterministic', 'direct-mode'].includes(plan.source)) fail('CANVAS_CONTEXT_INVALID_PLAN');
  if (!['proposed', 'approved'].includes(plan.status)) fail('CANVAS_CONTEXT_INVALID_PLAN');
  return freezeObject({
    id: plan.id,
    operation: plan.operation,
    source: plan.source,
    status: plan.status,
    providerId: plan.providerId,
  });
};

export const computeCanvasContextSemanticSha256 = async (
  payload: CanvasContextSemanticPayload,
  cryptoApi: Pick<Crypto, 'subtle'> | undefined = globalThis.crypto,
): Promise<string> => {
  if (!cryptoApi?.subtle) fail('CANVAS_CONTEXT_CRYPTO_UNAVAILABLE');
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const validateViewport = (viewport: Workspace['viewport']): Readonly<CanvasContextViewport> => {
  if (!isFiniteNumber(viewport.x) || !isFiniteNumber(viewport.y) || !isFiniteNumber(viewport.scale) || viewport.scale <= 0) {
    fail('CANVAS_CONTEXT_INVALID_VIEWPORT');
  }
  return freezeObject({
    x: normalizeNumber(viewport.x),
    y: normalizeNumber(viewport.y),
    scale: normalizeNumber(viewport.scale),
  });
};

const validateObjectGraph = (
  nodes: readonly CanvasNode[],
  nodesById: ReadonlyMap<string, CanvasNode>,
  assetsById: ReadonlyMap<string, Asset>,
  versionsById: ReadonlyMap<string, VersionRecord>,
) => {
  for (const node of nodes) {
    assertSafeId(node.id);
    if (!ALLOWED_NODE_KINDS.has(node.kind) || !ALLOWED_NODE_STATUSES.has(node.status)) fail('CANVAS_CONTEXT_INVALID_OBJECT');
    if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y) || !isFiniteNumber(node.width) || !isFiniteNumber(node.height) || node.width <= 0 || node.height <= 0) {
      fail('CANVAS_CONTEXT_INVALID_BOUNDS');
    }
    if (node.parentId) {
      assertSafeId(node.parentId);
      if (!nodesById.has(node.parentId)) fail('CANVAS_CONTEXT_DANGLING_OBJECT');
    }
    if (node.assetId) {
      assertSafeId(node.assetId);
      if (!assetsById.has(node.assetId)) fail('CANVAS_CONTEXT_DANGLING_ASSET');
    }
    if (node.versionId) {
      assertSafeId(node.versionId);
      const version = versionsById.get(node.versionId);
      if (!version) fail('CANVAS_CONTEXT_DANGLING_VERSION');
      if (version?.canvasObjectId !== node.id) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
      if (version!.sequence !== node.version) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
    }
  }
  assertAcyclic(nodes.map((node) => [node.id, node.parentId] as const));
};

const validateAssetGraph = (assets: readonly Asset[]) => {
  for (const asset of assets) {
    const mediaAsset = asset as unknown as CanvasContextAssetShape;
    assertSafeId(mediaAsset.id);
    assertSafeId(mediaAsset.providerId);
    if (!ALLOWED_ASSET_SOURCES.has(mediaAsset.source)) {
      fail('CANVAS_CONTEXT_INVALID_ASSET');
    }
    if (!isPositiveInteger(mediaAsset.metadata.width) || !isPositiveInteger(mediaAsset.metadata.height) || typeof mediaAsset.metadata.deterministic !== 'boolean') {
      fail('CANVAS_CONTEXT_INVALID_ASSET');
    }
    if (mediaAsset.kind === 'image' && !ALLOWED_IMAGE_MIME_TYPES.has(mediaAsset.mimeType)) {
      fail('CANVAS_CONTEXT_INVALID_ASSET');
    }
    if (mediaAsset.kind === 'video' && (
      mediaAsset.mimeType !== 'video/mp4'
      || !Number.isFinite(mediaAsset.metadata.durationSeconds)
      || mediaAsset.metadata.durationSeconds! < CORE009_VIDEO_DURATION_RANGE_SECONDS.min
      || mediaAsset.metadata.durationSeconds! > CORE009_VIDEO_DURATION_RANGE_SECONDS.max
    )) {
      fail('CANVAS_CONTEXT_INVALID_ASSET');
    }
    if (mediaAsset.kind !== 'image' && mediaAsset.kind !== 'video') {
      fail('CANVAS_CONTEXT_INVALID_ASSET');
    }
  }
};

const validateVersionGraph = (
  versions: readonly VersionRecord[],
  nodesById: ReadonlyMap<string, CanvasNode>,
  versionsById: ReadonlyMap<string, VersionRecord>,
) => {
  for (const version of versions) {
    assertSafeId(version.id);
    assertSafeId(version.canvasObjectId);
    if (!nodesById.has(version.canvasObjectId)) fail('CANVAS_CONTEXT_DANGLING_OBJECT');
    if (!isNonNegativeInteger(version.sequence) || !ALLOWED_VERSION_STATUSES.has(version.status)) fail('CANVAS_CONTEXT_INVALID_VERSION');

    const hasParentVersion = typeof version.parentVersionId === 'string';
    const hasParentObject = typeof version.parentCanvasObjectId === 'string';
    if (hasParentVersion !== hasParentObject) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
    const node = nodesById.get(version.canvasObjectId)!;
    if (!hasParentVersion || !hasParentObject) {
      if (node.parentId) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
      continue;
    }

    assertSafeId(version.parentVersionId!);
    assertSafeId(version.parentCanvasObjectId!);
    const parentVersion = versionsById.get(version.parentVersionId!);
    if (!parentVersion) fail('CANVAS_CONTEXT_DANGLING_VERSION');
    if (!nodesById.has(version.parentCanvasObjectId!)) fail('CANVAS_CONTEXT_DANGLING_OBJECT');
    if (parentVersion?.canvasObjectId !== version.parentCanvasObjectId) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
    if (node.parentId !== version.parentCanvasObjectId) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
    const parentNode = nodesById.get(version.parentCanvasObjectId!)!;
    if (parentNode.versionId !== parentVersion!.id) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
    if (version.sequence !== parentVersion!.sequence + 1) fail('CANVAS_CONTEXT_LINEAGE_MISMATCH');
  }
  assertAcyclic(versions.map((version) => [version.id, version.parentVersionId] as const));
};

const indexByUniqueId = <T extends { id: string }>(items: readonly T[]): Map<string, T> => {
  const indexed = new Map<string, T>();
  for (const item of items) {
    assertSafeId(item.id);
    if (indexed.has(item.id)) fail('CANVAS_CONTEXT_DUPLICATE_ID');
    indexed.set(item.id, item);
  }
  return indexed;
};

const assertAcyclic = (relations: ReadonlyArray<readonly [string, string | undefined]>) => {
  const parents = new Map(relations);
  for (const [start] of relations) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current) {
      if (visited.has(current)) fail('CANVAS_CONTEXT_LINEAGE_CYCLE');
      visited.add(current);
      current = parents.get(current);
    }
  }
};

const resolveLimit = (requested: number | undefined, hardLimit: number): number => {
  if (requested === undefined) return hardLimit;
  if (!Number.isInteger(requested) || requested < 1 || requested > hardLimit) fail('CANVAS_CONTEXT_INVALID_LIMIT');
  return requested;
};

const assertSafeId = (value: string) => {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('CANVAS_CONTEXT_INVALID_ID');
};

const isFiniteNumber = (value: number): value is number => typeof value === 'number' && Number.isFinite(value);
const isPositiveInteger = (value: number): value is number => Number.isSafeInteger(value) && value > 0;
const isNonNegativeInteger = (value: number): value is number => Number.isSafeInteger(value) && value >= 0;
const normalizeNumber = (value: number) => Object.is(value, -0) ? 0 : value;
const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const freezeObject = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

const fail = (code: CanvasContextErrorCode): never => {
  throw new CanvasContextError(code);
};
