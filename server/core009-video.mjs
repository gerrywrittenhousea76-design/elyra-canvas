import { createHash, randomUUID } from 'node:crypto';
import { ClientInputError, EvoLinkHttpError } from './evolink.mjs';
import { PlannerBudgetExceededError, PlannerBudgetLedgerError } from './planner-budget.mjs';
import { normalizeCore009VideoReferencePng } from './reference-image.mjs';

export const CORE009_BUDGET_CAP_USD = 5;
export const CORE009_GENERATION_RESERVATION_USD = 1;
export const CORE009_VIDEO_DURATION_SECONDS = 4;

const CLIENT_JOB_ID = /^job-[A-Za-z0-9_-]{1,190}$/;
const DOMAIN_ID = /^[A-Za-z0-9_-]{1,200}$/;
const TASK_ID = /^task-unified-[A-Za-z0-9_-]+$/;
const RESULT_ID = /^video-result-[a-f0-9]{32}$/;
const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
const STATUS_QUERY_TIMEOUT_MS = 15_000;
const RESULT_DOWNLOAD_TIMEOUT_MS = 60_000;

export class Core009VideoError extends Error {
  constructor(status, code, message, retryable = false, retryScope = 'none') {
    super(message);
    this.name = 'Core009VideoError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryScope = retryScope;
  }
}

export const createCore009VideoGateway = ({
  evolinkClient,
  budgetLedger,
  ensureConfigured,
  resolveProviderResult = resolveProviderVideo,
  normalizeVideoReference = normalizeCore009VideoReferencePng,
  budgetCapUsd = CORE009_BUDGET_CAP_USD,
  reservationUsd = CORE009_GENERATION_RESERVATION_USD,
  model = 'sora-2-preview',
  now = () => Date.now(),
  createResultId = () => `video-result-${randomUUID().replaceAll('-', '')}`,
  scheduleTimeout = setTimeout,
  cancelScheduledTimeout = clearTimeout,
} = {}) => {
  if (!evolinkClient || !budgetLedger || typeof ensureConfigured !== 'function' || typeof normalizeVideoReference !== 'function') {
    throw new TypeError('CORE009 video gateway requires Provider, ledger and configuration preflight.');
  }
  const sessions = new Map();
  const results = new Map();

  const budgetStatus = () => {
    try {
      return budgetLedger.getStatusSync({ capUsd: budgetCapUsd, reservationPerAttemptUsd: reservationUsd });
    } catch (error) {
      throw mapLedgerError(error);
    }
  };

  return Object.freeze({
    getBudgetStatus: budgetStatus,

    async create(input, { signal } = {}) {
      const normalized = validateCreateInput(input);
      const requestSha256 = sha256Json({
        version: 1,
        clientJobId: normalized.clientJobId, model, reservationUsd,
        prompt: normalized.prompt,
        sourceObjectId: normalized.sourceObjectId,
        sourceAssetId: normalized.sourceAssetId,
        sourceVersionId: normalized.sourceVersionId,
        referenceSha256: normalized.sanitized.sha256,
        referenceDimensions: [normalized.sanitized.width, normalized.sanitized.height],
      });
      const existing = sessions.get(normalized.clientJobId);
      if (existing) {
        if (existing.requestSha256 !== requestSha256) throw failure(409, 'CORE009_JOB_BINDING_CONFLICT', '本地 Job ID 已绑定其他视频请求。');
        if (existing.promise) return existing.promise;
        return publicSession(existing, budgetCapUsd);
      }

      const startedAt = now();
      const session = {
        clientJobId: normalized.clientJobId,
        requestSha256,
        sourceObjectId: normalized.sourceObjectId,
        sourceAssetId: normalized.sourceAssetId,
        sourceVersionId: normalized.sourceVersionId,
        sourceSha256: normalized.sanitized.sha256,
        status: 'preparing',
        progress: 20,
        cancelled: false,
        providerSubmitCount: 0,
        statusRequestCount: 0,
        createdAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(startedAt).toISOString(),
      };
      sessions.set(normalized.clientJobId, session);

      let attempt;
      attempt = submitOnce(session, normalized, signal).finally(() => {
        if (session.promise === attempt) delete session.promise;
      });
      session.promise = attempt;
      return attempt;
    },

    async status(clientJobId, { signal } = {}) {
      const session = requireSession(sessions, clientJobId);
      if (session.cancelled || ['completed', 'failed', 'local_result_pending'].includes(session.status)) return publicSession(session, budgetCapUsd);
      if (!session.providerTaskId) return publicSession(session, budgetCapUsd);
      session.statusRequestCount += 1;
      let task;
      try {
        task = await runBoundedOperation(
          (boundedSignal) => evolinkClient.getTask(session.providerTaskId, { signal: boundedSignal }),
          {
            signal,
            timeoutMs: STATUS_QUERY_TIMEOUT_MS,
            scheduleTimeout,
            cancelScheduledTimeout,
            cancelError: () => failure(499, 'CORE009_VIDEO_STATUS_CANCELLED', '已停止本地状态查询；不代表远端任务已取消。'),
            timeoutError: () => failure(504, 'CORE009_VIDEO_STATUS_TIMEOUT', '视频任务状态查询超时。', true),
          },
        );
      } catch (error) {
        if (error instanceof Core009VideoError && error.code === 'CORE009_VIDEO_STATUS_CANCELLED') throw error;
        const timedOut = error instanceof Core009VideoError && error.code === 'CORE009_VIDEO_STATUS_TIMEOUT';
        const retryable = timedOut || isRetryable(error);
        session.status = 'failed';
        session.error = {
          code: timedOut ? 'CORE009_VIDEO_STATUS_TIMEOUT' : retryable ? 'CORE009_VIDEO_STATUS_UNAVAILABLE' : 'CORE009_VIDEO_STATUS_REJECTED',
          message: timedOut ? '视频任务状态查询超时；只会重查原任务。' : retryable ? '视频任务状态暂时无法查询；只会重查原任务。' : '视频任务状态查询被拒绝。',
          retryable,
          retryScope: retryable ? 'status-only' : 'none',
        };
        session.updatedAt = new Date(now()).toISOString();
        return publicSession(session, budgetCapUsd);
      }
      if (session.cancelled) return publicSession(session, budgetCapUsd);
      if (task?.status === 'failed') {
        session.status = 'failed';
        session.error = classifyTaskFailure(task);
      } else if (task?.status === 'completed') {
        session.providerCompleted = true;
        session.providerCompletedTask = task;
        session.progress = 94;
        try {
          const video = await resolveProviderResult(task, { signal });
          if (session.cancelled) return publicSession(session, budgetCapUsd);
          const resultId = createResultId();
          if (!RESULT_ID.test(resultId) || results.has(resultId)) throw failure(500, 'CORE009_VIDEO_RESULT_ID_INVALID', '无法创建唯一视频结果标识。');
          results.set(resultId, { ...video, clientJobId: session.clientJobId });
          session.resultId = resultId;
          session.result = { mimeType: 'video/mp4', bytes: video.bytes, durationSeconds: video.durationSeconds, sha256: video.sha256, width: video.width, height: video.height };
          session.status = 'completed';
          session.progress = 100;
          delete session.error;
          delete session.providerTaskId;
          delete session.providerCompletedTask;
        } catch (error) {
          session.status = 'local_result_pending';
          session.error = {
            code: error instanceof Core009VideoError ? error.code : 'CORE009_VIDEO_RESULT_INVALID',
            message: 'Provider 已完成生成，但本地 MP4 尚未通过验证；不会再次提交付费生成。',
            retryable: true,
            retryScope: 'local-result',
          };
        }
      } else {
        session.status = task?.status === 'processing' ? 'processing' : 'pending';
        session.progress = safeProgress(task?.progress, 72);
      }
      session.updatedAt = new Date(now()).toISOString();
      return publicSession(session, budgetCapUsd);
    },

    cancel(clientJobId) {
      const session = requireSession(sessions, clientJobId);
      if (session.status === 'completed') throw failure(409, 'CORE009_VIDEO_ALREADY_COMPLETED', '已完成的视频任务不能软取消。');
      session.cancelled = true;
      session.status = 'user_cancelled';
      session.progress = 0;
      session.error = { code: 'CORE009_VIDEO_SOFT_CANCELLED', message: softCancelMessage(), retryable: false, retryScope: 'none' };
      session.updatedAt = new Date(now()).toISOString();
      if (session.resultId) results.delete(session.resultId);
      delete session.resultId;
      delete session.result;
      return publicSession(session, budgetCapUsd);
    },

    async retryLocalResult(clientJobId, { signal } = {}) {
      const session = requireSession(sessions, clientJobId);
      if (session.cancelled || session.status === 'user_cancelled') return publicSession(session, budgetCapUsd);
      if (session.status !== 'local_result_pending' || !session.providerCompletedTask) throw failure(409, 'CORE009_VIDEO_LOCAL_RETRY_INVALID', '当前任务没有可重取的已完成 Provider 结果。');
      try {
        const video = await resolveProviderResult(session.providerCompletedTask, { signal });
        const resultId = createResultId();
        if (!RESULT_ID.test(resultId) || results.has(resultId)) throw failure(500, 'CORE009_VIDEO_RESULT_ID_INVALID', '无法创建唯一视频结果标识。');
        results.set(resultId, { ...video, clientJobId: session.clientJobId });
        session.resultId = resultId;
        session.result = { mimeType: 'video/mp4', bytes: video.bytes, durationSeconds: video.durationSeconds, sha256: video.sha256, width: video.width, height: video.height };
        session.status = 'completed';
        session.progress = 100;
        delete session.error;
        delete session.providerCompletedTask;
      } catch (error) {
        session.error = { code: error instanceof Core009VideoError ? error.code : 'CORE009_VIDEO_RESULT_INVALID', message: 'Provider 已完成生成，本地 MP4 仍未通过验证；不会重提付费任务。', retryable: true, retryScope: 'local-result' };
      }
      session.updatedAt = new Date(now()).toISOString();
      return publicSession(session, budgetCapUsd);
    },

    async retryStatus(clientJobId, { signal } = {}) {
      const session = requireSession(sessions, clientJobId);
      if (session.cancelled || session.status === 'user_cancelled') return publicSession(session, budgetCapUsd);
      if (session.status !== 'failed' || session.error?.retryScope !== 'status-only' || !session.providerTaskId) throw failure(409, 'CORE009_VIDEO_STATUS_RETRY_INVALID', '当前任务没有可安全重查的原 Provider 任务。');
      session.status = 'pending';
      session.progress = Math.max(66, session.progress);
      delete session.error;
      return this.status(clientJobId, { signal });
    },

    evidence(clientJobId) {
      const session = requireSession(sessions, clientJobId);
      return {
        clientJobIdSha256: sha256(clientJobId),
        requestSha256: session.requestSha256,
        sourceSha256: session.sourceSha256,
        uploadSha256: session.uploadSha256,
        referenceAspectRatio: session.referenceAspectRatio,
        providerTaskIdSha256: session.providerTaskIdSha256,
        providerSubmitCount: session.providerSubmitCount,
        statusRequestCount: session.statusRequestCount,
        status: session.status,
        resultSha256: session.result?.sha256,
        resultBytes: session.result?.bytes,
        resultDurationSeconds: session.result?.durationSeconds,
        resultDimensions: session.result ? [session.result.width, session.result.height] : undefined,
        budgetCapUsd,
        budgetUsedUsd: session.budgetUsedUsd ?? 0,
        softCancelled: session.cancelled,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    },

    result(resultId) {
      if (!RESULT_ID.test(resultId)) throw failure(400, 'CORE009_VIDEO_RESULT_ID_INVALID', '本地视频结果 ID 无效。');
      const result = results.get(resultId);
      if (!result) throw failure(404, 'CORE009_VIDEO_RESULT_NOT_FOUND', '本地视频结果已不存在。');
      const session = sessions.get(result.clientJobId);
      if (!session || session.cancelled || session.status !== 'completed' || session.resultId !== resultId) throw failure(410, 'CORE009_VIDEO_RESULT_UNAVAILABLE', '本地视频结果不可用。');
      return result;
    },
  });

  async function submitOnce(session, input, signal) {
    try {
      await ensureConfigured();
    } catch {
      sessions.delete(session.clientJobId);
      throw failure(503, 'CORE009_VIDEO_NOT_CONFIGURED', '本机服务未配置视频 Provider 凭据。');
    }
    let reservation;
    try {
      reservation = await budgetLedger.reserve({ capUsd: budgetCapUsd, amountUsd: reservationUsd });
    } catch (error) {
      sessions.delete(session.clientJobId);
      throw mapLedgerError(error);
    }
    let generationMayHaveSubmitted = false;
    try {
      assertNotCancelled(signal, session);
      session.status = 'uploading';
      session.progress = 38;
      const videoReference = await normalizeVideoReference({
        buffer: input.sanitized.buffer,
        width: input.sanitized.width,
        height: input.sanitized.height,
      });
      if (
        !videoReference
        || !Buffer.isBuffer(videoReference.buffer)
        || videoReference.mimeType !== 'image/png'
        || !/^[a-f0-9]{32}\.png$/.test(videoReference.serverFilename)
        || !/^[a-f0-9]{64}$/.test(videoReference.sha256)
        || !['1280x720', '720x1280'].includes(videoReference.aspectRatio)
        || `${videoReference.width}x${videoReference.height}` !== videoReference.aspectRatio
      ) throw new ClientInputError('视频参考图像素与 aspect_ratio 绑定无效。');
      session.uploadSha256 = videoReference.sha256;
      session.referenceAspectRatio = videoReference.aspectRatio;
      const upload = await evolinkClient.uploadReferenceImage({
        buffer: videoReference.buffer,
        mimeType: videoReference.mimeType,
        filename: videoReference.serverFilename,
        signal,
      });
      assertNotCancelled(signal, session);
      session.status = 'submitting';
      session.progress = 58;
      generationMayHaveSubmitted = true;
      session.providerSubmitCount = 1;
      const task = await evolinkClient.createVideoJob({
        prompt: input.prompt,
        referenceUrl: upload.fileUrl,
        aspectRatio: videoReference.aspectRatio,
        signal,
      });
      const taskId = requireTaskId(task?.id);
      const settlement = await budgetLedger.settle({ id: reservation.id, actualUsd: null, capUsd: budgetCapUsd });
      session.providerTaskId = taskId;
      session.providerTaskIdSha256 = sha256(taskId);
      session.status = task?.status === 'processing' ? 'processing' : 'pending';
      session.progress = safeProgress(task?.progress, 66);
      session.budgetUsedUsd = settlement.usedUsd;
      session.updatedAt = new Date(now()).toISOString();
      return publicSession(session, budgetCapUsd);
    } catch (error) {
      let settlement;
      try {
        settlement = await budgetLedger.settle({ id: reservation.id, actualUsd: generationMayHaveSubmitted ? null : 0, capUsd: budgetCapUsd });
      } catch (ledgerError) {
        throw mapLedgerError(ledgerError);
      }
      session.budgetUsedUsd = settlement.usedUsd;
      session.status = signal?.aborted || session.cancelled ? 'user_cancelled' : 'failed';
      session.progress = 0;
      session.error = signal?.aborted || session.cancelled
        ? { code: 'CORE009_VIDEO_SOFT_CANCELLED', message: softCancelMessage(), retryable: false, retryScope: 'none' }
        : safeSubmitFailure(error, generationMayHaveSubmitted);
      session.updatedAt = new Date(now()).toISOString();
      if (signal?.aborted || session.cancelled) throw failure(499, 'CORE009_VIDEO_SOFT_CANCELLED', softCancelMessage());
      throw failure(error?.status ?? 502, session.error.code, session.error.message, session.error.retryable, session.error.retryScope);
    }
  }
};

const validateCreateInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure(400, 'CORE009_VIDEO_INPUT_INVALID', '视频任务必须是对象。');
  if (!CLIENT_JOB_ID.test(input.clientJobId)) throw failure(400, 'CORE009_VIDEO_JOB_ID_INVALID', '本地 Job ID 无效。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32_000) throw failure(400, 'CORE009_VIDEO_PROMPT_INVALID', '视频描述必须为 1–32000 个字符。');
  for (const key of ['sourceObjectId', 'sourceAssetId', 'sourceVersionId']) if (!DOMAIN_ID.test(input[key])) throw failure(400, 'CORE009_VIDEO_SOURCE_BINDING_INVALID', '视频源图绑定无效。');
  const sanitized = input.sanitized;
  if (!sanitized || !Buffer.isBuffer(sanitized.buffer) || sanitized.mimeType !== 'image/png'
    || !/^[a-f0-9]{32}\.png$/.test(sanitized.serverFilename)
    || !/^[a-f0-9]{64}$/.test(sanitized.sha256)
    || !Number.isInteger(sanitized.width) || sanitized.width < 1
    || !Number.isInteger(sanitized.height) || sanitized.height < 1) throw failure(422, 'CORE009_VIDEO_REFERENCE_INVALID', '参考图未通过服务端清理。');
  return { ...input, prompt: input.prompt.trim(), sanitized };
};

const publicSession = (session, budgetCapUsd) => ({
  localJobId: session.clientJobId,
  status: session.status,
  progress: session.progress,
  providerCompleted: Boolean(session.providerCompleted),
  sourceBinding: { objectId: session.sourceObjectId, assetId: session.sourceAssetId, versionId: session.sourceVersionId },
  ...(session.resultId ? { resultId: session.resultId } : {}),
  ...(session.result ? { result: session.result } : {}),
  ...(session.error?.retryScope ? { retryScope: session.error.retryScope } : {}),
  ...(session.error ? { error: session.error } : {}),
  budget: { capUsd: budgetCapUsd, usedUsd: session.budgetUsedUsd ?? 0, conservativeReservationUsd: session.reservationUsd ?? CORE009_GENERATION_RESERVATION_USD },
  policy: { model: session.model ?? 'sora-2-preview', operation: 'image-to-video', durationSeconds: CORE009_VIDEO_DURATION_SECONDS, cancel: 'soft-only' },
});

export const resolveProviderVideo = async (task, {
  fetchImpl = fetch,
  allowedHosts = ['files.evolink.ai'],
  signal,
  scheduleTimeout = setTimeout,
  cancelScheduledTimeout = clearTimeout,
} = {}) => {
  const url = extractVideoUrl(task);
  let parsed;
  try { parsed = new URL(url); } catch { throw failure(502, 'CORE009_VIDEO_RESULT_URL_INVALID', 'Provider 视频结果 URL 无效。'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowedHosts.includes(parsed.hostname)) throw failure(502, 'CORE009_VIDEO_RESULT_URL_INVALID', 'Provider 视频结果必须来自配置的 HTTPS 文件主机。');
  return runBoundedOperation(async (boundedSignal) => {
    const response = await fetchImpl(parsed, { headers: { Accept: 'video/mp4,application/octet-stream' }, redirect: 'error', signal: boundedSignal });
    if (!response.ok) throw failure(response.status, 'CORE009_VIDEO_RESULT_DOWNLOAD_FAILED', 'Provider 视频结果下载失败。', response.status === 429 || response.status >= 500);
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_VIDEO_BYTES)) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(502, 'CORE009_VIDEO_RESULT_TOO_LARGE', 'Provider 视频结果超过本地上限。');
    }
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    if (!['video/mp4', 'application/octet-stream'].includes(mimeType)) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(502, 'CORE009_VIDEO_RESULT_MIME_INVALID', 'Provider 视频结果类型无效。');
    }
    const buffer = await readBoundedBody(response, boundedSignal, MAX_VIDEO_BYTES);
    const metadata = validateMp4(buffer);
    return { buffer, mimeType: 'video/mp4', bytes: buffer.length, sha256: sha256(buffer), ...metadata };
  }, {
    signal,
    timeoutMs: RESULT_DOWNLOAD_TIMEOUT_MS,
    scheduleTimeout,
    cancelScheduledTimeout,
    cancelError: () => failure(499, 'CORE009_VIDEO_RESULT_CANCELLED', '已停止本地视频结果下载；不代表远端任务已取消。'),
    timeoutError: () => failure(504, 'CORE009_VIDEO_RESULT_TIMEOUT', 'Provider 已完成，但本地视频结果下载超时。', true),
  });
};

const readBoundedBody = async (response, signal, maxBytes) => {
  if (!response.body || typeof response.body.getReader !== 'function') throw failure(502, 'CORE009_VIDEO_RESULT_STREAM_INVALID', 'Provider 视频结果没有可读流。');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const cancelReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : failure(499, 'CORE009_VIDEO_RESULT_CANCELLED', '已停止本地视频结果下载。');
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength < 1) throw failure(502, 'CORE009_VIDEO_RESULT_STREAM_INVALID', 'Provider 视频结果流无效。');
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('CORE009_VIDEO_RESULT_TOO_LARGE').catch(() => undefined);
        throw failure(502, 'CORE009_VIDEO_RESULT_TOO_LARGE', 'Provider 视频结果超过本地上限。');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : failure(499, 'CORE009_VIDEO_RESULT_CANCELLED', '已停止本地视频结果下载。');
    if (!total) throw failure(502, 'CORE009_VIDEO_RESULT_TOO_LARGE', 'Provider 视频结果大小无效。');
    return Buffer.concat(chunks, total);
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    try { reader.releaseLock(); } catch { /* already released by cancellation */ }
  }
};

const runBoundedOperation = async (operation, {
  signal,
  timeoutMs,
  scheduleTimeout,
  cancelScheduledTimeout,
  cancelError,
  timeoutError,
}) => {
  if (signal?.aborted) throw cancelError();
  const controller = new AbortController();
  let disposed = false;
  let boundaryTriggered = false;
  let rejectBoundary;
  const boundary = new Promise((_, reject) => { rejectBoundary = reject; });
  const stop = (error) => {
    if (disposed || boundaryTriggered) return;
    boundaryTriggered = true;
    rejectBoundary(error);
    controller.abort(error);
  };
  const cancelFromCaller = () => stop(cancelError());
  signal?.addEventListener('abort', cancelFromCaller, { once: true });
  const timeout = scheduleTimeout(() => stop(timeoutError()), timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      boundary,
    ]);
  } finally {
    disposed = true;
    cancelScheduledTimeout(timeout);
    signal?.removeEventListener('abort', cancelFromCaller);
  }
};

const extractVideoUrl = (task) => {
  const candidates = [task?.results?.[0], task?.data?.results?.[0], task?.result_urls?.[0], task?.video_url, task?.data?.video_url];
  const value = candidates.find((item) => typeof item === 'string');
  if (!value) throw failure(502, 'CORE009_VIDEO_RESULT_SCHEMA_INVALID', 'Provider 任务未返回可下载视频。');
  return value;
};

export const validateMp4 = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 40) throw failure(502, 'CORE009_VIDEO_MP4_INVALID', 'MP4 文件结构无效。');
  const boxes = readBoxes(buffer, 0, buffer.length);
  if (!boxes.some((box) => box.type === 'ftyp') || !boxes.some((box) => box.type === 'moov') || !boxes.some((box) => box.type === 'mdat')) throw failure(502, 'CORE009_VIDEO_MP4_INVALID', 'MP4 缺少必要 box。');
  const moov = boxes.find((box) => box.type === 'moov');
  const children = readBoxes(buffer, moov.start + moov.headerSize, moov.end);
  const mvhd = children.find((box) => box.type === 'mvhd');
  if (!mvhd) throw failure(502, 'CORE009_VIDEO_MP4_INVALID', 'MP4 缺少 mvhd。');
  const payload = mvhd.start + mvhd.headerSize;
  const version = buffer[payload];
  const timescaleOffset = version === 0 ? payload + 12 : version === 1 ? payload + 20 : -1;
  const durationOffset = version === 0 ? payload + 16 : version === 1 ? payload + 24 : -1;
  if (timescaleOffset < 0 || durationOffset + (version === 1 ? 8 : 4) > mvhd.end) throw failure(502, 'CORE009_VIDEO_MP4_INVALID', 'MP4 时长结构无效。');
  const timescale = buffer.readUInt32BE(timescaleOffset);
  const duration = version === 0 ? buffer.readUInt32BE(durationOffset) : Number(buffer.readBigUInt64BE(durationOffset));
  const seconds = duration / timescale;
  if (!Number.isFinite(seconds) || timescale < 1 || seconds < 3.5 || seconds > 4.5) throw failure(502, 'CORE009_VIDEO_DURATION_INVALID', '视频结果不是批准的 4 秒时长。');
  const dimensions = children.filter((box) => box.type === 'trak').map((track) => {
    const tkhd = readBoxes(buffer, track.start + track.headerSize, track.end).find((box) => box.type === 'tkhd');
    if (!tkhd || tkhd.end - tkhd.start < 24) return null;
    const width = buffer.readUInt32BE(tkhd.end - 8) / 65_536;
    const height = buffer.readUInt32BE(tkhd.end - 4) / 65_536;
    return Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1 ? { width: Math.round(width), height: Math.round(height) } : null;
  }).find(Boolean);
  if (!dimensions) throw failure(502, 'CORE009_VIDEO_DIMENSIONS_INVALID', 'MP4 未包含可验证的视频轨尺寸。');
  return { durationSeconds: Number(seconds.toFixed(3)), ...dimensions };
};

const readBoxes = (buffer, start, end) => {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw failure(502, 'CORE009_VIDEO_MP4_INVALID', 'MP4 box 被截断。');
    let size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) throw failure(502, 'CORE009_VIDEO_MP4_INVALID', 'MP4 extended box 被截断。');
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (!/^[ -~]{4}$/.test(type) || !Number.isSafeInteger(size) || size < headerSize || offset + size > end) throw failure(502, 'CORE009_VIDEO_MP4_INVALID', 'MP4 box 长度无效。');
    boxes.push({ type, start: offset, end: offset + size, headerSize });
    offset += size;
  }
  return boxes;
};

const requireSession = (sessions, clientJobId) => {
  if (!CLIENT_JOB_ID.test(clientJobId)) throw failure(400, 'CORE009_VIDEO_JOB_ID_INVALID', '本地 Job ID 无效。');
  const session = sessions.get(clientJobId);
  if (!session) throw failure(404, 'CORE009_VIDEO_JOB_NOT_FOUND', '本地视频 Job 不存在。');
  return session;
};
const requireTaskId = (value) => {
  if (typeof value !== 'string' || !TASK_ID.test(value)) throw failure(502, 'CORE009_VIDEO_TASK_ID_INVALID', 'Provider 未返回有效视频任务标识。');
  return value;
};
const assertNotCancelled = (signal, session) => {
  if (signal?.aborted || session.cancelled) throw failure(499, 'CORE009_VIDEO_SOFT_CANCELLED', softCancelMessage());
};
const safeProgress = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(99, Math.round(value))) : fallback;
const softCancelMessage = () => '已停止本地等待并忽略迟到结果；不代表远端任务已取消、退款或立即删除。';
const isRetryable = (error) => error instanceof EvoLinkHttpError && (error.status === 429 || error.status >= 500);
const safeSubmitFailure = (error, ambiguous) => ambiguous
  ? { code: 'CORE009_VIDEO_SUBMIT_AMBIGUOUS', message: '视频提交结果不确定；为避免重复计费不会自动重提。', retryable: false, retryScope: 'none' }
  : error instanceof ClientInputError
    ? { code: 'CORE009_VIDEO_INPUT_INVALID', message: error.message, retryable: false, retryScope: 'none' }
    : { code: 'CORE009_VIDEO_UPLOAD_FAILED', message: '视频参考图上传失败，未提交视频生成。', retryable: isRetryable(error), retryScope: isRetryable(error) ? 'new-provider-job' : 'none' };
const classifyTaskFailure = (task) => {
  const status = Number(task?.error?.status ?? task?.error?.http_status ?? task?.status_code);
  const retryable = status === 429 || status >= 500;
  return { code: retryable ? 'CORE009_VIDEO_TASK_TRANSIENT_FAILURE' : 'CORE009_VIDEO_TASK_FAILED', message: retryable ? '视频任务因明确临时状态失败；新的付费提交需要新发送。' : '视频任务失败，不会暴露 Provider 原始响应。', retryable, retryScope: retryable ? 'new-provider-job' : 'none' };
};
const mapLedgerError = (error) => {
  if (error instanceof PlannerBudgetExceededError) return failure(402, 'CORE009_BUDGET_EXCEEDED', 'CORE-009 的 5 美元里程碑预算已达上限。');
  if (error instanceof PlannerBudgetLedgerError) return failure(503, 'CORE009_BUDGET_LEDGER_UNAVAILABLE', 'CORE-009 预算账本不可用。');
  return error;
};
const failure = (status, code, message, retryable = false, retryScope = 'none') => new Core009VideoError(status, code, message, retryable, retryScope);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(JSON.stringify(value));
