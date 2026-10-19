import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApiHandler, CORE009_LOCAL_API_PROTOCOL } from './elyra-server.mjs';
import { createPaidConfirmationStore, createVideoRequestBinding } from './paid-confirmation.mjs';

const SEND_ID = 'send-99999999999999999999999999999999';
const targetBinding = { objectId: 'canvas-video-source', assetId: 'asset-video-source', versionId: 'version-video-source' };
const plannerInput = {
  prompt: '让画面中的光影缓慢流动',
  imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview', creationMode: 'video', selectedCanvasObjectCount: 1,
  targetCanvasObjectId: targetBinding.objectId, targetBinding, referenceKind: 'user-upload', consentVersion: 'CORE-007-DATA-BOUNDARY-V1',
};
const plannerResult = {
  intent: { id: 'intent-video-server', kind: 'modify', operation: 'video_image_to_video', source: 'remote-agent', prompt: plannerInput.prompt, normalizedPrompt: plannerInput.prompt, goal: '创建四秒演示视频', constraints: ['非敏感演示'], targetCanvasObjectId: targetBinding.objectId, createdAt: '2026-08-10T00:00:00.000Z' },
  plan: { id: 'plan-video-server', intentId: 'intent-video-server', providerId: 'evolink-sora-2-preview', status: 'proposed', operation: 'video_image_to_video', source: 'remote-agent', plannerModel: 'test', summary: '生成四秒图生视频', bullets: ['校验图片', '创建视频 Job'], constraints: ['非敏感演示'], visualDirection: { subject: '原图主体', style: '克制', lighting: '流动', composition: '稳定' }, shouldFail: false, createdAt: '2026-08-10T00:00:00.000Z' },
};
const executionPrompt = [
  plannerResult.intent.normalizedPrompt,
  `规划摘要：${plannerResult.plan.summary}`,
  `视觉方向：主体=${plannerResult.plan.visualDirection.subject}；风格=${plannerResult.plan.visualDirection.style}；光线=${plannerResult.plan.visualDirection.lighting}；构图=${plannerResult.plan.visualDirection.composition}`,
  `约束：${plannerResult.plan.constraints.join('；')}`,
  `执行步骤：${plannerResult.plan.bullets.join('；')}`,
].join('\n');

const withApi = async (operation) => {
  const host = '127.0.0.1';
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.listen(0, host, resolvePromise).once('error', reject));
  const address = server.address();
  const port = address.port;
  let createdInput;
  const requestSignals = [];
  const videoBytes = Buffer.from('local-mp4-result');
  const videoGateway = {
    getBudgetStatus: () => ({ capUsd: 5, usedUsd: 1.05, reservationPerAttemptUsd: 1 }),
    async create(input) { createdInput = input; return { localJobId: input.clientJobId, status: 'pending', progress: 66, providerCompleted: false, sourceBinding: { objectId: input.sourceObjectId, assetId: input.sourceAssetId, versionId: input.sourceVersionId }, budget: { capUsd: 5, usedUsd: 1.05, conservativeReservationUsd: 1 }, policy: { model: 'sora-2-preview', operation: 'image-to-video', durationSeconds: 4, cancel: 'soft-only' } }; },
    async status(clientJobId, options) { requestSignals.push(['status', options?.signal]); return { localJobId: clientJobId, status: 'completed', progress: 100, resultId: 'video-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result: { mimeType: 'video/mp4', bytes: videoBytes.length, durationSeconds: 4, sha256: 'd'.repeat(64), width: 640, height: 360 } }; },
    cancel(clientJobId) { return { localJobId: clientJobId, status: 'user_cancelled', progress: 0 }; },
    async retryLocalResult(clientJobId, options) { requestSignals.push(['retry-local-result', options?.signal]); return { localJobId: clientJobId, status: 'completed', progress: 100 }; },
    async retryStatus(clientJobId, options) { requestSignals.push(['retry-status', options?.signal]); return { localJobId: clientJobId, status: 'processing', progress: 72 }; },
    evidence: () => ({ providerSubmitCount: 1, resultSha256: 'd'.repeat(64) }),
    result: () => ({ buffer: videoBytes, mimeType: 'video/mp4' }),
  };
  const deadGateway = { createImageJob() { throw new Error('image must not run'); }, createImageEditJob() { throw new Error('image must not run'); }, getBudgetStatus: () => ({ capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }) };
  const referenceJobs = { getBudgetStatus: () => ({ capUsd: 5, usedUsd: 0 }), result() { throw new Error('not used'); }, evidence() { throw new Error('not used'); } };
  const handler = createApiHandler({
    host, port,
    client: deadGateway,
    plannerClient: { createPlan: async () => plannerResult }, core007PlannerClient: { createPlan: async () => plannerResult }, core009PlannerClient: { createPlan: async () => plannerResult },
    referenceJobs, core009ReferenceJobs: referenceJobs, core008ImageGateway: deadGateway, core009ImageGateway: deadGateway,
    core009VideoGateway: videoGateway,
    paidConfirmations: createPaidConfirmationStore(),
    sanitizeReference: async ({ buffer }) => ({ buffer, mimeType: 'image/png', serverFilename: `${'a'.repeat(32)}.png`, sha256: 'b'.repeat(64), width: 1, height: 1 }),
  });
  server.removeAllListeners('request');
  server.on('request', handler);
  try { await operation(`http://${host}:${port}`, () => createdInput, videoBytes, requestSignals); }
  finally { await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())); }
};

const json = (baseUrl, path, body, token) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', ...(token ? { 'X-Elyra-Paid-Confirmation': token } : {}) }, body: JSON.stringify(body) });

test('CORE-009 BFF exposes capabilities, budget and one fully bound multipart video route', async () => {
  await withApi(async (baseUrl, getCreatedInput, videoBytes, requestSignals) => {
    const capabilities = await fetch(`${baseUrl}/api/agent/core-009-capabilities`);
    assert.deepEqual(await capabilities.json(), CORE009_LOCAL_API_PROTOCOL);
    const budget = await fetch(`${baseUrl}/api/agent/core-009-budget`);
    assert.deepEqual(await budget.json(), { capUsd: 5, usedUsd: 1.05, reservationPerAttemptUsd: 1 });

    const plannerTicketResponse = await json(baseUrl, '/api/agent/paid-confirmations', { authorizationId: SEND_ID, kind: 'planner', request: { route: '/api/agent/plans', body: plannerInput } });
    assert.equal(plannerTicketResponse.status, 201);
    const plannerTicket = await plannerTicketResponse.json();
    const planned = await json(baseUrl, '/api/agent/plans', plannerInput, plannerTicket.token);
    assert.equal(planned.status, 200);

    const fileBytes = Buffer.from([1, 2, 3]);
    const binding = createVideoRequestBinding({ prompt: executionPrompt, clientJobId: 'job-video-server-1', sourceObjectId: targetBinding.objectId, sourceAssetId: targetBinding.assetId, sourceVersionId: targetBinding.versionId, buffer: fileBytes });
    const chain = { intentId: plannerResult.intent.id, planId: plannerResult.plan.id, operation: 'video_image_to_video', providerId: 'evolink-sora-2-preview', targetBinding };
    const videoTicketResponse = await json(baseUrl, '/api/agent/paid-confirmations', { authorizationId: SEND_ID, kind: 'video', request: { route: '/api/agent/video-jobs', body: binding }, chain });
    assert.equal(videoTicketResponse.status, 201);
    const videoTicket = await videoTicketResponse.json();

    const form = new FormData();
    form.append('file', new File([fileBytes], `${'a'.repeat(32)}.png`, { type: 'image/png' }));
    form.append('prompt', executionPrompt);
    form.append('clientJobId', 'job-video-server-1');
    form.append('sourceObjectId', targetBinding.objectId);
    form.append('sourceAssetId', targetBinding.assetId);
    form.append('sourceVersionId', targetBinding.versionId);
    const submitted = await fetch(`${baseUrl}/api/agent/video-jobs`, { method: 'POST', headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', 'X-Elyra-Paid-Confirmation': videoTicket.token }, body: form });
    assert.equal(submitted.status, 202);
    assert.equal((await submitted.json()).status, 'pending');
    assert.equal(getCreatedInput().sourceAssetId, targetBinding.assetId);

    const status = await fetch(`${baseUrl}/api/agent/video-jobs/job-video-server-1`);
    const statusBody = await status.json();
    assert.deepEqual(statusBody.result, { mimeType: 'video/mp4', bytes: videoBytes.length, durationSeconds: 4, sha256: 'd'.repeat(64), width: 640, height: 360 });
    assert.equal(JSON.stringify(statusBody).includes('https://'), false);
    const result = await fetch(`${baseUrl}/api/agent/video-assets/${statusBody.resultId}`);
    assert.equal(result.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), videoBytes);

    const retryStatus = await json(baseUrl, '/api/agent/video-jobs/job-video-server-1', { action: 'retry-status' });
    assert.equal(retryStatus.status, 200);
    const retryLocal = await json(baseUrl, '/api/agent/video-jobs/job-video-server-1', { action: 'retry-local-result' });
    assert.equal(retryLocal.status, 200);
    assert.deepEqual(requestSignals.map(([kind]) => kind), ['status', 'retry-status', 'retry-local-result']);
    for (const [, signal] of requestSignals) assert.ok(signal instanceof AbortSignal, '本地视频请求未绑定 AbortSignal');
  });
});
