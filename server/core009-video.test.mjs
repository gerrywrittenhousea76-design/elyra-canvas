import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { EvoLinkHttpError } from './evolink.mjs';
import { createPlannerBudgetLedger } from './planner-budget.mjs';
import { createCore009VideoGateway, resolveProviderVideo, validateMp4 } from './core009-video.mjs';

const box = (type, payload) => {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, 'ascii');
  payload.copy(output, 8);
  return output;
};

const mp4Fixture = ({ seconds = 4, width = 640, height = 360 } = {}) => {
  const ftyp = box('ftyp', Buffer.from([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]));
  const mvhdPayload = Buffer.alloc(32);
  mvhdPayload.writeUInt32BE(1_000, 12);
  mvhdPayload.writeUInt32BE(seconds * 1_000, 16);
  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(width * 65_536, tkhdPayload.length - 8);
  tkhdPayload.writeUInt32BE(height * 65_536, tkhdPayload.length - 4);
  const moov = box('moov', Buffer.concat([box('mvhd', mvhdPayload), box('trak', box('tkhd', tkhdPayload))]));
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.from([1, 2, 3, 4]))]);
};

const createInput = () => ({
  clientJobId: 'job-core009-video-1',
  prompt: '让光影缓慢流动',
  sourceObjectId: 'canvas-source-1',
  sourceAssetId: 'asset-source-1',
  sourceVersionId: 'version-source-1',
  sanitized: {
    buffer: Buffer.from([1, 2, 3]), mimeType: 'image/png', serverFilename: `${'a'.repeat(32)}.png`, sha256: 'b'.repeat(64), width: 1, height: 1,
  },
});

const fixture = async (overrides = {}) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'elyra-core009-video-'));
  const ledger = createPlannerBudgetLedger({ directory });
  const calls = [];
  const client = {
    async uploadReferenceImage() { calls.push('upload'); return { fileUrl: 'https://files.evolink.ai/input.png' }; },
    async createVideoJob(input) { calls.push(['create', input]); return { id: 'task-unified-video-1', status: 'pending' }; },
    async getTask(id) { calls.push(['status', id]); return { id, status: 'completed', results: ['https://files.evolink.ai/output.mp4'] }; },
    ...overrides.client,
  };
  const gateway = createCore009VideoGateway({
    evolinkClient: client,
    budgetLedger: ledger,
    ensureConfigured: overrides.ensureConfigured ?? (async () => undefined),
    normalizeVideoReference: overrides.normalizeVideoReference ?? (async ({ buffer }) => ({
      buffer,
      mimeType: 'image/png',
      serverFilename: `${'d'.repeat(32)}.png`,
      sha256: 'e'.repeat(64),
      width: 1280,
      height: 720,
      aspectRatio: '1280x720',
    })),
    resolveProviderResult: overrides.resolveProviderResult ?? (async () => ({ buffer: mp4Fixture(), mimeType: 'video/mp4', bytes: mp4Fixture().length, sha256: 'c'.repeat(64), durationSeconds: 4, width: 640, height: 360 })),
    createResultId: () => 'video-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    scheduleTimeout: overrides.scheduleTimeout,
    cancelScheduledTimeout: overrides.cancelScheduledTimeout,
  });
  return { directory, ledger, calls, gateway, cleanup: () => rm(directory, { recursive: true, force: true }) };
};

test('validates real MP4 boxes, the approved 3.5–4.5 second window and video-track dimensions', () => {
  assert.deepEqual(validateMp4(mp4Fixture()), { durationSeconds: 4, width: 640, height: 360 });
  assert.deepEqual(validateMp4(mp4Fixture({ seconds: 3.5 })).durationSeconds, 3.5);
  assert.deepEqual(validateMp4(mp4Fixture({ seconds: 4.5 })).durationSeconds, 4.5);
  assert.throws(() => validateMp4(mp4Fixture({ seconds: 3.499 })), (error) => error.code === 'CORE009_VIDEO_DURATION_INVALID');
  assert.throws(() => validateMp4(mp4Fixture({ seconds: 4.501 })), (error) => error.code === 'CORE009_VIDEO_DURATION_INVALID');
  assert.throws(() => validateMp4(mp4Fixture({ seconds: 8 })), (error) => error.code === 'CORE009_VIDEO_DURATION_INVALID');
  assert.throws(() => validateMp4(Buffer.from('not mp4')), (error) => error.code === 'CORE009_VIDEO_MP4_INVALID');
});

test('submits one image-to-video task, materializes one localhost MP4 and exposes no Provider URL', async (context) => {
  const ctx = await fixture();
  context.after(ctx.cleanup);
  const submitted = await ctx.gateway.create(createInput());
  assert.equal(submitted.status, 'pending');
  assert.deepEqual(ctx.calls.map((entry) => Array.isArray(entry) ? entry[0] : entry), ['upload', 'create']);
  assert.deepEqual(ctx.calls[1][1], { prompt: '让光影缓慢流动', referenceUrl: 'https://files.evolink.ai/input.png', aspectRatio: '1280x720', signal: undefined });
  const completed = await ctx.gateway.status('job-core009-video-1');
  assert.deepEqual(completed.result, { mimeType: 'video/mp4', bytes: mp4Fixture().length, durationSeconds: 4, sha256: 'c'.repeat(64), width: 640, height: 360 });
  assert.equal(JSON.stringify(completed).includes('https://'), false);
  assert.equal(JSON.stringify(completed).includes('task-unified'), false);
  assert.equal(ctx.gateway.result(completed.resultId).mimeType, 'video/mp4');
  assert.deepEqual(ctx.gateway.getBudgetStatus(), { capUsd: 5, usedUsd: 1, reservationPerAttemptUsd: 1 });
  assert.deepEqual(ctx.gateway.evidence('job-core009-video-1').resultDimensions, [640, 360]);
  assert.equal(ctx.gateway.evidence('job-core009-video-1').referenceAspectRatio, '1280x720');
});

test('soft cancel ignores a late Provider result and never claims remote cancellation', async (context) => {
  const ctx = await fixture();
  context.after(ctx.cleanup);
  await ctx.gateway.create(createInput());
  const cancelled = ctx.gateway.cancel('job-core009-video-1');
  assert.equal(cancelled.status, 'user_cancelled');
  assert.match(cancelled.error.message, /不代表远端任务已取消/);
  const after = await ctx.gateway.status('job-core009-video-1');
  assert.equal(after.status, 'user_cancelled');
  assert.equal(ctx.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'status').length, 0);
});

test('transient Provider task failure uses the shared new-provider-job scope, never an unknown retry enum', async (context) => {
  const ctx = await fixture({ client: {
    async getTask() { return { id: 'task-unified-video-1', status: 'failed', error: { status: 503 } }; },
  } });
  context.after(ctx.cleanup);
  await ctx.gateway.create(createInput());
  const failed = await ctx.gateway.status('job-core009-video-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryScope, 'new-provider-job');
  assert.equal(failed.error.retryScope, 'new-provider-job');
  assert.equal(JSON.stringify(failed).includes('new-send'), false);
});

test('a transient status failure only retries the same Provider task and never resubmits generation', async (context) => {
  let statusCalls = 0;
  const ctx = await fixture({ client: {
    async getTask(id) {
      statusCalls += 1;
      if (statusCalls === 1) throw new EvoLinkHttpError(503, 'EVOLINK_STATUS_UNAVAILABLE', 'temporary');
      return { id, status: 'processing', progress: 80 };
    },
  } });
  context.after(ctx.cleanup);
  await ctx.gateway.create(createInput());
  const failed = await ctx.gateway.status('job-core009-video-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryScope, 'status-only');
  assert.equal(failed.error.retryScope, 'status-only');
  const retried = await ctx.gateway.retryStatus('job-core009-video-1');
  assert.equal(retried.status, 'processing');
  assert.equal(statusCalls, 2);
  assert.equal(ctx.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'create').length, 1);
});

test('a completed Provider task exposes local-result consistently at the task and error boundaries', async (context) => {
  const ctx = await fixture({
    resolveProviderResult: async () => { throw new Error('temporary local materialization failure'); },
  });
  context.after(ctx.cleanup);
  await ctx.gateway.create(createInput());
  const pending = await ctx.gateway.status('job-core009-video-1');
  assert.equal(pending.status, 'local_result_pending');
  assert.equal(pending.retryScope, 'local-result');
  assert.equal(pending.error.retryScope, 'local-result');
  assert.equal(pending.error.retryable, true);
});

test('an ambiguous submit is charged once and cannot be automatically resubmitted', async (context) => {
  let createCalls = 0;
  const ctx = await fixture({ client: { async createVideoJob() { createCalls += 1; throw new TypeError('socket closed'); } } });
  context.after(ctx.cleanup);
  await assert.rejects(() => ctx.gateway.create(createInput()), (error) => error.code === 'CORE009_VIDEO_SUBMIT_AMBIGUOUS');
  assert.equal(createCalls, 1);
  assert.equal((await ctx.gateway.create(createInput())).status, 'failed');
  assert.equal(createCalls, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
});

test('the independent five-dollar ledger fails closed before any upload', async (context) => {
  const ctx = await fixture();
  context.after(ctx.cleanup);
  const reservation = await ctx.ledger.reserve({ capUsd: 5, amountUsd: 4.1 });
  await ctx.ledger.settle({ id: reservation.id, actualUsd: null, capUsd: 5 });
  await assert.rejects(() => ctx.gateway.create(createInput()), (error) => error.code === 'CORE009_BUDGET_EXCEEDED');
  assert.equal(ctx.calls.length, 0);
});

test('the five-dollar revision carries forward settled two-dollar reservations without resetting spend', async (context) => {
  const ctx = await fixture();
  context.after(ctx.cleanup);
  const historical = await ctx.ledger.reserve({ capUsd: 2, amountUsd: 1 });
  await ctx.ledger.settle({ id: historical.id, actualUsd: 1, capUsd: 2 });
  assert.deepEqual(ctx.gateway.getBudgetStatus(), { capUsd: 5, usedUsd: 1, reservationPerAttemptUsd: 1 });
  const submitted = await ctx.gateway.create(createInput());
  assert.equal(submitted.budget.capUsd, 5);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 2);
});

test('CORE-008 and CORE-009 ledger mutations remain isolated in separate persisted directories', async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'elyra-ledger-isolation-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const core008 = createPlannerBudgetLedger({ directory: resolve(directory, 'core-008') });
  const core009 = createPlannerBudgetLedger({ directory: resolve(directory, 'core-009') });
  const oldReservation = await core008.reserve({ capUsd: 5, amountUsd: 0.75 });
  await core008.settle({ id: oldReservation.id, actualUsd: 0.75, capUsd: 5 });
  assert.equal(core008.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 0.75);
  assert.equal(core009.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 0);
  const newReservation = await core009.reserve({ capUsd: 5, amountUsd: 1 });
  await core009.settle({ id: newReservation.id, actualUsd: 1, capUsd: 5 });
  assert.equal(core009.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 1);
  assert.equal(core008.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 0.75);
});

test('Provider video URL stays server-only and only an exact EvoLink MP4 host is accepted', async () => {
  const bytes = mp4Fixture();
  let seenUrl;
  const result = await resolveProviderVideo({ results: ['https://files.evolink.ai/output.mp4'] }, {
    fetchImpl: async (url) => {
      seenUrl = String(url);
      return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) } });
    },
  });
  assert.equal(seenUrl, 'https://files.evolink.ai/output.mp4');
  assert.deepEqual({ durationSeconds: result.durationSeconds, width: result.width, height: result.height }, { durationSeconds: 4, width: 640, height: 360 });
  assert.equal(Object.values(result).includes(seenUrl), false);
  await assert.rejects(() => resolveProviderVideo({ results: ['https://127.0.0.1/output.mp4'] }), (error) => error.code === 'CORE009_VIDEO_RESULT_URL_INVALID');
});

test('a chunked video without Content-Length is cancelled as soon as the bounded stream exceeds the byte cap', async () => {
  const oneMiB = new Uint8Array(1024 * 1024);
  let chunks = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      chunks += 1;
      controller.enqueue(oneMiB);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(() => resolveProviderVideo({ results: ['https://files.evolink.ai/chunked.mp4'] }, {
    fetchImpl: async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'video/mp4' } }),
  }), (error) => error.code === 'CORE009_VIDEO_RESULT_TOO_LARGE');
  assert.equal(chunks, 121, '流超限后仍继续读取数据');
  assert.equal(cancelled, true, '无 Content-Length 超限时未取消上游流');
});

test('status query binds caller abort without mutating it into a timeout or remote cancellation claim', async (context) => {
  let entered;
  const enteredPromise = new Promise((resolvePromise) => { entered = resolvePromise; });
  let boundedSignal;
  let statusCalls = 0;
  const ctx = await fixture({ client: {
    async getTask(_id, { signal }) {
      statusCalls += 1;
      if (statusCalls > 1) return { id: 'task-unified-video-1', status: 'completed', results: ['https://files.evolink.ai/output.mp4'] };
      boundedSignal = signal;
      entered();
      return new Promise((resolvePromise, rejectPromise) => signal.addEventListener('abort', () => rejectPromise(signal.reason), { once: true }));
    },
  } });
  context.after(ctx.cleanup);
  await ctx.gateway.create(createInput());
  const controller = new AbortController();
  const statusPromise = ctx.gateway.status('job-core009-video-1', { signal: controller.signal });
  await enteredPromise;
  controller.abort();
  await assert.rejects(() => statusPromise, (error) => error.code === 'CORE009_VIDEO_STATUS_CANCELLED' && error.status === 499);
  assert.equal(boundedSignal.aborted, true, '调用方 abort 未传递到 Provider 状态请求');
  assert.equal((await ctx.gateway.status('job-core009-video-1')).status, 'completed', '取消一次本地查询错误地取消了远端任务');
});

test('status timeout aborts the bounded Provider request and remains a status-only retry', async (context) => {
  let timeoutDelay;
  let providerAborted = false;
  const ctx = await fixture({
    scheduleTimeout(callback, delay) {
      timeoutDelay = delay;
      setImmediate(callback);
      return 1;
    },
    cancelScheduledTimeout() {},
    client: {
      async getTask(_id, { signal }) {
        return new Promise((resolvePromise, rejectPromise) => signal.addEventListener('abort', () => {
          providerAborted = true;
          rejectPromise(signal.reason);
        }, { once: true }));
      },
    },
  });
  context.after(ctx.cleanup);
  await ctx.gateway.create(createInput());
  const failed = await ctx.gateway.status('job-core009-video-1');
  assert.equal(timeoutDelay, 15_000, '状态查询没有使用固定超时');
  assert.equal(providerAborted, true, '状态查询超时未中止 Provider 请求');
  assert.equal(failed.error.code, 'CORE009_VIDEO_STATUS_TIMEOUT');
  assert.equal(failed.error.retryScope, 'status-only');
});

test('result download distinguishes caller cancellation from its fixed timeout and cancels the response stream', async () => {
  let downloadEntered;
  const enteredPromise = new Promise((resolvePromise) => { downloadEntered = resolvePromise; });
  let streamCancelled = false;
  const stream = new ReadableStream({
    pull() { downloadEntered(); },
    cancel() { streamCancelled = true; },
  }, { highWaterMark: 0 });
  const controller = new AbortController();
  const cancelledDownload = resolveProviderVideo({ results: ['https://files.evolink.ai/cancel.mp4'] }, {
    signal: controller.signal,
    fetchImpl: async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'video/mp4' } }),
  });
  await enteredPromise;
  controller.abort();
  await assert.rejects(() => cancelledDownload, (error) => error.code === 'CORE009_VIDEO_RESULT_CANCELLED' && error.status === 499);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(streamCancelled, true, '调用方取消下载后响应流未取消');

  let timeoutDelay;
  let fetchAborted = false;
  await assert.rejects(() => resolveProviderVideo({ results: ['https://files.evolink.ai/timeout.mp4'] }, {
    scheduleTimeout(callback, delay) {
      timeoutDelay = delay;
      setImmediate(callback);
      return 1;
    },
    cancelScheduledTimeout() {},
    fetchImpl: async (_url, { signal }) => new Promise((resolvePromise, rejectPromise) => signal.addEventListener('abort', () => {
      fetchAborted = true;
      rejectPromise(signal.reason);
    }, { once: true })),
  }), (error) => error.code === 'CORE009_VIDEO_RESULT_TIMEOUT' && error.status === 504 && error.retryable === true);
  assert.equal(timeoutDelay, 60_000, '视频下载没有使用固定超时');
  assert.equal(fetchAborted, true, '视频下载超时未中止 fetch');
});
