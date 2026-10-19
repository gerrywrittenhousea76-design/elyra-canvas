const EVOLINK_ORIGIN = 'https://api.evolink.ai';
const EVOLINK_FILES_ORIGIN = 'https://files-api.evolink.ai';
const TASK_ID = /^task-unified-[A-Za-z0-9_-]+$/;
const IMAGE_URL = /^https:\/\/[^\s]+\.(?:png|jpe?g|webp)(?:\?[^\s]*)?$/i;
const SAFE_UPLOAD_NAME = /^[a-f0-9]{32}\.png$/;
const SIZES = new Set(['auto', '1:1', '1:2', '2:1', '1:3', '3:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '9:21']);
export const CORE009_VIDEO_MODEL = 'sora-2-preview';
export const CORE009_VIDEO_DURATION_SECONDS = 4;
export const CORE009_VIDEO_ASPECT_RATIOS = Object.freeze(['1280x720', '720x1280']);

/** The BFF reads only its process environment; it never reads or persists a Key. */
export const readEvoLinkKey = async () => {
  const key = process.env.EVOLINK_API_KEY?.trim();
  if (!key) throw new Error('未配置 EVOLINK_API_KEY 环境变量。');
  return key;
};

const assertGenerationInput = ({ prompt, size, quality, n }) => {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32_000) throw new ClientInputError('prompt 必须为 1–32000 个字符。');
  if (!SIZES.has(size)) throw new ClientInputError('size 必须为 EvoLink GPT Image 2 支持的比例。');
  if (!['low', 'medium', 'high'].includes(quality)) throw new ClientInputError('quality 必须为 low、medium 或 high。');
  if (n !== 1) throw new ClientInputError('当前 ELYRA 只允许每个任务生成 1 张图片。');
};

const requestImageTask = async ({ fetchImpl, readKey, apiBase, imageModel, auth, prompt, size, quality, n, imageUrls }) => {
  assertGenerationInput({ prompt, size, quality, n });
  const token = await readKey();
  const response = await fetchImpl(`${apiBase}/images/generations`, {
    method: 'POST', redirect: 'error',
    headers: { ...(auth === 'x-api-key' ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: imageModel, prompt: prompt.trim(), size, quality, n, ...(imageUrls ? { image_urls: imageUrls } : {}) }),
  });
  const body = await safeJson(response);
  if (!response.ok) throw new EvoLinkHttpError(response.status, imageErrorCode(response.status, 'CREATE'), safeImageStatusMessage(response.status, '创建'));
  return { ...body, httpStatus: response.status };
};

const retryableStatus = (status) => status === 429 || status >= 500;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const extractUploadedFileUrl = (body) => {
  const candidates = [body?.file_url, body?.url, body?.data?.file_url, body?.data?.url];
  const value = candidates.find((item) => typeof item === 'string');
  if (!value || !IMAGE_URL.test(value)) throw new EvoLinkHttpError(502, 'EVOLINK_UPLOAD_SCHEMA_INVALID', 'EvoLink 文件上传返回结构无效。');
  return value;
};

export const createEvoLinkClient = ({ fetchImpl = fetch, readKey = readEvoLinkKey, sleepImpl = pause, apiBase = `${EVOLINK_ORIGIN}/v1`, filesBase = `${EVOLINK_FILES_ORIGIN}/api/v1`, imageModel = 'gpt-image-2', videoModel = CORE009_VIDEO_MODEL, auth = 'bearer' } = {}) => ({
  createImageJob({ prompt, size = '1:1', quality = 'medium', n = 1 }) {
    return requestImageTask({ fetchImpl, readKey, apiBase, imageModel, auth, prompt, size, quality, n });
  },

  createImageEditJob({ prompt, referenceUrl, size = '1:1', quality = 'medium', n = 1 }) {
    if (typeof referenceUrl !== 'string' || !IMAGE_URL.test(referenceUrl)) throw new ClientInputError('固定演示参考图必须是可公开直接下载的 HTTPS 图片 URL。');
    return requestImageTask({ fetchImpl, readKey, apiBase, imageModel, auth, prompt, size, quality, n, imageUrls: [referenceUrl] });
  },

  async uploadReferenceImage({ buffer, mimeType, filename, signal }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 10 * 1024 * 1024) throw new ClientInputError('清理后的参考图大小无效。');
    if (mimeType !== 'image/png' || !SAFE_UPLOAD_NAME.test(filename)) throw new ClientInputError('清理后的参考图类型或随机文件名无效。');
    const token = await readKey();
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const form = new FormData();
      form.append('file', new File([buffer], filename, { type: mimeType }));
      let response;
      try {
        response = await fetchImpl(`${filesBase}/files/upload/stream`, {
          method: 'POST', redirect: 'error',
          headers: { ...(auth === 'x-api-key' ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` }) },
          body: form,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // A network failure has no authoritative response: the remote upload
        // may already exist. Retrying would create another 72-hour copy, so it
        // fails closed. Only explicit 429/5xx responses are retried once.
        throw new EvoLinkHttpError(502, 'EVOLINK_UPLOAD_NETWORK_ERROR', 'EvoLink 文件上传暂时不可用。');
      }
      lastStatus = response.status;
      const body = await safeJson(response);
      if (response.ok) return { fileUrl: extractUploadedFileUrl(body), httpStatus: response.status, retryCount: attempt };
      if (retryableStatus(response.status) && attempt === 0) { await sleepImpl(250); continue; }
      throw new EvoLinkHttpError(response.status, uploadErrorCode(response.status), safeUploadStatusMessage(response.status));
    }
    throw new EvoLinkHttpError(lastStatus || 502, 'EVOLINK_UPLOAD_FAILED', 'EvoLink 文件上传失败。');
  },

  createUploadedReferenceEditJob({ prompt, referenceUrl, size = '1:1', quality = 'medium', n = 1, signal }) {
    if (typeof referenceUrl !== 'string' || !IMAGE_URL.test(referenceUrl)) throw new ClientInputError('服务端临时参考图 URL 无效。');
    return requestImageTask({ fetchImpl: (url, options) => fetchImpl(url, { ...options, signal }), readKey, apiBase, imageModel, auth, prompt, size, quality, n, imageUrls: [referenceUrl] });
  },

  async createVideoJob({ prompt, referenceUrl, aspectRatio, signal }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32_000) throw new ClientInputError('prompt 必须为 1–32000 个字符。');
    if (typeof referenceUrl !== 'string' || !IMAGE_URL.test(referenceUrl)) throw new ClientInputError('图生视频参考图必须是有效的 HTTPS 图片 URL。');
    if (!CORE009_VIDEO_ASPECT_RATIOS.includes(aspectRatio)) throw new ClientInputError('图生视频 aspect_ratio 必须与受控参考图像素匹配。');
    const token = await readKey();
    const response = await fetchImpl(`${apiBase}/videos/generations`, {
      method: 'POST', redirect: 'error',
      headers: { ...(auth === 'x-api-key' ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: videoModel,
        prompt: prompt.trim(),
        image_urls: [referenceUrl],
        aspect_ratio: aspectRatio,
        duration: CORE009_VIDEO_DURATION_SECONDS,
      }),
      signal,
    });
    const body = await safeJson(response);
    if (!response.ok) throw new EvoLinkHttpError(response.status, videoErrorCode(response.status, 'CREATE'), safeVideoStatusMessage(response.status, '创建'));
    return { ...body, httpStatus: response.status };
  },

  async getTask(taskId, { signal } = {}) {
    if (!TASK_ID.test(taskId)) throw new ClientInputError('无效的 EvoLink task ID。');
    const token = await readKey();
    const response = await fetchImpl(`${apiBase}/tasks/${encodeURIComponent(taskId)}`, {
      redirect: 'error', headers: { ...(auth === 'x-api-key' ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` }) },
      signal,
    });
    const body = await safeJson(response);
    if (!response.ok) throw new EvoLinkHttpError(response.status, imageErrorCode(response.status, 'STATUS'), safeImageStatusMessage(response.status, '查询'));
    return { ...body, httpStatus: response.status };
  },
});

const uploadErrorCode = (status) => status === 400 ? 'EVOLINK_UPLOAD_INVALID' : status === 401 || status === 403 ? 'EVOLINK_UPLOAD_AUTH_FAILED' : status === 402 ? 'EVOLINK_UPLOAD_BALANCE_REQUIRED' : status === 429 ? 'EVOLINK_UPLOAD_RATE_LIMITED' : status >= 500 ? 'EVOLINK_UPLOAD_UNAVAILABLE' : 'EVOLINK_UPLOAD_REJECTED';
const safeUploadStatusMessage = (status) => status === 400 ? 'EvoLink 拒绝了参考图上传参数。' : status === 401 || status === 403 ? 'EvoLink 文件上传鉴权失败。' : status === 402 ? 'EvoLink 账户余额不足。' : status === 429 ? 'EvoLink 文件上传请求过于频繁。' : status >= 500 ? 'EvoLink 文件上传服务暂时不可用。' : 'EvoLink 拒绝了参考图上传。';
const imageErrorCode = (status, phase) => status === 400 ? `EVOLINK_${phase}_INVALID` : status === 401 || status === 403 ? `EVOLINK_${phase}_AUTH_FAILED` : status === 402 ? `EVOLINK_${phase}_BALANCE_REQUIRED` : status === 429 ? `EVOLINK_${phase}_RATE_LIMITED` : status >= 500 ? `EVOLINK_${phase}_UNAVAILABLE` : `EVOLINK_${phase}_REJECTED`;
const safeImageStatusMessage = (status, action) => status === 400 ? `EvoLink 拒绝了图片任务${action}参数。` : status === 401 || status === 403 ? `EvoLink 图片任务${action}鉴权失败。` : status === 402 ? 'EvoLink 账户余额不足。' : status === 429 ? `EvoLink 图片任务${action}请求过于频繁。` : status >= 500 ? `EvoLink 图片任务${action}服务暂时不可用。` : `EvoLink 拒绝了图片任务${action}。`;
const videoErrorCode = (status, phase) => status === 400 ? `EVOLINK_VIDEO_${phase}_INVALID` : status === 401 || status === 403 ? `EVOLINK_VIDEO_${phase}_AUTH_FAILED` : status === 402 ? `EVOLINK_VIDEO_${phase}_BALANCE_REQUIRED` : status === 429 ? `EVOLINK_VIDEO_${phase}_RATE_LIMITED` : status >= 500 ? `EVOLINK_VIDEO_${phase}_UNAVAILABLE` : `EVOLINK_VIDEO_${phase}_REJECTED`;
const safeVideoStatusMessage = (status, action) => status === 400 ? `EvoLink 拒绝了视频任务${action}参数。` : status === 401 || status === 403 ? `EvoLink 视频任务${action}鉴权失败。` : status === 402 ? 'EvoLink 账户余额不足。' : status === 429 ? `EvoLink 视频任务${action}请求过于频繁。` : status >= 500 ? `EvoLink 视频任务${action}服务暂时不可用。` : `EvoLink 拒绝了视频任务${action}。`;

const safeJson = async (response) => {
  try { return await response.json(); } catch { return null; }
};

export class ClientInputError extends Error {}

export class EvoLinkHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
