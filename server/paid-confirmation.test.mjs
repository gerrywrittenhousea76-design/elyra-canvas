import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaidConfirmationStore, createPaidRequestDigest, createUserReferenceRequestBinding, createVideoRequestBinding } from './paid-confirmation.mjs';

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const TOKEN_C = 'C'.repeat(43);
const AUTH_A = 'send-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AUTH_B = 'send-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PLANNER_REQUEST = {
  kind: 'planner',
  route: '/api/agent/plans',
  body: { prompt: '非敏感演示', imageProviderId: 'evolink-gpt-image-2' },
};
const PLANNER_RESULT = {
  intent: {
    id: 'intent-paid-1', kind: 'generate', operation: 'image_generate', source: 'remote-agent', prompt: '非敏感演示', normalizedPrompt: '非敏感演示', goal: '生成非敏感演示图', constraints: ['仅生成一张'], createdAt: '2026-08-07T00:00:00.000Z',
  },
  plan: {
    id: 'plan-paid-1', intentId: 'intent-paid-1', providerId: 'evolink-gpt-image-2', status: 'proposed', operation: 'image_generate', source: 'remote-agent', plannerModel: 'test', summary: '生成一张非敏感演示图', bullets: ['创建图片 Job'], constraints: ['仅生成一张'], visualDirection: { subject: '演示主体', style: '克制', lighting: '柔和', composition: '居中' }, shouldFail: false, createdAt: '2026-08-07T00:00:00.000Z',
  },
};
const executionPromptFor = ({ intent, plan }) => [
  intent.normalizedPrompt.trim(),
  `规划摘要：${plan.summary.trim()}`,
  `视觉方向：主体=${plan.visualDirection.subject.trim()}；风格=${plan.visualDirection.style.trim()}；光线=${plan.visualDirection.lighting.trim()}；构图=${plan.visualDirection.composition.trim()}`,
  `约束：${plan.constraints.map((item) => item.trim()).filter(Boolean).join('；')}`,
  `执行步骤：${plan.bullets.map((item) => item.trim()).filter(Boolean).join('；')}`,
].join('\n');
const IMAGE_REQUEST = {
  kind: 'image',
  route: '/api/agent/image-jobs',
  body: { prompt: executionPromptFor(PLANNER_RESULT), clientJobId: 'job-paid-1', size: '1:1' },
};
const PLANNER_DIGEST = createPaidRequestDigest(PLANNER_REQUEST);
const IMAGE_DIGEST = createPaidRequestDigest(IMAGE_REQUEST);
const IMAGE_CHAIN = { intentId: 'intent-paid-1', planId: 'plan-paid-1', operation: 'image_generate', providerId: 'evolink-gpt-image-2', targetBinding: null };

const issue = (store, authorizationId, request, chain) => store.issue({
  authorizationId,
  kind: request.kind,
  requestDigest: createPaidRequestDigest(request),
  request: { route: request.route, body: request.body },
  ...(chain ? { chain } : {}),
});

const bindPlanner = (store, authorizationId, token = TOKEN_A, request = PLANNER_REQUEST, result = PLANNER_RESULT) => {
  const receipt = issue(store, authorizationId, request);
  store.consume({ token, kind: 'planner', requestDigest: receipt.requestDigest });
  store.bindPlannerResult({ authorizationId, plannerRequestDigest: receipt.requestDigest, plannerInput: request.body, result });
  return receipt;
};

test('issues a short-lived Planner ticket and consumes it exactly once', () => {
  let time = Date.parse('2026-08-06T00:00:00.000Z');
  const store = createPaidConfirmationStore({ now: () => time, createToken: () => TOKEN_A, ttlMs: 30_000 });
  const issued = issue(store, AUTH_A, PLANNER_REQUEST);
  assert.deepEqual(issued, { token: TOKEN_A, authorizationId: AUTH_A, kind: 'planner', requestDigest: PLANNER_DIGEST, expiresAt: '2026-08-06T00:00:30.000Z' });
  time += 1;
  assert.deepEqual(store.consume({ token: TOKEN_A, kind: 'planner', requestDigest: PLANNER_DIGEST }), { authorizationId: AUTH_A, kind: 'planner', requestDigest: PLANNER_DIGEST, consumedAt: '2026-08-06T00:00:00.001Z' });
  assert.throws(() => store.consume({ token: TOKEN_A, kind: 'planner', requestDigest: PLANNER_DIGEST }), (error) => error.code === 'PAID_CONFIRMATION_REPLAYED');
});

test('missing, wrong-class and expired tickets fail closed', () => {
  let time = Date.parse('2026-08-06T00:00:00.000Z');
  const tokens = [TOKEN_A, TOKEN_B];
  const store = createPaidConfirmationStore({ now: () => time, createToken: () => tokens.shift(), ttlMs: 30_000 });
  assert.throws(() => store.consume({ kind: 'planner', requestDigest: PLANNER_DIGEST }), (error) => error.code === 'PAID_CONFIRMATION_REQUIRED');
  issue(store, AUTH_A, PLANNER_REQUEST);
  assert.throws(() => store.consume({ token: TOKEN_A, kind: 'image', requestDigest: IMAGE_DIGEST }), (error) => error.code === 'PAID_CONFIRMATION_KIND_MISMATCH');
  issue(store, AUTH_B, PLANNER_REQUEST);
  time += 30_000;
  assert.throws(() => store.consume({ token: TOKEN_B, kind: 'planner', requestDigest: PLANNER_DIGEST }), (error) => error.code === 'PAID_CONFIRMATION_EXPIRED');
});

test('rejects unsupported classes and malformed inputs without exposing tokens', () => {
  const store = createPaidConfirmationStore({ createToken: () => TOKEN_A });
  assert.throws(() => store.issue({ authorizationId: AUTH_A, kind: 'audio', requestDigest: PLANNER_DIGEST, request: PLANNER_REQUEST }), (error) => error.code === 'PAID_CONFIRMATION_KIND_INVALID');
  assert.throws(() => store.issue({ authorizationId: AUTH_A, kind: 'planner', requestDigest: 'wrong', request: PLANNER_REQUEST }), (error) => error.code === 'PAID_CONFIRMATION_DIGEST_INVALID');
  assert.throws(() => store.issue({ authorizationId: 'send-invalid', kind: 'planner', requestDigest: PLANNER_DIGEST, request: PLANNER_REQUEST }), (error) => error.code === 'SEND_AUTHORIZATION_ID_INVALID');
  assert.equal(Object.keys(store).sort().join(','), 'bindPlannerResult,consume,issue');
  assert.equal(JSON.stringify(store).includes(TOKEN_A), false);
});

test('canonical request digests bind route, kind and fields independent of key order', () => {
  assert.equal(createPaidRequestDigest({ kind: 'image', route: '/api/agent/image-jobs', body: { size: '1:1', clientJobId: 'job-paid-1', prompt: IMAGE_REQUEST.body.prompt } }), IMAGE_DIGEST);
  assert.notEqual(createPaidRequestDigest({ ...IMAGE_REQUEST, route: '/api/agent/image-edit-jobs' }), IMAGE_DIGEST);
  assert.notEqual(createPaidRequestDigest({ ...IMAGE_REQUEST, body: { ...IMAGE_REQUEST.body, clientJobId: 'job-paid-2' } }), IMAGE_DIGEST);
  assert.throws(() => createPaidRequestDigest({ ...IMAGE_REQUEST, body: { ...IMAGE_REQUEST.body, arbitrary: true } }), (error) => error.code === 'PAID_CONFIRMATION_BINDING_INVALID');
});

test('multipart digest binds prompt, action id, file bytes, type, size and consent', () => {
  const first = createUserReferenceRequestBinding({ prompt: '编辑参考图', clientJobId: 'job-reference-1', consentVersion: 'CORE-007-DATA-BOUNDARY-V1', buffer: Buffer.from([1, 2, 3]) });
  const changed = createUserReferenceRequestBinding({ prompt: '编辑参考图', clientJobId: 'job-reference-1', consentVersion: 'CORE-007-DATA-BOUNDARY-V1', buffer: Buffer.from([1, 2, 4]) });
  const digest = createPaidRequestDigest({ kind: 'image', route: '/api/agent/user-reference-image-jobs', body: first });
  assert.notEqual(createPaidRequestDigest({ kind: 'image', route: '/api/agent/user-reference-image-jobs', body: changed }), digest);
  assert.equal(createPaidRequestDigest({ kind: 'image', route: '/api/agent/user-reference-image-jobs', body: { ...first, prompt: '编辑参考图\r\n' } }), digest);
});

test('one Send requires a consumed and bound Planner before one Image ticket', () => {
  const tokens = [TOKEN_A, TOKEN_B];
  const store = createPaidConfirmationStore({ createToken: () => tokens.shift() });
  assert.throws(() => issue(store, AUTH_A, IMAGE_REQUEST, IMAGE_CHAIN), (error) => error.code === 'SEND_AUTHORIZATION_PLAN_NOT_BOUND');
  bindPlanner(store, AUTH_A);
  const image = issue(store, AUTH_A, IMAGE_REQUEST, IMAGE_CHAIN);
  assert.equal(image.token, TOKEN_B);
  assert.throws(() => issue(store, AUTH_A, { ...IMAGE_REQUEST, body: { ...IMAGE_REQUEST.body, clientJobId: 'job-paid-2' } }, IMAGE_CHAIN), (error) => error.code === 'SEND_AUTHORIZATION_KIND_ALREADY_USED');
});

test('Image ticket rejects a different Plan, route, target or prompt', () => {
  const cases = [
    { request: IMAGE_REQUEST, chain: { ...IMAGE_CHAIN, planId: 'plan-other' } },
    { request: { ...IMAGE_REQUEST, route: '/api/agent/image-edit-jobs' }, chain: IMAGE_CHAIN },
    { request: { ...IMAGE_REQUEST, body: { ...IMAGE_REQUEST.body, prompt: PLANNER_REQUEST.body.prompt } }, chain: IMAGE_CHAIN },
    { request: { ...IMAGE_REQUEST, body: { ...IMAGE_REQUEST.body, prompt: '被替换的提示词' } }, chain: IMAGE_CHAIN },
  ];
  for (const [index, candidate] of cases.entries()) {
    const tokens = [TOKEN_A, String.fromCharCode(66 + index).repeat(43)];
    const store = createPaidConfirmationStore({ createToken: () => tokens.shift() });
    bindPlanner(store, `send-${(index + 10).toString(16).padStart(32, '0')}`);
    assert.throws(
      () => issue(store, `send-${(index + 10).toString(16).padStart(32, '0')}`, candidate.request, candidate.chain),
      (error) => error.code === 'SEND_AUTHORIZATION_CHAIN_MISMATCH',
    );
  }
});

test('fixed-reference edit binds the exact object, version and asset selected by the Send', () => {
  const authorizationId = 'send-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const targetBinding = { objectId: 'canvas-reference-1', versionId: 'version-reference-1', assetId: 'asset-reference-1' };
  const plannerRequest = {
    kind: 'planner',
    route: '/api/agent/plans',
    body: {
      prompt: '把参考图改成暖色版本',
      imageProviderId: 'evolink-gpt-image-2',
      targetCanvasObjectId: targetBinding.objectId,
      targetBinding,
      referenceKind: 'fixed-demo',
    },
  };
  const plannerResult = {
    intent: {
      ...PLANNER_RESULT.intent,
      id: 'intent-edit-1',
      kind: 'edit',
      operation: 'image_edit_fixed_demo_reference',
      prompt: plannerRequest.body.prompt,
      normalizedPrompt: plannerRequest.body.prompt,
      targetCanvasObjectId: targetBinding.objectId,
    },
    plan: {
      ...PLANNER_RESULT.plan,
      id: 'plan-edit-1',
      intentId: 'intent-edit-1',
      operation: 'image_edit_fixed_demo_reference',
    },
  };
  const imageRequest = {
    kind: 'image',
    route: '/api/agent/image-edit-jobs',
    body: { prompt: executionPromptFor(plannerResult), clientJobId: 'job-edit-1', size: '1:1' },
  };
  const chain = {
    intentId: 'intent-edit-1',
    planId: 'plan-edit-1',
    operation: 'image_edit_fixed_demo_reference',
    providerId: 'evolink-gpt-image-2',
    targetBinding,
  };
  const store = createPaidConfirmationStore({ createToken: (() => {
    const tokens = [TOKEN_A, TOKEN_B];
    return () => tokens.shift();
  })() });
  bindPlanner(store, authorizationId, TOKEN_A, plannerRequest, plannerResult);
  assert.throws(
    () => issue(store, authorizationId, imageRequest, { ...chain, targetBinding: { ...targetBinding, versionId: 'version-replaced' } }),
    (error) => error.code === 'SEND_AUTHORIZATION_CHAIN_MISMATCH',
  );
});

test('Planner result must match the original operation, provider and target', () => {
  const store = createPaidConfirmationStore({ createToken: () => TOKEN_A });
  const receipt = issue(store, AUTH_A, PLANNER_REQUEST);
  store.consume({ token: TOKEN_A, kind: 'planner', requestDigest: receipt.requestDigest });
  assert.throws(
    () => store.bindPlannerResult({ authorizationId: AUTH_A, plannerRequestDigest: receipt.requestDigest, plannerInput: PLANNER_REQUEST.body, result: { ...PLANNER_RESULT, plan: { ...PLANNER_RESULT.plan, providerId: 'deterministic-mock' } } }),
    (error) => error.code === 'SEND_AUTHORIZATION_PLAN_RESULT_MISMATCH',
  );
});

test('used Send IDs remain exhausted for the process lifetime instead of reopening after five minutes', () => {
  let time = Date.parse('2026-08-06T00:00:00.000Z');
  const tokens = [TOKEN_A, TOKEN_B, TOKEN_C];
  const store = createPaidConfirmationStore({ now: () => time, createToken: () => tokens.shift() });
  bindPlanner(store, AUTH_A);
  time += 10 * 60_000;
  assert.throws(() => issue(store, AUTH_A, PLANNER_REQUEST), (error) => error.code === 'SEND_AUTHORIZATION_KIND_ALREADY_USED');
});

test('CORE-009 video confirmation binds one selected object, source Blob and Planner chain while excluding image XOR', () => {
  const authorizationId = 'send-99999999999999999999999999999999';
  const targetBinding = { objectId: 'canvas-video-source', assetId: 'asset-video-source', versionId: 'version-video-source' };
  const plannerRequest = {
    kind: 'planner', route: '/api/agent/plans', body: {
      prompt: '让当前图片缓慢运动', imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview',
      creationMode: 'video', selectedCanvasObjectCount: 1, targetCanvasObjectId: targetBinding.objectId, targetBinding, referenceKind: 'user-upload', consentVersion: 'CORE-007-DATA-BOUNDARY-V1',
    },
  };
  const plannerResult = {
    intent: { ...PLANNER_RESULT.intent, id: 'intent-video-1', kind: 'modify', operation: 'video_image_to_video', prompt: plannerRequest.body.prompt, normalizedPrompt: plannerRequest.body.prompt, targetCanvasObjectId: targetBinding.objectId },
    plan: { ...PLANNER_RESULT.plan, id: 'plan-video-1', intentId: 'intent-video-1', providerId: 'evolink-sora-2-preview', operation: 'video_image_to_video' },
  };
  const videoBody = createVideoRequestBinding({
    prompt: executionPromptFor(plannerResult), clientJobId: 'job-video-paid-1', sourceObjectId: targetBinding.objectId,
    sourceAssetId: targetBinding.assetId, sourceVersionId: targetBinding.versionId, buffer: Buffer.from([1, 2, 3]),
  });
  const videoRequest = { kind: 'video', route: '/api/agent/video-jobs', body: videoBody };
  const chain = { intentId: 'intent-video-1', planId: 'plan-video-1', operation: 'video_image_to_video', providerId: 'evolink-sora-2-preview', targetBinding };
  const tokens = [TOKEN_A, TOKEN_B];
  const store = createPaidConfirmationStore({ createToken: () => tokens.shift() });
  bindPlanner(store, authorizationId, TOKEN_A, plannerRequest, plannerResult);
  const receipt = issue(store, authorizationId, videoRequest, chain);
  const consumed = store.consume({ token: receipt.token, kind: 'video', requestDigest: receipt.requestDigest });
  assert.equal(consumed.milestone, 'CORE009');
  assert.throws(() => issue(store, authorizationId, IMAGE_REQUEST, IMAGE_CHAIN), (error) => ['SEND_AUTHORIZATION_PLAN_NOT_BOUND', 'SEND_AUTHORIZATION_CHAIN_MISMATCH'].includes(error.code));
  assert.notEqual(createPaidRequestDigest({ ...videoRequest, body: { ...videoBody, sourceAssetId: 'asset-replaced' } }), receipt.requestDigest);
});

test('CORE-009 refuses video authorization for a fixed demo without a restorable local Blob', () => {
  const targetBinding = { objectId: 'canvas-fixed-demo', assetId: 'asset-fixed-demo', versionId: 'version-fixed-demo' };
  const plannerRequest = {
    kind: 'planner', route: '/api/agent/plans', body: {
      prompt: '让演示图动起来', imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview',
      creationMode: 'video', selectedCanvasObjectCount: 1, targetCanvasObjectId: targetBinding.objectId, targetBinding, referenceKind: 'fixed-demo',
    },
  };
  const store = createPaidConfirmationStore({ createToken: () => TOKEN_A });
  assert.throws(
    () => issue(store, 'send-77777777777777777777777777777777', plannerRequest),
    (error) => error.code === 'PAID_CONFIRMATION_BINDING_INVALID',
  );
});

test('CORE-009 ambiguous Agent plan authorizes zero image or video submissions', () => {
  const authorizationId = 'send-88888888888888888888888888888888';
  const plannerRequest = { kind: 'planner', route: '/api/agent/plans', body: { prompt: '帮我处理一下', imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview', creationMode: 'agent', selectedCanvasObjectCount: 0 } };
  const plannerResult = {
    intent: { ...PLANNER_RESULT.intent, id: 'intent-clarify-1', kind: 'clarify', operation: 'clarify', prompt: plannerRequest.body.prompt, normalizedPrompt: plannerRequest.body.prompt },
    plan: { ...PLANNER_RESULT.plan, id: 'plan-clarify-1', intentId: 'intent-clarify-1', providerId: 'none', operation: 'clarify', summary: '请确认要生成图片还是视频。' },
  };
  const tokens = [TOKEN_A, TOKEN_B];
  const store = createPaidConfirmationStore({ createToken: () => tokens.shift() });
  bindPlanner(store, authorizationId, TOKEN_A, plannerRequest, plannerResult);
  assert.throws(() => issue(store, authorizationId, IMAGE_REQUEST, IMAGE_CHAIN), (error) => error.code === 'SEND_AUTHORIZATION_CHAIN_MISMATCH');
  const videoBody = createVideoRequestBinding({ prompt: executionPromptFor(plannerResult), clientJobId: 'job-clarify-video', sourceObjectId: 'canvas-x', sourceAssetId: 'asset-x', sourceVersionId: 'version-x', buffer: Buffer.from([1]) });
  assert.throws(() => issue(store, authorizationId, { kind: 'video', route: '/api/agent/video-jobs', body: videoBody }, { intentId: 'intent-clarify-1', planId: 'plan-clarify-1', operation: 'clarify', providerId: 'none', targetBinding: null }), (error) => ['SEND_AUTHORIZATION_TARGET_INVALID', 'SEND_AUTHORIZATION_CHAIN_MISMATCH'].includes(error.code));
});
