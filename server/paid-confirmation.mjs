import { createHash, randomBytes } from 'node:crypto';

export const PAID_CONFIRMATION_HEADER = 'x-elyra-paid-confirmation';
export const PAID_CONFIRMATION_TTL_MS = 30_000;
export const PAID_CONFIRMATION_KINDS = Object.freeze(['planner', 'image', 'video']);
export const PAID_CONFIRMATION_ROUTES = Object.freeze({
  '/api/agent/plans': 'planner',
  '/api/agent/image-jobs': 'image',
  '/api/agent/image-edit-jobs': 'image',
  '/api/agent/user-reference-image-jobs': 'image',
  '/api/agent/video-jobs': 'video',
});

const KIND_SET = new Set(PAID_CONFIRMATION_KINDS);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SEND_AUTHORIZATION_ID_PATTERN = /^send-[a-f0-9]{32}$/;
const CLIENT_JOB_ID = /^job-[A-Za-z0-9_-]{1,190}$/;
const MAX_BINDING_BYTES = 64 * 1024;
const CORE007_CONSENT_VERSION = 'CORE-007-DATA-BOUNDARY-V1';
const JSON_ROUTE_FIELDS = Object.freeze({
  '/api/agent/plans': Object.freeze(['prompt', 'imageProviderId', 'videoProviderId', 'creationMode', 'selectedCanvasObjectCount', 'targetCanvasObjectId', 'targetBinding', 'referenceKind', 'consentVersion']),
  '/api/agent/image-jobs': Object.freeze(['prompt', 'clientJobId', 'size', 'quality', 'n']),
  '/api/agent/image-edit-jobs': Object.freeze(['prompt', 'clientJobId', 'size', 'quality', 'n']),
});
const MULTIPART_BINDING_FIELDS = Object.freeze(['prompt', 'clientJobId', 'consentVersion', 'fileSha256', 'fileSize', 'mimeType']);
const VIDEO_MULTIPART_BINDING_FIELDS = Object.freeze(['prompt', 'clientJobId', 'sourceObjectId', 'sourceAssetId', 'sourceVersionId', 'fileSha256', 'fileSize', 'mimeType']);

export class PaidConfirmationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PaidConfirmationError';
    this.status = status;
    this.code = code;
    this.retryable = false;
  }
}

/**
 * Short-lived, process-local confirmation tickets. Raw tickets are returned
 * once to the same-origin browser; only their SHA-256 digests and the digest
 * of the exact authorized request remain in memory. A ticket is removed
 * before its class or request digest is checked so concurrent, replayed,
 * wrong-class, cross-route, and mutated submissions all fail closed.
 */
export const createPaidConfirmationStore = ({
  now = () => Date.now(),
  createToken = () => randomBytes(32).toString('base64url'),
  ttlMs = PAID_CONFIRMATION_TTL_MS,
  maxOutstanding = 128,
  maxSendAuthorizations = 4_096,
} = {}) => {
  if (typeof now !== 'function' || typeof createToken !== 'function') throw new TypeError('Paid confirmation clock and token source are required.');
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 5 * 60_000) throw new TypeError('Paid confirmation TTL is invalid.');
  if (!Number.isInteger(maxOutstanding) || maxOutstanding < 1 || maxOutstanding > 1_024) throw new TypeError('Paid confirmation capacity is invalid.');
  if (!Number.isInteger(maxSendAuthorizations) || maxSendAuthorizations < maxOutstanding || maxSendAuthorizations > 65_536) throw new TypeError('Send authorization capacity is invalid.');

  const active = new Map();
  const activeRequests = new Map();
  const tombstones = new Map();
  const sendAuthorizations = new Map();

  const cleanup = (time) => {
    for (const [digest, entry] of active) {
      if (entry.expiresAtMs <= time) {
        active.delete(digest);
        if (activeRequests.get(entry.requestDigest) === digest) activeRequests.delete(entry.requestDigest);
        tombstones.set(digest, Object.freeze({ state: 'expired', removeAtMs: entry.expiresAtMs + ttlMs }));
      }
    }
    for (const [digest, entry] of tombstones) if (entry.removeAtMs <= time) tombstones.delete(digest);
  };

  const issue = ({ authorizationId, kind, requestDigest, request, chain } = {}) => {
    assertSendAuthorizationId(authorizationId);
    assertKind(kind);
    assertRequestDigest(requestDigest);
    const normalizedRequest = normalizeIssuedRequest(kind, request, requestDigest);
    const issuedAtMs = requireNow(now());
    cleanup(issuedAtMs);
    if (active.size >= maxOutstanding) {
      throw new PaidConfirmationError(429, 'PAID_CONFIRMATION_CAPACITY_REACHED', '待确认的付费操作过多，请稍后重试。');
    }
    if (activeRequests.has(requestDigest)) {
      throw new PaidConfirmationError(409, 'PAID_CONFIRMATION_ALREADY_ISSUED', '该付费请求已有待使用的确认，请勿重复签发。');
    }
    let sendAuthorization = sendAuthorizations.get(authorizationId);
    if (sendAuthorization?.kinds.has(kind)) {
      throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_KIND_ALREADY_USED', '同一次发送不得重复调用同类付费服务。');
    }
    if (!sendAuthorization && sendAuthorizations.size >= maxSendAuthorizations) {
      throw new PaidConfirmationError(429, 'SEND_AUTHORIZATION_CAPACITY_REACHED', '本机发送授权记录已达到安全上限，请重启本地服务后继续。');
    }
    if (kind === 'planner') {
      if (sendAuthorization) throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_SEQUENCE_INVALID', '同一次发送必须从 Planner 开始。');
      sendAuthorization = createPlannerAuthorizationRecord(normalizedRequest);
    } else {
      assertGenerationChain(sendAuthorization, normalizedRequest, chain, kind);
    }
    const token = createToken();
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TypeError('Paid confirmation token source returned an invalid token.');
    const digest = sha256(token);
    if (active.has(digest) || tombstones.has(digest)) throw new TypeError('Paid confirmation token source returned a duplicate token.');
    const expiresAtMs = issuedAtMs + ttlMs;
    active.set(digest, Object.freeze({ authorizationId, kind, requestDigest, expiresAtMs }));
    activeRequests.set(requestDigest, digest);
    const kinds = new Set(sendAuthorization.kinds);
    kinds.add(kind);
    sendAuthorization.kinds = kinds;
    if (kind !== 'planner') sendAuthorization.phase = `${kind.toUpperCase()}_ISSUED`;
    sendAuthorizations.set(authorizationId, sendAuthorization);
    return Object.freeze({ token, authorizationId, kind, requestDigest, expiresAt: new Date(expiresAtMs).toISOString() });
  };

  const consume = ({ token, kind, requestDigest } = {}) => {
    assertKind(kind);
    assertRequestDigest(requestDigest);
    const consumedAtMs = requireNow(now());
    cleanup(consumedAtMs);
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw new PaidConfirmationError(428, 'PAID_CONFIRMATION_REQUIRED', '此付费操作需要一次新的明确确认。');
    }
    const digest = sha256(token);
    const tombstone = tombstones.get(digest);
    if (tombstone?.state === 'consumed') {
      throw new PaidConfirmationError(409, 'PAID_CONFIRMATION_REPLAYED', '该付费确认已使用，不能重放。');
    }
    if (tombstone?.state === 'expired') {
      throw new PaidConfirmationError(410, 'PAID_CONFIRMATION_EXPIRED', '该发送授权凭证已过期，请重新发送。');
    }
    const entry = active.get(digest);
    if (!entry) throw new PaidConfirmationError(428, 'PAID_CONFIRMATION_REQUIRED', '此付费操作需要一次新的明确确认。');

    // Delete first: JavaScript's synchronous section makes consumption atomic
    // within this process, and no rejected class/expiry can reuse the ticket.
    active.delete(digest);
    if (activeRequests.get(entry.requestDigest) === digest) activeRequests.delete(entry.requestDigest);
    tombstones.set(digest, Object.freeze({ state: 'consumed', removeAtMs: entry.expiresAtMs + ttlMs }));
    if (consumedAtMs >= entry.expiresAtMs) {
      throw new PaidConfirmationError(410, 'PAID_CONFIRMATION_EXPIRED', '该发送授权凭证已过期，请重新发送。');
    }
    if (entry.kind !== kind) {
      throw new PaidConfirmationError(409, 'PAID_CONFIRMATION_KIND_MISMATCH', '该付费确认不适用于当前操作。');
    }
    if (entry.requestDigest !== requestDigest) {
      throw new PaidConfirmationError(409, 'PAID_CONFIRMATION_REQUEST_MISMATCH', '该付费确认不适用于当前请求内容。');
    }
    const authorization = sendAuthorizations.get(entry.authorizationId);
    if (!authorization) throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_MISSING', '发送授权状态不存在。');
    authorization.consumedKinds.add(kind);
    authorization.phase = kind === 'planner' ? 'PLANNER_CONSUMED' : `${kind.toUpperCase()}_CONSUMED`;
    return Object.freeze({ authorizationId: entry.authorizationId, kind, requestDigest, ...(authorization.milestone === 'CORE009' ? { milestone: 'CORE009' } : {}), consumedAt: new Date(consumedAtMs).toISOString() });
  };

  const bindPlannerResult = ({ authorizationId, plannerRequestDigest, plannerInput, result } = {}) => {
    assertSendAuthorizationId(authorizationId);
    assertRequestDigest(plannerRequestDigest);
    const authorization = sendAuthorizations.get(authorizationId);
    if (!authorization || authorization.plannerRequestDigest !== plannerRequestDigest || !authorization.consumedKinds.has('planner')) {
      throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_PLANNER_NOT_CONSUMED', '图片调用前必须完成同一次发送的 Planner 请求。');
    }
    if (authorization.plannerResult) throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_PLAN_ALREADY_BOUND', '同一次发送不得替换 Planner 结果。');
    const plannerRequest = normalizeIssuedRequest('planner', { route: '/api/agent/plans', body: plannerInput }, plannerRequestDigest);
    if (plannerRequest.targetBindingSha256 !== authorization.targetBindingSha256 || plannerRequest.promptSha256 !== authorization.promptSha256) {
      throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_PLANNER_REQUEST_MISMATCH', 'Planner 请求与原发送授权不一致。');
    }
    const plannerResult = normalizePlannerResultBinding(plannerRequest, result);
    authorization.plannerResult = plannerResult;
    authorization.expectedGenerationKind = plannerResult.expectedGenerationKind;
    authorization.expectedGenerationRoute = plannerResult.expectedGenerationRoute;
    authorization.phase = 'PLANNER_RESULT_BOUND';
    return Object.freeze({ authorizationId, chainSha256: plannerResult.chainSha256 });
  };

  return Object.freeze({ bindPlannerResult, consume, issue });
};

const assertKind = (kind) => {
  if (!KIND_SET.has(kind)) throw new PaidConfirmationError(400, 'PAID_CONFIRMATION_KIND_INVALID', '付费确认类型无效。');
};

const assertSendAuthorizationId = (value) => {
  if (typeof value !== 'string' || !SEND_AUTHORIZATION_ID_PATTERN.test(value)) {
    throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_ID_INVALID', '发送授权标识无效。');
  }
};

const assertRequestDigest = (value) => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new PaidConfirmationError(400, 'PAID_CONFIRMATION_DIGEST_INVALID', '付费确认请求摘要无效。');
  }
};

const requireNow = (value) => {
  if (!Number.isFinite(value)) throw new TypeError('Paid confirmation clock returned an invalid time.');
  return value;
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Build a stable, domain-separated digest for one paid request. The caller
 * supplies either the exact JSON body which will be posted, or the semantic
 * multipart descriptor returned by createUserReferenceRequestBinding().
 * Raw prompts and file bytes are never retained by the confirmation store.
 */
export const createPaidRequestDigest = ({ kind, route, body } = {}) => {
  assertKind(kind);
  if (typeof route !== 'string' || PAID_CONFIRMATION_ROUTES[route] !== kind) {
    throw new PaidConfirmationError(400, 'PAID_CONFIRMATION_ROUTE_INVALID', '付费确认路由与类型不匹配。');
  }
  const normalizedBody = normalizeRouteBody(route, body);
  const canonical = stableJson({ version: 1, kind, method: 'POST', route, body: normalizedBody });
  if (Buffer.byteLength(canonical, 'utf8') > MAX_BINDING_BYTES) {
    throw new PaidConfirmationError(413, 'PAID_CONFIRMATION_BINDING_TOO_LARGE', '付费确认请求描述过大。');
  }
  return sha256(`ELYRA_PAID_CONFIRMATION_REQUEST_V1\n${canonical}`);
};

const normalizeIssuedRequest = (kind, request, requestDigest) => {
  if (!isPlainRecord(request) || typeof request.route !== 'string' || PAID_CONFIRMATION_ROUTES[request.route] !== kind) throw invalidBinding();
  const body = normalizeRouteBody(request.route, request.body);
  const recomputed = createPaidRequestDigest({ kind, route: request.route, body });
  if (recomputed !== requestDigest) throw new PaidConfirmationError(409, 'PAID_CONFIRMATION_DIGEST_MISMATCH', '发送授权请求摘要不一致。');
  if (kind === 'planner') {
    if (request.route !== '/api/agent/plans' || typeof body.prompt !== 'string' || !body.prompt.trim() || typeof body.imageProviderId !== 'string') throw invalidBinding();
    const targetObjectId = typeof body.targetCanvasObjectId === 'string' ? body.targetCanvasObjectId : undefined;
    const targetBinding = normalizeTargetBinding(body.targetBinding, targetObjectId);
    const referenceKind = targetObjectId ? body.referenceKind ?? 'fixed-demo' : undefined;
    if (referenceKind !== undefined && !['fixed-demo', 'user-upload'].includes(referenceKind)) throw invalidBinding();
    if (!targetObjectId && (body.referenceKind !== undefined || body.targetBinding !== undefined)) throw invalidBinding();
    if (referenceKind === 'user-upload' && body.consentVersion !== CORE007_CONSENT_VERSION) throw invalidBinding();
    const core009 = body.creationMode !== undefined;
    const creationMode = core009 && ['agent', 'image', 'video'].includes(body.creationMode) ? body.creationMode : undefined;
    if (core009 && !creationMode) throw invalidBinding();
    const selectedCanvasObjectCount = core009 ? body.selectedCanvasObjectCount : targetObjectId ? 1 : 0;
    if (!Number.isInteger(selectedCanvasObjectCount) || selectedCanvasObjectCount < 0 || selectedCanvasObjectCount > 100) throw invalidBinding();
    if ((selectedCanvasObjectCount === 1) !== Boolean(targetObjectId)) throw invalidBinding();
    if (creationMode === 'image' && selectedCanvasObjectCount > 1) throw invalidBinding();
    if (creationMode === 'video' && (selectedCanvasObjectCount !== 1 || body.videoProviderId !== 'evolink-sora-2-preview' || referenceKind !== 'user-upload')) throw invalidBinding();
    if (core009 && body.videoProviderId !== 'evolink-sora-2-preview') throw invalidBinding();
    const operation = creationMode === 'agent'
      ? 'route_by_intent'
      : creationMode === 'video'
        ? 'video_image_to_video'
        : targetObjectId
          ? referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference'
          : 'image_generate';
    return Object.freeze({
      route: request.route,
      body,
      operation,
      milestone: core009 ? 'CORE009' : 'CORE008',
      creationMode,
      selectedCanvasObjectCount,
      promptSha256: sha256(body.prompt.trim()),
      targetBindingSha256: targetBinding ? sha256(stableJson(targetBinding)) : null,
    });
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw invalidBinding();
  return Object.freeze({ route: request.route, body, promptSha256: sha256(normalizeMultipartPrompt(body.prompt)) });
};

const createPlannerAuthorizationRecord = (request) => ({
  phase: 'PLANNER_ISSUED',
  kinds: new Set(),
  consumedKinds: new Set(),
  plannerRequestDigest: createPaidRequestDigest({ kind: 'planner', route: request.route, body: request.body }),
  promptSha256: request.promptSha256,
  targetBindingSha256: request.targetBindingSha256,
  operation: request.operation,
  milestone: request.milestone,
  creationMode: request.creationMode,
  selectedCanvasObjectCount: request.selectedCanvasObjectCount,
  expectedGenerationKind: null,
  expectedGenerationRoute: null,
  plannerResult: null,
});

const assertGenerationChain = (authorization, generationRequest, chain, kind) => {
  if (!authorization || authorization.phase !== 'PLANNER_RESULT_BOUND' || !authorization.consumedKinds.has('planner') || !authorization.plannerResult) {
    throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_PLAN_NOT_BOUND', '生成调用前必须完成同一次发送的 Planner 结果绑定。');
  }
  if (!isPlainRecord(chain) || !hasExactKeys(chain, ['intentId', 'planId', 'operation', 'providerId', 'targetBinding'])) {
    throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_CHAIN_INVALID', '生成调用缺少有效的 Planner 链声明。');
  }
  const targetBinding = normalizeTargetBinding(chain.targetBinding, authorization.plannerResult.targetObjectId, true);
  const normalizedChain = {
    intentId: requireChainIdentifier(chain.intentId),
    operation: chain.operation,
    planId: requireChainIdentifier(chain.planId),
    providerId: chain.providerId,
    targetBinding,
  };
  const chainSha256 = sha256(stableJson(normalizedChain));
  if (
    chainSha256 !== authorization.plannerResult.chainSha256
    || kind !== authorization.expectedGenerationKind
    || generationRequest.route !== authorization.expectedGenerationRoute
    || generationRequest.promptSha256 !== authorization.plannerResult.executionPromptSha256
    || (kind === 'video' && !videoSourceMatchesTarget(generationRequest.body, targetBinding))
  ) throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_CHAIN_MISMATCH', '生成请求与同一次发送的 Planner 结果或目标不一致。');
};

const normalizePlannerResultBinding = (request, result) => {
  if (!isPlainRecord(result) || !isPlainRecord(result.intent) || !isPlainRecord(result.plan)) {
    throw new PaidConfirmationError(502, 'SEND_AUTHORIZATION_PLAN_RESULT_INVALID', 'Planner 未返回可绑定的结构化结果。');
  }
  const { intent, plan } = result;
  const intentId = requireChainIdentifier(intent.id);
  const planId = requireChainIdentifier(plan.id);
  const targetObjectId = typeof request.body.targetCanvasObjectId === 'string' ? request.body.targetCanvasObjectId : undefined;
  const operation = intent.operation;
  const expectedOperation = request.operation;
  const allowedOperation = expectedOperation === 'route_by_intent'
    ? allowedAgentOperation(operation, request.selectedCanvasObjectCount, request.body.referenceKind)
    : operation === expectedOperation;
  const expectedProviderId = operation === 'video_image_to_video'
    ? request.body.videoProviderId
    : operation === 'clarify'
      ? 'none'
      : request.body.imageProviderId;
  if (
    !allowedOperation
    || plan.operation !== operation
    || plan.intentId !== intentId
    || plan.providerId !== expectedProviderId
    || intent.prompt?.trim() !== request.body.prompt.trim()
    || (targetObjectId ? intent.targetCanvasObjectId !== targetObjectId : intent.targetCanvasObjectId !== undefined)
  ) throw new PaidConfirmationError(409, 'SEND_AUTHORIZATION_PLAN_RESULT_MISMATCH', 'Planner 结果与本次发送的请求或目标不一致。');
  const targetBinding = normalizeTargetBinding(request.body.targetBinding, targetObjectId);
  const chain = { intentId, operation: intent.operation, planId, providerId: plan.providerId, targetBinding };
  const executionPrompt = composeExecutionPrompt(intent, plan);
  const expectedGenerationKind = operation === 'video_image_to_video' ? 'video' : operation === 'clarify' ? null : 'image';
  const expectedGenerationRoute = operation === 'video_image_to_video'
    ? '/api/agent/video-jobs'
    : operation === 'image_generate'
      ? '/api/agent/image-jobs'
      : operation === 'image_edit_user_reference'
        ? '/api/agent/user-reference-image-jobs'
        : operation === 'image_edit_fixed_demo_reference'
          ? '/api/agent/image-edit-jobs'
          : null;
  return Object.freeze({
    chainSha256: sha256(stableJson(chain)),
    executionPromptSha256: sha256(normalizeMultipartPrompt(executionPrompt)),
    intentId,
    operation: intent.operation,
    planId,
    providerId: plan.providerId,
    targetObjectId,
    expectedGenerationKind,
    expectedGenerationRoute,
    resultSha256: sha256(stableJson({ chain, executionPromptSha256: sha256(normalizeMultipartPrompt(executionPrompt)) })),
  });
};

const composeExecutionPrompt = (intent, plan) => {
  if (
    typeof intent.normalizedPrompt !== 'string'
    || typeof plan.summary !== 'string'
    || !isPlainRecord(plan.visualDirection)
    || !Array.isArray(plan.constraints)
    || !Array.isArray(plan.bullets)
  ) throw new PaidConfirmationError(502, 'SEND_AUTHORIZATION_PLAN_RESULT_INVALID', 'Planner 结果缺少执行提示词字段。');
  const direction = plan.visualDirection;
  for (const value of [direction.subject, direction.style, direction.lighting, direction.composition]) {
    if (typeof value !== 'string' || !value.trim()) throw new PaidConfirmationError(502, 'SEND_AUTHORIZATION_PLAN_RESULT_INVALID', 'Planner 结果的视觉方向无效。');
  }
  if (plan.constraints.some((item) => typeof item !== 'string') || plan.bullets.some((item) => typeof item !== 'string')) throw new PaidConfirmationError(502, 'SEND_AUTHORIZATION_PLAN_RESULT_INVALID', 'Planner 结果的步骤或约束无效。');
  return [
    intent.normalizedPrompt.trim(),
    `规划摘要：${plan.summary.trim()}`,
    `视觉方向：主体=${direction.subject.trim()}；风格=${direction.style.trim()}；光线=${direction.lighting.trim()}；构图=${direction.composition.trim()}`,
    `约束：${plan.constraints.map((item) => item.trim()).filter(Boolean).join('；')}`,
    `执行步骤：${plan.bullets.map((item) => item.trim()).filter(Boolean).join('；')}`,
  ].join('\n');
};

const normalizeTargetBinding = (value, requiredObjectId, allowNull = false) => {
  if (!requiredObjectId) {
    if (value === undefined || value === null) return null;
    throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_TARGET_INVALID', '文生图发送不得绑定画布目标。');
  }
  if (value === null && allowNull) throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_TARGET_INVALID', '编辑发送必须绑定画布目标。');
  if (!isPlainRecord(value)) throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_TARGET_INVALID', '编辑发送缺少画布目标绑定。');
  const allowedKeys = Object.hasOwn(value, 'assetId') ? ['objectId', 'versionId', 'assetId'] : ['objectId', 'versionId'];
  if (!hasExactKeys(value, allowedKeys) || value.objectId !== requiredObjectId) throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_TARGET_INVALID', '画布目标绑定字段无效。');
  for (const key of allowedKeys) if (typeof value[key] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value[key])) throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_TARGET_INVALID', '画布目标绑定标识无效。');
  return Object.freeze(Object.fromEntries(allowedKeys.map((key) => [key, value[key]])));
};

const requireChainIdentifier = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new PaidConfirmationError(400, 'SEND_AUTHORIZATION_CHAIN_INVALID', 'Planner 链标识无效。');
  return value;
};

export const createUserReferenceRequestBinding = ({ prompt, clientJobId, consentVersion, buffer, mimeType = 'image/png' } = {}) => {
  if (!Buffer.isBuffer(buffer)) throw new PaidConfirmationError(400, 'PAID_CONFIRMATION_FILE_INVALID', '参考图确认缺少文件内容。');
  return Object.freeze({
    prompt: normalizeMultipartPrompt(prompt),
    clientJobId,
    consentVersion,
    fileSha256: sha256(buffer),
    fileSize: buffer.length,
    mimeType,
  });
};

export const createVideoRequestBinding = ({ prompt, clientJobId, sourceObjectId, sourceAssetId, sourceVersionId, buffer, mimeType = 'image/png' } = {}) => {
  if (!Buffer.isBuffer(buffer)) throw new PaidConfirmationError(400, 'PAID_CONFIRMATION_FILE_INVALID', '视频参考图确认缺少文件内容。');
  return Object.freeze({
    prompt: normalizeMultipartPrompt(prompt),
    clientJobId,
    sourceObjectId,
    sourceAssetId,
    sourceVersionId,
    fileSha256: sha256(buffer),
    fileSize: buffer.length,
    mimeType,
  });
};

const normalizeRouteBody = (route, body) => {
  if (!isPlainRecord(body)) throw invalidBinding();
  if (route === '/api/agent/user-reference-image-jobs') return normalizeMultipartBinding(body);
  if (route === '/api/agent/video-jobs') return normalizeVideoMultipartBinding(body);
  const allowed = JSON_ROUTE_FIELDS[route];
  if (!allowed) throw invalidBinding();
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.includes(key))) throw invalidBinding();
  const normalized = {};
  for (const key of keys.sort()) normalized[key] = normalizeJsonValue(body[key]);
  return normalized;
};

const normalizeVideoMultipartBinding = (body) => {
  if (!hasExactKeys(body, VIDEO_MULTIPART_BINDING_FIELDS)) throw invalidBinding();
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32_000) throw invalidBinding();
  if (typeof body.clientJobId !== 'string' || !CLIENT_JOB_ID.test(body.clientJobId)) throw invalidBinding();
  for (const key of ['sourceObjectId', 'sourceAssetId', 'sourceVersionId']) {
    if (typeof body[key] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body[key])) throw invalidBinding();
  }
  if (typeof body.fileSha256 !== 'string' || !DIGEST_PATTERN.test(body.fileSha256)) throw invalidBinding();
  if (!Number.isInteger(body.fileSize) || body.fileSize < 1 || body.fileSize > 10 * 1024 * 1024) throw invalidBinding();
  if (body.mimeType !== 'image/png') throw invalidBinding();
  return Object.fromEntries(VIDEO_MULTIPART_BINDING_FIELDS.slice().sort().map((key) => [key, key === 'prompt' ? normalizeMultipartPrompt(body.prompt) : body[key]]));
};

const videoSourceMatchesTarget = (body, targetBinding) => Boolean(targetBinding)
  && body.sourceObjectId === targetBinding.objectId
  && body.sourceVersionId === targetBinding.versionId
  && body.sourceAssetId === targetBinding.assetId;

const allowedAgentOperation = (operation, selectedCount, referenceKind) => {
  if (operation === 'clarify') return true;
  if (selectedCount === 0) return operation === 'image_generate';
  if (selectedCount !== 1) return false;
  if (referenceKind === 'user-upload') return operation === 'video_image_to_video' || operation === 'image_edit_user_reference';
  return operation === 'image_edit_fixed_demo_reference';
};

const normalizeMultipartBinding = (body) => {
  if (!hasExactKeys(body, MULTIPART_BINDING_FIELDS)) throw invalidBinding();
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 32_000) throw invalidBinding();
  if (typeof body.clientJobId !== 'string' || !CLIENT_JOB_ID.test(body.clientJobId)) throw invalidBinding();
  if (body.consentVersion !== CORE007_CONSENT_VERSION) throw invalidBinding();
  if (typeof body.fileSha256 !== 'string' || !DIGEST_PATTERN.test(body.fileSha256)) throw invalidBinding();
  if (!Number.isInteger(body.fileSize) || body.fileSize < 1 || body.fileSize > 10 * 1024 * 1024) throw invalidBinding();
  if (body.mimeType !== 'image/png') throw invalidBinding();
  return Object.fromEntries(MULTIPART_BINDING_FIELDS.slice().sort().map((key) => [key, key === 'prompt' ? normalizeMultipartPrompt(body.prompt) : body[key]]));
};

const normalizeMultipartPrompt = (value) => typeof value === 'string' ? value.trim().replace(/\r\n?/g, '\n') : value;

const normalizeJsonValue = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (isPlainRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJsonValue(value[key])]));
  throw invalidBinding();
};

const stableJson = (value) => JSON.stringify(normalizeJsonValue(value));
const isPlainRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hasExactKeys = (value, keys) => Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const invalidBinding = () => new PaidConfirmationError(400, 'PAID_CONFIRMATION_BINDING_INVALID', '付费确认请求描述无效。');
