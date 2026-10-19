import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CommandLineIcon,
  CloudArrowUpIcon,
  CursorArrowRaysIcon,
  DocumentDuplicateIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  HomeIcon,
  ArrowUpIcon,
  ArrowDownTrayIcon,
  MinusIcon,
  MoonIcon,
  PhotoIcon,
  PlusIcon,
  Square2StackIcon,
  SparklesIcon,
  StopCircleIcon,
  SunIcon,
  TrashIcon,
  VideoCameraIcon,
  ViewfinderCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampScale,
  clone,
  deleteWorkspaceNodes,
  GENERATED_ASSET,
  loadWorkspace,
  makeMockNode,
  makeReferenceNode,
  makeReferenceVersion,
  makeUploadedReferenceNode,
  nowLabel,
  orderCanvasNodesByLayer,
  persistWorkspace,
  PROJECT_ID,
  REFERENCE_TRANSFER_CONSENT_VERSION,
  workspaceAuditMessage,
  zoomViewportAtPoint,
  type CanvasNode,
  type CreationMode,
  type ImageProviderId,
  type Workspace,
} from './domain';
import { composeExecutionPrompt, evolinkMediaRuntime, localAgentRuntime, providerResultHasOutputSet, type AgentPlan, type Asset, type GenerationJob, type ProviderOutputSet, type ProviderProgress, type ProviderRunResult, type UserIntent, type VersionRecord } from './agent';
import { createDeterministicFallbackPlanning, evolinkPlanner, type PlanningRequest } from './planner';
import { BlobStore, hydrateObjectUrl, type BlobStorageMetadata, type HydratedObjectUrl } from './blob-store';
import { readMediaExportBlob, resolveMediaExportTarget } from './media-export';
import { ImageUploadError, sanitizeUserImageFile } from './image-upload';
import { buildCanvasContextGraphSnapshot } from './canvas-context';
import { buildProviderResultSettlement, validateProviderRunSuccess } from './provider-result-settlement';
import {
  createCreativeDirectorRuntime,
  createMemoryCheckpointStore,
  type AgentCheckpoint,
  type AgentRun,
  type AgentRunState,
  type CreativeDirectorRuntime,
} from './agent-runtime';
import { createCanvasActionExecutor } from './canvas-action-executor';
import { parseCanvasCommand, planCanvasCommand, resizeCanvasNode, type ResizeCorner } from './canvas-commands';
import { applyWorkflowCommand, makeWorkflowNode, resolveWorkflowRequest, type WorkflowCommand, type WorkflowKind } from './workflow-graph';
import { WorkflowCard } from './WorkflowCard';
import { ProviderSettings, useProviderLabels } from './ProviderSettings';
import './workflow.css';
import {
  loadAgentRunPresentation,
  persistedAgentRunBudgetMilestone,
  persistAgentRunPresentation,
  reconcilePersistedAgentRunBudget,
  type PersistedAgentRunPresentation,
} from './agent-run-persistence';
import { createUserReferencePaidBinding, createVideoPaidBinding, mapPlannerCredentialFailure, requestCore009PlannerConfirmation, requestPaidConfirmation, type PaidConfirmationBinding } from './paid-confirmation';
import { captureCanvasTargetBinding, canvasTargetBindingMatches, resolvePendingImageActionId, type CanvasTargetBinding } from './agent-target-binding';
import { captureCore009LiveReceipt, downloadCore009LiveReceipt } from './core009-live-receipt';
import {
  clearPortalDraft,
  consumeHomeWorkspaceHandoff,
  peekHomeWorkspaceHandoff,
  peekPortalDraft,
  type HomeWorkspaceHandoffV1,
  type HomeWorkspaceStagedReferenceV1,
} from './portal-state';

type Tool = 'select' | 'hand';
type PlannedIntent = { intent: UserIntent; plan: AgentPlan } | null;
type PlanningState =
  | { status: 'running'; request: PlanningRequest }
  | { status: 'failed'; request: PlanningRequest; error: { code: string; message: string; retryable: boolean }; fallbackAvailable?: true }
  | null;
type LocalUploadState =
  | { status: 'idle' }
  | { status: 'validating'; progress: number }
  | { status: 'ready'; assetId: string }
  | { status: 'failed'; code: string; message: string };
type DragState =
  | { kind: 'resize'; node: CanvasNode; corner: ResizeCorner; startX: number; startY: number; before: Workspace }
  | { kind: 'node'; ids: string[]; startX: number; startY: number; before: Workspace; positions: Record<string, { x: number; y: number }> }
  | { kind: 'pan'; startX: number; startY: number; viewport: Workspace['viewport'] }
  | { kind: 'marquee'; startX: number; startY: number; endX: number; endY: number }
  | null;

type GenerationExecutionOutcome =
  | {
      ok: true;
      jobId: string;
      /** Primary fields preserve every sealed single-output caller. */
      nodeId: string;
      versionId: string;
      assetId: string;
      /** Canonical one-or-three result set used by typed-action receipts. */
      outputs: ReadonlyArray<{ nodeId: string; versionId: string; assetId: string }>;
      costUsd: number;
    }
  | { ok: false; jobId?: string; nodeId?: string; errorCode: string; retryable: boolean; costUsd: number };

export const generationOutcomeOutputIds = (outcome: {
  jobId: string;
  outputs: ReadonlyArray<{ nodeId: string; versionId: string; assetId: string }>;
}) => [outcome.jobId, ...outcome.outputs.flatMap((output) => [output.assetId, output.nodeId, output.versionId])];

type MilestoneBudgetStatus = { capUsd: number; usedUsd: number; reservationPerAttemptUsd: number; providerReservations?: { planner: number; image: number; video: number } };
type AssetPresentation = { status: 'ready' | 'pending' | 'unavailable' | 'fixed-demo'; url?: string; kind?: Asset['kind'] };
type SendAuthorization = {
  id: string;
  planningEpoch: number;
  requestBinding: string;
  planBinding?: string;
  plannerCalls: number;
  imageCalls: number;
  videoCalls: number;
  reservedCostUsd: number;
  readonly maxPlannerCalls: 1;
  readonly maxImageCalls: 1;
  readonly maxVideoCalls: 1;
  readonly maxGenerationCalls: 1;
  maxCostUsd: number;
  plannerReservationUsd: number;
};

const CANVAS_WIDTH = 3200;
const CANVAS_HEIGHT = 2100;
const AGENT_PANEL_WIDTH_KEY = 'elyra-agent-panel-width-v1';
const PROJECT_AGENT_PANEL_WIDTH_PREFIX = 'elyra-core-012-agent-panel-width-v1:';
const PROJECT_PANEL_STATE_PREFIX = 'elyra-core-012-panel-state-v1:';
const AGENT_PANEL_WIDTH_DEFAULT = 400;
const AGENT_PANEL_WIDTH_MIN = 320;
const AGENT_PANEL_WIDTH_MAX = 520;
const EXECUTING_JOB_STATUSES = new Set<GenerationJob['status']>(['queued', 'validating', 'uploading', 'submitted', 'processing', 'running']);
const SETTLEABLE_JOB_STATUSES = new Set<GenerationJob['status']>([...EXECUTING_JOB_STATUSES, 'local_result_pending']);
const homeHandoffApplications = new Map<string, symbol | 'applied'>();
const externalAssetApplications = new Set<string>();

const homeHandoffCanvasObjectId = (handoffId: string) => `reference-home-${handoffId}`;
const homeHandoffVersionId = (handoffId: string) => `version-home-${handoffId}`;
const homeHandoffMessageId = (handoffId: string) => `system-home-handoff-${handoffId}`;

const stagedReferenceAssetMatches = (asset: Asset, reference: HomeWorkspaceStagedReferenceV1) => Boolean(
  asset.id === reference.assetId
  && asset.kind === 'image'
  && asset.source === 'local-upload'
  && asset.providerId === 'local-upload'
  && asset.mimeType === 'image/png'
  && asset.metadata.deterministic === false
  && asset.metadata.width === reference.width
  && asset.metadata.height === reference.height
  && asset.storage
  && asset.storage.locator === reference.storage.locator
  && asset.storage.projectId === reference.storage.projectId
  && asset.storage.blobKey === reference.storage.blobKey
  && asset.storage.sha256 === reference.storage.sha256
  && asset.storage.bytes === reference.storage.bytes
  && asset.storage.mimeType === reference.storage.mimeType
  && asset.storage.createdAt === reference.storage.createdAt
);

export const applyHomeHandoffToWorkspace = (current: Workspace, handoff: HomeWorkspaceHandoffV1): Workspace => {
  let assets = current.assets;
  let nodes = current.nodes;
  let versions = current.versions;
  let selectedIds = current.selectedIds;

  if (handoff.stagedReference) {
    const reference = handoff.stagedReference;
    const existingAsset = current.assets.find((asset) => asset.id === reference.assetId);
    if (existingAsset && !stagedReferenceAssetMatches(existingAsset, reference)) {
      throw new Error('CORE011_STAGED_REFERENCE_ASSET_CONFLICT');
    }
    if (!existingAsset) {
      const asset: Asset = {
        id: reference.assetId,
        kind: 'image',
        source: 'local-upload',
        providerId: 'local-upload',
        mimeType: 'image/png',
        storage: reference.storage,
        prompt: '用户有权使用的非敏感本地参考图',
        createdAt: reference.storage.createdAt,
        metadata: { deterministic: false, width: reference.width, height: reference.height },
      };
      assets = [...assets, asset];
    }

    const existingReferenceNode = current.nodes.find((node) => node.assetId === reference.assetId);
    if (existingReferenceNode) {
      const existingVersion = existingReferenceNode.versionId
        ? current.versions.find((version) => version.id === existingReferenceNode.versionId && version.canvasObjectId === existingReferenceNode.id)
        : undefined;
      if (existingReferenceNode.kind !== 'reference' || existingReferenceNode.status !== 'ready' || !existingVersion) {
        throw new Error('CORE011_STAGED_REFERENCE_LINEAGE_CONFLICT');
      }
      selectedIds = [existingReferenceNode.id];
    } else {
      const canvasObjectId = homeHandoffCanvasObjectId(handoff.handoffId);
      const versionId = homeHandoffVersionId(handoff.handoffId);
      if (current.nodes.some((node) => node.id === canvasObjectId) || current.versions.some((version) => version.id === versionId)) {
        throw new Error('CORE011_STAGED_REFERENCE_ID_CONFLICT');
      }
      const node = {
        ...makeUploadedReferenceNode({
          id: canvasObjectId,
          assetId: reference.assetId,
          versionId,
          width: reference.width,
          height: reference.height,
          index: current.nodes.filter((item) => item.kind === 'reference').length,
        }),
        createdAt: reference.storage.createdAt,
      };
      const version: VersionRecord = {
        id: versionId,
        canvasObjectId,
        sequence: 0,
        status: 'ready',
        createdAt: reference.storage.createdAt,
      };
      nodes = [...nodes, node];
      versions = [...versions, version];
      selectedIds = [node.id];
    }
  }

  const modeLabel = CREATION_MODE_LABELS[handoff.creationMode];
  const modelLabel = handoff.creationMode === 'agent'
    ? '已配置的 Agent Planner（可在已接入的图片与视频能力间规划）'
    : handoff.creationMode === 'video'
      ? '已配置的视频模型'
      : handoff.imageProviderId === 'evolink-gpt-image-2' ? '已配置的图片模型' : '本地确定性结果';
  const presetLabel = handoff.preset ? `，采用「${handoff.preset.category}」本地模板` : '';
  const referenceLabel = handoff.stagedReference ? '，并带入一张本机参考图' : '';
  const messageId = homeHandoffMessageId(handoff.handoffId);
  const messages = current.messages.some((message) => message.id === messageId) ? current.messages : [
    ...current.messages,
    {
      id: messageId,
      role: 'agent' as const,
      body: `内容已带入工作台：${modeLabel}模式、${modelLabel}${presetLabel}${referenceLabel}。确认后点击发送；首页没有自动生成或扣费。`,
      time: nowLabel(),
    },
  ];

  return {
    ...current,
    creationMode: handoff.creationMode,
    imageProviderId: handoff.imageProviderId,
    assets,
    nodes,
    versions,
    selectedIds,
    messages,
  };
};

const resolveAssetPresentation = (
  node: CanvasNode,
  assets: readonly Asset[],
  assetUrls: ReadonlyMap<string, string>,
  unavailableAssetIds: ReadonlySet<string>,
): AssetPresentation => {
  if (!node.assetId) return node.kind === 'reference'
    ? { status: 'fixed-demo', url: GENERATED_ASSET, kind: 'image' }
    : { status: 'unavailable' };
  const asset = assets.find((item) => item.id === node.assetId);
  if (!asset) return { status: 'unavailable' };
  if (asset.storage) {
    const hydratedUrl = assetUrls.get(asset.id);
    if (hydratedUrl) return { status: 'ready', url: hydratedUrl, kind: asset.kind };
    return { status: unavailableAssetIds.has(asset.id) ? 'unavailable' : 'pending' };
  }
  if (asset.source === 'deterministic-mock' && asset.uri === GENERATED_ASSET) {
    return { status: 'ready', url: GENERATED_ASSET, kind: 'image' };
  }
  return { status: 'unavailable' };
};

const resolveProjectAssetPresentation = (
  asset: Asset,
  assetUrls: ReadonlyMap<string, string>,
  unavailableAssetIds: ReadonlySet<string>,
): AssetPresentation => {
  const url = assetUrls.get(asset.id);
  if (url) return { status: 'ready', url, kind: asset.kind };
  if (!asset.storage && asset.source === 'deterministic-mock' && asset.uri === GENERATED_ASSET) {
    return { status: 'ready', url: GENERATED_ASSET, kind: asset.kind };
  }
  return { status: unavailableAssetIds.has(asset.id) ? 'unavailable' : 'pending', kind: asset.kind };
};

const AGENT_RUN_STATE_LABELS: Record<AgentRunState, string> = {
  OBSERVING: '理解画布',
  PLANNING: '规划动作',
  AWAITING_CONFIRMATION: '准备执行',
  EXECUTING: '执行动作',
  VERIFYING: '验证结果',
  REPLANNING: '重新规划',
  COMPLETED: '已完成',
  FAILED: '已停止',
  CANCELLED: '已取消',
};

const AGENT_ACTION_LABELS: Record<string, string> = {
  create_image_job: '创建图片 Job',
  create_video_job: '创建四秒视频 Job',
  select_objects: '选择画布对象',
  focus_objects: '聚焦画布对象',
  create_version: '创建非破坏式版本',
  ask_user: '等待用户信息',
  finish: '完成运行',
};

const CREATION_MODE_LABELS: Record<CreationMode, string> = {
  agent: 'Agent',
  image: '图片',
  video: '视频',
};

const LOCAL_PLANNER_FAILURES_ALLOWING_FALLBACK = new Set([
  'CORE009_PROTOCOL_MISMATCH',
  'CORE009_LOCAL_SERVICE_UNAVAILABLE',
  'CORE008_PROTOCOL_MISMATCH',
  'CORE008_LOCAL_SERVICE_UNAVAILABLE',
  'CORE008_TICKET_ISSUE_FAILED',
]);
const plannerFailureAllowsFallback = (code: string) => code.startsWith('PLANNER_') || LOCAL_PLANNER_FAILURES_ALLOWING_FALLBACK.has(code);

const planningTargetBindingStillMatches = (workspace: Workspace, request: PlanningRequest) => {
  if (!request.targetCanvasObjectId) return request.targetBinding === undefined;
  return Boolean(
    request.targetBinding
    && request.targetBinding.objectId === request.targetCanvasObjectId
    && canvasTargetBindingMatches(workspace, request.targetBinding),
  );
};

const fallbackAuthorizationIsCurrent = (
  planning: Extract<PlanningState, { status: 'failed' }>,
  authorization: SendAuthorization | null,
  planningEpoch: number,
  workspace: Workspace,
) => Boolean(
  planning.fallbackAvailable === true
  && plannerFailureAllowsFallback(planning.error.code)
  && authorization
  && authorization.planningEpoch === planningEpoch
  && authorization.requestBinding === planningRequestBinding(planning.request)
  && authorization.plannerCalls === 1
  && authorization.planBinding === undefined
  && authorization.imageCalls === 0
  && authorization.videoCalls === 0
  && authorization.reservedCostUsd >= 0
  && authorization.reservedCostUsd <= authorization.plannerReservationUsd
  && planningTargetBindingStillMatches(workspace, planning.request)
);

// Video polling has its own twelve-minute bounded wait. Keep the enclosing
// Agent run alive slightly longer so that polling can settle into a safe
// status-only retry instead of being misclassified as a user cancellation by
// the generic two-minute runtime deadline.
const IMAGE_AGENT_RUN_DEADLINE_MS = 120_000;
const VIDEO_AGENT_RUN_DEADLINE_MS = 13 * 60_000;

const clampAgentPanelWidth = (value: number) => Math.min(AGENT_PANEL_WIDTH_MAX, Math.max(AGENT_PANEL_WIDTH_MIN, Math.round(value)));
const agentPanelWidthStorageKey = (projectId: string) => projectId === PROJECT_ID
  ? AGENT_PANEL_WIDTH_KEY
  : `${PROJECT_AGENT_PANEL_WIDTH_PREFIX}${projectId}`;
const panelStateStorageKey = (projectId: string) => `${PROJECT_PANEL_STATE_PREFIX}${projectId}`;
const loadAgentPanelWidth = (projectId = PROJECT_ID) => {
  const stored = Number(window.localStorage.getItem(agentPanelWidthStorageKey(projectId)));
  return Number.isFinite(stored) && stored > 0 ? clampAgentPanelWidth(stored) : AGENT_PANEL_WIDTH_DEFAULT;
};
const loadActiveProjectPanel = (projectId: string): 'none' | 'layers' | 'assets' => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(panelStateStorageKey(projectId)) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'none';
    const value = (parsed as { activePanel?: unknown }).activePanel;
    return value === 'layers' || value === 'assets' ? value : 'none';
  } catch {
    return 'none';
  }
};

const isAgentRunActive = (run: AgentRun | null | undefined) => Boolean(run && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state));
const workspaceHasActiveJob = (current: Workspace) => current.jobs.some((job) => EXECUTING_JOB_STATUSES.has(job.status));

const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const planningRequestBinding = (request: PlanningRequest) => JSON.stringify(request);
const planBinding = (intent: UserIntent, plan: AgentPlan) => `${intent.id}:${plan.id}:${intent.operation}:${plan.providerId}`;
const createSendAuthorization = (request: PlanningRequest, planningEpoch: number): SendAuthorization => ({
  id: `send-${crypto.randomUUID().replaceAll('-', '')}`,
  planningEpoch,
  requestBinding: planningRequestBinding(request),
  plannerCalls: 0,
  imageCalls: 0,
  videoCalls: 0,
  reservedCostUsd: 0,
  maxPlannerCalls: 1,
  maxImageCalls: 1,
  maxVideoCalls: 1,
  maxGenerationCalls: 1,
  maxCostUsd: 1.05,
  plannerReservationUsd: 0.05,
});
const consumePlannerAuthorization = (authorization: SendAuthorization, request: PlanningRequest, planningEpoch: number) => {
  if (
    authorization.planningEpoch !== planningEpoch
    || authorization.requestBinding !== planningRequestBinding(request)
    || authorization.plannerCalls >= authorization.maxPlannerCalls
    || authorization.reservedCostUsd + authorization.plannerReservationUsd > authorization.maxCostUsd
  ) return false;
  authorization.plannerCalls += 1;
  authorization.reservedCostUsd = Number((authorization.reservedCostUsd + authorization.plannerReservationUsd).toFixed(8));
  return true;
};
const bindAuthorizationPlan = (authorization: SendAuthorization, intent: UserIntent, plan: AgentPlan) => {
  const binding = planBinding(intent, plan);
  if (authorization.planBinding && authorization.planBinding !== binding) return false;
  authorization.planBinding = binding;
  return true;
};
const consumeImageAuthorization = (authorization: SendAuthorization, intent: UserIntent, plan: AgentPlan, estimatedCostUsd: number) => {
  if (
    authorization.planBinding !== planBinding(intent, plan)
    || authorization.imageCalls >= authorization.maxImageCalls
    || authorization.imageCalls + authorization.videoCalls >= authorization.maxGenerationCalls
    || !Number.isFinite(estimatedCostUsd)
    || estimatedCostUsd < 0
    || authorization.reservedCostUsd + estimatedCostUsd > authorization.maxCostUsd
  ) return false;
  authorization.imageCalls += 1;
  authorization.reservedCostUsd = Number((authorization.reservedCostUsd + estimatedCostUsd).toFixed(8));
  return true;
};
const consumeVideoAuthorization = (authorization: SendAuthorization, intent: UserIntent, plan: AgentPlan, estimatedCostUsd: number) => {
  if (
    authorization.planBinding !== planBinding(intent, plan)
    || authorization.videoCalls >= authorization.maxVideoCalls
    || authorization.imageCalls + authorization.videoCalls >= authorization.maxGenerationCalls
    || !Number.isFinite(estimatedCostUsd)
    || estimatedCostUsd < 0
    || authorization.reservedCostUsd + estimatedCostUsd > authorization.maxCostUsd
  ) return false;
  authorization.videoCalls += 1;
  authorization.reservedCostUsd = Number((authorization.reservedCostUsd + estimatedCostUsd).toFixed(8));
  return true;
};
const formatScale = (scale: number) => `${Math.round(scale * 100)}%`;
const runtimeFor = (providerId: string) => providerId === 'evolink-gpt-image-2' || providerId === 'evolink-sora-2-preview' ? evolinkMediaRuntime : localAgentRuntime;
const restorePendingPlan = (workspace: Workspace): PlannedIntent => {
  if (!workspace.pendingPlanId) return null;
  const nextPlan = workspace.plans.find((item) => item.id === workspace.pendingPlanId && item.status === 'proposed');
  const intent = nextPlan ? workspace.intents.find((item) => item.id === nextPlan.intentId) : undefined;
  return nextPlan && intent ? { intent, plan: nextPlan } : null;
};

export type AssetAddRequest = { requestId: string; assetId: string };
export type AssetAddResult = AssetAddRequest & { ok: boolean; code?: 'ASSET_NOT_FOUND' | 'ASSET_UNAVAILABLE' | 'WORKSPACE_LOCKED' };

export interface AppProps {
  projectId?: string;
  projectTitle?: string;
  onExitWorkspace?: () => void;
  onRegisterLeaveGuard?: (guard: (() => boolean) | null) => void;
  onTrashProject?: (projectId: string) => void | boolean | Promise<void | boolean>;
  onOpenAssetLibrary?: (projectId: string) => void;
  assetToAdd?: AssetAddRequest;
  onAssetAdded?: (result: AssetAddResult) => void;
  skillToRun?: import('./skill-launch').PendingSkillRun;
  onClaimSkillRun?: (id: string, projectId: string) => boolean;
}

export const persistWorkspaceBeforeProjectExit = (
  workspace: Workspace,
  projectId: string,
  storage: Pick<Storage, 'setItem'>,
) => persistWorkspace(workspace, storage, projectId);

export const reuseProjectAssetOnCanvas = (
  current: Workspace,
  assetId: string,
  options: { canvasObjectId?: string; versionId?: string; createdAt?: string } = {},
): Workspace | undefined => {
  const asset = current.assets.find((item) => item.id === assetId);
  if (!asset) return undefined;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const canvasObjectId = options.canvasObjectId ?? uniqueId('asset-object');
  const versionId = options.versionId ?? uniqueId('asset-version');
  if (current.nodes.some((node) => node.id === canvasObjectId) || current.versions.some((version) => version.id === versionId)) return undefined;
  const index = current.nodes.length;
  const sourceWidth = Math.max(1, asset.metadata.width || (asset.kind === 'video' ? 1280 : 1024));
  const sourceHeight = Math.max(1, asset.metadata.height || (asset.kind === 'video' ? 720 : 1024));
  const maxDisplay = asset.kind === 'video' ? 420 : 390;
  const ratio = Math.min(1, maxDisplay / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(160, Math.round(sourceWidth * ratio));
  const height = Math.max(120, Math.round(sourceHeight * ratio));
  const visibleCenterX = (CANVAS_WIDTH / 2 - current.viewport.x) / current.viewport.scale;
  const visibleCenterY = (CANVAS_HEIGHT / 2 - current.viewport.y) / current.viewport.scale;
  const node: CanvasNode = {
    id: canvasObjectId,
    kind: 'generated',
    name: asset.kind === 'video' ? '资产库 · 视频' : '资产库 · 图片',
    x: Math.round(visibleCenterX - width / 2 + (index % 5) * 24),
    y: Math.round(visibleCenterY - height / 2 + (index % 5) * 24),
    width,
    height,
    status: 'ready',
    version: 1,
    prompt: '从当前项目资产库复用，未复制媒体 Blob',
    createdAt,
    assetId: asset.id,
    versionId,
  };
  const version: VersionRecord = {
    id: versionId,
    canvasObjectId,
    sequence: 1,
    status: 'ready',
    createdAt,
  };
  return {
    ...current,
    nodes: [...current.nodes, node],
    versions: [...current.versions, version],
    selectedIds: [node.id],
  };
};

export const deleteCanvasNodesKeepingProjectAssets = (
  current: Workspace,
  ids: string[],
  reason: 'delete' | 'soft-cancel' = 'delete',
) => {
  const result = deleteWorkspaceNodes(current, ids, { reason });
  if (!result.ok || reason === 'soft-cancel') return result;
  return { ...result, workspace: { ...result.workspace, assets: current.assets } };
};

function App({
  projectId = PROJECT_ID,
  projectTitle = '便携式无线音箱视觉创作',
  onExitWorkspace,
  onRegisterLeaveGuard,
  onTrashProject,
  onOpenAssetLibrary,
  assetToAdd,
  onAssetAdded,
  skillToRun,
  onClaimSkillRun,
}: AppProps) {
  const providerLabels = useProviderLabels();
  const [homeHandoff] = useState(() => peekHomeWorkspaceHandoff(Date.now(), projectId));
  const [workspace, setWorkspace] = useState<Workspace>(() => loadWorkspace(projectId));
  const workspaceRef = useRef(workspace);
  const [past, setPast] = useState<Workspace[]>([]);
  const [future, setFuture] = useState<Workspace[]>([]);
  const pastRef = useRef<Workspace[]>([]);
  const futureRef = useRef<Workspace[]>([]);
  const [draft, setDraft] = useState(() => homeHandoff ? '' : peekPortalDraft() ?? '');
  const [plan, setPlan] = useState<PlannedIntent>(() => restorePendingPlan(workspace));
  const [planning, setPlanning] = useState<PlanningState>(null);
  const [sendSubmissionInFlight, setSendSubmissionInFlight] = useState(false);
  const planningRef = useRef<PlanningState>(planning);
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [restoredAgentRun, setRestoredAgentRun] = useState<PersistedAgentRunPresentation | undefined>(() => loadAgentRunPresentation(window.localStorage, projectId));
  const [restoredBudgetStatus, setRestoredBudgetStatus] = useState<'not-applicable' | 'checking' | 'authoritative' | 'unavailable'>(() => {
    const restored = loadAgentRunPresentation(window.localStorage, projectId);
    return restored && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(restored.state) ? 'checking' : 'not-applicable';
  });
  const [localUpload, setLocalUpload] = useState<LocalUploadState>({ status: 'idle' });
  const [transferConsentChecked, setTransferConsentChecked] = useState(false);
  const [assetUrls, setAssetUrls] = useState<Map<string, string>>(() => new Map());
  const [unavailableAssetIds, setUnavailableAssetIds] = useState<Set<string>>(() => new Set());
  const [tool, setTool] = useState<Tool>('select');
  const [drag, setDrag] = useState<DragState>(null);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => loadActiveProjectPanel(projectId) === 'layers');
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(() => loadActiveProjectPanel(projectId) === 'assets');
  const [exportStatus, setExportStatus] = useState<'idle' | 'working' | 'success' | 'failed'>('idle');
  const [exportError, setExportError] = useState('');
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [preparedExport, setPreparedExport] = useState<{ url: string; filename: string; key: string } | null>(null);
  const exportRequestRef = useRef(0);
  const exportTargetKey = resolveMediaExportTarget(workspace, projectId)?.key;
  useEffect(() => () => { if (preparedExport) URL.revokeObjectURL(preparedExport.url); }, [preparedExport]);
  useEffect(() => {
    exportRequestRef.current += 1;
    setPreparedExport(null);
    setExportError('');
    setExportStatus('idle');
  }, [exportTargetKey]);
  const [agentPanelWidth, setAgentPanelWidth] = useState(() => loadAgentPanelWidth(projectId));
  const [mobilePane, setMobilePane] = useState<'agent' | 'canvas'>('canvas');
  const [canvasToolStatus, setCanvasToolStatus] = useState<string>('');
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; sourceId?: string } | null>(null);
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  const [connectionPoint, setConnectionPoint] = useState<{ x: number; y: number } | null>(null);
  const portDragRef = useRef<{ sourceId: string; x: number; y: number } | null>(null);
  const [workflowRunning, setWorkflowRunning] = useState<string | null>(null);
  const workflowRunningRef = useRef<string | null>(null);
  const [workflowErrors, setWorkflowErrors] = useState<Record<string, string>>({});
  const agentPanelWidthRef = useRef(agentPanelWidth);
  const agentResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const settlingJobPromisesRef = useRef(new Map<string, Promise<ProviderRunResult | undefined>>());
  const hydratedUrlsRef = useRef(new Map<string, HydratedObjectUrl>());
  const blobStoreRef = useRef(new BlobStore());
  const agentRunRef = useRef<AgentRun | null>(null);
  const agentRunEpochRef = useRef(0);
  const planningEpochRef = useRef(0);
  const sendSubmissionInFlightRef = useRef(false);
  const plannerConfirmationInFlightRef = useRef(false);
  const plannerAbortControllerRef = useRef<AbortController | null>(null);
  const plannerTargetBindingRef = useRef<CanvasTargetBinding | null>(null);
  const plannerProviderRequestEpochRef = useRef<number | null>(null);
  const imageConfirmationInFlightRef = useRef(false);
  const sendAuthorizationRef = useRef<SendAuthorization | null>(null);
  const agentTargetBindingsRef = useRef(new Map<string, CanvasTargetBinding>());
  const creativeDirectorRuntimeRef = useRef<CreativeDirectorRuntime | null>(null);
  const runStartInFlightRef = useRef(false);
  const providerRecoveryInFlightRef = useRef(new Set<string>());
  const jobHistorySnapshotsRef = useRef(new Map<string, Workspace>());
  const localImportInFlightRef = useRef(false);
  const appInstanceActiveRef = useRef(true);

  const executionBoundaryActive = (includePlanning = true) => (
    isAgentRunActive(agentRunRef.current)
    || workspaceHasActiveJob(workspaceRef.current)
    || abortControllersRef.current.size > 0
    || runStartInFlightRef.current
    || localImportInFlightRef.current
    || providerRecoveryInFlightRef.current.size > 0
    || (includePlanning && (
      sendSubmissionInFlightRef.current
      || Boolean(planningRef.current && planningRef.current.status !== 'failed')
    ))
  );

  useEffect(() => {
    agentPanelWidthRef.current = agentPanelWidth;
  }, [agentPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(agentPanelWidthStorageKey(projectId), String(agentPanelWidth));
  }, [agentPanelWidth, projectId]);

  useEffect(() => {
    const activePanel = assetLibraryOpen ? 'assets' : inspectorOpen ? 'layers' : 'none';
    window.localStorage.setItem(panelStateStorageKey(projectId), JSON.stringify({ activePanel }));
  }, [assetLibraryOpen, inspectorOpen, projectId]);

  useEffect(() => {
    clearPortalDraft();
  }, []);

  useEffect(() => {
    planningRef.current = planning;
  }, [planning]);

  useEffect(() => () => document.body.classList.remove('is-resizing-agent'), []);

  useEffect(() => {
    let disposed = false;
    const hydrate = async () => {
      const next = new Map<string, string>();
      const nextHydrated = new Map<string, HydratedObjectUrl>();
      const nextUnavailable = new Set<string>();
      for (const asset of workspace.assets) {
        if (!asset.storage) {
          if (asset.source === 'deterministic-mock' && asset.uri === GENERATED_ASSET) next.set(asset.id, GENERATED_ASSET);
          else nextUnavailable.add(asset.id);
          continue;
        }
        try {
          const hydrated = await hydrateObjectUrl(blobStoreRef.current, asset.storage);
          if (!hydrated || disposed) {
            hydrated?.revoke();
            if (!disposed) nextUnavailable.add(asset.id);
            continue;
          }
          nextHydrated.set(asset.id, hydrated);
          next.set(asset.id, hydrated.url);
        } catch {
          // A missing/corrupt local Blob is shown as unavailable; metadata stays
          // intact so the user can retry local recovery without a paid Job.
          nextUnavailable.add(asset.id);
        }
      }
      if (disposed) { for (const item of nextHydrated.values()) item.revoke(); return; }
      for (const item of hydratedUrlsRef.current.values()) item.revoke();
      hydratedUrlsRef.current = nextHydrated;
      setAssetUrls(next);
      setUnavailableAssetIds(nextUnavailable);
    };
    void hydrate();
    return () => { disposed = true; };
  }, [workspace.assets]);

  useEffect(() => {
    appInstanceActiveRef.current = true;
    return () => {
      appInstanceActiveRef.current = false;
      // Invalidate late continuations before aborting transports. A keyed
      // project remount must not allow an old App instance to publish afterward.
      planningEpochRef.current += 1;
      agentRunEpochRef.current += 1;
      sendAuthorizationRef.current = null;
      plannerAbortControllerRef.current?.abort();
      for (const controller of abortControllersRef.current.values()) controller.abort();
      for (const hydrated of hydratedUrlsRef.current.values()) hydrated.revoke();
      hydratedUrlsRef.current.clear();
    };
  }, []);

  const replace = useCallback((next: Workspace) => {
    workspaceRef.current = next;
    setWorkspace(next);
  }, []);

  const syncAgentRun = useCallback((run: AgentRun, expectedEpoch?: number) => {
    if (expectedEpoch !== undefined && expectedEpoch !== agentRunEpochRef.current) return;
    const snapshot = clone(run);
    agentRunRef.current = snapshot;
    setAgentRun(snapshot);
    persistAgentRunPresentation(snapshot, window.localStorage, projectId);
    setRestoredAgentRun(loadAgentRunPresentation(window.localStorage, projectId));
  }, [projectId]);

  const readMilestoneBudgetStatus = useCallback(async (route: string, expectedCapUsd: number): Promise<MilestoneBudgetStatus> => {
    const response = await fetch(route, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null) as Partial<MilestoneBudgetStatus> | null;
    if (
      !response.ok
      || body?.capUsd !== expectedCapUsd
      || typeof body.usedUsd !== 'number'
      || !Number.isFinite(body.usedUsd)
      || body.usedUsd < 0
      || body.usedUsd > body.capUsd
      || typeof body.reservationPerAttemptUsd !== 'number'
      || !Number.isFinite(body.reservationPerAttemptUsd)
      || body.reservationPerAttemptUsd <= 0
      || body.reservationPerAttemptUsd > 5
      || (body.providerReservations && ['planner', 'image', 'video'].some(role => {
        const amount = body.providerReservations![role as 'planner' | 'image' | 'video'];
        return typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 5;
      }))
    ) throw new Error('MILESTONE_BUDGET_STATUS_INVALID');
    return body as MilestoneBudgetStatus;
  }, []);
  const readCore008BudgetStatus = useCallback(
    () => readMilestoneBudgetStatus('/api/agent/core-008-budget', 5),
    [readMilestoneBudgetStatus],
  );
  const readCore009BudgetStatus = useCallback(
    () => readMilestoneBudgetStatus('/api/agent/core-009-budget', 5),
    [readMilestoneBudgetStatus],
  );

  useEffect(() => {
    const restored = loadAgentRunPresentation(window.localStorage, projectId);
    if (!restored || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(restored.state)) return;
    let disposed = false;
    setRestoredBudgetStatus('checking');
    const restoredMilestone = persistedAgentRunBudgetMilestone(restored);
    const readAuthoritativeBudget = restoredMilestone === 'CORE009' ? readCore009BudgetStatus : readCore008BudgetStatus;
    void readAuthoritativeBudget().then((budget) => {
      if (disposed) return;
      const reconciled = reconcilePersistedAgentRunBudget(
        { milestone: restoredMilestone, capUsd: budget.capUsd, usedUsd: budget.usedUsd },
        window.localStorage,
        new Date().toISOString(),
        projectId,
      );
      if (!reconciled) {
        setRestoredBudgetStatus('unavailable');
        return;
      }
      setRestoredAgentRun(reconciled);
      setRestoredBudgetStatus('authoritative');
    }).catch(() => {
      if (!disposed) setRestoredBudgetStatus('unavailable');
    });
    return () => { disposed = true; };
  }, [projectId, readCore008BudgetStatus, readCore009BudgetStatus]);

  const commit = useCallback((recipe: (current: Workspace) => Workspace) => {
    const before = clone(workspaceRef.current);
    const next = recipe(clone(before));
    const history = [...pastRef.current.slice(-49), before];
    pastRef.current = history;
    futureRef.current = [];
    setPast(history);
    setFuture([]);
    replace(next);
  }, [replace]);

  const replaceWithoutHistory = useCallback((recipe: (current: Workspace) => Workspace) => {
    replace(recipe(clone(workspaceRef.current)));
  }, [replace]);

  const attemptWorkspaceExit = useCallback(() => {
    if (executionBoundaryActive()) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, {
          id: uniqueId('system'),
          role: 'system',
          body: '当前规划或媒体任务仍在运行。请等待任务结束或先取消，再返回项目页。',
          time: nowLabel(),
        }],
      }));
      return false;
    }
    try {
      // A passive Effect may not run after an immediate keyed unmount. Seal
      // the exact current project before Root changes the active catalog item.
      persistWorkspaceBeforeProjectExit(workspaceRef.current, projectId, window.localStorage);
      return true;
    } catch {
      window.alert('当前项目无法写入本机存储，已阻止切换。画布仍保持在当前页面，请先释放浏览器存储空间后重试。');
      return false;
    }
  }, [projectId, replaceWithoutHistory]);

  useEffect(() => {
    onRegisterLeaveGuard?.(attemptWorkspaceExit);
    return () => onRegisterLeaveGuard?.(null);
  }, [attemptWorkspaceExit, onRegisterLeaveGuard]);

  const requestExitWorkspace = () => {
    if (!attemptWorkspaceExit()) return;
    onExitWorkspace?.();
  };

  // IndexedDB bytes are deliberately outside the serializable Workspace.
  // Any mutation that adds or removes such bytes forms a non-undoable storage
  // boundary so undo/redo can never restore metadata whose Blob was deleted,
  // or leave an orphan Blob after undoing its Canvas Object.
  const commitStorageBoundary = useCallback((recipe: (current: Workspace) => Workspace) => {
    jobHistorySnapshotsRef.current.clear();
    pastRef.current = [];
    futureRef.current = [];
    setPast([]);
    setFuture([]);
    replace(recipe(clone(workspaceRef.current)));
  }, [replace]);

  const publishAddedStorageBoundary = useCallback((next: Workspace) => {
    // New Blob bytes are already durable in IndexedDB. Seal their allowlisted
    // graph metadata synchronously before publishing the UI so an immediate
    // reload cannot expose a successful object that has no durable lineage.
    persistWorkspace(next, window.localStorage, projectId);
    commitStorageBoundary(() => next);
  }, [commitStorageBoundary, projectId]);

  useEffect(() => {
    if (!homeHandoff || homeHandoffApplications.has(homeHandoff.handoffId)) return;
    const applicationToken = Symbol(homeHandoff.handoffId);
    homeHandoffApplications.set(homeHandoff.handoffId, applicationToken);
    let active = true;

    const apply = async () => {
      try {
        if (homeHandoff.stagedReference) {
          const blob = await blobStoreRef.current.get(homeHandoff.stagedReference.storage);
          if (
            !blob
            || blob.type !== 'image/png'
            || blob.size !== homeHandoff.stagedReference.storage.bytes
          ) throw new Error('CORE011_STAGED_REFERENCE_UNAVAILABLE');
        }
        if (!active || homeHandoffApplications.get(homeHandoff.handoffId) !== applicationToken) return;

        const stillPending = peekHomeWorkspaceHandoff(Date.now(), projectId);
        if (!stillPending || stillPending.handoffId !== homeHandoff.handoffId) {
          throw new Error('CORE011_HANDOFF_EXPIRED_OR_REPLACED');
        }
        const next = applyHomeHandoffToWorkspace(clone(workspaceRef.current), homeHandoff);
        if (homeHandoff.stagedReference) await buildCanvasContextGraphSnapshot(next);
        if (!active || homeHandoffApplications.get(homeHandoff.handoffId) !== applicationToken) return;
        const finalPending = peekHomeWorkspaceHandoff(Date.now(), projectId);
        if (!finalPending || finalPending.handoffId !== homeHandoff.handoffId) {
          throw new Error('CORE011_HANDOFF_EXPIRED_OR_REPLACED');
        }

        // Durably publish the prefill metadata before removing its one-use
        // session record. No Planner, Intent, Job or Provider path is invoked.
        persistWorkspace(next, window.localStorage, projectId);
        const consumed = consumeHomeWorkspaceHandoff(homeHandoff.handoffId, Date.now(), projectId);
        if (!consumed) throw new Error('CORE011_HANDOFF_CONSUME_FAILED');
        homeHandoffApplications.set(homeHandoff.handoffId, 'applied');
        commitStorageBoundary(() => next);
        setDraft(homeHandoff.prompt);
        if (homeHandoff.stagedReference) {
          setLocalUpload({ status: 'ready', assetId: homeHandoff.stagedReference.assetId });
        }
      } catch (error) {
        if (active && homeHandoffApplications.get(homeHandoff.handoffId) === applicationToken) {
          homeHandoffApplications.delete(homeHandoff.handoffId);
          if (homeHandoff.stagedReference) {
            setLocalUpload({
              status: 'failed',
              code: error instanceof Error ? error.message : 'CORE011_HANDOFF_FAILED',
              message: '首页参考图未能安全进入画布。提示词尚未执行，请返回首页重新选择后再试。',
            });
          }
          replaceWithoutHistory((current) => {
            const messageId = `system-home-handoff-failed-${homeHandoff.handoffId}`;
            if (current.messages.some((message) => message.id === messageId)) return current;
            return {
              ...current,
              messages: [...current.messages, {
                id: messageId,
                role: 'system' as const,
                body: '首页内容交接失败，未创建任务、未调用 Provider，也未产生费用。请返回首页重试。',
                time: nowLabel(),
              }],
            };
          });
        }
      }
    };

    void apply();
    return () => {
      active = false;
      if (homeHandoffApplications.get(homeHandoff.handoffId) === applicationToken) {
        homeHandoffApplications.delete(homeHandoff.handoffId);
      }
    };
  }, [commitStorageBoundary, homeHandoff, projectId, replaceWithoutHistory]);

  const settleJobTransaction = useCallback((
    jobId: string,
    recipe: (current: Workspace) => Workspace,
    options: { storageBoundary?: boolean } = {},
  ) => {
    const actionBefore = jobHistorySnapshotsRef.current.get(jobId);
    jobHistorySnapshotsRef.current.delete(jobId);
    if (options.storageBoundary) {
      commitStorageBoundary(recipe);
      return;
    }
    if (!actionBefore) {
      replaceWithoutHistory(recipe);
      return;
    }
    const history = [...pastRef.current.slice(-49), clone(actionBefore)];
    pastRef.current = history;
    futureRef.current = [];
    setPast(history);
    setFuture([]);
    replace(recipe(clone(workspaceRef.current)));
  }, [commitStorageBoundary, replace, replaceWithoutHistory]);

  useEffect(() => {
    // `replace` is the single writer for workspaceRef. An older passive Effect
    // must never roll a newer synchronous durable commit back into localStorage.
    if (workspaceRef.current !== workspace) return;
    persistWorkspace(workspace, window.localStorage, projectId);
  }, [projectId, workspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'Escape') { setConnectionSource(null); setNodeMenu(null); setContextMenu(null); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) {
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const undo = useCallback(() => {
    if (executionBoundaryActive()) return;
    const previous = pastRef.current.at(-1);
    if (!previous) return;
    const nextPast = pastRef.current.slice(0, -1);
    const nextFuture = [clone(workspaceRef.current), ...futureRef.current].slice(0, 50);
    pastRef.current = nextPast;
    futureRef.current = nextFuture;
    setPast(nextPast);
    setFuture(nextFuture);
    replace(clone(previous));
  }, [replace]);

  const redo = useCallback(() => {
    if (executionBoundaryActive()) return;
    const next = futureRef.current[0];
    if (!next) return;
    const nextFuture = futureRef.current.slice(1);
    const nextPast = [...pastRef.current.slice(-49), clone(workspaceRef.current)];
    futureRef.current = nextFuture;
    pastRef.current = nextPast;
    setFuture(nextFuture);
    setPast(nextPast);
    replace(clone(next));
  }, [replace]);

  const addReference = () => {
    if (workspaceHasActiveJob(workspaceRef.current)) return;
    if (workspaceRef.current.nodes.some((node) => node.id === 'reference-demo')) return;
    const reference = makeReferenceNode();
    const referenceVersion = makeReferenceVersion();
    commit((current) => ({
      ...current,
      nodes: [...current.nodes, reference],
      versions: current.versions.some((version) => version.id === referenceVersion.id) ? current.versions : [...current.versions, referenceVersion],
      selectedIds: ['reference-demo'],
      messages: [...current.messages, { id: uniqueId('agent'), role: 'agent', body: '已添加本地静态演示参考图。现在可以描述你想要的视觉方向。', time: nowLabel() }],
    }));
  };

  const chooseReferenceFile = () => {
    if (workspaceHasActiveJob(workspaceRef.current)) return;
    fileInputRef.current?.click();
  };

  const importUserReference = async (file: File | undefined) => {
    if (!file || executionBoundaryActive()) return;
    localImportInFlightRef.current = true;
    const baseWorkspace = workspaceRef.current;
    setLocalUpload({ status: 'validating', progress: 12 });
    let stagedStorage: NonNullable<Asset['storage']> | undefined;
    let storagePublished = false;
    try {
      const sanitized = await sanitizeUserImageFile(file, { projectId });
      if (!appInstanceActiveRef.current) throw new Error('APP_INSTANCE_DISPOSED');
      setLocalUpload({ status: 'validating', progress: 68 });
      const storage = await blobStoreRef.current.put(projectId, sanitized.sanitizedBlob, {
        blobKey: sanitized.storage.blobKey,
        mimeType: 'image/png',
        createdAt: sanitized.storage.createdAt,
      });
      stagedStorage = storage;
      if (!appInstanceActiveRef.current) throw new Error('APP_INSTANCE_DISPOSED');
      if (storage.sha256 !== sanitized.storage.sha256 || storage.bytes !== sanitized.storage.bytes || storage.locator !== sanitized.storage.locator) {
        await blobStoreRef.current.delete(storage, { expectedProjectId: projectId }).catch(() => undefined);
        throw new Error('LOCAL_REFERENCE_STORAGE_MISMATCH');
      }
      if (workspaceHasActiveJob(workspaceRef.current)) {
        await blobStoreRef.current.delete(storage, { expectedProjectId: projectId }).catch(() => undefined);
        throw new Error('WORKSPACE_MUTATION_LOCKED');
      }
      const canvasObjectId = uniqueId('reference');
      const versionId = uniqueId('version');
      const asset: Asset = {
        id: sanitized.assetId,
        kind: 'image',
        source: 'local-upload',
        providerId: 'local-upload',
        mimeType: 'image/png',
        storage,
        prompt: '用户有权使用的非敏感本地参考图',
        createdAt: storage.createdAt,
        metadata: { deterministic: false, width: sanitized.width, height: sanitized.height },
      };
      const version: VersionRecord = {
        id: versionId,
        canvasObjectId,
        sequence: 0,
        status: 'ready',
        createdAt: storage.createdAt,
      };
      const node = makeUploadedReferenceNode({
        id: canvasObjectId,
        assetId: asset.id,
        versionId,
        width: sanitized.width,
        height: sanitized.height,
        index: workspaceRef.current.nodes.filter((item) => item.kind === 'reference').length,
      });
      const next = {
        ...clone(baseWorkspace),
        imageProviderId: 'evolink-gpt-image-2' as const,
        assets: [...baseWorkspace.assets, asset],
        versions: [...baseWorkspace.versions, version],
        nodes: [...baseWorkspace.nodes, node],
        selectedIds: [node.id],
        messages: [...baseWorkspace.messages, { id: uniqueId('agent'), role: 'agent' as const, body: '参考图已在本机完成解码、去元数据并保存。只有你确认数据边界后，净化副本才会传输给 EvoLink。', time: nowLabel() }],
      } satisfies Workspace;
      await buildCanvasContextGraphSnapshot(next);
      if (!appInstanceActiveRef.current || workspaceRef.current !== baseWorkspace || workspaceHasActiveJob(workspaceRef.current)) {
        throw new Error('LOCAL_REFERENCE_IMPORT_STALE');
      }
      publishAddedStorageBoundary(next);
      storagePublished = true;
      if (appInstanceActiveRef.current) setLocalUpload({ status: 'ready', assetId: asset.id });
    } catch (error) {
      if (stagedStorage && !storagePublished) {
        await blobStoreRef.current.delete(stagedStorage, { expectedProjectId: projectId }).catch(() => undefined);
      }
      const code = error instanceof ImageUploadError ? error.code : error instanceof Error ? error.message : 'LOCAL_REFERENCE_IMPORT_FAILED';
      const message = error instanceof ImageUploadError ? error.message : '无法安全导入这张图片，请检查格式、大小和文件完整性。';
      if (appInstanceActiveRef.current) setLocalUpload({ status: 'failed', code, message });
    } finally {
      localImportInFlightRef.current = false;
      if (appInstanceActiveRef.current && fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const runAuthorizedAgentPlanner = async (
    request: PlanningRequest,
    planningEpoch: number,
    targetBinding: CanvasTargetBinding | undefined,
    authorization: SendAuthorization,
  ) => {
    if (plannerConfirmationInFlightRef.current) return;
    if (executionBoundaryActive(false)) {
      setPlanning({ status: 'failed', request, error: { code: 'CORE008_CONCURRENT_EXECUTION_BLOCKED', message: '另一个 Agent 或媒体任务尚未结束；未签发 Planner 发送授权凭证。', retryable: true } });
      return;
    }
    if (
      sendAuthorizationRef.current !== authorization
      || !consumePlannerAuthorization(authorization, request, planningEpoch)
    ) {
      setPlanning({ status: 'failed', request, error: { code: 'CORE008_SEND_AUTHORIZATION_EXHAUSTED', message: '本次发送的 Planner 授权已使用或与当前请求不匹配；未调用 Provider。', retryable: false } });
      return;
    }
    plannerConfirmationInFlightRef.current = true;
    const targetIsCurrent = () => !request.targetCanvasObjectId || Boolean(
      targetBinding
      && targetBinding.objectId === request.targetCanvasObjectId
      && canvasTargetBindingMatches(workspaceRef.current, targetBinding),
    );
    if (!targetIsCurrent()) {
      plannerConfirmationInFlightRef.current = false;
      plannerTargetBindingRef.current = null;
      setPlanning({ status: 'failed', request, error: { code: 'CORE008_TARGET_BINDING_STALE', message: '引用对象、Asset 或 Version 已变化；未签发付费凭证，也未调用 Planner。', retryable: false } });
      return;
    }
    const controller = new AbortController();
    plannerAbortControllerRef.current = controller;
    setPlanning({ status: 'running', request });
    try {
      const paidConfirmationToken = await requestCore009PlannerConfirmation({
        route: '/api/agent/plans',
        body: {
          prompt: request.prompt,
          imageProviderId: request.imageProviderId,
          ...(request.videoProviderId ? { videoProviderId: request.videoProviderId } : {}),
          ...(request.creationMode ? { creationMode: request.creationMode } : {}),
          ...(request.selectedCanvasObjectCount !== undefined ? { selectedCanvasObjectCount: request.selectedCanvasObjectCount } : {}),
          ...(request.targetCanvasObjectId ? { targetCanvasObjectId: request.targetCanvasObjectId } : {}),
          ...(request.targetBinding ? { targetBinding: request.targetBinding } : {}),
          ...(request.referenceKind ? { referenceKind: request.referenceKind } : {}),
          ...(request.consentVersion ? { consentVersion: request.consentVersion } : {}),
        },
      }, fetch, controller.signal, authorization.id);
      if (planningEpoch !== planningEpochRef.current || sendAuthorizationRef.current !== authorization) return;
      if (!targetIsCurrent()) {
        plannerTargetBindingRef.current = null;
        setPlanning({ status: 'failed', request, error: { code: 'CORE008_TARGET_BINDING_STALE', message: '引用对象、Asset 或 Version 已变化；已废弃本次发送授权凭证，未调用 Planner。', retryable: false } });
        return;
      }
      plannerProviderRequestEpochRef.current = planningEpoch;
      const result = await evolinkPlanner.plan(request, paidConfirmationToken, controller.signal);
      if (planningEpoch !== planningEpochRef.current || sendAuthorizationRef.current !== authorization) return;
      if (!targetIsCurrent()) {
        plannerTargetBindingRef.current = null;
        setPlanning({ status: 'failed', request, error: { code: 'CORE008_TARGET_BINDING_STALE', message: '引用对象、Asset 或 Version 已变化；已忽略迟到的 Planner 结果。', retryable: false } });
        return;
      }
      if (!result.ok) {
        setPlanning({ status: 'failed', request, error: result.error, fallbackAvailable: true });
        commit((current) => ({
          ...current,
          plannerEvidence: result.evidence ? [...current.plannerEvidence, result.evidence] : current.plannerEvidence,
          messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: `Agent 规划失败：${result.error.message} 未创建媒体任务。`, time: nowLabel() }],
        }));
        return;
      }
      if (!bindAuthorizationPlan(authorization, result.intent, result.plan)) {
        setPlanning({ status: 'failed', request, error: { code: 'CORE008_SEND_AUTHORIZATION_PLAN_MISMATCH', message: 'Planner 结果与本次发送授权不匹配；未创建媒体任务。', retryable: false } });
        return;
      }
      if (result.intent.operation === 'video_image_to_video') {
        const sourceNode = result.intent.targetCanvasObjectId
          ? workspaceRef.current.nodes.find((node) => node.id === result.intent.targetCanvasObjectId)
          : undefined;
        const sourceAsset = sourceNode?.assetId
          ? workspaceRef.current.assets.find((asset) => asset.id === sourceNode.assetId)
          : undefined;
        const sourcePresentation = sourceNode
          ? resolveAssetPresentation(sourceNode, workspaceRef.current.assets, assetUrls, unavailableAssetIds)
          : undefined;
        const sourceIsRestorableImage = Boolean(
          sourceNode?.status === 'ready'
          && sourceNode.versionId
          && targetBinding?.objectId === sourceNode.id
          && targetBinding.assetId === sourceAsset?.id
          && targetBinding.versionId === sourceNode.versionId
          && sourceAsset?.kind === 'image'
          && sourceAsset.storage
          && sourcePresentation?.status === 'ready',
        );
        if (!sourceIsRestorableImage) {
          plannerTargetBindingRef.current = null;
          sendAuthorizationRef.current = null;
          setPlan(null);
          setPlanning({
            status: 'failed',
            request,
            error: {
              code: 'CORE009_VIDEO_SOURCE_NOT_RESTORABLE',
              message: 'Agent 已判断为图生视频，但当前引用不是本机可恢复的图片。请选择上传图或真实生成图后重新发送；Planner 已调用，媒体 Provider 未调用，也未创建 Job。',
              retryable: false,
            },
          });
          commit((current) => ({
            ...current,
            intents: [...current.intents, result.intent],
            plans: [...current.plans, result.plan],
            plannerEvidence: [...current.plannerEvidence, result.evidence],
            messages: [
              ...current.messages,
              { id: uniqueId('agent'), role: 'agent', body: result.plan.summary, time: nowLabel() },
              { id: uniqueId('system'), role: 'system', body: '需要一张本机可恢复的图片才能生成视频。已保留脱敏 Planner 证据；未创建 Job、Asset、Canvas Object 或 Version。', time: nowLabel() },
            ],
          }));
          return;
        }
      }
      setPlan({ intent: result.intent, plan: result.plan });
      plannerTargetBindingRef.current = null;
      setPlanning(null);
      commit((current) => ({
        ...current,
        intents: [...current.intents, result.intent],
        plans: [...current.plans, result.plan],
        pendingPlanId: result.plan.id,
        plannerEvidence: [...current.plannerEvidence, result.evidence],
        messages: [...current.messages, { id: uniqueId('agent'), role: 'agent', body: result.plan.summary, time: nowLabel() }],
      }));
      await beginBoundedRun(result.intent, result.plan, { sendAuthorizationId: authorization.id });
    } catch (error) {
      if (planningEpoch !== planningEpochRef.current || sendAuthorizationRef.current !== authorization) return;
      setPlanning({ status: 'failed', request, error: mapPlannerCredentialFailure(error), fallbackAvailable: true });
    } finally {
      if (plannerAbortControllerRef.current === controller) plannerAbortControllerRef.current = null;
      if (plannerProviderRequestEpochRef.current === planningEpoch) plannerProviderRequestEpochRef.current = null;
      plannerConfirmationInFlightRef.current = false;
    }
  };

  const prepareAgentPlanOnce = async (request: PlanningRequest, includeUserMessage: boolean) => {
    const planningEpoch = ++planningEpochRef.current;
    const authorization = createSendAuthorization(request, planningEpoch);
    sendAuthorizationRef.current = authorization;
    plannerAbortControllerRef.current?.abort();
    plannerAbortControllerRef.current = null;
    const targetBinding = request.targetCanvasObjectId
      ? captureCanvasTargetBinding(workspaceRef.current, request.targetCanvasObjectId)
      : undefined;
    plannerTargetBindingRef.current = targetBinding ?? null;
    setPlan(null);
    if (includeUserMessage) {
      commit((current) => ({
        ...current,
        pendingPlanId: undefined,
        messages: [...current.messages, { id: uniqueId('user'), role: 'user', body: request.prompt, time: nowLabel() }],
      }));
    }
    if (request.targetCanvasObjectId && !targetBinding) {
      if (sendAuthorizationRef.current === authorization) sendAuthorizationRef.current = null;
      setPlanning({ status: 'failed', request, error: { code: 'CORE008_TARGET_BINDING_STALE', message: '引用对象、Asset 或 Version 已变化；未签发付费凭证，也未调用 Planner。', retryable: false } });
      return;
    }
    try {
      await buildCanvasContextGraphSnapshot(workspaceRef.current);
    } catch (error) {
      if (planningEpoch !== planningEpochRef.current) return;
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'CANVAS_CONTEXT_INVALID';
      if (sendAuthorizationRef.current === authorization) sendAuthorizationRef.current = null;
      setPlanning({ status: 'failed', request, error: { code, message: '当前画布关系无法安全转换为 Agent 上下文，请先修复画布对象或版本关系。', retryable: false } });
      commit((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: `Agent 观察失败：${code}。未调用 Planner，也未创建媒体任务。`, time: nowLabel() }],
      }));
      return;
    }
    if (planningEpoch !== planningEpochRef.current) return;
    if (targetBinding && !canvasTargetBindingMatches(workspaceRef.current, targetBinding)) {
      plannerTargetBindingRef.current = null;
      if (sendAuthorizationRef.current === authorization) sendAuthorizationRef.current = null;
      setPlanning({ status: 'failed', request, error: { code: 'CORE008_TARGET_BINDING_STALE', message: '引用对象、Asset 或 Version 已变化；未签发付费凭证，也未调用 Planner。', retryable: false } });
      return;
    }
    let budget: MilestoneBudgetStatus;
    try {
      budget = await readCore009BudgetStatus();
    } catch {
      if (sendAuthorizationRef.current === authorization) sendAuthorizationRef.current = null;
      setPlanning({ status: 'failed', request, error: { code: 'CORE009_BUDGET_STATUS_UNAVAILABLE', message: '无法验证 CORE-009 独立里程碑预算，未签发凭证或调用 Provider。', retryable: true } });
      return;
    }
    if (planningEpoch !== planningEpochRef.current || sendAuthorizationRef.current !== authorization) return;
    const reservations = budget.providerReservations ?? { planner: 0.05, image: 1, video: 1 };
    const generationReservation = request.creationMode === 'video' ? reservations.video : request.creationMode === 'agent' ? Math.max(reservations.image, reservations.video) : request.imageProviderId === 'evolink-gpt-image-2' ? reservations.image : 0;
    const requiredReservationUsd = reservations.planner + generationReservation;
    authorization.plannerReservationUsd = reservations.planner;
    authorization.maxCostUsd = requiredReservationUsd;
    if (budget.capUsd - budget.usedUsd + Number.EPSILON < requiredReservationUsd) {
      if (sendAuthorizationRef.current === authorization) sendAuthorizationRef.current = null;
      setPlanning({ status: 'failed', request, error: { code: 'CORE009_BUDGET_EXCEEDED', message: `CORE-009 剩余预算不足以覆盖本次发送的保守预留 $${requiredReservationUsd.toFixed(2)}，未签发凭证或调用 Provider。`, retryable: false } });
      return;
    }
    await runAuthorizedAgentPlanner(request, planningEpoch, targetBinding, authorization);
  };

  const prepareAgentPlan = async (request: PlanningRequest, includeUserMessage: boolean) => {
    // React state updates are not synchronous. Take this lock before the first
    // await so Enter + button, key repeat, or a delayed budget preflight cannot
    // replace the request bound to the user's first Send gesture.
    if (executionBoundaryActive()) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '已有规划、Agent 或媒体任务在运行；本次未启动新规划，也未产生新费用。', time: nowLabel() }],
      }));
      return;
    }
    sendSubmissionInFlightRef.current = true;
    setSendSubmissionInFlight(true);
    try {
      await prepareAgentPlanOnce(request, includeUserMessage);
    } finally {
      sendSubmissionInFlightRef.current = false;
      setSendSubmissionInFlight(false);
    }
  };

  const runCanvasCommand = async (value: string) => {
    const command = parseCanvasCommand(value);
    if (!command || executionBoundaryActive()) return;
    sendSubmissionInFlightRef.current = true;
    setSendSubmissionInFlight(true);
    setCanvasToolStatus('正在调整画布');
    const actionId = uniqueId('canvas-action');
    try {
      const action = await planCanvasCommand(command, clone(workspaceRef.current), actionId);
      const executor = createCanvasActionExecutor({
        readWorkspace: () => workspaceRef.current,
        writeWorkspace: (next) => commit(() => next),
        async createImageJob() { throw new Error('画布工具不允许生成媒体。'); },
      });
      const receipt = await executor.executeOnce({ runId: actionId, stepId: actionId, idempotencyKey: actionId, action, signal: new AbortController().signal });
      replaceWithoutHistory(current => ({ ...current, messages: [...current.messages,
        { id: uniqueId('user'), role: 'user', body: value, time: nowLabel() },
        { id: uniqueId('agent'), role: receipt.ok ? 'agent' : 'system', body: receipt.ok ? receipt.changed ? `已调整 ${receipt.outputIds?.length ?? 0} 个画布对象。可以撤销；图片和原版本保持完整。` : '对象已符合指令，没有新增画布变化。' : receipt.summary, time: nowLabel() },
      ] }));
      setCanvasToolStatus(receipt.ok ? receipt.changed ? '画布已更新 · 可撤销' : '对象已符合指令' : receipt.summary);
      if (receipt.ok) setDraft('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '画布调整失败，请重新选择对象。';
      setCanvasToolStatus(message);
      replaceWithoutHistory(current => ({ ...current, messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: message, time: nowLabel() }] }));
    } finally {
      sendSubmissionInFlightRef.current = false;
      setSendSubmissionInFlight(false);
    }
  };

  const editWorkflow = (command: WorkflowCommand, continueTextEdit = false) => {
    if (executionBoundaryActive() || workflowRunningRef.current) return false;
    try {
      const next = applyWorkflowCommand(workspaceRef.current, command);
      // Node text is authored project content. Save on input, including when
      // the editor still has focus; one editing session uses one undo entry.
      persistWorkspace(next, window.localStorage, projectId);
      if (continueTextEdit && command.type === 'update') replaceWithoutHistory(() => next);
      else commit(() => next);
      setCanvasToolStatus('节点已更新 · 可撤销');
      return true;
    } catch (error) {
      setCanvasToolStatus(error instanceof Error ? error.message : '节点操作失败');
      return false;
    }
  };

  const addWorkflowNode = (kind: WorkflowKind, text = '') => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const viewport = workspaceRef.current.viewport;
    const placement = nodeMenu ?? { x: ((rect?.width ?? 1000) / 2 - viewport.x) / viewport.scale - 170, y: ((rect?.height ?? 700) / 2 - viewport.y) / viewport.scale - 140 };
    const node = makeWorkflowNode(kind, uniqueId('node'), placement.x, placement.y, text);
    if (editWorkflow({ type: 'create', node, sourceId: placement.sourceId })) { setNodeMenu(null); setConnectionSource(null); }
  };

  const connectWorkflowNodes = (targetId: string) => {
    if (!connectionSource) return;
    if (editWorkflow({ type: 'connect', sourceId: connectionSource, targetId })) setConnectionSource(null);
  };

  const startWorkflowConnection = (event: React.PointerEvent<HTMLButtonElement>, sourceId: string) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0 || executionBoundaryActive() || workflowRunningRef.current) return;
    portDragRef.current = { sourceId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setConnectionSource(sourceId);
  };

  const finishWorkflowConnection = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const start = portDragRef.current;
    portDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const targetId = element?.closest<HTMLElement>('[data-workflow-input]')?.dataset.workflowInput;
    if (targetId) editWorkflow({ type: 'connect', sourceId: start.sourceId, targetId });
    else if (canvasRef.current?.contains(element) && !element?.closest('article, button')) {
      const rect = canvasRef.current.getBoundingClientRect();
      const viewport = workspaceRef.current.viewport;
      setNodeMenu({ sourceId: start.sourceId, x: (event.clientX - rect.left - viewport.x) / viewport.scale, y: (event.clientY - rect.top - viewport.y) / viewport.scale });
    }
    setConnectionSource(null);
    setConnectionPoint(null);
  };

  const runWorkflowNode = async (nodeId: string, transferAlreadyAccepted = false) => {
    if (workflowRunningRef.current || executionBoundaryActive()) return;
    setWorkflowErrors(current => ({ ...current, [nodeId]: '' }));
    try {
      const input = resolveWorkflowRequest(workspaceRef.current, nodeId);
      const referenceAsset = workspaceRef.current.assets.find(asset => asset.id === input.reference?.assetId);
      if (input.reference && !['ready', 'fixed-demo'].includes(resolveAssetPresentation(input.reference, workspaceRef.current.assets, assetUrls, unavailableAssetIds).status)) throw new Error('参考媒体仍在恢复或不可用，未提交任务。');
      const remote = input.model !== 'deterministic-mock';
      if (remote && referenceAsset?.storage && !transferAlreadyAccepted && !window.confirm('此节点会把所连接的图片及提示词发送给现有模型服务，使用现有费用上限。确认运行？')) return;
      const request: PlanningRequest = {
        prompt: input.prompt, creationMode: input.kind, imageProviderId: input.model === 'evolink-gpt-image-2' ? 'evolink-gpt-image-2' : 'deterministic-mock',
        selectedCanvasObjectCount: input.reference ? 1 : 0, selectedObjectIds: input.reference ? [input.reference.id] : [],
        ...(input.reference ? { targetCanvasObjectId: input.reference.id, targetBinding: captureCanvasTargetBinding(workspaceRef.current, input.reference.id), referenceKind: referenceAsset?.storage ? 'user-upload' as const : 'fixed-demo' as const } : {}),
        ...(referenceAsset?.storage ? { consentVersion: REFERENCE_TRANSFER_CONSENT_VERSION } : {}),
        videoProviderId: 'evolink-sora-2-preview',
      };
      workflowRunningRef.current = nodeId;
      setWorkflowRunning(nodeId);
      replaceWithoutHistory(current => ({ ...current, selectedIds: input.reference ? [input.reference.id] : [], ...(remote && referenceAsset?.storage ? { referenceTransferConsent: { version: REFERENCE_TRANSFER_CONSENT_VERSION, acceptedAt: new Date().toISOString() } } : {}) }));
      const existing = new Set(workspaceRef.current.jobs.map(job => job.id));
      if (remote) await prepareAgentPlan(request, true);
      else {
        // The explicitly selected local rehearsal never contacts a Planner.
        const authorization = createSendAuthorization(request, ++planningEpochRef.current);
        sendAuthorizationRef.current = authorization;
        const fallback = createDeterministicFallbackPlanning(request);
        if (!bindAuthorizationPlan(authorization, fallback.intent, fallback.plan)) throw new Error('节点执行输入不一致，未创建任务。');
        commit(current => ({ ...current, intents: [...current.intents, fallback.intent], plans: [...current.plans, fallback.plan], pendingPlanId: fallback.plan.id }));
        await beginBoundedRun(fallback.intent, fallback.plan, { sendAuthorizationId: authorization.id });
      }
      const newJob = workspaceRef.current.jobs.find(job => !existing.has(job.id));
      if (!newJob || newJob.status !== 'succeeded') throw new Error(newJob?.error?.message ?? '节点未产出结果，请查看 Agent 中的具体错误；没有自动重试。');
      setCanvasToolStatus('节点运行完成，输出已连接到任务节点');
    } catch (error) {
      const message = error instanceof Error ? error.message : '节点运行失败';
      setWorkflowErrors(current => ({ ...current, [nodeId]: message }));
      setCanvasToolStatus(message);
    } finally {
      workflowRunningRef.current = null;
      setWorkflowRunning(null);
    }
  };

  useEffect(() => {
    if (!skillToRun || skillToRun.projectId !== projectId || !onClaimSkillRun) return;
    const node = workspaceRef.current.nodes.find(item => item.id === skillToRun.nodeId);
    const reference = node?.workflow?.inputs.find(input => input.role === 'image');
    if (reference?.assetId && !assetUrls.has(reference.assetId) && !unavailableAssetIds.has(reference.assetId)) return;
    // Defer to the next task so StrictMode's discarded first mount cannot
    // consume the explicit gesture then abort its only authorized run.
    const timer = window.setTimeout(() => {
      if (!onClaimSkillRun(skillToRun.id, projectId)) return;
      if (executionBoundaryActive() || node?.workflow?.text !== skillToRun.prompt || node.workflow.model !== skillToRun.model) {
        setCanvasToolStatus('Skill 节点已保存；当前任务或参数已变化，请检查后手动运行。');
        return;
      }
      void runWorkflowNode(skillToRun.nodeId, skillToRun.transferConsent);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [skillToRun, onClaimSkillRun, projectId, assetUrls, unavailableAssetIds]);

  const submitPrompt = () => {
    const value = draft.trim();
    if (!value || (planning && planning.status !== 'failed')) return;
    if (executionBoundaryActive()) return;
    const current = workspaceRef.current;
    const creationMode = current.creationMode;
    const createNodeRequest = /^(?:新建|添加)(文本|图片|视频)节点(?:[：:]([\s\S]*))?$/.exec(value);
    if (creationMode === 'agent' && createNodeRequest) {
      addWorkflowNode(({ 文本: 'text', 图片: 'image', 视频: 'video' } as const)[createNodeRequest[1] as '文本' | '图片' | '视频'], createNodeRequest[2]?.trim() ?? '');
      setDraft('');
      return;
    }
    if (creationMode === 'agent' && /^(连接选中节点|将选中节点连接)$/.test(value)) {
      if (current.selectedIds.length === 2) editWorkflow({ type: 'connect', sourceId: current.selectedIds[0], targetId: current.selectedIds[1] });
      else setCanvasToolStatus('请按来源、目标的顺序选择两个节点。');
      return;
    }
    if (creationMode === 'agent' && value === '运行选中节点') {
      const selectedTask = current.selectedIds.length === 1 ? current.nodes.find(node => node.id === current.selectedIds[0] && node.workflow && node.workflow.kind !== 'text') : undefined;
      if (selectedTask) { setDraft(''); void runWorkflowNode(selectedTask.id); }
      else setCanvasToolStatus('请先选择一个图片或视频任务节点。');
      return;
    }
    if (creationMode === 'agent' && parseCanvasCommand(value)) {
      void runCanvasCommand(value);
      return;
    }
    const selectedNodes = current.selectedIds.flatMap((id) => {
      const node = current.nodes.find((candidate) => candidate.id === id);
      return node ? [node] : [];
    });
    if (selectedNodes.some(node => node.workflow)) {
      setCanvasToolStatus('当前选中工作流节点。请编辑节点内容后点击运行，或输入“运行选中节点”。');
      return;
    }
    if (creationMode === 'image' && selectedNodes.length > 1) {
      replaceWithoutHistory((workspaceState) => ({
        ...workspaceState,
        messages: [...workspaceState.messages, { id: uniqueId('system'), role: 'system', body: '图片模式一次只能编辑 1 张图片；请保留单选或取消选择后重新发送。未调用 Provider。', time: nowLabel() }],
      }));
      return;
    }
    if (creationMode === 'video' && selectedNodes.length !== 1) {
      replaceWithoutHistory((workspaceState) => ({
        ...workspaceState,
        messages: [...workspaceState.messages, { id: uniqueId('system'), role: 'system', body: '视频模式必须且只能选择 1 张可恢复图片。本次未调用 Planner 或视频 Provider。', time: nowLabel() }],
      }));
      return;
    }
    const selected = selectedNodes.length === 1 && selectedNodes[0].status === 'ready' ? selectedNodes[0] : undefined;
    if (selected && !['ready', 'fixed-demo'].includes(resolveAssetPresentation(selected, workspaceRef.current.assets, assetUrls, unavailableAssetIds).status)) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '当前图片的本地 Blob 不可用或仍在恢复；未调用 Planner 或图片 Provider。', time: nowLabel() }],
      }));
      return;
    }
    const selectedAsset = selected?.assetId ? workspaceRef.current.assets.find((asset) => asset.id === selected.assetId) : undefined;
    if (selectedAsset?.kind === 'video') {
      replaceWithoutHistory((workspaceState) => ({
        ...workspaceState,
        messages: [...workspaceState.messages, { id: uniqueId('system'), role: 'system', body: 'CORE-009 只允许图片作为参考输入；当前选中的是视频结果。请取消选择或改选一张图片。未调用 Provider。', time: nowLabel() }],
      }));
      return;
    }
    if (creationMode === 'video' && (!selected || !selected.versionId || !selectedAsset || selectedAsset.kind !== 'image' || !selectedAsset.storage)) {
      replaceWithoutHistory((workspaceState) => ({
        ...workspaceState,
        messages: [...workspaceState.messages, { id: uniqueId('system'), role: 'system', body: '视频模式只接受已保存到本机的可恢复图片 Asset。请选择上传图或真实生成图；本次未调用 Provider。', time: nowLabel() }],
      }));
      return;
    }
    // Any Canvas Asset with a persisted Blob must bind the actual selected
    // pixels to the multipart edit request. Treating a generated remote Asset
    // as fixed-demo would silently edit ELYRA_DEMO_REFERENCE_URL instead.
    const referenceKind = selected ? selectedAsset?.storage ? 'user-upload' as const : 'fixed-demo' as const : undefined;
    if (referenceKind === 'user-upload' && !transferConsentChecked) return;
    const request: PlanningRequest = {
      prompt: value,
      creationMode,
      selectedCanvasObjectCount: current.selectedIds.length,
      selectedObjectIds: current.selectedIds,
      targetCanvasObjectId: selected?.id,
      ...(selected ? { targetBinding: captureCanvasTargetBinding(workspaceRef.current, selected.id) } : {}),
      referenceKind,
      ...(referenceKind === 'user-upload' ? { consentVersion: REFERENCE_TRANSFER_CONSENT_VERSION } : {}),
      imageProviderId: workspaceRef.current.imageProviderId,
      videoProviderId: 'evolink-sora-2-preview',
    };
    if (referenceKind === 'user-upload') {
      replaceWithoutHistory((current) => ({
        ...current,
        referenceTransferConsent: { version: REFERENCE_TRANSFER_CONSENT_VERSION, acceptedAt: new Date().toISOString() },
      }));
    }
    setDraft('');
    void prepareAgentPlan(request, true);
  };

  const retryPlanning = () => {
    if (planning?.status !== 'failed' || !planning.error.retryable) return;
    if (planning.request.referenceKind === 'user-upload' && !transferConsentChecked) return;
    setDraft(planning.request.prompt);
    sendAuthorizationRef.current = null;
    setPlan(null);
    setPlanning(null);
    replaceWithoutHistory((current) => ({
      ...current,
      selectedIds: planning.request.targetCanvasObjectId && current.nodes.some((node) => node.id === planning.request.targetCanvasObjectId && node.status === 'ready')
        ? [planning.request.targetCanvasObjectId]
        : current.selectedIds,
      messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '原指令已填回输入框；只有再次按发送才会建立新的 Planner 与图片调用授权。', time: nowLabel() }],
    }));
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('[data-testid="agent-input"]')?.focus());
  };

  const useDeterministicFallback = () => {
    if (planning?.status !== 'failed') return;
    const authorization = sendAuthorizationRef.current;
    const authorizationEligible = fallbackAuthorizationIsCurrent(planning, authorization, planningEpochRef.current, workspaceRef.current);
    if (!authorization || !authorizationEligible) return;
    const fallback = createDeterministicFallbackPlanning(planning.request);
    if (!bindAuthorizationPlan(authorization, fallback.intent, fallback.plan)) {
      setPlanning({ status: 'failed', request: planning.request, error: { code: 'CORE008_SEND_AUTHORIZATION_MISSING', message: '原发送授权已失效；请重新发送需求后再选择本地规划草案。', retryable: false } });
      return;
    }
    plannerTargetBindingRef.current = null;
    setPlan(fallback);
    setPlanning(null);
    commit((current) => ({
      ...current,
      intents: [...current.intents, fallback.intent],
      plans: [...current.plans, fallback.plan],
      pendingPlanId: fallback.plan.id,
      messages: [...current.messages, { id: uniqueId('agent'), role: 'agent', body: `已按你的选择创建 deterministic fallback：${fallback.plan.summary}`, time: nowLabel() }],
    }));
    void beginBoundedRun(fallback.intent, fallback.plan, { sendAuthorizationId: authorization.id });
  };

  const finishJob = useCallback(async (
    nodeId: string,
    jobId: string,
    incoming: ProviderRunResult,
    expectedRunEpoch?: number,
    signal?: AbortSignal,
  ) => {
    if (signal?.aborted || (expectedRunEpoch !== undefined && expectedRunEpoch !== agentRunEpochRef.current)) return;
    const activeSettlement = settlingJobPromisesRef.current.get(jobId);
    if (activeSettlement) return activeSettlement;
    const initialJob = workspaceRef.current.jobs.find((job) => job.id === jobId);
    const initialNode = workspaceRef.current.nodes.find((node) => node.id === nodeId);
    if (!initialJob || !SETTLEABLE_JOB_STATUSES.has(initialJob.status) || initialNode?.jobId !== jobId) return;
    const settlement = (async (): Promise<ProviderRunResult | undefined> => {
      let storedResults: BlobStorageMetadata[] = [];
      const rollbackStoredResults = async () => {
        if (storedResults.length === 0) return;
        await blobStoreRef.current.deleteMany(storedResults, { expectedProjectId: projectId }).catch(() => undefined);
        storedResults = [];
      };
      const localResultFailure = (message: string): ProviderRunResult => ({
        ok: false,
        error: {
          code: 'CORE009_LOCAL_RESULT_SAVE_FAILED',
          message,
          retryable: true,
          retryScope: 'local-result',
        },
      });
      let result: ProviderRunResult = incoming;
      if (incoming.ok) {
        const validation = validateProviderRunSuccess(incoming, initialJob);
        if (!validation.ok) {
          result = {
            ok: false,
            error: {
              code: validation.code,
              message: 'Provider 返回的媒体结果不满足完整性合同；未写入任何 Asset、Blob、画布对象或版本。',
              retryable: false,
              retryScope: 'none',
            },
          };
        } else if (providerResultHasOutputSet(incoming)) {
          try {
            storedResults = await blobStoreRef.current.putMany(projectId, incoming.outputs.map((output) => ({
              blob: output.blob,
              options: {
                blobKey: `provider-result:${jobId}:${output.slot}`,
                mimeType: output.asset.mimeType,
                createdAt: output.asset.createdAt,
              },
            })));
            const outputs = incoming.outputs.map((output, index) => ({
              ...output,
              asset: { ...output.asset, uri: undefined, storage: storedResults[index] },
            })) as unknown as ProviderOutputSet;
            result = { ok: true, outputs };
          } catch {
            result = localResultFailure('Provider 已完成三张结果，但媒体集合无法原子写入 IndexedDB；只能重试本地取回，不会再次提交付费生成。');
          }
        } else if (incoming.blob) {
          try {
            storedResults = await blobStoreRef.current.putMany(projectId, [{
              blob: incoming.blob,
              options: {
                blobKey: `provider-result:${jobId}:single`,
                mimeType: incoming.asset.mimeType,
                createdAt: incoming.asset.createdAt,
              },
            }]);
            result = { ...incoming, asset: { ...incoming.asset, uri: undefined, storage: storedResults[0] } };
          } catch {
            result = localResultFailure('Provider 已完成生成，但媒体结果无法写入 IndexedDB；只能重试本地取回，不会再次提交付费生成。');
          }
        }
      }

      if (signal?.aborted || (expectedRunEpoch !== undefined && expectedRunEpoch !== agentRunEpochRef.current)) {
        await rollbackStoredResults();
        return;
      }
      const latestJob = workspaceRef.current.jobs.find((job) => job.id === jobId);
      const latestNode = workspaceRef.current.nodes.find((node) => node.id === nodeId);
      if (!latestJob || !SETTLEABLE_JOB_STATUSES.has(latestJob.status) || latestNode?.jobId !== jobId) {
        await rollbackStoredResults();
        return;
      }
      const providerLabel = latestJob.providerId === 'evolink-sora-2-preview'
        ? `${providerLabels.video} 四秒视频`
        : latestJob.providerId === 'evolink-gpt-image-2' ? providerLabels.image : 'Mock';

      if (result.ok) {
        try {
          const baseWorkspace = workspaceRef.current;
          const settled = buildProviderResultSettlement({
            workspace: clone(baseWorkspace),
            projectId,
            jobId,
            placeholderNodeId: nodeId,
            result,
            settledAt: new Date().toISOString(),
          });
          if (!settled.ok) throw new Error(settled.code);
          const candidate: Workspace = {
            ...settled.workspace,
            messages: [...settled.workspace.messages, {
              id: uniqueId('agent'),
              role: 'agent',
              body: `${providerLabel} ${settled.kind === 'set' ? '三张结果已整体完成' : '结果已完成'}并保存到本机。源图与父版本未被覆盖。`,
              time: nowLabel(),
            }],
          };
          await buildCanvasContextGraphSnapshot(candidate);
          if (
            signal?.aborted
            || (expectedRunEpoch !== undefined && expectedRunEpoch !== agentRunEpochRef.current)
            || workspaceRef.current !== baseWorkspace
          ) {
            await rollbackStoredResults();
            return;
          }
          if (storedResults.length > 0) publishAddedStorageBoundary(candidate);
          else settleJobTransaction(jobId, () => candidate);
          return result;
        } catch {
          await rollbackStoredResults();
          result = localResultFailure('Provider 已完成生成，但媒体结果无法完成本地事务封存；只能重试本地取回，不会再次提交付费生成。');
        }
      }

      if (result.ok) return result;
      const failedJobStatus = result.error.retryScope === 'local-result' ? 'local_result_pending' as const : 'failed' as const;
      const failedWorkspace = clone(workspaceRef.current);
      const failedJob = failedWorkspace.jobs.find((job) => job.id === jobId);
      const failedNode = failedWorkspace.nodes.find((node) => node.id === nodeId);
      if (!failedJob || !SETTLEABLE_JOB_STATUSES.has(failedJob.status) || failedNode?.jobId !== jobId) return;
      failedWorkspace.nodes = failedWorkspace.nodes.map((node) => node.id === nodeId ? { ...node, status: 'failed', assetId: undefined } : node);
      failedWorkspace.jobs = failedWorkspace.jobs.map((job) => job.id === jobId
        ? { ...job, status: failedJobStatus, updatedAt: new Date().toISOString(), error: result.error }
        : job);
      failedWorkspace.versions = failedWorkspace.versions.map((version) => version.jobId === jobId ? { ...version, status: 'failed' } : version);
      failedWorkspace.selectedIds = failedWorkspace.selectedIds.filter((id) => id !== nodeId);
      failedWorkspace.messages = [...failedWorkspace.messages, {
        id: uniqueId('agent'),
        role: 'system',
        body: result.error.retryScope === 'local-result'
          ? result.error.message
          : `${providerLabel} 生成失败：${result.error.message}${result.error.retryable ? ' 点击重试只会填回原指令；再次按发送后才会建立新的付费授权。' : ''}`,
        time: nowLabel(),
      }];
      settleJobTransaction(jobId, () => failedWorkspace);
      return result;
    })();
    settlingJobPromisesRef.current.set(jobId, settlement);
    try {
      return await settlement;
    } finally {
      if (settlingJobPromisesRef.current.get(jobId) === settlement) settlingJobPromisesRef.current.delete(jobId);
    }
  }, [projectId, publishAddedStorageBoundary, settleJobTransaction]);

  const updateProviderProgress = useCallback((jobId: string, progress: ProviderProgress) => {
    replaceWithoutHistory((current) => ({
      ...current,
      jobs: current.jobs.map((job) => job.id === jobId && job.status !== 'user_cancelled' ? { ...job, status: progress.status, progress: progress.progress, updatedAt: new Date().toISOString() } : job),
    }));
  }, [replaceWithoutHistory]);

  const finalizeInterruptedGeneration = useCallback((
    nodeId: string,
    jobId: string,
    outcome: 'cancelled' | 'stale' | 'failed',
    code: string,
    message: string,
  ) => {
    settleJobTransaction(jobId, (current) => {
      const job = current.jobs.find((item) => item.id === jobId);
      if (!job || job.status === 'succeeded' || job.status === 'failed' || job.status === 'user_cancelled') return current;
      const cancelled = outcome === 'cancelled';
      const nodeStatus = cancelled ? 'user_cancelled' as const : 'failed' as const;
      return {
        ...current,
        nodes: current.nodes.map((node) => node.id === nodeId && node.jobId === jobId ? { ...node, status: nodeStatus } : node),
        jobs: current.jobs.map((item) => item.id === jobId ? {
          ...item,
          status: cancelled ? 'user_cancelled' as const : 'failed' as const,
          updatedAt: new Date().toISOString(),
          error: { code, message, retryable: false, retryScope: 'none' as const },
        } : item),
        versions: current.versions.map((item) => item.jobId === jobId ? { ...item, status: cancelled ? 'user_cancelled' as const : 'failed' as const } : item),
        selectedIds: current.selectedIds.filter((id) => id !== nodeId),
        messages: [...current.messages, { id: uniqueId('system'), role: 'system' as const, body: message, time: nowLabel() }],
      };
    });
  }, [settleJobTransaction]);

  const startGeneration = async (input: { intent: UserIntent; plan: AgentPlan; parentId?: string; retryId?: string; attempt?: number; signal?: AbortSignal; expectedRunEpoch: number; targetBinding?: CanvasTargetBinding; sendAuthorizationId: string }): Promise<GenerationExecutionOutcome> => {
    const { intent, plan: nextPlan, parentId, retryId, attempt = 1, expectedRunEpoch, targetBinding } = input;
    if (intent.operation === 'clarify' || nextPlan.operation === 'clarify') {
      return { ok: false, errorCode: 'CORE009_CLARIFICATION_REQUIRED', retryable: false, costUsd: 0 };
    }
    const isVideo = intent.operation === 'video_image_to_video';
    const requiresTarget = intent.operation !== 'image_generate';
    if (expectedRunEpoch !== agentRunEpochRef.current || input.signal?.aborted) {
      return { ok: false, errorCode: 'CORE008_RUN_INVALIDATED', retryable: false, costUsd: 0 };
    }
    if (
      requiresTarget
      && (!parentId || intent.targetCanvasObjectId !== parentId || !targetBinding || targetBinding.objectId !== parentId || !canvasTargetBindingMatches(workspaceRef.current, targetBinding))
    ) {
      return { ok: false, errorCode: 'CORE008_TARGET_BINDING_STALE', retryable: false, costUsd: 0 };
    }
    const remoteProvider = nextPlan.providerId === 'evolink-gpt-image-2' || nextPlan.providerId === 'evolink-sora-2-preview';
    const source = workspaceRef.current;
    const parent = source.nodes.find((node) => node.id === parentId);
    const nodeId = retryId ?? uniqueId('mock');
    const runtime = runtimeFor(nextPlan.providerId);
    const job = runtime.createJob({ intent, plan: nextPlan, attempt });
    const controller = new AbortController();
    const abortFromRuntime = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', abortFromRuntime, { once: true });
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    abortControllersRef.current.set(job.id, controller);
    let budgetBefore: MilestoneBudgetStatus | undefined;
    try {
      budgetBefore = remoteProvider ? await readCore009BudgetStatus() : undefined;
    } catch (error) {
      input.signal?.removeEventListener('abort', abortFromRuntime);
      abortControllersRef.current.delete(job.id);
      throw error;
    }
    if (
      expectedRunEpoch !== agentRunEpochRef.current
      || controller.signal.aborted
      || (requiresTarget && (!targetBinding || !canvasTargetBindingMatches(workspaceRef.current, targetBinding)))
    ) {
      input.signal?.removeEventListener('abort', abortFromRuntime);
      abortControllersRef.current.delete(job.id);
      return { ok: false, jobId: job.id, nodeId, errorCode: expectedRunEpoch !== agentRunEpochRef.current ? 'CORE008_RUN_INVALIDATED' : 'CORE008_TARGET_BINDING_STALE', retryable: false, costUsd: 0 };
    }
    const previousVersion = retryId ? source.versions.find((version) => version.canvasObjectId === retryId) : undefined;
    const actionBefore = {
      ...clone(source),
      pendingPlanId: undefined,
      plans: source.plans.map((item) => item.id === nextPlan.id ? { ...item, status: 'approved' as const } : item),
    };
    jobHistorySnapshotsRef.current.set(job.id, actionBefore);
    const version: VersionRecord = {
      id: previousVersion?.id ?? uniqueId('version'),
      canvasObjectId: nodeId,
      parentVersionId: parent?.versionId,
      parentCanvasObjectId: parent?.id,
      jobId: job.id,
      sequence: parent ? parent.version + 1 : 1,
      status: 'pending',
      createdAt: previousVersion?.createdAt ?? new Date().toISOString(),
    };
    if (retryId) {
      replaceWithoutHistory((current) => ({
        ...current,
        pendingPlanId: undefined,
        plans: current.plans.map((item) => item.id === nextPlan.id ? { ...item, status: 'approved' as const } : item),
        jobs: [...current.jobs, { ...job, status: intent.operation === 'image_edit_user_reference' || isVideo ? 'validating' : 'running', progress: intent.operation === 'image_edit_user_reference' || isVideo ? 5 : undefined, updatedAt: new Date().toISOString() }],
        versions: current.versions.map((item) => item.id === version.id ? version : item),
        nodes: current.nodes.map((node) => node.id === retryId ? { ...node, status: 'generating', jobId: job.id, versionId: version.id } : node),
        selectedIds: [retryId],
      }));
    } else {
      const node = makeMockNode(nodeId, composeExecutionPrompt(intent, nextPlan), parent, { jobId: job.id, versionId: version.id });
      const workflowOrigin = source.nodes.find(item => item.id === workflowRunningRef.current);
      if (workflowOrigin) {
        node.workflowOriginId = workflowOrigin.id;
        node.x = workflowOrigin.x + workflowOrigin.width + 100;
        node.y = workflowOrigin.y + source.nodes.filter(item => item.workflowOriginId === workflowOrigin.id).length * 80;
      }
      replaceWithoutHistory((current) => ({
        ...current,
        pendingPlanId: undefined,
        plans: current.plans.map((item) => item.id === nextPlan.id ? { ...item, status: 'approved' as const } : item),
        jobs: [...current.jobs, { ...job, status: intent.operation === 'image_edit_user_reference' || isVideo ? 'validating' : 'running', progress: intent.operation === 'image_edit_user_reference' || isVideo ? 5 : undefined, updatedAt: new Date().toISOString() }],
        versions: [...current.versions, version],
        nodes: [...current.nodes, node],
        // Keep the referenced parent selected until the edit succeeds. This
        // preserves the exact target binding and lets an explicit parent
        // deletion invalidate an in-flight child request before Provider use.
        selectedIds: requiresTarget && parent ? [parent.id] : [nodeId],
      }));
    }
    const interruptedAfterRecordCreation = (costUsd = 0): GenerationExecutionOutcome => {
      const cancelled = controller.signal.aborted || Boolean(input.signal?.aborted);
      const stale = requiresTarget && (!targetBinding || !canvasTargetBindingMatches(workspaceRef.current, targetBinding));
      const code = cancelled
        ? 'CORE008_USER_CANCELLED'
        : stale
          ? 'CORE008_TARGET_BINDING_STALE'
          : 'CORE008_RUN_INVALIDATED';
      finalizeInterruptedGeneration(
        nodeId,
        job.id,
        cancelled ? 'cancelled' : stale ? 'stale' : 'failed',
        code,
        cancelled
          ? '有界 Agent 已停止本地等待；若请求已提交，不代表远端取消或退款。'
          : stale
            ? '引用对象、Asset 或 Version 已变化；已停止当前动作，不会自动重提付费任务。'
            : '运行身份已失效；当前媒体动作已安全停止，不会自动重提。',
      );
      return { ok: false, jobId: job.id, nodeId, errorCode: code, retryable: false, costUsd };
    };
    const resolvedProviderCost = async () => {
      if (!remoteProvider || !budgetBefore) return 0;
      try {
        const after = await readCore009BudgetStatus();
        return Math.max(0, Number((after.usedUsd - budgetBefore.usedUsd).toFixed(8)));
      } catch {
        // The server remains authoritative. If its post-submit status endpoint
        // is unavailable, the run display conservatively accounts one image
        // reservation instead of pretending the call was free.
        return budgetBefore.providerReservations?.[isVideo ? 'video' : 'image'] ?? budgetBefore.reservationPerAttemptUsd;
      }
    };
    let providerExecutionStarted = false;
    try {
      let referenceBlob: Blob | undefined;
      if (intent.operation === 'image_edit_user_reference' || isVideo) {
        const parentAsset = parent?.assetId ? workspaceRef.current.assets.find((asset) => asset.id === parent.assetId) : undefined;
        if (!parentAsset?.storage || parentAsset.kind !== 'image') {
          const code = isVideo ? 'CORE009_VIDEO_SOURCE_NOT_STORED' : 'CORE007_REFERENCE_NOT_STORED';
          await finishJob(nodeId, job.id, { ok: false, error: { code, message: isVideo ? '图生视频源图未作为可恢复图片 Asset 保存；未调用 Sora。' : '本地参考图已丢失，请重新上传。', retryable: false } }, expectedRunEpoch, controller.signal);
          return { ok: false, jobId: job.id, nodeId, errorCode: code, retryable: false, costUsd: 0 };
        }
        try { referenceBlob = await blobStoreRef.current.get(parentAsset.storage); }
        catch { referenceBlob = undefined; }
        if (!referenceBlob) {
          const code = isVideo ? 'CORE009_VIDEO_SOURCE_NOT_STORED' : 'CORE007_REFERENCE_NOT_STORED';
          await finishJob(nodeId, job.id, { ok: false, error: { code, message: isVideo ? '图生视频源图无法从 IndexedDB 恢复；未调用 Sora。' : '本地参考图无法恢复，请重新上传。', retryable: false } }, expectedRunEpoch, controller.signal);
          return { ok: false, jobId: job.id, nodeId, errorCode: code, retryable: false, costUsd: 0 };
        }
      }
      let paidConfirmationToken: string | undefined;
      if (remoteProvider) {
        if (
          expectedRunEpoch !== agentRunEpochRef.current
          || controller.signal.aborted
          || (requiresTarget && (!targetBinding || !canvasTargetBindingMatches(workspaceRef.current, targetBinding)))
        ) {
          return interruptedAfterRecordCreation();
        }
        try {
          const executionPrompt = composeExecutionPrompt(intent, nextPlan);
          let paidBinding: PaidConfirmationBinding;
          if (isVideo) {
            if (!referenceBlob || !parent?.assetId || !parent.versionId) {
              await finishJob(nodeId, job.id, { ok: false, error: { code: 'CORE009_VIDEO_SOURCE_BINDING_INVALID', message: '图生视频源图绑定不完整；未调用 Sora。', retryable: false } }, expectedRunEpoch, controller.signal);
              return { ok: false, jobId: job.id, nodeId, errorCode: 'CORE009_VIDEO_SOURCE_BINDING_INVALID', retryable: false, costUsd: 0 };
            }
            paidBinding = await createVideoPaidBinding({
              prompt: executionPrompt,
              clientJobId: job.id,
              sourceObjectId: parent.id,
              sourceAssetId: parent.assetId,
              sourceVersionId: parent.versionId,
              blob: referenceBlob,
            });
          } else if (intent.operation === 'image_edit_user_reference') {
            if (!referenceBlob) {
              await finishJob(nodeId, job.id, { ok: false, error: { code: 'CORE007_REFERENCE_NOT_STORED', message: '本地参考图无法恢复，请重新上传。', retryable: false } }, expectedRunEpoch, controller.signal);
              return { ok: false, jobId: job.id, nodeId, errorCode: 'CORE007_REFERENCE_NOT_STORED', retryable: false, costUsd: 0 };
            }
            paidBinding = await createUserReferencePaidBinding({ prompt: executionPrompt, clientJobId: job.id, blob: referenceBlob });
          } else {
            paidBinding = {
              route: job.operation === 'edit' ? '/api/agent/image-edit-jobs' : '/api/agent/image-jobs',
              body: { prompt: executionPrompt, clientJobId: job.id },
            };
          }
          paidConfirmationToken = await requestPaidConfirmation(isVideo ? 'video' : 'image', paidBinding, fetch, controller.signal, input.sendAuthorizationId, {
            intentId: intent.id,
            planId: nextPlan.id,
            operation: intent.operation,
            providerId: nextPlan.providerId,
            targetBinding: targetBinding ?? null,
          });
        } catch {
          if (expectedRunEpoch !== agentRunEpochRef.current || controller.signal.aborted) {
            return interruptedAfterRecordCreation();
          }
          await finishJob(nodeId, job.id, { ok: false, error: { code: 'CORE008_CONFIRMATION_ISSUE_FAILED', message: '无法为当前媒体请求建立内容绑定的一次性授权凭证，未调用 Provider。', retryable: true, retryScope: 'new-provider-job' } }, expectedRunEpoch, controller.signal);
          return { ok: false, jobId: job.id, nodeId, errorCode: 'CORE008_CONFIRMATION_ISSUE_FAILED', retryable: false, costUsd: 0 };
        }
        if (
          expectedRunEpoch !== agentRunEpochRef.current
          || controller.signal.aborted
          || (requiresTarget && (!targetBinding || !canvasTargetBindingMatches(workspaceRef.current, targetBinding)))
        ) {
          return interruptedAfterRecordCreation();
        }
      }
      providerExecutionStarted = remoteProvider;
      const providerResult = await runtime.execute(job, intent, nextPlan, {
        referenceBlob,
        ...(isVideo && parent?.assetId && parent.versionId ? { sourceBinding: { canvasObjectId: parent.id, versionId: parent.versionId, assetId: parent.assetId } } : {}),
        signal: controller.signal,
        onProgress: (progress) => {
          if (expectedRunEpoch === agentRunEpochRef.current) updateProviderProgress(job.id, progress);
        },
        paidConfirmationToken,
      });
      const result: ProviderRunResult = isVideo
        && !providerResult.ok
        && providerResult.error.code === 'CORE009_VIDEO_TIMEOUT'
        ? {
            ok: false,
            error: {
              code: 'CORE009_VIDEO_TIMEOUT',
              message: '本地等待已达到十二分钟上限；只能重查原视频任务，不会重新提交付费生成。',
              retryable: true,
              retryScope: 'status-only',
            },
          }
        : providerResult;
      const providerCostUsd = await resolvedProviderCost();
      const videoDeadlineRecovery = isVideo
        && !result.ok
        && result.error.code === 'CORE009_VIDEO_DEADLINE_EXCEEDED'
        && result.error.retryScope === 'status-only'
        && (controller.signal.reason === 'RUN_DEADLINE_EXCEEDED' || input.signal?.reason === 'RUN_DEADLINE_EXCEEDED');
      if (videoDeadlineRecovery && expectedRunEpoch === agentRunEpochRef.current) {
        // A runtime deadline is not a user cancellation. Persist only the
        // status-only failure so the already-paid task can be rechecked; never
        // accept a late success result and never issue another paid submit.
        const settledDeadline = await finishJob(nodeId, job.id, result, expectedRunEpoch);
        if (settledDeadline && !settledDeadline.ok) {
          return { ok: false, jobId: job.id, nodeId, errorCode: settledDeadline.error.code, retryable: true, costUsd: providerCostUsd };
        }
      }
      if (expectedRunEpoch !== agentRunEpochRef.current) {
        return interruptedAfterRecordCreation(providerCostUsd);
      }
      if (controller.signal.aborted || input.signal?.aborted) {
        return interruptedAfterRecordCreation(providerCostUsd);
      }
      const settledResult = await finishJob(nodeId, job.id, result, expectedRunEpoch, controller.signal);
      if (!settledResult) return interruptedAfterRecordCreation(providerCostUsd);
      if (!settledResult.ok) return { ok: false, jobId: job.id, nodeId, errorCode: settledResult.error.code, retryable: settledResult.error.retryable, costUsd: providerCostUsd };
      const outputs = workspaceRef.current.selectedIds.flatMap((selectedId) => {
        const outputNode = workspaceRef.current.nodes.find((candidate) => (
          candidate.id === selectedId
          && candidate.jobId === job.id
          && candidate.status === 'ready'
          && candidate.assetId
          && candidate.versionId
        ));
        return outputNode?.assetId && outputNode.versionId
          ? [{ nodeId: outputNode.id, versionId: outputNode.versionId, assetId: outputNode.assetId }]
          : [];
      });
      const primaryOutput = outputs[0];
      if (!primaryOutput) return { ok: false, jobId: job.id, nodeId, errorCode: 'CORE013_SETTLED_OUTPUTS_MISSING', retryable: false, costUsd: providerCostUsd };
      return { ok: true, jobId: job.id, ...primaryOutput, outputs, costUsd: providerCostUsd };
    } catch {
      const providerCostUsd = providerExecutionStarted ? await resolvedProviderCost() : 0;
      if (
        expectedRunEpoch !== agentRunEpochRef.current
        || controller.signal.aborted
        || input.signal?.aborted
        || (requiresTarget && (!targetBinding || !canvasTargetBindingMatches(workspaceRef.current, targetBinding)))
      ) return interruptedAfterRecordCreation(providerCostUsd);
      const code = isVideo ? 'CORE009_VIDEO_EXECUTION_FAILED' : 'CORE008_IMAGE_EXECUTION_FAILED';
      await finishJob(nodeId, job.id, { ok: false, error: { code, message: `${isVideo ? '视频' : '图片'}动作执行异常；未自动重提付费任务。`, retryable: false, retryScope: 'none' } }, expectedRunEpoch, controller.signal);
      return { ok: false, jobId: job.id, nodeId, errorCode: code, retryable: false, costUsd: providerCostUsd };
    } finally {
      input.signal?.removeEventListener('abort', abortFromRuntime);
      abortControllersRef.current.delete(job.id);
    }
  };

  const beginBoundedRun = async (intent: UserIntent, nextPlan: AgentPlan, options: { retryId?: string; attempt?: number; sendAuthorizationId: string }) => {
    if (executionBoundaryActive(false)) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '已有一个 Agent 或媒体任务在运行；本次未启动第二个运行，也未提交新的付费请求。', time: nowLabel() }],
      }));
      return;
    }
    const sendAuthorization = sendAuthorizationRef.current;
    if (
      !sendAuthorization
      || sendAuthorization.id !== options.sendAuthorizationId
      || !bindAuthorizationPlan(sendAuthorization, intent, nextPlan)
    ) {
      setPlan(null);
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '本次媒体动作缺少与 Intent 和 Plan 精确绑定的发送授权；未创建 Job 或调用 Provider。', time: nowLabel() }],
      }));
      return;
    }
    runStartInFlightRef.current = true;
    try {
    const runEpoch = ++agentRunEpochRef.current;
    if (intent.operation === 'clarify' || nextPlan.operation === 'clarify') {
      setPlan(null);
      sendAuthorizationRef.current = null;
      replaceWithoutHistory((current) => ({
        ...current,
        pendingPlanId: undefined,
        plans: current.plans.map((item) => item.id === nextPlan.id ? { ...item, status: 'approved' as const } : item),
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: nextPlan.summary || '需要补充创作类型或画布选择；未创建 Provider Job。', time: nowLabel() }],
      }));
      return;
    }
    const isVideoPlan = intent.operation === 'video_image_to_video';
    const remoteProvider = nextPlan.providerId === 'evolink-gpt-image-2' || nextPlan.providerId === 'evolink-sora-2-preview';
    const targetBinding = intent.targetCanvasObjectId ? captureCanvasTargetBinding(workspaceRef.current, intent.targetCanvasObjectId) : undefined;
    if (intent.targetCanvasObjectId && !targetBinding) {
      setPlan(null);
      setPlanning({ status: 'failed', request: {
        prompt: intent.prompt,
        targetCanvasObjectId: intent.targetCanvasObjectId,
        referenceKind: intent.operation === 'image_edit_user_reference' ? 'user-upload' : 'fixed-demo',
        ...(intent.operation === 'image_edit_user_reference' ? { consentVersion: REFERENCE_TRANSFER_CONSENT_VERSION } : {}),
        imageProviderId: nextPlan.providerId === 'evolink-gpt-image-2' ? 'evolink-gpt-image-2' : 'deterministic-mock',
      }, error: { code: 'CORE008_TARGET_BINDING_STALE', message: '引用对象或版本已变化；未创建媒体任务，请重新选择对象并规划。', retryable: false } });
      return;
    }
    const mediaActionId = `action-${nextPlan.id}`;
    agentTargetBindingsRef.current.clear();
    if (targetBinding) agentTargetBindingsRef.current.set(mediaActionId, targetBinding);
    let milestoneBudget: MilestoneBudgetStatus = { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 };
    if (remoteProvider) {
      try {
        milestoneBudget = await readCore009BudgetStatus();
        milestoneBudget.reservationPerAttemptUsd = milestoneBudget.providerReservations?.[isVideoPlan ? 'video' : 'image'] ?? milestoneBudget.reservationPerAttemptUsd;
      } catch {
        if (runEpoch !== agentRunEpochRef.current) return;
        setPlan(null);
        setPlanning({ status: 'failed', request: {
          prompt: intent.prompt,
          targetCanvasObjectId: intent.targetCanvasObjectId,
          ...(targetBinding ? { targetBinding } : {}),
          referenceKind: intent.targetCanvasObjectId ? intent.operation === 'image_edit_user_reference' ? 'user-upload' : 'fixed-demo' : undefined,
          ...(intent.operation === 'image_edit_user_reference' ? { consentVersion: REFERENCE_TRANSFER_CONSENT_VERSION } : {}),
          imageProviderId: 'evolink-gpt-image-2',
        }, error: { code: 'CORE009_BUDGET_STATUS_UNAVAILABLE', message: '无法验证 CORE-009 独立里程碑预算，未创建媒体任务。', retryable: true } });
        return;
      }
    } else {
      // A local fallback must keep working when the budget service is down or
      // exhausted. When available, its redacted total is still shown so a
      // prior Planner charge is not misleadingly displayed as zero.
      try { milestoneBudget = await readCore009BudgetStatus(); }
      catch { /* deterministic execution has no paid reservation */ }
    }
    if (runEpoch !== agentRunEpochRef.current) return;
    let lastVerifiedDeltaSha256: string | undefined;
    const observeCanvasContext = () => buildCanvasContextGraphSnapshot(workspaceRef.current, {
      currentPlan: nextPlan,
      lastVerifiedDeltaSha256,
    });
    const memoryStore = createMemoryCheckpointStore();
    const checkpointStore = {
      async save(checkpoint: AgentCheckpoint) {
        await memoryStore.save(checkpoint);
        syncAgentRun(checkpoint.run, runEpoch);
      },
      load: (runId: string) => memoryStore.load(runId),
    };
    let runtime!: CreativeDirectorRuntime;
    let activeRunId: string | undefined;
    const reconcileTerminalBudget = async (costUsd: number) => {
      if (!remoteProvider || !activeRunId) return;
      let authoritativeSpentUsd = Math.min(milestoneBudget.capUsd, milestoneBudget.usedUsd + Math.max(0, costUsd));
      try {
        authoritativeSpentUsd = (await readCore009BudgetStatus()).usedUsd;
      } catch {
        // The local server ledger remains authoritative. When it is temporarily
        // unreadable after submission, retain the conservative cost already
        // returned by the image execution boundary instead of displaying zero.
      }
      try {
        const reconciled = await runtime.reconcileAuthoritativeTerminalSpend(activeRunId, authoritativeSpentUsd);
        if (reconciled) syncAgentRun(reconciled, runEpoch);
      } catch {
        // Never revive or mutate a terminal run when the ledger is inconsistent.
      }
    };
    const canvasExecutor = createCanvasActionExecutor({
      readWorkspace: () => workspaceRef.current,
      writeWorkspace: (next) => commit(() => next),
      async createImageJob(action, signal) {
        if (runEpoch !== agentRunEpochRef.current || signal.aborted) {
          return { ok: false, summary: 'Agent 运行已失效。', errorCode: 'CORE008_RUN_INVALIDATED', retryable: false, costUsd: 0 };
        }
        const currentIntent = workspaceRef.current.intents.find((item) => item.id === action.intentId);
        const currentPlan = workspaceRef.current.plans.find((item) => item.id === action.planId);
        if (!currentIntent || !currentPlan || currentPlan.intentId !== currentIntent.id || currentIntent.operation !== action.operation) {
          return { ok: false, summary: 'Intent、Plan 与画布上下文不一致。', errorCode: 'CORE008_PLAN_BINDING_INVALID', retryable: false, costUsd: 0 };
        }
        const currentTargetBinding = agentTargetBindingsRef.current.get(action.actionId);
        if (
          currentIntent.operation !== 'image_generate'
          && (!currentTargetBinding || currentTargetBinding.objectId !== currentIntent.targetCanvasObjectId || !canvasTargetBindingMatches(workspaceRef.current, currentTargetBinding))
        ) {
          return { ok: false, summary: '引用对象、Asset 或 Version 已变化。', errorCode: 'CORE008_TARGET_BINDING_STALE', retryable: false, costUsd: 0 };
        }
        const before = await observeCanvasContext();
        const outcome = await startGeneration({
          intent: currentIntent,
          plan: currentPlan,
          parentId: currentIntent.targetCanvasObjectId,
          retryId: options.retryId,
          attempt: options.attempt,
          signal,
          expectedRunEpoch: runEpoch,
          targetBinding: currentTargetBinding,
          sendAuthorizationId: sendAuthorization.id,
        });
        await reconcileTerminalBudget(outcome.costUsd);
        if (!outcome.ok) {
          return { ok: false, summary: '图片 Job 未完成。', errorCode: outcome.errorCode, retryable: false, costUsd: outcome.costUsd };
        }
        const after = await observeCanvasContext();
        if (before.semanticSha256 !== after.semanticSha256) lastVerifiedDeltaSha256 = after.semanticSha256;
        return {
          ok: true,
          changed: before.semanticSha256 !== after.semanticSha256,
          summary: '图片 Job、Asset、Canvas Object 与 Version 已创建。',
          deltaSha256: after.semanticSha256,
          outputIds: generationOutcomeOutputIds(outcome),
          costUsd: outcome.costUsd,
        };
      },
      async createVideoJob(action, signal) {
        if (runEpoch !== agentRunEpochRef.current || signal.aborted) {
          return { ok: false, summary: 'Agent 运行已失效。', errorCode: 'CORE009_RUN_INVALIDATED', retryable: false, costUsd: 0 };
        }
        const currentIntent = workspaceRef.current.intents.find((item) => item.id === action.intentId);
        const currentPlan = workspaceRef.current.plans.find((item) => item.id === action.planId);
        if (!currentIntent || !currentPlan || currentPlan.intentId !== currentIntent.id || currentIntent.operation !== 'video_image_to_video' || currentPlan.operation !== 'video_image_to_video') {
          return { ok: false, summary: 'Video Intent、Plan 与画布上下文不一致。', errorCode: 'CORE009_VIDEO_PLAN_BINDING_INVALID', retryable: false, costUsd: 0 };
        }
        const currentTargetBinding = agentTargetBindingsRef.current.get(action.actionId);
        if (!currentTargetBinding || currentTargetBinding.objectId !== currentIntent.targetCanvasObjectId || !canvasTargetBindingMatches(workspaceRef.current, currentTargetBinding)) {
          return { ok: false, summary: '图生视频源图、Asset 或 Version 已变化。', errorCode: 'CORE009_VIDEO_SOURCE_BINDING_STALE', retryable: false, costUsd: 0 };
        }
        if (currentTargetBinding.assetId !== action.sourceAssetId || currentTargetBinding.versionId !== action.sourceVersionId) {
          return { ok: false, summary: '视频动作的源 Asset 或 Version 与发送时绑定不一致。', errorCode: 'CORE009_VIDEO_SOURCE_BINDING_STALE', retryable: false, costUsd: 0 };
        }
        const before = await observeCanvasContext();
        const outcome = await startGeneration({
          intent: currentIntent,
          plan: currentPlan,
          parentId: currentIntent.targetCanvasObjectId,
          retryId: options.retryId,
          attempt: options.attempt,
          signal,
          expectedRunEpoch: runEpoch,
          targetBinding: currentTargetBinding,
          sendAuthorizationId: sendAuthorization.id,
        });
        await reconcileTerminalBudget(outcome.costUsd);
        if (!outcome.ok) return { ok: false, summary: '四秒图生视频 Job 未完成。', errorCode: outcome.errorCode, retryable: false, costUsd: outcome.costUsd };
        const after = await observeCanvasContext();
        if (before.semanticSha256 !== after.semanticSha256) lastVerifiedDeltaSha256 = after.semanticSha256;
        return {
          ok: true,
          changed: before.semanticSha256 !== after.semanticSha256,
          summary: '视频 Job、MP4 Asset、Canvas Object 与子 Version 已创建。',
          deltaSha256: after.semanticSha256,
          outputIds: generationOutcomeOutputIds(outcome),
          costUsd: outcome.costUsd,
        };
      },
    });
    runtime = createCreativeDirectorRuntime({
      observer: { observe: () => observeCanvasContext() },
      planner: {
        async nextAction(input) {
          if (input.currentStep === 1) {
            if (isVideoPlan) {
              if (!targetBinding?.assetId || !targetBinding.versionId || !intent.targetCanvasObjectId) {
                return { type: 'ask_user', actionId: `ask-${nextPlan.id}`, prompt: '请只选择一张本地可恢复的图片后再发送。' };
              }
              return {
                type: 'create_video_job',
                actionId: mediaActionId,
                intentId: intent.id,
                planId: nextPlan.id,
                operation: 'video_image_to_video',
                sourceCanvasObjectId: intent.targetCanvasObjectId,
                sourceVersionId: targetBinding.versionId,
                sourceAssetId: targetBinding.assetId,
                paid: true,
                estimatedCostUsd: milestoneBudget.reservationPerAttemptUsd,
              };
            }
            return {
              type: 'create_image_job',
              actionId: mediaActionId,
              intentId: intent.id,
              planId: nextPlan.id,
              operation: intent.operation,
              paid: remoteProvider,
              estimatedCostUsd: remoteProvider ? milestoneBudget.reservationPerAttemptUsd : 0,
            };
          }
          return { type: 'finish', actionId: `finish-${nextPlan.id}`, summary: '已完成画布结果验证与本地 checkpoint。' };
        },
      },
      executor: canvasExecutor,
      checkpointStore,
    });
    if (runEpoch !== agentRunEpochRef.current) return;
    creativeDirectorRuntimeRef.current = runtime;
    try {
      const run = await runtime.start({
        publicGoal: intent.goal,
        planSummary: nextPlan.summary,
        budgetCapUsd: milestoneBudget.capUsd,
        budgetSpentUsd: milestoneBudget.usedUsd,
        creationMode: intent.creationMode ?? 'agent',
        generationPolicy: 'single-xor',
        budgetMilestone: 'CORE009',
        maxSteps: 4,
        deadlineMs: isVideoPlan ? VIDEO_AGENT_RUN_DEADLINE_MS : IMAGE_AGENT_RUN_DEADLINE_MS,
      });
      activeRunId = run.id;
      if (runEpoch !== agentRunEpochRef.current) return;
      if (
        run.state === 'AWAITING_CONFIRMATION'
        && (run.pendingConfirmation?.kind === 'PAID_ACTION' || run.pendingConfirmation?.kind === 'ACTION')
        && run.pendingConfirmation.actionId
      ) {
        const pendingAction = run.steps.at(-1)?.action;
        const actionId = pendingAction?.actionId === mediaActionId && (pendingAction.type === 'create_image_job' || pendingAction.type === 'create_video_job')
          ? pendingAction.actionId
          : !isVideoPlan ? resolvePendingImageActionId(run, intent, nextPlan) : undefined;
        const targetBindingForAction = actionId ? agentTargetBindingsRef.current.get(actionId) : undefined;
        const targetIsCurrent = intent.operation === 'image_generate' || Boolean(
          actionId
          && targetBindingForAction
          && targetBindingForAction.objectId === intent.targetCanvasObjectId
          && canvasTargetBindingMatches(workspaceRef.current, targetBindingForAction),
        );
        const estimatedCostUsd = run.pendingConfirmation.estimatedCostUsd
          ?? (pendingAction?.type === 'create_image_job' || pendingAction?.type === 'create_video_job' ? pendingAction.estimatedCostUsd : 0);
        if (
          !actionId
          || !targetIsCurrent
          || sendAuthorizationRef.current !== sendAuthorization
          || !(isVideoPlan
            ? consumeVideoAuthorization(sendAuthorization, intent, nextPlan, estimatedCostUsd)
            : consumeImageAuthorization(sendAuthorization, intent, nextPlan, estimatedCostUsd))
        ) {
          const cancelled = await runtime.cancel(run);
          if (runEpoch !== agentRunEpochRef.current) return;
          setPlan(null);
          syncAgentRun(cancelled, runEpoch);
          replaceWithoutHistory((current) => ({
            ...current,
            messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: targetIsCurrent ? `本次发送的${isVideoPlan ? '视频' : '图片'}授权已使用、超出 CORE-009 上限或与计划不匹配；未调用 Provider。` : '引用对象、Asset 或 Version 已变化；本次动作已取消，未调用 Provider。', time: nowLabel() }],
          }));
          if (sendAuthorizationRef.current === sendAuthorization) sendAuthorizationRef.current = null;
          return;
        }
        imageConfirmationInFlightRef.current = true;
        setPlan(null);
        setTransferConsentChecked(false);
        try {
          const nextRun = await runtime.confirmAction(run, true);
          if (runEpoch !== agentRunEpochRef.current) return;
          agentTargetBindingsRef.current.delete(actionId);
          syncAgentRun(nextRun, runEpoch);
          if (sendAuthorizationRef.current === sendAuthorization && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(nextRun.state)) sendAuthorizationRef.current = null;
        } catch {
          agentTargetBindingsRef.current.delete(actionId);
          if (runEpoch === agentRunEpochRef.current) {
            replaceWithoutHistory((current) => ({ ...current, messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '无法执行本次发送授权的媒体动作，未自动重试付费任务。', time: nowLabel() }] }));
          }
          if (sendAuthorizationRef.current === sendAuthorization) sendAuthorizationRef.current = null;
        } finally {
          imageConfirmationInFlightRef.current = false;
        }
        return;
      }
      setPlan(null);
      syncAgentRun(run, runEpoch);
      if (sendAuthorizationRef.current === sendAuthorization && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) sendAuthorizationRef.current = null;
    } catch {
      if (runEpoch !== agentRunEpochRef.current) return;
      setPlan(null);
      setPlanning({ status: 'failed', request: {
          prompt: intent.prompt,
          targetCanvasObjectId: intent.targetCanvasObjectId,
          ...(targetBinding ? { targetBinding } : {}),
        referenceKind: intent.targetCanvasObjectId ? intent.operation === 'image_edit_user_reference' ? 'user-upload' : 'fixed-demo' : undefined,
        ...(intent.operation === 'image_edit_user_reference' ? { consentVersion: REFERENCE_TRANSFER_CONSENT_VERSION } : {}),
        imageProviderId: nextPlan.providerId === 'evolink-gpt-image-2' ? 'evolink-gpt-image-2' : 'deterministic-mock',
      }, error: { code: 'CORE008_RUNTIME_START_FAILED', message: '有界 Agent Runtime 无法建立安全 checkpoint。', retryable: false } });
    }
    } finally {
      runStartInFlightRef.current = false;
    }
  };

  const pauseAgentRun = () => {
    const runtime = creativeDirectorRuntimeRef.current;
    const run = agentRunRef.current;
    if (!runtime || !run) return;
    const expectedEpoch = agentRunEpochRef.current;
    void runtime.pause(run).then((next) => syncAgentRun(next, expectedEpoch));
  };

  const continueAgentRun = (userResponse?: string) => {
    const runtime = creativeDirectorRuntimeRef.current;
    const run = agentRunRef.current;
    if (!runtime || !run) return;
    const expectedEpoch = agentRunEpochRef.current;
    void runtime.continueRun(run, run.pendingConfirmation?.kind === 'USER_RESPONSE' ? { userResponse } : {}).then((next) => syncAgentRun(next, expectedEpoch));
  };

  const cancelAgentRun = () => {
    const runtime = creativeDirectorRuntimeRef.current;
    const run = agentRunRef.current;
    if (!runtime || !run) return;
    setPlan(null);
    sendAuthorizationRef.current = null;
    const expectedEpoch = agentRunEpochRef.current;
    void runtime.cancel(run).then((next) => syncAgentRun(next, expectedEpoch));
  };

  const beginEdit = () => {
    const selected = workspaceRef.current.nodes.find((node) => workspaceRef.current.selectedIds.includes(node.id) && node.status === 'ready');
    if (!selected || !['ready', 'fixed-demo'].includes(resolveAssetPresentation(selected, workspaceRef.current.assets, assetUrls, unavailableAssetIds).status)) return;
    replaceWithoutHistory((current) => ({ ...current, creationMode: 'image' }));
    setMobilePane('agent');
    document.querySelector<HTMLTextAreaElement>('[data-testid="agent-input"]')?.focus();
  };

  const retryNode = (node: CanvasNode) => {
    if (executionBoundaryActive()) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '当前 Agent 或媒体任务尚未结束；本次重试已拒绝，未新建运行或付费任务。', time: nowLabel() }],
      }));
      return;
    }
    const previousJob = workspaceRef.current.jobs.find((job) => job.id === node.jobId);
    const intent = previousJob ? workspaceRef.current.intents.find((item) => item.id === previousJob.intentId) : undefined;
    const retryPlan = previousJob ? workspaceRef.current.plans.find((item) => item.id === previousJob.planId) : undefined;
    if (!previousJob || !intent || !retryPlan) return;
    if (previousJob.error?.retryScope === 'local-result' || previousJob.error?.retryScope === 'status-only') {
      void resumeExistingProviderTask(node, previousJob, intent, retryPlan, previousJob.error.retryScope);
      return;
    }
    if (!previousJob.error?.retryable || previousJob.error.retryScope === 'none') return;
    const parentReady = intent.targetCanvasObjectId
      ? workspaceRef.current.nodes.some((item) => item.id === intent.targetCanvasObjectId && item.status === 'ready')
      : false;
    sendAuthorizationRef.current = null;
    setPlan(null);
    setPlanning(null);
    setDraft(intent.prompt);
    replaceWithoutHistory((current) => ({
      ...current,
      selectedIds: parentReady && intent.targetCanvasObjectId ? [intent.targetCanvasObjectId] : [],
      messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '失败指令已填回输入框；本次点击没有调用 Provider。再次按发送将作为一条新的发送授权。', time: nowLabel() }],
    }));
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('[data-testid="agent-input"]')?.focus());
  };

  const resumeExistingProviderTask = async (node: CanvasNode, job: GenerationJob, intent: UserIntent, retryPlan: AgentPlan, resumeScope: 'local-result' | 'status-only') => {
    if (providerRecoveryInFlightRef.current.has(job.id) || executionBoundaryActive()) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '已有一个受控运行处于活动状态；未同时重查或重取另一个 Provider 任务。', time: nowLabel() }],
      }));
      return;
    }
    const expectedRunEpoch = agentRunEpochRef.current;
    providerRecoveryInFlightRef.current.add(job.id);
    const controller = new AbortController();
    abortControllersRef.current.set(job.id, controller);
    replaceWithoutHistory((current) => ({
      ...current,
      nodes: current.nodes.map((item) => item.id === node.id ? { ...item, status: 'generating' } : item),
      jobs: current.jobs.map((item) => item.id === job.id ? { ...item, status: resumeScope === 'local-result' ? 'local_result_pending' : 'processing', progress: resumeScope === 'local-result' ? 92 : 74, error: undefined, updatedAt: new Date().toISOString() } : item),
      versions: current.versions.map((version) => version.jobId === job.id ? { ...version, status: 'pending' } : version),
      selectedIds: [node.id],
    }));
    try {
    let referenceBlob: Blob | undefined;
    if (intent.operation === 'image_edit_user_reference' || intent.operation === 'video_image_to_video') {
      const parent = node.parentId ? workspaceRef.current.nodes.find((item) => item.id === node.parentId) : undefined;
      const parentAsset = parent?.assetId ? workspaceRef.current.assets.find((asset) => asset.id === parent.assetId) : undefined;
      if (parentAsset?.storage) {
        try { referenceBlob = await blobStoreRef.current.get(parentAsset.storage); } catch { referenceBlob = undefined; }
      }
      if (!referenceBlob) {
        await finishJob(node.id, job.id, { ok: false, error: { code: intent.operation === 'video_image_to_video' ? 'CORE009_VIDEO_REFERENCE_BLOB_MISSING' : 'CORE007_REFERENCE_BLOB_MISSING', message: '无法读取本地参考图；不会创建新的付费任务。', retryable: false, retryScope: 'none' } }, expectedRunEpoch, controller.signal);
        return;
      }
    }
      const parent = node.parentId ? workspaceRef.current.nodes.find((item) => item.id === node.parentId) : undefined;
      const result = await runtimeFor(job.providerId).execute(job, intent, retryPlan, {
        referenceBlob,
        ...(intent.operation === 'video_image_to_video' && parent?.assetId && parent.versionId ? { sourceBinding: { canvasObjectId: parent.id, versionId: parent.versionId, assetId: parent.assetId } } : {}),
        resumeScope,
        signal: controller.signal,
        onProgress: (progress) => {
          if (expectedRunEpoch === agentRunEpochRef.current && !controller.signal.aborted) updateProviderProgress(job.id, progress);
        },
      });
      if (expectedRunEpoch !== agentRunEpochRef.current || controller.signal.aborted) return;
      const settledResult = await finishJob(node.id, job.id, result, expectedRunEpoch, controller.signal);
      if (
        settledResult?.ok
        && expectedRunEpoch === agentRunEpochRef.current
        && !controller.signal.aborted
        && workspaceRef.current.jobs.some((currentJob) => currentJob.id === job.id && currentJob.status === 'succeeded')
      ) {
        replaceWithoutHistory((current) => ({
          ...current,
          messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '原 AgentRun 已结束；当前 Job 已独立恢复成功，未重新提交付费生成。', time: nowLabel() }],
        }));
      }
    } finally {
      abortControllersRef.current.delete(job.id);
      providerRecoveryInFlightRef.current.delete(job.id);
    }
  };

  const removeNodes = useCallback(async (ids: string[], reason: 'delete' | 'soft-cancel') => {
    if (workflowRunningRef.current && reason !== 'soft-cancel') {
      setCanvasToolStatus('节点正在执行，请先取消或等待结束再删除。');
      return;
    }
    if (workspaceHasActiveJob(workspaceRef.current) && reason !== 'soft-cancel') {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '媒体动作执行期间已锁定对象写入；请先取消当前运行。', time: nowLabel() }],
      }));
      return;
    }
    const planned = deleteCanvasNodesKeepingProjectAssets(workspaceRef.current, ids, reason);
    if (!planned.ok) {
      if (planned.reason === 'HAS_CHILDREN') {
        replaceWithoutHistory((current) => ({ ...current, messages: [...current.messages, workspaceAuditMessage('CORE007_DELETE_BLOCKED_LINEAGE')] }));
      }
      return;
    }
    const plannerTargetRemoved = Boolean(plannerTargetBindingRef.current && ids.includes(plannerTargetBindingRef.current.objectId));
    const agentTargetRemoved = [...agentTargetBindingsRef.current.values()].some((binding) => ids.includes(binding.objectId));
    if (agentTargetRemoved) sendAuthorizationRef.current = null;
    if (plannerTargetRemoved) {
      const providerRequestAlreadySubmitted = plannerProviderRequestEpochRef.current === planningEpochRef.current;
      planningEpochRef.current += 1;
      plannerAbortControllerRef.current?.abort();
      plannerAbortControllerRef.current = null;
      plannerConfirmationInFlightRef.current = false;
      plannerTargetBindingRef.current = null;
      sendAuthorizationRef.current = null;
      setPlanning((current) => current ? {
        status: 'failed',
        request: current.request,
        error: {
          code: 'CORE008_TARGET_BINDING_STALE',
          message: providerRequestAlreadySubmitted
            ? '引用对象、Asset 或 Version 已变化；已停止本地等待并忽略迟到结果。若远端 Planner 已提交，不代表远端取消或退款。'
            : '引用对象、Asset 或 Version 已变化；本次规划已停止，未继续调用 Planner。',
          retryable: false,
        },
      } : current);
    }
    for (const jobId of planned.cancelledJobIds) abortControllersRef.current.get(jobId)?.abort();
    // Deleting a Canvas Object is no longer equivalent to deleting a project
    // Asset. CORE-012 keeps the Asset metadata and IndexedDB Blob so the same
    // project can place it on the canvas again without copying bytes. A soft
    // cancelled placeholder remains a storage-boundary cleanup transaction.
    if (reason === 'soft-cancel') {
      try {
        await blobStoreRef.current.deleteMany(
          planned.orphanedAssets.flatMap((asset) => asset.storage ? [asset.storage] : []),
          { expectedProjectId: projectId },
        );
      } catch {
        replaceWithoutHistory((current) => ({ ...current, messages: [...current.messages, workspaceAuditMessage('CORE007_DELETE_STORAGE_FAILED')] }));
        return;
      }
      for (const asset of planned.orphanedAssets) {
        hydratedUrlsRef.current.get(asset.id)?.revoke();
        hydratedUrlsRef.current.delete(asset.id);
      }
      setAssetUrls((current) => {
        const next = new Map(current);
        for (const asset of planned.orphanedAssets) next.delete(asset.id);
        return next;
      });
      setUnavailableAssetIds((current) => {
        const next = new Set(current);
        for (const asset of planned.orphanedAssets) next.delete(asset.id);
        return next;
      });
    }
    const applyDeletion = reason === 'soft-cancel' ? commitStorageBoundary : commit;
    applyDeletion((current) => {
      const currentPlan = deleteCanvasNodesKeepingProjectAssets(current, ids, reason);
      return currentPlan.ok ? currentPlan.workspace : current;
    });
    setContextMenu(null);
  }, [commit, commitStorageBoundary, projectId, replaceWithoutHistory]);

  const cancelJob = (node: CanvasNode) => {
    if (!node.jobId || node.status !== 'generating') return;
    void removeNodes([node.id], 'soft-cancel');
  };

  const selectNode = (id: string, additive: boolean) => {
    if (workspaceHasActiveJob(workspaceRef.current)) return;
    replaceWithoutHistory((current) => {
      const selected = additive
        ? current.selectedIds.includes(id) ? current.selectedIds.filter((item) => item !== id) : [...current.selectedIds, id]
        : [id];
      return { ...current, selectedIds: selected };
    });
  };

  const deleteSelected = useCallback(() => {
    const ids = workspaceRef.current.selectedIds;
    if (!ids.length) return;
    void removeNodes(ids, 'delete');
  }, [removeNodes]);

  const addProjectAssetToCanvas = useCallback((assetId: string): AssetAddResult => {
    const request = { requestId: `workspace-${uniqueId('asset-add')}`, assetId };
    if (executionBoundaryActive()) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '当前 Agent 或媒体任务仍在运行，资产尚未添加到画布。', time: nowLabel() }],
      }));
      return { ...request, ok: false, code: 'WORKSPACE_LOCKED' };
    }
    const asset = workspaceRef.current.assets.find((item) => item.id === assetId);
    if (!asset) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '当前项目中找不到该资产，未创建画布对象或版本。', time: nowLabel() }],
      }));
      return { ...request, ok: false, code: 'ASSET_NOT_FOUND' };
    }
    const presentation = resolveProjectAssetPresentation(asset, assetUrls, unavailableAssetIds);
    if (presentation.status !== 'ready') {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: presentation.status === 'pending' ? '资产仍在从本机恢复，暂未添加到画布。' : '资产的本机 Blob 缺失或损坏，未使用演示素材替代。', time: nowLabel() }],
      }));
      return { ...request, ok: false, code: 'ASSET_UNAVAILABLE' };
    }
    let added = false;
    commit((current) => {
      const next = reuseProjectAssetOnCanvas(current, assetId);
      if (!next) return current;
      added = true;
      return {
        ...next,
        messages: [...next.messages, { id: uniqueId('agent'), role: 'agent', body: `已将${asset.kind === 'video' ? '视频' : '图片'}资产重新放入当前项目画布；复用原 Asset 与 Blob，并创建新的根 Version。`, time: nowLabel() }],
      };
    });
    return added ? { ...request, ok: true } : { ...request, ok: false, code: 'ASSET_NOT_FOUND' };
  }, [assetUrls, commit, replaceWithoutHistory, unavailableAssetIds]);

  useEffect(() => {
    if (!assetToAdd) {
      const prefix = `${projectId}:`;
      for (const key of externalAssetApplications) if (key.startsWith(prefix)) externalAssetApplications.delete(key);
      return;
    }
    const applicationKey = `${projectId}:${assetToAdd.requestId}`;
    if (externalAssetApplications.has(applicationKey)) return;
    const asset = workspaceRef.current.assets.find((item) => item.id === assetToAdd.assetId);
    if (asset?.storage && !assetUrls.has(asset.id) && !unavailableAssetIds.has(asset.id)) return;
    externalAssetApplications.add(applicationKey);
    const result = addProjectAssetToCanvas(assetToAdd.assetId);
    onAssetAdded?.({ ...result, requestId: assetToAdd.requestId, assetId: assetToAdd.assetId });
  }, [addProjectAssetToCanvas, assetToAdd, assetUrls, onAssetAdded, projectId, unavailableAssetIds]);

  const exportCurrentProjectReceipt = async () => {
    if (exportStatus === 'working') return;
    setExportStatus('working');
    setExportError('');
    try {
      const receipt = await captureCore009LiveReceipt({
        workspace: workspaceRef.current,
        run: restoredAgentRun,
        blobStore: blobStoreRef.current,
      });
      downloadCore009LiveReceipt(receipt);
      setExportStatus('success');
    } catch (error) {
      setExportError(error instanceof Error ? error.message.slice(0, 120) : 'CORE009_RECEIPT_UNKNOWN_ERROR');
      setExportStatus('failed');
    }
  };

  const exportSelectedMedia = async () => {
    if (exportStatus === 'working') return;
    const request = ++exportRequestRef.current;
    const target = resolveMediaExportTarget(workspaceRef.current, projectId);
    const isCurrent = () => appInstanceActiveRef.current && request === exportRequestRef.current
      && target?.key === resolveMediaExportTarget(workspaceRef.current, projectId)?.key;
    setExportStatus('working');
    setExportError('');
    setPreparedExport(null);
    try {
      if (!target) throw new Error('请只选择一个原件可恢复的已完成图片或视频。');
      const blob = await readMediaExportBlob(target, blobStoreRef.current);
      if (!isCurrent()) return;
      setPreparedExport({ url: URL.createObjectURL(blob), filename: target.filename, key: target.key });
      setExportStatus('success');
    } catch (error) {
      if (!isCurrent()) return;
      setExportError(error instanceof Error ? error.message : '素材导出失败。');
      setExportStatus('failed');
    }
  };

  const trashProject = async () => {
    if (!attemptWorkspaceExit()) return;
    if (!onTrashProject) {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '当前入口未提供项目回收站，项目和本地素材均未改变。', time: nowLabel() }],
      }));
      return;
    }
    if (!window.confirm(`将「${projectTitle}」移到回收站？项目画布、资产与本机 Blob 都会保留，可从项目页恢复。`)) return;
    try {
      const moved = await onTrashProject(projectId);
      if (moved === false) throw new Error('LOCAL_PROJECT_TRASH_REJECTED');
    } catch {
      replaceWithoutHistory((current) => ({
        ...current,
        messages: [...current.messages, { id: uniqueId('system'), role: 'system', body: '项目未能移到回收站；项目画布、资产与本机 Blob 均保持原样。', time: nowLabel() }],
      }));
    }
  };

  const handleNodeResize = (event: React.PointerEvent<HTMLElement>, node: CanvasNode, corner: ResizeCorner) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0 || executionBoundaryActive() || workflowRunningRef.current) return;
    setDrag({ kind: 'resize', node: clone(node), corner, startX: event.clientX, startY: event.clientY, before: clone(workspaceRef.current) });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleNodePointerDown = (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => {
    if (event.button !== 0 || executionBoundaryActive() || workflowRunningRef.current) return;
    if (tool === 'hand') return;
    event.stopPropagation();
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    const current = workspaceRef.current;
    const preserveSelectedGroup = !additive && current.selectedIds.length > 1 && current.selectedIds.includes(node.id);
    const ids = additive
      ? current.selectedIds.includes(node.id) ? current.selectedIds.filter((id) => id !== node.id) : [...current.selectedIds, node.id]
      : preserveSelectedGroup ? current.selectedIds : [node.id];
    if (!preserveSelectedGroup) selectNode(node.id, additive);
    const currentNodes = workspaceRef.current.nodes;
    const positions = Object.fromEntries(currentNodes.filter((item) => ids.includes(item.id)).map((item) => [item.id, { x: item.x, y: item.y }]));
    setDrag({ kind: 'node', ids, startX: event.clientX, startY: event.clientY, before: clone(current), positions });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const canvasCoordinates = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canvasRef.current || workspaceHasActiveJob(workspaceRef.current)) return;
    setContextMenu(null);
    if (tool === 'hand') {
      setDrag({ kind: 'pan', startX: event.clientX, startY: event.clientY, viewport: clone(workspaceRef.current.viewport) });
    } else {
      const point = canvasCoordinates(event);
      replaceWithoutHistory((current) => ({ ...current, selectedIds: [] }));
      setDrag({ kind: 'marquee', startX: point.x, startY: point.y, endX: point.x, endY: point.y });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !canvasRef.current || workspaceHasActiveJob(workspaceRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setDrag({ kind: 'pan', startX: event.clientX, startY: event.clientY, viewport: clone(workspaceRef.current.viewport) });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (connectionSource && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const viewport = workspaceRef.current.viewport;
      setConnectionPoint({ x: (event.clientX - rect.left - viewport.x) / viewport.scale, y: (event.clientY - rect.top - viewport.y) / viewport.scale });
    }
    if (!drag || workspaceHasActiveJob(workspaceRef.current)) return;
    if (drag.kind === 'pan') {
      replaceWithoutHistory((current) => ({
        ...current,
        viewport: { ...drag.viewport, x: drag.viewport.x + event.clientX - drag.startX, y: drag.viewport.y + event.clientY - drag.startY },
      }));
    }
    if (drag.kind === 'node') {
      const dx = (event.clientX - drag.startX) / workspaceRef.current.viewport.scale;
      const dy = (event.clientY - drag.startY) / workspaceRef.current.viewport.scale;
      replaceWithoutHistory((current) => ({
        ...current,
        nodes: current.nodes.map((node) => drag.ids.includes(node.id)
          ? { ...node, x: drag.positions[node.id].x + dx, y: drag.positions[node.id].y + dy }
          : node),
      }));
    }
    if (drag.kind === 'resize') {
      const resized = resizeCanvasNode(drag.node, drag.corner, (event.clientX - drag.startX) / workspaceRef.current.viewport.scale, (event.clientY - drag.startY) / workspaceRef.current.viewport.scale);
      replaceWithoutHistory(current => ({ ...current, nodes: current.nodes.map(node => node.id === resized.id ? resized : node) }));
    }
    if (drag.kind === 'marquee') {
      const point = canvasCoordinates(event);
      setDrag({ ...drag, endX: point.x, endY: point.y });
    }
  };

  const handleCanvasPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (connectionSource && canvasRef.current && !(event.target as HTMLElement).closest('button, article')) {
      const rect = canvasRef.current.getBoundingClientRect();
      const viewport = workspaceRef.current.viewport;
      setNodeMenu({ sourceId: connectionSource, x: (event.clientX - rect.left - viewport.x) / viewport.scale, y: (event.clientY - rect.top - viewport.y) / viewport.scale });
      setConnectionSource(null);
      setConnectionPoint(null);
    }
    if (drag?.kind === 'node') {
      const changed = workspaceRef.current.nodes.some(node => drag.positions[node.id] && (node.x !== drag.positions[node.id].x || node.y !== drag.positions[node.id].y));
      if (changed) {
        const history = [...pastRef.current.slice(-49), drag.before];
        pastRef.current = history;
        futureRef.current = [];
        setPast(history);
        setFuture([]);
      }
    }
    if (drag?.kind === 'resize') {
      const current = workspaceRef.current.nodes.find(node => node.id === drag.node.id);
      if (current && (current.width !== drag.node.width || current.height !== drag.node.height)) {
        const history = [...pastRef.current.slice(-49), drag.before];
        pastRef.current = history; futureRef.current = []; setPast(history); setFuture([]);
      }
    }
    if (drag?.kind === 'marquee') {
      const { viewport } = workspaceRef.current;
      const left = Math.min(drag.startX, drag.endX);
      const top = Math.min(drag.startY, drag.endY);
      const right = Math.max(drag.startX, drag.endX);
      const bottom = Math.max(drag.startY, drag.endY);
      const world = {
        left: (left - viewport.x) / viewport.scale,
        top: (top - viewport.y) / viewport.scale,
        right: (right - viewport.x) / viewport.scale,
        bottom: (bottom - viewport.y) / viewport.scale,
      };
      replaceWithoutHistory((current) => ({
        ...current,
        selectedIds: current.nodes.filter((node) => node.x < world.right && node.x + node.width > world.left && node.y < world.bottom && node.y + node.height > world.top).map((node) => node.id),
      }));
    }
    setDrag(null);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (workspaceHasActiveJob(workspaceRef.current)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const normalizedDeltaY = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    replaceWithoutHistory((current) => ({ ...current, viewport: zoomViewportAtPoint(current.viewport, normalizedDeltaY, point) }));
  };

  const beginAgentResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    agentResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: agentPanelWidthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-agent');
  };

  const moveAgentResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = agentResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setAgentPanelWidth(clampAgentPanelWidth(active.startWidth + event.clientX - active.startX));
  };

  const finishAgentResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = agentResizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const width = clampAgentPanelWidth(active.startWidth + event.clientX - active.startX);
    agentResizeRef.current = null;
    setAgentPanelWidth(width);
    window.localStorage.setItem(agentPanelWidthStorageKey(projectId), String(width));
    document.body.classList.remove('is-resizing-agent');
  };

  const handleAgentResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next = agentPanelWidthRef.current;
    if (event.key === 'ArrowLeft') next -= 16;
    else if (event.key === 'ArrowRight') next += 16;
    else if (event.key === 'Home') next = AGENT_PANEL_WIDTH_MIN;
    else if (event.key === 'End') next = AGENT_PANEL_WIDTH_MAX;
    else return;
    event.preventDefault();
    const width = clampAgentPanelWidth(next);
    setAgentPanelWidth(width);
    window.localStorage.setItem(agentPanelWidthStorageKey(projectId), String(width));
  };

  const changeZoom = (amount: number) => {
    if (workspaceHasActiveJob(workspaceRef.current)) return;
    replaceWithoutHistory((current) => ({ ...current, viewport: { ...current.viewport, scale: clampScale(current.viewport.scale + amount) } }));
  };
  const resetView = () => {
    if (workspaceHasActiveJob(workspaceRef.current)) return;
    const current = workspaceRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !current.nodes.length) {
      replaceWithoutHistory((state) => ({ ...state, viewport: { x: 0, y: 0, scale: 1 } }));
      return;
    }
    const left = Math.min(...current.nodes.map(node => node.x));
    const top = Math.min(...current.nodes.map(node => node.y));
    const right = Math.max(...current.nodes.map(node => node.x + node.width));
    const bottom = Math.max(...current.nodes.map(node => node.y + node.height));
    const scale = clampScale(Math.min(1, Math.max(40, rect.width - 60) / (right - left), Math.max(40, rect.height - 170) / (bottom - top)));
    replaceWithoutHistory(state => ({ ...state, viewport: { x: rect.width / 2 - (left + right) / 2 * scale, y: rect.height / 2 - (top + bottom) / 2 * scale, scale } }));
  };
  useEffect(() => {
    if (mobilePane !== 'canvas' || !window.matchMedia('(max-width: 800px)').matches) return;
    const frame = requestAnimationFrame(() => resetView());
    return () => cancelAnimationFrame(frame);
  }, [mobilePane]);
  const toggleTheme = () => {
    if (workspaceHasActiveJob(workspaceRef.current)) return;
    replaceWithoutHistory((current) => ({ ...current, theme: current.theme === 'dark' ? 'light' : 'dark' }));
  };

  const marqueeStyle = useMemo(() => {
    if (drag?.kind !== 'marquee') return undefined;
    return { left: Math.min(drag.startX, drag.endX), top: Math.min(drag.startY, drag.endY), width: Math.abs(drag.endX - drag.startX), height: Math.abs(drag.endY - drag.startY) };
  }, [drag]);
  const selectedReadyNode = workspace.nodes.find((node) => workspace.selectedIds.includes(node.id) && node.status === 'ready');
  const selectedAssetPresentation = selectedReadyNode
    ? resolveAssetPresentation(selectedReadyNode, workspace.assets, assetUrls, unavailableAssetIds)
    : undefined;
  const selectedReadyAsset = selectedReadyNode?.assetId ? workspace.assets.find((asset) => asset.id === selectedReadyNode.assetId) : undefined;
  const selectedEditableNode = selectedReadyNode
    && selectedAssetPresentation?.kind !== 'video'
    && selectedReadyAsset?.kind !== 'video'
    && ['ready', 'fixed-demo'].includes(selectedAssetPresentation?.status ?? '')
    ? selectedReadyNode
    : undefined;
  const selectedEditableAsset = selectedEditableNode?.assetId ? workspace.assets.find((asset) => asset.id === selectedEditableNode.assetId) : undefined;
  const selectedUsesStoredReference = Boolean(selectedEditableAsset?.storage);
  const selectedUsesLocalUpload = selectedEditableAsset?.source === 'local-upload';
  const pendingUserReference = plan?.intent.operation === 'image_edit_user_reference';
  const pendingReferenceNode = pendingUserReference ? workspace.nodes.find((node) => node.id === plan.intent.targetCanvasObjectId) : undefined;
  const pendingReferenceAsset = pendingReferenceNode?.assetId ? workspace.assets.find((asset) => asset.id === pendingReferenceNode.assetId) : undefined;
  const showTransferConsent = selectedUsesStoredReference || Boolean(pendingUserReference && pendingReferenceAsset?.storage);
  const agentRunTerminal = Boolean(agentRun && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(agentRun.state));
  const runLocksComposer = Boolean(agentRun && !agentRunTerminal) || workspaceHasActiveJob(workspace);
  const workspaceMutationLocked = runLocksComposer || workspaceHasActiveJob(workspace);
  const plannerInFlight = planning?.status === 'running';
  // `sendSubmissionInFlight` remains true until the whole send-authorized
  // Planner -> Runtime handoff returns. It is a concurrency lock, not proof
  // that the remote Planner is still running. Showing it as PLANNING made the
  // UI look frozen throughout the subsequent image generation.
  const planningLocksComposer = sendSubmissionInFlight || plannerInFlight;
  const planningBlockedByBudget = planning?.status === 'failed' && planning.error.code === 'CORE009_BUDGET_EXCEEDED';
  const fallbackAuthorization = sendAuthorizationRef.current;
  const planningFallbackAvailable = planning?.status === 'failed'
    && fallbackAuthorizationIsCurrent(planning, fallbackAuthorization, planningEpochRef.current, workspace);
  const agentStatusLabel = plannerInFlight
    ? 'PLANNING'
    : agentRun && !agentRunTerminal
      ? agentRun.state
      : workspaceHasActiveJob(workspace)
        ? 'RUNNING'
        : 'READY';
  const consentReferenceId = pendingUserReference ? pendingReferenceNode?.id : selectedUsesStoredReference ? selectedEditableNode?.id : undefined;
  const contextMenuNode = contextMenu ? workspace.nodes.find((node) => node.id === contextMenu.id) : undefined;
  const contextMenuAsset = contextMenuNode?.assetId ? workspace.assets.find((asset) => asset.id === contextMenuNode.assetId) : undefined;
  const contextMenuPresentation = contextMenuNode
    ? resolveAssetPresentation(contextMenuNode, workspace.assets, assetUrls, unavailableAssetIds)
    : undefined;
  const contextMenuCanCreateChild = Boolean(
    contextMenuNode?.status === 'ready'
    && contextMenuAsset?.kind !== 'video'
    && contextMenuPresentation?.kind !== 'video'
    && ['ready', 'fixed-demo'].includes(contextMenuPresentation?.status ?? ''),
  );
  useEffect(() => setTransferConsentChecked(false), [consentReferenceId]);
  const captureRemoteAssetDimensions = useCallback((assetId: string | undefined, width: number, height: number) => {
    if (!assetId || !width || !height || workspaceHasActiveJob(workspaceRef.current)) return;
    const existing = workspaceRef.current.assets.find((item) => item.id === assetId);
    if (!existing || existing.source !== 'remote-provider' || (existing.metadata.width === width && existing.metadata.height === height)) return;
    replaceWithoutHistory((current) => {
      const asset = current.assets.find((item) => item.id === assetId);
      if (!asset || asset.source !== 'remote-provider' || (asset.metadata.width === width && asset.metadata.height === height)) return current;
      return {
        ...current,
        assets: current.assets.map((item) => item.id === assetId ? { ...item, metadata: { ...item.metadata, width, height } } : item),
      };
    });
  }, [replaceWithoutHistory]);

  return (
    <main className={`app-shell theme-${workspace.theme} mobile-pane-${mobilePane}`} data-testid="elyra-app">
      <nav className="workspace-rail" aria-label="工作台导航">
        <button type="button" onClick={requestExitWorkspace} aria-label="返回首页"><img src="/assets/elyra-mark.svg" alt="ELYRA" /></button>
        <button type="button" onClick={requestExitWorkspace} aria-label="项目首页"><HomeIcon /></button>
        <button type="button" className={mobilePane === 'agent' ? 'is-active' : ''} onClick={() => setMobilePane('agent')} aria-label="显示 Agent"><SparklesIcon /></button>
        <button type="button" className={mobilePane === 'canvas' ? 'is-active' : ''} onClick={() => setMobilePane('canvas')} aria-label="显示画布"><Square2StackIcon /></button>
        <button type="button" onClick={() => { setMobilePane('canvas'); setAssetLibraryOpen(value => !value); setInspectorOpen(false); }} aria-label="打开本地资产"><PhotoIcon /></button>
        <button className="rail-theme" type="button" onClick={toggleTheme} aria-label="日间或夜间">{workspace.theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
      </nav>
      <div className="workbench" style={{ gridTemplateColumns: `${agentPanelWidth}px minmax(0, 1fr)` }}>
        <aside className="agent-panel" data-testid="agent-panel" aria-label="统一 AI Agent">
          <input ref={fileInputRef} className="visually-hidden" data-testid="reference-file-input" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={(event) => void importUserReference(event.target.files?.[0])} />
          <div className="agent-title"><SparklesIcon /><div><strong>ELYRA Agent</strong><small>创意、编辑，始终在同一张画布</small></div><span className="agent-live">{agentStatusLabel === 'READY' ? '就绪' : '执行中'}</span></div>
          <div className="agent-scroll">
            {!workspace.nodes.length && (
              <section className="reference-card empty-reference">
                <PhotoIcon />
                <div><strong>空白项目</strong><p>可添加演示图，或选择你有权使用的非敏感 JPEG、PNG、WebP（≤10 MiB）。</p></div>
                <div className="reference-actions"><button type="button" data-testid="upload-reference" onClick={chooseReferenceFile}><CloudArrowUpIcon />上传参考图</button><button type="button" data-testid="add-reference" onClick={addReference}><PlusIcon />添加演示图</button></div>
              </section>
            )}
            {localUpload.status === 'validating' && <section className="upload-state-card" data-testid="upload-local-progress"><CloudArrowUpIcon /><div><strong>正在本机净化图片</strong><p>真实解码、尺寸校验、去除元数据并写入 IndexedDB。</p><div className="upload-progress"><i style={{ width: `${localUpload.progress}%` }} /></div></div></section>}
            {localUpload.status === 'failed' && <section className="upload-state-card upload-error" data-testid="upload-local-error"><ExclamationTriangleIcon /><div><strong>无法导入参考图</strong><p>{localUpload.message}</p><small>{localUpload.code}</small><button type="button" onClick={chooseReferenceFile}>重新选择</button></div></section>}
            {workspace.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            {!planning && (agentRun || restoredAgentRun) && <AgentRunConsole run={agentRun} restored={restoredAgentRun} restoredBudgetStatus={restoredBudgetStatus} onPause={pauseAgentRun} onContinue={continueAgentRun} onCancel={cancelAgentRun} />}
            {selectedReadyNode && selectedEditableNode && <section className="edit-reference-card" data-testid="edit-reference-card"><img src={selectedAssetPresentation?.url} alt="当前选中的参考图" /><div><span>{workspace.creationMode === 'video' ? '当前视频源图' : '编辑此图'}</span><strong>{selectedEditableNode.name}</strong><p>{workspace.creationMode === 'video' ? '将使用本机可恢复图片生成 4 秒 MP4；源图与父版本不会被覆盖。' : selectedUsesStoredReference ? selectedUsesLocalUpload ? '将本机净化副本作为图生图输入；原图与父版本不会被覆盖。' : '将当前结果的本机 Blob 作为图生图输入；实际选中对象与父版本会保留。' : '使用既有固定演示边界；原始父版本会保留。'}</p></div></section>}
            {selectedReadyAsset?.kind === 'video' && <section className="edit-reference-card video-result-card" data-testid="selected-video-card"><VideoCameraIcon /><div><span>视频结果</span><strong>{selectedReadyNode?.name}</strong><p>已从本机 IndexedDB 恢复 MP4。CORE-009 不支持视频继续作为源图。</p></div></section>}
            {selectedReadyNode && !selectedReadyNode.workflow && !selectedEditableNode && selectedReadyAsset?.kind !== 'video' && <section className="edit-reference-card asset-unavailable-card" data-testid="asset-unavailable" role="status"><ExclamationTriangleIcon /><div><span>{selectedAssetPresentation?.status === 'pending' ? '正在恢复本地素材' : '本地素材不可用'}</span><strong>{selectedReadyNode.name}</strong><p>{selectedAssetPresentation?.status === 'pending' ? '正在校验 IndexedDB 中的媒体 Blob，完成前不会调用 Planner 或 Provider。' : '本地 Blob 已丢失或损坏。不会用演示图冒充，也不会允许付费提交。'}</p></div></section>}
            {plannerInFlight && <section className="planner-state-card" data-testid="agent-planning"><SparklesIcon /><div><strong>Agent 正在规划</strong><p>正在校验画布与预算，并将自然语言需求转换为结构化 Intent 与 Agent Plan…</p></div></section>}
            {planning?.status === 'failed' && <section className={`planner-failure-card${planningBlockedByBudget ? ' planner-budget-blocked' : ''}`} data-testid="planner-failure" role="status"><ExclamationTriangleIcon /><div><strong>{planningBlockedByBudget ? '待预算授权' : planning.error.code === 'CORE009_VIDEO_SOURCE_NOT_RESTORABLE' ? '需要可恢复图片' : '规划失败'}</strong><p>{planning.error.message}</p><small>{planningBlockedByBudget ? '本次未扣费；未调用 Planner、图片 Provider 或视频 Provider；未创建 Job、Asset、Canvas Object 或 Version。' : '未创建 Job、Asset、Canvas Object 或 Version。'}</small>{(planning.error.retryable || planningFallbackAvailable) && <div className="planner-failure-actions">{planning.error.retryable && <button type="button" data-testid="retry-planning" onClick={retryPlanning}>填回并重新发送</button>}{planningFallbackAvailable && <button type="button" data-testid="use-fallback" onClick={useDeterministicFallback}>使用本地规划草案</button>}</div>}</div></section>}
            {plan && (
              <section className="plan-card" data-testid="agent-plan">
                <div className="plan-heading"><SparklesIcon /><span>结构化 Agent Plan</span><em className={`plan-source source-${plan.plan.source}`}>{plan.plan.source === 'remote-agent' ? providerLabels.planner : plan.plan.source === 'fallback' ? 'Fallback · 本地' : 'Legacy'}</em></div>
                <p>{plan.plan.summary}</p>
                <ul>{plan.plan.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
                <p className="plan-operation">{plan.plan.operation === 'video_image_to_video' ? '操作：Sora 2 Preview 单图生 4 秒视频 · 保留源图与父版本' : plan.plan.operation === 'clarify' ? '操作：需要补充信息 · 未创建 Provider Job' : plan.plan.operation === 'image_edit_user_reference' ? '操作：用户参考图编辑 · 保留原图与父版本' : plan.plan.operation === 'image_edit_fixed_demo_reference' ? '操作：固定演示参考图编辑 · 保留父版本' : '操作：文生图 · 创建新画布对象'}</p>
                {plan.plan.source === 'fallback' && <p className="fallback-note">这是你明确选择的 deterministic fallback，不是远程 Agent 规划结果。</p>}
                {plan.plan.providerId === 'evolink-gpt-image-2' && <p className="provider-cost-note">本次发送已授权自动提交最多 1 张 1:1 / medium 的 {providerLabels.image} {plan.intent.targetCanvasObjectId ? '图生图子版本' : '文生图'}任务；不会后台自动重投。</p>}
                {plan.plan.providerId === 'evolink-sora-2-preview' && <p className="provider-cost-note">本次发送已授权最多 1 次 {providerLabels.video} 四秒图生视频；不会同时生成图片，也不会后台自动重投。</p>}
              </section>
            )}
          </div>
          <div className="composer">
            {workspace.selectedIds.length > 0 && <div className="composer-selection" data-testid="agent-canvas-selection"><Square2StackIcon /><span>已引用 {workspace.selectedIds.length} 个对象</span><button type="button" aria-label="取消引用选区" disabled={planningLocksComposer || runLocksComposer} onClick={() => replaceWithoutHistory(current => ({ ...current, selectedIds: [] }))}><XMarkIcon /></button></div>}
            <div className="canvas-command-chips" aria-label="Agent 画布动作">
              <button type="button" disabled={planningLocksComposer || runLocksComposer || !workspace.nodes.length} onClick={() => void runCanvasCommand('全部对象网格排列')}>整理画布</button>
              <button type="button" disabled={planningLocksComposer || runLocksComposer || !workspace.selectedIds.length} onClick={() => void runCanvasCommand('选中对象横向排列')}>横向排列</button>
              <button type="button" disabled={planningLocksComposer || runLocksComposer || !workspace.selectedIds.length} onClick={() => void runCanvasCommand('选中对象缩放到120%')}>放大选区</button>
            </div>
            <textarea value={draft} disabled={planningLocksComposer || runLocksComposer} data-testid="agent-input" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              submitPrompt();
            }} placeholder={workspace.creationMode === 'video' ? '描述希望这张图如何动起来…' : selectedEditableNode ? '描述要如何修改当前对象…' : '描述你想生成或修改的视觉效果…'} />
            {showTransferConsent && <label className="transfer-consent" data-testid="pre-planner-consent"><input type="checkbox" checked={transferConsentChecked} onChange={(event) => setTransferConsentChecked(event.target.checked)} /><span>我确认对当前参考图拥有合法权利，且图片不敏感；同意将指令与净化后的图片按任务需要传输给已配置的规划、图片或视频服务。若使用 Sora 2 Preview，参考图须符合该模型的人像限制。留存及删除规则由所选服务决定；软取消不代表远端立即删除或退款。</span></label>}
            <div className="composer-actions">
              <label className="creation-mode-control">
                {workspace.creationMode === 'agent' ? <SparklesIcon /> : workspace.creationMode === 'image' ? <PhotoIcon /> : <VideoCameraIcon />}
                <select className="mode-select" data-testid="creation-mode" aria-label="创作模式" disabled={Boolean(plan) || planningLocksComposer || runLocksComposer} value={workspace.creationMode} onChange={(event) => {
                  const creationMode = event.target.value as CreationMode;
                  replaceWithoutHistory((current) => ({ ...current, creationMode }));
                }}>
                  {(['agent', 'image', 'video'] as const).map((mode) => <option key={mode} value={mode}>{CREATION_MODE_LABELS[mode]}</option>)}
                </select>
              </label>
              {workspace.creationMode !== 'video' && <select className="provider-select" disabled={Boolean(plan) || planningLocksComposer || runLocksComposer} aria-label="图片生成 Provider" value={workspace.imageProviderId} onChange={(event) => replaceWithoutHistory((current) => ({ ...current, imageProviderId: event.target.value === 'evolink-gpt-image-2' ? 'evolink-gpt-image-2' : 'deterministic-mock' }))}>
                <option value="deterministic-mock">本地 Mock</option>
                <option value="evolink-gpt-image-2">{providerLabels.image}</option>
              </select>}
              <button type="button" disabled={planningLocksComposer || runLocksComposer || !draft.trim() || Boolean(selectedUsesStoredReference && !transferConsentChecked && !(workspace.creationMode === 'agent' && parseCanvasCommand(draft)))} data-testid="send-prompt" aria-label="发送视觉需求" onClick={submitPrompt}><ArrowUpIcon /></button>
            </div>
          </div>
          <p className="agent-disclaimer" role="status">{canvasToolStatus || (workspace.creationMode === 'video' ? providerLabels.video : workspace.imageProviderId === 'deterministic-mock' ? '画布工具在本机执行 · 生成模式为本地演示' : '生成使用已配置的服务 · 每次最多一个媒体任务')}</p>
        </aside>

        <div
          className="agent-resizer"
          data-testid="agent-resizer"
          role="separator"
          aria-label="调整 Agent 面板宽度"
          aria-orientation="vertical"
          aria-valuemin={AGENT_PANEL_WIDTH_MIN}
          aria-valuemax={AGENT_PANEL_WIDTH_MAX}
          aria-valuenow={agentPanelWidth}
          tabIndex={0}
          style={{ left: agentPanelWidth - 6 }}
          onPointerDown={beginAgentResize}
          onPointerMove={moveAgentResize}
          onPointerUp={finishAgentResize}
          onPointerCancel={finishAgentResize}
          onLostPointerCapture={finishAgentResize}
          onKeyDown={handleAgentResizeKeyDown}
        />

        <section className="canvas-region" data-testid="canvas-region" aria-label="无限画布">
          <div className="canvas-top-left" data-testid="canvas-top-left">
            <img className="brand-logo" src="/assets/elyra-mark.svg" alt="ELYRA" />
            <span className="topbar-divider" />
            <button className="project-switcher" data-testid="return-to-projects" type="button" onClick={requestExitWorkspace} aria-label="返回本机项目页">{projectTitle} <ChevronLeftIcon /></button>
            <button className="project-switcher project-trash" data-testid="delete-project" type="button" onClick={() => void trashProject()} aria-label="将当前项目移到回收站" title="移到回收站后可恢复"><TrashIcon /></button>
          </div>
          <div className="canvas-top-right" data-testid="canvas-top-right">
            <div className="export-control">
              <button type="button" className="export-button" aria-expanded={exportMenuOpen} aria-label="导出" onClick={() => setExportMenuOpen(value => !value)} disabled={exportStatus === 'working'}><ArrowDownTrayIcon />{exportStatus === 'working' ? '导出中' : '导出'}</button>
              {(exportMenuOpen || exportError) && <div className="export-popover">
                {exportMenuOpen && <div className="export-menu" role="menu">
                  <button type="button" role="menuitem" disabled={!workspace.selectedIds.length || exportStatus === 'working'} onClick={() => void exportSelectedMedia()}>{exportStatus === 'working' ? '正在准备原件…' : '导出选中素材'}</button>
                  {preparedExport && preparedExport.key === exportTargetKey && <a role="menuitem" href={preparedExport.url} download={preparedExport.filename} data-testid="download-selected-media" onClick={event => { if (preparedExport.key !== resolveMediaExportTarget(workspaceRef.current, projectId)?.key) event.preventDefault(); }}>下载素材原件</a>}
                  <button type="button" role="menuitem" data-testid="export-core009-receipt" onClick={() => { setExportMenuOpen(false); void exportCurrentProjectReceipt(); }}>导出验收凭证</button>
                </div>}
                {exportError && <div className="export-error" role="alert">{exportError}</div>}
              </div>}
            </div>
            <button type="button" className={`layer-trigger ${assetLibraryOpen ? 'is-active' : ''}`} data-testid="workspace-asset-library-trigger" onClick={() => { setInspectorOpen(false); setAssetLibraryOpen((value) => !value); }} aria-label="项目资产库" aria-expanded={assetLibraryOpen} aria-controls="workspace-asset-library" title="项目资产库"><PhotoIcon /></button>
            <button type="button" className={`layer-trigger ${inspectorOpen ? 'is-active' : ''}`} onClick={() => { setAssetLibraryOpen(false); setInspectorOpen((value) => !value); }} aria-label="图层与版本" aria-expanded={inspectorOpen} aria-controls="canvas-inspector" title="图层与版本"><Square2StackIcon /></button>
          </div>
          <div className="canvas-toolbar" data-testid="canvas-toolbar" role="toolbar" aria-label="画布快捷工具">
            <ProviderSettings />
            <button type="button" aria-label="添加节点" title="添加节点" onClick={() => setNodeMenu(nodeMenu ? null : { x: (160 - workspace.viewport.x) / workspace.viewport.scale, y: (160 - workspace.viewport.y) / workspace.viewport.scale })}><PlusIcon /></button>
            <button type="button" className={tool === 'select' ? 'tool-selected' : ''} onClick={() => setTool('select')} aria-label="选择工具" aria-pressed={tool === 'select'} title="选择"><CursorArrowRaysIcon /></button>
            <button type="button" className={tool === 'hand' ? 'tool-selected' : ''} onClick={() => setTool('hand')} aria-label="手型工具" aria-pressed={tool === 'hand'} title="移动画布"><HandRaisedIcon /></button>
            <button type="button" onClick={addReference} aria-label="添加演示图" title="添加演示图"><PhotoIcon /></button>
            <button type="button" className="zoom-readout" onClick={resetView} aria-label={`重置缩放，当前 ${formatScale(workspace.viewport.scale)}`} title="适合画布"><span>{formatScale(workspace.viewport.scale)}</span></button>
            <button type="button" onClick={() => changeZoom(-0.1)} aria-label="缩小" title="缩小"><MinusIcon /></button>
            <button type="button" onClick={() => changeZoom(0.1)} aria-label="放大" title="放大"><PlusIcon /></button>
            <span className="toolbar-divider" aria-hidden="true" />
            <button type="button" aria-label="撤销" title={workspaceMutationLocked ? '当前 Agent 或媒体任务结束后可撤销' : '撤销'} disabled={!past.length || workspaceMutationLocked} onClick={undo}><ArrowUturnLeftIcon /></button>
            <button type="button" aria-label="重做" title={workspaceMutationLocked ? '当前 Agent 或媒体任务结束后可重做' : '重做'} disabled={!future.length || workspaceMutationLocked} onClick={redo}><ArrowUturnRightIcon /></button>
            <button type="button" data-testid="theme-toggle" aria-label="切换主题" title="切换主题" onClick={toggleTheme}>{workspace.theme === 'dark' ? <SunIcon /> : <MoonIcon />}</button>
          </div>
          {nodeMenu && <div className="workflow-add-menu" role="menu" aria-label="添加工作流节点">{(['text', 'image', 'video'] as const).map(kind => <button type="button" key={kind} role="menuitem" onClick={() => addWorkflowNode(kind)}>{({ text: '文本节点', image: '图片任务节点', video: '视频任务节点' })[kind]}</button>)}<button type="button" role="menuitem" onClick={() => { chooseReferenceFile(); setNodeMenu(null); }}>上传图片素材</button><button type="button" onClick={() => setNodeMenu(null)}>取消</button></div>}
          {connectionSource && <div className="workflow-connection-bar"><span>点击目标左侧端口，或创建下游：</span>{(['image', 'video'] as const).map(kind => <button type="button" key={kind} onClick={() => { const source = workspaceRef.current.nodes.find(node => node.id === connectionSource); if (!source) return; const node = makeWorkflowNode(kind, uniqueId('node'), source.x + source.width + 100, source.y); if (editWorkflow({ type: 'create', node, sourceId: source.id })) setConnectionSource(null); }}>{kind === 'image' ? '图片节点' : '视频节点'}</button>)}<button type="button" onClick={() => setConnectionSource(null)}>取消连接</button></div>}
          <div className={`infinite-canvas tool-${tool} ${drag?.kind === 'pan' ? 'is-panning' : ''}`} ref={canvasRef} onDoubleClick={event => { if ((event.target as HTMLElement).closest('article,button')) return; const rect = event.currentTarget.getBoundingClientRect(); setNodeMenu({ x: (event.clientX - rect.left - workspace.viewport.x) / workspace.viewport.scale, y: (event.clientY - rect.top - workspace.viewport.y) / workspace.viewport.scale }); }} onWheel={handleWheel} onPointerDownCapture={handleCanvasPointerDownCapture} onPointerDown={handleCanvasPointerDown} onPointerMove={handleCanvasPointerMove} onPointerUp={handleCanvasPointerUp} onPointerCancel={() => { if (drag?.kind === 'node') replaceWithoutHistory(current => ({ ...current, nodes: current.nodes.map(node => drag.positions[node.id] ? { ...node, ...drag.positions[node.id] } : node) })); if (drag?.kind === 'resize') replaceWithoutHistory(current => ({ ...current, nodes: current.nodes.map(node => node.id === drag.node.id ? drag.node : node) })); setDrag(null); setConnectionSource(null); }} onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}>
            <div className="canvas-world" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `translate(${workspace.viewport.x}px, ${workspace.viewport.y}px) scale(${workspace.viewport.scale})` }}>
              <svg className="lineage-lines" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} aria-hidden="true">
                {workspace.nodes.filter((node) => node.parentId).map((node) => {
                  const parent = workspace.nodes.find((item) => item.id === node.parentId);
                  if (!parent) return null;
                  return <path key={node.id} d={`M ${parent.x + parent.width} ${parent.y + parent.height / 2} C ${parent.x + parent.width + 65} ${parent.y + parent.height / 2}, ${node.x - 65} ${node.y + node.height / 2}, ${node.x} ${node.y + node.height / 2}`} />;
                })}
              </svg>
              <svg className="workflow-wires" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} aria-label="节点连线">{connectionSource && connectionPoint && (() => { const source = workspace.nodes.find(node => node.id === connectionSource); return source ? <path strokeDasharray="6 4" d={`M ${source.x + source.width + 10} ${source.y + source.height / 2} L ${connectionPoint.x} ${connectionPoint.y}`} /> : null; })()}{workspace.nodes.flatMap(target => [
                ...(target.workflow?.inputs ?? []).map(input => ({ sourceId: input.sourceId, removable: true })),
                ...(target.workflowOriginId ? [{ sourceId: target.workflowOriginId, removable: false }] : []),
              ].map(input => { const source = workspace.nodes.find(node => node.id === input.sourceId); if (!source) return null; const bend = Math.min(70, Math.max(10, (target.x - source.x - source.width - 20) / 2)); const path = `M ${source.x + source.width + 10} ${source.y + source.height / 2} C ${source.x + source.width + 10 + bend} ${source.y + source.height / 2}, ${target.x - 10 - bend} ${target.y + target.height / 2}, ${target.x - 10} ${target.y + target.height / 2}`; return <g key={`${source.id}-${target.id}`}><path d={path} />{input.removable && <path className="workflow-wire-hit" d={path} role="button" aria-label="删除连线" tabIndex={0} onPointerDown={event => event.stopPropagation()} onClick={() => editWorkflow({ type: 'disconnect', sourceId: source.id, targetId: target.id })} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Delete') { event.stopPropagation(); editWorkflow({ type: 'disconnect', sourceId: source.id, targetId: target.id }); } }}><title>点击移除连线（可撤销）</title></path>}</g>; }))}</svg>
              {orderCanvasNodesByLayer(workspace.nodes).map((node) => node.workflow ? <WorkflowCard key={node.id} node={node} selected={workspace.selectedIds.includes(node.id)} locked={workspaceMutationLocked || Boolean(workflowRunning)} running={workflowRunning === node.id} hasResult={workspace.nodes.some(result => result.workflowOriginId === node.id && result.status === 'ready' && result.assetId)} error={workflowErrors[node.id]} onPointerDown={handleNodePointerDown} onSelect={() => selectNode(node.id, false)} onUpdate={(text, model, continueTextEdit) => editWorkflow({ type: 'update', nodeId: node.id, text, model }, continueTextEdit)} onRun={() => void runWorkflowNode(node.id)} /> : <CanvasCard key={node.id} node={node} job={node.jobId ? workspace.jobs.find((job) => job.id === node.jobId) : undefined} assetPresentation={resolveAssetPresentation(node, workspace.assets, assetUrls, unavailableAssetIds)} selected={workspace.selectedIds.includes(node.id)} onPointerDown={handleNodePointerDown} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); selectNode(node.id, false); setContextMenu({ id: node.id, x: event.clientX, y: event.clientY }); }} onRetry={() => retryNode(node)} onCancel={() => cancelJob(node)} onAssetLoad={captureRemoteAssetDimensions} onResize={handleNodeResize} />)}
              {workspace.nodes.map(node => <div key={`ports-${node.id}`}>
                <button type="button" className={`workflow-port ${connectionSource === node.id ? 'connecting' : ''}`} style={{ left: node.x + node.width, top: node.y + node.height / 2 - 10 }} aria-label={`${node.name} 输出端口`} title="连接到下游节点" onPointerDown={event => startWorkflowConnection(event, node.id)} onPointerUp={finishWorkflowConnection} onPointerCancel={() => { portDragRef.current = null; setConnectionSource(null); setConnectionPoint(null); }} onClick={event => { if (event.detail === 0) setConnectionSource(node.id); }}>+</button>
                {node.workflow && node.workflow.kind !== 'text' && <button type="button" className="workflow-port" data-workflow-input={node.id} style={{ left: node.x - 20, top: node.y + node.height / 2 - 10 }} aria-label={`${node.name} 输入端口`} title="接收文本或图片" onPointerDown={event => event.stopPropagation()} onPointerUp={event => { event.stopPropagation(); connectWorkflowNodes(node.id); }} onClick={event => { if (event.detail === 0) connectWorkflowNodes(node.id); }}>+</button>}
              </div>)}
            </div>
            {!workspace.nodes.length && <div className="canvas-empty-state" data-testid="canvas-empty"><SparklesIcon /><h1>从一个视觉方向开始</h1><p>添加演示图，或导入你有权使用的非敏感参考图。</p><div className="canvas-empty-actions"><button type="button" onClick={chooseReferenceFile}><CloudArrowUpIcon />上传参考图</button><button type="button" onClick={addReference}><PlusIcon />添加演示图</button></div></div>}
            {marqueeStyle && <div className="selection-marquee" style={marqueeStyle} />}
          </div>
          <div className="minimap" aria-label="画布小地图"><div className="minimap-content"><i /></div><div className="minimap-actions"><ViewfinderCircleIcon /><button type="button" aria-label="小地图放大" onClick={() => changeZoom(0.1)}>+</button><button type="button" aria-label="小地图缩小" onClick={() => changeZoom(-0.1)}>−</button></div></div>
          {workspace.selectedIds.length > 0 && <div className="selection-actions"><span>{workspace.selectedIds.length} 个对象已选中</span><button type="button" data-testid="create-child" disabled={!selectedEditableNode} title={selectedEditableNode ? '编辑此图' : selectedReadyAsset?.kind === 'video' ? '视频结果不支持继续图片编辑' : '本地素材不可用，无法编辑'} onClick={beginEdit}><DocumentDuplicateIcon />编辑此图</button><button type="button" data-testid="delete-selected" onClick={deleteSelected}><TrashIcon />删除</button></div>}
          {assetLibraryOpen && <WorkspaceAssetLibrary assets={workspace.assets} nodes={workspace.nodes} assetUrls={assetUrls} unavailableAssetIds={unavailableAssetIds} onClose={() => setAssetLibraryOpen(false)} onAdd={addProjectAssetToCanvas} onOpenFullLibrary={onOpenAssetLibrary ? () => { if (attemptWorkspaceExit()) onOpenAssetLibrary(projectId); } : undefined} />}
          {inspectorOpen && <Inspector nodes={orderCanvasNodesByLayer(workspace.nodes)} assets={workspace.assets} assetUrls={assetUrls} unavailableAssetIds={unavailableAssetIds} selectedIds={workspace.selectedIds} onClose={() => setInspectorOpen(false)} onSelect={(id) => selectNode(id, false)} />}
        </section>
      </div>

      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} node={contextMenuNode} canCreateChild={contextMenuCanCreateChild} onClose={() => setContextMenu(null)} onChild={beginEdit} onDelete={deleteSelected} />}
    </main>
  );
}

function AgentRunConsole({ run, restored, restoredBudgetStatus, onPause, onContinue, onCancel }: {
  run: AgentRun | null;
  restored?: PersistedAgentRunPresentation;
  restoredBudgetStatus: 'not-applicable' | 'checking' | 'authoritative' | 'unavailable';
  onPause: () => void;
  onContinue: (userResponse?: string) => void;
  onCancel: () => void;
}) {
  const [userResponse, setUserResponse] = useState('');
  const state = run?.state ?? restored?.state;
  const responseScopeKey = run ? `${run.id}:${run.pendingConfirmation?.stepId ?? ''}:${run.pendingConfirmation?.kind ?? ''}` : '';
  useEffect(() => setUserResponse(''), [responseScopeKey]);
  if (!state) return null;
  const latestStep = run?.steps.at(-1);
  const context = run?.currentObservation?.context ?? latestStep?.observationAfter?.context ?? latestStep?.observationBefore.context;
  const referencedIds = context
    ? (context.selectedObjectIds.length ? context.selectedObjectIds : context.objects.map((object) => object.id))
    : restored?.selectedObjectIds.length ? restored.selectedObjectIds : restored?.referencedObjectIds ?? [];
  const actionType = latestStep?.action?.type ?? restored?.currentActionType;
  const evaluation = latestStep?.evaluation;
  const verificationOutcome = evaluation?.outcome ?? restored?.verificationOutcome;
  const verificationSummary = evaluation?.summary ?? restored?.verificationSummary ?? '等待动作执行后的真实画布快照。';
  const remaining = run?.remainingSteps ?? restored?.remainingSteps ?? 0;
  const maxSteps = run?.maxSteps ?? restored?.maxSteps ?? 4;
  const budget = run?.budget ?? restored?.budget ?? { capUsd: 5, spentUsd: 0, reservedUsd: 0 };
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(state);
  const restoredHistory = Boolean(!run && terminal);
  const canPause = Boolean(run && !terminal && !run.paused);
  const canContinue = Boolean(run && !terminal && (run.paused || run.pendingConfirmation?.kind === 'USER_RESPONSE'));
  const userPrompt = run?.pendingConfirmation?.kind === 'USER_RESPONSE' ? run.pendingConfirmation.publicPrompt : undefined;
  const waitingForUser = Boolean(userPrompt);
  const canCancel = Boolean(run && !terminal);

  const runDetails = <>
    <div className="agent-run-context" data-testid="agent-run-context">
      <small>{terminal ? '运行结束时引用' : '当前引用'}</small>
      <div>{referencedIds.slice(0, 4).map((id) => <span key={id}>{id}</span>)}{referencedIds.length > 4 && <span>+{referencedIds.length - 4}</span>}{!referencedIds.length && <span>空白画布</span>}</div>
      <code>{(context?.semanticSha256 ?? restored?.contextSha256 ?? '').slice(0, 12) || '待观察'}</code>
    </div>
    <p className="agent-run-plan" data-testid="agent-run-plan-summary">{run?.planSummary ?? '已恢复脱敏 checkpoint 索引；不会自动继续或重新提交 Provider。'}</p>
    <div className="agent-run-grid">
      <div data-testid="agent-run-step"><small>当前步骤</small><strong>{actionType ? AGENT_ACTION_LABELS[actionType] ?? actionType : AGENT_RUN_STATE_LABELS[state]}</strong></div>
      <div data-testid="agent-run-verification"><small>验证结果</small><strong>{verificationOutcome ? `${verificationOutcome} · ${verificationSummary}` : verificationSummary}</strong></div>
      <div data-testid="agent-run-remaining"><small>剩余步数</small><strong>{remaining} / {maxSteps}</strong></div>
      <div data-testid="agent-run-budget"><small>里程碑预算</small><strong>${budget.spentUsd.toFixed(3)} / ${budget.capUsd.toFixed(0)}{!run && restoredBudgetStatus === 'checking' ? ' · 对账中' : !run && restoredBudgetStatus === 'unavailable' ? ' · 待对账' : ''}</strong></div>
    </div>
    {(run?.failureCode || restored?.failureCode) && <p className="agent-run-failure" data-testid="agent-run-failure">{restoredHistory ? `历史结果·${restored?.failureCode}` : run?.failureCode ?? restored?.failureCode}</p>}
    {waitingForUser && <label className="agent-run-response">
      <span data-testid="agent-question">{userPrompt}</span>
      <input data-testid="agent-response" value={userResponse} maxLength={600} onChange={(event) => setUserResponse(event.target.value)} placeholder="输入补充信息" />
    </label>}
    <div className="agent-run-controls">
      {canPause && <button type="button" data-testid="pause-agent-run" onClick={onPause}>暂停</button>}
      {canContinue && <button type="button" data-testid="continue-agent-run" disabled={Boolean(waitingForUser && !userResponse.trim())} onClick={() => {
        onContinue(waitingForUser ? userResponse : undefined);
        if (waitingForUser) setUserResponse('');
      }}>{waitingForUser ? '提交并继续' : '继续'}</button>}
      {canCancel && <button type="button" data-testid="cancel-agent-run" onClick={onCancel}>取消</button>}
      {!run && <span>仅恢复显示</span>}
    </div>
    <p className="agent-run-boundary">只展示公开步骤、动作与验证结果，不展示私有推理。</p>
  </>;

  if (restoredHistory) {
    const historyLabel = state === 'COMPLETED' ? '上次运行已完成' : state === 'CANCELLED' ? '上次运行已取消' : '上次运行未完成';
    return <details className={`agent-run-console state-${state.toLowerCase()} restored-history`} data-testid="agent-run-console" aria-label="CreativeDirectorAgent 历史运行记录">
      <summary className="agent-run-history-summary" data-testid="agent-run-history-summary">
        <span><SparklesIcon /><span><strong>{historyLabel}</strong><small>历史记录已保留，不影响当前创作，也不会自动重试或扣费。</small></span></span>
        <em><span className="history-show-label">查看详情</span><span className="history-hide-label">收起详情</span></em>
      </summary>
      <div className="agent-run-history-details">{runDetails}</div>
    </details>;
  }

  return <section className={`agent-run-console state-${state.toLowerCase()}`} data-testid="agent-run-console" aria-label="CreativeDirectorAgent 运行状态" aria-live="polite">
    <div className="agent-run-heading"><span><SparklesIcon />CreativeDirectorAgent</span><em>{AGENT_RUN_STATE_LABELS[state]}</em></div>
    {runDetails}
  </section>;
}

function MessageBubble({ message }: { message: Workspace['messages'][number] }) {
  return <div className={`message message-${message.role}`}><div className="message-copy">{message.role === 'agent' && <span className="message-agent-label"><SparklesIcon />ELYRA</span>}{message.body}</div><span className="message-time">{message.time}</span></div>;
}

function CanvasCard({ node, job, assetPresentation, selected, onPointerDown, onContextMenu, onRetry, onCancel, onAssetLoad, onResize }: { node: CanvasNode; job?: GenerationJob; assetPresentation: AssetPresentation; selected: boolean; onPointerDown: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void; onContextMenu: (event: React.MouseEvent<HTMLElement>) => void; onRetry: () => void; onCancel: () => void; onAssetLoad: (assetId: string | undefined, width: number, height: number) => void; onResize: (event: React.PointerEvent<HTMLElement>, node: CanvasNode, corner: ResizeCorner) => void }) {
  const localResultPending = job?.status === 'local_result_pending' || job?.error?.retryScope === 'local-result';
  const statusRetry = job?.error?.retryScope === 'status-only';
  const canRetry = Boolean(job?.error?.retryable && job.error.retryScope !== 'none');
  const videoJob = job?.operation === 'video' || assetPresentation.kind === 'video';
  return <article className={`canvas-card ${selected ? 'selected' : ''} status-${node.status}`} data-testid="canvas-node" data-node-id={node.id} style={{ width: node.width, height: node.height, transform: `translate(${node.x}px, ${node.y}px)` }} onPointerDown={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const left = event.clientX - rect.left < 20;
      const right = rect.right - event.clientX < 20;
      const top = event.clientY - rect.top < 20;
      const bottom = rect.bottom - event.clientY < 20;
      if (selected && (left || right) && (top || bottom)) onResize(event, node, `${top ? 'n' : 's'}${left ? 'w' : 'e'}` as ResizeCorner);
      else onPointerDown(event, node);
    }} onContextMenu={onContextMenu}>
    {selected && (['nw', 'ne', 'sw', 'se'] as const).map(corner => <button key={corner} type="button" aria-label={`调整尺寸 ${corner}`} className={`handle handle-${corner}`} style={{ padding: 0, cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' }} onPointerDown={event => onResize(event, node, corner)} />)}
    {node.status === 'generating' ? <div className="node-placeholder">
      <SparklesIcon />
      <strong>{job?.status === 'local_result_pending' ? '正在重取本地结果' : videoJob ? '正在生成四秒视频' : '正在生成视觉版本'}</strong>
      <span>{job?.status === 'validating' ? '校验参考图' : job?.status === 'uploading' ? '上传到本机服务' : job?.status === 'submitted' ? '已提交远端任务' : job?.status === 'local_result_pending' ? '不再提交付费生成' : job?.providerId === 'deterministic-mock' ? '本地流程演练（固定示例图）' : videoJob ? 'Sora 2 Preview 处理中' : 'GPT Image 2 处理中'} · {Math.round(job?.progress ?? 8)}%</span>
      <div className="progress"><i style={{ width: `${Math.max(8, job?.progress ?? 8)}%` }} /></div>
      {(job?.providerId === 'evolink-gpt-image-2' || job?.providerId === 'evolink-sora-2-preview') && <button className="cancel-job" type="button" data-testid="cancel-job" onPointerDown={(event) => event.stopPropagation()} onClick={onCancel}><StopCircleIcon />软取消</button>}
    </div> : node.status === 'failed' || node.status === 'user_cancelled' ? <div className="node-failure">
      <ExclamationTriangleIcon />
      <strong>{node.status === 'user_cancelled' ? '已软取消' : localResultPending ? '结果待本地取回' : statusRetry ? '任务状态待重查' : '生成失败'}</strong>
      <span>{node.status === 'user_cancelled' ? '仅停止本地等待；远端不保证取消、退款或删除' : localResultPending ? 'Provider 已完成，不会再次提交付费生成' : statusRetry ? '只重查原 Provider 任务，不会再次提交付费生成' : job?.error?.message ?? '任务失败'}</span>
      {node.status === 'failed' && canRetry && <button type="button" data-testid="retry-node" onPointerDown={(event) => event.stopPropagation()} onClick={onRetry}><ArrowPathIcon />{localResultPending ? '重取结果' : statusRetry ? '重查状态' : '填回并重新发送'}</button>}
    </div> : assetPresentation.url ? <>
      {assetPresentation.kind === 'video'
        ? <><video src={assetPresentation.url} aria-label="生成的四秒视频版本" controls muted loop playsInline preload="metadata" data-testid="canvas-video" onPointerDown={(event) => event.stopPropagation()} onLoadedMetadata={(event) => onAssetLoad(node.assetId, event.currentTarget.videoWidth, event.currentTarget.videoHeight)} /><div className="video-drag-surface" data-testid="video-drag-surface" aria-label="选择并拖动视频对象" onPointerDown={(event) => onPointerDown(event, node)} onContextMenu={onContextMenu} /></>
        : <img src={assetPresentation.url} alt={node.kind === 'reference' ? '参考图片对象' : '生成的视觉版本'} draggable={false} onLoad={(event) => onAssetLoad(node.assetId, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />}
      <div className="node-meta"><span>{node.name}</span><span>{Math.round(node.width)} × {Math.round(node.height)}</span><span>{assetPresentation.kind === 'video' ? '4s · MP4' : node.kind === 'reference' ? '参考图' : `v${node.version}`}</span><EllipsisHorizontalIcon /></div>
    </> : <div className="node-asset-unavailable" data-testid="asset-unavailable"><ExclamationTriangleIcon /><strong>{assetPresentation.status === 'pending' ? '正在恢复本地素材' : '本地素材不可用'}</strong><span>{assetPresentation.status === 'pending' ? '正在校验 IndexedDB Blob' : '未使用演示图替代真实结果'}</span></div>}
  </article>;
}

function WorkspaceAssetLibrary({ assets, nodes, assetUrls, unavailableAssetIds, onClose, onAdd, onOpenFullLibrary }: {
  assets: Asset[];
  nodes: CanvasNode[];
  assetUrls: Map<string, string>;
  unavailableAssetIds: Set<string>;
  onClose: () => void;
  onAdd: (assetId: string) => AssetAddResult;
  onOpenFullLibrary?: () => void;
}) {
  return <aside id="workspace-asset-library" className="workspace-asset-library" data-testid="workspace-asset-library">
    <div className="inspector-heading"><span>当前项目资产</span><button type="button" aria-label="关闭项目资产库" onClick={onClose}><XMarkIcon /></button></div>
    <div className="asset-library-summary"><strong>{assets.length}</strong><span>个本机资产</span><small>删除画布对象不会删除这里的 Asset 或 Blob。</small></div>
    <div className="asset-library-list">
      {assets.length ? assets.map((asset) => {
        const presentation = resolveProjectAssetPresentation(asset, assetUrls, unavailableAssetIds);
        const references = nodes.filter((node) => node.assetId === asset.id).length;
        const available = presentation.status === 'ready';
        return <article className="asset-library-row" key={asset.id} data-testid={`workspace-asset-${asset.id}`}>
          <div className="asset-library-preview">
            {presentation.url
              ? asset.kind === 'video'
                ? <video src={presentation.url} muted playsInline preload="metadata" aria-label="项目视频资产缩略图" />
                : <img src={presentation.url} alt="" />
              : <ExclamationTriangleIcon />}
          </div>
          <div className="asset-library-copy">
            <strong>{asset.kind === 'video' ? '视频资产' : '图片资产'}</strong>
            <span>{asset.metadata.width} × {asset.metadata.height}{asset.kind === 'video' && asset.metadata.durationSeconds ? ` · ${asset.metadata.durationSeconds}s` : ''}</span>
            <small>{presentation.status === 'ready' ? `${references} 个画布引用` : presentation.status === 'pending' ? '正在恢复本机 Blob' : '本机 Blob 缺失或损坏'}</small>
          </div>
          <button type="button" data-testid={`add-asset-${asset.id}`} disabled={!available} onClick={() => onAdd(asset.id)} aria-label={`将${asset.kind === 'video' ? '视频' : '图片'}资产添加到画布`}><PlusIcon /></button>
        </article>;
      }) : <p className="inspector-empty">当前项目还没有图片或视频资产。</p>}
    </div>
    {onOpenFullLibrary && <button type="button" className="open-full-asset-library" data-testid="open-full-asset-library" onClick={onOpenFullLibrary}>在项目页查看全部资产</button>}
  </aside>;
}

function Inspector({ nodes, assets, assetUrls, unavailableAssetIds, selectedIds, onClose, onSelect }: { nodes: CanvasNode[]; assets: Asset[]; assetUrls: Map<string, string>; unavailableAssetIds: Set<string>; selectedIds: string[]; onClose: () => void; onSelect: (id: string) => void }) {
  return <aside id="canvas-inspector" className="canvas-inspector" data-testid="inspector">
    <div className="inspector-heading"><span>图层与版本</span><button type="button" aria-label="关闭检查器" onClick={onClose}><XMarkIcon /></button></div>
    <section>
      <p className="inspector-label">对象</p>
      {nodes.length ? nodes.map((node) => {
        const presentation = resolveAssetPresentation(node, assets, assetUrls, unavailableAssetIds);
        const readyLabel = presentation.kind === 'video' ? '4 秒 MP4 · 本地可恢复' : '可编辑图片';
        const statusLabel = node.status === 'ready'
          ? presentation.url
            ? readyLabel
            : presentation.status === 'pending'
              ? '正在恢复本地素材'
              : '本地素材不可用'
          : node.status === 'failed'
            ? '失败，可重试'
            : node.status === 'user_cancelled'
              ? '已软取消'
              : '生成中';
        return <button type="button" key={node.id} className={`layer-row ${selectedIds.includes(node.id) ? 'active' : ''}`} onClick={() => onSelect(node.id)}>
          {presentation.url
            ? presentation.kind === 'video'
              ? <video src={presentation.url} muted playsInline preload="metadata" aria-label="视频图层缩略图" data-testid="layer-video-thumbnail" />
              : <img src={presentation.url} alt="" />
            : <span className="layer-asset-placeholder" aria-hidden="true"><ExclamationTriangleIcon /></span>}
          <span><strong>{node.name}</strong><small>{statusLabel}</small></span>
          {node.parentId && <DocumentDuplicateIcon />}
        </button>;
      }) : <p className="inspector-empty">尚无画布对象</p>}
    </section>
    <section className="version-section"><p className="inspector-label">版本关系</p>{nodes.filter((node) => node.kind === 'generated').length ? nodes.filter((node) => node.kind === 'generated').map((node) => <div className="version-row" key={`version-${node.id}`}><i className={node.status === 'ready' ? 'complete' : ''} /><div><strong>{node.name}</strong><small>{node.parentId ? '保留父版本的非破坏式分支' : '初始生成版本'}</small></div></div>) : <p className="inspector-empty">生成后将在此显示父子版本。</p>}</section>
  </aside>;
}

function ContextMenu({ x, y, node, canCreateChild, onClose, onChild, onDelete }: { x: number; y: number; node?: CanvasNode; canCreateChild: boolean; onClose: () => void; onChild: () => void; onDelete: () => void }) {
  if (!node) return null;
  return <div className="context-menu" data-testid="context-menu" style={{ left: x, top: y }} role="menu">{canCreateChild && <button type="button" data-testid="context-create-child" onClick={() => { onChild(); onClose(); }}><DocumentDuplicateIcon />创建子版本</button>}<button type="button" onClick={() => { onDelete(); onClose(); }}><TrashIcon />删除对象</button></div>;
}

export default App;
