import { randomUUID } from 'node:crypto';
import { createEvoLinkClient, EvoLinkHttpError, ClientInputError } from './evolink.mjs';
import { createEvoLinkPlannerClient } from './planner.mjs';
import { resolveProviderResultImage } from './reference-jobs.mjs';
import { sanitizeProviderResultImage } from './reference-image.mjs';
import { resolveProviderVideo } from './core009-video.mjs';

export const authHeaders = (settings, token) => settings.auth === 'x-api-key' ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` };
const fail = (status = 502) => new EvoLinkHttpError(status, 'PROVIDER_REQUEST_FAILED', '模型服务请求失败，请检查服务配置。');

// Never echo provider bodies: authentication failures can contain credentials.
export async function readProviderJson(response, limit = 32 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw fail(response.status); }
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw fail();
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > limit) { await reader.cancel(); throw fail(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw fail(); } finally { reader.releaseLock(); }
}

export function createPlannerAdapter({ settings, readKey, fetchImpl = fetch }, protocol) {
  const endpoint = `${settings.baseUrl}/${protocol === 'openai-chat' ? 'chat/completions' : 'messages'}`;
  const requestProvider = async ({ payload, token, signal }) => {
    const body = protocol === 'openai-chat' ? {
      model: settings.model, max_tokens: payload.max_tokens, temperature: 0,
      messages: [{ role: 'system', content: payload.system }, ...payload.messages],
      tools: payload.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
      tool_choice: { type: 'function', function: { name: 'submit_elyra_plan' } }, parallel_tool_calls: false,
    } : payload;
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { ...authHeaders(settings, token), 'Content-Type': 'application/json', ...(protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}) },
      body: JSON.stringify(body),
    });
    // Preserve HTTP status without reading or forwarding upstream error text.
    if (!response.ok) { await response.body?.cancel(); return new Response('{}', { status: response.status }); }
    const data = await readProviderJson(response, 1024 * 1024);
    if (protocol !== 'openai-chat') return new Response(JSON.stringify(data));
    const message = data.choices?.[0]?.message;
    const calls = message?.tool_calls;
    const normalized = {
      id: data.id, stop_reason: message?.refusal ? 'refusal' : 'tool_use',
      content: Array.isArray(calls) ? calls.map(call => {
        let input; try { input = JSON.parse(call.function?.arguments); } catch { input = null; }
        return { type: 'tool_use', name: call.function?.name, input };
      }) : [],
      ...(data.usage ? { usage: { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens } } : {}),
    };
    return new Response(JSON.stringify(normalized));
  };
  return {
    createClient(options) {
      const client = createEvoLinkPlannerClient({ ...options, readKey, model: settings.model, requestProvider, costEstimator: () => null, attemptReservationUsd: settings.reservationUsd });
      const evidence = previous => ({ ...previous, provider: settings.label, endpoint, model: settings.model, pricingSource: 'operator-reservation', pricingCheckedAt: undefined });
      return { ...client, async createPlan(input) {
        try { const result = await client.createPlan(input); return { ...result, evidence: evidence(result.evidence) }; }
        catch (error) { if (error.evidence) error.evidence = evidence(error.evidence); throw error; }
      } };
    },
  };
}

export function createEvoMediaAdapter({ settings, readKey, fetchImpl = fetch, namespace }, role) {
  const upstream = createEvoLinkClient({ fetchImpl, readKey, apiBase: settings.baseUrl, filesBase: settings.filesBaseUrl, imageModel: settings.model, videoModel: settings.model, auth: settings.auth });
  const prefix = `task-unified-${namespace}-`;
  const wrapTask = task => {
    if (typeof task?.id !== 'string' || !/^task-unified-[A-Za-z0-9_-]+$/.test(task.id) || task.id.length > 200) throw fail();
    return { ...task, id: prefix + Buffer.from(task.id).toString('base64url') };
  };
  const client = { ...upstream };
  for (const method of ['createImageJob', 'createImageEditJob', 'createUploadedReferenceEditJob', 'createVideoJob']) client[method] = async input => wrapTask(await upstream[method](input));
  client.getTask = async (id, options) => {
    // A restored job may only return to the same endpoint, model and account.
    if (typeof id !== 'string' || !id.startsWith(prefix)) throw new ClientInputError('此任务属于其他 API 配置，不能转交给当前服务。');
    const externalId = Buffer.from(id.slice(prefix.length), 'base64url').toString();
    if (prefix + Buffer.from(externalId).toString('base64url') !== id) throw new ClientInputError('任务标识无效。');
    const task = await upstream.getTask(externalId, options);
    if (task?.id !== externalId) throw fail();
    return wrapTask(task);
  };
  return {
    client,
    resolveResult: role === 'video' ? (task, options) => resolveProviderVideo(task, { ...options, fetchImpl, allowedHosts: settings.resultHosts }) : resolveProviderResultImage,
  };
}

// Synchronous image APIs are normalized into ELYRA's existing asynchronous jobs.
// Reference bytes and vendor responses stay private; the browser sees local IDs.
export function createOpenAIImageAdapter({ settings, readKey, fetchImpl = fetch, sanitize = sanitizeProviderResultImage, resolveImage = resolveProviderResultImage, now = Date.now }) {
  const tasks = new Map(); const references = new Map();
  const prune = map => { for (const [key, item] of map) if (item.expires < now()) map.delete(key); };
  const reserveSlot = map => { prune(map); if (map.size >= 20) throw fail(429); };
  const deadline = signal => signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const sizeFor = ratio => {
    if (!ratio || ratio === 'auto') return 'auto';
    const [width, height] = ratio.split(':').map(Number);
    if (!width || !height) throw new ClientInputError('图片比例无效。');
    return width === height ? '1024x1024' : width > height ? '1536x1024' : '1024x1536';
  };
  const create = async ({ prompt, size = '1:1', quality = 'medium', n = 1, referenceUrl, signal }) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000 || n !== 1 || !['low', 'medium', 'high'].includes(quality)) throw new ClientInputError('图片任务参数无效。');
    reserveSlot(tasks);
    const token = await readKey();
    const fields = { model: settings.model, prompt: prompt.trim(), size: sizeFor(size), quality, n: 1 };
    let body; const headers = authHeaders(settings, token);
    if (referenceUrl) {
      prune(references);
      const reference = references.get(referenceUrl); references.delete(referenceUrl);
      if (!reference) throw new ClientInputError('参考图已失效，请重新上传。');
      body = new FormData();
      for (const [name, value] of Object.entries(fields)) body.append(name, String(value));
      body.append('image', new File([reference.buffer], 'reference.png', { type: 'image/png' }));
    } else { body = JSON.stringify(fields); headers['Content-Type'] = 'application/json'; }
    const response = await fetchImpl(`${settings.baseUrl}/images/${referenceUrl ? 'edits' : 'generations'}`, { method: 'POST', redirect: 'error', headers, body, signal: deadline(signal) });
    const data = await readProviderJson(response);
    if (!Array.isArray(data.data) || data.data.length !== 1) throw fail();
    const item = data.data[0];
    if (typeof item.b64_json !== 'string' && typeof item.url !== 'string') throw fail();
    const id = `task-unified-${randomUUID()}`;
    tasks.set(id, { item, expires: now() + 60 * 60_000 });
    return { id, status: 'pending', httpStatus: 200 };
  };
  const client = {
    createImageJob: create,
    async uploadReferenceImage({ buffer, mimeType }) {
      await readKey(); reserveSlot(references);
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 10 * 1024 * 1024 || mimeType !== 'image/png') throw new ClientInputError('参考图格式无效。');
      const fileUrl = `https://elyra.invalid/reference/${randomUUID()}.png`;
      references.set(fileUrl, { buffer, expires: now() + 60_000 });
      return { fileUrl, httpStatus: 200, retryCount: 0 };
    },
    createUploadedReferenceEditJob: create,
    async createImageEditJob(input) {
      const reference = await resolveImage({ results: [input.referenceUrl] }, { signal: input.signal });
      const { fileUrl } = await client.uploadReferenceImage(reference);
      return create({ ...input, referenceUrl: fileUrl });
    },
    async getTask(id) {
      prune(tasks); if (!tasks.has(id)) throw fail(404);
      return { id, status: 'completed', progress: 100 };
    },
  };
  return { client, async resolveResult(task, options = {}) {
    prune(tasks); const record = tasks.get(task.id); if (!record) throw fail(404);
    if (record.result) return record.result;
    const item = record.item;
    if (item.b64_json) {
      if (item.b64_json.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)) throw fail();
      record.result = await sanitize({ buffer: Buffer.from(item.b64_json, 'base64'), temporaryParent: options.temporaryParent });
    } else record.result = await resolveImage({ results: [item.url] }, options);
    delete record.item;
    return record.result;
  } };
}
