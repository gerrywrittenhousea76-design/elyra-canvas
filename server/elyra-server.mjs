import { createServer } from 'node:http';
import { createProviderSettingsStore, ProviderConfigError } from './provider-config.mjs';
import { createProviderRegistry } from './provider-registry.mjs';
import { providerPlugins } from './provider-plugins.mjs';
import { isPrivateResource } from './private-files.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { ClientInputError, EvoLinkHttpError } from './evolink.mjs';
import { CORE007_CONSENT_VERSION, PlannerError, PlannerInputError } from './planner.mjs';
import { createPlannerBudgetLedger } from './planner-budget.mjs';
import { CORE008_BUDGET_CAP_USD, Core008BudgetError, createCore008ImageGateway } from './core008-budget.mjs';
import {
  PAID_CONFIRMATION_HEADER,
  PaidConfirmationError,
  createPaidConfirmationStore,
  createPaidRequestDigest,
  createUserReferenceRequestBinding,
  createVideoRequestBinding,
} from './paid-confirmation.mjs';
import { ReferenceImageError, sanitizeBrowserReferencePng } from './reference-image.mjs';
import { ReferenceJobError, createReferenceJobService } from './reference-jobs.mjs';
import { CORE009_BUDGET_CAP_USD, Core009VideoError, createCore009VideoGateway } from './core009-video.mjs';

const DEFAULT_HOST = '127.0.0.1';
const MAX_JSON_BYTES = 40_000;
const MAX_MULTIPART_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const MAX_HTTP_HEADER_BYTES = 16 * 1024;
const MAX_PART_HEADER_BYTES = 2 * 1024;
const MAX_MULTIPART_PARTS = 4;
const MAX_VIDEO_MULTIPART_PARTS = 6;
const MULTIPART_DEADLINE_MS = 30_000;
const CLIENT_JOB_ID = /^job-[A-Za-z0-9_-]{1,190}$/;
const SAFE_UPLOAD_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.png$/;
const LEGACY_IMAGE_FIELDS = new Set(['prompt', 'clientJobId', 'size', 'quality', 'n']);
const CORE007_ROUTE_MARKERS = new Set(['operation', 'referenceKind', 'consentVersion', 'image_urls', 'imageUrls', 'referenceUrl', 'file']);
const PAID_IMAGE_SIZES = new Set(['auto', '1:1', '1:2', '2:1', '1:3', '3:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '9:21']);
const PAID_IMAGE_QUALITIES = new Set(['low', 'medium', 'high']);
const PAID_IMAGE_PROVIDERS = new Set(['deterministic-mock', 'evolink-gpt-image-2']);
const PUBLIC_IMAGE_URL = /^https:\/\/[^\s]+\.(?:png|jpe?g|webp)(?:\?[^\s]*)?$/i;

export const CORE008_LOCAL_API_PROTOCOL = Object.freeze({
  protocol: 'ELYRA_CORE008_LOCAL_API',
  protocolVersion: 1,
  capabilities: Object.freeze([
    'core008-budget-v1',
    'paid-confirmation-v1',
    'planner-send-authorization-v1',
  ]),
});

export const CORE009_LOCAL_API_PROTOCOL = Object.freeze({
  protocol: 'ELYRA_CORE009_LOCAL_API',
  protocolVersion: 1,
  capabilities: Object.freeze([
    'core009-budget-v1',
    'paid-confirmation-video-v1',
    'planner-three-mode-routing-v1',
    'sora2-image-to-video-v1',
    'localhost-video-assets-v1',
    'soft-cancel-v1',
  ]),
});

export const CORE008_BUDGET_DIRECTORY = resolve(fileURLToPath(new URL('..', import.meta.url)), '.elyra-runtime', 'core-008-budget');
export const CORE009_BUDGET_DIRECTORY = resolve(fileURLToPath(new URL('..', import.meta.url)), '.elyra-runtime', 'core-009-budget');

export const createBoundedSemaphore = ({ limit = 2, maxQueue = 4 } = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxQueue) || maxQueue < 0) throw new TypeError('Semaphore limits are invalid.');
  let active = 0;
  const queue = [];

  const release = () => {
    active -= 1;
    while (queue.length) {
      const next = queue.shift();
      if (next.signal?.aborted) {
        next.reject(new ReferenceJobError(499, 'CORE007_USER_CANCELLED', '本地请求已停止。', false));
        continue;
      }
      active += 1;
      next.resolve(release);
      return;
    }
  };

  const acquire = (signal) => {
    if (signal?.aborted) return Promise.reject(new ReferenceJobError(499, 'CORE007_USER_CANCELLED', '本地请求已停止。', false));
    if (active < limit) {
      active += 1;
      return Promise.resolve(release);
    }
    if (queue.length >= maxQueue) return Promise.reject(new ReferenceJobError(429, 'CORE007_LOCAL_CAPACITY_REACHED', '本机图片处理任务繁忙，请稍后重试。', true));
    return new Promise((resolvePromise, reject) => {
      const entry = { resolve: resolvePromise, reject, signal };
      const abort = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(new ReferenceJobError(499, 'CORE007_USER_CANCELLED', '本地请求已停止。', false));
      };
      entry.resolve = (value) => {
        signal?.removeEventListener('abort', abort);
        resolvePromise(value);
      };
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(entry);
    });
  };

  return {
    async run(operation, signal) {
      const releasePermit = await acquire(signal);
      try { return await operation(); } finally { releasePermit(); }
    },
    snapshot: () => Object.freeze({ active, queued: queue.length, limit, maxQueue }),
  };
};

export const assertCore007PlannerConsent = (input) => {
  if (input?.referenceKind === 'user-upload' && input?.consentVersion !== CORE007_CONSENT_VERSION) {
    throw new PlannerInputError('必须先确认用户参考图外传与最长 72 小时留存边界。', 'CORE007_CONSENT_REQUIRED');
  }
};

export const assertLegacyImageRouteBoundary = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ClientInputError('图片任务必须是对象。');
  const keys = Object.keys(input);
  if (input.operation === 'image_edit_user_reference' || input.referenceKind === 'user-upload' || keys.some((key) => CORE007_ROUTE_MARKERS.has(key))) {
    throw new ReferenceJobError(409, 'CORE007_DEDICATED_ROUTE_REQUIRED', '用户参考图只能通过受预算约束的 CORE-007 专用路由处理。', false);
  }
  if (keys.some((key) => !LEGACY_IMAGE_FIELDS.has(key))) throw new ClientInputError('图片任务包含未允许字段。');
};

export const parseMultipartBoundary = (request) => {
  const headerBytes = (request.rawHeaders ?? []).reduce((total, value) => total + Buffer.byteLength(String(value)) + 2, 0);
  if (headerBytes > MAX_HTTP_HEADER_BYTES) throw new ReferenceJobError(431, 'CORE007_HEADERS_TOO_LARGE', '参考图请求头过大。', false);
  const contentType = request.headers?.['content-type'];
  if (typeof contentType !== 'string' || contentType.length > 200) {
    throw new ReferenceJobError(415, 'CORE007_MULTIPART_REQUIRED', '参考图上传必须使用 multipart/form-data。', false);
  }
  const match = contentType.match(/^multipart\/form-data\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,.\/:=?-]{12,70})"|([0-9A-Za-z'()+_,.\/:=?-]{12,70}))\s*$/i);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new ReferenceJobError(400, 'CORE007_MULTIPART_BOUNDARY_INVALID', '参考图 multipart boundary 无效。', false);
  return boundary;
};

export const readReferenceMultipart = async (request, boundary, { deadlineMs = MULTIPART_DEADLINE_MS } = {}) => {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new TypeError('Multipart deadline is invalid.');
  const declaredHeader = request.headers?.['content-length'];
  if (declaredHeader !== undefined && !/^\d+$/.test(String(declaredHeader))) {
    throw new ReferenceJobError(400, 'CORE007_CONTENT_LENGTH_INVALID', '参考图请求体长度无效。', false);
  }
  const declared = declaredHeader === undefined ? NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared <= 0 || declared > MAX_MULTIPART_BYTES)) {
    throw new ReferenceJobError(413, 'CORE007_UPLOAD_TOO_LARGE', '参考图上传体积超过 10 MiB 限制。', false);
  }

  const chunks = [];
  let bytes = 0;
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    request.destroy?.();
  }, deadlineMs);
  try {
    for await (const chunk of request) {
      if (deadlineExceeded) throw new ReferenceJobError(408, 'CORE007_BODY_DEADLINE_EXCEEDED', '参考图请求体读取超时。', true);
      bytes += chunk.length;
      if (bytes > MAX_MULTIPART_BYTES) throw new ReferenceJobError(413, 'CORE007_UPLOAD_TOO_LARGE', '参考图上传体积超过 10 MiB 限制。', false);
      chunks.push(Buffer.from(chunk));
    }
    if (deadlineExceeded) throw new ReferenceJobError(408, 'CORE007_BODY_DEADLINE_EXCEEDED', '参考图请求体读取超时。', true);
  } catch (error) {
    if (deadlineExceeded) throw new ReferenceJobError(408, 'CORE007_BODY_DEADLINE_EXCEEDED', '参考图请求体读取超时。', true);
    throw error;
  } finally {
    clearTimeout(deadline);
  }

  const body = Buffer.concat(chunks);
  assertMultipartEnvelope(body, boundary, MAX_MULTIPART_PARTS);
  const envelope = new Request('http://127.0.0.1/api/agent/user-reference-image-jobs', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  let form;
  try { form = await envelope.formData(); } catch { throw new ReferenceJobError(400, 'CORE007_MULTIPART_INVALID', '参考图 multipart 请求无效。', false); }
  return validateReferenceMultipartForm(form);
};

export const validateReferenceMultipartForm = async (form) => {
  const allowed = new Set(['file', 'prompt', 'clientJobId', 'consentVersion']);
  for (const key of form.keys()) if (!allowed.has(key)) throw new ReferenceJobError(400, 'CORE007_MULTIPART_FIELD_INVALID', '参考图上传包含未允许字段。', false);
  if (form.getAll('file').length !== 1 || form.getAll('prompt').length !== 1 || form.getAll('clientJobId').length !== 1 || form.getAll('consentVersion').length !== 1) {
    throw new ReferenceJobError(400, 'CORE007_MULTIPART_CARDINALITY_INVALID', '参考图上传字段数量无效。', false);
  }
  const file = form.get('file');
  const prompt = form.get('prompt');
  const clientJobId = form.get('clientJobId');
  const consentVersion = form.get('consentVersion');
  if (!(file instanceof File) || typeof prompt !== 'string' || typeof clientJobId !== 'string' || typeof consentVersion !== 'string') {
    throw new ReferenceJobError(400, 'CORE007_MULTIPART_VALUE_INVALID', '参考图上传字段类型无效。', false);
  }

  // Cheap authorization and shape checks must precede file.arrayBuffer(),
  // sips decoding, Provider upload, Key access, and budget reservation.
  if (!CLIENT_JOB_ID.test(clientJobId)) throw new ReferenceJobError(400, 'CORE007_JOB_ID_INVALID', '本地 Job ID 无效。', false);
  if (!prompt.trim() || prompt.length > 32_000) throw new ReferenceJobError(400, 'CORE007_PROMPT_INVALID', '图片编辑指令必须为 1–32000 个字符。', false);
  if (consentVersion !== CORE007_CONSENT_VERSION) throw new ReferenceJobError(400, 'CORE007_CONSENT_REQUIRED', '必须先确认图片外传与最长 72 小时留存边界。', false);
  if (!SAFE_UPLOAD_FILENAME.test(file.name) || file.name.includes('/') || file.name.includes('\\')) throw new ReferenceJobError(400, 'CORE007_FILENAME_INVALID', '参考图文件名无效。', false);
  if (file.type !== 'image/png') throw new ReferenceJobError(415, 'CORE007_FILE_TYPE_INVALID', '浏览器必须提交清理后的 PNG。', false);
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new ReferenceJobError(413, 'CORE007_UPLOAD_TOO_LARGE', '参考图上传体积超过 10 MiB 限制。', false);

  const buffer = Buffer.from(await file.arrayBuffer());
  return { buffer, mimeType: 'image/png', extension: '.png', prompt: prompt.trim(), clientJobId, consentVersion };
};

export const readVideoMultipart = async (request, boundary, { deadlineMs = MULTIPART_DEADLINE_MS } = {}) => {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new TypeError('Multipart deadline is invalid.');
  const declaredHeader = request.headers?.['content-length'];
  if (declaredHeader !== undefined && !/^\d+$/.test(String(declaredHeader))) throw new Core009VideoError(400, 'CORE009_CONTENT_LENGTH_INVALID', '视频参考图请求体长度无效。');
  const declared = declaredHeader === undefined ? NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared <= 0 || declared > MAX_MULTIPART_BYTES)) throw new Core009VideoError(413, 'CORE009_UPLOAD_TOO_LARGE', '视频参考图上传体积超过 10 MiB 限制。');
  const chunks = [];
  let bytes = 0;
  let deadlineExceeded = false;
  const deadline = setTimeout(() => { deadlineExceeded = true; request.destroy?.(); }, deadlineMs);
  try {
    for await (const chunk of request) {
      if (deadlineExceeded) throw new Core009VideoError(408, 'CORE009_BODY_DEADLINE_EXCEEDED', '视频参考图请求体读取超时。', true);
      bytes += chunk.length;
      if (bytes > MAX_MULTIPART_BYTES) throw new Core009VideoError(413, 'CORE009_UPLOAD_TOO_LARGE', '视频参考图上传体积超过 10 MiB 限制。');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (deadlineExceeded) throw new Core009VideoError(408, 'CORE009_BODY_DEADLINE_EXCEEDED', '视频参考图请求体读取超时。', true);
    throw error;
  } finally { clearTimeout(deadline); }
  if (deadlineExceeded) throw new Core009VideoError(408, 'CORE009_BODY_DEADLINE_EXCEEDED', '视频参考图请求体读取超时。', true);
  const body = Buffer.concat(chunks);
  assertMultipartEnvelope(body, boundary, MAX_VIDEO_MULTIPART_PARTS);
  const envelope = new Request('http://127.0.0.1/api/agent/video-jobs', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
  let form;
  try { form = await envelope.formData(); } catch { throw new Core009VideoError(400, 'CORE009_MULTIPART_INVALID', '视频参考图 multipart 请求无效。'); }
  return validateVideoMultipartForm(form);
};

export const validateVideoMultipartForm = async (form) => {
  const fields = ['file', 'prompt', 'clientJobId', 'sourceObjectId', 'sourceAssetId', 'sourceVersionId'];
  for (const key of form.keys()) if (!fields.includes(key)) throw new Core009VideoError(400, 'CORE009_MULTIPART_FIELD_INVALID', '视频参考图上传包含未允许字段。');
  if (fields.some((key) => form.getAll(key).length !== 1)) throw new Core009VideoError(400, 'CORE009_MULTIPART_CARDINALITY_INVALID', '视频参考图上传字段数量无效。');
  const file = form.get('file');
  const prompt = form.get('prompt');
  const clientJobId = form.get('clientJobId');
  const sourceObjectId = form.get('sourceObjectId');
  const sourceAssetId = form.get('sourceAssetId');
  const sourceVersionId = form.get('sourceVersionId');
  if (!(file instanceof File) || [prompt, clientJobId, sourceObjectId, sourceAssetId, sourceVersionId].some((value) => typeof value !== 'string')) throw new Core009VideoError(400, 'CORE009_MULTIPART_VALUE_INVALID', '视频参考图上传字段类型无效。');
  if (!CLIENT_JOB_ID.test(clientJobId)) throw new Core009VideoError(400, 'CORE009_VIDEO_JOB_ID_INVALID', '本地 Job ID 无效。');
  if (!prompt.trim() || prompt.length > 32_000) throw new Core009VideoError(400, 'CORE009_VIDEO_PROMPT_INVALID', '视频描述必须为 1–32000 个字符。');
  for (const value of [sourceObjectId, sourceAssetId, sourceVersionId]) if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Core009VideoError(400, 'CORE009_VIDEO_SOURCE_BINDING_INVALID', '视频源图绑定无效。');
  if (!SAFE_UPLOAD_FILENAME.test(file.name) || file.type !== 'image/png') throw new Core009VideoError(415, 'CORE009_VIDEO_FILE_TYPE_INVALID', '浏览器必须提交清理后的 PNG 参考图。');
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Core009VideoError(413, 'CORE009_UPLOAD_TOO_LARGE', '视频参考图超过 10 MiB 限制。');
  return { buffer: Buffer.from(await file.arrayBuffer()), mimeType: 'image/png', extension: '.png', prompt: prompt.trim(), clientJobId, sourceObjectId, sourceAssetId, sourceVersionId };
};

export const createApiHandler = ({
  host,
  port,
  client,
  plannerClient,
  core007PlannerClient,
  core009PlannerClient = plannerClient,
  referenceJobs,
  core009ReferenceJobs = referenceJobs,
  core008ImageGateway = client,
  core009ImageGateway = core008ImageGateway,
  core009VideoGateway,
  providerSettings,
  paidConfirmations = createPaidConfirmationStore(),
  sanitizeReference = sanitizeBrowserReferencePng,
  expensiveWork = createBoundedSemaphore(),
}) => async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname === '/api/agent/provider-settings' && providerSettings) {
      if (request.method === 'GET') {
        assertLocalApiRequest(request, { host, port });
        response.setHeader('Cache-Control', 'no-store');
        return sendJson(response, 200, providerSettings.readPublic());
      }
      if (request.method === 'POST') {
        assertStrictLocalJsonRequest(request, { host, port });
        response.setHeader('Cache-Control', 'no-store');
        return sendJson(response, 200, await providerSettings.save(await readJson(request)));
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/agent/paid-confirmations') {
      assertStrictPaidJsonRequest(request, { host, port });
      const input = await readJson(request);
      const expectedKeys = input?.kind === 'image' || input?.kind === 'video' ? 'authorizationId|chain|kind|request' : 'authorizationId|kind|request';
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join('|') !== expectedKeys) {
        throw new PaidConfirmationError(400, 'PAID_CONFIRMATION_REQUEST_INVALID', '付费确认请求结构无效。');
      }
      const requestDigest = createPaidRequestDigest({ kind: input.kind, route: input.request?.route, body: input.request?.body });
      return sendJson(response, 201, paidConfirmations.issue({ authorizationId: input.authorizationId, kind: input.kind, requestDigest, request: input.request, chain: input.chain }));
    }
    if (request.method === 'POST' && url.pathname === '/api/agent/plans') {
      assertStrictPaidJsonRequest(request, { host, port });
      const input = await readJson(request);
      assertPaidPlannerInput(input);
      assertCore007PlannerConsent(input);
      const confirmation = consumePaidConfirmation(request, paidConfirmations, 'planner', url.pathname, input);
      const selectedPlanner = input?.creationMode ? core009PlannerClient : input?.referenceKind === 'user-upload' ? core007PlannerClient : plannerClient;
      const result = await selectedPlanner.createPlan(input);
      paidConfirmations.bindPlannerResult({ authorizationId: confirmation.authorizationId, plannerRequestDigest: confirmation.requestDigest, plannerInput: input, result });
      return sendJson(response, 200, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/agent/image-jobs') {
      assertStrictPaidJsonRequest(request, { host, port });
      const input = await readJson(request);
      assertLegacyImageRouteBoundary(input);
      assertPaidImageInput(input);
      const confirmation = consumePaidConfirmation(request, paidConfirmations, 'image', url.pathname, input);
      const gateway = confirmation.milestone === 'CORE009' ? core009ImageGateway : core008ImageGateway;
      return sendJson(response, 202, await gateway.createImageJob(input));
    }
    if (request.method === 'POST' && url.pathname === '/api/agent/image-edit-jobs') {
      assertStrictPaidJsonRequest(request, { host, port });
      const input = await readJson(request);
      assertLegacyImageRouteBoundary(input);
      assertPaidImageInput(input);
      const referenceUrl = process.env.ELYRA_DEMO_REFERENCE_URL;
      if (!referenceUrl || !PUBLIC_IMAGE_URL.test(referenceUrl)) throw new ClientInputError('未配置有效的 ELYRA_DEMO_REFERENCE_URL 固定演示参考图环境变量。');
      const confirmation = consumePaidConfirmation(request, paidConfirmations, 'image', url.pathname, input);
      const gateway = confirmation.milestone === 'CORE009' ? core009ImageGateway : core008ImageGateway;
      return sendJson(response, 202, await gateway.createImageEditJob({ ...input, referenceUrl }));
    }
    if (request.method === 'POST' && url.pathname === '/api/agent/user-reference-image-jobs') {
      const boundary = assertStrictPaidMultipartRequest(request, { host, port });
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('local request aborted'));
      request.once('aborted', abort);
      response.once('close', () => { if (!response.writableEnded) abort(); });
      const input = await readReferenceMultipart(request, boundary);
      const requestBinding = createUserReferenceRequestBinding({
        prompt: input.prompt,
        clientJobId: input.clientJobId,
        consentVersion: input.consentVersion,
        buffer: input.buffer,
        mimeType: input.mimeType,
      });
      const confirmation = consumePaidConfirmation(request, paidConfirmations, 'image', url.pathname, requestBinding);
      const selectedReferenceJobs = confirmation.milestone === 'CORE009' ? core009ReferenceJobs : referenceJobs;
      const job = await expensiveWork.run(async () => {
        const sanitized = await sanitizeReference({ buffer: input.buffer, mimeType: input.mimeType, extension: input.extension });
        return selectedReferenceJobs.create({
          clientJobId: input.clientJobId,
          clientReferenceSha256: createHash('sha256').update(input.buffer).digest('hex'),
          prompt: input.prompt,
          sanitized,
          consentVersion: input.consentVersion,
          signal: controller.signal,
        });
      }, controller.signal);
      return sendJson(response, 202, job);
    }
    if (request.method === 'POST' && url.pathname === '/api/agent/video-jobs') {
      if (!core009VideoGateway) throw new Core009VideoError(503, 'CORE009_VIDEO_GATEWAY_UNAVAILABLE', '视频服务尚未初始化。');
      const boundary = assertStrictPaidMultipartRequest(request, { host, port });
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('local video request aborted'));
      request.once('aborted', abort);
      response.once('close', () => { if (!response.writableEnded) abort(); });
      const input = await readVideoMultipart(request, boundary);
      const requestBinding = createVideoRequestBinding({ ...input, buffer: input.buffer });
      const confirmation = consumePaidConfirmation(request, paidConfirmations, 'video', url.pathname, requestBinding);
      if (confirmation.milestone !== 'CORE009') throw new Core009VideoError(409, 'CORE009_VIDEO_AUTHORIZATION_REQUIRED', '视频任务只接受 CORE-009 发送授权。');
      const job = await expensiveWork.run(async () => {
        const sanitized = await sanitizeReference({ buffer: input.buffer, mimeType: input.mimeType, extension: input.extension });
        return core009VideoGateway.create({ ...input, sanitized }, { signal: controller.signal });
      }, controller.signal);
      return sendJson(response, 202, job);
    }
    if (request.method === 'GET' && url.pathname === '/api/agent/core-007-budget') {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, referenceJobs.getBudgetStatus());
    }
    if (request.method === 'GET' && url.pathname === '/api/agent/core-008-budget') {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, core008ImageGateway.getBudgetStatus());
    }
    if (request.method === 'GET' && url.pathname === '/api/agent/core-008-capabilities') {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, CORE008_LOCAL_API_PROTOCOL);
    }
    if (request.method === 'GET' && url.pathname === '/api/agent/core-009-budget') {
      assertLocalApiRequest(request, { host, port });
      if (!core009VideoGateway) throw new Core009VideoError(503, 'CORE009_VIDEO_GATEWAY_UNAVAILABLE', '视频服务尚未初始化。');
      return sendJson(response, 200, { ...core009VideoGateway.getBudgetStatus(), ...(providerSettings ? { providerReservations: Object.fromEntries(Object.entries(providerSettings.active.roles).map(([role, profile]) => [role, profile.reservationUsd])) } : {}) });
    }
    if (request.method === 'GET' && url.pathname === '/api/agent/core-009-capabilities') {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, CORE009_LOCAL_API_PROTOCOL);
    }
    if (request.method === 'POST' && url.pathname === '/api/agent/image-jobs/recover-existing') {
      assertStrictLocalJsonRequest(request, { host, port });
      const input = await readJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).sort().join('|') !== 'clientJobId|taskId') {
        throw new Core008BudgetError(400, 'CORE008_RECOVERY_REQUEST_INVALID', '已完成图片任务的恢复请求结构无效。');
      }
      return sendJson(response, 200, await core008ImageGateway.recoverExistingTask(input));
    }
    const imageClientJobMatch = url.pathname.match(/^\/api\/agent\/image-jobs\/by-client-job\/(job-[A-Za-z0-9_-]{1,190})$/);
    if (request.method === 'GET' && imageClientJobMatch) {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, gatewayFallback(
        () => core009ImageGateway.getTaskForClientJob(imageClientJobMatch[1]),
        () => core008ImageGateway.getTaskForClientJob(imageClientJobMatch[1]),
        new Set(['CORE008_LOCAL_TASK_HANDLE_MISSING']),
      ));
    }
    const referenceEvidenceMatch = url.pathname.match(/^\/api\/agent\/user-reference-image-jobs\/(job-[A-Za-z0-9_-]{1,190})\/evidence$/);
    if (request.method === 'GET' && referenceEvidenceMatch) {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, gatewayFallback(
        () => core009ReferenceJobs.evidence(referenceEvidenceMatch[1]),
        () => referenceJobs.evidence(referenceEvidenceMatch[1]),
        new Set(['CORE007_JOB_NOT_FOUND']),
      ));
    }
    const referenceJobMatch = url.pathname.match(/^\/api\/agent\/user-reference-image-jobs\/(job-[A-Za-z0-9_-]{1,190})$/);
    if (request.method === 'GET' && referenceJobMatch) {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, await gatewayFallbackAsync(
        () => core009ReferenceJobs.status(referenceJobMatch[1]),
        () => referenceJobs.status(referenceJobMatch[1]),
        new Set(['CORE007_JOB_NOT_FOUND']),
      ));
    }
    if (request.method === 'POST' && referenceJobMatch) {
      assertLocalJsonRequest(request, { host, port });
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('local request aborted'));
      request.once('aborted', abort);
      response.once('close', () => { if (!response.writableEnded) abort(); });
      const input = await readJson(request);
      if (input?.action === 'soft-cancel') return sendJson(response, 200, gatewayFallback(
        () => core009ReferenceJobs.cancel(referenceJobMatch[1]),
        () => referenceJobs.cancel(referenceJobMatch[1]),
        new Set(['CORE007_JOB_NOT_FOUND']),
      ));
      if (input?.action === 'retry-local-result') return sendJson(response, 200, await gatewayFallbackAsync(
        () => core009ReferenceJobs.retryLocalResult(referenceJobMatch[1], { signal: controller.signal }),
        () => referenceJobs.retryLocalResult(referenceJobMatch[1], { signal: controller.signal }),
        new Set(['CORE007_JOB_NOT_FOUND']),
      ));
      if (input?.action === 'retry-status') return sendJson(response, 200, await gatewayFallbackAsync(
        () => core009ReferenceJobs.retryStatus(referenceJobMatch[1], { signal: controller.signal }),
        () => referenceJobs.retryStatus(referenceJobMatch[1], { signal: controller.signal }),
        new Set(['CORE007_JOB_NOT_FOUND']),
      ));
      throw new ReferenceJobError(400, 'CORE007_JOB_ACTION_INVALID', '本地任务操作无效。', false);
    }
    const localResultMatch = url.pathname.match(/^\/api\/agent\/local-assets\/(result-[a-f0-9]{32})$/);
    if (request.method === 'GET' && localResultMatch) {
      assertLocalApiRequest(request, { host, port });
      const result = gatewayFallback(
        () => core009ReferenceJobs.result(localResultMatch[1]),
        () => referenceJobs.result(localResultMatch[1]),
        new Set(['CORE007_RESULT_NOT_FOUND']),
      );
      response.writeHead(200, {
        'Content-Type': result.mimeType,
        'Content-Length': result.buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(result.buffer);
      return;
    }
    const videoEvidenceMatch = url.pathname.match(/^\/api\/agent\/video-jobs\/(job-[A-Za-z0-9_-]{1,190})\/evidence$/);
    if (request.method === 'GET' && videoEvidenceMatch) {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, core009VideoGateway.evidence(videoEvidenceMatch[1]));
    }
    const videoJobMatch = url.pathname.match(/^\/api\/agent\/video-jobs\/(job-[A-Za-z0-9_-]{1,190})$/);
    if (request.method === 'GET' && videoJobMatch) {
      assertLocalApiRequest(request, { host, port });
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('local request aborted'));
      request.once('aborted', abort);
      response.once('close', () => { if (!response.writableEnded) abort(); });
      return sendJson(response, 200, await core009VideoGateway.status(videoJobMatch[1], { signal: controller.signal }));
    }
    if (request.method === 'POST' && videoJobMatch) {
      assertLocalJsonRequest(request, { host, port });
      const controller = new AbortController();
      const abort = () => controller.abort(new Error('local request aborted'));
      request.once('aborted', abort);
      response.once('close', () => { if (!response.writableEnded) abort(); });
      const input = await readJson(request);
      if (input?.action === 'soft-cancel') return sendJson(response, 200, core009VideoGateway.cancel(videoJobMatch[1]));
      if (input?.action === 'retry-local-result') return sendJson(response, 200, await core009VideoGateway.retryLocalResult(videoJobMatch[1], { signal: controller.signal }));
      if (input?.action === 'retry-status') return sendJson(response, 200, await core009VideoGateway.retryStatus(videoJobMatch[1], { signal: controller.signal }));
      throw new Core009VideoError(400, 'CORE009_VIDEO_ACTION_INVALID', '视频任务操作无效。');
    }
    const videoResultMatch = url.pathname.match(/^\/api\/agent\/video-assets\/(video-result-[a-f0-9]{32})$/);
    if (request.method === 'GET' && videoResultMatch) {
      assertLocalApiRequest(request, { host, port });
      const result = core009VideoGateway.result(videoResultMatch[1]);
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': result.buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(result.buffer);
      return;
    }
    const imageResultMatch = url.pathname.match(/^\/api\/agent\/image-job-results\/(image-result-[a-f0-9]{32})$/);
    if (request.method === 'GET' && imageResultMatch) {
      assertLocalApiRequest(request, { host, port });
      const result = gatewayFallback(
        () => core009ImageGateway.result(imageResultMatch[1]),
        () => core008ImageGateway.result(imageResultMatch[1]),
        new Set(['CORE008_RESULT_NOT_FOUND']),
      );
      response.writeHead(200, {
        'Content-Type': result.mimeType,
        'Content-Length': result.buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(result.buffer);
      return;
    }
    const taskMatch = url.pathname.match(/^\/api\/agent\/jobs\/(task-unified-[A-Za-z0-9_-]+)$/);
    if (request.method === 'GET' && taskMatch) {
      assertLocalApiRequest(request, { host, port });
      return sendJson(response, 200, await gatewayFallbackAsync(
        () => core009ImageGateway.getTask(taskMatch[1]),
        () => core008ImageGateway.getTask(taskMatch[1]),
        new Set(['CORE008_TASK_NOT_FOUND']),
      ));
    }
    return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '未知本机 Agent API。' } });
  } catch (error) {
    if (response.destroyed) return;
    const status = error instanceof ClientInputError || error instanceof PlannerInputError || error instanceof ReferenceImageError ? 400 : error instanceof EvoLinkHttpError || error instanceof PlannerError || error instanceof ReferenceJobError || error instanceof Core008BudgetError || error instanceof Core009VideoError || error instanceof PaidConfirmationError || error instanceof ProviderConfigError ? error.status : 502;
    const code = error instanceof EvoLinkHttpError ? safeEvoLinkErrorCode(error.status) : error instanceof PlannerError || error instanceof ReferenceJobError || error instanceof Core008BudgetError || error instanceof Core009VideoError || error instanceof PaidConfirmationError || error instanceof ReferenceImageError || error instanceof PlannerInputError || error instanceof ProviderConfigError ? error.code ?? 'INVALID_INPUT' : error instanceof ClientInputError ? 'INVALID_INPUT' : 'LOCAL_AGENT_ERROR';
    const safeMessage = error instanceof EvoLinkHttpError ? safeEvoLinkErrorMessage(error.status) : error instanceof ReferenceImageError ? '参考图未通过服务端安全验证。' : error instanceof ClientInputError || error instanceof PlannerInputError || error instanceof PlannerError || error instanceof ReferenceJobError || error instanceof Core008BudgetError || error instanceof Core009VideoError || error instanceof PaidConfirmationError || error instanceof ProviderConfigError ? error.message : '本机 Agent 服务异常。';
    const retryable = error instanceof EvoLinkHttpError ? error.status === 429 || error.status >= 500 : error instanceof PlannerError || error instanceof ReferenceJobError || error instanceof Core009VideoError ? error.retryable : false;
    const retryScope = error instanceof Core009VideoError ? error.retryScope : error instanceof EvoLinkHttpError && retryable ? 'new-provider-job' : 'none';
    return sendJson(response, status, {
      error: { code, message: safeMessage, retryable, retryScope },
      ...(error instanceof PlannerError && error.evidence ? { evidence: error.evidence } : {}),
    });
  }
};

const safeEvoLinkErrorCode = (status) => status === 400 ? 'EVOLINK_REQUEST_INVALID' : status === 401 || status === 403 ? 'EVOLINK_AUTH_FAILED' : status === 402 ? 'EVOLINK_BALANCE_REQUIRED' : status === 429 ? 'EVOLINK_RATE_LIMITED' : status >= 500 ? 'EVOLINK_UNAVAILABLE' : 'EVOLINK_REJECTED';
const safeEvoLinkErrorMessage = (status) => status === 400 ? 'EvoLink 拒绝了图片任务参数。' : status === 401 || status === 403 ? 'EvoLink 图片服务鉴权失败。' : status === 402 ? 'EvoLink 账户余额不足。' : status === 429 ? 'EvoLink 图片请求过于频繁。' : status >= 500 ? 'EvoLink 图片服务暂时不可用。' : 'EvoLink 拒绝了图片任务。';

const gatewayFallback = (primary, fallback, missingCodes) => {
  try { return primary(); } catch (error) {
    if (!missingCodes.has(error?.code)) throw error;
    return fallback();
  }
};

const gatewayFallbackAsync = async (primary, fallback, missingCodes) => {
  try { return await primary(); } catch (error) {
    if (!missingCodes.has(error?.code)) throw error;
    return fallback();
  }
};

export const startElyraServer = async ({ host = DEFAULT_HOST, port = Number(process.env.PORT ?? 4175) } = {}) => {
  const preview = process.env.ELYRA_PREVIEW_ONLY === '1';
  const registry = createProviderRegistry({ plugins: providerPlugins, preview });
  const providerSettings = createProviderSettingsStore({ path: resolve(fileURLToPath(new URL('..', import.meta.url)), '.elyra-runtime/provider-settings.json'), protocols: registry.protocols, preview });
  const settings = providerSettings.active.roles;
  const plannerAdapter = registry.create('planner', settings.planner);
  const imageAdapter = registry.create('image', settings.image);
  const videoAdapter = registry.create('video', settings.video);
  const client = imageAdapter.client;
  const core008BudgetLedger = createPlannerBudgetLedger({ directory: CORE008_BUDGET_DIRECTORY });
  const core009BudgetLedger = createPlannerBudgetLedger({ directory: CORE009_BUDGET_DIRECTORY });
  // CORE-008 Send authorization allows one Planner and one Image submission.
  // A retryable Planner failure therefore returns to the UI instead of issuing
  // a second Provider request inside the same Send grant.
  const plannerClient = plannerAdapter.createClient({ budgetLedger: core008BudgetLedger, budgetCapUsd: CORE008_BUDGET_CAP_USD, attemptReservationUsd: 0.05, historicalSpentUsd: 0, maxAttempts: 1 });
  const core007PlannerClient = plannerClient;
  const core009PlannerClient = plannerAdapter.createClient({ budgetLedger: core009BudgetLedger, budgetCapUsd: CORE009_BUDGET_CAP_USD, attemptReservationUsd: 0.05, historicalSpentUsd: 0, maxAttempts: 1 });
  const core008ImageGateway = createCore008ImageGateway({ client, budgetLedger: core008BudgetLedger, ensureConfigured: imageAdapter.ensureConfigured, resolveProviderResult: imageAdapter.resolveResult, imageReservationUsd: settings.image.reservationUsd });
  const core009ImageGateway = createCore008ImageGateway({ client, budgetLedger: core009BudgetLedger, ensureConfigured: imageAdapter.ensureConfigured, resolveProviderResult: imageAdapter.resolveResult, imageReservationUsd: settings.image.reservationUsd, budgetCapUsd: CORE009_BUDGET_CAP_USD, budgetMilestone: 'CORE009' });
  const referenceJobs = createReferenceJobService({ evolinkClient: client, ensureConfigured: imageAdapter.ensureConfigured, resolveProviderResult: imageAdapter.resolveResult, imageReservationUsd: settings.image.reservationUsd, budgetLedger: core008BudgetLedger, budgetCapUsd: CORE008_BUDGET_CAP_USD, budgetMilestone: 'CORE008' });
  const core009ReferenceJobs = createReferenceJobService({ evolinkClient: client, ensureConfigured: imageAdapter.ensureConfigured, resolveProviderResult: imageAdapter.resolveResult, imageReservationUsd: settings.image.reservationUsd, budgetLedger: core009BudgetLedger, budgetCapUsd: CORE009_BUDGET_CAP_USD, budgetMilestone: 'CORE009' });
  const core009VideoGateway = createCore009VideoGateway({ evolinkClient: videoAdapter.client, budgetLedger: core009BudgetLedger, ensureConfigured: videoAdapter.ensureConfigured, resolveProviderResult: videoAdapter.resolveResult, reservationUsd: settings.video.reservationUsd, model: settings.video.model });
  const paidConfirmations = createPaidConfirmationStore();
  // Share the actual HTTP server: separate previews must not compete for
  // Vite's default WebSocket port or reconnect to another project's HMR.
  const app = createServer();
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server: app } }, appType: 'spa' });
  const apiHandler = createApiHandler({ host, port, client, plannerClient, core007PlannerClient, core009PlannerClient, referenceJobs, core009ReferenceJobs, core008ImageGateway, core009ImageGateway, core009VideoGateway, paidConfirmations, providerSettings });
  app.on('request', (request, response) => {
    if (isPrivateResource(request.url)) { response.writeHead(404).end(); return; }
    if (request.url?.startsWith('/api/agent/')) {
      void apiHandler(request, response);
      return;
    }
    vite.middlewares(request, response, () => void serveApp(vite, request, response));
  });
  await new Promise((resolvePromise, reject) => app.listen(port, host, resolvePromise).once('error', reject));
  console.log(`ELYRA local agent server: http://${host}:${port}`);
  return {
    app,
    vite,
    async close() {
      await Promise.all([
        new Promise((resolvePromise, reject) => app.close((error) => error ? reject(error) : resolvePromise())),
        vite.close(),
      ]);
    },
  };
};

function assertLocalJsonRequest(request, boundary) {
  assertLocalApiRequest(request, boundary);
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new PlannerInputError('Agent Planner 只接受 application/json。');
}

function assertStrictLocalJsonRequest(request, boundary) {
  const { host, port } = boundary;
  if (request.headers.host !== `${host}:${port}`
    || request.headers.origin !== `http://${host}:${port}`
    || request.headers['sec-fetch-site'] !== 'same-origin') {
    throw new Core008BudgetError(403, 'CORE008_RECOVERY_SAME_ORIGIN_REQUIRED', '任务恢复只接受明确的同源本机请求。');
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new Core008BudgetError(415, 'CORE008_RECOVERY_JSON_REQUIRED', '任务恢复只接受 application/json。');
  }
}

function assertLocalMultipartRequest(request, boundary) {
  assertLocalApiRequest(request, boundary);
  return parseMultipartBoundary(request);
}

function assertStrictPaidJsonRequest(request, boundary) {
  assertStrictPaidRequest(request, boundary);
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new PlannerInputError('Agent Planner 只接受 application/json。');
}

function assertStrictPaidMultipartRequest(request, boundary) {
  assertStrictPaidRequest(request, boundary);
  return parseMultipartBoundary(request);
}

function assertStrictPaidRequest(request, { host, port }) {
  if (request.headers.host !== `${host}:${port}`) throw new PlannerInputError('本机 Agent API Host 无效。');
  if (request.headers.origin !== `http://${host}:${port}` || request.headers['sec-fetch-site'] !== 'same-origin') {
    throw new PaidConfirmationError(403, 'PAID_CONFIRMATION_SAME_ORIGIN_REQUIRED', '付费操作只接受明确的同源浏览器请求。');
  }
}

function consumePaidConfirmation(request, paidConfirmations, kind, route, body) {
  const token = request.headers[PAID_CONFIRMATION_HEADER];
  const requestDigest = createPaidRequestDigest({ kind, route, body });
  return paidConfirmations.consume({ token: typeof token === 'string' ? token : undefined, kind, requestDigest });
}

function assertPaidPlannerInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PlannerInputError('规划请求必须是对象。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4_000) throw new PlannerInputError('视觉需求必须为 1–4000 个字符。');
  if (!PAID_IMAGE_PROVIDERS.has(input.imageProviderId)) throw new PlannerInputError('图片 Provider 不在 CORE-003 白名单中。');
  if (input.creationMode !== undefined) {
    if (!['agent', 'image', 'video'].includes(input.creationMode)) throw new PlannerInputError('创作模式无效。', 'CORE009_MODE_INVALID');
    if (input.videoProviderId !== 'evolink-sora-2-preview') throw new PlannerInputError('视频 Provider 不在 CORE-009 白名单中。', 'CORE009_VIDEO_PROVIDER_INVALID');
    if (!Number.isInteger(input.selectedCanvasObjectCount) || input.selectedCanvasObjectCount < 0 || input.selectedCanvasObjectCount > 100) throw new PlannerInputError('选中对象数量无效。', 'CORE009_SELECTION_COUNT_INVALID');
    if ((input.selectedCanvasObjectCount === 1) !== Boolean(input.targetCanvasObjectId)) throw new PlannerInputError('单选绑定与选中数量不一致。', 'CORE009_SELECTION_BINDING_INVALID');
    if (input.creationMode === 'image' && input.selectedCanvasObjectCount > 1) throw new PlannerInputError('图片模式只允许未选中或单选一张图片。', 'CORE009_IMAGE_SELECTION_INVALID');
    if (input.creationMode === 'video' && input.selectedCanvasObjectCount !== 1) throw new PlannerInputError('视频模式必须且只能选中一张图片。', 'CORE009_VIDEO_SELECTION_REQUIRED');
  }
  if (input.targetCanvasObjectId !== undefined && (typeof input.targetCanvasObjectId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.targetCanvasObjectId))) throw new PlannerInputError('目标 Canvas Object ID 无效。');
  if (input.targetCanvasObjectId) {
    const binding = input.targetBinding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || binding.objectId !== input.targetCanvasObjectId || typeof binding.versionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(binding.versionId)) throw new PlannerInputError('目标 Canvas Object 绑定无效。');
    if (typeof binding.objectId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(binding.objectId)) throw new PlannerInputError('目标 Canvas Object 绑定无效。');
    if (binding.assetId !== undefined && (typeof binding.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(binding.assetId))) throw new PlannerInputError('目标 Asset 绑定无效。');
    const expectedBindingKeys = binding.assetId === undefined ? 'objectId|versionId' : 'assetId|objectId|versionId';
    if (Object.keys(binding).sort().join('|') !== expectedBindingKeys) throw new PlannerInputError('目标 Canvas Object 绑定字段无效。');
  } else if (input.targetBinding !== undefined) throw new PlannerInputError('文生图请求不得携带目标绑定。');
  if (!input.targetCanvasObjectId && input.referenceKind !== undefined) throw new PlannerInputError('未选中 Canvas Object 时不得声明参考图类型。');
  if (input.referenceKind !== undefined && !['fixed-demo', 'user-upload'].includes(input.referenceKind)) throw new PlannerInputError('参考图类型不在 CORE-007 白名单中。');
}

function assertPaidImageInput(input) {
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32_000) throw new ClientInputError('prompt 必须为 1–32000 个字符。');
  if (typeof input.clientJobId !== 'string' || !CLIENT_JOB_ID.test(input.clientJobId)) throw new ClientInputError('本地 Job ID 无效。');
  if (input.size !== undefined && !PAID_IMAGE_SIZES.has(input.size)) throw new ClientInputError('size 必须为 EvoLink GPT Image 2 支持的比例。');
  if (input.quality !== undefined && !PAID_IMAGE_QUALITIES.has(input.quality)) throw new ClientInputError('quality 必须为 low、medium 或 high。');
  if (input.n !== undefined && input.n !== 1) throw new ClientInputError('当前 ELYRA 只允许每个任务生成 1 张图片。');
}

function assertLocalApiRequest(request, { host, port }) {
  if (request.headers.host !== `${host}:${port}`) throw new PlannerInputError('本机 Agent API Host 无效。');
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}:${port}`) throw new PlannerInputError('本机 Agent API 只接受同源 localhost 请求。');
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') throw new PlannerInputError('本机 Agent API 拒绝跨站请求。');
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_JSON_BYTES) throw new ClientInputError('请求体过大。');
  }
  try { return JSON.parse(raw); } catch { throw new ClientInputError('请求必须是 JSON。'); }
}

function assertMultipartEnvelope(body, boundary, expectedParts = MAX_MULTIPART_PARTS) {
  const delimiter = Buffer.from(`--${boundary}`);
  const marker = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, delimiter.length).equals(delimiter)) throw new ReferenceJobError(400, 'CORE007_MULTIPART_INVALID', '参考图 multipart 起始边界无效。', false);
  let cursor = delimiter.length;
  let parts = 0;
  while (true) {
    if (body.subarray(cursor, cursor + 2).toString('ascii') === '--') {
      cursor += 2;
      if (cursor === body.length) break;
      if (body.subarray(cursor).toString('ascii') === '\r\n') break;
      throw new ReferenceJobError(400, 'CORE007_MULTIPART_INVALID', '参考图 multipart 尾部无效。', false);
    }
    if (body.subarray(cursor, cursor + 2).toString('ascii') !== '\r\n') throw new ReferenceJobError(400, 'CORE007_MULTIPART_INVALID', '参考图 multipart 分隔符无效。', false);
    cursor += 2;
    const headerEnd = body.indexOf('\r\n\r\n', cursor, 'ascii');
    if (headerEnd < 0 || headerEnd - cursor > MAX_PART_HEADER_BYTES) throw new ReferenceJobError(431, 'CORE007_PART_HEADERS_INVALID', '参考图 multipart part header 无效或过大。', false);
    const headerBytes = body.subarray(cursor, headerEnd);
    if ([...headerBytes].some((byte) => byte !== 9 && byte !== 13 && byte !== 10 && (byte < 32 || byte > 126))) throw new ReferenceJobError(400, 'CORE007_PART_HEADERS_INVALID', '参考图 multipart part header 包含非法字符。', false);
    const headerLines = headerBytes.toString('ascii').split('\r\n');
    if (headerLines.some((line) => line.length > 512 || /^[ \t]/.test(line) || !/^[A-Za-z0-9-]+: [\x20-\x7e]*$/.test(line))) throw new ReferenceJobError(400, 'CORE007_PART_HEADERS_INVALID', '参考图 multipart part header 格式无效。', false);
    if (headerLines.filter((line) => /^content-disposition:/i.test(line)).length !== 1) throw new ReferenceJobError(400, 'CORE007_PART_HEADERS_INVALID', '参考图 multipart 缺少唯一 Content-Disposition。', false);
    const bodyStart = headerEnd + 4;
    const next = findNextMultipartMarker(body, marker, bodyStart);
    if (next < 0) throw new ReferenceJobError(400, 'CORE007_MULTIPART_INVALID', '参考图 multipart 缺少结束边界。', false);
    parts += 1;
    if (parts > expectedParts) throw new ReferenceJobError(400, 'CORE007_MULTIPART_CARDINALITY_INVALID', '参考图 multipart part 数量过多。', false);
    cursor = next + marker.length;
  }
  if (parts !== expectedParts) throw new ReferenceJobError(400, 'CORE007_MULTIPART_CARDINALITY_INVALID', `参考图 multipart 必须且只能包含 ${expectedParts} 个字段。`, false);
}

function findNextMultipartMarker(body, marker, from) {
  let cursor = from;
  while (cursor < body.length) {
    const candidate = body.indexOf(marker, cursor);
    if (candidate < 0) return -1;
    const suffix = body.subarray(candidate + marker.length, candidate + marker.length + 2).toString('ascii');
    if (suffix === '\r\n' || suffix === '--') return candidate;
    cursor = candidate + 1;
  }
  return -1;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function serveApp(vite, request, response) {
  try {
    const template = await readFile('index.html', 'utf8');
    const html = await vite.transformIndexHtml(request.url ?? '/', template);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  } catch (error) {
    vite.ssrFixStacktrace(error);
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : 'Vite server error');
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await startElyraServer();
