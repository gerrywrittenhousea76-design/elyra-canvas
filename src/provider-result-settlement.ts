import {
  PROVIDER_OUTPUT_SLOTS,
  providerResultHasOutputSet,
  type Asset,
  type GenerationJob,
  type ProviderOutputSet,
  type ProviderOutputSlot,
  type ProviderRunResult,
} from './agent';
import type { CanvasNode, Workspace } from './domain';

const SETTLEABLE_JOB_STATUSES = new Set<GenerationJob['status']>([
  'queued',
  'validating',
  'uploading',
  'submitted',
  'processing',
  'local_result_pending',
  'running',
]);
const IMAGE_MIME_TYPES = new Set<Asset['mimeType']>(['image/png', 'image/jpeg', 'image/webp']);
const ASSET_MIME_TYPES = new Set<Asset['mimeType']>(['image/png', 'image/jpeg', 'image/webp', 'video/mp4']);

export type ProviderResultValidationCode =
  | 'CORE013_RESULT_NOT_SUCCESS'
  | 'CORE013_OUTPUT_SET_SHAPE_INVALID'
  | 'CORE013_OUTPUT_SLOT_INVALID'
  | 'CORE013_OUTPUT_ASSET_INVALID'
  | 'CORE013_OUTPUT_ASSET_ID_DUPLICATE'
  | 'CORE013_OUTPUT_BLOB_INVALID';

export type ProviderSettlementCode = ProviderResultValidationCode
  | 'CORE013_JOB_NOT_SETTLEABLE'
  | 'CORE013_PLACEHOLDER_NOT_SETTLEABLE'
  | 'CORE013_PLACEHOLDER_VERSION_INVALID'
  | 'CORE013_OUTPUT_STORAGE_INVALID'
  | 'CORE013_OUTPUT_ID_CONFLICT'
  | 'CORE013_SETTLEMENT_ID_CONFLICT'
  | 'CORE013_SETTLEMENT_TIMESTAMP_INVALID';

export type ValidatedProviderSuccess =
  | {
      kind: 'single';
      outputs: readonly [{ slot?: undefined; asset: Asset; blob?: Blob }];
    }
  | {
      kind: 'set';
      outputs: ProviderOutputSet;
    };

export type ProviderSuccessValidation =
  | { ok: true; value: ValidatedProviderSuccess }
  | { ok: false; code: ProviderResultValidationCode };

export interface ProviderSettlementOutputIds {
  nodeIds: string[];
  versionIds: string[];
  assetIds: string[];
}

export type ProviderSettlementResult =
  | {
      ok: true;
      kind: ValidatedProviderSuccess['kind'];
      workspace: Workspace;
      outputIds: ProviderSettlementOutputIds;
    }
  | { ok: false; code: ProviderSettlementCode };

const failValidation = (code: ProviderResultValidationCode): ProviderSuccessValidation => ({ ok: false, code });
const failSettlement = (code: ProviderSettlementCode): ProviderSettlementResult => ({ ok: false, code });
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isPositiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isBlob = (value: unknown): value is Blob => typeof Blob !== 'undefined' && value instanceof Blob;

const assetMatchesJob = (asset: unknown, job: GenerationJob, requireImage: boolean): asset is Asset => {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
  const candidate = asset as Asset;
  if (
    !isNonEmptyString(candidate.id)
    || candidate.jobId !== job.id
    || candidate.providerId !== job.providerId
    || candidate.source === 'local-upload'
    || !ASSET_MIME_TYPES.has(candidate.mimeType)
    || (requireImage && (candidate.kind !== 'image' || !IMAGE_MIME_TYPES.has(candidate.mimeType)))
    || (!requireImage && candidate.kind === 'image' && !IMAGE_MIME_TYPES.has(candidate.mimeType))
    || (!requireImage && candidate.kind === 'video' && candidate.mimeType !== 'video/mp4')
    || !isNonEmptyString(candidate.prompt)
    || !isNonEmptyString(candidate.createdAt)
    || !Number.isFinite(Date.parse(candidate.createdAt))
    || !candidate.metadata
    || !isPositiveFinite(candidate.metadata.width)
    || !isPositiveFinite(candidate.metadata.height)
    || typeof candidate.metadata.deterministic !== 'boolean'
  ) return false;
  return true;
};

const blobMatchesAsset = (blob: unknown, asset: Asset): blob is Blob => (
  isBlob(blob)
  && blob.size > 0
  && blob.type === asset.mimeType
);

/**
 * Validates the complete Provider success before any Blob or Workspace write.
 * The three-image branch is deliberately exact: no missing slot, reordering,
 * duplicate Asset ID, URL-only output, or partial Blob set is accepted.
 */
export const validateProviderRunSuccess = (
  result: ProviderRunResult,
  job: GenerationJob,
): ProviderSuccessValidation => {
  if (!result.ok) return failValidation('CORE013_RESULT_NOT_SUCCESS');

  if (providerResultHasOutputSet(result)) {
    const rawOutputs: unknown = result.outputs;
    if (
      !Array.isArray(rawOutputs)
      || rawOutputs.length !== PROVIDER_OUTPUT_SLOTS.length
      || hasOwn(result, 'asset')
      || hasOwn(result, 'blob')
    ) return failValidation('CORE013_OUTPUT_SET_SHAPE_INVALID');

    const assetIds = new Set<string>();
    for (let index = 0; index < PROVIDER_OUTPUT_SLOTS.length; index += 1) {
      const output = rawOutputs[index] as { slot?: unknown; asset?: unknown; blob?: unknown } | undefined;
      const expectedSlot = PROVIDER_OUTPUT_SLOTS[index];
      if (!output || output.slot !== expectedSlot) return failValidation('CORE013_OUTPUT_SLOT_INVALID');
      if (!assetMatchesJob(output.asset, job, true)) return failValidation('CORE013_OUTPUT_ASSET_INVALID');
      if (output.asset.metadata.outputSlot !== expectedSlot || hasOwn(output.asset, 'uri')) {
        return failValidation('CORE013_OUTPUT_ASSET_INVALID');
      }
      if (assetIds.has(output.asset.id)) return failValidation('CORE013_OUTPUT_ASSET_ID_DUPLICATE');
      assetIds.add(output.asset.id);
      if (!blobMatchesAsset(output.blob, output.asset)) return failValidation('CORE013_OUTPUT_BLOB_INVALID');
    }

    return { ok: true, value: { kind: 'set', outputs: result.outputs } };
  }

  if (!hasOwn(result, 'asset') || hasOwn(result, 'outputs') || !assetMatchesJob(result.asset, job, false)) {
    return failValidation('CORE013_OUTPUT_ASSET_INVALID');
  }
  if (result.blob !== undefined && !blobMatchesAsset(result.blob, result.asset)) {
    return failValidation('CORE013_OUTPUT_BLOB_INVALID');
  }
  return { ok: true, value: { kind: 'single', outputs: [{ asset: result.asset, ...(result.blob ? { blob: result.blob } : {}) }] } };
};

const stableOutputId = (kind: 'node' | 'version', jobId: string, slot: ProviderOutputSlot) => (
  `core013-output-${kind}-${encodeURIComponent(jobId)}-${slot}`
);

const outputNodeName: Readonly<Record<ProviderOutputSlot, string>> = {
  left45: '左前 45°',
  front: '正面',
  right45: '右前 45°',
};

const storedBlobMatches = (asset: Asset, blob: Blob | undefined, projectId: string): boolean => {
  if (!blob) return asset.storage === undefined;
  const storage = asset.storage;
  if (!storage) return false;
  return storage.projectId === projectId
    && storage.mimeType === asset.mimeType
    && storage.bytes === blob.size
    && isNonEmptyString(storage.blobKey)
    && storage.locator === `indexeddb://elyra-assets/${encodeURIComponent(projectId)}/${encodeURIComponent(storage.blobKey)}`
    && /^[a-f0-9]{64}$/.test(storage.sha256)
    && Number.isFinite(Date.parse(storage.createdAt));
};

const siblingNode = (
  placeholder: CanvasNode,
  slot: ProviderOutputSlot,
  index: number,
  assetId: string,
  jobId: string,
  settledAt: string,
): CanvasNode => {
  if (index === 0) {
    return {
      ...placeholder,
      name: `v${placeholder.version} · ${outputNodeName[slot]}`,
      status: 'ready',
      assetId,
    };
  }
  return {
    ...placeholder,
    id: stableOutputId('node', jobId, slot),
    name: `v${placeholder.version} · ${outputNodeName[slot]}`,
    x: placeholder.x + index * (placeholder.width + 48),
    status: 'ready',
    assetId,
    versionId: stableOutputId('version', jobId, slot),
    createdAt: settledAt,
  };
};

/**
 * Builds, but never publishes, an all-or-nothing Workspace candidate.
 * Callers must first atomically persist every returned Blob, attach the three
 * storage records to the Assets, then validate/publish this candidate once.
 */
export const buildProviderResultSettlement = (input: {
  workspace: Workspace;
  projectId: string;
  jobId: string;
  placeholderNodeId: string;
  result: ProviderRunResult;
  settledAt: string;
}): ProviderSettlementResult => {
  if (!isNonEmptyString(input.projectId) || !Number.isFinite(Date.parse(input.settledAt))) {
    return failSettlement('CORE013_SETTLEMENT_TIMESTAMP_INVALID');
  }

  const matchingJobs = input.workspace.jobs.filter((job) => job.id === input.jobId);
  const job = matchingJobs[0];
  if (matchingJobs.length !== 1 || !job || !SETTLEABLE_JOB_STATUSES.has(job.status)) {
    return failSettlement('CORE013_JOB_NOT_SETTLEABLE');
  }
  const validation = validateProviderRunSuccess(input.result, job);
  if (!validation.ok) return failSettlement(validation.code);

  const matchingNodes = input.workspace.nodes.filter((node) => node.id === input.placeholderNodeId);
  const placeholder = matchingNodes[0];
  if (
    matchingNodes.length !== 1
    || !placeholder
    || placeholder.status !== 'generating'
    || placeholder.jobId !== job.id
    || !placeholder.versionId
  ) return failSettlement('CORE013_PLACEHOLDER_NOT_SETTLEABLE');

  const matchingVersions = input.workspace.versions.filter((version) => version.id === placeholder.versionId);
  const placeholderVersion = matchingVersions[0];
  if (
    matchingVersions.length !== 1
    || !placeholderVersion
    || placeholderVersion.canvasObjectId !== placeholder.id
    || placeholderVersion.jobId !== job.id
    || placeholderVersion.status !== 'pending'
  ) return failSettlement('CORE013_PLACEHOLDER_VERSION_INVALID');

  const outputs = validation.value.outputs;
  if (!outputs.every((output) => storedBlobMatches(output.asset, output.blob, input.projectId))) {
    return failSettlement('CORE013_OUTPUT_STORAGE_INVALID');
  }
  const currentAssetIds = new Set(input.workspace.assets.map((asset) => asset.id));
  if (outputs.some((output) => currentAssetIds.has(output.asset.id))) {
    return failSettlement('CORE013_OUTPUT_ID_CONFLICT');
  }

  const nodeIds: string[] = [];
  const versionIds: string[] = [];
  const nodesToAdd: CanvasNode[] = [];
  const versionsToAdd = [] as Workspace['versions'];
  const settledNodes = validation.value.kind === 'single'
    ? [{ ...placeholder, status: 'ready' as const, assetId: outputs[0].asset.id }]
    : outputs.map((output, index) => siblingNode(placeholder, output.slot as ProviderOutputSlot, index, output.asset.id, job.id, input.settledAt));

  for (let index = 0; index < settledNodes.length; index += 1) {
    const node = settledNodes[index];
    const versionId = node.versionId;
    if (!versionId) return failSettlement('CORE013_PLACEHOLDER_VERSION_INVALID');
    nodeIds.push(node.id);
    versionIds.push(versionId);
    if (index > 0) {
      if (
        input.workspace.nodes.some((candidate) => candidate.id === node.id)
        || input.workspace.versions.some((candidate) => candidate.id === versionId)
        || nodesToAdd.some((candidate) => candidate.id === node.id)
        || versionsToAdd.some((candidate) => candidate.id === versionId)
      ) return failSettlement('CORE013_SETTLEMENT_ID_CONFLICT');
      nodesToAdd.push(node);
      versionsToAdd.push({
        ...placeholderVersion,
        id: versionId,
        canvasObjectId: node.id,
        status: 'ready',
        createdAt: input.settledAt,
      });
    }
  }

  const primaryNode = settledNodes[0];
  const workspace: Workspace = {
    ...input.workspace,
    nodes: [
      ...input.workspace.nodes.map((node) => node.id === placeholder.id ? primaryNode : node),
      ...nodesToAdd,
    ],
    jobs: input.workspace.jobs.map((candidate) => candidate.id === job.id
      ? { ...candidate, status: 'succeeded' as const, progress: 1, updatedAt: input.settledAt, error: undefined }
      : candidate),
    assets: [...input.workspace.assets, ...outputs.map((output) => output.asset)],
    versions: [
      ...input.workspace.versions.map((version) => version.id === placeholderVersion.id
        ? { ...version, status: 'ready' as const }
        : version),
      ...versionsToAdd,
    ],
    selectedIds: nodeIds,
  };

  return {
    ok: true,
    kind: validation.value.kind,
    workspace,
    outputIds: {
      nodeIds,
      versionIds,
      assetIds: outputs.map((output) => output.asset.id),
    },
  };
};
