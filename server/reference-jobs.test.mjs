import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPlannerBudgetLedger } from './planner-budget.mjs';
import { EvoLinkHttpError } from './evolink.mjs';
import { ReferenceJobError, createReferenceJobService } from './reference-jobs.mjs';

const fixture = readFileSync(new URL('../public/assets/elyra-speaker.png', import.meta.url));
const sanitized = {
  buffer: fixture,
  mimeType: 'image/png',
  serverFilename: 'a'.repeat(32) + '.png',
  sha256: 'b'.repeat(64),
  width: 1024,
  height: 1024,
};

const temporaryLedger = () => mkdtempSync(join(tmpdir(), 'elyra-core007-budget-test-'));
const input = (id = 'job-reference-1') => ({ clientJobId: id, clientReferenceSha256: 'a'.repeat(64), prompt: '改为克制的高端棚拍', sanitized, consentVersion: 'CORE-007-DATA-BOUNDARY-V1' });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('keeps upload and task URLs server-only and returns a local result Blob over a DNS-pinned request', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const client = standardClient(calls);
  const requestImpl = fakeHttpsRequest([{ status: 200, headers: { 'content-type': 'image/png', 'content-length': String(fixture.length) }, body: fixture }], calls);
  const service = createReferenceJobService({
    evolinkClient: client,
    budgetLedger: createPlannerBudgetLedger({ directory }),
    requestImpl,
    lookupImpl: publicDns,
  });

  const created = await service.create(input());
  assert.equal(created.status, 'processing');
  assert.equal(created.budget.capUsd, 5);
  assert.equal(created.budget.usedUsd, 1);
  assert.doesNotMatch(JSON.stringify(created), /https?:|task-unified|file_url|results/);

  const completed = await service.status('job-reference-1');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.providerCompleted, true);
  assert.equal(completed.retryScope, 'none');
  assert.match(completed.resultId, /^result-[a-f0-9]{32}$/);
  assert.equal(completed.result.mimeType, 'image/png');
  assert.doesNotMatch(JSON.stringify(completed), /https?:|task-unified|files\.example|cdn\.example/);
  assert.equal(service.evidence('job-reference-1').clientReferenceSha256, 'a'.repeat(64));
  const result = service.result(completed.resultId);
  assert.equal(result.mimeType, 'image/png');
  assert.ok(result.buffer.length > 0);
  assert.deepEqual(calls.map(([name]) => name), ['upload', 'create', 'status', 'download']);
  assert.equal(calls.at(-1)[2], '93.184.216.34');
});

test('reports the bound CORE009 budget namespace when an upload-edit reservation is refused', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = createPlannerBudgetLedger({ directory });
  await ledger.reserve({ capUsd: 5, amountUsd: 5 });
  const service = createReferenceJobService({
    evolinkClient: standardClient([]),
    budgetLedger: ledger,
    budgetMilestone: 'CORE009',
  });
  await assert.rejects(service.create(input('job-reference-core009-budget-blocked')), (error) => (
    error.code === 'CORE009_BUDGET_EXCEEDED'
      && error.status === 402
      && /CORE-009/.test(error.message)
  ));
});

test('sniffs and safely sanitizes a valid PNG when the Provider omits or generalizes Content-Type', async (context) => {
  const cases = [
    ['missing-content-type', { 'content-length': String(fixture.length) }],
    ['octet-stream', { 'content-type': 'application/octet-stream', 'content-length': String(fixture.length) }],
  ];
  for (const [name, headers] of cases) {
    await context.test(name, async () => {
      const directory = temporaryLedger();
      try {
        const service = createReferenceJobService({
          evolinkClient: standardClient([], `task-unified-${name}`),
          budgetLedger: createPlannerBudgetLedger({ directory }),
          requestImpl: fakeHttpsRequest([{ status: 200, headers, body: fixture }]),
          lookupImpl: publicDns,
        });
        const clientJobId = `job-reference-${name}`;
        await service.create(input(clientJobId));
        const completed = await service.status(clientJobId);
        assert.equal(completed.status, 'completed');
        assert.equal(completed.error, undefined);
        assert.equal(completed.result.mimeType, 'image/png');
        const result = service.result(completed.resultId);
        assert.equal(result.mimeType, 'image/png');
        assert.ok(result.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test('rejects generic binary responses that are not supported images and explicit MIME/magic mismatches', async (context) => {
  const cases = [
    ['octet-stream-html', 'application/octet-stream', Buffer.from('<!doctype html><title>not an image</title>'), 'RESULT_IMAGE_INVALID'],
    ['octet-stream-random', 'application/octet-stream', Buffer.from([0x13, 0x37, 0x00, 0xff, 0x7f, 0x01]), 'RESULT_IMAGE_INVALID'],
    ['declared-jpeg-actual-png', 'image/jpeg', fixture, 'RESULT_IMAGE_INVALID'],
  ];
  for (const [name, contentType, body, expectedCode] of cases) {
    await context.test(name, async () => {
      const directory = temporaryLedger();
      try {
        const service = createReferenceJobService({
          evolinkClient: standardClient([], `task-unified-${name}`),
          budgetLedger: createPlannerBudgetLedger({ directory }),
          requestImpl: fakeHttpsRequest([{
            status: 200,
            headers: { 'content-type': contentType, 'content-length': String(body.length) },
            body,
          }]),
          lookupImpl: publicDns,
        });
        const clientJobId = `job-reference-${name}`;
        await service.create(input(clientJobId));
        const failed = await service.status(clientJobId);
        assert.equal(failed.status, 'failed');
        assert.equal(failed.error.code, expectedCode);
        assert.equal(failed.error.retryable, false);
        assert.equal(failed.retryScope, 'none');
        assert.equal(failed.resultId, undefined);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test('provider-completed local download failure can only retry local retrieval without a new paid generation', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const client = standardClient(calls, 'task-unified-core007-local-retry');
  const requestImpl = fakeHttpsRequest([
    { status: 503, headers: { 'content-type': 'text/plain' }, body: Buffer.from('unavailable') },
    { status: 200, headers: { 'content-type': 'image/png' }, body: fixture },
  ], calls);
  const service = createReferenceJobService({
    evolinkClient: client,
    budgetLedger: createPlannerBudgetLedger({ directory }),
    requestImpl,
    lookupImpl: publicDns,
  });

  await service.create(input('job-reference-local-retry'));
  const pending = await service.status('job-reference-local-retry');
  assert.equal(pending.status, 'local_result_pending');
  assert.equal(pending.providerCompleted, true);
  assert.equal(pending.retryScope, 'local-result');
  assert.equal(pending.error.retryable, true);
  assert.match(pending.error.message, /只能重试本地取回/);

  const completed = await service.retryLocalResult('job-reference-local-retry');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.budget.usedUsd, 1);
  assert.equal(calls.filter(([name]) => name === 'create').length, 1);
  assert.equal(calls.filter(([name]) => name === 'download').length, 2);
});

test('task failure classification never offers retry for auth, balance, parameter, safety or schema errors', async (context) => {
  const cases = [
    ['AUTH_FAILED', 401],
    ['INSUFFICIENT_BALANCE', 402],
    ['INVALID_PARAMETER', 400],
    ['CONTENT_POLICY_REJECTED', 422],
    ['SCHEMA_INVALID', 422],
  ];
  for (const [code, status] of cases) {
    await context.test(String(code), async () => {
      const directory = temporaryLedger();
      try {
        const service = createReferenceJobService({
          evolinkClient: {
            async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
            async createUploadedReferenceEditJob() { return { id: `task-unified-${String(code).toLowerCase()}` }; },
            async getTask() { return { status: 'failed', error: { code, status } }; },
          },
          budgetLedger: createPlannerBudgetLedger({ directory }),
        });
        const id = `job-reference-${String(code).toLowerCase().replaceAll('_', '-')}`;
        await service.create(input(id));
        const failed = await service.status(id);
        assert.equal(failed.status, 'failed');
        assert.equal(failed.error.retryable, false);
        assert.equal(failed.retryScope, 'none');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test('only an explicit transient task code or 429/5xx status permits a new-provider-job retry', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
      async createUploadedReferenceEditJob() { return { id: 'task-unified-transient' }; },
      async getTask() { return { status: 'failed', error: { code: 'SERVICE_UNAVAILABLE', status: 503 } }; },
    },
    budgetLedger: createPlannerBudgetLedger({ directory }),
  });
  await service.create(input('job-reference-transient'));
  const failed = await service.status('job-reference-transient');
  assert.equal(failed.error.retryable, true);
  assert.equal(failed.retryScope, 'new-provider-job');
});

test('soft cancel aborts an in-flight local status request without claiming remote cancellation', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let statusStarted;
  const started = new Promise((resolve) => { statusStarted = resolve; });
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
      async createUploadedReferenceEditJob() { return { id: 'task-unified-core007-cancel' }; },
      async getTask(_taskId, { signal }) {
        statusStarted();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
    budgetLedger: createPlannerBudgetLedger({ directory }),
  });
  await service.create(input('job-reference-cancel'));
  const pendingStatus = service.status('job-reference-cancel');
  await started;
  const cancelled = service.cancel('job-reference-cancel');
  assert.equal(cancelled.status, 'user_cancelled');
  assert.match(cancelled.error.message, /不代表远端任务已取消/);
  assert.equal((await pendingStatus).status, 'user_cancelled');
});

test('a signal cancelled before submit performs zero upload, zero generation and zero budget spend', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = createPlannerBudgetLedger({ directory });
  const controller = new AbortController();
  controller.abort(new Error('cancel before submit'));
  let uploads = 0;
  let creates = 0;
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() { uploads += 1; throw new Error('must not upload'); },
      async createUploadedReferenceEditJob() { creates += 1; throw new Error('must not generate'); },
    },
    budgetLedger: ledger,
  });

  await assert.rejects(
    service.create({ ...input('job-reference-cancelled-before-submit'), signal: controller.signal }),
    (error) => error.code === 'CORE007_USER_CANCELLED' && error.status === 499,
  );
  assert.equal(uploads, 0);
  assert.equal(creates, 0);
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 0);
  const evidence = service.evidence('job-reference-cancelled-before-submit');
  assert.equal(evidence.status, 'user_cancelled');
  assert.equal(evidence.providerSubmitCount, 0);
  assert.equal(evidence.budgetUsedUsd, 0);
});

test('cancelling during upload never starts generation and releases the budget reservation', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = createPlannerBudgetLedger({ directory });
  const controller = new AbortController();
  let uploadStarted;
  const started = new Promise((resolve) => { uploadStarted = resolve; });
  let uploads = 0;
  let creates = 0;
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage({ signal }) {
        uploads += 1;
        uploadStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      async createUploadedReferenceEditJob() { creates += 1; throw new Error('must not generate'); },
    },
    budgetLedger: ledger,
  });

  const pending = service.create({ ...input('job-reference-cancelled-during-upload'), signal: controller.signal });
  await started;
  controller.abort(new Error('cancel during upload'));
  await assert.rejects(pending, (error) => error.code === 'CORE007_USER_CANCELLED' && error.status === 499);
  assert.equal(uploads, 1);
  assert.equal(creates, 0);
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 0);
  const evidence = service.evidence('job-reference-cancelled-during-upload');
  assert.equal(evidence.status, 'user_cancelled');
  assert.equal(evidence.providerSubmitCount, 0);
  assert.equal(evidence.budgetUsedUsd, 0);
});

test('an ambiguous generation POST network failure is never retried and keeps the conservative charge', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = createPlannerBudgetLedger({ directory });
  let uploads = 0;
  let creates = 0;
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() {
        uploads += 1;
        return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0, httpStatus: 200 };
      },
      async createUploadedReferenceEditJob() {
        creates += 1;
        throw new TypeError('socket closed after request bytes were sent');
      },
    },
    budgetLedger: ledger,
  });

  await assert.rejects(
    service.create(input('job-reference-generation-network-ambiguous')),
    (error) => error.code === 'CORE007_PROVIDER_NETWORK_ERROR' && error.retryable === false,
  );
  assert.equal(uploads, 1);
  assert.equal(creates, 1);
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 1);
  const evidence = service.evidence('job-reference-generation-network-ambiguous');
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.providerSubmitCount, 1);
  assert.equal(evidence.budgetUsedUsd, 1);
});

test('status polling retries explicit 429/5xx once but never retries a terminal 4xx', async (context) => {
  for (const [status, expectedCalls, expectedCode, expectedRetryScope] of [
    [429, 2, 'CORE007_STATUS_UNAVAILABLE', 'status-only'],
    [503, 2, 'CORE007_STATUS_UNAVAILABLE', 'status-only'],
    [400, 1, 'STATUS_400', 'none'],
  ]) {
    await context.test(String(status), async () => {
      const directory = temporaryLedger();
      try {
        let statusCalls = 0;
        const service = createReferenceJobService({
          evolinkClient: {
            async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
            async createUploadedReferenceEditJob() { return { id: `task-unified-core007-status-${status}` }; },
            async getTask() {
              statusCalls += 1;
              throw new EvoLinkHttpError(status, `STATUS_${status}`, 'redacted Provider status error');
            },
          },
          budgetLedger: createPlannerBudgetLedger({ directory }),
          sleepImpl: async () => {},
        });
        const id = `job-reference-status-boundary-${status}`;
        await service.create(input(id));
        const failed = await service.status(id);
        assert.equal(statusCalls, expectedCalls);
        assert.equal(failed.status, 'failed');
        assert.equal(failed.error.code, expectedCode);
        assert.equal(failed.retryScope, expectedRetryScope);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test('status requests have a bounded timeout, retry once and then fail with a status-only retry class', { timeout: 1000 }, async (context) => {
  // AbortSignal.timeout is unref'ed. The fixture has no real socket to keep
  // Node alive while the two bounded requests are awaited.
  const keepAlive = setInterval(() => {}, 100);
  context.after(() => clearInterval(keepAlive));
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
      async createUploadedReferenceEditJob() { return { id: 'task-unified-core007-timeout' }; },
      async getTask(_taskId, { signal }) {
        calls += 1;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    },
    budgetLedger: createPlannerBudgetLedger({ directory }),
    statusTimeoutMs: 5,
    sleepImpl: async () => {},
  });
  await service.create(input('job-reference-timeout'));
  const failed = await service.status('job-reference-timeout');
  assert.equal(calls, 2);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'CORE007_STATUS_UNAVAILABLE');
  assert.equal(failed.error.retryable, true);
});

test('status-only retry reuses the same paid Provider task and never uploads or creates again', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let uploads = 0;
  let creates = 0;
  let statusCalls = 0;
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() { uploads += 1; return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
      async createUploadedReferenceEditJob() { creates += 1; return { id: 'task-unified-core007-status-retry' }; },
      async getTask() {
        statusCalls += 1;
        if (statusCalls <= 2) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        return { status: 'completed', results: ['https://cdn.example.test/result.png'] };
      },
    },
    budgetLedger: createPlannerBudgetLedger({ directory }),
    requestImpl: fakeHttpsRequest([{ status: 200, headers: { 'content-type': 'image/png' }, body: fixture }]),
    lookupImpl: publicDns,
    statusTimeoutMs: 5,
    sleepImpl: async () => {},
  });
  await service.create(input('job-reference-status-retry'));
  const failed = await service.status('job-reference-status-retry');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryScope, 'status-only');
  const completed = await service.retryStatus('job-reference-status-retry');
  assert.equal(completed.status, 'completed');
  assert.equal(uploads, 1);
  assert.equal(creates, 1);
  assert.equal(statusCalls, 3);
});

test('budget is fail-closed before upload and a pre-generation failure releases its reservation', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = createPlannerBudgetLedger({ directory });
  let uploads = 0;
  const failing = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() { uploads += 1; throw new ReferenceJobError(400, 'UPLOAD_REJECTED', 'rejected', false); },
      async createUploadedReferenceEditJob() { throw new Error('must not run'); },
    },
    budgetLedger: ledger,
  });
  await assert.rejects(failing.create(input('job-reference-upload-fail')), (error) => error.code === 'UPLOAD_REJECTED');
  assert.equal(uploads, 1);
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 0);

  await ledger.reserve({ capUsd: 5, amountUsd: 5 });
  const blocked = createReferenceJobService({
    evolinkClient: { async uploadReferenceImage() { uploads += 1; } },
    budgetLedger: ledger,
  });
  await assert.rejects(blocked.create(input('job-reference-budget-blocked')), (error) => error.code === 'CORE007_BUDGET_EXCEEDED');
  assert.equal(uploads, 1);
});

test('rejects private, mapped, documentation and redirect destinations before connection', async (context) => {
  const cases = [
    ['https://127.0.0.1/result.png', undefined],
    ['https://240.0.0.1/result.png', undefined],
    ['https://[::ffff:127.0.0.1]/result.png', undefined],
    ['https://cdn.example.test/result.png', [{ address: '203.0.113.8', family: 4 }]],
  ];
  for (const [resultUrl, lookupResult] of cases) {
    await context.test(String(resultUrl), async () => {
      const directory = temporaryLedger();
      let requests = 0;
      try {
        const service = createReferenceJobService({
          evolinkClient: {
            async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
            async createUploadedReferenceEditJob() { return { id: 'task-unified-private' }; },
            async getTask() { return { status: 'completed', results: [resultUrl] }; },
          },
          budgetLedger: createPlannerBudgetLedger({ directory }),
          requestImpl: () => { requests += 1; throw new Error('must not connect'); },
          ...(lookupResult ? { lookupImpl: async () => lookupResult } : {}),
        });
        const id = `job-reference-private-${Math.random().toString(36).slice(2)}`;
        await service.create(input(id));
        const status = await service.status(id);
        assert.equal(status.status, 'failed');
        assert.equal(status.error.code, 'EVOLINK_RESULT_NETWORK_BOUNDARY');
        assert.equal(requests, 0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  const directory = temporaryLedger();
  try {
    let requests = 0;
    const service = createReferenceJobService({
      evolinkClient: standardClient([], 'task-unified-redirect'),
      budgetLedger: createPlannerBudgetLedger({ directory }),
      requestImpl: fakeHttpsRequest([{ status: 302, headers: { location: 'https://127.0.0.1/private.png' } }], { push: () => { requests += 1; } }),
      lookupImpl: publicDns,
    });
    await service.create(input('job-reference-redirect'));
    const status = await service.status('job-reference-redirect');
    assert.equal(status.error.code, 'EVOLINK_RESULT_NETWORK_BOUNDARY');
    assert.equal(requests, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('allows the 198.18/15 proxy fake-IP only for the exact EvoLink result host and keeps TLS/DNS pinning', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const requestCalls = [];
  const requestOptions = [];
  const pinnedAddress = '198.19.44.21';
  const fakeRequest = fakeHttpsRequest([
    { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(fixture.length) }, body: fixture },
  ], requestCalls);
  const service = createReferenceJobService({
    evolinkClient: {
      async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
      async createUploadedReferenceEditJob() { return { id: 'task-unified-evolink-fake-ip-pinned' }; },
      async getTask() { return { status: 'completed', results: ['https://files.evolink.ai/provider/result.png'] }; },
    },
    budgetLedger: createPlannerBudgetLedger({ directory }),
    lookupImpl: async (hostname) => {
      assert.equal(hostname, 'files.evolink.ai');
      return [{ address: pinnedAddress, family: 4 }];
    },
    requestImpl(options, onResponse) {
      requestOptions.push(options);
      return fakeRequest(options, onResponse);
    },
  });

  await service.create(input('job-reference-evolink-fake-ip-pinned'));
  const completed = await service.status('job-reference-evolink-fake-ip-pinned');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.mimeType, 'image/png');
  assert.deepEqual(requestCalls, [['download', 'files.evolink.ai', pinnedAddress, 4]]);
  assert.equal(requestOptions.length, 1);
  assert.equal(requestOptions[0].protocol, 'https:');
  assert.equal(requestOptions[0].hostname, 'files.evolink.ai');
  assert.equal(requestOptions[0].servername, 'files.evolink.ai');
  assert.equal(requestOptions[0].rejectUnauthorized, true);
});

test('rejects the same 198.18/15 fake-IP for every other hostname and for direct IP URLs', async (context) => {
  const cases = [
    ['other-hostname', 'https://cdn.example.test/result.png', '198.18.7.9', 1],
    ['direct-ip', 'https://198.19.7.9/result.png', '198.19.7.9', 0],
  ];
  for (const [name, resultUrl, fakeAddress, expectedLookups] of cases) {
    await context.test(name, async () => {
      const directory = temporaryLedger();
      let requests = 0;
      let lookups = 0;
      try {
        const service = createReferenceJobService({
          evolinkClient: {
            async uploadReferenceImage() { return { fileUrl: 'https://files.example.test/reference.png', retryCount: 0 }; },
            async createUploadedReferenceEditJob() { return { id: `task-unified-evolink-fake-ip-${name}` }; },
            async getTask() { return { status: 'completed', results: [resultUrl] }; },
          },
          budgetLedger: createPlannerBudgetLedger({ directory }),
          lookupImpl: async () => {
            lookups += 1;
            return [{ address: fakeAddress, family: 4 }];
          },
          requestImpl: () => {
            requests += 1;
            throw new Error('must not connect');
          },
        });
        const clientJobId = `job-reference-evolink-fake-ip-${name}`;
        await service.create(input(clientJobId));
        const failed = await service.status(clientJobId);
        assert.equal(failed.status, 'failed');
        assert.equal(failed.error.code, 'EVOLINK_RESULT_NETWORK_BOUNDARY');
        assert.equal(failed.retryScope, 'none');
        assert.equal(lookups, expectedLookups);
        assert.equal(requests, 0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test('the HTTPS connection is pinned to the DNS address validated before request', async (context) => {
  const directory = temporaryLedger();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const requestCalls = [];
  let lookups = 0;
  const service = createReferenceJobService({
    evolinkClient: standardClient([], 'task-unified-pinned'),
    budgetLedger: createPlannerBudgetLedger({ directory }),
    lookupImpl: async () => { lookups += 1; return [{ address: '93.184.216.34', family: 4 }]; },
    requestImpl: fakeHttpsRequest([{ status: 200, headers: { 'content-type': 'image/png' }, body: fixture }], requestCalls),
  });
  await service.create(input('job-reference-pinned'));
  assert.equal((await service.status('job-reference-pinned')).status, 'completed');
  assert.equal(lookups, 1);
  assert.equal(requestCalls[0][2], '93.184.216.34');
});

const standardClient = (calls = [], taskId = 'task-unified-core007-1') => ({
  async uploadReferenceImage(value) { calls.push(['upload', value.filename]); return { fileUrl: 'https://files.example.test/private/reference.png', retryCount: 0 }; },
  async createUploadedReferenceEditJob(value) { calls.push(['create', value.referenceUrl]); return { id: taskId, status: 'pending' }; },
  async getTask() { calls.push(['status']); return { id: taskId, status: 'completed', results: ['https://cdn.example.test/result.png'] }; },
});

const fakeHttpsRequest = (responses, calls = []) => (options, onResponse) => {
  const request = new EventEmitter();
  request.end = () => {
    queueMicrotask(() => {
      options.lookup(options.hostname, {}, (error, address, family) => {
        if (error) { request.emit('error', error); return; }
        calls.push(['download', options.hostname, address, family]);
        const specification = responses.shift();
        if (!specification) { request.emit('error', new Error('missing fake response')); return; }
        const response = Readable.from(specification.body ? [specification.body] : []);
        response.statusCode = specification.status;
        response.headers = specification.headers ?? {};
        onResponse(response);
      });
    });
  };
  request.destroy = (error) => queueMicrotask(() => request.emit('error', error ?? new Error('destroyed')));
  return request;
};
