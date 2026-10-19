export type PaidConfirmationKind = 'planner' | 'image' | 'video';
export type PaidConfirmationRoute =
  | '/api/agent/plans'
  | '/api/agent/image-jobs'
  | '/api/agent/image-edit-jobs'
  | '/api/agent/user-reference-image-jobs'
  | '/api/agent/video-jobs';

export interface PaidConfirmationBinding {
  route: PaidConfirmationRoute;
  body: Record<string, unknown>;
}

export interface PaidGenerationChainBinding {
  intentId: string;
  planId: string;
  operation: 'image_generate' | 'image_edit_fixed_demo_reference' | 'image_edit_user_reference' | 'video_image_to_video';
  providerId: string;
  targetBinding: { objectId: string; versionId: string; assetId?: string } | null;
}

export type PaidImageChainBinding = PaidGenerationChainBinding;

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const SEND_AUTHORIZATION_ID = /^send-[a-f0-9]{32}$/;
const CORE008_LOCAL_API_PROTOCOL = 'ELYRA_CORE008_LOCAL_API';
const CORE008_LOCAL_API_PROTOCOL_VERSION = 1;
const CORE008_LOCAL_API_CAPABILITIES = [
  'core008-budget-v1',
  'paid-confirmation-v1',
  'planner-send-authorization-v1',
] as const;
const CORE008_CAPABILITIES_ENDPOINT = '/api/agent/core-008-capabilities';
const CORE009_LOCAL_API_PROTOCOL = 'ELYRA_CORE009_LOCAL_API';
const CORE009_LOCAL_API_PROTOCOL_VERSION = 1;
const CORE009_LOCAL_API_CAPABILITIES = [
  'core009-budget-v1',
  'paid-confirmation-video-v1',
  'planner-three-mode-routing-v1',
  'sora2-image-to-video-v1',
  'localhost-video-assets-v1',
  'soft-cancel-v1',
] as const;
const CORE009_CAPABILITIES_ENDPOINT = '/api/agent/core-009-capabilities';

export class PaidConfirmationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PaidConfirmationError';
  }
}

export type PlannerCredentialFailure = {
  code: 'CORE008_PROTOCOL_MISMATCH' | 'CORE008_LOCAL_SERVICE_UNAVAILABLE' | 'CORE008_TICKET_ISSUE_FAILED' | 'CORE009_PROTOCOL_MISMATCH' | 'CORE009_LOCAL_SERVICE_UNAVAILABLE' | 'CORE009_TICKET_ISSUE_FAILED';
  message: string;
  retryable: true;
};

/**
 * Verifies that the localhost server understands the exact request-bound
 * CORE-008 ticket protocol before the browser asks it to mint a capability.
 * This endpoint is read-only and never reads a Provider key or spends budget.
 */
export const assertCore008LocalApiProtocol = async (
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> => {
  let response: Response;
  try {
    response = await fetchImpl(CORE008_CAPABILITIES_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new PaidConfirmationError('CORE008_LOCAL_SERVICE_UNAVAILABLE', '无法连接当前版本的本机 Agent 服务；未签发凭证，也未调用 Planner。');
  }

  if (response.status >= 500) {
    throw new PaidConfirmationError('CORE008_LOCAL_SERVICE_UNAVAILABLE', '本机 Agent 服务暂时不可用；未签发凭证，也未调用 Planner。');
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isCore008ProtocolEnvelope(body)) {
    throw new PaidConfirmationError('CORE008_PROTOCOL_MISMATCH', '页面与本机 Agent 服务版本不一致，请重启本机服务并刷新页面；未签发凭证，也未调用 Planner。');
  }
};

export const requestCore008PlannerConfirmation = async (
  request: PaidConfirmationBinding,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  sendAuthorizationId?: string,
): Promise<string> => {
  await assertCore008LocalApiProtocol(fetchImpl, signal);
  return requestPaidConfirmation('planner', request, fetchImpl, signal, sendAuthorizationId);
};

/** Verifies the exact three-mode localhost API before any CORE-009 ticket is minted. */
export const assertCore009LocalApiProtocol = async (
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<void> => {
  let response: Response;
  try {
    response = await fetchImpl(CORE009_CAPABILITIES_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new PaidConfirmationError('CORE009_LOCAL_SERVICE_UNAVAILABLE', '无法连接当前版本的本机三模式服务；未签发凭证，也未调用 Provider。');
  }
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isCore009ProtocolEnvelope(body)) {
    throw new PaidConfirmationError('CORE009_PROTOCOL_MISMATCH', '页面与本机三模式服务版本不一致，请重启本机服务并刷新页面；未调用 Provider。');
  }
};

export const requestCore009PlannerConfirmation = async (
  request: PaidConfirmationBinding,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  sendAuthorizationId?: string,
): Promise<string> => {
  await assertCore009LocalApiProtocol(fetchImpl, signal);
  return requestPaidConfirmation('planner', request, fetchImpl, signal, sendAuthorizationId);
};

export const mapPlannerCredentialFailure = (error: unknown): PlannerCredentialFailure => {
  if (error instanceof PaidConfirmationError && error.code === 'CORE009_PROTOCOL_MISMATCH') {
    return { code: error.code, message: error.message, retryable: true };
  }
  if (error instanceof PaidConfirmationError && error.code === 'CORE009_LOCAL_SERVICE_UNAVAILABLE') {
    return { code: error.code, message: error.message, retryable: true };
  }
  if (error instanceof PaidConfirmationError && error.code === 'CORE008_PROTOCOL_MISMATCH') {
    return { code: error.code, message: error.message, retryable: true };
  }
  if (error instanceof PaidConfirmationError && error.code === 'CORE008_LOCAL_SERVICE_UNAVAILABLE') {
    return { code: error.code, message: error.message, retryable: true };
  }
  return {
    code: 'CORE008_TICKET_ISSUE_FAILED',
    message: '本机 Agent 服务未能签发本次发送的一次性 Planner 凭证；未调用 Planner。',
    retryable: true,
  };
};

/**
 * Requests one short-lived, single-use server capability bound to the user's
 * current Send gesture. The token remains in memory only and is never added to
 * Workspace, localStorage, evidence or a Provider payload.
 */
export const requestPaidConfirmation = async (
  kind: PaidConfirmationKind,
  request: PaidConfirmationBinding,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  sendAuthorizationId?: string,
  generationChain?: PaidGenerationChainBinding,
): Promise<string> => {
  if (typeof sendAuthorizationId !== 'string' || !SEND_AUTHORIZATION_ID.test(sendAuthorizationId)) {
    throw new PaidConfirmationError('CORE008_SEND_AUTHORIZATION_INVALID', '本次发送授权无效，未调用付费服务。');
  }
  if ((kind === 'image' || kind === 'video') && !isPaidGenerationChainBinding(generationChain, kind)) {
    throw new PaidConfirmationError(kind === 'video' ? 'CORE009_SEND_CHAIN_INVALID' : 'CORE008_SEND_CHAIN_INVALID', '媒体调用缺少与 Intent、Plan 和画布目标绑定的发送链。');
  }
  if (kind === 'planner' && generationChain !== undefined) {
    throw new PaidConfirmationError('CORE008_SEND_CHAIN_INVALID', 'Planner 调用不得携带媒体生成链。');
  }
  const expectedDigest = await createPaidRequestDigest(kind, request);
  const response = await fetchImpl('/api/agent/paid-confirmations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorizationId: sendAuthorizationId, kind, request, ...(kind !== 'planner' ? { chain: generationChain } : {}) }),
    signal,
  });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isRecord(body)) {
    const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : 'CORE008_CONFIRMATION_ISSUE_FAILED';
    throw new PaidConfirmationError(code, '无法建立本次付费调用的一次性确认凭证。');
  }
  if (
    Object.keys(body).sort().join('|') !== ['authorizationId', 'expiresAt', 'kind', 'requestDigest', 'token'].sort().join('|')
    || body.authorizationId !== sendAuthorizationId
    || body.kind !== kind
    || body.requestDigest !== expectedDigest
    || typeof body.token !== 'string'
    || !TOKEN.test(body.token)
    || typeof body.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(body.expiresAt))
    || Date.parse(body.expiresAt) <= Date.now()
  ) throw new PaidConfirmationError('CORE008_CONFIRMATION_INVALID', '本次付费调用的确认凭证无效。');
  return body.token;
};

const isPaidGenerationChainBinding = (value: unknown, kind: Extract<PaidConfirmationKind, 'image' | 'video'>): value is PaidGenerationChainBinding => {
  const operations = kind === 'video'
    ? ['video_image_to_video']
    : ['image_generate', 'image_edit_fixed_demo_reference', 'image_edit_user_reference'];
  if (!isRecord(value) || !operations.includes(String(value.operation))) return false;
  if (![value.intentId, value.planId, value.providerId].every((item) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(item))) return false;
  if (value.targetBinding === null) return value.operation === 'image_generate';
  if (!isRecord(value.targetBinding) || value.operation === 'image_generate') return false;
  const target = value.targetBinding;
  const keys = Object.hasOwn(target, 'assetId') ? ['assetId', 'objectId', 'versionId'] : ['objectId', 'versionId'];
  return Object.keys(target).sort().join('|') === keys.sort().join('|')
    && [target.objectId, target.versionId, target.assetId].filter((item) => item !== undefined).every((item) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(item));
};

const isCore008ProtocolEnvelope = (value: unknown): boolean => isRecord(value)
  && Object.keys(value).sort().join('|') === ['capabilities', 'protocol', 'protocolVersion'].sort().join('|')
  && value.protocol === CORE008_LOCAL_API_PROTOCOL
  && value.protocolVersion === CORE008_LOCAL_API_PROTOCOL_VERSION
  && Array.isArray(value.capabilities)
  && value.capabilities.length === CORE008_LOCAL_API_CAPABILITIES.length
  && CORE008_LOCAL_API_CAPABILITIES.every((capability, index) => value.capabilities?.[index] === capability);

const isCore009ProtocolEnvelope = (value: unknown): boolean => isRecord(value)
  && Object.keys(value).sort().join('|') === ['capabilities', 'protocol', 'protocolVersion'].sort().join('|')
  && value.protocol === CORE009_LOCAL_API_PROTOCOL
  && value.protocolVersion === CORE009_LOCAL_API_PROTOCOL_VERSION
  && Array.isArray(value.capabilities)
  && value.capabilities.length === CORE009_LOCAL_API_CAPABILITIES.length
  && CORE009_LOCAL_API_CAPABILITIES.every((capability, index) => value.capabilities?.[index] === capability);

export const isPaidConfirmationToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

export const createUserReferencePaidBinding = async ({
  prompt,
  clientJobId,
  blob,
}: {
  prompt: string;
  clientJobId: string;
  blob: Blob;
}): Promise<PaidConfirmationBinding> => ({
  route: '/api/agent/user-reference-image-jobs',
  body: {
    prompt: normalizeMultipartPrompt(prompt),
    clientJobId,
    consentVersion: 'CORE-007-DATA-BOUNDARY-V1',
    fileSha256: await sha256(await blob.arrayBuffer()),
    fileSize: blob.size,
    mimeType: blob.type,
  },
});

export const createVideoPaidBinding = async ({
  prompt,
  clientJobId,
  sourceObjectId,
  sourceAssetId,
  sourceVersionId,
  blob,
}: {
  prompt: string;
  clientJobId: string;
  sourceObjectId: string;
  sourceAssetId: string;
  sourceVersionId: string;
  blob: Blob;
}): Promise<PaidConfirmationBinding> => ({
  route: '/api/agent/video-jobs',
  body: {
    prompt: normalizeMultipartPrompt(prompt),
    clientJobId,
    sourceObjectId,
    sourceAssetId,
    sourceVersionId,
    fileSha256: await sha256(await blob.arrayBuffer()),
    fileSize: blob.size,
    mimeType: blob.type,
  },
});

const normalizeMultipartPrompt = (value: string): string => value.trim().replace(/\r\n?/g, '\n');

export const createPaidRequestDigest = async (kind: PaidConfirmationKind, request: PaidConfirmationBinding): Promise<string> => {
  const body = normalizePaidRequestBody(request);
  const canonical = stableJson({ version: 1, kind, method: 'POST', route: request.route, body });
  return sha256(new TextEncoder().encode(`ELYRA_PAID_CONFIRMATION_REQUEST_V1\n${canonical}`));
};

const normalizePaidRequestBody = (request: PaidConfirmationBinding): Record<string, unknown> => {
  if (request.route === '/api/agent/plans') {
    const allowed = [
      'prompt', 'imageProviderId', 'videoProviderId', 'creationMode', 'selectedCanvasObjectCount',
      'targetCanvasObjectId', 'targetBinding', 'referenceKind', 'consentVersion',
    ];
    return Object.fromEntries(allowed.flatMap((key) => request.body[key] === undefined ? [] : [[key, request.body[key]]]));
  }
  if (request.route === '/api/agent/user-reference-image-jobs' || request.route === '/api/agent/video-jobs') {
    return { ...request.body, prompt: typeof request.body.prompt === 'string' ? normalizeMultipartPrompt(request.body.prompt) : request.body.prompt };
  }
  return request.body;
};

const stableJson = (value: unknown): string => JSON.stringify(normalizeJsonValue(value));
const normalizeJsonValue = (value: unknown): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : normalizeJsonValue(item));
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, normalizeJsonValue(value[key])]));
  throw new PaidConfirmationError('CORE008_CONFIRMATION_BINDING_INVALID', '本次付费调用的请求描述无效。');
};

const sha256 = async (value: ArrayBuffer | Uint8Array): Promise<string> => {
  if (!globalThis.crypto?.subtle) throw new PaidConfirmationError('CORE008_CONFIRMATION_DIGEST_UNAVAILABLE', '浏览器无法建立本次付费请求摘要。');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
