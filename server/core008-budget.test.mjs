import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { ClientInputError, EvoLinkHttpError } from './evolink.mjs';
import { createPlannerBudgetLedger } from './planner-budget.mjs';
import { createCore008ImageGateway } from './core008-budget.mjs';
import { PLANNER_MODEL, createEvoLinkPlannerClient } from './planner.mjs';
import { ReferenceJobError } from './reference-jobs.mjs';

const validPlannerResponse = () => new Response(JSON.stringify({
  id: 'msg_core008_shared_ledger',
  type: 'message',
  role: 'assistant',
  model: PLANNER_MODEL,
  stop_reason: 'tool_use',
  usage: { input_tokens: 120, output_tokens: 80 },
  content: [{
    type: 'tool_use',
    id: 'tool_core008_shared_ledger',
    name: 'submit_elyra_plan',
    input: {
      intent: {
        normalized_prompt: '生成一个克制的非敏感产品演示主视觉',
        goal: '验证共享预算约束下的设计任务',
        constraints: ['非敏感演示数据', '保持主体清晰'],
      },
      plan: {
        operation: 'image_generate',
        summary: '先规划，再在同一预算账本下提交图片任务。',
        steps: ['确认视觉目标', '提交图片任务'],
        visual_direction: {
          subject: '演示产品',
          style: '克制商业摄影',
          lighting: '柔和轮廓光',
          composition: '居中留白',
        },
      },
    },
  }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fixture = async (options = {}) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'elyra-core008-budget-'));
  const ledger = createPlannerBudgetLedger({ directory });
  const calls = [];
  let taskSequence = 0;
  const client = {
    async createImageJob(input) { calls.push(['generate', input]); taskSequence += 1; return { id: `task-unified-core008-${taskSequence}`, status: 'pending' }; },
    async createImageEditJob(input) { calls.push(['edit', input]); taskSequence += 1; return { id: `task-unified-core008-${taskSequence}`, status: 'pending' }; },
    async getTask(id) { calls.push(['status', id]); return { id, status: 'completed' }; },
    ...options.client,
  };
  const gateway = createCore008ImageGateway({
    client,
    budgetLedger: options.gatewayLedger ? options.gatewayLedger(ledger) : ledger,
    ensureConfigured: options.ensureConfigured ?? (async () => undefined),
    budgetMilestone: options.budgetMilestone,
    resolveProviderResult: options.resolveProviderResult ?? (async () => ({
      buffer: Buffer.from([1, 2, 3]),
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes: 3,
      sha256: 'a'.repeat(64),
    })),
    createResultId: options.createResultId,
  });
  return { directory, ledger, calls, gateway, cleanup: () => rm(directory, { recursive: true, force: true }) };
};

test('shares one persistent cap across image submissions and returns only redacted budget totals', async (t) => {
  const ctx = await fixture();
  t.after(ctx.cleanup);
  const first = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-budget-0' });
  assert.deepEqual(first.budget, { capUsd: 5, usedUsd: 1, chargedUsd: 1 });
  for (let index = 0; index < 4; index += 1) await ctx.gateway.createImageEditJob({ prompt: `edit-${index}`, clientJobId: `job-budget-${index + 1}` });
  await assert.rejects(() => ctx.gateway.createImageJob({ prompt: 'over-cap', clientJobId: 'job-budget-over' }), { code: 'CORE008_BUDGET_EXCEEDED', status: 402 });
  assert.equal(ctx.calls.length, 5);
  assert.deepEqual(ctx.gateway.getBudgetStatus(), { capUsd: 5, usedUsd: 5, reservationPerAttemptUsd: 1 });
});

test('reports a CORE009 budget namespace when the shared image gateway is bound to the independent CORE009 ledger', async (t) => {
  const ctx = await fixture({ budgetMilestone: 'CORE009' });
  t.after(ctx.cleanup);
  for (let index = 0; index < 5; index += 1) await ctx.gateway.createImageJob({ prompt: `core009-${index}`, clientJobId: `job-core009-${index}` });
  await assert.rejects(() => ctx.gateway.createImageJob({ prompt: 'over-cap', clientJobId: 'job-core009-over' }), (error) => (
    error.code === 'CORE009_BUDGET_EXCEEDED'
      && error.status === 402
      && /CORE-009/.test(error.message)
  ));
});

test('configuration failure occurs before reserve and Provider activity', async (t) => {
  const ctx = await fixture({ ensureConfigured: async () => { throw new Error('not configured'); } });
  t.after(ctx.cleanup);
  await assert.rejects(() => ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-not-configured' }), /not configured/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 0);
});

test('input rejection releases reservation but ambiguous Provider failure is conservatively charged', async (t) => {
  let mode = 'input';
  const ctx = await fixture({
    client: {
      async createImageJob() {
        if (mode === 'input') throw new ClientInputError('invalid');
        throw new Error('ambiguous network failure');
      },
    },
  });
  t.after(ctx.cleanup);
  await assert.rejects(() => ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-input-failure' }), ClientInputError);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 0);
  mode = 'network';
  await assert.rejects(() => ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-network-failure' }), /ambiguous/);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
});

test('status polling never reserves a second paid amount', async (t) => {
  const ctx = await fixture();
  t.after(ctx.cleanup);
  await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-status-budget' });
  const before = ctx.gateway.getBudgetStatus();
  await ctx.gateway.getTask('task-unified-core008-1');
  assert.deepEqual(ctx.gateway.getBudgetStatus(), before);
});

test('recovers one completed existing Provider task without create, reserve, settle or budget drift', async (t) => {
  const events = [];
  let reserveCalls = 0;
  let settleCalls = 0;
  const ctx = await fixture({
    ensureConfigured: async () => { events.push('configured'); },
    client: {
      async getTask(id) {
        events.push('status');
        return { id, status: 'completed', results: ['https://provider.example/recovered.png?private=1'] };
      },
    },
    resolveProviderResult: async () => {
      events.push('materialized');
      return {
        buffer: Buffer.from([31, 32, 33]),
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
        bytes: 3,
        sha256: 'd'.repeat(64),
      };
    },
    createResultId: () => 'image-result-dddddddddddddddddddddddddddddddd',
    gatewayLedger: (ledger) => ({
      getStatusSync: (...args) => ledger.getStatusSync(...args),
      async reserve(...args) { reserveCalls += 1; return ledger.reserve(...args); },
      async settle(...args) { settleCalls += 1; return ledger.settle(...args); },
    }),
  });
  t.after(ctx.cleanup);

  const before = ctx.gateway.getBudgetStatus();
  const recovered = await ctx.gateway.recoverExistingTask({
    clientJobId: 'job-recover-existing',
    taskId: 'task-unified-core008-existing',
  });

  assert.deepEqual(events, ['configured', 'status', 'materialized']);
  assert.equal(reserveCalls, 0);
  assert.equal(settleCalls, 0);
  assert.equal(ctx.calls.filter(([kind]) => kind === 'generate' || kind === 'edit').length, 0);
  assert.deepEqual(ctx.gateway.getBudgetStatus(), before);
  assert.deepEqual(recovered, {
    id: 'task-unified-core008-existing',
    status: 'completed',
    progress: 100,
    resultId: 'image-result-dddddddddddddddddddddddddddddddd',
    result: { mimeType: 'image/png', width: 1024, height: 1024, bytes: 3 },
    budget: { capUsd: 5, usedUsd: 0, chargedUsd: 0 },
    providerCompleted: true,
  });
  assert.deepEqual(ctx.gateway.getTaskForClientJob('job-recover-existing'), recovered);
  assert.deepEqual(ctx.gateway.result(recovered.resultId).buffer, Buffer.from([31, 32, 33]));
});

test('deduplicates concurrent and repeated exact recovery while preserving one bidirectional binding', async (t) => {
  let statusCalls = 0;
  let materializeCalls = 0;
  let releaseStatus;
  let markStarted;
  const started = new Promise((resolvePromise) => { markStarted = resolvePromise; });
  const released = new Promise((resolvePromise) => { releaseStatus = resolvePromise; });
  const ctx = await fixture({
    client: {
      async getTask(id) {
        statusCalls += 1;
        markStarted();
        await released;
        return { id, status: 'completed' };
      },
    },
    resolveProviderResult: async () => {
      materializeCalls += 1;
      return { buffer: Buffer.from([1]), mimeType: 'image/png', width: 1, height: 1, bytes: 1, sha256: 'e'.repeat(64) };
    },
    createResultId: () => 'image-result-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  });
  t.after(ctx.cleanup);
  const request = { clientJobId: 'job-recover-concurrent', taskId: 'task-unified-core008-concurrent-recovery' };
  const before = ctx.gateway.getBudgetStatus();

  const first = ctx.gateway.recoverExistingTask(request);
  const duplicate = ctx.gateway.recoverExistingTask({ taskId: request.taskId, clientJobId: request.clientJobId });
  assert.equal(first, duplicate, '并发恢复必须共享同一个 Promise');
  await started;
  assert.equal(statusCalls, 1);
  releaseStatus();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.deepEqual(duplicateResult, firstResult);
  const repeated = await ctx.gateway.recoverExistingTask(request);
  assert.deepEqual(repeated, firstResult);
  assert.equal(statusCalls, 1);
  assert.equal(materializeCalls, 1);
  assert.deepEqual(ctx.gateway.getBudgetStatus(), before);
});

test('fails closed on either direction of recovery rebinding and on a mismatched Provider response ID', async (t) => {
  let statusCalls = 0;
  const ctx = await fixture({
    client: {
      async getTask() {
        statusCalls += 1;
        return { id: 'task-unified-core008-returned-other', status: 'completed' };
      },
    },
  });
  t.after(ctx.cleanup);
  const request = { clientJobId: 'job-recover-strict-binding', taskId: 'task-unified-core008-requested' };
  const before = ctx.gateway.getBudgetStatus();

  await assert.rejects(
    () => ctx.gateway.recoverExistingTask(request),
    { code: 'CORE008_RECOVERY_TASK_ID_MISMATCH', status: 502 },
  );
  await assert.rejects(
    () => ctx.gateway.recoverExistingTask({ clientJobId: request.clientJobId, taskId: 'task-unified-core008-another-task' }),
    { code: 'CORE008_RECOVERY_JOB_BINDING_CONFLICT', status: 409 },
  );
  await assert.rejects(
    () => ctx.gateway.recoverExistingTask({ clientJobId: 'job-recover-another-job', taskId: request.taskId }),
    { code: 'CORE008_RECOVERY_TASK_BINDING_CONFLICT', status: 409 },
  );
  assert.equal(statusCalls, 1);
  assert.deepEqual(ctx.gateway.getBudgetStatus(), before);
});

test('accepts only an explicitly completed recovery task and never materializes pending or failed tasks', async (t) => {
  for (const status of ['pending', 'processing', 'failed']) {
    let materializeCalls = 0;
    const ctx = await fixture({
      client: {
        async getTask(id) { return { id, status }; },
      },
      resolveProviderResult: async () => {
        materializeCalls += 1;
        throw new Error('must not materialize');
      },
    });
    t.after(ctx.cleanup);
    const before = ctx.gateway.getBudgetStatus();
    await assert.rejects(
      () => ctx.gateway.recoverExistingTask({
        clientJobId: `job-recover-${status}`,
        taskId: `task-unified-core008-recover-${status}`,
      }),
      { code: 'CORE008_RECOVERY_TASK_NOT_COMPLETED', status: 409 },
    );
    assert.equal(materializeCalls, 0);
    assert.deepEqual(ctx.gateway.getBudgetStatus(), before);
  }
});

test('returns the existing task for a sequential duplicate with reordered fields and explicit defaults', async (t) => {
  const ctx = await fixture();
  t.after(ctx.cleanup);
  const first = await ctx.gateway.createImageJob({
    prompt: 'same demo',
    clientJobId: 'job-sequential-idempotent',
  });
  const completed = await ctx.gateway.getTask(first.id);
  const duplicate = await ctx.gateway.createImageJob({
    n: 1,
    quality: 'medium',
    clientJobId: 'job-sequential-idempotent',
    size: '1:1',
    prompt: 'same demo',
  });

  assert.deepEqual(duplicate, completed);
  assert.equal(ctx.calls.filter(([kind]) => kind === 'generate').length, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
});

test('shares one atomic in-flight promise for concurrent exact duplicates', async (t) => {
  let providerCalls = 0;
  let markStarted;
  let releaseProvider;
  const started = new Promise((resolvePromise) => { markStarted = resolvePromise; });
  const released = new Promise((resolvePromise) => { releaseProvider = resolvePromise; });
  const ctx = await fixture({
    client: {
      async createImageJob() {
        providerCalls += 1;
        markStarted();
        await released;
        return { id: 'task-unified-core008-concurrent', status: 'pending' };
      },
    },
  });
  t.after(ctx.cleanup);

  const first = ctx.gateway.createImageJob({ prompt: 'concurrent demo', clientJobId: 'job-concurrent-idempotent' });
  const duplicate = ctx.gateway.createImageJob({ clientJobId: 'job-concurrent-idempotent', prompt: 'concurrent demo', size: '1:1', quality: 'medium', n: 1 });
  assert.equal(first, duplicate, '并发重复必须共享同一原子占位 Promise');
  await started;
  assert.equal(providerCalls, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
  releaseProvider();
  const [firstTask, duplicateTask] = await Promise.all([first, duplicate]);
  assert.deepEqual(duplicateTask, firstTask);
  assert.equal(providerCalls, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
});

test('fails closed when one clientJobId is reused with changed content or another operation', async (t) => {
  let releaseProvider;
  let markStarted;
  const started = new Promise((resolvePromise) => { markStarted = resolvePromise; });
  const released = new Promise((resolvePromise) => { releaseProvider = resolvePromise; });
  let providerCalls = 0;
  const ctx = await fixture({
    client: {
      async createImageJob() {
        providerCalls += 1;
        markStarted();
        await released;
        return { id: 'task-unified-core008-conflict', status: 'pending' };
      },
      async createImageEditJob() {
        providerCalls += 1;
        return { id: 'task-unified-core008-conflict-edit', status: 'pending' };
      },
    },
  });
  t.after(ctx.cleanup);

  const accepted = ctx.gateway.createImageJob({ prompt: 'original binding', clientJobId: 'job-binding-conflict' });
  await started;
  await assert.rejects(
    () => ctx.gateway.createImageJob({ prompt: 'changed binding', clientJobId: 'job-binding-conflict' }),
    { code: 'CORE008_JOB_BINDING_CONFLICT', status: 409 },
  );
  await assert.rejects(
    () => ctx.gateway.createImageEditJob({ prompt: 'original binding', clientJobId: 'job-binding-conflict', referenceUrl: 'https://example.com/reference.png' }),
    { code: 'CORE008_JOB_BINDING_CONFLICT', status: 409 },
  );
  assert.equal(providerCalls, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
  releaseProvider();
  await accepted;
  await assert.rejects(
    () => ctx.gateway.createImageJob({ prompt: 'changed after submit', clientJobId: 'job-binding-conflict' }),
    { code: 'CORE008_JOB_BINDING_CONFLICT', status: 409 },
  );
  assert.equal(providerCalls, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
});

test('allows the same binding to recover after a definitely pre-Provider failure but never rebinds its clientJobId', async (t) => {
  let configuredCalls = 0;
  const ctx = await fixture({
    ensureConfigured: async () => {
      configuredCalls += 1;
      if (configuredCalls === 1) throw new Error('temporary local configuration read failure');
    },
  });
  t.after(ctx.cleanup);
  const request = { prompt: 'recover exact request', clientJobId: 'job-safe-recovery' };

  await assert.rejects(() => ctx.gateway.createImageJob(request), /temporary local configuration/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 0);
  await assert.rejects(
    () => ctx.gateway.createImageJob({ ...request, prompt: 'must not rebind' }),
    { code: 'CORE008_JOB_BINDING_CONFLICT', status: 409 },
  );
  const recovered = await ctx.gateway.createImageJob({ clientJobId: request.clientJobId, prompt: request.prompt, quality: 'medium', size: '1:1', n: 1 });
  const duplicate = await ctx.gateway.createImageJob(request);
  assert.deepEqual(duplicate, recovered);
  assert.equal(ctx.calls.filter(([kind]) => kind === 'generate').length, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
});

test('retains an unsafe tombstone after an ambiguous Provider failure and never resubmits it', async (t) => {
  let providerCalls = 0;
  const ctx = await fixture({
    client: {
      async createImageJob() {
        providerCalls += 1;
        throw new Error('ambiguous provider transport failure');
      },
    },
  });
  t.after(ctx.cleanup);
  const request = { prompt: 'ambiguous request', clientJobId: 'job-unsafe-retry' };

  await assert.rejects(() => ctx.gateway.createImageJob(request), /ambiguous provider transport/);
  assert.equal(providerCalls, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
  await assert.rejects(
    () => ctx.gateway.createImageJob(request),
    { code: 'CORE008_JOB_RETRY_UNSAFE', status: 409 },
  );
  await assert.rejects(
    () => ctx.gateway.createImageJob({ ...request, prompt: 'changed ambiguous request' }),
    { code: 'CORE008_JOB_BINDING_CONFLICT', status: 409 },
  );
  assert.equal(providerCalls, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1);
});

test('materializes text and fixed-reference results behind one stable opaque localhost result without exposing Provider URLs', async (t) => {
  let resolveCalls = 0;
  const ctx = await fixture({
    client: {
      async getTask(id) {
        ctx.calls.push(['status', id]);
        return {
          id,
          status: 'completed',
          results: ['https://provider-cdn.example/private-temporary-result.png?secret=never-browser'],
          raw_provider_field: 'must-not-cross-boundary',
        };
      },
    },
    resolveProviderResult: async (task) => {
      resolveCalls += 1;
      assert.equal(task.results[0].startsWith('https://provider-cdn.example/'), true);
      return { buffer: Buffer.from([7, 8, 9]), mimeType: 'image/png', width: 640, height: 480, bytes: 3, sha256: 'b'.repeat(64) };
    },
    createResultId: () => 'image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  t.after(ctx.cleanup);

  const generated = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-generated' });
  const completed = await ctx.gateway.getTask(generated.id);
  const repeated = await ctx.gateway.getTask(generated.id);
  assert.deepEqual(completed, repeated);
  assert.deepEqual(completed, {
    id: 'task-unified-core008-1',
    status: 'completed',
    progress: 100,
    resultId: 'image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    result: { mimeType: 'image/png', width: 640, height: 480, bytes: 3 },
    budget: { capUsd: 5, usedUsd: 1, chargedUsd: 1 },
    providerCompleted: true,
  });
  assert.equal(resolveCalls, 1, '重复状态读取不得重新下载或处理 Provider 结果');
  const serialized = JSON.stringify(completed);
  for (const forbidden of ['https://', 'provider-cdn.example', 'secret=never-browser', 'raw_provider_field', 'results']) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(ctx.gateway.result(completed.resultId).buffer, Buffer.from([7, 8, 9]));

  const edited = await ctx.gateway.createImageEditJob({ prompt: 'edit', clientJobId: 'job-edited' });
  assert.equal(edited.id, 'task-unified-core008-2');
});

test('keeps the exact allowlisted downloader code while retaining a completed Provider task for local-only retry', async (t) => {
  const ctx = await fixture({
    client: {
      async getTask(id) {
        return { id, status: 'completed', results: ['https://provider.example/transient.png?raw=private'] };
      },
    },
    resolveProviderResult: async () => {
      throw new ReferenceJobError(502, 'EVOLINK_RESULT_DNS_UNAVAILABLE', 'raw internal resolver text and URL https://private.invalid', true);
    },
  });
  t.after(ctx.cleanup);
  const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-local-result-failure' });
  const status = await ctx.gateway.getTask(created.id);
  assert.equal(status.status, 'local_result_pending');
  assert.deepEqual(status.error, {
    code: 'EVOLINK_RESULT_DNS_UNAVAILABLE',
    message: 'Provider 已完成生成，但本地结果尚未取回；只能重试本地取回，不会再次提交付费生成。',
    retryable: true,
    retryScope: 'local-result',
  });
  assert.doesNotMatch(JSON.stringify(status), /https?:|private\.invalid|provider\.example|raw internal/);
  assert.throws(() => ctx.gateway.result('image-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), { code: 'CORE008_RESULT_NOT_FOUND' });
});

test('re-materializes the same completed Provider task after a terminal local boundary error without create or charge again', async (t) => {
  let providerStatusCalls = 0;
  let materializeCalls = 0;
  const ctx = await fixture({
    client: {
      async getTask(id) {
        providerStatusCalls += 1;
        return { id, status: 'completed', results: ['https://provider.example/result.bin?private=never-browser'] };
      },
    },
    resolveProviderResult: async () => {
      materializeCalls += 1;
      if (materializeCalls === 1) {
        throw new ReferenceJobError(502, 'EVOLINK_RESULT_MIME_INVALID', 'raw Provider MIME and https://provider.example/private', false);
      }
      return {
        buffer: Buffer.from([10, 20, 30]),
        mimeType: 'image/png',
        width: 512,
        height: 512,
        bytes: 3,
        sha256: 'c'.repeat(64),
      };
    },
    createResultId: () => 'image-result-cccccccccccccccccccccccccccccccc',
  });
  t.after(ctx.cleanup);

  const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-terminal-local-result-retry' });
  const budgetAfterCreate = ctx.gateway.getBudgetStatus();
  const pending = await ctx.gateway.getTask(created.id);
  assert.equal(pending.status, 'local_result_pending');
  assert.deepEqual(pending.error, {
    code: 'EVOLINK_RESULT_MIME_INVALID',
    message: 'Provider 已完成生成，但本地结果尚未取回；只能重试本地取回，不会再次提交付费生成。',
    retryable: true,
    retryScope: 'local-result',
  });
  assert.doesNotMatch(JSON.stringify(pending), /https?:|provider\.example|raw Provider|result\.bin/);

  const recovered = await ctx.gateway.getTask(created.id);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.resultId, 'image-result-cccccccccccccccccccccccccccccccc');
  assert.equal(providerStatusCalls, 1, '本地物化重试必须复用已缓存的同一 Provider completed task');
  assert.equal(materializeCalls, 2, '第二次 getTask 只能重新执行本地物化');
  assert.equal(ctx.calls.filter(([kind]) => kind === 'generate').length, 1, '不得再次创建 Provider 图片任务');
  assert.deepEqual(ctx.gateway.getBudgetStatus(), budgetAfterCreate, '本地物化重试不得再次预留或结算预算');
  assert.deepEqual(ctx.gateway.result(recovered.resultId).buffer, Buffer.from([10, 20, 30]));
});

test('preserves only the exact local-result safety-code allowlist and redacts unknown or internal failures', async (t) => {
  const allowlistedCodes = [
    'EVOLINK_RESULT_SCHEMA_INVALID',
    'EVOLINK_RESULT_URL_INVALID',
    'EVOLINK_RESULT_DNS_UNAVAILABLE',
    'EVOLINK_RESULT_NETWORK_BOUNDARY',
    'EVOLINK_RESULT_DOWNLOAD_FAILED',
    'EVOLINK_RESULT_TOO_LARGE',
    'EVOLINK_RESULT_MIME_INVALID',
    'EVOLINK_RESULT_EMPTY',
    'EVOLINK_RESULT_REDIRECT_INVALID',
    'EVOLINK_RESULT_REDIRECT_LIMIT',
    'EVOLINK_RESULT_NETWORK_ERROR',
  ];

  for (const [index, code] of allowlistedCodes.entries()) {
    const ctx = await fixture({
      resolveProviderResult: async () => {
        throw new ReferenceJobError(502, code, `raw allowlisted failure ${code} https://private.invalid/${index}`, false);
      },
    });
    t.after(ctx.cleanup);
    const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: `job-allowlisted-result-${index}` });
    const pending = await ctx.gateway.getTask(created.id);
    assert.equal(pending.status, 'local_result_pending', `${code} 必须保留已完成 Provider 结果供本地重试`);
    assert.equal(pending.error.code, code, `${code} 必须原样跨越精确 allowlist`);
    assert.equal(pending.error.retryable, true);
    assert.equal(pending.error.retryScope, 'local-result');
    assert.doesNotMatch(JSON.stringify(pending), /https?:|private\.invalid|raw allowlisted/);
  }

  for (const [index, errorFactory] of [
    () => new ReferenceJobError(502, 'EVOLINK_RESULT_PRIVATE_INTERNAL', 'private path /Users/demo and https://private.invalid', false),
    () => new Error('unknown internal stack detail https://private.invalid secret-token'),
  ].entries()) {
    const ctx = await fixture({ resolveProviderResult: async () => { throw errorFactory(); } });
    t.after(ctx.cleanup);
    const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: `job-redacted-result-${index}` });
    const pending = await ctx.gateway.getTask(created.id);
    assert.equal(pending.status, 'local_result_pending');
    assert.deepEqual(pending.error, {
      code: 'CORE008_RESULT_INVALID',
      message: 'Provider 已完成生成，但本地结果尚未取回；只能重试本地取回，不会再次提交付费生成。',
      retryable: true,
      retryScope: 'local-result',
    });
    assert.doesNotMatch(JSON.stringify(pending), /PRIVATE_INTERNAL|\/Users\/demo|private\.invalid|secret-token|unknown internal/);
  }
});

test('retains malformed sanitized output for local-only retry and rejects unknown task/result identifiers without leaking details', async (t) => {
  const ctx = await fixture({ resolveProviderResult: async () => ({ buffer: Buffer.from([1]), mimeType: 'image/jpeg', width: 1, height: 1, bytes: 1 }) });
  t.after(ctx.cleanup);
  await assert.rejects(() => ctx.gateway.getTask('task-unified-not-created'), { code: 'CORE008_TASK_NOT_FOUND' });
  const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-invalid-output' });
  const failed = await ctx.gateway.getTask(created.id);
  assert.equal(failed.status, 'local_result_pending');
  assert.equal(failed.error.code, 'CORE008_RESULT_INVALID');
  assert.equal(failed.error.retryable, true);
  assert.equal(failed.error.retryScope, 'local-result');
  assert.equal(JSON.stringify(failed).includes('image/jpeg'), false);
  assert.throws(() => ctx.gateway.result('../escape'), { code: 'CORE008_RESULT_ID_INVALID' });
});

test('maps task-status 429 and 5xx to status-only and rechecks the same task without another paid submit', async (t) => {
  let statusCalls = 0;
  const ctx = await fixture({
    client: {
      async getTask(id) {
        statusCalls += 1;
        if (statusCalls === 1) throw new EvoLinkHttpError(503, 'RAW_PROVIDER_CODE', 'raw https://provider.invalid/status?secret=1');
        return { id, status: 'completed', results: ['https://provider.example/result.png?private=1'] };
      },
    },
    createResultId: () => 'image-result-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  });
  t.after(ctx.cleanup);
  const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-status-retry' });
  const usedBeforeStatus = ctx.gateway.getBudgetStatus().usedUsd;
  const unavailable = await ctx.gateway.getTask(created.id);
  assert.deepEqual(unavailable.error, {
    code: 'EVOLINK_STATUS_UNAVAILABLE',
    message: '已提交的 EvoLink 图片任务状态暂时无法查询。',
    retryable: true,
    retryScope: 'status-only',
  });
  assert.doesNotMatch(JSON.stringify(unavailable), /provider\.invalid|secret=1|RAW_PROVIDER_CODE/);
  const completed = await ctx.gateway.getTask(created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultId, 'image-result-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(statusCalls, 2);
  assert.equal(ctx.calls.filter(([kind]) => kind === 'generate').length, 1);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, usedBeforeStatus);
});

test('maps permanent task-status authorization failure to non-retryable without exposing upstream text', async (t) => {
  const ctx = await fixture({
    client: {
      async getTask() { throw new EvoLinkHttpError(401, 'MALICIOUS_CODE', 'raw prompt https://provider.invalid/private'); },
    },
  });
  t.after(ctx.cleanup);
  const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-status-auth' });
  const failed = await ctx.gateway.getTask(created.id);
  assert.deepEqual(failed.error, {
    code: 'EVOLINK_STATUS_AUTH_FAILED',
    message: '已提交的 EvoLink 图片任务状态查询被拒绝。',
    retryable: false,
    retryScope: 'none',
  });
  assert.doesNotMatch(JSON.stringify(failed), /MALICIOUS|provider\.invalid|raw prompt/);
});

test('never reflects a syntactically valid but untrusted Provider task failure code', async (t) => {
  const ctx = await fixture({
    client: {
      async getTask(id) {
        return { id, status: 'failed', error: { code: 'SECRET_PROMPT_TOKEN', message: 'https://provider.invalid/private?token=raw' } };
      },
    },
  });
  t.after(ctx.cleanup);
  const created = await ctx.gateway.createImageJob({ prompt: 'demo', clientJobId: 'job-provider-failure' });
  const failed = await ctx.gateway.getTask(created.id);
  assert.deepEqual(failed.error, {
    code: 'EVOLINK_TASK_FAILED',
    message: 'EvoLink 图片任务失败；不会向浏览器暴露 Provider 原始响应。',
    retryable: false,
    retryScope: 'none',
  });
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_PROMPT_TOKEN|provider\.invalid|token=raw/);
});

test('Planner and Image consume the same persistent CORE-008 five-dollar ledger', async (t) => {
  const ctx = await fixture();
  t.after(ctx.cleanup);
  let plannerProviderCalls = 0;
  const planner = createEvoLinkPlannerClient({
    budgetLedger: ctx.ledger,
    budgetCapUsd: 5,
    attemptReservationUsd: 0.05,
    historicalSpentUsd: 0,
    readKey: async () => 'test-only-redacted-key',
    sleepImpl: async () => {},
    fetchImpl: async () => {
      plannerProviderCalls += 1;
      return validPlannerResponse();
    },
  });

  const plan = await planner.createPlan({
    prompt: '生成一个克制的非敏感产品演示主视觉',
    imageProviderId: 'evolink-gpt-image-2',
  });
  const afterPlanner = planner.getBudgetStatus();
  assert.equal(plannerProviderCalls, 1);
  assert.equal(plan.evidence.budgetCapUsd, 5);
  assert.equal(afterPlanner.capUsd, 5);
  assert.equal(afterPlanner.usedUsd, 0.000468);

  const image = await ctx.gateway.createImageJob({ prompt: 'same approved demo', clientJobId: 'job-shared-ledger' });
  assert.equal(ctx.calls.length, 1);
  assert.equal(image.budget.usedUsd, 1.000468);
  assert.equal(planner.getBudgetStatus().usedUsd, 1.000468);
  assert.equal(ctx.gateway.getBudgetStatus().usedUsd, 1.000468);

  const ledgerText = await import('node:fs/promises').then(({ readFile }) => readFile(ctx.ledger.path, 'utf8'));
  assert.equal(ledgerText.includes('test-only-redacted-key'), false);
  assert.equal(ledgerText.includes('msg_core008_shared_ledger'), false);
  assert.equal(ledgerText.includes('task-unified-core008-1'), false);
});
