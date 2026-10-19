import { describe, expect, it, vi } from 'vitest';
import { composeExecutionPrompt, createAgentRuntime, createDeterministicMockProvider, createEvoLinkGptImageProvider, createEvoLinkSoraVideoProvider, providerResultHasOutputSet } from './agent';

const PAID_CONFIRMATION = 'i'.repeat(43);

describe('Phase 2 local agent runtime', () => {
  it('keeps intent, plan, job and deterministic asset as separate records', async () => {
    const runtime = createAgentRuntime([createDeterministicMockProvider(0)]);
    const intent = runtime.createIntent({ prompt: '为音箱增加一圈柔和轮廓光' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, { paidConfirmationToken: PAID_CONFIRMATION });

    expect(intent.id).toMatch(/^intent-/);
    expect(plan).toMatchObject({ intentId: intent.id, providerId: 'deterministic-mock', status: 'proposed' });
    expect(job).toMatchObject({ intentId: intent.id, planId: plan.id, providerId: 'deterministic-mock', status: 'queued' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok && !providerResultHasOutputSet(result)) {
      expect(result.asset).toMatchObject({ jobId: job.id, source: 'deterministic-mock', metadata: { deterministic: true, width: 1254, height: 1254 } });
      expect(result.asset.prompt).toBe(composeExecutionPrompt(intent, plan));
      expect(result.asset.prompt).toContain(plan.summary);
      expect(result.asset.prompt).toContain(plan.visualDirection.lighting);
    }
  });

  it('derives the immutable Provider prompt from normalized Intent and the approved Plan', () => {
    const runtime = createAgentRuntime([createDeterministicMockProvider(0)]);
    const intent = { ...runtime.createIntent({ prompt: '  原始音箱需求  ' }), normalizedPrompt: '规范化后的黑色音箱棚拍需求' };
    const plan = {
      ...runtime.planIntent(intent),
      summary: '建立克制的商业产品主视觉',
      bullets: ['保留产品比例', '增加底部轮廓光'],
      constraints: ['不得改变产品结构'],
      visualDirection: { subject: '黑色音箱', style: '高级商业摄影', lighting: '柔和棚拍光', composition: '居中留白' },
    };

    expect(composeExecutionPrompt(intent, plan)).toBe([
      '规范化后的黑色音箱棚拍需求',
      '规划摘要：建立克制的商业产品主视觉',
      '视觉方向：主体=黑色音箱；风格=高级商业摄影；光线=柔和棚拍光；构图=居中留白',
      '约束：不得改变产品结构',
      '执行步骤：保留产品比例；增加底部轮廓光',
    ].join('\n'));
  });

  it('preserves retryability on the deterministic failure path', async () => {
    const runtime = createAgentRuntime([createDeterministicMockProvider(0)]);
    const intent = runtime.createIntent({ prompt: '请失败一次' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, { paidConfirmationToken: PAID_CONFIRMATION });

    expect(result).toEqual({
      ok: false,
      error: { code: 'DETERMINISTIC_MOCK_FAILURE', message: 'Mock 失败路径已触发。', retryable: true },
    });
  });

  it('reuses the approved plan for an image retry without paying for a second planning call', async () => {
    const runtime = createAgentRuntime([createDeterministicMockProvider(0)]);
    const intent = runtime.createIntent({ prompt: '请失败一次' });
    const plan = runtime.planIntent(intent);
    const first = runtime.createJob({ intent, plan, attempt: 1 });
    const retry = runtime.createJob({ intent, plan, attempt: 2 });
    await expect(runtime.execute(first, intent, plan)).resolves.toMatchObject({ ok: false });
    await expect(runtime.execute(retry, intent, plan)).resolves.toMatchObject({ ok: true });
    expect(retry.planId).toBe(first.planId);
    expect(retry.intentId).toBe(first.intentId);
  });

  it('fails closed when a future provider was not registered', async () => {
    const runtime = createAgentRuntime([]);
    const intent = runtime.createIntent({ prompt: '生成产品主视觉' });
    const plan = { ...runtime.planIntent(intent), providerId: 'future-image-provider' };
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_NOT_CONFIGURED', retryable: false },
    });
  });

  it('fails closed when plan operation conflicts with the Canvas Object context', () => {
    const runtime = createAgentRuntime([createDeterministicMockProvider(0)]);
    const intent = runtime.createIntent({ prompt: '编辑当前对象', targetCanvasObjectId: 'parent-1' });
    const plan = { ...runtime.planIntent(intent), operation: 'image_generate' as const };
    expect(() => runtime.createJob({ intent, plan })).toThrow('operation 与 Canvas Object 上下文不匹配');
  });

  it('routes GPT Image 2 only through the local BFF and turns a completed task into an asset', async () => {
    const requests: string[] = [];
    const requestBodies: Array<{ prompt: string; clientJobId: string }> = [];
    const resultBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const fetchStub = async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (url.endsWith('/image-jobs')) {
        requestBodies.push(JSON.parse(String(init?.body)));
        expect(new Headers(init?.headers).get('X-ELYRA-Paid-Confirmation')).toBe(PAID_CONFIRMATION);
      }
      if (url.endsWith('/image-jobs')) return new Response(JSON.stringify({ id: 'task-unified-image-1', status: 'pending' }), { status: 202 });
      if (url.endsWith('/jobs/task-unified-image-1')) return new Response(JSON.stringify({ id: 'task-unified-image-1', status: 'completed', resultId: 'image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result: { mimeType: 'image/png', width: 1024, height: 1024, bytes: 3 } }), { status: 200 });
      if (url.endsWith('/image-job-results/image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) return new Response(resultBlob, { status: 200, headers: { 'Content-Type': 'image/png' } });
      throw new Error('unexpected route');
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '产品主视觉' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, { paidConfirmationToken: PAID_CONFIRMATION });

    expect(requests).toEqual(['/api/agent/image-jobs', '/api/agent/jobs/task-unified-image-1', '/api/agent/image-job-results/image-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(requestBodies[0]).toEqual({ prompt: composeExecutionPrompt(intent, plan), clientJobId: job.id });
    expect(requestBodies[0].prompt).toContain(plan.summary);
    expect(requestBodies[0].prompt).toContain(plan.visualDirection.composition);
    expect(result).toMatchObject({ ok: true });
    if (result.ok && !providerResultHasOutputSet(result)) {
      expect(result.asset).toMatchObject({ providerId: 'evolink-gpt-image-2', source: 'remote-provider', prompt: composeExecutionPrompt(intent, plan), metadata: { width: 1024, height: 1024 } });
      expect(Object.hasOwn(result.asset, 'uri')).toBe(false);
      expect(result.blob?.type).toBe('image/png');
      expect(new Uint8Array(await result.blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(JSON.stringify(result)).not.toContain('http');
  });

  it('routes a selected canvas object through the fixed-reference image edit endpoint', async () => {
    const requests: string[] = [];
    const resultBlob = new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' });
    const fetchStub = async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (url.endsWith('/image-edit-jobs')) expect(new Headers(init?.headers).get('X-ELYRA-Paid-Confirmation')).toBe(PAID_CONFIRMATION);
      if (url.endsWith('/image-edit-jobs')) return new Response(JSON.stringify({ id: 'task-unified-edit-1', status: 'pending' }), { status: 202 });
      if (url.endsWith('/jobs/task-unified-edit-1')) return new Response(JSON.stringify({ id: 'task-unified-edit-1', status: 'completed', resultId: 'image-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', result: { mimeType: 'image/png', width: 768, height: 1024, bytes: 3 } }), { status: 200 });
      if (url.endsWith('/image-job-results/image-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')) return new Response(resultBlob, { status: 200, headers: { 'Content-Type': 'image/png' } });
      throw new Error('unexpected route');
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '将光影改为暖色', targetCanvasObjectId: 'canvas-parent', kind: 'modify' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, { paidConfirmationToken: PAID_CONFIRMATION });

    expect(job.operation).toBe('edit');
    expect(requests).toEqual(['/api/agent/image-edit-jobs', '/api/agent/jobs/task-unified-edit-1', '/api/agent/image-job-results/image-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    expect(result).toMatchObject({ ok: true });
    if (result.ok && !providerResultHasOutputSet(result)) {
      expect(Object.hasOwn(result.asset, 'uri')).toBe(false);
      expect(result.blob?.type).toBe('image/png');
      expect(new Uint8Array(await result.blob!.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    }
    expect(JSON.stringify(result)).not.toContain('http');
  });

  it('routes an uploaded reference through multipart BFF and receives only an owned local Blob result', async () => {
    const requests: string[] = [];
    const progress: string[] = [];
    const resultBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const upload = async ({ endpoint, jobId, blob, onProgress, paidConfirmationToken }: any) => {
      expect(endpoint).toBe('/api/agent/user-reference-image-jobs');
      expect(blob.type).toBe('image/png');
      expect(paidConfirmationToken).toBe(PAID_CONFIRMATION);
      onProgress?.(41);
      return {
        response: new Response('{}', { status: 202 }),
        body: { localJobId: jobId, status: 'processing' as const, progress: 72 },
      };
    };
    const fetchStub = async (url: string) => {
      requests.push(url);
      if (url.includes('/user-reference-image-jobs/')) return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status: 'completed', progress: 100, resultId: 'result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result: { mimeType: 'image/png', width: 1024, height: 1024, bytes: 3 } }));
      if (url.includes('/local-assets/')) return new Response(resultBlob, { headers: { 'Content-Type': 'image/png' } });
      throw new Error('unexpected route');
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0, upload)]);
    const intent = runtime.createIntent({ prompt: '将背景改成暖灰棚拍', targetCanvasObjectId: 'parent-1', referenceKind: 'user-upload' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, { referenceBlob: new Blob([new Uint8Array([4])], { type: 'image/png' }), paidConfirmationToken: PAID_CONFIRMATION, onProgress: (value) => progress.push(value.status) });

    expect(intent.operation).toBe('image_edit_user_reference');
    expect(requests).toEqual([`/api/agent/user-reference-image-jobs/${job.id}`, '/api/agent/local-assets/result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(progress).toEqual(['validating', 'uploading', 'submitted']);
    expect(result).toMatchObject({ ok: true, asset: { source: 'remote-provider', metadata: { width: 1024, height: 1024 } } });
    if (result.ok && !providerResultHasOutputSet(result)) expect(Object.hasOwn(result.asset, 'uri')).toBe(false);
    if (result.ok && !providerResultHasOutputSet(result)) {
      if (!result.blob) throw new Error('expected an owned local result Blob');
      expect(result.blob.type).toBe('image/png');
      expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(JSON.stringify(result)).not.toContain('http');
  });

  it('fails closed when uploaded-reference bytes are unavailable', async () => {
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider()]);
    const intent = runtime.createIntent({ prompt: '编辑上传图', targetCanvasObjectId: 'parent-1', referenceKind: 'user-upload' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan)).resolves.toMatchObject({ ok: false, error: { code: 'CORE007_REFERENCE_BLOB_MISSING', retryable: false } });
  });

  it('does not contact the BFF when an initial remote image call lacks a paid confirmation', async () => {
    const fetchStub = vi.fn();
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '不得旁路确认门' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CORE008_PAID_CONFIRMATION_REQUIRED', retryable: false },
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('retries only the already-paid local result without uploading or creating a second Provider Job', async () => {
    let uploadCalls = 0;
    let localRetryCalls = 0;
    let statusCalls = 0;
    const resultBlob = new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' });
    const upload = async ({ jobId }: any) => {
      uploadCalls += 1;
      return {
        response: new Response('{}', { status: 202 }),
        body: { localJobId: jobId, status: 'processing' as const, progress: 72 },
      };
    };
    const fetchStub = async (url: string, options?: RequestInit) => {
      if (url.includes('/local-assets/')) return new Response(resultBlob, { headers: { 'Content-Type': 'image/png' } });
      if (url.includes('/user-reference-image-jobs/')) {
        if (options?.method === 'POST') {
          localRetryCalls += 1;
          expect(JSON.parse(String(options.body))).toEqual({ action: 'retry-local-result' });
          return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status: 'completed', progress: 100, resultId: 'result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', result: { mimeType: 'image/png', width: 1024, height: 1024, bytes: 3 }, retryScope: 'none', providerCompleted: true }));
        }
        statusCalls += 1;
        return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status: 'local_result_pending', progress: 92, retryScope: 'local-result', providerCompleted: true, error: { code: 'EVOLINK_RESULT_NETWORK_ERROR', message: '只能重试本地取回。', retryable: true } }));
      }
      throw new Error('unexpected route');
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0, upload)]);
    const intent = runtime.createIntent({ prompt: '仅重取本地结果', targetCanvasObjectId: 'parent-2', referenceKind: 'user-upload' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const referenceBlob = new Blob([new Uint8Array([1])], { type: 'image/png' });

    const first = await runtime.execute(job, intent, plan, { referenceBlob, paidConfirmationToken: PAID_CONFIRMATION });
    expect(first).toEqual({ ok: false, error: { code: 'EVOLINK_RESULT_NETWORK_ERROR', message: '只能重试本地取回。', retryable: true, retryScope: 'local-result' } });
    const resumed = await runtime.execute(job, intent, plan, { referenceBlob, resumeScope: 'local-result' });
    expect(resumed).toMatchObject({ ok: true, asset: { source: 'remote-provider' } });
    expect(uploadCalls).toBe(1);
    expect(localRetryCalls).toBe(1);
    expect(statusCalls).toBe(2);
  });

  it('rechecks only the existing paid task after exhausted status polling', async () => {
    let uploadCalls = 0;
    let statusReads = 0;
    let statusRetries = 0;
    const upload = async ({ jobId }: any) => {
      uploadCalls += 1;
      return {
        response: new Response('{}', { status: 202 }),
        body: { localJobId: jobId, status: 'processing' as const, progress: 72 },
      };
    };
    const resultBlob = new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' });
    const fetchStub = async (url: string, options?: RequestInit) => {
      if (url.includes('/local-assets/')) return new Response(resultBlob, { headers: { 'Content-Type': 'image/png' } });
      if (options?.method === 'POST') {
        statusRetries += 1;
        expect(JSON.parse(String(options.body))).toEqual({ action: 'retry-status' });
        return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status: 'completed', progress: 100, resultId: 'result-cccccccccccccccccccccccccccccccc', result: { mimeType: 'image/png', width: 1024, height: 1024, bytes: 3 }, retryScope: 'none', providerCompleted: true }));
      }
      statusReads += 1;
      return new Response(JSON.stringify({
        localJobId: url.split('/').at(-1),
        status: 'failed',
        progress: 72,
        retryScope: 'status-only',
        error: { code: 'CORE007_STATUS_UNAVAILABLE', message: '状态暂时无法查询。', retryable: true },
      }));
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0, upload)]);
    const intent = runtime.createIntent({ prompt: '状态故障', targetCanvasObjectId: 'parent-3', referenceKind: 'user-upload' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const referenceBlob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const result = await runtime.execute(job, intent, plan, { referenceBlob, paidConfirmationToken: PAID_CONFIRMATION });
    expect(result).toEqual({ ok: false, error: { code: 'CORE007_STATUS_UNAVAILABLE', message: '状态暂时无法查询。', retryable: true, retryScope: 'status-only' } });
    const resumed = await runtime.execute(job, intent, plan, { referenceBlob, resumeScope: 'status-only' });
    expect(resumed).toMatchObject({ ok: true, asset: { source: 'remote-provider' } });
    expect(uploadCalls).toBe(1);
    expect(statusReads).toBe(2);
    expect(statusRetries).toBe(1);
  });

  it('fails closed on an ambiguous create response without suggesting a duplicate paid retry', async () => {
    const fetchStub = vi.fn(async () => { throw new Error('offline'); });
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch)]);
    const intent = runtime.createIntent({ prompt: '树脂大板桌主视觉' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan, { paidConfirmationToken: PAID_CONFIRMATION })).resolves.toEqual({
      ok: false,
      error: { code: 'CORE008_CREATE_AMBIGUOUS', message: '图片任务创建结果不明确，可能已经产生费用；不会自动或普通重试。', retryable: false, retryScope: 'none' },
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['text generation', undefined, '/api/agent/image-jobs'],
    ['fixed-reference edit', 'canvas-parent', '/api/agent/image-edit-jobs'],
  ])('rechecks the same paid task after a %s status failure without a second ticket or submit', async (_label, targetCanvasObjectId, submitRoute) => {
    let submits = 0;
    let statusReads = 0;
    let resultReads = 0;
    const fetchStub = async (url: string) => {
      if (url.endsWith(submitRoute)) {
        submits += 1;
        return new Response(JSON.stringify({ id: `task-unified-status-${targetCanvasObjectId ? 'edit' : 'text'}`, status: 'pending' }), { status: 202 });
      }
      if (url.includes('/jobs/')) {
        statusReads += 1;
        if (statusReads === 1) throw new TypeError('temporary local status transport failure');
        return new Response(JSON.stringify({ id: url.split('/').at(-1), status: 'completed', resultId: 'image-result-cccccccccccccccccccccccccccccccc', result: { mimeType: 'image/png', width: 512, height: 512, bytes: 3 } }));
      }
      if (url.includes('/image-job-results/')) {
        resultReads += 1;
        return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`unexpected route: ${url}`);
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '状态恢复', ...(targetCanvasObjectId ? { targetCanvasObjectId, kind: 'modify' as const } : {}) });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const first = await runtime.execute(job, intent, plan, { paidConfirmationToken: PAID_CONFIRMATION });
    expect(first).toMatchObject({ ok: false, error: { code: 'CORE008_STATUS_UNAVAILABLE', retryable: true, retryScope: 'status-only' } });
    const resumed = await runtime.execute(job, intent, plan, { resumeScope: 'status-only' });
    expect(resumed).toMatchObject({ ok: true, asset: { metadata: { width: 512, height: 512 } } });
    expect(submits).toBe(1);
    expect(statusReads).toBe(2);
    expect(resultReads).toBe(1);
  });

  it.each([
    ['text generation', undefined, '/api/agent/image-jobs'],
    ['fixed-reference edit', 'canvas-parent', '/api/agent/image-edit-jobs'],
  ])('re-fetches only the existing localhost Blob after a %s local-result failure', async (_label, targetCanvasObjectId, submitRoute) => {
    let submits = 0;
    let statusReads = 0;
    let resultReads = 0;
    const fetchStub = async (url: string) => {
      if (url.endsWith(submitRoute)) {
        submits += 1;
        return new Response(JSON.stringify({ id: `task-unified-result-${targetCanvasObjectId ? 'edit' : 'text'}`, status: 'pending' }), { status: 202 });
      }
      if (url.includes('/jobs/')) {
        statusReads += 1;
        return new Response(JSON.stringify({ id: url.split('/').at(-1), status: 'completed', resultId: 'image-result-dddddddddddddddddddddddddddddddd', result: { mimeType: 'image/png', width: 640, height: 640, bytes: 3 } }));
      }
      if (url.includes('/image-job-results/')) {
        resultReads += 1;
        if (resultReads === 1) throw new TypeError('temporary localhost Blob read failure');
        return new Response(new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`unexpected route: ${url}`);
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '本地结果恢复', ...(targetCanvasObjectId ? { targetCanvasObjectId, kind: 'modify' as const } : {}) });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const first = await runtime.execute(job, intent, plan, { paidConfirmationToken: PAID_CONFIRMATION });
    expect(first).toMatchObject({ ok: false, error: { code: 'CORE008_LOCAL_RESULT_UNAVAILABLE', retryable: true, retryScope: 'local-result' } });
    const resumed = await runtime.execute(job, intent, plan, { resumeScope: 'local-result' });
    expect(resumed).toMatchObject({ ok: true, asset: { metadata: { width: 640, height: 640 } } });
    expect(submits).toBe(1);
    expect(statusReads).toBe(2);
    expect(resultReads).toBe(2);
  });

  it('fails closed after refresh when the server no longer has the opaque task handle and never creates a new paid job', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'CORE008_LOCAL_TASK_HANDLE_MISSING', message: '本机未保留该任务。', retryable: false },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '刷新后的本地结果恢复' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan, { resumeScope: 'local-result' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CORE008_LOCAL_TASK_HANDLE_MISSING', retryable: false, retryScope: 'none' },
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(`/api/agent/image-jobs/by-client-job/${job.id}`, { signal: undefined });
  });

  it('recovers the opaque task handle from the local server after refresh and only re-materializes that task', async () => {
    const requests: string[] = [];
    const fetchStub = async (url: string) => {
      requests.push(url);
      if (url.includes('/image-jobs/by-client-job/')) {
        return new Response(JSON.stringify({ id: 'task-unified-refresh-recovery', status: 'local_result_pending' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/jobs/task-unified-refresh-recovery')) {
        return new Response(JSON.stringify({
          id: 'task-unified-refresh-recovery',
          status: 'completed',
          resultId: 'image-result-ffffffffffffffffffffffffffffffff',
          result: { mimeType: 'image/png', width: 1024, height: 1024, bytes: 3 },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/image-job-results/')) {
        return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`unexpected route: ${url}`);
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '刷新恢复同一付费任务' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, { resumeScope: 'local-result' });
    expect(result).toMatchObject({ ok: true, asset: { metadata: { width: 1024, height: 1024 } } });
    expect(requests).toEqual([
      `/api/agent/image-jobs/by-client-job/${job.id}`,
      '/api/agent/jobs/task-unified-refresh-recovery',
      '/api/agent/image-job-results/image-result-ffffffffffffffffffffffffffffffff',
    ]);
  });

  it('actively aborts a non-upload image submit and never begins status polling', async () => {
    const requests: string[] = [];
    const fetchStub = async (url: string, init?: RequestInit) => {
      requests.push(url);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };
    const runtime = createAgentRuntime([createEvoLinkGptImageProvider(fetchStub as typeof fetch, '/api/agent', 0)]);
    const intent = runtime.createIntent({ prompt: '中止远程任务' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const controller = new AbortController();
    const resultPromise = runtime.execute(job, intent, plan, { signal: controller.signal, paidConfirmationToken: PAID_CONFIRMATION });
    controller.abort();
    await expect(resultPromise).resolves.toMatchObject({ ok: false, error: { code: 'CORE007_USER_CANCELLED', retryable: false } });
    expect(requests).toEqual(['/api/agent/image-jobs']);
  });

  it('creates a strongly-bound four-second video Job and materializes only a localhost MP4 Blob', async () => {
    const requests: string[] = [];
    let submittedForm: FormData | undefined;
    const mp4 = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/agent/video-jobs') {
        submittedForm = init?.body as FormData;
        expect(new Headers(init?.headers).get('X-ELYRA-Paid-Confirmation')).toBe(PAID_CONFIRMATION);
        return new Response(JSON.stringify({ localJobId: submittedForm?.get('clientJobId'), status: 'processing', progress: 72 }));
      }
      if (url.includes('/api/agent/video-jobs/')) return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status: 'completed', progress: 100, resultId: 'video-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', result: { mimeType: 'video/mp4', width: 1280, height: 720, durationSeconds: 3.75, bytes: mp4.length, sha256: '13c5cdb9c9f00bbaf88c207ace44d2cd5c44ea53d6b7c11373226c0858e8bab5' } }));
      if (url.includes('/api/agent/video-assets/')) return new Response(new Blob([mp4], { type: 'video/mp4' }), { headers: { 'Content-Type': 'video/mp4' } });
      throw new Error(`unexpected route ${url}`);
    });
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '让灯光缓慢扫过产品', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
    });

    expect(job).toMatchObject({ operation: 'video', targetCanvasObjectId: 'object-source' });
    expect(requests).toEqual([
      '/api/agent/video-jobs',
      `/api/agent/video-jobs/${job.id}`,
      '/api/agent/video-assets/video-result-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    expect([...submittedForm!.keys()].sort()).toEqual(['clientJobId', 'file', 'prompt', 'sourceAssetId', 'sourceObjectId', 'sourceVersionId']);
    expect(submittedForm!.get('sourceObjectId')).toBe('object-source');
    expect(submittedForm!.get('sourceVersionId')).toBe('version-source');
    expect(submittedForm!.get('sourceAssetId')).toBe('asset-source');
    expect(result).toMatchObject({ ok: true, asset: { kind: 'video', providerId: 'evolink-sora-2-preview', mimeType: 'video/mp4', metadata: { width: 1280, height: 720, durationSeconds: 3.75 } } });
    expect(JSON.stringify(result)).not.toContain('https://');
  });

  it.each([
    ['status-only', 'failed', { code: 'CORE009_VIDEO_STATUS_UNAVAILABLE', message: '状态暂时不可用。', retryable: true, retryScope: 'status-only' }],
    ['local-result', 'local_result_pending', { code: 'CORE009_VIDEO_RESULT_DOWNLOAD_FAILED', message: '本地结果暂时不可用。', retryable: true, retryScope: 'local-result' }],
  ] as const)('surfaces a nested %s scope from the first paid task without losing its safe retry boundary', async (scope, status, error) => {
    const requests: string[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/agent/video-jobs') return new Response(JSON.stringify({ localJobId: 'job-video-nested-scope', status: 'processing', progress: 72 }));
      return new Response(JSON.stringify({ localJobId: 'job-video-nested-scope', status, progress: 72, error }));
    });
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = { ...runtime.createJob({ intent, plan }), id: 'job-video-nested-scope' };
    const result = await runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
    });

    expect(result).toMatchObject({ ok: false, error: { code: error.code, retryable: true, retryScope: scope } });
    expect(requests).toEqual(['/api/agent/video-jobs', '/api/agent/video-jobs/job-video-nested-scope']);
  });

  it('preserves a transient pre-task video failure only as a new-send retry boundary', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'CORE009_VIDEO_UPLOAD_FAILED', message: '视频参考图上传失败，未提交视频生成。', retryable: true, retryScope: 'new-provider-job' },
    }), { status: 503 }));
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CORE009_VIDEO_UPLOAD_FAILED', retryable: true, retryScope: 'new-provider-job' },
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('preserves a transient terminal video failure only as a new-send retry boundary', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/agent/video-jobs'
      ? new Response(JSON.stringify({ localJobId: 'job-video-task-transient', status: 'processing', progress: 72 }))
      : new Response(JSON.stringify({
        localJobId: 'job-video-task-transient',
        status: 'failed',
        progress: 72,
        retryScope: 'new-provider-job',
        error: { code: 'CORE009_VIDEO_TASK_TRANSIENT_FAILURE', message: '视频任务因明确临时状态失败。', retryable: true, retryScope: 'new-provider-job' },
      })));
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = { ...runtime.createJob({ intent, plan }), id: 'job-video-task-transient' };
    await expect(runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CORE009_VIDEO_TASK_TRANSIENT_FAILURE', retryable: true, retryScope: 'new-provider-job' },
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['status-only', 'failed', { code: 'CORE009_VIDEO_STATUS_UNAVAILABLE', message: '状态暂时不可用。', retryable: true, retryScope: 'status-only' }],
    ['local-result', 'local_result_pending', { code: 'CORE009_VIDEO_RESULT_DOWNLOAD_FAILED', message: '本地结果暂时不可用。', retryable: true, retryScope: 'local-result' }],
  ] as const)('preserves a nested %s retry scope without creating another paid video task', async (scope, status, error) => {
    const requests: Array<{ url: string; method: string; action?: string }> = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const action = typeof init?.body === 'string' ? JSON.parse(init.body).action : undefined;
      requests.push({ url, method, action });
      if (method === 'GET') return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status, progress: 72, error }));
      return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status, progress: 72, error }));
    });
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '继续视频任务', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const result = await runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      resumeScope: scope,
    });

    expect(result).toMatchObject({ ok: false, error: { code: error.code, retryable: true, retryScope: scope } });
    expect(requests).toEqual([
      { url: `/api/agent/video-jobs/${job.id}`, method: 'GET', action: undefined },
      { url: `/api/agent/video-jobs/${job.id}`, method: 'POST', action: scope === 'status-only' ? 'retry-status' : 'retry-local-result' },
    ]);
    expect(fetchStub).not.toHaveBeenCalledWith('/api/agent/video-jobs', expect.anything());
  });

  it('fails closed when top-level and nested video retry scopes disagree', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      localJobId: String(input).split('/').at(-1),
      status: 'failed',
      progress: 72,
      retryScope: 'local-result',
      error: { code: 'CORE009_VIDEO_STATUS_UNAVAILABLE', message: '状态暂时不可用。', retryable: true, retryScope: 'status-only' },
    })));
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '继续视频任务', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      resumeScope: 'status-only',
    })).resolves.toMatchObject({ ok: false, error: { code: 'CORE009_VIDEO_STATUS_UNAVAILABLE', retryable: false, retryScope: 'none' } });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('rejects a localhost video Blob whose digest differs from the sealed task result', async () => {
    const mp4 = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/agent/video-jobs') return new Response(JSON.stringify({ localJobId: 'job-video-digest', status: 'processing', progress: 72 }));
      if (url.includes('/api/agent/video-jobs/')) return new Response(JSON.stringify({
        localJobId: 'job-video-digest',
        status: 'completed',
        progress: 100,
        resultId: 'video-result-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        result: { mimeType: 'video/mp4', width: 1280, height: 720, durationSeconds: 4, bytes: mp4.length, sha256: '0'.repeat(64) },
      }));
      if (url.includes('/api/agent/video-assets/')) return new Response(new Blob([mp4], { type: 'video/mp4' }), { headers: { 'Content-Type': 'video/mp4' } });
      throw new Error(`unexpected route ${url}`);
    });
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = { ...runtime.createJob({ intent, plan }), id: 'job-video-digest' };
    await expect(runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
    })).resolves.toMatchObject({ ok: false, error: { code: 'CORE009_VIDEO_RESULT_DIGEST_MISMATCH', retryable: false } });
  });

  it('fails closed before contacting the video BFF without token, one source image or exact binding', async () => {
    const fetchStub = vi.fn();
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const clarify = runtime.createIntent({ prompt: '生成视频', creationMode: 'video' });
    expect(clarify.operation).toBe('clarify');
    expect(() => runtime.createJob({ intent: clarify, plan: runtime.planIntent(clarify) })).toThrow('Clarify Intent');

    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'CORE009_PAID_CONFIRMATION_REQUIRED', retryable: false } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects a non-sanitized video source before contacting the BFF', async () => {
    const fetchStub = vi.fn();
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    await expect(runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
    })).resolves.toMatchObject({ ok: false, error: { code: 'CORE009_VIDEO_REFERENCE_BLOB_INVALID', retryable: false } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('soft-cancels local video waiting and never accepts a late result', async () => {
    let softCancelCalls = 0;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/video-jobs/') && init?.method === 'POST') {
        softCancelCalls += 1;
        return new Response(JSON.stringify({ localJobId: url.split('/').at(-1), status: 'user_cancelled', progress: 0 }));
      }
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = runtime.createJob({ intent, plan });
    const controller = new AbortController();
    const pending = runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CORE009_USER_CANCELLED', retryable: false } });
    await vi.waitFor(() => expect(softCancelCalls).toBe(1));
  });

  it('keeps an established paid video task recoverable when the Agent deadline expires', async () => {
    let softCancelCalls = 0;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/agent/video-jobs') {
        return new Response(JSON.stringify({ localJobId: 'job-video-deadline', status: 'processing', progress: 72 }));
      }
      if (init?.method === 'POST') {
        softCancelCalls += 1;
        return new Response(JSON.stringify({ localJobId: 'job-video-deadline', status: 'user_cancelled', progress: 0 }));
      }
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const runtime = createAgentRuntime([createEvoLinkSoraVideoProvider(fetchStub as typeof fetch, undefined, 0)]);
    const intent = runtime.createIntent({ prompt: '生成视频', creationMode: 'video', targetCanvasObjectId: 'object-source' });
    const plan = runtime.planIntent(intent);
    const job = { ...runtime.createJob({ intent, plan }), id: 'job-video-deadline' };
    const controller = new AbortController();
    const pending = runtime.execute(job, intent, plan, {
      referenceBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      sourceBinding: { canvasObjectId: 'object-source', versionId: 'version-source', assetId: 'asset-source' },
      paidConfirmationToken: PAID_CONFIRMATION,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    controller.abort('RUN_DEADLINE_EXCEEDED');
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'CORE009_VIDEO_DEADLINE_EXCEEDED', retryable: true, retryScope: 'status-only' },
    });
    expect(softCancelCalls).toBe(0);
  });
});
