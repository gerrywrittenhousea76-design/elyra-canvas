import { describe, expect, it, vi } from 'vitest';
import type { CanvasContextGraphSnapshot } from './canvas-context';
import {
  createCreativeDirectorRuntime,
  createMemoryCheckpointStore,
  parseAgentAction,
  validateCheckpoint,
  type ActionExecutionReceipt,
  type AgentAction,
  type AgentActionExecutorPort,
  type AgentCheckpoint,
  type AgentCheckpointStore,
  type AgentObserverPort,
  type AgentPlannerPort,
} from './agent-runtime';

const SHA = {
  a: 'a'.repeat(64),
  b: 'b'.repeat(64),
  c: 'c'.repeat(64),
  d: 'd'.repeat(64),
};

const snapshot = (semanticSha256: string): CanvasContextGraphSnapshot => ({
  schemaVersion: 1,
  viewport: { x: 0, y: 0, scale: 1 },
  selectedObjectIds: [],
  objects: [],
  assets: [],
  versions: [],
  semanticSha256,
});

const selectAction = (actionId = 'select-1'): AgentAction => ({ type: 'select_objects', actionId, objectIds: ['object-1'] });
const focusAction = (actionId = 'focus-1'): AgentAction => ({ type: 'focus_objects', actionId, objectIds: ['object-1'] });
const finishAction = (actionId = 'finish-1'): AgentAction => ({ type: 'finish', actionId, summary: '画布任务已完成。' });
const paidAction = (estimatedCostUsd = 0.12): AgentAction => ({
  type: 'create_image_job',
  actionId: 'paid-1',
  intentId: 'intent-1',
  planId: 'plan-1',
  operation: 'image_generate',
  paid: true,
  estimatedCostUsd,
});
const freeImageAction = (actionId = 'free-image-1'): AgentAction => ({
  type: 'create_image_job',
  actionId,
  intentId: 'intent-free-1',
  planId: 'plan-free-1',
  operation: 'image_generate',
  paid: false,
  estimatedCostUsd: 0,
});
const paidVideoAction = (actionId = 'video-1'): AgentAction => ({
  type: 'create_video_job',
  actionId,
  intentId: 'intent-video-1',
  planId: 'plan-video-1',
  operation: 'video_image_to_video',
  sourceCanvasObjectId: 'object-source',
  sourceVersionId: 'version-source',
  sourceAssetId: 'asset-source',
  paid: true,
  estimatedCostUsd: 1,
});

const videoSnapshot = (semanticSha256: string): CanvasContextGraphSnapshot => ({
  schemaVersion: 1,
  viewport: { x: 0, y: 0, scale: 1 },
  selectedObjectIds: ['object-source'],
  objects: [{ id: 'object-source', kind: 'generated', status: 'ready', bounds: { x: 0, y: 0, width: 100, height: 100 }, zOrder: 0, assetId: 'asset-source', versionId: 'version-source' }],
  assets: [{ id: 'asset-source', kind: 'image', source: 'remote-provider', providerId: 'evolink-gpt-image-2', mimeType: 'image/png', width: 1024, height: 1024, deterministic: false }],
  versions: [{ id: 'version-source', canvasObjectId: 'object-source', sequence: 1, status: 'ready' }],
  semanticSha256,
});

const sequenceObserver = (hashes: string[]): AgentObserverPort => {
  let last = hashes.at(-1) ?? SHA.a;
  return {
    async observe() {
      last = hashes.shift() ?? last;
      return snapshot(last);
    },
  };
};

const sequencePlanner = (actions: unknown[]): AgentPlannerPort => ({
  async nextAction() {
    if (!actions.length) throw new Error('NO_PLANNED_ACTION');
    return actions.shift();
  },
});

const successfulExecutor = (): AgentActionExecutorPort & { calls: Array<{ action: AgentAction; idempotencyKey: string }> } => {
  const calls: Array<{ action: AgentAction; idempotencyKey: string }> = [];
  const receipts = new Map<string, ActionExecutionReceipt>();
  return {
    calls,
    async executeOnce(input) {
      calls.push({ action: input.action, idempotencyKey: input.idempotencyKey });
      const previous = receipts.get(input.idempotencyKey);
      if (previous) return previous;
      const receipt: ActionExecutionReceipt = input.action.type === 'create_image_job' || input.action.type === 'create_video_job'
        ? { ok: true, changed: true, summary: '媒体 Job 已创建。', outputIds: ['job-1'], costUsd: input.action.paid ? 0.12 : 0 }
        : input.action.type === 'finish'
          ? { ok: true, changed: false, summary: '完成。' }
          : { ok: true, changed: true, summary: '画布动作已执行。' };
      receipts.set(input.idempotencyKey, receipt);
      return receipt;
    },
  };
};

const deterministicIds = () => {
  let counter = 0;
  return (prefix: string) => `${prefix}-${++counter}`;
};

const runtimeFixture = (input: {
  actions: unknown[];
  hashes: string[];
  executor?: AgentActionExecutorPort;
  checkpointStore?: AgentCheckpointStore;
  now?: () => number;
}) => {
  const checkpointStore = input.checkpointStore ?? createMemoryCheckpointStore();
  const executor = input.executor ?? successfulExecutor();
  const runtime = createCreativeDirectorRuntime({
    observer: sequenceObserver([...input.hashes]),
    planner: sequencePlanner([...input.actions]),
    executor,
    checkpointStore,
    now: input.now ?? (() => Date.parse('2026-08-06T00:00:00.000Z')),
    idFactory: deterministicIds(),
  });
  return { runtime, executor, checkpointStore };
};

describe('CORE-008 typed action schema', () => {
  it('accepts only the six allowlisted exact action shapes', () => {
    const actions: unknown[] = [
      paidAction(),
      selectAction(),
      focusAction(),
      { type: 'create_version', actionId: 'version-1', parentCanvasObjectId: 'object-1', parentVersionId: 'version-parent', jobId: 'job-1' },
      { type: 'ask_user', actionId: 'ask-1', prompt: '请选择一个方向。' },
      finishAction(),
    ];
    expect(actions.map(parseAgentAction).map((action) => action.type)).toEqual([
      'create_image_job',
      'select_objects',
      'focus_objects',
      'create_version',
      'ask_user',
      'finish',
    ]);
  });

  it('fails closed on unknown actions, extra fields, duplicate IDs and private reasoning', () => {
    expect(() => parseAgentAction({ type: 'delete_objects', actionId: 'delete-1', objectIds: ['object-1'] })).toThrow('ACTION_TYPE_NOT_ALLOWED');
    expect(() => parseAgentAction({ ...selectAction(), unexpected: true })).toThrow('ACTION_EXTRA_OR_MISSING_FIELDS');
    expect(() => parseAgentAction({ type: 'select_objects', actionId: 'select-1', objectIds: ['object-1', 'object-1'] })).toThrow('OBJECT_IDS_INVALID');
    expect(() => parseAgentAction({ ...finishAction(), chainOfThought: 'private' })).toThrow('ACTION_EXTRA_OR_MISSING_FIELDS');
    expect(() => parseAgentAction({ ...paidAction(), estimatedCostUsd: 0 })).toThrow('ESTIMATED_COST_INVALID');
    expect(() => parseAgentAction({ ...paidAction(), paid: false, estimatedCostUsd: 0.01 })).toThrow('FREE_ACTION_COST_INVALID');
    expect(() => parseAgentAction({ ...paidAction(), paid: 'yes' })).toThrow('PAID_FLAG_INVALID');
    const { paid: _paid, ...missingPaid } = paidAction() as Extract<AgentAction, { type: 'create_image_job' }>;
    expect(() => parseAgentAction(missingPaid)).toThrow('ACTION_EXTRA_OR_MISSING_FIELDS');
  });

  it('accepts only the exact CORE-009 image-to-video action shape', () => {
    expect(parseAgentAction(paidVideoAction())).toEqual(paidVideoAction());
    expect(() => parseAgentAction({ ...paidVideoAction(), operation: 'video_generate' })).toThrow('VIDEO_OPERATION_INVALID');
    expect(() => parseAgentAction({ ...paidVideoAction(), sourceAssetId: '' })).toThrow('SOURCE_ASSET_ID_INVALID');
    expect(() => parseAgentAction({ ...paidVideoAction(), durationSeconds: 4 })).toThrow('ACTION_EXTRA_OR_MISSING_FIELDS');
  });
});

describe('CORE-008 bounded CreativeDirectorAgent runtime', () => {
  it('gates a video action against one selected ready image and accounts it once', async () => {
    const observations = [videoSnapshot(SHA.a), videoSnapshot(SHA.b), videoSnapshot(SHA.b), videoSnapshot(SHA.b)];
    const executor = successfulExecutor();
    const runtime = createCreativeDirectorRuntime({
      observer: { async observe() { return observations.shift() ?? videoSnapshot(SHA.b); } },
      planner: sequencePlanner([paidVideoAction(), finishAction()]),
      executor,
      checkpointStore: createMemoryCheckpointStore(),
      now: () => Date.parse('2026-08-06T00:00:00.000Z'),
      idFactory: deterministicIds(),
    });
    const awaiting = await runtime.start({ publicGoal: '让选中图片动起来', planSummary: '创建一个四秒视频。', creationMode: 'video', generationPolicy: 'single-xor', budgetMilestone: 'CORE009', budgetCapUsd: 5 });
    expect(awaiting).toMatchObject({ state: 'AWAITING_CONFIRMATION', creationMode: 'video', generationPolicy: 'single-xor', budgetMilestone: 'CORE009', pendingConfirmation: { kind: 'PAID_ACTION', actionId: 'video-1', estimatedCostUsd: 1 } });
    const completed = await runtime.confirmPaidAction(awaiting, true);
    expect(completed.state).toBe('COMPLETED');
    expect(executor.calls.filter((call) => call.action.type === 'create_video_job')).toHaveLength(1);
    expect(completed.budget).toEqual({ capUsd: 5, spentUsd: 0.12, reservedUsd: 0 });
  });

  it('fails closed on stale video binding, mode mismatch and a second generation action in one send', async () => {
    const staleRuntime = createCreativeDirectorRuntime({
      observer: { async observe() { return snapshot(SHA.a); } },
      planner: sequencePlanner([paidVideoAction()]), executor: successfulExecutor(), checkpointStore: createMemoryCheckpointStore(), idFactory: deterministicIds(),
    });
    await expect(staleRuntime.start({ publicGoal: '生成视频', planSummary: '视频。', creationMode: 'video', generationPolicy: 'single-xor', budgetMilestone: 'CORE009', budgetCapUsd: 5 })).resolves.toMatchObject({ state: 'FAILED', failureCode: 'CORE009_VIDEO_REQUIRES_ONE_SELECTED_IMAGE' });

    const mismatch = runtimeFixture({ actions: [paidVideoAction()], hashes: [SHA.a] });
    await expect(mismatch.runtime.start({ publicGoal: '图片模式', planSummary: '不得视频。', creationMode: 'image', generationPolicy: 'single-xor', budgetMilestone: 'CORE009', budgetCapUsd: 5 })).resolves.toMatchObject({ state: 'FAILED', failureCode: 'CORE009_IMAGE_MODE_VIDEO_FORBIDDEN' });

    const executor = successfulExecutor();
    const xor = runtimeFixture({ actions: [freeImageAction('image-first'), freeImageAction('image-second')], hashes: [SHA.a, SHA.b, SHA.b], executor });
    const firstGate = await xor.runtime.start({ publicGoal: '只生成一次', planSummary: '禁止第二个任务。', creationMode: 'agent', generationPolicy: 'single-xor', budgetCapUsd: 0 });
    const failed = await xor.runtime.confirmAction(firstGate, true);
    expect(failed).toMatchObject({ state: 'FAILED', failureCode: 'CORE009_GENERATION_SUBMISSION_LIMIT' });
    expect(executor.calls.filter((call) => call.action.type === 'create_image_job')).toHaveLength(1);
  });
  it('runs Observe -> Plan -> Act -> Verify -> Checkpoint and completes without exposing CoT', async () => {
    const { runtime, executor, checkpointStore } = runtimeFixture({
      actions: [selectAction(), finishAction()],
      hashes: [SHA.a, SHA.b, SHA.b, SHA.b],
    });
    const run = await runtime.start({ publicGoal: '选择并聚焦产品图', planSummary: '先选择对象，再结束。', budgetCapUsd: 5 });

    expect(run.state).toBe('COMPLETED');
    expect(run.stopReason).toBe('FINISHED');
    expect(run.maxSteps).toBe(4);
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].evaluation).toMatchObject({ verifiedDelta: true, outcome: 'DELTA' });
    expect(run.steps[1].evaluation).toMatchObject({ outcome: 'COMPLETE' });
    expect((executor as ReturnType<typeof successfulExecutor>).calls).toHaveLength(2);
    expect(JSON.stringify(run)).not.toMatch(/chain.?of.?thought|reasoning/i);
    const saved = await checkpointStore.load(run.id);
    expect(saved?.run.state).toBe('COMPLETED');
    await expect(validateCheckpoint(saved as AgentCheckpoint)).resolves.toBeUndefined();
  });

  it('holds every paid image action for explicit confirmation and accounts actual cost once', async () => {
    const executor = successfulExecutor();
    const { runtime } = runtimeFixture({
      actions: [paidAction(), finishAction()],
      hashes: [SHA.a, SHA.b, SHA.b, SHA.b],
      executor,
    });
    const awaiting = await runtime.start({ publicGoal: '生成一张产品图', planSummary: '生成后验证。', budgetCapUsd: 5 });

    expect(awaiting.state).toBe('AWAITING_CONFIRMATION');
    expect(awaiting.pendingConfirmation).toEqual({ kind: 'PAID_ACTION', actionId: 'paid-1', stepId: expect.any(String), estimatedCostUsd: 0.12 });
    expect(executor.calls).toHaveLength(0);

    const completed = await runtime.confirmPaidAction(awaiting, true);
    expect(completed.state).toBe('COMPLETED');
    expect(completed.budget).toEqual({ capUsd: 5, spentUsd: 0.12, reservedUsd: 0 });
    expect(executor.calls.filter((call) => call.action.type === 'create_image_job')).toHaveLength(1);
    await runtime.confirmPaidAction(completed, true);
    expect(executor.calls.filter((call) => call.action.type === 'create_image_job')).toHaveLength(1);
  });

  it('requires a fresh confirmation capability when a later step reuses the same paid actionId', async () => {
    const executor = successfulExecutor();
    const repeatedPaidAction = paidAction();
    const { runtime } = runtimeFixture({
      actions: [paidAction(), repeatedPaidAction, finishAction()],
      hashes: [SHA.a, SHA.b, SHA.c, SHA.d, SHA.d, SHA.d],
      executor,
    });
    const firstGate = await runtime.start({ publicGoal: '生成两个受控版本', planSummary: '每个付费步骤分别确认。', budgetCapUsd: 5 });
    const firstStepId = firstGate.steps[0].id;
    const secondGate = await runtime.confirmPaidAction(firstGate, true);

    expect(secondGate.state).toBe('AWAITING_CONFIRMATION');
    expect(secondGate.steps).toHaveLength(2);
    expect(secondGate.steps[1].action?.actionId).toBe('paid-1');
    expect(secondGate.pendingConfirmation).toMatchObject({
      kind: 'PAID_ACTION',
      actionId: 'paid-1',
      stepId: secondGate.steps[1].id,
    });
    expect(secondGate.pendingConfirmation && 'stepId' in secondGate.pendingConfirmation ? secondGate.pendingConfirmation.stepId : '').not.toBe(firstStepId);
    expect(executor.calls.filter((call) => call.action.type === 'create_image_job')).toHaveLength(1);

    const completed = await runtime.confirmPaidAction(secondGate, true);
    expect(completed.state).toBe('COMPLETED');
    expect(executor.calls.filter((call) => call.action.type === 'create_image_job')).toHaveLength(2);
    expect(new Set(completed.confirmedActionIds).size).toBe(2);
  });

  it('holds a free deterministic image action for general confirmation and runs with a zero budget without charging it', async () => {
    const executor = successfulExecutor();
    const { runtime } = runtimeFixture({
      actions: [freeImageAction(), finishAction()],
      hashes: [SHA.a, SHA.b, SHA.b, SHA.b],
      executor,
    });

    const awaiting = await runtime.start({ publicGoal: '生成本地演示图', planSummary: '用户确认后执行本地 Mock。', budgetCapUsd: 0 });

    expect(awaiting.state).toBe('AWAITING_CONFIRMATION');
    expect(awaiting.pendingConfirmation).toEqual({ kind: 'ACTION', actionId: 'free-image-1', stepId: expect.any(String) });
    expect(awaiting.budget).toEqual({ capUsd: 0, spentUsd: 0, reservedUsd: 0 });
    expect(executor.calls).toHaveLength(0);
    await expect(runtime.confirmPaidAction(awaiting, true)).rejects.toThrow('NO_PAID_ACTION_AWAITING_CONFIRMATION');

    const completed = await runtime.confirmAction(awaiting, true);

    expect(completed.state).toBe('COMPLETED');
    expect(completed.budget).toEqual({ capUsd: 0, spentUsd: 0, reservedUsd: 0 });
    expect(executor.calls.filter((call) => call.action.type === 'create_image_job')).toHaveLength(1);
    expect(completed.steps[0].toolResults[0]).toMatchObject({ ok: true, costUsd: 0 });
  });

  it('retries a confirmed free deterministic image action at most once and never touches paid budget', async () => {
    const executor: AgentActionExecutorPort & { calls: number; keys: string[] } = {
      calls: 0,
      keys: [],
      async executeOnce(input) {
        if (input.action.type === 'finish') return { ok: true, changed: false, summary: '完成。' };
        this.calls += 1;
        this.keys.push(input.idempotencyKey);
        return this.calls === 1
          ? { ok: false, summary: '本地 Mock 暂时失败。', errorCode: 'DETERMINISTIC_MOCK_TRANSIENT', retryable: true, costUsd: 0 }
          : { ok: true, changed: true, summary: '本地 Mock 重试成功。', outputIds: ['job-free-1'], costUsd: 0 };
      },
    };
    const { runtime } = runtimeFixture({
      actions: [freeImageAction(), finishAction()],
      hashes: [SHA.a, SHA.b, SHA.b, SHA.b],
      executor,
    });
    const awaiting = await runtime.start({ publicGoal: '生成本地演示图', planSummary: '只允许一次自动重试。', budgetCapUsd: 0 });

    const completed = await runtime.confirmAction(awaiting, true);

    expect(completed.state).toBe('COMPLETED');
    expect(executor.calls).toBe(2);
    expect(new Set(executor.keys).size).toBe(2);
    expect(completed.steps[0].toolCalls).toHaveLength(2);
    expect(completed.steps[0].toolResults).toHaveLength(2);
    expect(completed.budget).toEqual({ capUsd: 0, spentUsd: 0, reservedUsd: 0 });
  });

  it('fails before mutation when a paid estimate exceeds the milestone budget', async () => {
    const executor = successfulExecutor();
    const { runtime } = runtimeFixture({ actions: [paidAction(0.6)], hashes: [SHA.a], executor });
    const run = await runtime.start({ publicGoal: '生成产品图', planSummary: '生成。', budgetCapUsd: 0.5 });
    expect(run).toMatchObject({ state: 'FAILED', stopReason: 'BUDGET_DENIED', failureCode: 'MILESTONE_BUDGET_CAP_EXCEEDED' });
    expect(executor.calls).toHaveLength(0);
  });

  it('stops after two consecutive actions produce no verified canvas delta', async () => {
    const { runtime, executor } = runtimeFixture({
      actions: [selectAction(), focusAction()],
      hashes: [SHA.a, SHA.a, SHA.a, SHA.a],
    });
    const run = await runtime.start({ publicGoal: '调整画布选择', planSummary: '选择并聚焦。', budgetCapUsd: 5 });
    expect(run).toMatchObject({ state: 'FAILED', stopReason: 'NO_PROGRESS', consecutiveNoDelta: 2 });
    expect((executor as ReturnType<typeof successfulExecutor>).calls).toHaveLength(2);
  });

  it('enforces maxSteps before a hidden fifth continuation', async () => {
    const { runtime, executor } = runtimeFixture({
      actions: [selectAction(), focusAction(), finishAction()],
      hashes: [SHA.a, SHA.b, SHA.b, SHA.c],
    });
    const run = await runtime.start({ publicGoal: '调整画布', planSummary: '执行两个动作。', budgetCapUsd: 5, maxSteps: 2 });
    expect(run).toMatchObject({ state: 'FAILED', stopReason: 'MAX_STEPS', remainingSteps: 0 });
    expect((executor as ReturnType<typeof successfulExecutor>).calls).toHaveLength(2);
  });

  it('enforces the finite deadline before planning continues', async () => {
    let now = Date.parse('2026-08-06T00:00:00.000Z');
    const planner = { nextAction: vi.fn(async () => finishAction()) };
    const checkpointStore = createMemoryCheckpointStore();
    const runtime = createCreativeDirectorRuntime({
      observer: { async observe() { now += 11; return snapshot(SHA.a); } },
      planner,
      executor: successfulExecutor(),
      checkpointStore,
      now: () => now,
      idFactory: deterministicIds(),
    });
    const run = await runtime.start({ publicGoal: '检查画布', planSummary: '检查后结束。', budgetCapUsd: 5, deadlineMs: 10 });
    expect(run).toMatchObject({ state: 'FAILED', stopReason: 'DEADLINE_EXCEEDED' });
    expect(planner.nextAction).not.toHaveBeenCalled();
  });

  it('retries one non-paid transient failure once but never auto-retries a paid action', async () => {
    let nonPaidAttempts = 0;
    const nonPaidExecutor: AgentActionExecutorPort & { keys: string[] } = {
      keys: [],
      async executeOnce(input) {
        this.keys.push(input.idempotencyKey);
        if (input.action.type === 'finish') return { ok: true, changed: false, summary: '完成。' };
        nonPaidAttempts += 1;
        return nonPaidAttempts === 1
          ? { ok: false, summary: '临时失败。', errorCode: 'TEMPORARY_FAILURE', retryable: true }
          : { ok: true, changed: true, summary: '重试成功。' };
      },
    };
    const nonPaid = runtimeFixture({ actions: [selectAction(), finishAction()], hashes: [SHA.a, SHA.b, SHA.b, SHA.b], executor: nonPaidExecutor });
    const completed = await nonPaid.runtime.start({ publicGoal: '选择对象', planSummary: '失败时受限重试。', budgetCapUsd: 5 });
    expect(completed.state).toBe('COMPLETED');
    expect(nonPaidAttempts).toBe(2);
    expect(new Set(nonPaidExecutor.keys).size).toBe(3);

    const paidExecutor: AgentActionExecutorPort & { calls: number } = {
      calls: 0,
      async executeOnce() {
        this.calls += 1;
        return { ok: false, summary: 'Provider 暂时失败。', errorCode: 'PROVIDER_5XX', retryable: true, costUsd: 0 };
      },
    };
    const paid = runtimeFixture({ actions: [paidAction()], hashes: [SHA.a], executor: paidExecutor });
    const awaiting = await paid.runtime.start({ publicGoal: '生成图片', planSummary: '仅提交一次。', budgetCapUsd: 5 });
    const failed = await paid.runtime.confirmPaidAction(awaiting, true);
    expect(failed).toMatchObject({ state: 'FAILED', stopReason: 'ACTION_FAILED' });
    expect(paidExecutor.calls).toBe(1);
  });

  it('fails with RETRY_EXHAUSTED after exactly two retryable non-paid attempts', async () => {
    const executor: AgentActionExecutorPort & { calls: number; keys: string[] } = {
      calls: 0,
      keys: [],
      async executeOnce(input) {
        this.calls += 1;
        this.keys.push(input.idempotencyKey);
        return {
          ok: false,
          summary: '非付费画布动作持续临时失败。',
          errorCode: 'TEMPORARY_CANVAS_FAILURE',
          retryable: true,
        };
      },
    };
    const { runtime } = runtimeFixture({ actions: [selectAction()], hashes: [SHA.a], executor });

    const failed = await runtime.start({ publicGoal: '选择对象', planSummary: '执行受限重试。', budgetCapUsd: 5 });

    expect(failed).toMatchObject({
      state: 'FAILED',
      stopReason: 'RETRY_EXHAUSTED',
      failureCode: 'TEMPORARY_CANVAS_FAILURE',
    });
    expect(executor.calls).toBe(2);
    expect(executor.keys).toHaveLength(2);
    expect(new Set(executor.keys).size).toBe(2);
    expect(failed.steps[0].toolCalls).toHaveLength(2);
    expect(failed.steps[0].toolResults).toHaveLength(2);
  });

  it('fails with CONFIRMATION_DENIED without calling the paid executor when the user refuses', async () => {
    const executor: AgentActionExecutorPort & { calls: number } = {
      calls: 0,
      async executeOnce() {
        this.calls += 1;
        return { ok: true, changed: true, summary: '不应执行。', costUsd: 0.12 };
      },
    };
    const { runtime } = runtimeFixture({ actions: [paidAction()], hashes: [SHA.a], executor });
    const awaiting = await runtime.start({ publicGoal: '生成图片', planSummary: '等待付费确认。', budgetCapUsd: 5 });

    const denied = await runtime.confirmPaidAction(awaiting, false);

    expect(denied).toMatchObject({
      state: 'FAILED',
      stopReason: 'CONFIRMATION_DENIED',
      failureCode: 'PAID_ACTION_REJECTED',
      budget: { capUsd: 5, spentUsd: 0, reservedUsd: 0 },
    });
    expect(denied.pendingConfirmation).toBeUndefined();
    expect(executor.calls).toBe(0);
    expect(denied.steps[0].toolCalls).toHaveLength(0);
    expect(denied.steps[0].toolResults).toHaveLength(0);
  });

  it('fails closed when actual paid cost exceeds the cap and never performs a hidden retry', async () => {
    const executor: AgentActionExecutorPort & { calls: number } = {
      calls: 0,
      async executeOnce() {
        this.calls += 1;
        return {
          ok: true,
          changed: true,
          summary: 'Provider 已返回，但实际费用超过里程碑上限。',
          outputIds: ['job-over-budget'],
          costUsd: 0.6,
        };
      },
    };
    const { runtime } = runtimeFixture({ actions: [paidAction(0.1), finishAction()], hashes: [SHA.a, SHA.b], executor });
    const awaiting = await runtime.start({ publicGoal: '生成图片', planSummary: '生成后验证。', budgetCapUsd: 0.5 });

    const failed = await runtime.confirmPaidAction(awaiting, true);

    expect(failed).toMatchObject({
      state: 'FAILED',
      stopReason: 'BUDGET_EXCEEDED',
      failureCode: 'ACTUAL_COST_EXCEEDED_MILESTONE_CAP',
      budget: { capUsd: 0.5, spentUsd: 0.6, reservedUsd: 0 },
    });
    expect(executor.calls).toBe(1);
    expect(failed.steps).toHaveLength(1);
    expect(failed.steps[0].toolCalls).toHaveLength(1);
    expect(failed.steps[0].toolResults).toHaveLength(1);
    expect(failed.steps[0].toolResults[0]).toMatchObject({ ok: true, costUsd: 0.6 });
  });

  it('passes an explicit ask_user answer to the next planner call without checkpointing the answer', async () => {
    const actions: unknown[] = [
      { type: 'ask_user', actionId: 'ask-1', prompt: '请选择方向。' },
      finishAction(),
    ];
    const plannerInputs: Array<Parameters<AgentPlannerPort['nextAction']>[0]> = [];
    const checkpointStore = createMemoryCheckpointStore();
    const executor = successfulExecutor();
    const runtime = createCreativeDirectorRuntime({
      observer: sequenceObserver([SHA.a, SHA.a, SHA.a, SHA.a]),
      planner: {
        async nextAction(input) {
          plannerInputs.push(structuredClone(input));
          const action = actions.shift();
          if (!action) throw new Error('NO_PLANNED_ACTION');
          return action;
        },
      },
      executor,
      checkpointStore,
      now: () => Date.parse('2026-08-06T00:00:00.000Z'),
      idFactory: deterministicIds(),
    });
    const waiting = await runtime.start({ publicGoal: '明确视觉方向', planSummary: '先询问再结束。', budgetCapUsd: 5 });
    expect(waiting).toMatchObject({
      state: 'AWAITING_CONFIRMATION',
      pendingConfirmation: {
        kind: 'USER_RESPONSE',
        actionId: 'ask-1',
        stepId: expect.any(String),
        publicPrompt: '请选择方向。',
      },
    });
    await runtime.continueRun(waiting);
    expect(executor.calls).toHaveLength(1);

    const answer = '选择克制的深色棚拍方向';
    const completed = await runtime.continueRun(waiting, { userResponse: answer });
    expect(completed.state).toBe('COMPLETED');
    expect(plannerInputs).toHaveLength(2);
    expect(plannerInputs[0].userResponse).toBeUndefined();
    expect(plannerInputs[1].userResponse).toBe(answer);
    expect(JSON.stringify(await checkpointStore.load(completed.id))).not.toContain(answer);
  });

  it('restores the ask_user gate after process loss instead of planning without the transient answer', async () => {
    const memory = createMemoryCheckpointStore();
    let interruptReplanningSave = true;
    const crashStore: AgentCheckpointStore = {
      async save(checkpoint) {
        await memory.save(checkpoint);
        if (interruptReplanningSave && checkpoint.run.state === 'REPLANNING') {
          interruptReplanningSave = false;
          throw new Error('SIMULATED_PROCESS_CRASH');
        }
      },
      load: (runId) => memory.load(runId),
    };
    const first = runtimeFixture({
      actions: [{ type: 'ask_user', actionId: 'ask-recover', prompt: '请重新确认方向。' }],
      hashes: [SHA.a, SHA.a],
      checkpointStore: crashStore,
    });
    const waiting = await first.runtime.start({ publicGoal: '确认方向', planSummary: '先询问。', budgetCapUsd: 5 });
    await expect(first.runtime.continueRun(waiting, { userResponse: '不得持久化的临时答案' })).rejects.toThrow('SIMULATED_PROCESS_CRASH');

    let plannerCalls = 0;
    const second = createCreativeDirectorRuntime({
      observer: sequenceObserver([SHA.a]),
      planner: { async nextAction() { plannerCalls += 1; return finishAction(); } },
      executor: successfulExecutor(),
      checkpointStore: crashStore,
      now: () => Date.parse('2026-08-06T00:00:00.000Z'),
      idFactory: deterministicIds(),
    });
    const restored = await second.resume(waiting.id);
    expect(restored).toMatchObject({
      state: 'AWAITING_CONFIRMATION',
      pendingConfirmation: {
        kind: 'USER_RESPONSE',
        actionId: 'ask-recover',
        publicPrompt: '请重新确认方向。',
      },
    });
    expect(plannerCalls).toBe(0);
    expect(JSON.stringify(await memory.load(waiting.id))).not.toContain('不得持久化的临时答案');
  });

  it('cancellation wins over a late action result and creates no post-cancel ToolResult', async () => {
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const executor: AgentActionExecutorPort = {
      async executeOnce({ signal }) {
        executionStarted();
        return new Promise<ActionExecutionReceipt>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      },
    };
    const checkpointStore = createMemoryCheckpointStore();
    const { runtime } = runtimeFixture({ actions: [selectAction()], hashes: [SHA.a], executor, checkpointStore });
    const startPromise = runtime.start({ publicGoal: '选择对象', planSummary: '执行选择。', budgetCapUsd: 5 });
    await started;
    const runId = [...checkpointStore.entries.keys()][0];
    const persisted = await checkpointStore.load(runId);
    const cancelled = await runtime.cancel((persisted as AgentCheckpoint).run);
    const returned = await startPromise;

    expect(cancelled.state).toBe('CANCELLED');
    expect(returned.state).toBe('CANCELLED');
    expect(returned.stopReason).toBe('USER_CANCELLED');
    expect(returned.steps[0].toolResults).toHaveLength(0);
  });

  it('reconciles a terminal cancelled run to authoritative server spend without reviving execution', async () => {
    const { runtime, checkpointStore } = runtimeFixture({ actions: [paidAction()], hashes: [SHA.a] });
    const awaiting = await runtime.start({
      publicGoal: '生成图片',
      planSummary: '等待确认。',
      budgetCapUsd: 5,
      budgetSpentUsd: 0.05,
    });
    const cancelled = await runtime.cancel(awaiting);
    const reconciled = await runtime.reconcileAuthoritativeTerminalSpend(cancelled.id, 1.05);

    expect(reconciled).toMatchObject({
      state: 'CANCELLED',
      stopReason: 'USER_CANCELLED',
      budget: { capUsd: 5, spentUsd: 1.05, reservedUsd: 0 },
    });
    expect(reconciled?.steps[0].toolResults).toHaveLength(0);
    expect((await checkpointStore.load(cancelled.id))?.run.budget.spentUsd).toBe(1.05);
    await expect(runtime.reconcileAuthoritativeTerminalSpend(cancelled.id, 0.05)).rejects.toThrow('AUTHORITATIVE_SPEND_REGRESSION');
    await expect(runtime.reconcileAuthoritativeTerminalSpend(cancelled.id, 5.01)).rejects.toThrow('AUTHORITATIVE_SPEND_EXCEEDS_CAP');
  });

  it('serializes pause/continue with an in-flight paid action so execution and cost are recorded once', async () => {
    let executionStarted!: () => void;
    let releaseExecution!: (receipt: ActionExecutionReceipt) => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const receipt = new Promise<ActionExecutionReceipt>((resolve) => { releaseExecution = resolve; });
    const executor: AgentActionExecutorPort & { calls: AgentAction[] } = {
      calls: [],
      async executeOnce({ action }) {
        this.calls.push(action);
        if (action.type === 'finish') return { ok: true, changed: false, summary: '完成。' };
        executionStarted();
        return receipt;
      },
    };
    const memory = createMemoryCheckpointStore();
    const { runtime } = runtimeFixture({ actions: [paidAction(), finishAction()], hashes: [SHA.a, SHA.b, SHA.b, SHA.b], executor, checkpointStore: memory });
    const awaiting = await runtime.start({ publicGoal: '生成图片', planSummary: '生成后结束。', budgetCapUsd: 5 });
    const confirmation = runtime.confirmPaidAction(awaiting, true);
    await started;

    const paused = await runtime.pause(awaiting);
    expect(paused.paused).toBe(true);
    const continued = runtime.continueRun(paused);
    releaseExecution({ ok: true, changed: true, summary: '图片已生成。', outputIds: ['job-1'], costUsd: 0.12 });

    const [confirmedRun, continuedRun] = await Promise.all([confirmation, continued]);
    expect(confirmedRun.state).toBe('COMPLETED');
    expect(continuedRun.state).toBe('COMPLETED');
    expect(executor.calls.filter((action) => action.type === 'create_image_job')).toHaveLength(1);
    expect(continuedRun.steps[0].toolResults).toHaveLength(1);
    expect(continuedRun.steps[0].toolResults[0].costUsd).toBe(0.12);
    expect(continuedRun.budget).toEqual({ capUsd: 5, spentUsd: 0.12, reservedUsd: 0 });
  });

  it('serializes asynchronously delayed checkpoints and never persists a lower sequence after a higher one', async () => {
    const persisted: AgentCheckpoint[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const store: AgentCheckpointStore = {
      async save(checkpoint) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, checkpoint.sequence % 2 === 0 ? 1 : 8));
        persisted.push(structuredClone(checkpoint));
        inFlight -= 1;
      },
      async load(runId) {
        const match = persisted.filter((checkpoint) => checkpoint.runId === runId).at(-1);
        return match ? structuredClone(match) : undefined;
      },
    };
    const { runtime } = runtimeFixture({ actions: [finishAction()], hashes: [SHA.a, SHA.a], checkpointStore: store });
    const run = await runtime.start({ publicGoal: '结束', planSummary: '结束运行。', budgetCapUsd: 5 });
    expect(run.state).toBe('COMPLETED');
    expect(maxInFlight).toBe(1);
    expect(persisted.map((checkpoint) => checkpoint.sequence)).toEqual(
      [...persisted].map((checkpoint) => checkpoint.sequence).sort((a, b) => a - b),
    );
    await Promise.all(persisted.map(validateCheckpoint));
  });

  it('queues a pause checkpoint behind an already in-flight save instead of interleaving store writes', async () => {
    const entries = new Map<string, AgentCheckpoint>();
    const saveStarts: number[] = [];
    let secondSaveStarted!: () => void;
    let releaseSecondSave!: () => void;
    const secondStarted = new Promise<void>((resolve) => { secondSaveStarted = resolve; });
    const secondRelease = new Promise<void>((resolve) => { releaseSecondSave = resolve; });
    const store: AgentCheckpointStore = {
      async save(checkpoint) {
        saveStarts.push(checkpoint.sequence);
        if (checkpoint.sequence === 2) {
          secondSaveStarted();
          await secondRelease;
        }
        const previous = entries.get(checkpoint.runId);
        if (previous && previous.sequence >= checkpoint.sequence) throw new Error('CHECKPOINT_SEQUENCE_NOT_MONOTONIC');
        entries.set(checkpoint.runId, structuredClone(checkpoint));
      },
      async load(runId) {
        const checkpoint = entries.get(runId);
        return checkpoint ? structuredClone(checkpoint) : undefined;
      },
    };
    const { runtime } = runtimeFixture({ actions: [finishAction()], hashes: [SHA.a, SHA.a], checkpointStore: store });
    const startPromise = runtime.start({ publicGoal: '结束', planSummary: '结束运行。', budgetCapUsd: 5 });
    await secondStarted;
    const firstCheckpoint = [...entries.values()][0];
    const pausePromise = runtime.pause(firstCheckpoint.run);
    await Promise.resolve();
    expect(saveStarts).toEqual([1, 2]);
    releaseSecondSave();
    const [startedRun, pausedRun] = await Promise.all([startPromise, pausePromise]);
    expect(startedRun.paused).toBe(true);
    expect(pausedRun.paused).toBe(true);
    expect(saveStarts).toEqual([1, 2, 3]);
    expect([...entries.values()][0].sequence).toBe(3);
  });

  it('actively aborts an observer that is still running when the run deadline expires', async () => {
    let observerAborted = false;
    const planner = { nextAction: vi.fn(async () => finishAction()) };
    const runtime = createCreativeDirectorRuntime({
      observer: {
        observe(signal) {
          return new Promise<CanvasContextGraphSnapshot>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              observerAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
        },
      },
      planner,
      executor: successfulExecutor(),
      checkpointStore: createMemoryCheckpointStore(),
      idFactory: deterministicIds(),
    });
    const run = await runtime.start({ publicGoal: '观察', planSummary: '观察画布。', budgetCapUsd: 5, deadlineMs: 20 });
    expect(run).toMatchObject({ state: 'FAILED', stopReason: 'DEADLINE_EXCEEDED' });
    expect(observerAborted).toBe(true);
    expect(planner.nextAction).not.toHaveBeenCalled();
  });

  it('actively aborts a planner that is still running when the run deadline expires', async () => {
    let plannerAborted = false;
    const runtime = createCreativeDirectorRuntime({
      observer: sequenceObserver([SHA.a]),
      planner: {
        nextAction(_input, signal) {
          return new Promise<unknown>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              plannerAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
        },
      },
      executor: successfulExecutor(),
      checkpointStore: createMemoryCheckpointStore(),
      idFactory: deterministicIds(),
    });
    const run = await runtime.start({ publicGoal: '规划', planSummary: '规划动作。', budgetCapUsd: 5, deadlineMs: 20 });
    expect(run).toMatchObject({ state: 'FAILED', stopReason: 'DEADLINE_EXCEEDED' });
    expect(plannerAborted).toBe(true);
  });

  it('actively aborts an executor that is still running when the run deadline expires', async () => {
    let executorAborted = false;
    const runtime = createCreativeDirectorRuntime({
      observer: sequenceObserver([SHA.a]),
      planner: sequencePlanner([selectAction()]),
      executor: {
        executeOnce({ signal }) {
          return new Promise<ActionExecutionReceipt>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              executorAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
        },
      },
      checkpointStore: createMemoryCheckpointStore(),
      idFactory: deterministicIds(),
    });
    const run = await runtime.start({ publicGoal: '执行', planSummary: '执行画布动作。', budgetCapUsd: 5, deadlineMs: 20 });
    expect(run).toMatchObject({ state: 'FAILED', stopReason: 'DEADLINE_EXCEEDED' });
    expect(executorAborted).toBe(true);
    expect(run.steps[0].toolResults).toHaveLength(0);
  });

  it('fails closed when a new process loads an EXECUTING checkpoint without a durable receipt', async () => {
    const memory = createMemoryCheckpointStore();
    let interruptExecutingSave = true;
    const crashStore: AgentCheckpointStore = {
      async save(checkpoint) {
        await memory.save(checkpoint);
        if (interruptExecutingSave && checkpoint.run.state === 'EXECUTING') {
          interruptExecutingSave = false;
          throw new Error('SIMULATED_PROCESS_CRASH');
        }
      },
      load: (runId) => memory.load(runId),
    };
    const executor = successfulExecutor();
    const first = runtimeFixture({ actions: [paidAction()], hashes: [SHA.a], executor, checkpointStore: crashStore });
    const awaiting = await first.runtime.start({ publicGoal: '生成图片', planSummary: '用户确认后执行。', budgetCapUsd: 5 });
    await expect(first.runtime.confirmPaidAction(awaiting, true)).rejects.toThrow('SIMULATED_PROCESS_CRASH');
    expect(executor.calls).toHaveLength(0);

    const second = runtimeFixture({ actions: [], hashes: [SHA.a], executor, checkpointStore: crashStore });
    const resumed = await second.runtime.resume(awaiting.id);
    expect(resumed).toMatchObject({
      state: 'FAILED',
      stopReason: 'ACTION_FAILED',
      failureCode: 'RESUME_EXECUTING_CHECKPOINT_UNSAFE',
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('resumes a durable VERIFYING checkpoint without repeating executeOnce', async () => {
    const memory = createMemoryCheckpointStore();
    let failAfterSave = true;
    const crashStore: AgentCheckpointStore = {
      async save(checkpoint) {
        await memory.save(checkpoint);
        if (failAfterSave && checkpoint.run.state === 'VERIFYING') {
          failAfterSave = false;
          throw new Error('SIMULATED_PROCESS_CRASH');
        }
      },
      load: (runId) => memory.load(runId),
    };
    const executor = successfulExecutor();
    const first = runtimeFixture({ actions: [finishAction()], hashes: [SHA.a], executor, checkpointStore: crashStore });
    await expect(first.runtime.start({ publicGoal: '结束运行', planSummary: '确认完成。', budgetCapUsd: 5 })).rejects.toThrow('SIMULATED_PROCESS_CRASH');
    expect(executor.calls).toHaveLength(1);

    const runId = [...memory.entries.keys()][0];
    const second = runtimeFixture({ actions: [], hashes: [SHA.a], executor, checkpointStore: crashStore });
    const resumed = await second.runtime.resume(runId);
    expect(resumed?.state).toBe('COMPLETED');
    expect(executor.calls).toHaveLength(1);
  });

  it('rejects a tampered checkpoint before resume', async () => {
    const { runtime, checkpointStore } = runtimeFixture({ actions: [finishAction()], hashes: [SHA.a, SHA.a] });
    const run = await runtime.start({ publicGoal: '结束', planSummary: '结束。', budgetCapUsd: 5 });
    const checkpoint = await checkpointStore.load(run.id) as AgentCheckpoint;
    checkpoint.run.planSummary = '被篡改';
    await expect(validateCheckpoint(checkpoint)).rejects.toThrow('CHECKPOINT_SHA256_MISMATCH');
  });

  it('fails closed on executor receipts with extra fields or illegal non-paid cost', async () => {
    const invalidReceipt: AgentActionExecutorPort = {
      async executeOnce() {
        return { ok: true, changed: true, summary: '伪造', privateReasoning: 'secret' } as unknown as ActionExecutionReceipt;
      },
    };
    const invalid = runtimeFixture({ actions: [selectAction()], hashes: [SHA.a], executor: invalidReceipt });
    const invalidRun = await invalid.runtime.start({ publicGoal: '选择', planSummary: '选择。', budgetCapUsd: 5 });
    expect(invalidRun).toMatchObject({ state: 'FAILED', failureCode: 'EXECUTOR_RECEIPT_INVALID' });

    const illegalCost: AgentActionExecutorPort = {
      async executeOnce() { return { ok: true, changed: true, summary: '选择完成。', costUsd: 0.01 }; },
    };
    const cost = runtimeFixture({ actions: [selectAction()], hashes: [SHA.a], executor: illegalCost });
    const costRun = await cost.runtime.start({ publicGoal: '选择', planSummary: '选择。', budgetCapUsd: 5 });
    expect(costRun).toMatchObject({ state: 'FAILED', failureCode: 'ACTION_COST_POLICY_VIOLATION' });
  });
});
