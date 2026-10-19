import { describe, expect, it, vi } from 'vitest';
import { createDeterministicFallbackPlanning, createDirectModePlanning, createEvoLinkPlannerAdapter } from './planner';

const PAID_CONFIRMATION = 'c'.repeat(43);

const envelope = (operation: 'image_generate' | 'image_edit_fixed_demo_reference' | 'image_edit_user_reference' | 'video_image_to_video' | 'clarify' = 'image_generate', imageProviderId = 'deterministic-mock') => ({
  intent: {
    id: 'intent-remote-1',
    kind: operation === 'clarify' ? 'clarify' : operation === 'image_generate' ? 'generate' : 'modify',
    operation,
    source: 'remote-agent',
    prompt: '音箱主视觉',
    normalizedPrompt: '为黑色音箱生成克制的棚拍主视觉',
    goal: '建立高级产品视觉',
    constraints: ['保留产品轮廓'],
    ...(operation !== 'image_generate' ? { targetCanvasObjectId: 'parent-1' } : {}),
    createdAt: '2026-08-05T00:00:00.000Z',
  },
  plan: {
    id: 'plan-remote-1',
    intentId: 'intent-remote-1',
    providerId: imageProviderId,
    status: 'proposed',
    operation,
    source: 'remote-agent',
    plannerModel: 'claude-haiku-4-5-20251001',
    summary: '结构化产品视觉方案',
    bullets: ['主体与轮廓', '材质与光影'],
    constraints: ['保留产品轮廓'],
    visualDirection: { subject: '音箱', style: '商业摄影', lighting: '棚拍', composition: '居中' },
    shouldFail: false,
    createdAt: '2026-08-05T00:00:00.000Z',
  },
  evidence: {
    provider: 'EvoLink',
    endpoint: 'https://direct.evolink.ai/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    httpStatus: 200,
    durationMs: 120,
    retryCount: 0,
    schemaResult: 'valid',
  },
});

describe('CORE-003 browser-side Planner Adapter', () => {
  it('accepts a schema-valid remote plan from the same-origin BFF', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify(envelope()), { status: 200 });
    });
    const planner = createEvoLinkPlannerAdapter(fetchStub as typeof fetch);
    const result = await planner.plan({ prompt: '音箱主视觉', imageProviderId: 'deterministic-mock' }, PAID_CONFIRMATION);
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(new Headers(capturedInit?.headers).get('X-ELYRA-Paid-Confirmation')).toBe(PAID_CONFIRMATION);
    expect(result).toMatchObject({ ok: true, intent: { source: 'remote-agent' }, plan: { operation: 'image_generate' }, evidence: { schemaResult: 'valid' } });
  });

  it('does not contact the Planner BFF without a paid confirmation token', async () => {
    const fetchStub = vi.fn();
    const planner = createEvoLinkPlannerAdapter(fetchStub as typeof fetch);
    await expect(planner.plan({ prompt: '音箱主视觉', imageProviderId: 'deterministic-mock' }, '')).resolves.toEqual({
      ok: false,
      error: { code: 'CORE008_PAID_CONFIRMATION_REQUIRED', message: '本次发送缺少有效的 Planner 一次性授权凭证。', retryable: false },
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('fails closed when the returned operation does not match selected-object context', async () => {
    const planner = createEvoLinkPlannerAdapter(async () => new Response(JSON.stringify(envelope('image_generate', 'evolink-gpt-image-2')), { status: 200 }));
    const result = await planner.plan({ prompt: '编辑当前图片', targetCanvasObjectId: 'parent-1', imageProviderId: 'evolink-gpt-image-2' }, PAID_CONFIRMATION);
    expect(result).toEqual({ ok: false, error: { code: 'PLANNER_CONTEXT_MISMATCH', message: 'Agent Planner 结果与当前画布上下文不一致。', retryable: false }, evidence: envelope('image_generate', 'evolink-gpt-image-2').evidence });
  });

  it('fails closed when an edit plan omits or changes the requested Canvas Object target', async () => {
    for (const target of [undefined, 'different-parent']) {
      const response = envelope('image_edit_fixed_demo_reference', 'evolink-gpt-image-2') as any;
      if (target === undefined) delete response.intent.targetCanvasObjectId;
      else response.intent.targetCanvasObjectId = target;
      const planner = createEvoLinkPlannerAdapter(async () => new Response(JSON.stringify(response), { status: 200 }));
      const result = await planner.plan({ prompt: '音箱主视觉', targetCanvasObjectId: 'parent-1', imageProviderId: 'evolink-gpt-image-2' }, PAID_CONFIRMATION);
      expect(result).toMatchObject({ ok: false, error: { code: 'PLANNER_CONTEXT_MISMATCH', retryable: false } });
    }
  });

  it('binds an uploaded local Asset to the dedicated CORE-007 operation', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchStub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify(envelope('image_edit_user_reference', 'evolink-gpt-image-2')), { status: 200 });
    });
    const planner = createEvoLinkPlannerAdapter(fetchStub as typeof fetch);
    const result = await planner.plan({ prompt: '音箱主视觉', targetCanvasObjectId: 'parent-1', referenceKind: 'user-upload', consentVersion: 'CORE-007-DATA-BOUNDARY-V1', imageProviderId: 'evolink-gpt-image-2' }, PAID_CONFIRMATION);
    expect(result).toMatchObject({ ok: true, intent: { operation: 'image_edit_user_reference', targetCanvasObjectId: 'parent-1' }, plan: { operation: 'image_edit_user_reference' } });
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ referenceKind: 'user-upload', consentVersion: 'CORE-007-DATA-BOUNDARY-V1' });
  });

  it('does not contact the remote Planner for a user reference without the same-version consent', async () => {
    const fetchStub = vi.fn();
    const planner = createEvoLinkPlannerAdapter(fetchStub as typeof fetch);
    const result = await planner.plan({ prompt: '音箱主视觉', targetCanvasObjectId: 'parent-1', referenceKind: 'user-upload', imageProviderId: 'evolink-gpt-image-2' }, PAID_CONFIRMATION);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CORE007_PLANNER_CONSENT_REQUIRED',
        message: '在向远程 Agent Planner 发送用户参考图指令前，必须确认外传与最长 72 小时留存边界。',
        retryable: false,
      },
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects invalid kind, status and visualDirection before they enter workspace state', async () => {
    const invalidResponses = [
      (() => { const value = envelope() as any; value.intent.kind = 'retry'; return value; })(),
      (() => { const value = envelope() as any; value.plan.status = 'approved'; return value; })(),
      (() => { const value = envelope() as any; delete value.plan.visualDirection.composition; return value; })(),
    ];
    for (const response of invalidResponses) {
      const planner = createEvoLinkPlannerAdapter(async () => new Response(JSON.stringify(response), { status: 200 }));
      const result = await planner.plan({ prompt: '音箱主视觉', imageProviderId: 'deterministic-mock' }, PAID_CONFIRMATION);
      expect(result).toEqual({ ok: false, error: { code: 'PLANNER_SCHEMA_INVALID', message: 'Agent Planner 返回的结构不符合 CORE-003 schema。', retryable: false } });
    }
  });

  it('does not silently downgrade a failed BFF response', async () => {
    const planner = createEvoLinkPlannerAdapter(async () => new Response(JSON.stringify({ error: { code: 'PLANNER_AUTH_FAILED', message: 'Agent Planner 鉴权失败。', retryable: false } }), { status: 401 }));
    await expect(planner.plan({ prompt: '音箱主视觉', imageProviderId: 'deterministic-mock' }, PAID_CONFIRMATION)).resolves.toEqual({ ok: false, error: { code: 'PLANNER_AUTH_FAILED', message: 'Agent Planner 鉴权失败。', retryable: false } });
  });

  it('creates a clearly labelled fallback only through the explicit local function', () => {
    const result = createDeterministicFallbackPlanning({ prompt: '为音箱增加暖色光', targetCanvasObjectId: 'parent-1', imageProviderId: 'deterministic-mock' });
    expect(result.intent).toMatchObject({ source: 'fallback', operation: 'image_edit_fixed_demo_reference', targetCanvasObjectId: 'parent-1' });
    expect(result.plan).toMatchObject({ source: 'fallback', status: 'proposed', operation: 'image_edit_fixed_demo_reference' });
    expect(result.plan.summary).toContain('本地规划草案');
  });

  it('keeps an explicitly chosen fallback inside the user-reference boundary', () => {
    const result = createDeterministicFallbackPlanning({ prompt: '编辑上传图', targetCanvasObjectId: 'parent-1', referenceKind: 'user-upload', imageProviderId: 'evolink-gpt-image-2' });
    expect(result.intent.operation).toBe('image_edit_user_reference');
    expect(result.plan.operation).toBe('image_edit_user_reference');
    expect(result.intent.source).toBe('fallback');
    expect(result.plan.providerId).toBe('deterministic-mock');
  });

  it('builds direct Image and Video mode plans without contacting the remote Planner', () => {
    const imageGenerate = createDirectModePlanning({ prompt: '生成产品图', creationMode: 'image', selectedCanvasObjectCount: 0, selectedObjectIds: [], imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview' });
    expect(imageGenerate).toMatchObject({ intent: { operation: 'image_generate', source: 'direct-mode', creationMode: 'image' }, plan: { outputKind: 'image', providerId: 'evolink-gpt-image-2' } });

    const imageEdit = createDirectModePlanning({ prompt: '编辑此图', creationMode: 'image', selectedCanvasObjectCount: 1, selectedObjectIds: ['object-1'], targetCanvasObjectId: 'object-1', imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview' });
    expect(imageEdit).toMatchObject({ intent: { operation: 'image_edit_fixed_demo_reference', targetCanvasObjectId: 'object-1' }, plan: { outputKind: 'image' } });

    const video = createDirectModePlanning({ prompt: '让镜头环绕产品', creationMode: 'video', selectedCanvasObjectCount: 1, selectedObjectIds: ['object-1'], targetCanvasObjectId: 'object-1', imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview' });
    expect(video).toMatchObject({ intent: { operation: 'video_image_to_video', targetCanvasObjectId: 'object-1' }, plan: { outputKind: 'video', providerId: 'evolink-sora-2-preview' } });

    for (const invalid of [
      createDirectModePlanning({ prompt: '生成视频', creationMode: 'video', selectedCanvasObjectCount: 0, selectedObjectIds: [], imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview' }),
      createDirectModePlanning({ prompt: '编辑图片', creationMode: 'image', selectedCanvasObjectCount: 2, selectedObjectIds: ['object-1', 'object-2'], imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview' }),
      createDirectModePlanning({ prompt: '由 Agent 判断', creationMode: 'agent', selectedCanvasObjectCount: 0, selectedObjectIds: [], imageProviderId: 'evolink-gpt-image-2', videoProviderId: 'evolink-sora-2-preview' }),
    ]) expect(invalid).toMatchObject({ intent: { operation: 'clarify', kind: 'clarify' }, plan: { outputKind: 'none', providerId: 'none' } });
  });

  it('accepts a bound Agent-mode video plan and strips local selected IDs from the remote request', async () => {
    let body: any;
    const response = envelope('video_image_to_video', 'evolink-sora-2-preview') as any;
    response.intent.creationMode = 'agent';
    response.plan.creationMode = 'agent';
    response.plan.outputKind = 'video';
    const planner = createEvoLinkPlannerAdapter(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(response), { status: 200 });
    });
    const result = await planner.plan({
      prompt: '音箱主视觉',
      creationMode: 'agent',
      selectedCanvasObjectCount: 1,
      selectedObjectIds: ['parent-1'],
      targetCanvasObjectId: 'parent-1',
      referenceKind: 'user-upload',
      consentVersion: 'CORE-007-DATA-BOUNDARY-V1',
      imageProviderId: 'evolink-gpt-image-2',
      videoProviderId: 'evolink-sora-2-preview',
    }, PAID_CONFIRMATION);
    expect(result).toMatchObject({ ok: true, intent: { operation: 'video_image_to_video', creationMode: 'agent' }, plan: { outputKind: 'video' } });
    expect(body).toMatchObject({ creationMode: 'agent', selectedCanvasObjectCount: 1, targetCanvasObjectId: 'parent-1', videoProviderId: 'evolink-sora-2-preview' });
    expect(body).not.toHaveProperty('selectedObjectIds');
  });

  it('classifies Agent-mode video routing without a restorable Blob as a dedicated zero-media failure', async () => {
    const response = envelope('video_image_to_video', 'evolink-sora-2-preview') as any;
    response.intent.creationMode = 'agent';
    response.plan.creationMode = 'agent';
    response.plan.outputKind = 'video';
    const planner = createEvoLinkPlannerAdapter(async () => new Response(JSON.stringify(response), { status: 200 }));
    const result = await planner.plan({
      prompt: '让演示图动起来',
      creationMode: 'agent',
      selectedCanvasObjectCount: 1,
      selectedObjectIds: ['parent-1'],
      targetCanvasObjectId: 'parent-1',
      referenceKind: 'fixed-demo',
      imageProviderId: 'evolink-gpt-image-2',
      videoProviderId: 'evolink-sora-2-preview',
    }, PAID_CONFIRMATION);
    expect(result).toMatchObject({ ok: false, error: { code: 'CORE009_VIDEO_SOURCE_NOT_RESTORABLE', retryable: false } });
  });
});
