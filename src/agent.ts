import { GENERATED_ASSET, GENERATED_ASSET_DIMENSIONS, analyzePrompt } from './domain';
import { sha256Blob, type BlobStorageMetadata } from './blob-store';
import { isPaidConfirmationToken } from './paid-confirmation';

/**
 * Phase 2 domain boundary. UI code may ask this runtime to plan and run work,
 * but it never imports a ProviderAdapter or holds provider credentials.
 */
export type CreationMode = 'agent' | 'image' | 'video';
export type IntentKind = 'generate' | 'modify' | 'retry' | 'clarify';
export type GenerationOperation = 'generate' | 'edit' | 'video';
export type PlannerOperation = 'image_generate' | 'image_edit_fixed_demo_reference' | 'image_edit_user_reference' | 'video_image_to_video' | 'clarify';
export type PlanningSource = 'remote-agent' | 'fallback' | 'legacy-deterministic' | 'direct-mode';
export type PlanStatus = 'proposed' | 'approved';
export type JobStatus = 'queued' | 'validating' | 'uploading' | 'submitted' | 'processing' | 'local_result_pending' | 'running' | 'succeeded' | 'failed' | 'user_cancelled';
export type AssetSource = 'deterministic-mock' | 'remote-provider' | 'local-upload';
export type VersionStatus = 'pending' | 'ready' | 'failed' | 'user_cancelled';
export const PROVIDER_OUTPUT_SLOTS = ['left45', 'front', 'right45'] as const;
export type ProviderOutputSlot = typeof PROVIDER_OUTPUT_SLOTS[number];

export interface UserIntent {
  id: string;
  kind: IntentKind;
  operation: PlannerOperation;
  source: PlanningSource;
  creationMode?: CreationMode;
  prompt: string;
  normalizedPrompt: string;
  goal: string;
  constraints: string[];
  targetCanvasObjectId?: string;
  createdAt: string;
}

export interface AgentPlan {
  id: string;
  intentId: string;
  providerId: string;
  status: PlanStatus;
  operation: PlannerOperation;
  source: PlanningSource;
  creationMode?: CreationMode;
  outputKind?: 'image' | 'video' | 'none';
  clarificationQuestion?: string;
  plannerModel?: string;
  summary: string;
  bullets: string[];
  constraints: string[];
  visualDirection: { subject: string; style: string; lighting: string; composition: string };
  shouldFail: boolean;
  createdAt: string;
}

export interface GenerationJob {
  id: string;
  intentId: string;
  planId: string;
  providerId: string;
  operation: GenerationOperation;
  targetCanvasObjectId?: string;
  status: JobStatus;
  progress?: number;
  attempt: number;
  error?: { code: string; message: string; retryable: boolean; retryScope?: ProviderRetryScope };
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  kind: 'image' | 'video';
  source: AssetSource;
  providerId: string;
  jobId?: string;
  uri?: string;
  storage?: BlobStorageMetadata;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
  prompt: string;
  createdAt: string;
  metadata: {
    deterministic: boolean;
    width: number;
    height: number;
    durationSeconds?: number;
    /** Stable semantic position inside an atomic three-image Provider result. */
    outputSlot?: ProviderOutputSlot;
  };
}

export interface VersionRecord {
  id: string;
  canvasObjectId: string;
  parentVersionId?: string;
  parentCanvasObjectId?: string;
  jobId?: string;
  sequence: number;
  status: VersionStatus;
  createdAt: string;
}

export interface ProviderRunRequest {
  intent: UserIntent;
  plan: AgentPlan;
  job: GenerationJob;
  referenceBlob?: Blob;
  sourceBinding?: { canvasObjectId: string; versionId: string; assetId: string };
  resumeScope?: Extract<ProviderRetryScope, 'local-result' | 'status-only'>;
  signal?: AbortSignal;
  onProgress?: (progress: ProviderProgress) => void;
  paidConfirmationToken?: string;
}

export interface ProviderProgress {
  status: Extract<JobStatus, 'validating' | 'uploading' | 'submitted' | 'processing'>;
  progress: number;
  message: string;
}

export interface ProviderMediaOutput<Slot extends ProviderOutputSlot = ProviderOutputSlot> {
  slot: Slot;
  asset: Asset & { metadata: Asset['metadata'] & { outputSlot: Slot } };
  blob: Blob;
}

export type ProviderOutputSet = readonly [
  ProviderMediaOutput<'left45'>,
  ProviderMediaOutput<'front'>,
  ProviderMediaOutput<'right45'>,
];

export type ProviderRunResult =
  | { ok: true; asset: Asset; blob?: Blob; outputs?: never }
  | { ok: true; outputs: ProviderOutputSet; asset?: never; blob?: never }
  | { ok: false; error: { code: string; message: string; retryable: boolean; retryScope?: ProviderRetryScope } };

export const providerResultHasOutputSet = (
  result: ProviderRunResult,
): result is Extract<ProviderRunResult, { ok: true; outputs: ProviderOutputSet }> => (
  result.ok && Array.isArray(result.outputs)
);

export type ProviderRetryScope = 'new-provider-job' | 'local-result' | 'status-only' | 'none';

/**
 * Future remote adapters implement this exact shape behind a server boundary.
 * There is intentionally no API key, network client, or remote implementation
 * in this browser-only MVP.
 */
export interface ProviderAdapter {
  id: string;
  label: string;
  mode: 'mock' | 'remote';
  capabilities: Array<'generate-image' | 'edit-image' | 'generate-video-from-image'>;
  run(request: ProviderRunRequest): Promise<ProviderRunResult>;
}

type EvoLinkTask = {
  id: string;
  status: 'pending' | 'processing' | 'local_result_pending' | 'completed' | 'failed';
  progress?: number;
  resultId?: string;
  result?: { mimeType: 'image/png'; width: number; height: number; bytes?: number };
  error?: { code?: string; message?: string; retryable?: boolean; retryScope?: ProviderRetryScope };
};

type UserReferenceTask = {
  localJobId: string;
  status: 'uploading' | 'submitted' | 'processing' | 'local_result_pending' | 'completed' | 'failed' | 'user_cancelled';
  progress: number;
  retryScope?: ProviderRetryScope;
  providerCompleted?: boolean;
  resultId?: string;
  result?: { mimeType: 'image/png'; width: number; height: number; bytes?: number };
  error?: { code: string; message: string; retryable: boolean };
};

type Core009VideoTask = {
  localJobId: string;
  status: 'pending' | 'submitted' | 'processing' | 'local_result_pending' | 'completed' | 'failed' | 'user_cancelled';
  progress: number;
  retryScope?: ProviderRetryScope;
  providerCompleted?: boolean;
  resultId?: string;
  result?: { mimeType: 'video/mp4'; width: number; height: number; durationSeconds: number; bytes?: number; sha256: string };
  error?: { code?: string; message?: string; retryable?: boolean; retryScope?: ProviderRetryScope };
};

/** Same-origin routes shared by the browser adapter and the CORE-009 BFF. */
export const CORE009_VIDEO_BFF_ROUTES = Object.freeze({
  jobs: '/api/agent/video-jobs',
  assets: '/api/agent/video-assets',
});

type ReferenceUpload = (input: {
  endpoint: string;
  jobId: string;
  prompt: string;
  blob: Blob;
  signal?: AbortSignal;
  onProgress?: (value: number) => void;
  paidConfirmationToken: string;
}) => Promise<{ response: Response; body: UserReferenceTask | { retryScope?: ProviderRetryScope; error?: { code?: string; message?: string; retryable?: boolean } } }>;

export interface AgentRuntime {
  createIntent(input: { prompt: string; targetCanvasObjectId?: string; referenceKind?: 'fixed-demo' | 'user-upload'; creationMode?: CreationMode; kind?: IntentKind }): UserIntent;
  planIntent(intent: UserIntent): AgentPlan;
  createJob(input: { intent: UserIntent; plan: AgentPlan; attempt?: number }): GenerationJob;
  execute(job: GenerationJob, intent: UserIntent, plan: AgentPlan, options?: Pick<ProviderRunRequest, 'referenceBlob' | 'sourceBinding' | 'resumeScope' | 'signal' | 'onProgress' | 'paidConfirmationToken'>): Promise<ProviderRunResult>;
}

const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isoNow = () => new Date().toISOString();
const pause = (milliseconds: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

/**
 * The immutable execution prompt is derived from both the normalized Intent
 * and the user-confirmed Agent Plan. Provider adapters must use this value,
 * rather than bypassing the planning layer with the original chat message.
 */
export const composeExecutionPrompt = (intent: UserIntent, plan: AgentPlan): string => {
  const direction = plan.visualDirection;
  return [
    intent.normalizedPrompt.trim(),
    `规划摘要：${plan.summary.trim()}`,
    `视觉方向：主体=${direction.subject.trim()}；风格=${direction.style.trim()}；光线=${direction.lighting.trim()}；构图=${direction.composition.trim()}`,
    `约束：${plan.constraints.map((item) => item.trim()).filter(Boolean).join('；')}`,
    `执行步骤：${plan.bullets.map((item) => item.trim()).filter(Boolean).join('；')}`,
  ].join('\n');
};

export const createDeterministicMockProvider = (latencyMs = 1050): ProviderAdapter => ({
  id: 'deterministic-mock',
  label: 'ELYRA Deterministic Mock',
  mode: 'mock',
  capabilities: ['generate-image', 'edit-image'],
  async run({ intent, plan, job, signal }) {
    try { await abortablePause(latencyMs, signal); }
    catch { return providerFailure('CORE008_USER_CANCELLED', '有界 Agent 已停止本地执行。', false, 'none'); }
    if (plan.shouldFail && job.attempt === 1) {
      return {
        ok: false,
        error: { code: 'DETERMINISTIC_MOCK_FAILURE', message: 'Mock 失败路径已触发。', retryable: true },
      };
    }
    return {
      ok: true,
      asset: {
        id: id('asset'),
        kind: 'image',
        source: 'deterministic-mock',
        providerId: 'deterministic-mock',
        jobId: job.id,
        uri: GENERATED_ASSET,
        mimeType: 'image/png',
        prompt: composeExecutionPrompt(intent, plan),
        createdAt: isoNow(),
        metadata: { deterministic: true, ...GENERATED_ASSET_DIMENSIONS },
      },
    };
  },
});

/**
 * Browser-side half of the EvoLink adapter. It only calls the same-origin
 * local BFF; the EvoLink token is supplied to that process through its
 * environment and never enters browser state, localStorage or the bundle.
 */
export const createEvoLinkGptImageProvider = (
  fetchImpl: typeof fetch = fetch,
  basePath = '/api/agent',
  pollIntervalMs = 1_500,
  referenceUpload: ReferenceUpload = xhrReferenceUpload,
): ProviderAdapter => {
  // Maps only local Job IDs to opaque Provider task IDs. Result URLs never
  // cross the server boundary, and this transient map is not persisted.
  const submittedTasks = new Map<string, string>();
  return ({
  id: 'evolink-gpt-image-2',
  label: 'EvoLink · GPT Image 2',
  mode: 'remote',
  capabilities: ['generate-image', 'edit-image'],
  async run({ intent, plan, job, referenceBlob, resumeScope, signal, onProgress, paidConfirmationToken }) {
    let submittedTaskId: string | undefined;
    let remotePhase: 'create' | 'status' | 'local-result' = 'create';
    try {
      const executionPrompt = composeExecutionPrompt(intent, plan);
      if (intent.operation === 'image_edit_user_reference') {
        if (!referenceBlob || referenceBlob.type !== 'image/png') return providerFailure('CORE007_REFERENCE_BLOB_MISSING', '无法读取本地参考图，请重新选择图片。', false);
        let current: UserReferenceTask;
        if (resumeScope === 'local-result' || resumeScope === 'status-only') {
          onProgress?.({ status: 'processing', progress: resumeScope === 'local-result' ? 92 : 74, message: resumeScope === 'local-result' ? '仅重取已完成的本地结果，不会再次提交付费生成' : '仅重查既有 Provider 任务，不会再次提交付费生成' });
          const statusResponse = await fetchImpl(`${basePath}/user-reference-image-jobs/${encodeURIComponent(job.id)}`, { signal });
          const statusBody = await safeJson(statusResponse);
          if (!statusResponse.ok || !isUserReferenceTask(statusBody)) {
            const error = isRecord(statusBody) && isRecord(statusBody.error) ? statusBody.error : {};
            return providerFailure(typeof error.code === 'string' ? error.code : 'CORE007_LOCAL_RESULT_STATUS_FAILED', typeof error.message === 'string' ? error.message : '无法读取已完成任务的本地结果状态。', false, 'none');
          }
          current = statusBody;
          if (resumeScope === 'status-only' && current.status === 'failed' && current.retryScope === 'status-only') {
            const retryResponse = await fetchImpl(`${basePath}/user-reference-image-jobs/${encodeURIComponent(job.id)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'retry-status' }),
              signal,
            });
            const retryBody = await safeJson(retryResponse);
            if (!retryResponse.ok || !isUserReferenceTask(retryBody)) {
              const error = isRecord(retryBody) && isRecord(retryBody.error) ? retryBody.error : {};
              return providerFailure(typeof error.code === 'string' ? error.code : 'CORE007_STATUS_RETRY_FAILED', typeof error.message === 'string' ? error.message : '无法重新查询既有 Provider 任务。', false, 'none');
            }
            current = retryBody;
          } else if (resumeScope === 'local-result' && current.status === 'local_result_pending') {
            const retryResponse = await fetchImpl(`${basePath}/user-reference-image-jobs/${encodeURIComponent(job.id)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'retry-local-result' }),
              signal,
            });
            const retryBody = await safeJson(retryResponse);
            if (!retryResponse.ok || !isUserReferenceTask(retryBody)) {
              const error = isRecord(retryBody) && isRecord(retryBody.error) ? retryBody.error : {};
              return providerFailure(typeof error.code === 'string' ? error.code : 'CORE007_LOCAL_RESULT_RETRY_FAILED', typeof error.message === 'string' ? error.message : '无法重新取回本地结果。', false, 'none');
            }
            current = retryBody;
          }
        } else {
          if (!isPaidConfirmationToken(paidConfirmationToken)) return providerFailure('CORE008_PAID_CONFIRMATION_REQUIRED', '本次发送缺少有效的图片一次性授权凭证。', false, 'none');
          onProgress?.({ status: 'validating', progress: 8, message: '正在校验本地参考图' });
          const uploaded = await referenceUpload({
            endpoint: `${basePath}/user-reference-image-jobs`,
            jobId: job.id,
            prompt: executionPrompt,
            blob: referenceBlob,
            signal,
            paidConfirmationToken,
            onProgress: (value) => onProgress?.({ status: 'uploading', progress: Math.max(12, Math.min(55, value)), message: '正在上传到本机安全处理服务' }),
          });
          const createdBody = uploaded.body;
          if (!uploaded.response.ok || !isUserReferenceTask(createdBody) || createdBody.localJobId !== job.id) {
            const error: { code?: string; message?: string; retryable?: boolean } = isRecord(createdBody) && isRecord(createdBody.error) ? createdBody.error : {};
            const scope = isRecord(createdBody) && createdBody.retryScope ? normalizeRetryScope(createdBody.retryScope) : error.retryable ? 'new-provider-job' : 'none';
            return providerFailure(typeof error.code === 'string' ? error.code : 'CORE007_CREATE_FAILED', typeof error.message === 'string' ? error.message : '未能创建参考图编辑任务。', Boolean(error.retryable), scope);
          }
          current = createdBody;
          onProgress?.({ status: 'submitted', progress: Math.max(65, createdBody.progress), message: '参考图已提交；远端最长保留 72 小时' });
        }
        const completed = ['completed', 'failed', 'user_cancelled', 'local_result_pending'].includes(current.status)
          ? current
          : await pollUserReferenceTask(fetchImpl, basePath, job.id, pollIntervalMs, signal, onProgress);
        if (completed.status === 'user_cancelled') return providerFailure('CORE007_USER_CANCELLED', '已停止本地等待并忽略迟到结果；不代表远端任务已取消、退款或提前删除。', false);
        if (completed.status !== 'completed' || !completed.resultId || !completed.result) {
          const scope = normalizeRetryScope(completed.retryScope);
          return providerFailure(
            completed.error?.code ?? 'CORE007_TASK_FAILED',
            completed.error?.message ?? '参考图编辑任务未返回结果。',
            scope === 'local-result' || scope === 'status-only' || (scope === 'new-provider-job' && Boolean(completed.error?.retryable)),
            scope,
          );
        }
        const resultResponse = await fetchImpl(`${basePath}/local-assets/${encodeURIComponent(completed.resultId)}`, { signal });
        if (!resultResponse.ok) return providerFailure('CORE007_RESULT_DOWNLOAD_FAILED', 'Provider 已完成生成；只能重试本地取回，不会再次提交付费生成。', true, 'local-result');
        const resultBlob = await resultResponse.blob();
        if (resultBlob.type !== 'image/png' || resultBlob.size === 0) return providerFailure('CORE007_RESULT_INVALID', '本地结果图片类型无效。', false);
        return {
          ok: true,
          asset: {
            id: id('asset'),
            kind: 'image',
            source: 'remote-provider',
            providerId: 'evolink-gpt-image-2',
            jobId: job.id,
            mimeType: 'image/png',
            prompt: executionPrompt,
            createdAt: isoNow(),
            metadata: { deterministic: false, width: completed.result.width, height: completed.result.height },
          },
          blob: resultBlob,
        };
      }
      let taskId = submittedTasks.get(job.id);
      if (resumeScope && !taskId) {
        try {
          const recoveryResponse = await fetchImpl(`${basePath}/image-jobs/by-client-job/${encodeURIComponent(job.id)}`, { signal });
          const recovered = await parseJson<EvoLinkTask>(recoveryResponse);
          if (!recoveryResponse.ok || typeof recovered.id !== 'string' || !/^task-unified-[A-Za-z0-9_-]+$/.test(recovered.id)) {
            return providerFailure(
              recovered.error?.code ?? 'CORE008_LOCAL_TASK_HANDLE_MISSING',
              recovered.error?.message ?? '刷新后本机未保留原 Provider 任务；不会创建新的付费任务。',
              false,
              'none',
            );
          }
          taskId = recovered.id;
          submittedTasks.set(job.id, taskId);
        } catch (error) {
          if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
          return providerFailure('CORE008_LOCAL_TASK_HANDLE_UNAVAILABLE', '本机暂时无法读取原 Provider 任务绑定；不会创建新的付费任务。', true, 'status-only');
        }
      }
      if (!taskId || !resumeScope) {
        if (!isPaidConfirmationToken(paidConfirmationToken)) return providerFailure('CORE008_PAID_CONFIRMATION_REQUIRED', '本次发送缺少有效的图片一次性授权凭证。', false, 'none');
        const created = await fetchImpl(`${basePath}/${job.operation === 'edit' ? 'image-edit-jobs' : 'image-jobs'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-ELYRA-Paid-Confirmation': paidConfirmationToken },
          body: JSON.stringify({ prompt: executionPrompt, clientJobId: job.id }),
          signal,
        });
        const task = await parseJson<EvoLinkTask>(created);
        if (!created.ok || !task.id) return providerFailure(task.error?.code ?? 'EVOLINK_CREATE_FAILED', task.error?.message ?? 'EvoLink 未能创建图片任务。', Boolean(task.error?.retryable), normalizeRetryScope(task.error?.retryScope));
        taskId = task.id;
        submittedTasks.set(job.id, taskId);
      }

      submittedTaskId = taskId;
      remotePhase = 'status';
      const completed = await pollTask(fetchImpl, basePath, taskId, pollIntervalMs, signal);
      if (completed.status !== 'completed' || !completed.resultId || !completed.result) {
        const scope = normalizeRetryScope(completed.error?.retryScope);
        if (scope === 'none') submittedTasks.delete(job.id);
        return providerFailure(
          completed.error?.code ?? 'EVOLINK_TASK_FAILED',
          completed.error?.message ?? 'EvoLink 图片任务未返回本地结果。',
          Boolean(completed.error?.retryable),
          scope,
        );
      }
      remotePhase = 'local-result';
      const resultResponse = await fetchImpl(`${basePath}/image-job-results/${encodeURIComponent(completed.resultId)}`, { signal });
      if (!resultResponse.ok) return providerFailure('CORE008_RESULT_DOWNLOAD_FAILED', 'Provider 已完成生成；只能重试本地取回，不会再次提交付费生成。', true, 'local-result');
      const resultBlob = await resultResponse.blob();
      if (resultBlob.type !== 'image/png' || resultBlob.size === 0) return providerFailure('CORE008_RESULT_INVALID', '本地结果图片类型无效；可仅重取同一结果，不会再次生成或计费。', false, 'local-result');
      return {
        ok: true,
        asset: {
          id: id('asset'),
          kind: 'image',
          source: 'remote-provider',
          providerId: 'evolink-gpt-image-2',
          jobId: job.id,
          mimeType: 'image/png',
          prompt: executionPrompt,
          createdAt: isoNow(),
          metadata: { deterministic: false, width: completed.result.width, height: completed.result.height },
        },
        blob: resultBlob,
      };
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) return providerFailure('CORE007_USER_CANCELLED', '已停止本地等待并忽略迟到结果；不代表远端任务已取消、退款或提前删除。', false);
      if (intent.operation === 'image_edit_user_reference') return providerFailure('EVOLINK_NETWORK_ERROR', '本机服务无法连接 EvoLink 图片任务。', false, 'none');
      if (submittedTaskId && remotePhase === 'local-result') {
        return providerFailure('CORE008_LOCAL_RESULT_UNAVAILABLE', 'Provider 已完成生成，但本地结果暂时无法取回；只能重试本地取回，不会再次提交付费生成。', true, 'local-result');
      }
      if (submittedTaskId) {
        return providerFailure('CORE008_STATUS_UNAVAILABLE', '已提交的 Provider 任务状态暂时无法查询；只能重查原任务，不会再次提交付费生成。', true, 'status-only');
      }
      return providerFailure('CORE008_CREATE_AMBIGUOUS', '图片任务创建结果不明确，可能已经产生费用；不会自动或普通重试。', false, 'none');
    }
  },
  });
};

/**
 * Browser-side CORE-009 image-to-video adapter. The browser sends one owned
 * image Blob to the same-origin BFF and only ever receives a localhost MP4
 * Blob. EvoLink task IDs and result URLs stay behind the server boundary.
 */
export const createEvoLinkSoraVideoProvider = (
  fetchImpl: typeof fetch = fetch,
  routes: typeof CORE009_VIDEO_BFF_ROUTES = CORE009_VIDEO_BFF_ROUTES,
  pollIntervalMs = 1_500,
): ProviderAdapter => ({
  id: 'evolink-sora-2-preview',
  label: 'EvoLink · Sora 2 Preview',
  mode: 'remote',
  capabilities: ['generate-video-from-image'],
  async run({ intent, plan, job, referenceBlob, sourceBinding, resumeScope, signal, onProgress, paidConfirmationToken }) {
    if (intent.operation !== 'video_image_to_video' || plan.operation !== intent.operation || job.operation !== 'video') {
      return providerFailure('CORE009_VIDEO_OPERATION_INVALID', '当前 Intent、Plan 与 Video Job 不一致。', false, 'none');
    }
    if (!intent.targetCanvasObjectId || job.targetCanvasObjectId !== intent.targetCanvasObjectId) {
      return providerFailure('CORE009_VIDEO_TARGET_REQUIRED', '图生视频必须绑定一个已选图片对象。', false, 'none');
    }
    if (
      !sourceBinding
      || sourceBinding.canvasObjectId !== intent.targetCanvasObjectId
      || !sourceBinding.versionId
      || !sourceBinding.assetId
    ) return providerFailure('CORE009_VIDEO_SOURCE_BINDING_INVALID', '图生视频的 Canvas Object、Version 与 Asset 绑定无效。', false, 'none');
    if (!referenceBlob || referenceBlob.type !== 'image/png' || referenceBlob.size < 1) {
      return providerFailure('CORE009_VIDEO_REFERENCE_BLOB_INVALID', '图生视频只接受已在本机净化并保存的 PNG 图片。', false, 'none');
    }

    const statusUrl = `${routes.jobs}/${encodeURIComponent(job.id)}`;
    let taskHandleAvailable = resumeScope === 'status-only' || resumeScope === 'local-result';
    try {
      let current: Core009VideoTask;
      if (resumeScope === 'status-only' || resumeScope === 'local-result') {
        onProgress?.({ status: 'processing', progress: resumeScope === 'local-result' ? 94 : 72, message: resumeScope === 'local-result' ? '仅重取已完成的本地视频，不会再次提交付费任务' : '仅重查原视频任务，不会再次提交付费任务' });
        const response = await fetchImpl(statusUrl, { signal });
        const body = await safeJson(response);
        if (!response.ok || !isCore009VideoTask(body) || body.localJobId !== job.id) {
          return providerFailure('CORE009_VIDEO_STATUS_UNAVAILABLE', '无法读取原视频任务；不会创建新的付费任务。', false, 'none');
        }
        current = body;
        if (current.status === 'failed' && resumeScope === 'status-only' && core009TaskRetryScope(current) === 'status-only') {
          const retry = await fetchImpl(statusUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'retry-status' }),
            signal,
          });
          const retried = await safeJson(retry);
          if (!retry.ok || !isCore009VideoTask(retried) || retried.localJobId !== job.id) {
            return providerFailure('CORE009_VIDEO_STATUS_RETRY_FAILED', '原视频任务状态重查失败；不会重新提交生成。', false, 'none');
          }
          current = retried;
        }
        if (current.status === 'local_result_pending' && resumeScope === 'local-result') {
          const retry = await fetchImpl(statusUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'retry-local-result' }),
            signal,
          });
          const retried = await safeJson(retry);
          if (!retry.ok || !isCore009VideoTask(retried) || retried.localJobId !== job.id) {
            return providerFailure('CORE009_VIDEO_LOCAL_RESULT_RETRY_FAILED', '本地视频结果重取失败；不会重新提交生成。', false, 'none');
          }
          current = retried;
        }
      } else {
        if (!isPaidConfirmationToken(paidConfirmationToken)) {
          return providerFailure('CORE009_PAID_CONFIRMATION_REQUIRED', '本次发送缺少有效的视频一次性授权凭证。', false, 'none');
        }
        onProgress?.({ status: 'validating', progress: 8, message: '正在校验图生视频的对象、版本与本地图片' });
        const form = new FormData();
        form.set('clientJobId', job.id);
        form.set('prompt', composeExecutionPrompt(intent, plan));
        form.set('sourceObjectId', sourceBinding.canvasObjectId);
        form.set('sourceVersionId', sourceBinding.versionId);
        form.set('sourceAssetId', sourceBinding.assetId);
        form.set('file', referenceBlob, 'reference.png');
        onProgress?.({ status: 'uploading', progress: 30, message: '正在上传本地参考图到受控服务' });
        const response = await fetchImpl(routes.jobs, {
          method: 'POST',
          headers: { 'X-ELYRA-Paid-Confirmation': paidConfirmationToken },
          body: form,
          signal,
        });
        const body = await safeJson(response);
        if (!response.ok || !isCore009VideoTask(body) || body.localJobId !== job.id) {
          const error = isRecord(body) && isRecord(body.error) ? body.error : {};
          const scope = normalizeRetryScope(error.retryScope);
          return providerFailure(
            typeof error.code === 'string' ? error.code : 'CORE009_VIDEO_CREATE_FAILED',
            typeof error.message === 'string' ? error.message : '未能创建 Sora 2 Preview 图生视频任务。',
            error.retryable === true && scope === 'new-provider-job',
            scope === 'new-provider-job' ? scope : 'none',
          );
        }
        current = body;
        taskHandleAvailable = true;
        onProgress?.({ status: 'submitted', progress: Math.max(45, current.progress), message: 'Sora 2 Preview 四秒图生视频任务已提交' });
      }

      const completed = ['completed', 'failed', 'user_cancelled', 'local_result_pending'].includes(current.status)
        ? current
        : await pollCore009VideoTask(fetchImpl, statusUrl, job.id, pollIntervalMs, signal, onProgress);
      if (completed.status === 'user_cancelled') {
        return providerFailure('CORE009_USER_CANCELLED', '已停止本地等待并忽略迟到结果；不代表远端任务已取消、退款或删除。', false, 'none');
      }
      if (completed.status !== 'completed' || !completed.resultId || !completed.result) {
        const scope = core009TaskRetryScope(completed);
        return providerFailure(
          completed.error?.code ?? 'CORE009_VIDEO_TASK_FAILED',
          completed.error?.message ?? 'Sora 2 Preview 未返回可用视频结果。',
          completed.error?.retryable === true && (scope === 'status-only' || scope === 'local-result' || scope === 'new-provider-job'),
          scope,
        );
      }
      if (
        completed.result.mimeType !== 'video/mp4'
        || !Number.isFinite(completed.result.durationSeconds)
        || completed.result.durationSeconds < 3.5
        || completed.result.durationSeconds > 4.5
        || !Number.isInteger(completed.result.width)
        || completed.result.width < 1
        || !Number.isInteger(completed.result.height)
        || completed.result.height < 1
        || !/^[0-9a-f]{64}$/.test(completed.result.sha256)
      ) {
        return providerFailure('CORE009_VIDEO_RESULT_METADATA_INVALID', '视频结果不是受控的四秒 MP4。', false, 'none');
      }
      const resultResponse = await fetchImpl(`${routes.assets}/${encodeURIComponent(completed.resultId)}`, { signal });
      if (!resultResponse.ok) return providerFailure('CORE009_VIDEO_RESULT_DOWNLOAD_FAILED', 'Provider 已完成；只能重取本地视频，不会重新提交付费生成。', true, 'local-result');
      const resultBlob = await resultResponse.blob();
      if (resultBlob.type !== 'video/mp4' || resultBlob.size < 12) return providerFailure('CORE009_VIDEO_RESULT_INVALID', '本地视频结果不是有效 MP4。', false, 'none');
      const header = new Uint8Array(await resultBlob.slice(0, 12).arrayBuffer());
      if (String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') return providerFailure('CORE009_VIDEO_RESULT_INVALID', '本地视频缺少 MP4 ftyp 签名。', false, 'none');
      if (await sha256Blob(resultBlob) !== completed.result.sha256) return providerFailure('CORE009_VIDEO_RESULT_DIGEST_MISMATCH', '本地视频与受控任务摘要不一致。', false, 'none');
      return {
        ok: true,
        asset: {
          id: id('asset'),
          kind: 'video',
          source: 'remote-provider',
          providerId: 'evolink-sora-2-preview',
          jobId: job.id,
          mimeType: 'video/mp4',
          prompt: composeExecutionPrompt(intent, plan),
          createdAt: isoNow(),
          metadata: {
            deterministic: false,
            width: completed.result.width,
            height: completed.result.height,
            durationSeconds: completed.result.durationSeconds,
          },
        },
        blob: resultBlob,
      };
    } catch (error) {
      if (signal?.aborted && signal.reason === 'RUN_DEADLINE_EXCEEDED') {
        return taskHandleAvailable
          ? providerFailure('CORE009_VIDEO_DEADLINE_EXCEEDED', '本地运行期限已到；只允许重查原视频任务，不会软取消或重新提交付费生成。', true, 'status-only')
          : providerFailure('CORE009_VIDEO_DEADLINE_EXCEEDED', '本地运行期限在视频任务建立前已到；未自动重提付费生成。', false, 'none');
      }
      if (signal?.aborted) {
        void fetchImpl(statusUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'soft-cancel' }),
        }).catch(() => undefined);
        return providerFailure('CORE009_USER_CANCELLED', '已停止本地等待并忽略迟到结果；不代表远端任务已取消、退款或删除。', false, 'none');
      }
      return providerFailure('CORE009_VIDEO_NETWORK_ERROR', '本机服务暂时无法完成图生视频；不会自动重投付费任务。', false, 'none');
    }
  },
});

const providerFailure = (code: string, message: string, retryable = true, retryScope?: ProviderRetryScope): ProviderRunResult => ({
  ok: false,
  error: { code, message, retryable, ...(retryScope ? { retryScope } : {}) },
});

const normalizeRetryScope = (value: unknown): ProviderRetryScope => ['new-provider-job', 'local-result', 'status-only', 'none'].includes(String(value)) ? value as ProviderRetryScope : 'none';

const parseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const pollTask = async (fetchImpl: typeof fetch, basePath: string, taskId: string, pollIntervalMs: number, signal?: AbortSignal): Promise<EvoLinkTask> => {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    await abortablePause(pollIntervalMs, signal);
    const response = await fetchImpl(`${basePath}/jobs/${encodeURIComponent(taskId)}`, { signal });
    const task = await parseJson<EvoLinkTask & { error?: { code?: string; message?: string } }>(response);
    if (!response.ok || task.status === 'completed' || task.status === 'failed' || task.status === 'local_result_pending') return task;
  }
  return { id: taskId, status: 'failed', error: { code: 'EVOLINK_TIMEOUT', message: 'EvoLink 图片任务超时。' } };
};

const pollCore009VideoTask = async (
  fetchImpl: typeof fetch,
  statusUrl: string,
  localJobId: string,
  pollIntervalMs: number,
  signal?: AbortSignal,
  onProgress?: (progress: ProviderProgress) => void,
): Promise<Core009VideoTask> => {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    await abortablePause(pollIntervalMs, signal);
    const response = await fetchImpl(statusUrl, { signal });
    const task = await safeJson(response);
    if (!isCore009VideoTask(task) || task.localJobId !== localJobId) {
      return { localJobId, status: 'failed', progress: 0, error: { code: 'CORE009_VIDEO_STATUS_SCHEMA_INVALID', message: '本地视频任务状态无效。', retryable: false } };
    }
    if (task.status === 'processing' || task.status === 'submitted') {
      onProgress?.({ status: task.status, progress: task.progress, message: task.status === 'processing' ? 'Sora 2 Preview 正在生成四秒视频' : '视频任务已提交' });
    }
    if (!response.ok || ['completed', 'failed', 'user_cancelled', 'local_result_pending'].includes(task.status)) return task;
  }
  return {
    localJobId,
    status: 'failed',
    progress: 0,
    retryScope: 'status-only',
    error: {
      code: 'CORE009_VIDEO_TIMEOUT',
      message: '本地等待超时；只允许重查原任务，不会重新提交生成，也不会声称远端任务已取消。',
      retryable: true,
      retryScope: 'status-only',
    },
  };
};

const isCore009VideoTask = (value: unknown): value is Core009VideoTask => {
  if (
    !isRecord(value)
    || typeof value.localJobId !== 'string'
    || !['pending', 'submitted', 'processing', 'local_result_pending', 'completed', 'failed', 'user_cancelled'].includes(String(value.status))
    || !Number.isFinite(value.progress)
  ) return false;
  if (value.retryScope !== undefined && !isProviderRetryScope(value.retryScope)) return false;
  if (value.error !== undefined) {
    if (!isRecord(value.error)) return false;
    if (value.error.retryScope !== undefined && !isProviderRetryScope(value.error.retryScope)) return false;
    if (value.error.retryScope !== undefined && value.retryScope !== undefined && value.error.retryScope !== value.retryScope) return false;
  }
  return true;
};

const isProviderRetryScope = (value: unknown): value is ProviderRetryScope => (
  ['new-provider-job', 'local-result', 'status-only', 'none'] as const
).includes(value as ProviderRetryScope);

const core009TaskRetryScope = (task: Core009VideoTask): ProviderRetryScope => normalizeRetryScope(
  task.retryScope ?? task.error?.retryScope,
);

async function xhrReferenceUpload({ endpoint, jobId, prompt, blob, signal, onProgress, paidConfirmationToken }: Parameters<ReferenceUpload>[0]): Promise<Awaited<ReturnType<ReferenceUpload>>> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open('POST', endpoint);
    xhr.setRequestHeader('X-ELYRA-Paid-Confirmation', paidConfirmationToken);
    xhr.responseType = 'json';
    xhr.timeout = 120_000;
    xhr.withCredentials = false;
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.round((event.loaded / event.total) * 43) + 12);
      else onProgress?.(20);
    });
    xhr.addEventListener('load', () => {
      signal?.removeEventListener('abort', abort);
      const body = isRecord(xhr.response) ? xhr.response : {};
      resolvePromise({ response: new Response(JSON.stringify(body), { status: xhr.status, headers: { 'Content-Type': 'application/json' } }), body: body as UserReferenceTask });
    });
    xhr.addEventListener('error', () => { signal?.removeEventListener('abort', abort); reject(new Error('CORE007_XHR_NETWORK_ERROR')); });
    xhr.addEventListener('timeout', () => { signal?.removeEventListener('abort', abort); reject(new Error('CORE007_XHR_TIMEOUT')); });
    xhr.addEventListener('abort', () => { signal?.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); });
    signal?.addEventListener('abort', abort, { once: true });
    const form = new FormData();
    form.append('file', blob, `${crypto.randomUUID().replaceAll('-', '')}.png`);
    form.append('prompt', prompt);
    form.append('clientJobId', jobId);
    form.append('consentVersion', 'CORE-007-DATA-BOUNDARY-V1');
    if (signal?.aborted) {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    xhr.send(form);
  });
}

const pollUserReferenceTask = async (
  fetchImpl: typeof fetch,
  basePath: string,
  clientJobId: string,
  pollIntervalMs: number,
  signal?: AbortSignal,
  onProgress?: (progress: ProviderProgress) => void,
): Promise<UserReferenceTask> => {
  const deadline = Date.now() + 12 * 60_000;
  try {
    while (Date.now() < deadline) {
      await abortablePause(pollIntervalMs, signal);
      const response = await fetchImpl(`${basePath}/user-reference-image-jobs/${encodeURIComponent(clientJobId)}`, { signal });
      const body = await safeJson(response);
      if (!isUserReferenceTask(body)) return { localJobId: clientJobId, status: 'failed', progress: 0, error: { code: 'CORE007_STATUS_SCHEMA_INVALID', message: '本地任务状态无效。', retryable: false } };
      if (body.status === 'processing' || body.status === 'submitted' || body.status === 'uploading') onProgress?.({ status: body.status === 'uploading' ? 'uploading' : body.status === 'submitted' ? 'submitted' : 'processing', progress: body.progress, message: body.status === 'processing' ? 'GPT Image 2 正在生成子版本' : '参考图正在提交' });
      if (!response.ok || ['completed', 'failed', 'user_cancelled', 'local_result_pending'].includes(body.status)) return body;
    }
  } catch (error) {
    if (signal?.aborted) {
      await fetchImpl(`${basePath}/user-reference-image-jobs/${encodeURIComponent(clientJobId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'soft-cancel' }),
      }).catch(() => undefined);
      return { localJobId: clientJobId, status: 'user_cancelled', progress: 0 };
    }
    throw error;
  }
  return { localJobId: clientJobId, status: 'failed', progress: 0, error: { code: 'CORE007_TIMEOUT', message: '本地等待超时；不会声称远端任务已取消。', retryable: false } };
};

const abortablePause = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolvePromise, reject) => {
  if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const timer = globalThis.setTimeout(resolvePromise, milliseconds);
  signal?.addEventListener('abort', () => { globalThis.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

const safeJson = async (response: Response): Promise<unknown> => { try { return await response.json(); } catch { return null; } };
const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isUserReferenceTask = (value: unknown): value is UserReferenceTask => isRecord(value)
  && typeof value.localJobId === 'string'
  && ['uploading', 'submitted', 'processing', 'local_result_pending', 'completed', 'failed', 'user_cancelled'].includes(String(value.status))
  && Number.isFinite(value.progress);

export const createAgentRuntime = (providers: ProviderAdapter[] = [createDeterministicMockProvider()]): AgentRuntime => {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const defaultProviderId = providers[0]?.id ?? 'deterministic-mock';
  return {
    createIntent({ prompt, targetCanvasObjectId, referenceKind, creationMode = 'image', kind }) {
      const normalizedPrompt = prompt.trim();
      const operation: PlannerOperation = creationMode === 'video'
        ? targetCanvasObjectId ? 'video_image_to_video' : 'clarify'
        : targetCanvasObjectId ? referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference' : 'image_generate';
      return {
        id: id('intent'),
        kind: kind ?? (operation === 'clarify' ? 'clarify' : targetCanvasObjectId ? 'modify' : 'generate'),
        operation,
        source: 'legacy-deterministic',
        creationMode,
        prompt: normalizedPrompt,
        normalizedPrompt,
        goal: normalizedPrompt,
        constraints: ['保留当前 ELYRA 画布与版本边界'],
        targetCanvasObjectId,
        createdAt: isoNow(),
      };
    },
    planIntent(intent) {
      const analysis = analyzePrompt(intent.prompt);
      return {
        id: id('plan'),
        intentId: intent.id,
        providerId: defaultProviderId,
        status: 'proposed',
        operation: intent.operation,
        source: intent.source,
        creationMode: intent.creationMode,
        outputKind: intent.operation === 'clarify' ? 'none' : intent.operation === 'video_image_to_video' ? 'video' : 'image',
        summary: analysis.summary,
        bullets: analysis.bullets,
        constraints: intent.constraints,
        visualDirection: { subject: '产品主体', style: '高级商业视觉', lighting: '克制棚拍光', composition: '主体清晰、留白平衡' },
        shouldFail: analysis.shouldFail,
        createdAt: isoNow(),
      };
    },
    createJob({ intent, plan, attempt = 1 }) {
      if (plan.intentId !== intent.id) throw new Error('AgentPlan 与 UserIntent 不匹配。');
      if (intent.operation === 'clarify') throw new Error('Clarify Intent 不能创建 Job。');
      const expectedOperation: PlannerOperation = intent.operation === 'video_image_to_video'
        ? intent.targetCanvasObjectId ? 'video_image_to_video' : 'clarify'
        : intent.targetCanvasObjectId ? intent.operation === 'image_edit_user_reference' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference' : 'image_generate';
      if (intent.operation !== expectedOperation || plan.operation !== expectedOperation) throw new Error('AgentPlan operation 与 Canvas Object 上下文不匹配。');
      const timestamp = isoNow();
      return {
        id: id('job'),
        intentId: intent.id,
        planId: plan.id,
        providerId: plan.providerId,
        operation: intent.operation === 'video_image_to_video' ? 'video' : intent.targetCanvasObjectId ? 'edit' : 'generate',
        targetCanvasObjectId: intent.targetCanvasObjectId,
        status: 'queued',
        attempt,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
    async execute(job, intent, plan, options = {}) {
      const provider = providerById.get(job.providerId);
      if (!provider) {
        return {
          ok: false,
          error: { code: 'PROVIDER_NOT_CONFIGURED', message: `Provider ${job.providerId} 未配置。`, retryable: false },
        };
      }
      return provider.run({ job, intent, plan, ...options });
    },
  };
};

/** The only currently registered adapter. It is local, deterministic, and network-free. */
export const localAgentRuntime = createAgentRuntime();
export const evolinkAgentRuntime = createAgentRuntime([createEvoLinkGptImageProvider()]);
export const evolinkSoraRuntime = createAgentRuntime([createEvoLinkSoraVideoProvider()]);
export const evolinkMediaRuntime = createAgentRuntime([createEvoLinkGptImageProvider(), createEvoLinkSoraVideoProvider()]);
