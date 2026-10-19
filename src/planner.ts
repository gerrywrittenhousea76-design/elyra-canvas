import type { AgentPlan, CreationMode, PlannerOperation, UserIntent } from './agent';
import type { CanvasTargetBinding } from './agent-target-binding';
import { analyzePrompt, REFERENCE_TRANSFER_CONSENT_VERSION } from './domain';
import type { ImageProviderId } from './domain';
import { isPaidConfirmationToken } from './paid-confirmation';

export interface PlannerEvidence {
  provider: string;
  endpoint: string;
  model: string;
  httpStatus: number;
  requestId?: string;
  durationMs: number;
  retryCount: number;
  schemaResult: 'valid' | 'invalid' | 'not_received';
  schemaFailureStage?: string;
  providerStopReason?: string;
  intentSummarySha256?: string;
  planSummarySha256?: string;
  redactedErrorCode?: string;
  estimatedRequestCostUsd?: number;
  budgetCapUsd?: number;
  budgetUsedUsd?: number;
  pricingSource?: string;
  pricingCheckedAt?: string;
}

export interface PlanningRequest {
  prompt: string;
  creationMode?: CreationMode;
  selectedCanvasObjectCount?: number;
  selectedObjectIds?: string[];
  targetCanvasObjectId?: string;
  targetBinding?: CanvasTargetBinding;
  referenceKind?: 'fixed-demo' | 'user-upload';
  consentVersion?: typeof REFERENCE_TRANSFER_CONSENT_VERSION;
  imageProviderId: ImageProviderId;
  videoProviderId?: 'evolink-sora-2-preview';
}

export type PlanningResult =
  | { ok: true; intent: UserIntent; plan: AgentPlan; evidence: PlannerEvidence }
  | { ok: false; error: { code: string; message: string; retryable: boolean }; evidence?: PlannerEvidence };

export interface PlannerAdapter {
  id: 'evolink-agent-planner';
  plan(request: PlanningRequest, paidConfirmationToken: string, signal?: AbortSignal): Promise<PlanningResult>;
}

export const createEvoLinkPlannerAdapter = (fetchImpl: typeof fetch = fetch, endpoint = '/api/agent/plans'): PlannerAdapter => ({
  id: 'evolink-agent-planner',
  async plan(request, paidConfirmationToken, signal) {
    if (!isPaidConfirmationToken(paidConfirmationToken)) {
      return { ok: false, error: { code: 'CORE008_PAID_CONFIRMATION_REQUIRED', message: '本次发送缺少有效的 Planner 一次性授权凭证。', retryable: false } };
    }
    if (request.referenceKind === 'user-upload' && request.consentVersion !== REFERENCE_TRANSFER_CONSENT_VERSION) {
      return {
        ok: false,
        error: {
          code: 'CORE007_PLANNER_CONSENT_REQUIRED',
          message: '在向远程 Agent Planner 发送用户参考图指令前，必须确认外传与最长 72 小时留存边界。',
          retryable: false,
        },
      };
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ELYRA-Paid-Confirmation': paidConfirmationToken },
        body: JSON.stringify(plannerRequestBody(request)),
        signal,
      });
      const body = await safeJson(response);
      const bodyRecord = isRecord(body) ? body : {};
      if (!response.ok) {
        const errorRecord = isRecord(bodyRecord.error) ? bodyRecord.error : {};
        return {
          ok: false,
          error: {
            code: typeof errorRecord.code === 'string' ? errorRecord.code : 'PLANNER_REQUEST_FAILED',
            message: typeof errorRecord.message === 'string' ? errorRecord.message : 'Agent Planner 暂时不可用。',
            retryable: Boolean(errorRecord.retryable),
          },
          ...(isPlannerEvidence(bodyRecord.evidence) ? { evidence: bodyRecord.evidence } : {}),
        };
      }
      if (!isPlanningEnvelope(body)) {
        return { ok: false, error: { code: 'PLANNER_SCHEMA_INVALID', message: 'Agent Planner 返回的结构不符合 CORE-003 schema。', retryable: false } };
      }
      const creationMode = request.creationMode ?? 'image';
      const expected = expectedPlannerContext(request);
      const expectedOperation = expected.exactOperation;
      const operationAllowed = expected.allowedOperations.includes(body.intent.operation);
      const expectedKind = body.intent.operation === 'clarify' ? 'clarify' : body.intent.operation === 'image_generate' ? 'generate' : 'modify';
      const targetMatches = body.intent.operation === 'clarify'
        ? body.intent.targetCanvasObjectId === request.targetCanvasObjectId
        : operationNeedsTarget(body.intent.operation)
        ? body.intent.targetCanvasObjectId === request.targetCanvasObjectId
        : body.intent.targetCanvasObjectId === undefined;
      const expectedProviderId = body.intent.operation === 'video_image_to_video'
        ? request.videoProviderId ?? 'evolink-sora-2-preview'
        : body.intent.operation === 'clarify' ? 'none' : request.imageProviderId;
      if (
        creationMode === 'agent'
        && body.intent.operation === 'video_image_to_video'
        && request.referenceKind !== 'user-upload'
      ) {
        return {
          ok: false,
          error: {
            code: 'CORE009_VIDEO_SOURCE_NOT_RESTORABLE',
            message: 'Agent 已判断为图生视频，但当前引用不是本机可恢复的图片。请选择上传图或真实生成图后重新发送；Planner 已调用，媒体 Provider 未调用。',
            retryable: false,
          },
          evidence: body.evidence,
        };
      }
      if (
        !operationAllowed
        || (expectedOperation !== undefined && body.intent.operation !== expectedOperation)
        || body.plan.operation !== body.intent.operation
        || body.intent.kind !== expectedKind
        || !targetMatches
        || body.intent.prompt !== request.prompt.trim()
        || body.plan.intentId !== body.intent.id
        || body.plan.providerId !== expectedProviderId
        || (body.intent.creationMode !== undefined && body.intent.creationMode !== creationMode)
        || (body.plan.creationMode !== undefined && body.plan.creationMode !== creationMode)
        || (body.plan.outputKind !== undefined && body.plan.outputKind !== operationOutputKind(body.intent.operation))
      ) {
        return { ok: false, error: { code: 'PLANNER_CONTEXT_MISMATCH', message: 'Agent Planner 结果与当前画布上下文不一致。', retryable: false }, evidence: body.evidence };
      }
      return { ok: true, intent: body.intent, plan: body.plan, evidence: body.evidence };
    } catch {
      return { ok: false, error: { code: 'PLANNER_LOCAL_NETWORK_ERROR', message: '浏览器无法连接本机 Agent Planner 服务。', retryable: true } };
    }
  },
});

export const createDeterministicFallbackPlanning = (request: PlanningRequest): { intent: UserIntent; plan: AgentPlan } => {
  const timestamp = new Date().toISOString();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const creationMode = request.creationMode ?? 'image';
  const operation: PlannerOperation = creationMode === 'video'
    ? 'clarify'
    : request.targetCanvasObjectId ? request.referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference' : 'image_generate';
  const analysis = analyzePrompt(request.prompt);
  const intent: UserIntent = {
    id: `intent-fallback-${suffix}`,
    kind: operation === 'clarify' ? 'clarify' : request.targetCanvasObjectId ? 'modify' : 'generate',
    operation,
    source: 'fallback',
    creationMode,
    prompt: request.prompt.trim(),
    normalizedPrompt: request.prompt.trim(),
    goal: request.prompt.trim(),
    constraints: operation === 'clarify'
      ? ['本地 fallback 不伪造视频 Provider', '请选择 Agent 或图片模式，或恢复真实视频服务']
      : ['仅使用现有图片 Job', '保留原始 Canvas Object 与父版本', '一次发送最多创建一个图片 Job'],
    ...(request.targetCanvasObjectId ? { targetCanvasObjectId: request.targetCanvasObjectId } : {}),
    createdAt: timestamp,
  };
  const plan: AgentPlan = {
    id: `plan-fallback-${suffix}`,
    intentId: intent.id,
    providerId: 'deterministic-mock',
    status: 'proposed',
    operation,
    source: 'fallback',
    creationMode,
    outputKind: operationOutputKind(operation),
    summary: `本地规划草案：${analysis.summary}`,
    bullets: analysis.bullets,
    constraints: intent.constraints,
    visualDirection: { subject: '保留产品主体', style: '高级商业视觉', lighting: '克制棚拍光', composition: '主体清晰、画面平衡' },
    shouldFail: analysis.shouldFail,
    createdAt: timestamp,
  };
  return { intent, plan };
};

/**
 * Direct Image/Video modes bypass the remote Planner but still create the
 * same immutable UserIntent -> AgentPlan boundary consumed by the Job layer.
 * Agent mode must use the real Planner and therefore fails closed to clarify.
 */
export const createDirectModePlanning = (request: PlanningRequest): { intent: UserIntent; plan: AgentPlan } => {
  const creationMode = request.creationMode ?? 'image';
  const selectedIds = canonicalSelection(request);
  const selectionCount = selectedCount(request);
  const oneTarget = selectionCount === 1 && Boolean(request.targetCanvasObjectId) && (selectedIds.length === 0 || request.targetCanvasObjectId === selectedIds[0]);
  let operation: PlannerOperation;
  if (creationMode === 'agent') operation = 'clarify';
  else if (creationMode === 'video') operation = oneTarget ? 'video_image_to_video' : 'clarify';
  else if (selectionCount === 0 && request.targetCanvasObjectId === undefined) operation = 'image_generate';
  else if (oneTarget) operation = request.referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference';
  else operation = 'clarify';

  const analysis = analyzePrompt(request.prompt);
  const timestamp = new Date().toISOString();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outputKind = operationOutputKind(operation);
  const targetCanvasObjectId = operationNeedsTarget(operation) ? request.targetCanvasObjectId : undefined;
  const summary = operation === 'clarify'
    ? creationMode === 'agent'
      ? 'Agent 模式必须先由远程 Planner 选择图片或视频动作。'
      : creationMode === 'video'
        ? '视频模式需要且只允许选择一个可恢复的图片对象。'
        : '图片编辑一次只能选择一个图片对象。'
    : operation === 'video_image_to_video'
      ? `将选中图片生成四秒视频：${analysis.summary}`
      : analysis.summary;
  const constraints = operation === 'video_image_to_video'
    ? ['固定使用 EvoLink Sora 2 Preview', '仅图生视频', '时长固定 4 秒', '保留源图片与父版本', '一次发送最多一个视频 Job']
    : operation === 'clarify'
      ? ['不创建 Provider Job', '等待用户修正模式或选择']
      : ['固定使用现有图片链路', '保留父版本', '一次发送最多一个图片 Job'];
  const intent: UserIntent = {
    id: `intent-direct-${suffix}`,
    kind: operation === 'clarify' ? 'clarify' : operation === 'image_generate' ? 'generate' : 'modify',
    operation,
    source: 'direct-mode',
    creationMode,
    prompt: request.prompt.trim(),
    normalizedPrompt: request.prompt.trim(),
    goal: request.prompt.trim(),
    constraints,
    ...(targetCanvasObjectId ? { targetCanvasObjectId } : {}),
    createdAt: timestamp,
  };
  const plan: AgentPlan = {
    id: `plan-direct-${suffix}`,
    intentId: intent.id,
    providerId: outputKind === 'video' ? request.videoProviderId ?? 'evolink-sora-2-preview' : outputKind === 'image' ? request.imageProviderId : 'none',
    status: 'proposed',
    operation,
    source: 'direct-mode',
    creationMode,
    outputKind,
    summary,
    bullets: operation === 'clarify' ? ['修正选择后重新发送'] : analysis.bullets,
    constraints,
    visualDirection: { subject: '当前创作主体', style: '沿用用户要求', lighting: '保持画面连续', composition: '保持主体清晰' },
    shouldFail: false,
    createdAt: timestamp,
  };
  return { intent, plan };
};

const ALL_PLANNER_OPERATIONS: PlannerOperation[] = ['image_generate', 'image_edit_fixed_demo_reference', 'image_edit_user_reference', 'video_image_to_video', 'clarify'];

const operationNeedsTarget = (operation: PlannerOperation) => operation === 'image_edit_fixed_demo_reference'
  || operation === 'image_edit_user_reference'
  || operation === 'video_image_to_video';

const operationOutputKind = (operation: PlannerOperation): 'image' | 'video' | 'none' => operation === 'video_image_to_video'
  ? 'video'
  : operation === 'clarify' ? 'none' : 'image';

const canonicalSelection = (request: PlanningRequest): string[] => {
  if (request.selectedObjectIds !== undefined) {
    return [...new Set(request.selectedObjectIds.filter((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)))].sort();
  }
  return request.targetCanvasObjectId ? [request.targetCanvasObjectId] : [];
};

const selectedCount = (request: PlanningRequest) => request.selectedCanvasObjectCount ?? canonicalSelection(request).length;

const plannerRequestBody = (request: PlanningRequest) => ({
  prompt: request.prompt,
  imageProviderId: request.imageProviderId,
  ...(request.videoProviderId ? { videoProviderId: request.videoProviderId } : {}),
  ...(request.creationMode ? { creationMode: request.creationMode } : {}),
  ...(request.selectedCanvasObjectCount !== undefined ? { selectedCanvasObjectCount: request.selectedCanvasObjectCount } : {}),
  ...(request.targetCanvasObjectId ? { targetCanvasObjectId: request.targetCanvasObjectId } : {}),
  ...(request.targetBinding ? { targetBinding: request.targetBinding } : {}),
  ...(request.referenceKind ? { referenceKind: request.referenceKind } : {}),
  ...(request.consentVersion ? { consentVersion: request.consentVersion } : {}),
});

const expectedPlannerContext = (request: PlanningRequest): { exactOperation?: PlannerOperation; allowedOperations: PlannerOperation[] } => {
  const creationMode = request.creationMode ?? 'image';
  const selected = canonicalSelection(request);
  const selectionCount = selectedCount(request);
  const oneTarget = selectionCount === 1 && Boolean(request.targetCanvasObjectId) && (selected.length === 0 || request.targetCanvasObjectId === selected[0]);
  if (creationMode === 'image') {
    if (selectionCount === 0 && !request.targetCanvasObjectId) return { exactOperation: 'image_generate', allowedOperations: ['image_generate'] };
    if (oneTarget) {
      const operation = request.referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference';
      return { exactOperation: operation, allowedOperations: [operation] };
    }
    return { exactOperation: 'clarify', allowedOperations: ['clarify'] };
  }
  if (creationMode === 'video') return oneTarget
    ? { exactOperation: 'video_image_to_video', allowedOperations: ['video_image_to_video'] }
    : { exactOperation: 'clarify', allowedOperations: ['clarify'] };
  if (oneTarget) {
    const imageOperation = request.referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference';
    return request.referenceKind === 'user-upload'
      ? { allowedOperations: [imageOperation, 'video_image_to_video', 'clarify'] }
      : { allowedOperations: [imageOperation, 'clarify'] };
  }
  if (selectionCount === 0) return { allowedOperations: ['image_generate', 'clarify'] };
  return { exactOperation: 'clarify', allowedOperations: ['clarify'] };
};

const isPlanningEnvelope = (value: unknown): value is { intent: UserIntent; plan: AgentPlan; evidence: PlannerEvidence } => {
  if (!isRecord(value) || !isRecord(value.intent) || !isRecord(value.plan) || !isPlannerEvidence(value.evidence)) return false;
  const intent = value.intent;
  const plan = value.plan;
  const expectedIntentKeys = ['id', 'kind', 'operation', 'source', 'prompt', 'normalizedPrompt', 'goal', 'constraints', 'createdAt'];
  if (Object.hasOwn(intent, 'targetCanvasObjectId')) expectedIntentKeys.push('targetCanvasObjectId');
  if (Object.hasOwn(intent, 'creationMode')) expectedIntentKeys.push('creationMode');
  const expectedPlanKeys = ['id', 'intentId', 'providerId', 'status', 'operation', 'source', 'plannerModel', 'summary', 'bullets', 'constraints', 'visualDirection', 'shouldFail', 'createdAt'];
  if (Object.hasOwn(plan, 'creationMode')) expectedPlanKeys.push('creationMode');
  if (Object.hasOwn(plan, 'outputKind')) expectedPlanKeys.push('outputKind');
  if (Object.hasOwn(plan, 'clarificationQuestion')) expectedPlanKeys.push('clarificationQuestion');
  if (!hasExactKeys(intent, expectedIntentKeys) || !hasExactKeys(plan, expectedPlanKeys)) return false;
  const operationOk = ALL_PLANNER_OPERATIONS.includes(intent.operation as PlannerOperation);
  const sourceOk = intent.source === 'remote-agent' && plan.source === 'remote-agent';
  const modeOk = (intent.creationMode === undefined || ['agent', 'image', 'video'].includes(String(intent.creationMode)))
    && (plan.creationMode === undefined || ['agent', 'image', 'video'].includes(String(plan.creationMode)));
  const outputKindOk = plan.outputKind === undefined || plan.outputKind === operationOutputKind(intent.operation as PlannerOperation);
  const clarificationOk = plan.clarificationQuestion === undefined
    || (intent.operation === 'clarify' && typeof plan.clarificationQuestion === 'string' && plan.clarificationQuestion.trim().length > 0);
  const stringsOk = ['id', 'prompt', 'normalizedPrompt', 'goal', 'createdAt'].every((key) => typeof intent[key] === 'string' && intent[key].length > 0)
    && ['id', 'intentId', 'providerId', 'plannerModel', 'summary', 'createdAt'].every((key) => typeof plan[key] === 'string' && plan[key].length > 0);
  const kindOk = intent.kind === 'generate' || intent.kind === 'modify' || intent.kind === 'clarify';
  const targetOk = intent.targetCanvasObjectId === undefined || (typeof intent.targetCanvasObjectId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(intent.targetCanvasObjectId));
  const direction = plan.visualDirection;
  const directionOk = isRecord(direction)
    && hasExactKeys(direction, ['subject', 'style', 'lighting', 'composition'])
    && ['subject', 'style', 'lighting', 'composition'].every((key) => typeof direction[key] === 'string' && direction[key].trim().length > 0);
  return operationOk
    && sourceOk
    && modeOk
    && outputKindOk
    && clarificationOk
    && stringsOk
    && kindOk
    && targetOk
    && plan.status === 'proposed'
    && plan.shouldFail === false
    && plan.operation === intent.operation
    && validStringArray(intent.constraints)
    && validStringArray(plan.bullets)
    && validStringArray(plan.constraints)
    && directionOk;
};

const isPlannerEvidence = (value: unknown): value is PlannerEvidence => isRecord(value)
  && typeof value.provider === 'string'
  && typeof value.endpoint === 'string'
  && typeof value.model === 'string'
  && Number.isFinite(value.httpStatus)
  && Number.isFinite(value.durationMs)
  && Number.isInteger(value.retryCount)
  && ['valid', 'invalid', 'not_received'].includes(String(value.schemaResult));

const safeJson = async (response: Response): Promise<unknown> => { try { return await response.json(); } catch { return null; } };
const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value: Record<string, any>, keys: string[]) => Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const validStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0);

export const evolinkPlanner = createEvoLinkPlannerAdapter();
