import { createHash, randomUUID } from 'node:crypto';
import { readEvoLinkKey } from './evolink.mjs';
import {
  PlannerBudgetExceededError,
  PlannerBudgetLedgerError,
  createPlannerBudgetLedger,
} from './planner-budget.mjs';

export const PLANNER_PROVIDER = 'EvoLink';
export const PLANNER_ORIGIN = 'https://direct.evolink.ai';
export const PLANNER_ENDPOINT = '/v1/messages';
export const PLANNER_MODEL = 'claude-haiku-4-5-20251001';
export const PLANNER_MAX_TOKENS = 1024;
export const CORE003_BUDGET_CAP_USD = 5;
export const CORE007_CONSENT_VERSION = 'CORE-007-DATA-BOUNDARY-V1';
// Bound to docs/evidence/real-provider-agent-planner-v1.json so the paid call
// completed before the persistent ledger was introduced is never forgotten.
export const CORE003_VERIFIED_HISTORICAL_SPEND_USD = 0.0040734;

const ALLOWED_IMAGE_PROVIDERS = new Set(['deterministic-mock', 'evolink-gpt-image-2']);
const RETRYABLE_STATUS = (status) => status === 429 || status >= 500;
const INPUT_RATE_USD_PER_MILLION = 0.9;
const OUTPUT_RATE_USD_PER_MILLION = 4.5;
const CONSERVATIVE_ATTEMPT_RESERVATION_USD = 0.05;

const SYSTEM_PROMPT = `You are ELYRA's planning layer. Convert one non-sensitive visual-design request into a strict tool call.
Do not call tools other than submit_elyra_plan. Do not invent providers, accounts, billing, collaboration, or deployment.
Use the required_operation supplied by ELYRA. A fixed image or video mode cannot be changed. In agent mode, route an unambiguous request to one allowed image or image-to-video operation. If the request is ambiguous, use clarify; never choose text-to-video.
Keep the normalized prompt faithful to the user. Return concise Chinese copy suitable for a professional design workspace.`;
const STRUCTURE_INSTRUCTION = 'Return exactly one submit_elyra_plan tool call. Use exactly 2-4 constraints and exactly 2-4 steps. Include only the fields declared by the tool schema.';

const PLAN_TOOL = {
  name: 'submit_elyra_plan',
  description: 'Submit one validated ELYRA image planning result.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'plan'],
    properties: {
      intent: {
        type: 'object',
        additionalProperties: false,
        required: ['normalized_prompt', 'goal', 'constraints'],
        properties: {
          normalized_prompt: { type: 'string', minLength: 1, maxLength: 4000 },
          goal: { type: 'string', minLength: 1, maxLength: 240 },
          constraints: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 180 } },
        },
      },
      plan: {
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'summary', 'steps', 'visual_direction'],
        properties: {
          operation: { type: 'string', enum: ['image_generate', 'image_edit_fixed_demo_reference', 'image_edit_user_reference', 'video_image_to_video', 'clarify'] },
          summary: { type: 'string', minLength: 1, maxLength: 400 },
          steps: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 180 } },
          visual_direction: {
            type: 'object',
            additionalProperties: false,
            required: ['subject', 'style', 'lighting', 'composition'],
            properties: {
              subject: { type: 'string', minLength: 1, maxLength: 160 },
              style: { type: 'string', minLength: 1, maxLength: 160 },
              lighting: { type: 'string', minLength: 1, maxLength: 160 },
              composition: { type: 'string', minLength: 1, maxLength: 160 },
            },
          },
        },
      },
    },
  },
};

export const createEvoLinkPlannerClient = ({
  fetchImpl = fetch,
  readKey = readEvoLinkKey,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  budgetCapUsd = CORE003_BUDGET_CAP_USD,
  attemptReservationUsd = CONSERVATIVE_ATTEMPT_RESERVATION_USD,
  historicalSpentUsd = CORE003_VERIFIED_HISTORICAL_SPEND_USD,
  budgetLedgerDirectory,
  budgetLedger,
  maxAttempts = 2,
  model = PLANNER_MODEL,
  requestProvider,
  costEstimator = usageCostUsd,
} = {}) => {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) {
    throw new TypeError('Planner maxAttempts must be 1 or 2.');
  }
  const ledger = budgetLedger ?? createPlannerBudgetLedger({ directory: budgetLedgerDirectory, now, initialSpentUsd: historicalSpentUsd });

  const reserveAttempt = async ({ startedAt, retryCount }) => {
    try {
      return await ledger.reserve({ capUsd: budgetCapUsd, amountUsd: attemptReservationUsd });
    } catch (error) {
      if (error instanceof PlannerBudgetExceededError) {
        throw plannerFailure({ status: 402, code: 'PLANNER_BUDGET_EXCEEDED', message: 'CORE-003 的 5 美元规划预算已达到上限。', retryable: false, startedAt, retryCount, now, schemaResult: 'not_received', costUsd: 0, budgetCapUsd, usedBudgetUsd: error.usedUsd });
      }
      throw budgetLedgerFailure({ startedAt, retryCount, now, budgetCapUsd, error });
    }
  };

  const settleAttempt = async ({ reservationId, usage, startedAt, retryCount }) => {
    const actualUsd = usage ? costEstimator(usage) : null;
    try {
      return await ledger.settle({ id: reservationId, actualUsd, capUsd: budgetCapUsd });
    } catch (error) {
      if (error instanceof PlannerBudgetExceededError) {
        throw plannerFailure({ status: 402, code: 'PLANNER_BUDGET_EXCEEDED', message: 'Agent Planner 的实际用量达到里程碑预算上限。', retryable: false, startedAt, retryCount, now, schemaResult: 'not_received', costUsd: 0, budgetCapUsd, usedBudgetUsd: error.usedUsd });
      }
      throw budgetLedgerFailure({ startedAt, retryCount, now, budgetCapUsd, error });
    }
  };

  return {
    getBudgetStatus() {
      return ledger.getStatusSync({ capUsd: budgetCapUsd, reservationPerAttemptUsd: attemptReservationUsd });
    },

    async createPlan(input) {
      const validated = validatePlanningInput(input);
      const expectedOperation = requiredOperation(validated);
      const startedAt = now();
      let token;
      try {
        token = await readKey();
      } catch {
        throw plannerFailure({ status: 503, code: 'PLANNER_NOT_CONFIGURED', message: '本机服务未配置 Agent Planner 凭据。', retryable: false, startedAt, retryCount: 0, now, schemaResult: 'not_received', costUsd: 0, budgetCapUsd, usedBudgetUsd: 0 });
      }
      let lastStatus = 0;
      let lastRequestId;
      let accumulatedCostUsd = 0;
      let usedBudgetUsd = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const reservation = await reserveAttempt({ startedAt, retryCount: attempt });
        usedBudgetUsd = reservation.usedUsd;
        const providerPayload = {
          model,
          max_tokens: PLANNER_MAX_TOKENS,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `${STRUCTURE_INSTRUCTION}\n${JSON.stringify({ request: validated.prompt, creation_mode: validated.creationMode ?? 'legacy-image', selected_canvas_object_count: validated.selectedCanvasObjectCount, selected_canvas_object: Boolean(validated.targetCanvasObjectId), reference_kind: validated.referenceKind ?? 'none', required_operation: expectedOperation, allowed_agent_operations: expectedOperation === 'route_by_intent' ? allowedAgentOperations(validated) : [expectedOperation] })}` }],
          tools: [PLAN_TOOL],
          tool_choice: { type: 'tool', name: PLAN_TOOL.name, disable_parallel_tool_use: true },
        };
        const providerPayloadJson = JSON.stringify(providerPayload);
        // One token cannot occupy fewer than one UTF-8 byte. Binding the input
        // ceiling to this exact payload plus max_tokens proves the Planner
        // request remains inside its USD 0.05 send-authorization slot.
        const inputTokenCeiling = Buffer.byteLength(providerPayloadJson, 'utf8');
        if (costEstimator({ input_tokens: inputTokenCeiling, output_tokens: PLANNER_MAX_TOKENS }) > attemptReservationUsd + Number.EPSILON) {
          const settlement = await settleAttempt({ reservationId: reservation.id, usage: { input_tokens: 0, output_tokens: 0 }, startedAt, retryCount: attempt });
          throw plannerFailure({ status: 413, code: 'PLANNER_REQUEST_COST_BOUND_EXCEEDED', message: 'Agent Planner 请求超出本次发送的费用上限。', retryable: false, startedAt, retryCount: attempt, now, schemaResult: 'not_received', costUsd: settlement.billedUsd, budgetCapUsd, usedBudgetUsd: settlement.usedUsd });
        }
        let response;
        try {
          response = requestProvider ? await requestProvider({ payload: providerPayload, token, signal: AbortSignal.timeout(20_000) }) : await fetchImpl(`${PLANNER_ORIGIN}${PLANNER_ENDPOINT}`, {
            method: 'POST', redirect: 'error',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: providerPayloadJson,
            signal: AbortSignal.timeout(20_000),
          });
        } catch {
          const settlement = await settleAttempt({ reservationId: reservation.id, usage: null, startedAt, retryCount: attempt });
          accumulatedCostUsd += settlement.billedUsd;
          usedBudgetUsd = settlement.usedUsd;
          if (attempt + 1 < maxAttempts) {
            await sleepImpl(250);
            continue;
          }
          throw plannerFailure({ status: 502, code: 'PLANNER_NETWORK_ERROR', message: '本机服务无法连接 EvoLink Agent Planner。', retryable: true, startedAt, retryCount: attempt, now, costUsd: accumulatedCostUsd, budgetCapUsd, usedBudgetUsd });
        }

        lastStatus = response.status;
        const body = await safeJson(response);
        lastRequestId = safeRequestId(body, response);
        const usage = safeUsage(body?.usage, { inputTokenCeiling, outputTokenCeiling: PLANNER_MAX_TOKENS });
        const usageInvalid = body?.usage !== undefined && body?.usage !== null && !usage;
        const settlement = await settleAttempt({ reservationId: reservation.id, usage, startedAt, retryCount: attempt });
        accumulatedCostUsd += settlement.billedUsd;
        usedBudgetUsd = settlement.usedUsd;

        if (usageInvalid) {
          throw plannerFailure({ status: 502, code: 'PLANNER_USAGE_INVALID', message: 'Agent Planner 返回的用量数据超出本次发送的请求边界。', retryable: false, startedAt, retryCount: attempt, now, requestId: lastRequestId, schemaResult: 'invalid', costUsd: accumulatedCostUsd, budgetCapUsd, usedBudgetUsd });
        }

        if (!response.ok) {
          if (RETRYABLE_STATUS(response.status) && attempt + 1 < maxAttempts) {
            await sleepImpl(250);
            continue;
          }
          throw plannerFailure({
            status: response.status,
            code: response.status === 401 || response.status === 403 ? 'PLANNER_AUTH_FAILED' : response.status === 402 ? 'PLANNER_BALANCE_REQUIRED' : response.status === 429 ? 'PLANNER_RATE_LIMITED' : response.status >= 500 ? 'PLANNER_UPSTREAM_UNAVAILABLE' : 'PLANNER_REQUEST_REJECTED',
            message: safeStatusMessage(response.status),
            retryable: RETRYABLE_STATUS(response.status),
            startedAt,
            retryCount: attempt,
            now,
            requestId: lastRequestId,
            costUsd: accumulatedCostUsd,
            budgetCapUsd,
            usedBudgetUsd,
          });
        }

        if (body?.stop_reason === 'refusal') {
          throw plannerFailure({ status: 422, code: 'PLANNER_REFUSAL', message: 'Agent Planner 拒绝了该请求，请调整为非敏感演示内容。', retryable: false, startedAt, retryCount: attempt, now, requestId: lastRequestId, schemaResult: 'invalid', costUsd: accumulatedCostUsd, budgetCapUsd, usedBudgetUsd });
        }

        let structured;
        try {
          const payload = extractToolPayload(body);
          structured = validateToolPayload(payload, expectedOperation, validated);
        } catch (error) {
          if (!(error instanceof PlannerSchemaError)) throw error;
          throw plannerFailure({ status: 422, code: 'PLANNER_SCHEMA_INVALID', message: error.message, retryable: false, startedAt, retryCount: attempt, now, requestId: lastRequestId, schemaResult: 'invalid', schemaFailureStage: error.stage, providerStopReason: safeStopReason(body?.stop_reason), costUsd: accumulatedCostUsd, budgetCapUsd, usedBudgetUsd });
        }
        const intentId = `intent-${randomUUID()}`;
        const planId = `plan-${randomUUID()}`;
        const intent = {
          id: intentId,
          kind: structured.plan.operation === 'clarify' ? 'clarify' : validated.targetCanvasObjectId ? 'modify' : 'generate',
          operation: structured.plan.operation,
          source: 'remote-agent',
          prompt: validated.prompt,
          normalizedPrompt: structured.intent.normalized_prompt,
          goal: structured.intent.goal,
          constraints: structured.intent.constraints,
          ...(validated.creationMode !== undefined ? { creationMode: validated.creationMode } : {}),
          ...(validated.targetCanvasObjectId ? { targetCanvasObjectId: validated.targetCanvasObjectId } : {}),
          createdAt: new Date(now()).toISOString(),
        };
        const plan = {
          id: planId,
          intentId,
          providerId: structured.plan.operation === 'video_image_to_video' ? validated.videoProviderId : structured.plan.operation === 'clarify' ? 'none' : validated.imageProviderId,
          status: 'proposed',
          operation: structured.plan.operation,
          source: 'remote-agent',
          plannerModel: model,
          summary: structured.plan.summary,
          bullets: structured.plan.steps,
          constraints: structured.intent.constraints,
          visualDirection: {
            subject: structured.plan.visual_direction.subject,
            style: structured.plan.visual_direction.style,
            lighting: structured.plan.visual_direction.lighting,
            composition: structured.plan.visual_direction.composition,
          },
          shouldFail: false,
          ...(validated.creationMode !== undefined ? {
            creationMode: validated.creationMode,
            outputKind: structured.plan.operation === 'video_image_to_video'
              ? 'video'
              : structured.plan.operation === 'clarify' ? 'none' : 'image',
          } : {}),
          ...(structured.plan.operation === 'clarify' ? { clarificationQuestion: structured.plan.summary } : {}),
          createdAt: new Date(now()).toISOString(),
        };
        const evidence = {
          ...baseEvidence(),
          httpStatus: lastStatus,
          ...(lastRequestId ? { requestId: lastRequestId } : {}),
          durationMs: Math.max(0, now() - startedAt),
          retryCount: attempt,
          schemaResult: 'valid',
          intentSummarySha256: sha256Json({ goal: intent.goal, operation: intent.operation, constraints: intent.constraints }),
          planSummarySha256: sha256Json({ summary: plan.summary, bullets: plan.bullets, visualDirection: plan.visualDirection }),
          estimatedRequestCostUsd: roundUsd(accumulatedCostUsd),
          budgetCapUsd,
          budgetUsedUsd: roundUsd(usedBudgetUsd),
          pricingSource: 'https://evolink.ai/claude-haiku-4-5',
          pricingCheckedAt: '2026-08-05',
        };
        return { intent, plan, evidence };
      }

      throw plannerFailure({ status: lastStatus || 502, code: 'PLANNER_UPSTREAM_UNAVAILABLE', message: 'Agent Planner 暂时不可用。', retryable: true, startedAt, retryCount: Math.max(0, maxAttempts - 1), now, requestId: lastRequestId, costUsd: accumulatedCostUsd, budgetCapUsd, usedBudgetUsd });
    },
  };
};

const validatePlanningInput = (input) => {
  if (!isRecord(input)) throw new PlannerInputError('规划请求必须是对象。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) throw new PlannerInputError('视觉需求必须为 1–4000 个字符。');
  if (!ALLOWED_IMAGE_PROVIDERS.has(input.imageProviderId)) throw new PlannerInputError('图片 Provider 不在 CORE-003 白名单中。');
  const creationMode = input.creationMode;
  if (creationMode !== undefined && !['agent', 'image', 'video'].includes(creationMode)) throw new PlannerInputError('创作模式必须是 agent、image 或 video。', 'CORE009_MODE_INVALID');
  if (creationMode !== undefined && input.videoProviderId !== 'evolink-sora-2-preview') throw new PlannerInputError('视频 Provider 不在 CORE-009 白名单中。', 'CORE009_VIDEO_PROVIDER_INVALID');
  if (input.targetCanvasObjectId !== undefined && (typeof input.targetCanvasObjectId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.targetCanvasObjectId))) throw new PlannerInputError('目标 Canvas Object ID 无效。');
  const referenceKind = input.targetCanvasObjectId ? input.referenceKind ?? 'fixed-demo' : undefined;
  if (referenceKind !== undefined && !['fixed-demo', 'user-upload'].includes(referenceKind)) throw new PlannerInputError('参考图类型不在 CORE-007 白名单中。');
  if (!input.targetCanvasObjectId && input.referenceKind !== undefined) throw new PlannerInputError('未选中 Canvas Object 时不得声明参考图类型。');
  if (referenceKind === 'user-upload' && input.consentVersion !== CORE007_CONSENT_VERSION) {
    throw new PlannerInputError('必须先确认用户参考图外传与最长 72 小时留存边界。', 'CORE007_CONSENT_REQUIRED');
  }
  const selectedCanvasObjectCount = creationMode === undefined ? (input.targetCanvasObjectId ? 1 : 0) : input.selectedCanvasObjectCount;
  if (!Number.isInteger(selectedCanvasObjectCount) || selectedCanvasObjectCount < 0 || selectedCanvasObjectCount > 100) throw new PlannerInputError('选中对象数量无效。', 'CORE009_SELECTION_COUNT_INVALID');
  if ((selectedCanvasObjectCount === 1) !== Boolean(input.targetCanvasObjectId)) throw new PlannerInputError('单选绑定与选中对象数量不一致。', 'CORE009_SELECTION_BINDING_INVALID');
  if (creationMode === 'image' && selectedCanvasObjectCount > 1) throw new PlannerInputError('图片模式只允许未选中或单选一张图片。', 'CORE009_IMAGE_SELECTION_INVALID');
  if (creationMode === 'video' && selectedCanvasObjectCount !== 1) throw new PlannerInputError('视频模式必须且只能选中一张图片。', 'CORE009_VIDEO_SELECTION_REQUIRED');
  return { prompt: input.prompt.trim(), imageProviderId: input.imageProviderId, videoProviderId: input.videoProviderId, creationMode, selectedCanvasObjectCount, targetCanvasObjectId: input.targetCanvasObjectId, referenceKind };
};

const extractToolPayload = (body) => {
  if (!isRecord(body) || !Array.isArray(body.content)) throw invalidSchema('message_envelope');
  const blocks = body.content.filter((item) => isRecord(item) && item.type === 'tool_use' && item.name === PLAN_TOOL.name);
  if (blocks.length !== 1) throw invalidSchema('tool_selection');
  if (!isRecord(blocks[0].input)) throw invalidSchema('tool_input');
  return blocks[0].input;
};

const validateToolPayload = (payload, expectedOperation, validated) => {
  if (!hasExactKeys(payload, ['intent', 'plan'])) throw invalidSchema('top_level_shape');
  const intent = payload.intent;
  const plan = payload.plan;
  if (!hasExactKeys(intent, ['normalized_prompt', 'goal', 'constraints'])) throw invalidSchema('intent_shape');
  if (!hasExactKeys(plan, ['operation', 'summary', 'steps', 'visual_direction'])) throw invalidSchema('plan_shape');
  if (!validString(intent.normalized_prompt, 4000) || !validString(intent.goal, 240) || !validStringArray(intent.constraints, 1, 8, 180)) throw invalidSchema('intent_values');
  if (expectedOperation === 'route_by_intent') {
    if (!allowedAgentOperations(validated).includes(plan.operation)) throw invalidSchema('plan_operation');
  } else if (plan.operation !== expectedOperation) throw invalidSchema('plan_operation');
  if (!validString(plan.summary, 400) || !validStringArray(plan.steps, 2, 6, 180)) throw invalidSchema('plan_values');
  if (!hasExactKeys(plan.visual_direction, ['subject', 'style', 'lighting', 'composition'])) throw invalidSchema('visual_direction_shape');
  for (const key of ['subject', 'style', 'lighting', 'composition']) if (!validString(plan.visual_direction[key], 160)) throw invalidSchema('visual_direction_values');
  return payload;
};

const requiredOperation = (input) => {
  if (input.creationMode === 'agent') return 'route_by_intent';
  if (input.creationMode === 'video') return 'video_image_to_video';
  return input.targetCanvasObjectId
    ? input.referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference'
    : 'image_generate';
};

const allowedAgentOperations = (input) => {
  if (input.selectedCanvasObjectCount === 0) return ['image_generate', 'clarify'];
  if (input.selectedCanvasObjectCount === 1) {
    const imageOperation = input.referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference';
    // Video execution requires the exact selected pixels to be restored from
    // IndexedDB and bound into the multipart request. A fixed demo node has no
    // persisted Blob, so Agent mode must clarify instead of proposing a paid
    // video action that cannot pass the execution boundary.
    return input.referenceKind === 'user-upload'
      ? [imageOperation, 'video_image_to_video', 'clarify']
      : [imageOperation, 'clarify'];
  }
  return ['clarify'];
};

const invalidSchema = (stage) => new PlannerSchemaError(stage);
const usageCostUsd = (usage) => (usage.input_tokens * INPUT_RATE_USD_PER_MILLION + usage.output_tokens * OUTPUT_RATE_USD_PER_MILLION) / 1_000_000;
const budgetLedgerFailure = ({ startedAt, retryCount, now, budgetCapUsd, error }) => {
  if (!(error instanceof PlannerBudgetLedgerError)) throw error;
  return plannerFailure({
    status: 503,
    code: 'PLANNER_BUDGET_LEDGER_UNAVAILABLE',
    message: '本机规划预算账本不可用，已拒绝发起 Provider 请求。',
    retryable: false,
    startedAt,
    retryCount,
    now,
    schemaResult: 'not_received',
    costUsd: 0,
    budgetCapUsd,
    usedBudgetUsd: 0,
  });
};
const plannerFailure = ({ status, code, message, retryable, startedAt, retryCount, now, requestId, schemaResult = 'not_received', schemaFailureStage, providerStopReason, costUsd, budgetCapUsd, usedBudgetUsd }) => new PlannerError(status, code, message, retryable, {
  ...baseEvidence(),
  httpStatus: status,
  ...(requestId ? { requestId } : {}),
  durationMs: Math.max(0, now() - startedAt),
  retryCount,
  schemaResult,
  ...(schemaFailureStage ? { schemaFailureStage } : {}),
  ...(providerStopReason ? { providerStopReason } : {}),
  redactedErrorCode: code,
  estimatedRequestCostUsd: roundUsd(costUsd),
  budgetCapUsd,
  budgetUsedUsd: roundUsd(usedBudgetUsd),
});
const baseEvidence = () => ({ provider: PLANNER_PROVIDER, endpoint: `${PLANNER_ORIGIN}${PLANNER_ENDPOINT}`, model: PLANNER_MODEL });
const safeStatusMessage = (status) => status === 400 ? 'Agent Planner 请求参数无效。' : status === 401 || status === 403 ? 'Agent Planner 鉴权失败。' : status === 402 ? 'EvoLink 账户余额不足。' : status === 429 ? 'Agent Planner 请求过于频繁。' : status >= 500 ? 'Agent Planner 上游暂时不可用。' : 'Agent Planner 拒绝了该请求。';
const safeStopReason = (value) => ['tool_use', 'max_tokens', 'end_turn', 'refusal', 'pause_turn'].includes(value) ? value : 'unknown';
const safeRequestId = (body, response) => typeof body?.id === 'string' && body.id.length <= 200 ? body.id : response.headers.get('x-request-id')?.slice(0, 200) || undefined;
const safeUsage = (usage, { inputTokenCeiling, outputTokenCeiling }) => isRecord(usage)
  && Number.isInteger(usage.input_tokens)
  && usage.input_tokens >= 0
  && usage.input_tokens <= inputTokenCeiling
  && Number.isInteger(usage.output_tokens)
  && usage.output_tokens >= 0
  && usage.output_tokens <= outputTokenCeiling
  ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
  : null;
const safeJson = async (response) => { try { return await response.json(); } catch { return null; } };
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const validString = (value, max) => typeof value === 'string' && value.trim().length >= 1 && value.length <= max;
const validStringArray = (value, min, max, stringMax) => Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => validString(item, stringMax));
const sha256Json = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const roundUsd = (value = 0) => Number(value.toFixed(8));

export class PlannerInputError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.code = code;
  }
}

class PlannerSchemaError extends Error {
  constructor(stage) {
    super('Agent Planner 返回的结构不符合 CORE-003 schema。');
    this.stage = stage;
  }
}

export class PlannerError extends Error {
  constructor(status, code, message, retryable, evidence) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.evidence = evidence;
  }
}
