import { createHash, randomUUID } from 'node:crypto';
import { lookup as lookupDns } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { EvoLinkHttpError } from './evolink.mjs';
import { PlannerBudgetExceededError, PlannerBudgetLedgerError } from './planner-budget.mjs';
import { ReferenceImageError, sanitizeProviderResultImage } from './reference-image.mjs';

export const CORE007_BUDGET_CAP_USD = 5;
// EvoLink does not expose an authoritative per-response bill in this API.
// Reserve and conservatively settle one dollar for every generation POST.
export const CORE007_IMAGE_RESERVATION_USD = 1;

const CLIENT_JOB_ID = /^job-[A-Za-z0-9_-]{1,190}$/;
const RESULT_ID = /^result-[a-f0-9]{32}$/;
const MAX_RESULT_BYTES = 20 * 1024 * 1024;
const EVOLINK_RESULT_HOSTNAME = 'files.evolink.ai';
const RETRYABLE = (status) => status === 429 || status >= 500;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const createReferenceJobService = ({
  evolinkClient,
  budgetLedger,
  requestImpl = httpsRequest,
  lookupImpl = (hostname) => lookupDns(hostname, { all: true, verbatim: true }),
  sleepImpl = pause,
  now = () => Date.now(),
  temporaryParent,
  budgetCapUsd = CORE007_BUDGET_CAP_USD,
  budgetMilestone = 'CORE007',
  imageReservationUsd = CORE007_IMAGE_RESERVATION_USD,
  statusTimeoutMs = 30_000,
  ensureConfigured = async () => {},
  resolveProviderResult = resolveProviderResultImage,
} = {}) => {
  if (!evolinkClient || !budgetLedger) throw new TypeError('CORE007 service requires Provider and budget ledger.');
  if (!['CORE007', 'CORE008', 'CORE009'].includes(budgetMilestone)) throw new TypeError('Reference budget milestone must be CORE007, CORE008 or CORE009.');
  const sessions = new Map();
  const results = new Map();
  const budgetCode = (suffix) => `${budgetMilestone}_${suffix}`;
  const budgetLabel = budgetMilestone.replace('CORE', 'CORE-');

  const settle = async (reservationId, actualUsd) => {
    try {
      return await budgetLedger.settle({ id: reservationId, actualUsd });
    } catch (error) {
      if (error instanceof PlannerBudgetLedgerError) throw referenceFailure(503, budgetCode('BUDGET_LEDGER_UNAVAILABLE'), `${budgetLabel} 预算账本不可用。`, false);
      throw error;
    }
  };

  return {
    getBudgetStatus() {
      try {
        return budgetLedger.getStatusSync({ capUsd: budgetCapUsd, reservationPerAttemptUsd: imageReservationUsd });
      } catch {
        throw referenceFailure(503, budgetCode('BUDGET_LEDGER_UNAVAILABLE'), `${budgetLabel} 预算账本不可用。`, false);
      }
    },

    async create({ clientJobId, clientReferenceSha256, prompt, sanitized, consentVersion, signal }) {
      validateCreateInput({ clientJobId, clientReferenceSha256, prompt, sanitized, consentVersion });
      if (sessions.has(clientJobId)) throw referenceFailure(409, 'CORE007_JOB_EXISTS', '本地 Job ID 已存在。', false);
      await ensureConfigured();
      let reservation;
      try {
        reservation = await budgetLedger.reserve({ capUsd: budgetCapUsd, amountUsd: imageReservationUsd });
      } catch (error) {
        if (error instanceof PlannerBudgetExceededError) throw referenceFailure(402, budgetCode('BUDGET_EXCEEDED'), `${budgetLabel} 的 ${budgetCapUsd} 美元里程碑预算已达到上限。`, false);
        if (error instanceof PlannerBudgetLedgerError) throw referenceFailure(503, budgetCode('BUDGET_LEDGER_UNAVAILABLE'), `${budgetLabel} 预算账本不可用。`, false);
        throw error;
      }

      const startedAt = now();
      const session = {
        clientJobId,
        status: 'uploading',
        progress: 40,
        cancelled: false,
        createdAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(startedAt).toISOString(),
        reservationId: reservation.id,
        budgetUsedUsd: reservation.usedUsd,
        uploadRetryCount: 0,
        statusRetryCount: 0,
        providerSubmitCount: 0,
        clientReferenceSha256,
        referenceSha256: sanitized.sha256,
        referenceWidth: sanitized.width,
        referenceHeight: sanitized.height,
        providerCompleted: false,
      };
      sessions.set(clientJobId, session);
      let generationSubmitted = false;
      try {
        assertNotCancelled(signal, session);
        const upload = await evolinkClient.uploadReferenceImage({
          buffer: sanitized.buffer,
          mimeType: sanitized.mimeType,
          filename: sanitized.serverFilename,
          signal,
        });
        session.uploadRetryCount = upload.retryCount;
        session.uploadHttpStatus = upload.httpStatus;
        session.status = 'submitted';
        session.progress = 65;
        session.updatedAt = new Date(now()).toISOString();
        assertNotCancelled(signal, session);

        generationSubmitted = true;
        session.providerSubmitCount += 1;
        const task = await evolinkClient.createUploadedReferenceEditJob({
          prompt,
          referenceUrl: upload.fileUrl,
          size: '1:1',
          quality: 'medium',
          n: 1,
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]),
        });
        // The temporary upload URL is deliberately not retained after submit.
        const taskId = requireTaskId(task?.id);
        session.generationHttpStatus = task?.httpStatus;
        session.providerTaskId = taskId;
        session.providerTaskIdSha256 = sha256(taskId);
        session.status = 'processing';
        session.progress = 72;
        session.updatedAt = new Date(now()).toISOString();
        const settled = await settle(reservation.id, null);
        session.budgetUsedUsd = settled.usedUsd;
        return publicSession(session, { budgetCapUsd });
      } catch (error) {
        const cancelled = signal?.aborted || session.cancelled;
        const settlement = await settle(reservation.id, generationSubmitted ? null : 0);
        session.budgetUsedUsd = settlement.usedUsd;
        session.status = cancelled ? 'user_cancelled' : 'failed';
        session.progress = cancelled ? session.progress : 0;
        session.updatedAt = new Date(now()).toISOString();
        session.error = cancelled ? { code: 'CORE007_USER_CANCELLED', message: softCancelMessage(), retryable: false } : safeProviderError(error);
        if (cancelled) throw referenceFailure(499, 'CORE007_USER_CANCELLED', softCancelMessage(), false);
        if (error instanceof ReferenceJobError) throw error;
        const safe = session.error;
        throw referenceFailure(httpStatusFor(error), safe.code, safe.message, safe.retryable);
      }
    },

    async status(clientJobId, { signal } = {}) {
      const session = requireSession(sessions, clientJobId);
      if (session.cancelled || session.status === 'user_cancelled') return publicSession(session, { budgetCapUsd });
      if (['completed', 'failed', 'local_result_pending'].includes(session.status)) return publicSession(session, { budgetCapUsd });
      if (!session.providerTaskId) return publicSession(session, { budgetCapUsd });
      return refreshProviderStatus(session, { signal });
    },

    async retryLocalResult(clientJobId, { signal } = {}) {
      const session = requireSession(sessions, clientJobId);
      if (session.cancelled || session.status === 'user_cancelled') return publicSession(session, { budgetCapUsd });
      if (session.status !== 'local_result_pending' || !session.providerTaskId || !session.providerCompleted) {
        throw referenceFailure(409, 'CORE007_LOCAL_RESULT_RETRY_INVALID', '当前任务没有可单独重取的 Provider 结果。', false);
      }
      session.status = 'processing';
      session.progress = Math.max(92, session.progress);
      delete session.error;
      return refreshProviderStatus(session, { signal, localResultRetry: true });
    },

    async retryStatus(clientJobId, { signal } = {}) {
      const session = requireSession(sessions, clientJobId);
      if (session.cancelled || session.status === 'user_cancelled') return publicSession(session, { budgetCapUsd });
      if (session.status !== 'failed' || session.retryScope !== 'status-only' || !session.providerTaskId || session.providerCompleted) {
        throw referenceFailure(409, 'CORE007_STATUS_RETRY_INVALID', '当前任务没有可安全重查的既有 Provider 状态。', false);
      }
      session.status = 'processing';
      session.progress = Math.max(72, session.progress);
      session.retryScope = 'none';
      delete session.error;
      return refreshProviderStatus(session, { signal });
    },

    cancel(clientJobId) {
      const session = requireSession(sessions, clientJobId);
      if (session.status === 'completed') throw referenceFailure(409, 'CORE007_ALREADY_COMPLETED', '任务已完成，不能标记为软取消。', false);
      session.cancelled = true;
      session.statusRequestController?.abort(new Error('CORE007_LOCAL_SOFT_CANCEL'));
      session.status = 'user_cancelled';
      session.error = { code: 'CORE007_USER_CANCELLED', message: softCancelMessage(), retryable: false };
      session.updatedAt = new Date(now()).toISOString();
      delete session.providerTaskId;
      if (session.resultId) results.delete(session.resultId);
      delete session.resultId;
      return publicSession(session, { budgetCapUsd });
    },

    result(resultId) {
      if (!RESULT_ID.test(resultId)) throw referenceFailure(400, 'CORE007_RESULT_ID_INVALID', '本地结果 ID 无效。', false);
      const result = results.get(resultId);
      if (!result) throw referenceFailure(404, 'CORE007_RESULT_NOT_FOUND', '本地结果已不存在。', false);
      const session = sessions.get(result.clientJobId);
      if (!session || session.cancelled || session.status !== 'completed') throw referenceFailure(410, 'CORE007_RESULT_UNAVAILABLE', '本地结果不可用。', false);
      return result;
    },

    evidence(clientJobId) {
      const session = requireSession(sessions, clientJobId);
      return {
        clientJobIdSha256: sha256(clientJobId),
        providerTaskIdSha256: session.providerTaskIdSha256,
        status: session.status,
        uploadRetryCount: session.uploadRetryCount,
        statusRetryCount: session.statusRetryCount,
        providerSubmitCount: session.providerSubmitCount,
        uploadHttpStatus: session.uploadHttpStatus,
        generationHttpStatus: session.generationHttpStatus,
        taskStatusHttpStatus: session.taskStatusHttpStatus,
        clientReferenceSha256: session.clientReferenceSha256,
        referenceSha256: session.referenceSha256,
        referenceDimensions: [session.referenceWidth, session.referenceHeight],
        resultSha256: session.resultSha256,
        resultDimensions: session.resultWidth ? [session.resultWidth, session.resultHeight] : undefined,
        resultBytes: Number.isFinite(session.resultBytes) ? session.resultBytes : undefined,
        budgetCapUsd,
        budgetUsedUsd: session.budgetUsedUsd,
        softCancelled: session.cancelled,
        startedAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    },
  };

  async function refreshProviderStatus(session, { signal, localResultRetry = false } = {}) {
    if (session.statusRequestController) return publicSession(session, { budgetCapUsd });
    let task;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (session.cancelled) return publicSession(session, { budgetCapUsd });
      const controller = new AbortController();
      session.statusRequestController = controller;
      const timeoutSignal = AbortSignal.timeout(statusTimeoutMs);
      const requestSignal = AbortSignal.any([controller.signal, timeoutSignal, ...(signal ? [signal] : [])]);
      try {
        task = await evolinkClient.getTask(session.providerTaskId, { signal: requestSignal });
        session.taskStatusHttpStatus = task?.httpStatus;
        break;
      } catch (error) {
        if (session.cancelled) return publicSession(session, { budgetCapUsd });
        if (isRetryableStatusError(error) && attempt === 0) {
          session.statusRetryCount += 1;
          await sleepImpl(250);
          continue;
        }
        session.error = statusQueryError(error, Boolean(localResultRetry && session.providerCompleted));
        session.status = localResultRetry && session.providerCompleted && session.error.retryable ? 'local_result_pending' : 'failed';
        session.retryScope = session.error.retryable ? (localResultRetry && session.providerCompleted ? 'local-result' : 'status-only') : 'none';
        session.updatedAt = new Date(now()).toISOString();
        return publicSession(session, { budgetCapUsd });
      } finally {
        if (session.statusRequestController === controller) delete session.statusRequestController;
      }
    }

    if (session.cancelled) return publicSession(session, { budgetCapUsd });
    if (task?.status === 'failed') {
      session.status = 'failed';
      session.error = classifyTaskFailure(task);
      session.retryScope = session.error.retryable ? 'new-provider-job' : 'none';
    } else if (task?.status === 'completed') {
      session.providerCompleted = true;
      try {
        const sanitizedResult = await resolveProviderResult(task, { requestImpl, lookupImpl, signal, temporaryParent });
        if (session.cancelled) return publicSession(session, { budgetCapUsd });
        const resultId = `result-${randomUUID().replaceAll('-', '')}`;
        results.set(resultId, { ...sanitizedResult, clientJobId: session.clientJobId, createdAt: new Date(now()).toISOString() });
        session.resultId = resultId;
        session.resultSha256 = sanitizedResult.sha256;
        session.resultWidth = sanitizedResult.width;
        session.resultHeight = sanitizedResult.height;
        session.resultBytes = sanitizedResult.bytes;
        session.status = 'completed';
        session.progress = 100;
        session.retryScope = 'none';
        delete session.error;
        delete session.providerTaskId;
      } catch (error) {
        const safe = safeProviderError(error);
        session.status = safe.retryable ? 'local_result_pending' : 'failed';
        session.error = safe.retryable
          ? { ...safe, message: 'Provider 已完成生成，但本地结果尚未取回；只能重试本地取回，不会再次提交付费生成。' }
          : safe;
        session.retryScope = safe.retryable ? 'local-result' : 'none';
      }
    } else {
      session.status = 'processing';
      session.progress = Math.min(96, Math.max(session.progress, Number.isFinite(task?.progress) ? Math.round(task.progress) : 78));
      session.retryScope = 'none';
    }
    session.updatedAt = new Date(now()).toISOString();
    return publicSession(session, { budgetCapUsd });
  }
};

const validateCreateInput = ({ clientJobId, clientReferenceSha256, prompt, sanitized, consentVersion }) => {
  if (!CLIENT_JOB_ID.test(clientJobId)) throw referenceFailure(400, 'CORE007_JOB_ID_INVALID', '本地 Job ID 无效。', false);
  if (typeof clientReferenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(clientReferenceSha256)) throw referenceFailure(400, 'CORE007_REFERENCE_DIGEST_INVALID', '参考图上传摘要无效。', false);
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32_000) throw referenceFailure(400, 'CORE007_PROMPT_INVALID', '图片编辑指令必须为 1–32000 个字符。', false);
  if (consentVersion !== 'CORE-007-DATA-BOUNDARY-V1') throw referenceFailure(400, 'CORE007_CONSENT_REQUIRED', '必须先确认图片外传与最长 72 小时留存边界。', false);
  if (!sanitized || !Buffer.isBuffer(sanitized.buffer) || sanitized.mimeType !== 'image/png') throw referenceFailure(400, 'CORE007_REFERENCE_INVALID', '服务端未获得有效的已清理参考图。', false);
};

const requireTaskId = (value) => {
  if (typeof value !== 'string' || !/^task-unified-[A-Za-z0-9_-]+$/.test(value)) throw referenceFailure(502, 'EVOLINK_CREATE_SCHEMA_INVALID', 'EvoLink 未返回有效任务标识。', false);
  return value;
};
const requireSession = (sessions, clientJobId) => {
  if (!CLIENT_JOB_ID.test(clientJobId)) throw referenceFailure(400, 'CORE007_JOB_ID_INVALID', '本地 Job ID 无效。', false);
  const session = sessions.get(clientJobId);
  if (!session) throw referenceFailure(404, 'CORE007_JOB_NOT_FOUND', '本地 Job 不存在。', false);
  return session;
};
const assertNotCancelled = (signal, session) => {
  if (signal?.aborted || session.cancelled) throw referenceFailure(499, 'CORE007_USER_CANCELLED', softCancelMessage(), false);
};
const publicSession = (session, { budgetCapUsd }) => ({
  localJobId: session.clientJobId,
  status: session.status,
  progress: session.progress,
  retryCount: session.uploadRetryCount + session.statusRetryCount,
  ...(session.resultId ? { resultId: session.resultId } : {}),
  ...(session.resultWidth ? { result: { mimeType: 'image/png', width: session.resultWidth, height: session.resultHeight, bytes: resultsSafeBytes(session) } } : {}),
  ...(session.error ? { error: session.error } : {}),
  retryScope: session.retryScope ?? 'none',
  providerCompleted: Boolean(session.providerCompleted),
  budget: { capUsd: budgetCapUsd, usedUsd: session.budgetUsedUsd ?? 0, conservativeReservationUsd: CORE007_IMAGE_RESERVATION_USD },
  retention: { providerUploadExpiresWithinHours: 72, earlyDeleteProven: false },
});
const resultsSafeBytes = (session) => Number.isFinite(session.resultBytes) ? session.resultBytes : undefined;

const extractResultUrl = (task) => {
  const candidates = [task?.results?.[0], task?.data?.results?.[0], task?.result_urls?.[0]];
  const value = candidates.find((item) => typeof item === 'string');
  if (!value) throw referenceFailure(502, 'EVOLINK_RESULT_SCHEMA_INVALID', 'EvoLink 任务未返回可下载结果。', false);
  return value;
};

/**
 * Shared server-only boundary for every EvoLink image result. The temporary
 * Provider URL is consumed here and is never returned to browser code.
 */
export const resolveProviderResultImage = async (task, {
  requestImpl = httpsRequest,
  lookupImpl = (hostname) => lookupDns(hostname, { all: true, verbatim: true }),
  signal,
  temporaryParent,
} = {}) => {
  const remoteUrl = extractResultUrl(task);
  const downloaded = await downloadImage(remoteUrl, { requestImpl, lookupImpl, signal });
  return sanitizeProviderResultImage({ buffer: downloaded.buffer, mimeType: downloaded.mimeType, temporaryParent });
};

const downloadImage = async (initialUrl, { requestImpl, lookupImpl, signal }) => {
  let current = await assertSafeExternalUrl(initialUrl, lookupImpl);
  for (let redirects = 0; redirects < 3; redirects += 1) {
    const response = await pinnedHttpsGet(current, { requestImpl, signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = headerValue(response.headers, 'location');
      if (!location) throw referenceFailure(502, 'EVOLINK_RESULT_REDIRECT_INVALID', 'Provider 结果重定向无效。', false);
      current = await assertSafeExternalUrl(new URL(location, current.url).toString(), lookupImpl);
      continue;
    }
    if (!response.ok) throw referenceFailure(response.status, 'EVOLINK_RESULT_DOWNLOAD_FAILED', 'Provider 结果下载失败。', RETRYABLE(response.status));
    const length = Number(headerValue(response.headers, 'content-length'));
    if (Number.isFinite(length) && length > MAX_RESULT_BYTES) throw referenceFailure(502, 'EVOLINK_RESULT_TOO_LARGE', 'Provider 结果超过本地限制。', false);
    const mimeType = headerValue(response.headers, 'content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    // Some object-storage CDNs omit Content-Type or return the generic binary
    // type. Those responses are still untrusted: the shared sanitizer must
    // uniquely identify PNG/JPEG/WebP by strict structure and then decode and
    // re-encode it before any byte reaches the browser.
    if (![ '', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/webp' ].includes(mimeType)) {
      throw referenceFailure(502, 'EVOLINK_RESULT_MIME_INVALID', 'Provider 结果类型无效。', false);
    }
    if (!response.buffer.length) throw referenceFailure(502, 'EVOLINK_RESULT_EMPTY', 'Provider 结果为空。', false);
    return { buffer: response.buffer, mimeType };
  }
  throw referenceFailure(502, 'EVOLINK_RESULT_REDIRECT_LIMIT', 'Provider 结果重定向次数过多。', false);
};

const assertSafeExternalUrl = async (value, lookupImpl) => {
  let url;
  try { url = new URL(value); } catch { throw referenceFailure(502, 'EVOLINK_RESULT_URL_INVALID', 'Provider 结果 URL 无效。', false); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw referenceFailure(502, 'EVOLINK_RESULT_URL_INVALID', 'Provider 结果 URL 必须是无凭据的 HTTPS 地址。', false);
  const hostname = unbracketHostname(url.hostname);
  const directFamily = isIP(hostname);
  let addresses;
  try {
    addresses = directFamily ? [{ address: hostname, family: directFamily }] : await lookupImpl(hostname);
  } catch {
    throw referenceFailure(502, 'EVOLINK_RESULT_DNS_UNAVAILABLE', 'Provider 结果地址暂时无法解析。', true);
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !isAllowedResolvedAddress(hostname, address))) throw referenceFailure(502, 'EVOLINK_RESULT_NETWORK_BOUNDARY', 'Provider 结果 URL 指向不允许的网络地址。', false);
  const selected = addresses[0];
  return { url, hostname, address: selected.address, family: normalizeFamily(selected.family, selected.address) };
};

const pinnedHttpsGet = (target, { requestImpl, signal }) => new Promise((resolve, reject) => {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const requestSignal = AbortSignal.any([timeoutSignal, ...(signal ? [signal] : [])]);
  const { url, hostname, address, family } = target;
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    callback(value);
  };
  const request = requestImpl({
    protocol: 'https:',
    hostname,
    port: 443,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    servername: hostname,
    rejectUnauthorized: true,
    headers: { Host: hostname, Accept: 'image/png,image/jpeg,image/webp' },
    signal: requestSignal,
    lookup(_hostname, options, callback) {
      const done = typeof options === 'function' ? options : callback;
      const settings = typeof options === 'object' && options ? options : {};
      if (settings.all) done(null, [{ address, family }]);
      else done(null, address, family);
    },
  }, async (response) => {
    try {
      const status = Number(response.statusCode ?? 0);
      const headers = response.headers ?? {};
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume?.();
        finish(resolve, { status, ok: false, headers, buffer: Buffer.alloc(0) });
        return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response) {
        const part = Buffer.from(chunk);
        bytes += part.length;
        if (bytes > MAX_RESULT_BYTES) {
          response.destroy?.();
          throw referenceFailure(502, 'EVOLINK_RESULT_TOO_LARGE', 'Provider 结果超过本地限制。', false);
        }
        chunks.push(part);
      }
      finish(resolve, { status, ok: status >= 200 && status < 300, headers, buffer: Buffer.concat(chunks) });
    } catch (error) {
      finish(reject, error);
    }
  });
  request.once('error', (error) => finish(reject, referenceFailure(502, 'EVOLINK_RESULT_NETWORK_ERROR', 'Provider 结果下载网络失败。', true)));
  request.end();
});

const headerValue = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined;
};

const unbracketHostname = (hostname) => hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
const normalizeFamily = (family, address) => family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : isIP(address);

const isGloballyRoutableAddress = (address) => {
  const family = isIP(address);
  if (family === 4) return isGlobalIpv4(address);
  if (family === 6) return isGlobalIpv6(address);
  return false;
};

// Some macOS proxy clients expose DNS fake-IP answers from RFC 2544's
// 198.18.0.0/15 benchmark range. Refusing every such answer made EvoLink's
// official result host impossible to consume even though HTTPS still verifies
// files.evolink.ai and the request pins that single answer. Permit only this
// exact Provider hostname/range pair; IP literals and every other hostname
// remain subject to the ordinary globally-routable boundary.
const isAllowedResolvedAddress = (hostname, address) => isGloballyRoutableAddress(address)
  || (hostname === EVOLINK_RESULT_HOSTNAME && isEvoLinkProxySyntheticIpv4(address));

const isEvoLinkProxySyntheticIpv4 = (address) => {
  const parts = address.split('.').map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 198
    && (parts[1] === 18 || parts[1] === 19);
};

const isGlobalIpv4 = (address) => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const value = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
  const inRange = (base, bits) => (value >>> (32 - bits)) === (base >>> (32 - bits));
  const ranges = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
    [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16],
    [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ];
  return !ranges.some(([base, bits]) => inRange(base, bits));
};

const isGlobalIpv6 = (address) => {
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // Only globally-routable unicast (2000::/3) is eligible; explicitly reject
  // documentation, benchmarking, translation and transition sub-ranges.
  if ((value >> 125n) !== 1n) return false;
  const inRange = (base, bits) => (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
  return ![
    [0x20010000000000000000000000000000n, 23],
    [0x20010200000000000000000000000000n, 48],
    [0x20010db8000000000000000000000000n, 32],
    [0x20020000000000000000000000000000n, 16],
    [0x3fff0000000000000000000000000000n, 20],
  ].some(([base, bits]) => inRange(base, bits));
};

const ipv6ToBigInt = (address) => {
  if (address.includes('%')) return null;
  let input = address.toLowerCase();
  const ipv4Tail = input.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const parts = ipv4Tail.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    input = `${input.slice(0, -ipv4Tail.length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
};

const safeProviderError = (error) => {
  if (error instanceof ReferenceJobError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof ReferenceImageError) return { code: error.code, message: '图片无法通过安全验证。', retryable: false };
  if (error instanceof EvoLinkHttpError) return { code: safeCode(error.code, 'EVOLINK_REQUEST_FAILED'), message: safeProviderStatusMessage(error.status), retryable: RETRYABLE(error.status) };
  return { code: 'CORE007_PROVIDER_NETWORK_ERROR', message: '本机服务无法完成图片任务；若生成请求已发出，可能已经产生费用。', retryable: false };
};

const isRetryableStatusError = (error) => (error instanceof EvoLinkHttpError && RETRYABLE(error.status))
  || error?.name === 'TimeoutError'
  || error?.name === 'TypeError'
  || /^UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET|CONNECT)$/.test(String(error?.cause?.code ?? error?.code ?? ''));

const statusQueryError = (error, localResultOnly) => {
  const base = safeProviderError(error);
  if (isRetryableStatusError(error)) {
    return {
      code: localResultOnly ? 'CORE007_LOCAL_RESULT_STATUS_UNAVAILABLE' : 'CORE007_STATUS_UNAVAILABLE',
      message: localResultOnly ? 'Provider 已完成生成，但本地暂时无法重新查询结果；只能重试本地取回。' : 'EvoLink 任务状态暂时无法查询。',
      retryable: true,
    };
  }
  return base;
};

const classifyTaskFailure = (task) => {
  const rawCode = task?.error?.code;
  const code = safeCode(rawCode, 'EVOLINK_TASK_FAILED');
  const status = Number(task?.error?.status ?? task?.error?.http_status ?? task?.status_code);
  const explicitlyTransient = status === 429
    || status >= 500
    || /^(?:RATE_LIMIT(?:ED)?|TOO_MANY_REQUESTS|NETWORK_ERROR|STATUS_NETWORK_ERROR|STATUS_TIMEOUT|UPSTREAM_UNAVAILABLE|SERVICE_UNAVAILABLE|INTERNAL_SERVER_ERROR|GATEWAY_TIMEOUT)$/.test(code);
  const explicitlyTerminal = status === 400
    || status === 401
    || status === 402
    || status === 403
    || /(?:AUTH|UNAUTHORIZED|FORBIDDEN|BALANCE|PAYMENT|QUOTA|PARAM|INVALID|SCHEMA|SAFETY|CONTENT_POLICY|MODERATION|REJECT)/.test(code);
  const retryable = explicitlyTransient && !explicitlyTerminal;
  const message = retryable
    ? 'EvoLink 图片编辑任务因明确的临时状态失败；确认额外费用后可创建新的 Provider Job。'
    : 'EvoLink 图片编辑任务被拒绝或永久失败；不会建议自动或重复付费重试。';
  return { code, message, retryable };
};
const safeProviderStatusMessage = (status) => status === 400 ? 'EvoLink 拒绝了图片任务参数。' : status === 401 || status === 403 ? 'EvoLink 图片服务鉴权失败。' : status === 402 ? 'EvoLink 账户余额不足。' : status === 429 ? 'EvoLink 请求过于频繁。' : status >= 500 ? 'EvoLink 图片服务暂时不可用。' : 'EvoLink 拒绝了图片任务。';
const safeCode = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_-]{1,80}$/.test(value) ? value : fallback;
const httpStatusFor = (error) => error instanceof EvoLinkHttpError ? error.status : error instanceof ReferenceImageError ? 422 : 502;
const softCancelMessage = () => '已停止本地等待并忽略迟到结果；不代表远端任务已取消、退款或提前删除。';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const referenceFailure = (status, code, message, retryable) => new ReferenceJobError(status, code, message, retryable);

export class ReferenceJobError extends Error {
  constructor(status, code, message, retryable) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}
