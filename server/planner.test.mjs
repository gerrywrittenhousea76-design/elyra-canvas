import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { CORE007_CONSENT_VERSION, PLANNER_MODEL, PlannerError, PlannerInputError, createEvoLinkPlannerClient } from './planner.mjs';
import { PlannerBudgetExceededError, PlannerBudgetLedgerError, createPlannerBudgetLedger } from './planner-budget.mjs';

const validToolResponse = (operation = 'image_generate', options = {}) => new Response(JSON.stringify({
  id: options.requestId ?? 'msg_demo_planner_001',
  type: 'message',
  role: 'assistant',
  model: PLANNER_MODEL,
  stop_reason: options.stopReason ?? 'tool_use',
  usage: Object.hasOwn(options, 'usage') ? options.usage : { input_tokens: 120, output_tokens: 80 },
  content: options.content ?? [{
    type: 'tool_use',
    id: 'tool_demo_001',
    name: 'submit_elyra_plan',
    input: {
      intent: { normalized_prompt: '生成一个克制的音箱棚拍主视觉', goal: '建立高级产品主视觉', constraints: ['保留产品轮廓', '非敏感演示数据'] },
      plan: {
        operation,
        summary: '以产品主体、材质和克制光影建立可确认的生成计划。',
        steps: ['明确产品主体与比例', '建立棚拍光线和构图'],
        visual_direction: { subject: '黑色便携音箱', style: '高级商业摄影', lighting: '柔和轮廓光', composition: '居中留白构图' },
      },
    },
  }],
}), { status: options.status ?? 200, headers: { 'Content-Type': 'application/json' } });

const request = (overrides = {}) => ({ prompt: '生成一个克制的音箱棚拍主视觉', imageProviderId: 'deterministic-mock', ...overrides });
const temporaryLedgers = [];
const temporaryLedger = () => {
  const directory = mkdtempSync(join(tmpdir(), 'elyra-planner-budget-test-'));
  temporaryLedgers.push(directory);
  return directory;
};
after(() => {
  for (const directory of temporaryLedgers) rmSync(directory, { recursive: true, force: true });
});
const clientFor = (fetchImpl, options = {}) => createEvoLinkPlannerClient({
  fetchImpl,
  readKey: async () => 'planner-test-token',
  sleepImpl: async () => {},
  budgetLedgerDirectory: options.budgetLedgerDirectory ?? temporaryLedger(),
  historicalSpentUsd: options.historicalSpentUsd ?? 0,
  ...options,
});

test('creates one schema-valid remote Agent plan with fixed endpoint, model and redacted evidence', async () => {
  const calls = [];
  const client = clientFor(async (url, options) => {
    calls.push({ url, options });
    return validToolResponse();
  });
  const result = await client.createPlan(request());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://direct.evolink.ai/v1/messages');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'claude-haiku-4-5-20251001');
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.tool_choice.name, 'submit_elyra_plan');
  assert.match(body.messages[0].content, /required_operation/);
  assert.equal(result.intent.source, 'remote-agent');
  assert.equal(result.plan.operation, 'image_generate');
  assert.equal(Object.hasOwn(result.intent, 'creationMode'), false);
  assert.equal(Object.hasOwn(result.plan, 'creationMode'), false);
  assert.equal(Object.hasOwn(result.plan, 'outputKind'), false);
  assert.equal(result.evidence.schemaResult, 'valid');
  assert.equal(result.evidence.httpStatus, 200);
  assert.equal(JSON.stringify(result).includes('planner-test-token'), false);
  assert.equal(JSON.stringify(result).includes(request().prompt), true, 'domain result should retain the owner-approved non-sensitive prompt');
});

test('forces fixed-reference edit operation from the selected Canvas Object context', async () => {
  const client = clientFor(async () => validToolResponse('image_edit_fixed_demo_reference'));
  const result = await client.createPlan(request({ targetCanvasObjectId: 'canvas-parent-1', imageProviderId: 'evolink-gpt-image-2' }));
  assert.equal(result.intent.targetCanvasObjectId, 'canvas-parent-1');
  assert.equal(result.plan.operation, 'image_edit_fixed_demo_reference');
  assert.equal(result.plan.providerId, 'evolink-gpt-image-2');
});

test('binds a selected uploaded Asset to image_edit_user_reference', async () => {
  const calls = [];
  const client = clientFor(async (_url, options) => { calls.push(JSON.parse(options.body)); return validToolResponse('image_edit_user_reference'); });
  const result = await client.createPlan(request({ targetCanvasObjectId: 'canvas-upload-1', referenceKind: 'user-upload', consentVersion: CORE007_CONSENT_VERSION, imageProviderId: 'evolink-gpt-image-2' }));
  assert.equal(result.intent.operation, 'image_edit_user_reference');
  assert.equal(result.intent.targetCanvasObjectId, 'canvas-upload-1');
  assert.equal(result.plan.operation, 'image_edit_user_reference');
  assert.match(calls[0].messages[0].content, /"reference_kind":"user-upload"/);
  assert.match(calls[0].messages[0].content, /"required_operation":"image_edit_user_reference"/);
});

test('retries network, 429 and 5xx failures once and no more', async (t) => {
  for (const scenario of ['network', '429', '500']) {
    await t.test(scenario, async () => {
      let calls = 0;
      const client = clientFor(async () => {
        calls += 1;
        if (calls === 1) {
          if (scenario === 'network') throw new Error('offline');
          return new Response(JSON.stringify({ error: { message: 'private upstream detail' } }), { status: Number(scenario) });
        }
        return validToolResponse();
      });
      const result = await client.createPlan(request());
      assert.equal(calls, 2);
      assert.equal(result.evidence.retryCount, 1);
      assert.equal(JSON.stringify(result).includes('private upstream detail'), false);
    });
  }
});

test('CORE-008 send-authorization mode never auto-retries a paid Planner request', async (t) => {
  for (const scenario of ['network', '429', '500']) {
    await t.test(scenario, async () => {
      let calls = 0;
      const client = clientFor(async () => {
        calls += 1;
        if (scenario === 'network') throw new Error('offline');
        return new Response(JSON.stringify({ error: { message: 'private upstream detail' } }), { status: Number(scenario) });
      }, { maxAttempts: 1 });
      await assert.rejects(
        () => client.createPlan(request()),
        (error) => error instanceof PlannerError && error.retryable === true && error.evidence.retryCount === 0,
      );
      assert.equal(calls, 1, 'one human confirmation must authorize exactly one paid Planner request');
      assert.equal(client.getBudgetStatus().usedUsd, 0.05, 'ambiguous paid attempt must remain conservatively charged');
    });
  }
});

test('does not retry 400, 401, 402 or 403', async (t) => {
  for (const status of [400, 401, 402, 403]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const client = clientFor(async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'must stay redacted' } }), { status });
      });
      await assert.rejects(() => client.createPlan(request()), (error) => error instanceof PlannerError && error.status === status && error.retryable === false);
      assert.equal(calls, 1);
    });
  }
});

test('rejects refusal, malformed schema and operation mismatch without retry', async (t) => {
  const scenarios = [
    { name: 'refusal', response: () => validToolResponse('image_generate', { stopReason: 'refusal', content: [{ type: 'text', text: 'not returned to client' }] }), code: 'PLANNER_REFUSAL' },
    { name: 'malformed', response: () => validToolResponse('image_generate', { content: [{ type: 'text', text: '{}' }] }), code: 'PLANNER_SCHEMA_INVALID' },
    { name: 'operation mismatch', response: () => validToolResponse('image_edit_fixed_demo_reference'), code: 'PLANNER_SCHEMA_INVALID' },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const client = clientFor(async () => { calls += 1; return scenario.response(); });
      await assert.rejects(() => client.createPlan(request()), (error) => error instanceof PlannerError && error.code === scenario.code && error.retryable === false);
      assert.equal(calls, 1);
    });
  }
});

test('records only a redacted schema stage and allowlisted stop reason for truncated output', async () => {
  const client = clientFor(async () => validToolResponse('image_generate', { stopReason: 'max_tokens', content: [{ type: 'text', text: 'private incomplete provider content' }] }));
  await assert.rejects(() => client.createPlan(request()), (error) => {
    assert.ok(error instanceof PlannerError);
    assert.equal(error.code, 'PLANNER_SCHEMA_INVALID');
    assert.equal(error.evidence.schemaFailureStage, 'tool_selection');
    assert.equal(error.evidence.providerStopReason, 'max_tokens');
    assert.equal(JSON.stringify(error.evidence).includes('private incomplete provider content'), false);
    return true;
  });
});

test('rejects invalid input before reading a key or running provider code', async () => {
  let keyReads = 0;
  let fetchCalls = 0;
  const client = createEvoLinkPlannerClient({ readKey: async () => { keyReads += 1; return 'unused'; }, fetchImpl: async () => { fetchCalls += 1; return validToolResponse(); } });
  await assert.rejects(() => client.createPlan(request({ imageProviderId: 'future-provider' })), PlannerInputError);
  assert.equal(keyReads, 0);
  assert.equal(fetchCalls, 0);
});

test('rejects missing or incorrect CORE-007 consent before reading a key, reserving budget or running Provider code', async (t) => {
  for (const consentVersion of [undefined, 'CORE-007-DATA-BOUNDARY-OLD']) {
    await t.test(String(consentVersion), async () => {
      let keyReads = 0;
      let fetchCalls = 0;
      const budgetLedgerDirectory = temporaryLedger();
      const client = createEvoLinkPlannerClient({
        readKey: async () => { keyReads += 1; return 'unused'; },
        fetchImpl: async () => { fetchCalls += 1; return validToolResponse('image_edit_user_reference'); },
        budgetLedgerDirectory,
        historicalSpentUsd: 0,
      });
      await assert.rejects(
        () => client.createPlan(request({ targetCanvasObjectId: 'canvas-upload-1', referenceKind: 'user-upload', consentVersion, imageProviderId: 'evolink-gpt-image-2' })),
        (error) => error instanceof PlannerInputError && error.code === 'CORE007_CONSENT_REQUIRED',
      );
      assert.equal(keyReads, 0);
      assert.equal(fetchCalls, 0);
      assert.equal(client.getBudgetStatus().usedUsd, 0);
    });
  }
});

test('fails closed when the persisted budget reservation is exhausted', async () => {
  let calls = 0;
  const client = clientFor(async () => { calls += 1; return validToolResponse('image_generate', { usage: null }); }, { budgetCapUsd: 0.05, attemptReservationUsd: 0.05 });
  await client.createPlan(request());
  await assert.rejects(() => client.createPlan(request()), (error) => error instanceof PlannerError && error.code === 'PLANNER_BUDGET_EXCEEDED');
  assert.equal(calls, 1);
});

test('persists conservative no-usage billing across client instances and service restarts', async () => {
  const budgetLedgerDirectory = temporaryLedger();
  let calls = 0;
  const options = { budgetLedgerDirectory, budgetCapUsd: 0.05, attemptReservationUsd: 0.05 };
  const firstInstance = clientFor(async () => { calls += 1; return validToolResponse('image_generate', { usage: null }); }, options);
  const firstResult = await firstInstance.createPlan(request());
  assert.equal(firstResult.evidence.estimatedRequestCostUsd, 0.05);
  assert.equal(firstResult.evidence.budgetUsedUsd, 0.05);

  const restartedInstance = clientFor(async () => { calls += 1; return validToolResponse(); }, options);
  await assert.rejects(() => restartedInstance.createPlan(request()), (error) => error instanceof PlannerError && error.code === 'PLANNER_BUDGET_EXCEEDED');
  assert.equal(calls, 1, 'restarted client must reject before Provider execution');

  const ledgerPath = join(budgetLedgerDirectory, 'ledger.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.deepEqual(Object.keys(ledger).sort(), ['reservations', 'spentUsd', 'updatedAt']);
  assert.equal(ledger.spentUsd, 0.05);
  assert.equal(ledger.reservations.length, 1);
  assert.deepEqual(Object.keys(ledger.reservations[0]).sort(), ['capUsd', 'id', 'reservedAt', 'reservedUsd', 'settledAt', 'settledUsd']);
  assert.equal(JSON.stringify(ledger).includes(request().prompt), false);
  assert.equal(JSON.stringify(ledger).includes('planner-test-token'), false);
  assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);
});

test('seeds a fresh persistent ledger with the already verified live-call spend', async () => {
  const budgetLedgerDirectory = temporaryLedger();
  const client = clientFor(async () => validToolResponse(), { budgetLedgerDirectory, historicalSpentUsd: 0.0040734 });
  assert.equal(client.getBudgetStatus().usedUsd, 0.0040734);
  const result = await client.createPlan(request());
  const ledger = JSON.parse(readFileSync(join(budgetLedgerDirectory, 'ledger.json'), 'utf8'));
  assert.equal(ledger.spentUsd, 0.0045414);
  assert.equal(result.evidence.budgetUsedUsd, 0.0045414);
  assert.equal(ledger.reservations.length, 1);
  assert.ok(ledger.reservations[0].settledAt);
});

test('serializes concurrent reservations so two clients cannot overspend one remaining slot', async () => {
  const budgetLedgerDirectory = temporaryLedger();
  let fetchCalls = 0;
  let releaseProvider;
  const providerGate = new Promise((resolvePromise) => { releaseProvider = resolvePromise; });
  const options = { budgetLedgerDirectory, budgetCapUsd: 0.05, attemptReservationUsd: 0.05 };
  const firstClient = clientFor(async () => { fetchCalls += 1; await providerGate; return validToolResponse(); }, options);
  const secondClient = clientFor(async () => { fetchCalls += 1; return validToolResponse(); }, options);

  const firstCall = firstClient.createPlan(request());
  await waitUntil(() => firstClient.getBudgetStatus().usedUsd === 0.05);
  await assert.rejects(() => secondClient.createPlan(request()), (error) => error instanceof PlannerError && error.code === 'PLANNER_BUDGET_EXCEEDED');
  releaseProvider();
  await firstCall;
  assert.equal(fetchCalls, 1);
});

test('settles a reservation from usage and keeps only amount, reservation ID and timestamps in the ledger', async () => {
  const budgetLedgerDirectory = temporaryLedger();
  const client = clientFor(async () => validToolResponse('image_generate', { usage: { input_tokens: 1000, output_tokens: 1000 } }), { budgetLedgerDirectory });
  const result = await client.createPlan(request());
  assert.equal(result.evidence.estimatedRequestCostUsd, 0.0054);
  assert.equal(result.evidence.budgetUsedUsd, 0.0054);
  const ledgerText = readFileSync(join(budgetLedgerDirectory, 'ledger.json'), 'utf8');
  for (const forbidden of ['prompt', 'key', 'response', 'authorization', 'token']) assert.equal(ledgerText.toLowerCase().includes(forbidden), false);
});

test('fails closed on impossible Provider usage and charges only the approved Planner slot', async () => {
  let calls = 0;
  const client = clientFor(async () => {
    calls += 1;
    return validToolResponse('image_generate', { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
  }, { maxAttempts: 1 });
  await assert.rejects(
    () => client.createPlan(request()),
    (error) => error instanceof PlannerError
      && error.code === 'PLANNER_USAGE_INVALID'
      && error.retryable === false
      && error.evidence.estimatedRequestCostUsd === 0.05,
  );
  assert.equal(calls, 1);
  assert.equal(client.getBudgetStatus().usedUsd, 0.05);
});

test('charges the conservative reservation for a network failure before retrying', async () => {
  const budgetLedgerDirectory = temporaryLedger();
  let calls = 0;
  const client = clientFor(async () => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
    return validToolResponse('image_generate', { usage: { input_tokens: 0, output_tokens: 0 } });
  }, { budgetLedgerDirectory });
  const result = await client.createPlan(request());
  assert.equal(result.evidence.retryCount, 1);
  assert.equal(result.evidence.estimatedRequestCostUsd, 0.05);
  assert.equal(result.evidence.budgetUsedUsd, 0.05);
});

test('returns PLANNER_NOT_CONFIGURED without exposing the missing environment variable value', async () => {
  let fetchCalls = 0;
  const client = createEvoLinkPlannerClient({
    readKey: async () => { throw new Error('secret backend path'); },
    fetchImpl: async () => { fetchCalls += 1; return validToolResponse(); },
    budgetLedgerDirectory: temporaryLedger(),
    historicalSpentUsd: 0,
  });
  await assert.rejects(() => client.createPlan(request()), (error) => error instanceof PlannerError && error.code === 'PLANNER_NOT_CONFIGURED' && !error.message.includes('secret backend path'));
  assert.equal(fetchCalls, 0);
  assert.equal(client.getBudgetStatus().usedUsd, 0);
});

test('settlement is atomic and saturates at the approved cap instead of recording overspend', async () => {
  const directory = temporaryLedger();
  const ledger = createPlannerBudgetLedger({ directory, reservationId: () => 'reservation-overrun' });
  const reservation = await ledger.reserve({ capUsd: 5, amountUsd: 1 });
  await assert.rejects(
    () => ledger.settle({ id: reservation.id, actualUsd: 8, capUsd: 5 }),
    (error) => error instanceof PlannerBudgetExceededError && error.usedUsd === 5,
  );
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 5);
  const persisted = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8'));
  assert.equal(persisted.spentUsd, 5);
  assert.equal(persisted.reservations[0].capUsd, 5);
  assert.equal(persisted.reservations[0].settledUsd, 5);
  assert.ok(persisted.reservations[0].settledAt);
  assert.ok(persisted.spentUsd <= 5);
  await assert.rejects(() => ledger.reserve({ capUsd: 5, amountUsd: 0.01 }), PlannerBudgetExceededError);
});

test('settlement rejects a mismatched cap without mutating the pending reservation', async () => {
  const directory = temporaryLedger();
  const ledger = createPlannerBudgetLedger({ directory, reservationId: () => 'reservation-cap-binding' });
  const reservation = await ledger.reserve({ capUsd: 5, amountUsd: 1 });
  await assert.rejects(
    () => ledger.settle({ id: reservation.id, actualUsd: 0.5, capUsd: 4 }),
    (error) => error instanceof PlannerBudgetLedgerError,
  );
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 1);
  const persisted = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8'));
  assert.equal(persisted.spentUsd, 0);
  assert.equal(persisted.reservations[0].settledAt, null);
});

test('actual cost may exceed its estimate only when the atomic settlement remains inside the cap', async () => {
  const directory = temporaryLedger();
  const ledger = createPlannerBudgetLedger({ directory, reservationId: () => 'reservation-estimate-overrun' });
  const reservation = await ledger.reserve({ capUsd: 5, amountUsd: 1 });
  const settled = await ledger.settle({ id: reservation.id, actualUsd: 2, capUsd: 5 });
  assert.deepEqual(settled, { billedUsd: 2, usedUsd: 2 });
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 1 }).usedUsd, 2);
  const persisted = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8'));
  assert.equal(persisted.spentUsd, 2);
  assert.ok(persisted.spentUsd <= 5);
});

test('legacy budget records remain readable while new reservations bind their cap', async () => {
  const directory = temporaryLedger();
  const legacy = {
    spentUsd: 0.25,
    reservations: [{ id: 'legacy-reservation', reservedUsd: 0.05, reservedAt: '2026-08-05T00:00:00.000Z', settledUsd: 0.05, settledAt: '2026-08-05T00:00:01.000Z' }],
    updatedAt: '2026-08-05T00:00:01.000Z',
  };
  writeFileSync(join(directory, 'ledger.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const ledger = createPlannerBudgetLedger({ directory, reservationId: () => 'new-capped-reservation' });
  assert.equal(ledger.getStatusSync({ capUsd: 5, reservationPerAttemptUsd: 0.05 }).usedUsd, 0.25);
  await ledger.reserve({ capUsd: 5, amountUsd: 0.05 });
  const persisted = JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8'));
  assert.equal(Object.hasOwn(persisted.reservations[0], 'capUsd'), false);
  assert.equal(persisted.reservations[1].capUsd, 5);
});

const waitUntil = async (predicate) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('Timed out waiting for planner budget reservation.');
};
