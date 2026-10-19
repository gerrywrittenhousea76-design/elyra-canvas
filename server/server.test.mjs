import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CORE008_BUDGET_DIRECTORY,
  CORE008_LOCAL_API_PROTOCOL,
  assertLegacyImageRouteBoundary,
  createApiHandler,
  createBoundedSemaphore,
  parseMultipartBoundary,
  readReferenceMultipart,
  validateReferenceMultipartForm,
} from './elyra-server.mjs';
import { Core008BudgetError } from './core008-budget.mjs';
import { EvoLinkHttpError } from './evolink.mjs';
import { createEvoLinkPlannerClient } from './planner.mjs';
import { createPaidConfirmationStore, createUserReferenceRequestBinding } from './paid-confirmation.mjs';

const CONSENT = 'CORE-007-DATA-BOUNDARY-V1';
let sendAuthorizationSequence = 0;
const nextSendAuthorizationId = () => `send-${(++sendAuthorizationSequence).toString(16).padStart(32, '0')}`;
const testImageChains = new Map();
const testAuthorizedImageBodies = new Map();
const testPlannerEnvelope = (input) => {
  const operation = input.targetCanvasObjectId ? input.referenceKind === 'user-upload' ? 'image_edit_user_reference' : 'image_edit_fixed_demo_reference' : 'image_generate';
  return {
    intent: {
      id: 'intent-server-test', kind: input.targetCanvasObjectId ? 'modify' : 'generate', operation, source: 'remote-agent', prompt: input.prompt, normalizedPrompt: input.prompt, goal: input.prompt, constraints: ['仅生成一张'], ...(input.targetCanvasObjectId ? { targetCanvasObjectId: input.targetCanvasObjectId } : {}), createdAt: '2026-08-07T00:00:00.000Z',
    },
    plan: {
      id: 'plan-server-test', intentId: 'intent-server-test', providerId: input.imageProviderId, status: 'proposed', operation, source: 'remote-agent', plannerModel: 'test', summary: '测试规划', bullets: ['创建图片 Job'], constraints: ['仅生成一张'], visualDirection: { subject: '演示主体', style: '克制', lighting: '柔和', composition: '居中' }, shouldFail: false, createdAt: '2026-08-07T00:00:00.000Z',
    },
  };
};
const executionPromptFor = ({ intent, plan }) => [
  intent.normalizedPrompt.trim(),
  `规划摘要：${plan.summary.trim()}`,
  `视觉方向：主体=${plan.visualDirection.subject.trim()}；风格=${plan.visualDirection.style.trim()}；光线=${plan.visualDirection.lighting.trim()}；构图=${plan.visualDirection.composition.trim()}`,
  `约束：${plan.constraints.map((item) => item.trim()).filter(Boolean).join('；')}`,
  `执行步骤：${plan.bullets.map((item) => item.trim()).filter(Boolean).join('；')}`,
].join('\n');

const dependencies = (overrides = {}) => ({
  client: {
    async createImageJob() { throw new Error('legacy Provider must not run'); },
    async createImageEditJob() { throw new Error('legacy Provider must not run'); },
    async getTask() { throw new Error('Provider must not run'); },
  },
  plannerClient: { async createPlan(input) { return testPlannerEnvelope(input); } },
  core007PlannerClient: { async createPlan(input) { return testPlannerEnvelope(input); } },
  referenceJobs: {
    getBudgetStatus() { return { capUsd: 5, usedUsd: 0, remainingUsd: 5, reservationPerAttemptUsd: 1 }; },
    async create() { return { localJobId: 'job-test', status: 'processing', progress: 72 }; },
    async status() { throw new Error('status must not run'); },
    async retryLocalResult() { throw new Error('retry must not run'); },
    async retryStatus() { throw new Error('status retry must not run'); },
    cancel() { throw new Error('cancel must not run'); },
    result() { throw new Error('result must not run'); },
    evidence() { throw new Error('evidence must not run'); },
  },
  sanitizeReference: async () => { throw new Error('sanitizer must not run'); },
  ...overrides,
});

const withApi = async (deps, operation) => {
  const host = '127.0.0.1';
  const server = createServer();
  await new Promise((resolvePromise, reject) => server.listen(0, host, resolvePromise).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const handler = createApiHandler({ host, port, ...deps });
  server.removeAllListeners('request');
  server.on('request', handler);
  try {
    return await operation(`http://${host}:${port}`);
  } finally {
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  }
};

const jsonRequest = (baseUrl, path, body, { paidToken, origin = baseUrl, fetchSite = 'same-origin' } = {}) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(origin === null ? {} : { Origin: origin }),
    ...(fetchSite === null ? {} : { 'Sec-Fetch-Site': fetchSite }),
    ...(paidToken ? { 'X-Elyra-Paid-Confirmation': paidToken } : {}),
  },
  body: JSON.stringify(body),
});

const plannerInputForImage = (route, body) => {
  if (route === '/api/agent/image-jobs') return { prompt: body.prompt, imageProviderId: 'evolink-gpt-image-2' };
  const userReference = route === '/api/agent/user-reference-image-jobs';
  const objectId = userReference ? 'canvas-user-reference-test' : 'canvas-fixed-reference-test';
  return {
    prompt: body.prompt,
    imageProviderId: 'evolink-gpt-image-2',
    targetCanvasObjectId: objectId,
    targetBinding: { objectId, versionId: 'version-reference-test', assetId: 'asset-reference-test' },
    referenceKind: userReference ? 'user-upload' : 'fixed-demo',
    ...(userReference ? { consentVersion: CONSENT } : {}),
  };
};

const issuePaidConfirmation = async (baseUrl, kind, route, body, authorizationId = nextSendAuthorizationId()) => {
  let chain;
  let authorizedBody = body;
  if (kind === 'image') {
    const plannerInput = plannerInputForImage(route, body);
    const plannerToken = await issuePaidConfirmation(baseUrl, 'planner', '/api/agent/plans', plannerInput, authorizationId);
    const plannerResponse = await jsonRequest(baseUrl, '/api/agent/plans', plannerInput, { paidToken: plannerToken });
    assert.equal(plannerResponse.status, 200);
    const envelope = await plannerResponse.json();
    authorizedBody = { ...body, prompt: executionPromptFor(envelope) };
    if (!Object.isFrozen(body)) body.prompt = authorizedBody.prompt;
    testAuthorizedImageBodies.set(authorizationId, authorizedBody);
    chain = {
      intentId: envelope.intent.id,
      planId: envelope.plan.id,
      operation: envelope.intent.operation,
      providerId: envelope.plan.providerId,
      targetBinding: plannerInput.targetBinding ?? null,
    };
    testImageChains.set(authorizationId, chain);
  }
  const response = await jsonRequest(baseUrl, '/api/agent/paid-confirmations', { authorizationId, kind, request: { route, body: authorizedBody }, ...(chain ? { chain } : {}) });
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.authorizationId, authorizationId);
  assert.equal(receipt.kind, kind);
  assert.match(receipt.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(receipt.requestDigest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(receipt.expiresAt)));
  return receipt.token;
};

const referenceForm = ({ id = 'job-reference-test', consent = CONSENT, prompt = '非敏感演示编辑', filename = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', bytes = Buffer.from([1, 2, 3]), extra } = {}) => {
  const form = new FormData();
  form.append('file', new File([bytes], filename, { type: 'image/png' }));
  form.append('prompt', prompt);
  form.append('clientJobId', id);
  form.append('consentVersion', consent);
  if (extra) form.append(extra.name, extra.value);
  return form;
};

test('CORE-007 planner consent fails before the planner can read a key or spend budget', async () => {
  let plannerCalls = 0;
  await withApi(dependencies({ core007PlannerClient: { async createPlan() { plannerCalls += 1; throw new Error('must not run'); } } }), async (baseUrl) => {
    const response = await jsonRequest(baseUrl, '/api/agent/plans', {
      prompt: '编辑上传图', targetCanvasObjectId: 'canvas-1', targetBinding: { objectId: 'canvas-1', versionId: 'version-1', assetId: 'asset-1' }, referenceKind: 'user-upload', imageProviderId: 'evolink-gpt-image-2',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'CORE007_CONSENT_REQUIRED');
  });
  assert.equal(plannerCalls, 0);
});

test('legacy image routes reject every CORE-007 marker before an unbudgeted Provider call', async () => {
  let providerCalls = 0;
  const client = {
    async createImageJob() { providerCalls += 1; },
    async createImageEditJob() { providerCalls += 1; },
    async getTask() { providerCalls += 1; },
  };
  await withApi(dependencies({ client }), async (baseUrl) => {
    const generate = await jsonRequest(baseUrl, '/api/agent/image-jobs', { prompt: 'x', operation: 'image_edit_user_reference' });
    assert.equal(generate.status, 409);
    assert.equal((await generate.json()).error.code, 'CORE007_DEDICATED_ROUTE_REQUIRED');
    const edit = await jsonRequest(baseUrl, '/api/agent/image-edit-jobs', { prompt: 'x', referenceKind: 'user-upload' });
    assert.equal(edit.status, 409);
    assert.equal((await edit.json()).error.code, 'CORE007_DEDICATED_ROUTE_REQUIRED');
  });
  assert.equal(providerCalls, 0);
  assert.throws(() => assertLegacyImageRouteBoundary({ prompt: 'x', image_urls: ['https://invalid.example'] }), (error) => error.code === 'CORE007_DEDICATED_ROUTE_REQUIRED');
});

test('multipart consent, job ID, prompt, cardinality and filename are checked before sanitizer execution', async () => {
  let sanitizerCalls = 0;
  await withApi(dependencies({ sanitizeReference: async () => { sanitizerCalls += 1; throw new Error('must not run'); } }), async (baseUrl) => {
    const scenarios = [
      { form: referenceForm({ consent: 'not-approved' }), code: 'CORE007_CONSENT_REQUIRED' },
      { form: referenceForm({ id: '../bad-job' }), code: 'CORE007_JOB_ID_INVALID' },
      { form: referenceForm({ prompt: 'x'.repeat(32_001) }), code: 'CORE007_PROMPT_INVALID' },
      { form: referenceForm({ filename: `${'a'.repeat(81)}.png` }), code: 'CORE007_FILENAME_INVALID' },
      { form: referenceForm({ extra: { name: 'unexpected', value: 'x' } }), code: 'CORE007_MULTIPART_CARDINALITY_INVALID' },
    ];
    for (const scenario of scenarios) {
      const response = await fetch(`${baseUrl}/api/agent/user-reference-image-jobs`, {
        method: 'POST', headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' }, body: scenario.form,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, scenario.code);
    }
  });
  assert.equal(sanitizerCalls, 0);
});

test('multipart binds the exact browser Blob digest to the sanitized Provider request', async () => {
  const browserBytes = Buffer.from([1, 2, 3, 4, 5, 6]);
  let received;
  let sanitizerCalls = 0;
  const sanitized = {
    buffer: Buffer.from([7, 8, 9]),
    mimeType: 'image/png',
    serverFilename: `${'b'.repeat(32)}.png`,
    sha256: 'c'.repeat(64),
    width: 1,
    height: 1,
  };
  await withApi(dependencies({
    sanitizeReference: async () => { sanitizerCalls += 1; return sanitized; },
    referenceJobs: {
      ...dependencies().referenceJobs,
      async create(input) {
        received = input;
        return { localJobId: input.clientJobId, status: 'processing', progress: 72 };
      },
    },
  }), async (baseUrl) => {
    const binding = createUserReferenceRequestBinding({
      prompt: '非敏感演示编辑',
      clientJobId: 'job-reference-test',
      consentVersion: CONSENT,
      buffer: browserBytes,
    });
    const authorizationId = nextSendAuthorizationId();
    const paidToken = await issuePaidConfirmation(
      baseUrl,
      'image',
      '/api/agent/user-reference-image-jobs',
      binding,
      authorizationId,
    );
    const authorizedPrompt = testAuthorizedImageBodies.get(authorizationId).prompt;
    const response = await fetch(`${baseUrl}/api/agent/user-reference-image-jobs`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', 'X-Elyra-Paid-Confirmation': paidToken },
      body: referenceForm({ bytes: browserBytes, prompt: authorizedPrompt }),
    });
    assert.equal(response.status, 202);
    const replay = await fetch(`${baseUrl}/api/agent/user-reference-image-jobs`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin', 'X-Elyra-Paid-Confirmation': paidToken },
      body: referenceForm({ bytes: browserBytes, prompt: authorizedPrompt }),
    });
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, 'PAID_CONFIRMATION_REPLAYED');
    assert.equal(JSON.stringify(replayBody).includes(paidToken), false);
  });
  assert.equal(sanitizerCalls, 1);
  assert.equal(received.clientReferenceSha256, createHash('sha256').update(browserBytes).digest('hex'));
  assert.equal(received.sanitized, sanitized);
});

test('multipart header, boundary and body deadlines fail closed', async () => {
  assert.throws(
    () => parseMultipartBoundary({ headers: { 'content-type': 'multipart/form-data; boundary=x' }, rawHeaders: [] }),
    (error) => error.code === 'CORE007_MULTIPART_BOUNDARY_INVALID',
  );
  assert.throws(
    () => parseMultipartBoundary({ headers: { 'content-type': 'multipart/form-data; boundary=abcdefghijklmnop' }, rawHeaders: ['X-Probe', 'x'.repeat(17_000)] }),
    (error) => error.code === 'CORE007_HEADERS_TOO_LARGE',
  );

  const delayedRequest = {
    headers: {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      yield Buffer.from('--abcdefghijklmnop--');
    },
  };
  await assert.rejects(
    () => readReferenceMultipart(delayedRequest, 'abcdefghijklmnop', { deadlineMs: 5 }),
    (error) => error.code === 'CORE007_BODY_DEADLINE_EXCEEDED',
  );
});

test('cheap File metadata validation does not read invalid file bytes', async () => {
  const form = referenceForm({ consent: 'not-approved' });
  const file = form.get('file');
  let reads = 0;
  file.arrayBuffer = async () => { reads += 1; return new ArrayBuffer(0); };
  await assert.rejects(() => validateReferenceMultipartForm(form), (error) => error.code === 'CORE007_CONSENT_REQUIRED');
  assert.equal(reads, 0);
});

test('bounded semaphore limits expensive sanitize/provider work and rejects queue overflow', async () => {
  const semaphore = createBoundedSemaphore({ limit: 2, maxQueue: 1 });
  let active = 0;
  let maximum = 0;
  let releaseGate;
  const gate = new Promise((resolvePromise) => { releaseGate = resolvePromise; });
  const expensive = () => semaphore.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate;
    active -= 1;
  });
  const first = expensive();
  const second = expensive();
  const queued = expensive();
  await assert.rejects(expensive(), (error) => error.code === 'CORE007_LOCAL_CAPACITY_REACHED' && error.status === 429);
  assert.deepEqual(semaphore.snapshot(), { active: 2, queued: 1, limit: 2, maxQueue: 1 });
  releaseGate();
  await Promise.all([first, second, queued]);
  assert.equal(maximum, 2);
  assert.deepEqual(semaphore.snapshot(), { active: 0, queued: 0, limit: 2, maxQueue: 1 });
});

test('retry-local-result is the only local retrieval retry and receives a request abort signal', async () => {
  let retryCalls = 0;
  await withApi(dependencies({
    referenceJobs: {
      async retryLocalResult(id, { signal }) {
        retryCalls += 1;
        assert.equal(id, 'job-reference-retry');
        assert.ok(signal instanceof AbortSignal);
        return { localJobId: id, status: 'completed', progress: 100 };
      },
      getBudgetStatus() { throw new Error('budget status must not run'); },
      async retryStatus() { throw new Error('status retry must not run'); },
      cancel() { throw new Error('cancel must not run'); },
      async status() { throw new Error('status must not run'); },
      result() { throw new Error('result must not run'); },
      evidence() { throw new Error('evidence must not run'); },
      async create() { throw new Error('create must not run'); },
    },
  }), async (baseUrl) => {
    const response = await jsonRequest(baseUrl, '/api/agent/user-reference-image-jobs/job-reference-retry', { action: 'retry-local-result' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'completed');
  });
  assert.equal(retryCalls, 1);
});

test('redacted CORE-007 evidence route exposes hashes and counters without Provider identifiers or URLs', async () => {
  const receipt = {
    clientJobIdSha256: 'a'.repeat(64),
    providerTaskIdSha256: 'b'.repeat(64),
    status: 'completed',
    uploadRetryCount: 0,
    statusRetryCount: 1,
    providerSubmitCount: 1,
    uploadHttpStatus: 200,
    generationHttpStatus: 200,
    taskStatusHttpStatus: 200,
    clientReferenceSha256: 'e'.repeat(64),
    referenceSha256: 'c'.repeat(64),
    referenceDimensions: [256, 256],
    resultSha256: 'd'.repeat(64),
    resultDimensions: [1024, 1024],
    budgetCapUsd: 5,
    budgetUsedUsd: 1.05,
    softCancelled: false,
    startedAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:01:00.000Z',
  };
  let evidenceCalls = 0;
  await withApi(dependencies({
    referenceJobs: {
      getBudgetStatus() { throw new Error('budget status must not run'); },
      async create() { throw new Error('create must not run'); },
      async status() { throw new Error('status must not run'); },
      async retryLocalResult() { throw new Error('retry must not run'); },
      async retryStatus() { throw new Error('status retry must not run'); },
      cancel() { throw new Error('cancel must not run'); },
      result() { throw new Error('result must not run'); },
      evidence(id) {
        evidenceCalls += 1;
        assert.equal(id, 'job-reference-evidence');
        return receipt;
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent/user-reference-image-jobs/job-reference-evidence/evidence`, {
      headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), receipt);
  });
  assert.equal(evidenceCalls, 1);
  const serialized = JSON.stringify(receipt);
  for (const forbidden of ['task-unified-', 'https://', 'Authorization', 'Bearer ', 'result-']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('CORE-007 budget preflight is localhost-only and returns no secret or Provider identifier', async () => {
  const status = { capUsd: 5, usedUsd: 1.05, remainingUsd: 3.95, reservationPerAttemptUsd: 1 };
  await withApi(dependencies({
    referenceJobs: {
      getBudgetStatus() { return status; },
      async create() { throw new Error('create must not run'); },
      async status() { throw new Error('status must not run'); },
      async retryLocalResult() { throw new Error('retry must not run'); },
      async retryStatus() { throw new Error('status retry must not run'); },
      cancel() { throw new Error('cancel must not run'); },
      result() { throw new Error('result must not run'); },
      evidence() { throw new Error('evidence must not run'); },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent/core-007-budget`, {
      headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), status);
  });
  assert.doesNotMatch(JSON.stringify(status), /task-unified-|https?:|Authorization|Bearer/);
});

test('CORE-008 budget endpoint returns only redacted shared-ledger totals', async () => {
  const status = { capUsd: 5, usedUsd: 1.000468, reservationPerAttemptUsd: 1 };
  let statusCalls = 0;
  await withApi(dependencies({
    core008ImageGateway: {
      getBudgetStatus() {
        statusCalls += 1;
        return status;
      },
      async createImageJob() { throw new Error('image submit must not run'); },
      async createImageEditJob() { throw new Error('image edit must not run'); },
      async getTask() { throw new Error('status poll must not run'); },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent/core-008-budget`, {
      headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, status);
    assert.deepEqual(Object.keys(body).sort(), ['capUsd', 'reservationPerAttemptUsd', 'usedUsd']);
    assert.doesNotMatch(JSON.stringify(body), /secret|api.?key|provider|task-unified-|https?:|Authorization|Bearer/i);
  });
  assert.equal(statusCalls, 1);
});

test('CORE-008 capability handshake is fixed, read-only and does not touch Provider dependencies', async () => {
  let providerCalls = 0;
  await withApi(dependencies({
    plannerClient: { async createPlan() { providerCalls += 1; throw new Error('must not run'); } },
    core008ImageGateway: {
      getBudgetStatus() { providerCalls += 1; throw new Error('budget must not run'); },
      async createImageJob() { providerCalls += 1; throw new Error('must not run'); },
      async createImageEditJob() { providerCalls += 1; throw new Error('must not run'); },
      async getTask() { providerCalls += 1; throw new Error('must not run'); },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent/core-008-capabilities`, {
      headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), CORE008_LOCAL_API_PROTOCOL);
  });
  assert.equal(providerCalls, 0);
});

test('recovers an existing CORE-008 task by browser Job ID without a new paid submit', async () => {
  const calls = [];
  await withApi(dependencies({
    core008ImageGateway: {
      getTaskForClientJob(clientJobId) {
        calls.push(['recover', clientJobId]);
        return {
          id: 'task-unified-recovered-existing',
          status: 'local_result_pending',
          providerCompleted: true,
          error: { code: 'EVOLINK_RESULT_MIME_INVALID', message: '已脱敏本地结果错误。', retryable: true, retryScope: 'local-result' },
        };
      },
      async createImageJob() { calls.push(['create']); throw new Error('must not submit'); },
      async createImageEditJob() { calls.push(['edit']); throw new Error('must not submit'); },
      async getTask() { calls.push(['status']); throw new Error('must not poll'); },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent/image-jobs/by-client-job/job-refresh-safe`, {
      headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, 'task-unified-recovered-existing');
    assert.equal(body.status, 'local_result_pending');
    assert.equal(body.error.retryScope, 'local-result');
    assert.doesNotMatch(JSON.stringify(body), /https?:\/\/|Authorization|Bearer|api.?key/i);
  });
  assert.deepEqual(calls, [['recover', 'job-refresh-safe']]);
});

test('recovers an exact existing CORE-008 Provider task through the strict same-origin route without requiring or consuming a paid ticket', async () => {
  const recoveryCalls = [];
  let paidConfirmationConsumes = 0;
  const publicRecovery = {
    id: 'task-unified-core008-route-recovered',
    status: 'completed',
    progress: 100,
    resultId: 'image-result-11111111111111111111111111111111',
    result: { mimeType: 'image/png', width: 1024, height: 1024, bytes: 1_234 },
    budget: { capUsd: 5, usedUsd: 1.003, chargedUsd: 0 },
    providerCompleted: true,
  };
  await withApi(dependencies({
    paidConfirmations: {
      consume() {
        paidConfirmationConsumes += 1;
        throw new Error('recovery must not consume paid confirmation');
      },
    },
    core008ImageGateway: {
      async recoverExistingTask(input) {
        recoveryCalls.push(input);
        return publicRecovery;
      },
      async createImageJob() { throw new Error('must not submit'); },
      async createImageEditJob() { throw new Error('must not submit'); },
      async getTask() { throw new Error('must not use normal poll route'); },
    },
  }), async (baseUrl) => {
    const request = {
      clientJobId: 'job-recover-existing-route',
      taskId: 'task-unified-core008-provider-completed',
    };
    const withoutTicket = await jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', request);
    assert.equal(withoutTicket.status, 200);
    const body = await withoutTicket.json();
    assert.deepEqual(body, publicRecovery);
    assert.deepEqual(Object.keys(body).sort(), ['budget', 'id', 'progress', 'providerCompleted', 'result', 'resultId', 'status']);
    assert.doesNotMatch(JSON.stringify(body), /https?:\/\/|Authorization|Bearer|api.?key|cookie|private|secret/i);

    const ignoredTicket = 'R'.repeat(43);
    const withUnusedTicket = await jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', request, { paidToken: ignoredTicket });
    assert.equal(withUnusedTicket.status, 200);
    assert.equal(JSON.stringify(await withUnusedTicket.json()).includes(ignoredTicket), false);
  });
  assert.equal(paidConfirmationConsumes, 0);
  assert.deepEqual(recoveryCalls, [
    { clientJobId: 'job-recover-existing-route', taskId: 'task-unified-core008-provider-completed' },
    { clientJobId: 'job-recover-existing-route', taskId: 'task-unified-core008-provider-completed' },
  ]);
});

test('existing-task recovery fails closed on origin, fetch metadata, body shape and gateway ID validation', async () => {
  const gatewayCalls = [];
  await withApi(dependencies({
    core008ImageGateway: {
      async recoverExistingTask(input) {
        gatewayCalls.push(input);
        if (!/^job-[A-Za-z0-9_-]{1,190}$/.test(input.clientJobId)
          || !/^task-unified-[A-Za-z0-9_-]+$/.test(input.taskId)) {
          throw new Core008BudgetError(400, 'CORE008_RECOVERY_REQUEST_INVALID', '已完成图片任务的恢复标识无效。');
        }
        return { id: input.taskId, status: 'completed' };
      },
      async createImageJob() { throw new Error('must not submit'); },
      async createImageEditJob() { throw new Error('must not submit'); },
      async getTask() { throw new Error('must not use normal poll route'); },
    },
  }), async (baseUrl) => {
    const valid = { clientJobId: 'job-recover-boundary', taskId: 'task-unified-core008-recover-boundary' };
    const rejectedBoundaryRequests = [
      jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', valid, { origin: null }),
      jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', valid, { origin: 'https://cross-site.invalid', fetchSite: 'cross-site' }),
      jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', valid, { fetchSite: null }),
      jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', valid, { fetchSite: 'cross-site' }),
    ];
    for (const responsePromise of rejectedBoundaryRequests) {
      const response = await responsePromise;
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error.code, 'CORE008_RECOVERY_SAME_ORIGIN_REQUIRED');
      assert.doesNotMatch(JSON.stringify(body), /cross-site\.invalid|Authorization|Bearer|api.?key|secret/i);
    }
    assert.equal(gatewayCalls.length, 0, '边界不合格时不得进入 gateway');

    const extraField = await jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', { ...valid, providerUrl: 'https://private.invalid/result.png' });
    assert.equal(extraField.status, 400);
    const extraFieldBody = await extraField.json();
    assert.equal(extraFieldBody.error.code, 'CORE008_RECOVERY_REQUEST_INVALID');
    assert.doesNotMatch(JSON.stringify(extraFieldBody), /private\.invalid|providerUrl|Authorization|Bearer|api.?key/i);
    assert.equal(gatewayCalls.length, 0, '额外字段必须在路由层拒绝');

    for (const invalid of [
      { clientJobId: 'bad-client-job', taskId: valid.taskId },
      { clientJobId: valid.clientJobId, taskId: 'bad-provider-task' },
    ]) {
      const response = await jsonRequest(baseUrl, '/api/agent/image-jobs/recover-existing', invalid);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, 'CORE008_RECOVERY_REQUEST_INVALID');
      assert.equal(JSON.stringify(body).includes(invalid.clientJobId), false);
      assert.equal(JSON.stringify(body).includes(invalid.taskId), false);
      assert.doesNotMatch(JSON.stringify(body), /Authorization|Bearer|api.?key|secret/i);
    }
  });
  assert.deepEqual(gatewayCalls, [
    { clientJobId: 'bad-client-job', taskId: 'task-unified-core008-recover-boundary' },
    { clientJobId: 'job-recover-boundary', taskId: 'bad-provider-task' },
  ]);
});

test('a no-key Planner entry returns a safe error with zero external fetches and zero spend', async () => {
  const budgetDirectory = mkdtempSync(resolve(tmpdir(), 'elyra-core008-no-key-'));
  let externalFetches = 0;
  const plannerClient = createEvoLinkPlannerClient({
    readKey: async () => { throw new Error('private missing-key detail'); },
    fetchImpl: async () => { externalFetches += 1; throw new Error('must not fetch'); },
    budgetLedgerDirectory: budgetDirectory,
    historicalSpentUsd: 0,
    maxAttempts: 1,
  });
  try {
    await withApi(dependencies({ plannerClient }), async (baseUrl) => {
      const input = { prompt: '非敏感无密钥演示', imageProviderId: 'evolink-gpt-image-2' };
      const token = await issuePaidConfirmation(baseUrl, 'planner', '/api/agent/plans', input);
      const response = await jsonRequest(baseUrl, '/api/agent/plans', input, { paidToken: token });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.deepEqual(body.error, {
        code: 'PLANNER_NOT_CONFIGURED',
        message: '本机服务未配置 Agent Planner 凭据。',
        retryable: false,
        retryScope: 'none',
      });
      assert.doesNotMatch(JSON.stringify(body), /private missing-key detail|EVOLINK_API_KEY|Authorization|Bearer/i);
    });
    assert.equal(externalFetches, 0);
    assert.equal(plannerClient.getBudgetStatus().usedUsd, 0);
  } finally {
    rmSync(budgetDirectory, { recursive: true, force: true });
  }
});

test('text and fixed-reference image routes can only submit through the CORE-008 gateway', async () => {
  const legacyCalls = [];
  const gatewayCalls = [];
  const previousReferenceUrl = process.env.ELYRA_DEMO_REFERENCE_URL;
  process.env.ELYRA_DEMO_REFERENCE_URL = 'https://demo.invalid/fixed-reference.png';
  try {
    await withApi(dependencies({
      client: {
        async createImageJob(input) { legacyCalls.push(['generate', input]); throw new Error('legacy Provider must not run'); },
        async createImageEditJob(input) { legacyCalls.push(['edit', input]); throw new Error('legacy Provider must not run'); },
        async getTask(id) { legacyCalls.push(['status', id]); throw new Error('legacy Provider must not run'); },
      },
      core008ImageGateway: {
        getBudgetStatus() { return { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }; },
        async createImageJob(input) {
          gatewayCalls.push(['generate', input]);
          return { id: 'task-unified-core008-text', status: 'pending' };
        },
        async createImageEditJob(input) {
          gatewayCalls.push(['edit', input]);
          return { id: 'task-unified-core008-fixed', status: 'pending' };
        },
        async getTask(id) {
          gatewayCalls.push(['status', id]);
          return {
            id,
            status: 'completed',
            progress: 100,
            resultId: id.includes('text') ? 'image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'image-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            result: { mimeType: 'image/png', width: 1, height: 1, bytes: 3 },
          };
        },
        result(id) {
          gatewayCalls.push(['result', id]);
          return { buffer: Buffer.from([1, 2, 3]), mimeType: 'image/png', width: 1, height: 1, bytes: 3 };
        },
      },
    }), async (baseUrl) => {
      const textInput = {
        prompt: '非敏感文本生图演示',
        clientJobId: 'job-core008-text',
        size: '1:1',
      };
      const textToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', textInput);
      const textResponse = await jsonRequest(baseUrl, '/api/agent/image-jobs', textInput, { paidToken: textToken });
      assert.equal(textResponse.status, 202);
      assert.equal((await textResponse.json()).id, 'task-unified-core008-text');
      const textStatusResponse = await fetch(`${baseUrl}/api/agent/jobs/task-unified-core008-text`, {
        headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(textStatusResponse.status, 200);
      const textStatusBody = await textStatusResponse.json();
      assert.equal(textStatusBody.resultId, 'image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      assert.doesNotMatch(JSON.stringify(textStatusBody), /https?:\/\/|results|provider-cdn/i);
      const textResult = await fetch(`${baseUrl}/api/agent/image-job-results/${textStatusBody.resultId}`, {
        headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(textResult.status, 200);
      assert.equal(textResult.headers.get('cache-control'), 'no-store');
      assert.equal(textResult.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await textResult.arrayBuffer()), Buffer.from([1, 2, 3]));

      const fixedInput = {
        prompt: '非敏感固定参考图编辑演示',
        clientJobId: 'job-core008-fixed',
        size: '1:1',
      };
      const fixedToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-edit-jobs', fixedInput);
      const fixedResponse = await jsonRequest(baseUrl, '/api/agent/image-edit-jobs', fixedInput, { paidToken: fixedToken });
      assert.equal(fixedResponse.status, 202);
      assert.equal((await fixedResponse.json()).id, 'task-unified-core008-fixed');
      const fixedReplay = await jsonRequest(baseUrl, '/api/agent/image-edit-jobs', fixedInput, { paidToken: fixedToken });
      assert.equal(fixedReplay.status, 409);
      const fixedReplayBody = await fixedReplay.json();
      assert.equal(fixedReplayBody.error.code, 'PAID_CONFIRMATION_REPLAYED');
      assert.equal(JSON.stringify(fixedReplayBody).includes(fixedToken), false);

      const statusResponse = await fetch(`${baseUrl}/api/agent/jobs/task-unified-core008-fixed`, {
        headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(statusResponse.status, 200);
      const statusBody = await statusResponse.json();
      assert.equal(statusBody.status, 'completed');
      assert.equal(statusBody.resultId, 'image-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      assert.doesNotMatch(JSON.stringify(statusBody), /https?:\/\/|results|provider-cdn/i);
      const fixedResult = await fetch(`${baseUrl}/api/agent/image-job-results/${statusBody.resultId}`, {
        headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.equal(fixedResult.status, 200);
      assert.equal(fixedResult.headers.get('cache-control'), 'no-store');
      assert.equal(fixedResult.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await fixedResult.arrayBuffer()), Buffer.from([1, 2, 3]));
    });
  } finally {
    if (previousReferenceUrl === undefined) delete process.env.ELYRA_DEMO_REFERENCE_URL;
    else process.env.ELYRA_DEMO_REFERENCE_URL = previousReferenceUrl;
  }

  assert.deepEqual(legacyCalls, []);
  assert.deepEqual(gatewayCalls, [
    ['generate', { prompt: executionPromptFor(testPlannerEnvelope({ prompt: '非敏感文本生图演示', imageProviderId: 'evolink-gpt-image-2' })), clientJobId: 'job-core008-text', size: '1:1' }],
    ['status', 'task-unified-core008-text'],
    ['result', 'image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['edit', {
      prompt: executionPromptFor(testPlannerEnvelope(plannerInputForImage('/api/agent/image-edit-jobs', { prompt: '非敏感固定参考图编辑演示' }))),
      clientJobId: 'job-core008-fixed',
      size: '1:1',
      referenceUrl: 'https://demo.invalid/fixed-reference.png',
    }],
    ['status', 'task-unified-core008-fixed'],
    ['result', 'image-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  ]);
});

test('image create errors expose only status-derived classes and never raw Provider response text', async () => {
  const scenarios = [
    [400, 'EVOLINK_REQUEST_INVALID', false, 'none'],
    [401, 'EVOLINK_AUTH_FAILED', false, 'none'],
    [402, 'EVOLINK_BALANCE_REQUIRED', false, 'none'],
    [403, 'EVOLINK_AUTH_FAILED', false, 'none'],
    [429, 'EVOLINK_RATE_LIMITED', true, 'new-provider-job'],
    [503, 'EVOLINK_UNAVAILABLE', true, 'new-provider-job'],
  ];
  let calls = 0;
  await withApi(dependencies({
    core008ImageGateway: {
      getBudgetStatus() { return { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }; },
      async createImageJob(input) {
        calls += 1;
        const status = Number(input.prompt.split('\n', 1)[0]);
        throw new EvoLinkHttpError(status, 'SECRET_PROMPT_TOKEN', `raw prompt ${input.prompt} https://provider.invalid/private?token=secret`);
      },
      async createImageEditJob() { throw new Error('edit must not run'); },
      async getTask() { throw new Error('status must not run'); },
      result() { throw new Error('result must not run'); },
    },
  }), async (baseUrl) => {
    for (const [status, expectedCode, retryable, retryScope] of scenarios) {
      const input = { prompt: String(status), clientJobId: `job-error-${status}`, size: '1:1' };
      const token = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', input);
      const response = await jsonRequest(baseUrl, '/api/agent/image-jobs', input, { paidToken: token });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.error.code, expectedCode);
      assert.equal(body.error.retryable, retryable);
      assert.equal(body.error.retryScope, retryScope);
      assert.doesNotMatch(JSON.stringify(body), /SECRET_PROMPT_TOKEN|provider\.invalid|token=secret|raw prompt/);
    }
  });
  assert.equal(calls, scenarios.length);
});

test('unknown local image gateway exceptions are redacted instead of reflecting internal paths or URLs', async () => {
  await withApi(dependencies({
    core008ImageGateway: {
      getBudgetStatus() { return { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }; },
      async createImageJob() { throw new Error('secret /Users/private/path https://provider.invalid/raw'); },
      async createImageEditJob() { throw new Error('edit must not run'); },
      async getTask() { throw new Error('status must not run'); },
      result() { throw new Error('result must not run'); },
    },
  }), async (baseUrl) => {
    const input = { prompt: '非敏感演示', clientJobId: 'job-unknown-error', size: '1:1' };
    const token = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', input);
    const response = await jsonRequest(baseUrl, '/api/agent/image-jobs', input, { paidToken: token });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.deepEqual(body.error, { code: 'LOCAL_AGENT_ERROR', message: '本机 Agent 服务异常。', retryable: false, retryScope: 'none' });
    assert.doesNotMatch(JSON.stringify(body), /Users|provider\.invalid|secret|raw/);
  });
});

test('paid confirmation issuance and paid requests require explicit same-origin browser headers', async () => {
  let plannerCalls = 0;
  await withApi(dependencies({
    plannerClient: { async createPlan(input) { plannerCalls += 1; return testPlannerEnvelope(input); } },
  }), async (baseUrl) => {
    for (const options of [{ origin: null }, { fetchSite: null }, { origin: 'http://127.0.0.1:9' }, { fetchSite: 'cross-site' }]) {
      const response = await jsonRequest(baseUrl, '/api/agent/paid-confirmations', { kind: 'planner' }, options);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'PAID_CONFIRMATION_SAME_ORIGIN_REQUIRED');
    }

    const planInput = { prompt: '非敏感同源演示', imageProviderId: 'evolink-gpt-image-2' };
    const token = await issuePaidConfirmation(baseUrl, 'planner', '/api/agent/plans', planInput);
    const rejected = await jsonRequest(baseUrl, '/api/agent/plans', planInput, { paidToken: token, fetchSite: null });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, 'PAID_CONFIRMATION_SAME_ORIGIN_REQUIRED');
    assert.equal(plannerCalls, 0);

    // Origin rejection happens before consumption, so the same ticket remains
    // valid for the subsequent properly same-origin request.
    const accepted = await jsonRequest(baseUrl, '/api/agent/plans', planInput, { paidToken: token });
    assert.equal(accepted.status, 200);
    const replay = await jsonRequest(baseUrl, '/api/agent/plans', planInput, { paidToken: token });
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, 'PAID_CONFIRMATION_REPLAYED');
    assert.equal(JSON.stringify(replayBody).includes(token), false);
    assert.equal(plannerCalls, 1);
  });
});

test('missing, wrong-class, expired and replayed confirmations block Provider activity', async () => {
  let time = Date.parse('2026-08-06T00:00:00.000Z');
  const tokens = ['A', 'B', 'C', 'D', 'E'].map((value) => value.repeat(43));
  const paidConfirmations = createPaidConfirmationStore({
    now: () => time,
    ttlMs: 30_000,
    createToken: () => tokens.shift(),
  });
  let gatewayCalls = 0;
  await withApi(dependencies({
    paidConfirmations,
    core008ImageGateway: {
      getBudgetStatus() { return { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }; },
      async createImageJob() { gatewayCalls += 1; return { id: 'task-unified-confirmed', status: 'pending' }; },
      async createImageEditJob() { gatewayCalls += 1; throw new Error('fixed edit must not run'); },
      async getTask() { throw new Error('status must not run'); },
    },
  }), async (baseUrl) => {
    const input = { prompt: '非敏感演示', clientJobId: 'job-confirmation-boundary', size: '1:1', quality: 'medium', n: 1 };

    const missing = await jsonRequest(baseUrl, '/api/agent/image-jobs', input);
    assert.equal(missing.status, 428);
    assert.equal((await missing.json()).error.code, 'PAID_CONFIRMATION_REQUIRED');

    const plannerToken = await issuePaidConfirmation(baseUrl, 'planner', '/api/agent/plans', {
      prompt: '不同类别规划', imageProviderId: 'evolink-gpt-image-2',
    });
    const wrongClass = await jsonRequest(baseUrl, '/api/agent/image-jobs', input, { paidToken: plannerToken });
    assert.equal(wrongClass.status, 409);
    const wrongClassBody = await wrongClass.json();
    assert.equal(wrongClassBody.error.code, 'PAID_CONFIRMATION_KIND_MISMATCH');
    assert.equal(JSON.stringify(wrongClassBody).includes(plannerToken), false);

    const expiredToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', input);
    time += 30_000;
    const expired = await jsonRequest(baseUrl, '/api/agent/image-jobs', input, { paidToken: expiredToken });
    assert.equal(expired.status, 410);
    const expiredBody = await expired.json();
    assert.equal(expiredBody.error.code, 'PAID_CONFIRMATION_EXPIRED');
    assert.equal(JSON.stringify(expiredBody).includes(expiredToken), false);

    const validToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', input);
    const accepted = await jsonRequest(baseUrl, '/api/agent/image-jobs', input, { paidToken: validToken });
    assert.equal(accepted.status, 202);
    const replay = await jsonRequest(baseUrl, '/api/agent/image-jobs', input, { paidToken: validToken });
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, 'PAID_CONFIRMATION_REPLAYED');
    assert.equal(JSON.stringify(replayBody).includes(validToken), false);
  });
  assert.equal(gatewayCalls, 1);
});

test('request-bound confirmations reject body mutation, cross-action use and cross-route use before Provider activity', async () => {
  let gatewayCalls = 0;
  const previousReferenceUrl = process.env.ELYRA_DEMO_REFERENCE_URL;
  process.env.ELYRA_DEMO_REFERENCE_URL = 'https://demo.invalid/fixed-reference.png';
  try {
    await withApi(dependencies({
      core008ImageGateway: {
        getBudgetStatus() { return { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }; },
        async createImageJob() { gatewayCalls += 1; return { id: 'task-must-not-run', status: 'pending' }; },
        async createImageEditJob() { gatewayCalls += 1; return { id: 'task-must-not-run', status: 'pending' }; },
        async getTask() { throw new Error('status must not run'); },
      },
    }), async (baseUrl) => {
      const original = { prompt: '已确认的非敏感动作', clientJobId: 'job-bound-action-1', size: '1:1' };

      const mutationAuthorizationId = nextSendAuthorizationId();
      const mutatedToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', original, mutationAuthorizationId);
      const duplicateIssue = await jsonRequest(baseUrl, '/api/agent/paid-confirmations', {
        authorizationId: mutationAuthorizationId, kind: 'image', request: { route: '/api/agent/image-jobs', body: original }, chain: testImageChains.get(mutationAuthorizationId),
      });
      assert.equal(duplicateIssue.status, 409);
      assert.equal((await duplicateIssue.json()).error.code, 'PAID_CONFIRMATION_ALREADY_ISSUED');
      const mutated = await jsonRequest(baseUrl, '/api/agent/image-jobs', { ...original, prompt: '未经确认的篡改动作' }, { paidToken: mutatedToken });
      assert.equal(mutated.status, 409);
      assert.equal((await mutated.json()).error.code, 'PAID_CONFIRMATION_REQUEST_MISMATCH');
      const mutatedReplay = await jsonRequest(baseUrl, '/api/agent/image-jobs', original, { paidToken: mutatedToken });
      assert.equal(mutatedReplay.status, 409);
      assert.equal((await mutatedReplay.json()).error.code, 'PAID_CONFIRMATION_REPLAYED');

      const crossActionToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', original);
      const crossAction = await jsonRequest(baseUrl, '/api/agent/image-jobs', { ...original, clientJobId: 'job-bound-action-2' }, { paidToken: crossActionToken });
      assert.equal(crossAction.status, 409);
      assert.equal((await crossAction.json()).error.code, 'PAID_CONFIRMATION_REQUEST_MISMATCH');

      const crossRouteToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-edit-jobs', original);
      const crossRoute = await jsonRequest(baseUrl, '/api/agent/image-jobs', original, { paidToken: crossRouteToken });
      assert.equal(crossRoute.status, 409);
      assert.equal((await crossRoute.json()).error.code, 'PAID_CONFIRMATION_REQUEST_MISMATCH');

      const injectedDigest = await jsonRequest(baseUrl, '/api/agent/paid-confirmations', {
        authorizationId: nextSendAuthorizationId(),
        kind: 'image',
        request: { route: '/api/agent/image-jobs', body: original },
        requestDigest: '0'.repeat(64),
      });
      assert.equal(injectedDigest.status, 400);
      assert.equal((await injectedDigest.json()).error.code, 'PAID_CONFIRMATION_REQUEST_INVALID');
    });
  } finally {
    if (previousReferenceUrl === undefined) delete process.env.ELYRA_DEMO_REFERENCE_URL;
    else process.env.ELYRA_DEMO_REFERENCE_URL = previousReferenceUrl;
  }
  assert.equal(gatewayCalls, 0);
});

test('every paid POST route rejects a missing ticket before Planner, gateway, sanitizer or reference service activity', async () => {
  let plannerCalls = 0;
  let gatewayCalls = 0;
  let sanitizerCalls = 0;
  let referenceCalls = 0;
  const previousReferenceUrl = process.env.ELYRA_DEMO_REFERENCE_URL;
  process.env.ELYRA_DEMO_REFERENCE_URL = 'https://demo.invalid/fixed-reference.png';
  try {
    await withApi(dependencies({
      plannerClient: { async createPlan() { plannerCalls += 1; throw new Error('planner must not run'); } },
      core008ImageGateway: {
        getBudgetStatus() { return { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }; },
        async createImageJob() { gatewayCalls += 1; throw new Error('image must not run'); },
        async createImageEditJob() { gatewayCalls += 1; throw new Error('edit must not run'); },
        async getTask() { throw new Error('status must not run'); },
      },
      sanitizeReference: async () => { sanitizerCalls += 1; throw new Error('sanitizer must not run'); },
      referenceJobs: {
        ...dependencies().referenceJobs,
        async create() { referenceCalls += 1; throw new Error('reference service must not run'); },
      },
    }), async (baseUrl) => {
      const responses = [
        await jsonRequest(baseUrl, '/api/agent/plans', { prompt: '非敏感规划', imageProviderId: 'evolink-gpt-image-2' }),
        await jsonRequest(baseUrl, '/api/agent/image-jobs', { prompt: '非敏感文生图', clientJobId: 'job-missing-confirmation-generate', size: '1:1', quality: 'medium', n: 1 }),
        await jsonRequest(baseUrl, '/api/agent/image-edit-jobs', { prompt: '非敏感固定图编辑', clientJobId: 'job-missing-confirmation-edit', size: '1:1', quality: 'medium', n: 1 }),
        await fetch(`${baseUrl}/api/agent/user-reference-image-jobs`, {
          method: 'POST',
          headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
          body: referenceForm(),
        }),
      ];
      for (const response of responses) {
        assert.equal(response.status, 428);
        assert.equal((await response.json()).error.code, 'PAID_CONFIRMATION_REQUIRED');
      }
    });
  } finally {
    if (previousReferenceUrl === undefined) delete process.env.ELYRA_DEMO_REFERENCE_URL;
    else process.env.ELYRA_DEMO_REFERENCE_URL = previousReferenceUrl;
  }
  assert.deepEqual({ plannerCalls, gatewayCalls, sanitizerCalls, referenceCalls }, {
    plannerCalls: 0,
    gatewayCalls: 0,
    sanitizerCalls: 0,
    referenceCalls: 0,
  });
});

test('cheap Planner and Image validation happens before ticket consumption', async () => {
  let plannerCalls = 0;
  let imageCalls = 0;
  await withApi(dependencies({
    plannerClient: { async createPlan(input) { plannerCalls += 1; return testPlannerEnvelope(input); } },
    core008ImageGateway: {
      getBudgetStatus() { return { capUsd: 5, usedUsd: 0, reservationPerAttemptUsd: 1 }; },
      async createImageJob() { imageCalls += 1; return { id: 'task-unified-valid', status: 'pending' }; },
      async createImageEditJob() { throw new Error('edit must not run'); },
      async getTask() { throw new Error('status must not run'); },
    },
  }), async (baseUrl) => {
    const validPlannerInput = {
      prompt: '非敏感演示规划', imageProviderId: 'evolink-gpt-image-2',
    };
    const plannerToken = await issuePaidConfirmation(baseUrl, 'planner', '/api/agent/plans', validPlannerInput);
    const invalidPlanner = await jsonRequest(baseUrl, '/api/agent/plans', {
      prompt: '', imageProviderId: 'evolink-gpt-image-2',
    }, { paidToken: plannerToken });
    assert.equal(invalidPlanner.status, 400);
    const validPlanner = await jsonRequest(baseUrl, '/api/agent/plans', validPlannerInput, { paidToken: plannerToken });
    assert.equal(validPlanner.status, 200);

    const validImageInput = {
      prompt: '非敏感演示', clientJobId: 'job-cheap-image-validation', size: '1:1', quality: 'medium', n: 1,
    };
    const imageToken = await issuePaidConfirmation(baseUrl, 'image', '/api/agent/image-jobs', validImageInput);
    const invalidImage = await jsonRequest(baseUrl, '/api/agent/image-jobs', {
      prompt: '非敏感演示', clientJobId: 'job-cheap-image-validation', size: '1K', quality: 'medium', n: 1,
    }, { paidToken: imageToken });
    assert.equal(invalidImage.status, 400);
    const missingClientJobId = await jsonRequest(baseUrl, '/api/agent/image-jobs', {
      prompt: '非敏感演示', size: '1:1', quality: 'medium', n: 1,
    }, { paidToken: imageToken });
    assert.equal(missingClientJobId.status, 400);
    const validImage = await jsonRequest(baseUrl, '/api/agent/image-jobs', validImageInput, { paidToken: imageToken });
    assert.equal(validImage.status, 202);
  });
  assert.equal(plannerCalls, 2, '图片发送授权必须先完成同 Send Planner 链绑定');
  assert.equal(imageCalls, 1);
});

test('CORE-008 persistent budget directory is anchored to the controlled server entry instead of process.cwd', () => {
  const expected = resolve(fileURLToPath(new URL('..', import.meta.url)), '.elyra-runtime', 'core-008-budget');
  assert.equal(CORE008_BUDGET_DIRECTORY, expected);
  const probeCwd = mkdtempSync(resolve(tmpdir(), 'elyra-core008-cwd-probe-'));
  try {
    const moduleUrl = new URL('./elyra-server.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { CORE008_BUDGET_DIRECTORY } from ${JSON.stringify(moduleUrl)}; process.stdout.write(CORE008_BUDGET_DIRECTORY);`,
    ], { cwd: probeCwd, encoding: 'utf8' });
    assert.equal(output, expected);
    assert.notEqual(output, resolve(probeCwd, '.elyra-runtime', 'core-008-budget'));
  } finally {
    rmSync(probeCwd, { recursive: true, force: true });
  }
});
