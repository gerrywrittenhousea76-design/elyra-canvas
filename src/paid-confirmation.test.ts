import { describe, expect, it, vi } from 'vitest';
import {
  PaidConfirmationError,
  assertCore008LocalApiProtocol,
  assertCore009LocalApiProtocol,
  createPaidRequestDigest,
  createUserReferencePaidBinding,
  createVideoPaidBinding,
  mapPlannerCredentialFailure,
  requestCore008PlannerConfirmation,
  requestCore009PlannerConfirmation,
  requestPaidConfirmation,
} from './paid-confirmation';

const PLANNER_BINDING = {
  route: '/api/agent/plans' as const,
  body: { prompt: '非敏感演示', imageProviderId: 'evolink-gpt-image-2' },
};
const SEND_ID = 'send-0123456789abcdef0123456789abcdef';
const IMAGE_CHAIN = {
  intentId: 'intent-1',
  planId: 'plan-1',
  operation: 'image_generate' as const,
  providerId: 'evolink-gpt-image-2',
  targetBinding: null,
};
const VIDEO_CHAIN = {
  intentId: 'intent-video-1',
  planId: 'plan-video-1',
  operation: 'video_image_to_video' as const,
  providerId: 'evolink-sora-2-preview',
  targetBinding: { objectId: 'object-1', assetId: 'asset-1', versionId: 'version-1' },
};

describe('CORE-008 paid confirmation client', () => {
  it('checks the exact localhost protocol before issuing a Planner ticket', async () => {
    const requestDigest = await createPaidRequestDigest('planner', PLANNER_BINDING);
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url) === '/api/agent/core-008-capabilities') {
        return new Response(JSON.stringify({
          protocol: 'ELYRA_CORE008_LOCAL_API',
          protocolVersion: 1,
          capabilities: ['core008-budget-v1', 'paid-confirmation-v1', 'planner-send-authorization-v1'],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: 'a'.repeat(43), authorizationId: SEND_ID, kind: 'planner', requestDigest, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
    });
    await expect(requestCore008PlannerConfirmation(PLANNER_BINDING, fetchStub as typeof fetch, undefined, SEND_ID)).resolves.toBe('a'.repeat(43));
    expect(calls).toEqual([
      { url: '/api/agent/core-008-capabilities', method: 'GET' },
      { url: '/api/agent/paid-confirmations', method: 'POST' },
    ]);
  });

  it.each([
    ['missing endpoint', new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 })],
    ['old protocol', new Response(JSON.stringify({ protocol: 'ELYRA_CORE008_LOCAL_API', protocolVersion: 0, capabilities: [] }), { status: 200 })],
    ['missing capability', new Response(JSON.stringify({ protocol: 'ELYRA_CORE008_LOCAL_API', protocolVersion: 1, capabilities: ['core008-budget-v1'] }), { status: 200 })],
  ])('fails closed on a %s without requesting a ticket', async (_label, handshakeResponse) => {
    const fetchStub = vi.fn(async () => handshakeResponse.clone());
    await expect(requestCore008PlannerConfirmation(PLANNER_BINDING, fetchStub as typeof fetch, undefined, SEND_ID)).rejects.toMatchObject({ code: 'CORE008_PROTOCOL_MISMATCH' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('separates an unavailable local service from protocol and ticket issuance failures', async () => {
    const networkFailure = vi.fn(async () => { throw new TypeError('network down'); });
    await expect(assertCore008LocalApiProtocol(networkFailure as typeof fetch)).rejects.toMatchObject({ code: 'CORE008_LOCAL_SERVICE_UNAVAILABLE' });
    expect(mapPlannerCredentialFailure(new PaidConfirmationError('PAID_CONFIRMATION_CAPACITY_REACHED', 'private'))).toEqual({
      code: 'CORE008_TICKET_ISSUE_FAILED',
      message: '本机 Agent 服务未能签发本次发送的一次性 Planner 凭证；未调用 Planner。',
      retryable: true,
    });
  });

  it('returns one validated in-memory token for the requested kind', async () => {
    const requestDigest = await createPaidRequestDigest('planner', PLANNER_BINDING);
    // Fixed cross-runtime vector: server/paid-confirmation.mjs must produce
    // the same digest for this canonical request.
    expect(requestDigest).toBe('bcff8e61d35ed88b9e01af08f1e58cb44685771db60d70cdb0cc5e06e01ba972');
    const fetchStub = vi.fn(async (_url, init) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ authorizationId: SEND_ID, kind: 'planner', request: PLANNER_BINDING });
      return new Response(JSON.stringify({ token: 'a'.repeat(43), authorizationId: SEND_ID, kind: 'planner', requestDigest, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
    });
    await expect(requestPaidConfirmation('planner', PLANNER_BINDING, fetchStub as typeof fetch, undefined, SEND_ID)).resolves.toBe('a'.repeat(43));
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ token: 'short', kind: 'image', requestDigest: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 'CORE008_CONFIRMATION_INVALID'],
    [{ token: 'a'.repeat(43), kind: 'planner', requestDigest: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }, 'CORE008_CONFIRMATION_INVALID'],
    [{ token: 'a'.repeat(43), kind: 'image', requestDigest: 'a'.repeat(64), expiresAt: new Date(Date.now() - 1).toISOString() }, 'CORE008_CONFIRMATION_INVALID'],
  ])('fails closed for an invalid or mismatched receipt', async (body, code) => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify(body), { status: 201 }));
    await expect(requestPaidConfirmation('image', { route: '/api/agent/image-jobs', body: { prompt: 'x' } }, fetchStub as typeof fetch, undefined, SEND_ID, IMAGE_CHAIN)).rejects.toMatchObject({ code });
  });

  it('rejects a valid-looking ticket whose receipt is bound to a different request', async () => {
    const wrongDigest = await createPaidRequestDigest('planner', { ...PLANNER_BINDING, body: { ...PLANNER_BINDING.body, prompt: '另一项动作' } });
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      token: 'a'.repeat(43),
      authorizationId: SEND_ID,
      kind: 'planner',
      requestDigest: wrongDigest,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 201 }));
    await expect(requestPaidConfirmation('planner', PLANNER_BINDING, fetchStub as typeof fetch, undefined, SEND_ID)).rejects.toMatchObject({ code: 'CORE008_CONFIRMATION_INVALID' });
  });

  it('digests optional undefined object fields exactly as JSON.stringify omits them', async () => {
    const withUndefined = {
      route: '/api/agent/plans' as const,
      body: { ...PLANNER_BINDING.body, targetCanvasObjectId: undefined },
    };
    await expect(createPaidRequestDigest('planner', withUndefined)).resolves.toBe(
      await createPaidRequestDigest('planner', PLANNER_BINDING),
    );
  });

  it('binds CORE-009 Planner receipts only to the server allowlist fields', async () => {
    const withLocalSelectionIds = {
      route: '/api/agent/plans' as const,
      body: { ...PLANNER_BINDING.body, creationMode: 'agent', selectedCanvasObjectCount: 0, selectedObjectIds: ['local-only-id'] },
    };
    const serverShape = {
      route: '/api/agent/plans' as const,
      body: { ...PLANNER_BINDING.body, creationMode: 'agent', selectedCanvasObjectCount: 0 },
    };
    await expect(createPaidRequestDigest('planner', withLocalSelectionIds)).resolves.toBe(
      await createPaidRequestDigest('planner', serverShape),
    );
  });

  it('builds a multipart authorization descriptor from the exact Blob bytes', async () => {
    const binding = await createUserReferencePaidBinding({
      prompt: '编辑参考图',
      clientJobId: 'job-reference-1',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    });
    expect(binding).toEqual({
      route: '/api/agent/user-reference-image-jobs',
      body: {
        prompt: '编辑参考图',
        clientJobId: 'job-reference-1',
        consentVersion: 'CORE-007-DATA-BOUNDARY-V1',
        fileSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        fileSize: 3,
        mimeType: 'image/png',
      },
    });
  });

  it('canonicalizes multipart CRLF conversion to the same request digest', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const lf = await createUserReferencePaidBinding({ prompt: '第一行\n第二行', clientJobId: 'job-newlines', blob });
    const crlf = { ...lf, body: { ...lf.body, prompt: '第一行\r\n第二行' } };
    await expect(createPaidRequestDigest('image', lf)).resolves.toBe(await createPaidRequestDigest('image', crlf));
  });

  it('does not expose a server error body', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'CORE008_CONFIRMATION_REQUIRED', message: 'private detail' } }), { status: 403 }));
    await expect(requestPaidConfirmation('planner', PLANNER_BINDING, fetchStub as typeof fetch, undefined, SEND_ID)).rejects.toEqual(expect.objectContaining<Partial<PaidConfirmationError>>({ code: 'CORE008_CONFIRMATION_REQUIRED' }));
  });

  it('rejects a missing, malformed or mismatched Send authorization before returning a ticket', async () => {
    const fetchStub = vi.fn(async () => new Response('{}', { status: 201 }));
    await expect(requestPaidConfirmation('planner', PLANNER_BINDING, fetchStub as typeof fetch)).rejects.toMatchObject({ code: 'CORE008_SEND_AUTHORIZATION_INVALID' });
    await expect(requestPaidConfirmation('planner', PLANNER_BINDING, fetchStub as typeof fetch, undefined, 'send-not-hex')).rejects.toMatchObject({ code: 'CORE008_SEND_AUTHORIZATION_INVALID' });
    expect(fetchStub).not.toHaveBeenCalled();

    const requestDigest = await createPaidRequestDigest('planner', PLANNER_BINDING);
    const mismatchedReceipt = vi.fn(async () => new Response(JSON.stringify({
      token: 'a'.repeat(43), authorizationId: 'send-ffffffffffffffffffffffffffffffff', kind: 'planner', requestDigest,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 201 }));
    await expect(requestPaidConfirmation('planner', PLANNER_BINDING, mismatchedReceipt as typeof fetch, undefined, SEND_ID)).rejects.toMatchObject({ code: 'CORE008_CONFIRMATION_INVALID' });
  });

  it('requires a Planner-bound chain for every Image ticket request', async () => {
    const fetchStub = vi.fn();
    await expect(requestPaidConfirmation('image', { route: '/api/agent/image-jobs', body: { prompt: 'x' } }, fetchStub as typeof fetch, undefined, SEND_ID)).rejects.toMatchObject({ code: 'CORE008_SEND_CHAIN_INVALID' });
    await expect(requestPaidConfirmation('planner', PLANNER_BINDING, fetchStub as typeof fetch, undefined, SEND_ID, IMAGE_CHAIN)).rejects.toMatchObject({ code: 'CORE008_SEND_CHAIN_INVALID' });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('CORE-009 video confirmation client', () => {
  it('checks the exact CORE-009 localhost protocol before issuing a Planner ticket', async () => {
    const binding = {
      route: '/api/agent/plans' as const,
      body: {
        prompt: '让选中的图片动起来',
        imageProviderId: 'evolink-gpt-image-2',
        videoProviderId: 'evolink-sora-2-preview',
        creationMode: 'agent',
        selectedCanvasObjectCount: 1,
        targetCanvasObjectId: 'object-1',
        targetBinding: { objectId: 'object-1', assetId: 'asset-1', versionId: 'version-1' },
        referenceKind: 'user-upload',
        consentVersion: 'CORE-007-DATA-BOUNDARY-V1',
      },
    };
    const requestDigest = await createPaidRequestDigest('planner', binding);
    const calls: string[] = [];
    const fetchStub = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url) === '/api/agent/core-009-capabilities') {
        return new Response(JSON.stringify({
          protocol: 'ELYRA_CORE009_LOCAL_API',
          protocolVersion: 1,
          capabilities: ['core009-budget-v1', 'paid-confirmation-video-v1', 'planner-three-mode-routing-v1', 'sora2-image-to-video-v1', 'localhost-video-assets-v1', 'soft-cancel-v1'],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: 'v'.repeat(43), authorizationId: SEND_ID, kind: 'planner', requestDigest, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
    });
    await expect(requestCore009PlannerConfirmation(binding, fetchStub as typeof fetch, undefined, SEND_ID)).resolves.toBe('v'.repeat(43));
    expect(calls).toEqual(['/api/agent/core-009-capabilities', '/api/agent/paid-confirmations']);
  });

  it('fails closed when the CORE-009 capability set is incomplete', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      protocol: 'ELYRA_CORE009_LOCAL_API',
      protocolVersion: 1,
      capabilities: ['core009-budget-v1'],
    }), { status: 200 }));
    await expect(assertCore009LocalApiProtocol(fetchStub as typeof fetch)).rejects.toMatchObject({ code: 'CORE009_PROTOCOL_MISMATCH' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('binds a video ticket to the exact local source image bytes and lineage', async () => {
    const binding = await createVideoPaidBinding({
      prompt: '让灯光缓慢流动',
      clientJobId: 'job-video-1',
      sourceObjectId: 'object-1',
      sourceAssetId: 'asset-1',
      sourceVersionId: 'version-1',
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    });
    expect(binding).toEqual({
      route: '/api/agent/video-jobs',
      body: {
        prompt: '让灯光缓慢流动',
        clientJobId: 'job-video-1',
        sourceObjectId: 'object-1',
        sourceAssetId: 'asset-1',
        sourceVersionId: 'version-1',
        fileSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
        fileSize: 3,
        mimeType: 'image/png',
      },
    });
    const requestDigest = await createPaidRequestDigest('video', binding);
    const fetchStub = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ authorizationId: SEND_ID, kind: 'video', request: binding, chain: VIDEO_CHAIN });
      return new Response(JSON.stringify({ token: 'v'.repeat(43), authorizationId: SEND_ID, kind: 'video', requestDigest, expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
    });
    await expect(requestPaidConfirmation('video', binding, fetchStub as typeof fetch, undefined, SEND_ID, VIDEO_CHAIN)).resolves.toBe('v'.repeat(43));
  });

  it('rejects video without a selected image lineage or with an image operation', async () => {
    const fetchStub = vi.fn();
    const binding = { route: '/api/agent/video-jobs' as const, body: { prompt: 'x' } };
    await expect(requestPaidConfirmation('video', binding, fetchStub as typeof fetch, undefined, SEND_ID)).rejects.toMatchObject({ code: 'CORE009_SEND_CHAIN_INVALID' });
    await expect(requestPaidConfirmation('video', binding, fetchStub as typeof fetch, undefined, SEND_ID, IMAGE_CHAIN)).rejects.toMatchObject({ code: 'CORE009_SEND_CHAIN_INVALID' });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
