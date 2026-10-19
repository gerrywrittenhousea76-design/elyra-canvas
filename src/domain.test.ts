import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzePrompt,
  clampScale,
  createBlankWorkspace,
  deleteWorkspaceNodes,
  loadWorkspace,
  makeMockNode,
  makeReferenceNode,
  PERSISTED_WORKSPACE_SCHEMA_VERSION,
  persistWorkspace,
  PROJECT_ID,
  readWorkspace,
  serializeWorkspace,
  STORAGE_KEY,
  WorkspacePersistenceError,
  workspaceStorageKey,
  workspaceAuditMessage,
  zoomViewportAtPoint,
} from './domain';

afterEach(() => vi.unstubAllGlobals());

describe('CORE-001 deterministic mock domain', () => {
  it('starts as a blank light workspace', () => {
    const workspace = createBlankWorkspace();
    expect(workspace.theme).toBe('light');
    expect(workspace.creationMode).toBe('agent');
    expect(workspace.nodes).toEqual([]);
    expect(workspace.messages).toHaveLength(1);
    expect(workspace).toMatchObject({ intents: [], plans: [], jobs: [], assets: [], versions: [] });
  });

  it('returns a structured plan and recognizes explicit deterministic failures', () => {
    expect(analyzePrompt('为音箱增加柔和的轮廓光').shouldFail).toBe(false);
    expect(analyzePrompt('请失败一次')).toMatchObject({ shouldFail: true });
  });

  it('creates a non-destructive child version next to its parent', () => {
    const parent = makeReferenceNode();
    const child = makeMockNode('child', '增强边缘光', parent);
    expect(child.parentId).toBe(parent.id);
    expect(child.version).toBe(1);
    expect(child.x).toBeGreaterThan(parent.x);
    expect(parent.status).toBe('ready');
  });

  it('keeps zoom in the usable canvas range', () => {
    expect(clampScale(9)).toBe(1.55);
    expect(clampScale(0.1)).toBe(0.45);
    expect(clampScale(1.0042)).toBe(1.0042);
  });

  it('keeps the world coordinate under the pointer stable while zooming', () => {
    const viewport = { x: -180, y: 75, scale: 1.2 };
    const point = { x: 640, y: 360 };
    const before = {
      x: (point.x - viewport.x) / viewport.scale,
      y: (point.y - viewport.y) / viewport.scale,
    };
    const zoomed = zoomViewportAtPoint(viewport, -100, point);
    const after = {
      x: (point.x - zoomed.x) / zoomed.scale,
      y: (point.y - zoomed.y) / zoomed.scale,
    };

    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('uses a lower wheel zoom step than the former fixed 0.08 jump', () => {
    const viewport = { x: 0, y: 0, scale: 1 };
    const zoomedIn = zoomViewportAtPoint(viewport, -100, { x: 0, y: 0 });
    const zoomedOut = zoomViewportAtPoint(viewport, 100, { x: 0, y: 0 });

    expect(zoomedIn.scale - viewport.scale).toBeGreaterThan(0);
    expect(zoomedIn.scale - viewport.scale).toBeLessThan(0.08);
    expect(viewport.scale - zoomedOut.scale).toBeGreaterThan(0);
    expect(viewport.scale - zoomedOut.scale).toBeLessThan(0.08);
  });

  it('clamps cursor-anchored wheel zoom at the supported scale limits', () => {
    expect(zoomViewportAtPoint({ x: 0, y: 0, scale: 1.54 }, -10_000, { x: 200, y: 100 }).scale).toBe(1.55);
    expect(zoomViewportAtPoint({ x: 0, y: 0, scale: 0.46 }, 10_000, { x: 200, y: 100 }).scale).toBe(0.45);
  });

  it('migrates legacy localStorage records without discarding Canvas or Version data', () => {
    const legacy = createBlankWorkspace() as any;
    delete legacy.plannerEvidence;
    legacy.nodes = [makeReferenceNode()];
    legacy.intents = [{ id: 'legacy-intent', kind: 'generate', prompt: '历史主视觉', createdAt: '2026-01-01T00:00:00.000Z' }];
    legacy.plans = [{ id: 'legacy-plan', intentId: 'legacy-intent', providerId: 'deterministic-mock', status: 'proposed', summary: '历史计划', bullets: ['历史步骤'], shouldFail: false, createdAt: '2026-01-01T00:00:00.000Z' }];
    const storage = new Map([[STORAGE_KEY, JSON.stringify(legacy)]]);
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null } });
    const restored = loadWorkspace();
    expect(restored.nodes).toHaveLength(1);
    expect(restored.intents[0]).toMatchObject({ operation: 'image_generate', source: 'legacy-deterministic', normalizedPrompt: '[已脱敏本地记录]' });
    expect(restored.plans[0]).toMatchObject({ operation: 'image_generate', source: 'legacy-deterministic' });
    expect(restored.plannerEvidence).toEqual([]);
    expect(restored.pendingPlanId).toBeUndefined();
    expect(restored.messages).toHaveLength(1);
  });

  it('migrates the schema v2 allowlisted workspace to schema v3 with Agent mode', () => {
    const workspace = createBlankWorkspace();
    workspace.creationMode = 'video';
    workspace.nodes = [makeReferenceNode()];
    const persistedV2 = JSON.parse(serializeWorkspace(workspace));
    persistedV2.schemaVersion = 2;
    delete persistedV2.creationMode;
    const storage = new Map([[STORAGE_KEY, JSON.stringify(persistedV2)]]);
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null } });

    const restored = loadWorkspace();
    expect(restored.creationMode).toBe('agent');
    expect(restored.nodes).toHaveLength(1);
    expect(JSON.parse(serializeWorkspace(restored))).toMatchObject({
      schemaVersion: 3,
      creationMode: 'agent',
    });
  });
});

describe('CORE-007 explicit localStorage allowlist', () => {
  it('persists graph relations without raw prompts, chat, evidence, Blob or external URLs', () => {
    const workspace = createBlankWorkspace() as any;
    workspace.creationMode = 'video';
    workspace.nodes = [{ ...makeReferenceNode(), id: 'parent', assetId: 'asset-local', versionId: 'version-parent', prompt: 'RAW_NODE_PROMPT' }];
    workspace.selectedIds = ['parent'];
    workspace.messages = [
      { id: 'raw-message', role: 'user', body: 'RAW_CHAT_MESSAGE', time: '10:00' },
      workspaceAuditMessage('CORE007_SOFT_CANCELLED', 'audit-safe'),
    ];
    workspace.intents = [{ id: 'intent-1', kind: 'modify', operation: 'image_edit_user_reference', source: 'remote-agent', prompt: 'RAW_INTENT_PROMPT', normalizedPrompt: 'RAW_NORMALIZED_PROMPT', goal: 'RAW_GOAL', constraints: ['RAW_CONSTRAINT'], targetCanvasObjectId: 'parent', createdAt: '2026-08-05T00:00:00.000Z' }];
    workspace.plans = [{ id: 'plan-1', intentId: 'intent-1', providerId: 'evolink-gpt-image-2', status: 'approved', operation: 'image_edit_user_reference', source: 'remote-agent', plannerModel: 'claude-haiku-4-5-20251001', summary: 'RAW_PLAN_SUMMARY', bullets: ['RAW_PLAN_STEP'], constraints: ['RAW_PLAN_CONSTRAINT'], visualDirection: { subject: 'RAW_SUBJECT', style: 'RAW_STYLE', lighting: 'RAW_LIGHT', composition: 'RAW_COMPOSITION' }, shouldFail: false, createdAt: '2026-08-05T00:00:00.000Z' }];
    workspace.pendingPlanId = 'plan-1';
    workspace.plannerEvidence = [{ provider: 'SECRET_PROVIDER_EVIDENCE', endpoint: 'https://direct.evolink.ai/private', model: 'secret', httpStatus: 200, durationMs: 1, retryCount: 0, schemaResult: 'valid' }];
    workspace.jobs = [{ id: 'job-1', intentId: 'intent-1', planId: 'plan-1', providerId: 'evolink-gpt-image-2', operation: 'edit', targetCanvasObjectId: 'parent', status: 'local_result_pending', attempt: 1, error: { code: 'SAFE_CODE', message: 'RAW_PROVIDER_ERROR', retryable: true, retryScope: 'local-result' }, createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:01:00.000Z' }];
    workspace.assets = [{ id: 'asset-local', kind: 'image', source: 'local-upload', providerId: 'local-upload', uri: 'data:image/png;base64,RAW_BYTES', mimeType: 'image/png', prompt: 'RAW_ASSET_PROMPT', createdAt: '2026-08-05T00:00:00.000Z', metadata: { deterministic: false, width: 10, height: 10 }, storage: { locator: 'indexeddb://elyra-assets/elyra-local-project-v1/blob-safe', projectId: 'elyra-local-project-v1', blobKey: 'blob-safe', sha256: 'a'.repeat(64), bytes: 42, mimeType: 'image/png', createdAt: '2026-08-05T00:00:00.000Z', fileName: '/Users/private/original.png', blob: new Blob(['RAW_BLOB']) } }];
    workspace.versions = [{ id: 'version-parent', canvasObjectId: 'parent', sequence: 0, status: 'ready', createdAt: '2026-08-05T00:00:00.000Z' }];
    workspace.referenceTransferConsent = { version: 'CORE-007-DATA-BOUNDARY-V1', acceptedAt: '2026-08-05T00:00:00.000Z' };

    const serialized = serializeWorkspace(workspace);
    for (const forbidden of ['RAW_', 'data:image', 'https://direct.evolink.ai', '/Users/private', 'original.png', 'SECRET_PROVIDER_EVIDENCE', 'EVOLINK_API_KEY']) {
      expect(serialized).not.toContain(forbidden);
    }
    const persisted = JSON.parse(serialized);
    expect(Object.keys(persisted).sort()).toEqual([
      'assets', 'auditMessages', 'imageProviderId', 'intents', 'jobs', 'nodes', 'plans', 'projectId',
      'creationMode', 'referenceTransferConsent', 'schemaVersion', 'selectedIds', 'theme', 'versions', 'viewport',
    ].sort());
    expect(persisted.schemaVersion).toBe(PERSISTED_WORKSPACE_SCHEMA_VERSION);
    expect(persisted.creationMode).toBe('video');
    expect(persisted.intents[0]).not.toHaveProperty('prompt');
    expect(persisted.plans[0]).not.toHaveProperty('summary');
    expect(persisted.jobs[0].error).toEqual({ code: 'SAFE_CODE', retryable: true, retryScope: 'local-result' });
    expect(persisted.assets[0].storage).not.toHaveProperty('blob');
    expect(persisted.assets[0].storage).not.toHaveProperty('fileName');
    expect(persisted.auditMessages).toEqual([{ id: 'audit-safe', role: 'system', auditCode: 'CORE007_SOFT_CANCELLED', time: expect.any(String) }]);

    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === STORAGE_KEY ? serialized : null } });
    const restored = loadWorkspace();
    expect(restored.nodes[0]).toMatchObject({ id: 'parent', prompt: '[已脱敏本地记录]' });
    expect(restored.intents[0]).toMatchObject({ id: 'intent-1', targetCanvasObjectId: 'parent', prompt: '[已脱敏本地记录]' });
    expect(restored.plans[0]).toMatchObject({ id: 'plan-1', intentId: 'intent-1', summary: '已脱敏 Agent Plan' });
    expect(restored.jobs[0]).toMatchObject({ id: 'job-1', intentId: 'intent-1', planId: 'plan-1', status: 'local_result_pending', error: { code: 'SAFE_CODE', message: '已脱敏任务错误', retryable: true, retryScope: 'local-result' } });
    expect(restored.messages.some((message) => message.auditCode === 'CORE007_SOFT_CANCELLED')).toBe(true);
    expect(restored.pendingPlanId).toBeUndefined();
    expect(restored.plannerEvidence).toEqual([]);
  });

  it('persists a local four-second MP4 Asset without its Provider URL or Blob', () => {
    const workspace = createBlankWorkspace() as any;
    workspace.creationMode = 'video';
    workspace.assets = [{
      id: 'asset-video',
      kind: 'video',
      source: 'remote-provider',
      providerId: 'evolink-sora-2-preview',
      jobId: 'job-video',
      uri: 'https://temporary.provider.example/result.mp4?secret=RAW_PROVIDER_URL',
      mimeType: 'video/mp4',
      prompt: 'RAW_VIDEO_PROMPT',
      createdAt: '2026-08-10T00:00:00.000Z',
      metadata: { deterministic: false, width: 1280, height: 720, durationSeconds: 4 },
      storage: {
        locator: 'indexeddb://elyra-assets/elyra-local-project-v1/asset-video',
        projectId: 'elyra-local-project-v1',
        blobKey: 'asset-video',
        sha256: 'b'.repeat(64),
        bytes: 1024,
        mimeType: 'video/mp4',
        createdAt: '2026-08-10T00:00:00.000Z',
        blob: new Blob(['RAW_VIDEO_BYTES'], { type: 'video/mp4' }),
      },
    }];

    const serialized = serializeWorkspace(workspace);
    expect(serialized).not.toContain('temporary.provider.example');
    expect(serialized).not.toContain('RAW_');
    const persisted = JSON.parse(serialized);
    expect(persisted.assets[0]).toMatchObject({
      id: 'asset-video',
      kind: 'video',
      mimeType: 'video/mp4',
      metadata: { deterministic: false, width: 1280, height: 720, durationSeconds: 4 },
      storage: { mimeType: 'video/mp4', sha256: 'b'.repeat(64) },
    });
    expect(persisted.assets[0].storage).not.toHaveProperty('blob');

    vi.stubGlobal('window', { localStorage: { getItem: () => serialized } });
    const restored = loadWorkspace() as any;
    expect(restored.creationMode).toBe('video');
    expect(restored.assets[0]).toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      metadata: { durationSeconds: 4 },
    });
    expect(restored.assets[0]).not.toHaveProperty('uri');
  });

  it('round-trips the allowlisted CORE-013 output slot without persisting media bytes', () => {
    const workspace = createBlankWorkspace();
    workspace.assets = [{
      id: 'asset-left45',
      kind: 'image',
      source: 'deterministic-mock',
      providerId: 'deterministic-mock',
      jobId: 'job-core013',
      mimeType: 'image/png',
      prompt: 'RAW_CORE013_PROMPT',
      createdAt: '2026-08-21T02:30:00.000Z',
      metadata: { deterministic: true, width: 640, height: 640, outputSlot: 'left45' },
    }];

    const serialized = serializeWorkspace(workspace);
    expect(serialized).not.toContain('RAW_CORE013_PROMPT');
    expect(JSON.parse(serialized).assets[0].metadata).toEqual({
      deterministic: true,
      width: 640,
      height: 640,
      outputSlot: 'left45',
    });

    vi.stubGlobal('window', { localStorage: { getItem: () => serialized } });
    expect(loadWorkspace().assets[0].metadata.outputSlot).toBe('left45');
  });

  it('fails closed after reload when browser-only Provider handles no longer exist', () => {
    const workspace = createBlankWorkspace() as any;
    const parent = { ...makeReferenceNode(), id: 'parent', versionId: 'version-parent' };
    const fixedChild = { ...makeMockNode('fixed-child', 'fixed', parent, { jobId: 'job-fixed', versionId: 'version-fixed' }), status: 'generating' };
    const userChild = { ...makeMockNode('user-child', 'user', parent, { jobId: 'job-user', versionId: 'version-user' }), status: 'generating' };
    workspace.nodes = [parent, fixedChild, userChild];
    workspace.intents = [
      { id: 'intent-fixed', kind: 'modify', operation: 'image_edit_fixed_demo_reference', source: 'remote-agent', prompt: 'fixed', normalizedPrompt: 'fixed', goal: 'fixed', constraints: [], targetCanvasObjectId: parent.id, createdAt: '2026-08-07T00:00:00.000Z' },
      { id: 'intent-user', kind: 'modify', operation: 'image_edit_user_reference', source: 'remote-agent', prompt: 'user', normalizedPrompt: 'user', goal: 'user', constraints: [], targetCanvasObjectId: parent.id, createdAt: '2026-08-07T00:00:00.000Z' },
    ];
    workspace.plans = [
      { id: 'plan-fixed', intentId: 'intent-fixed', providerId: 'evolink-gpt-image-2', status: 'approved', operation: 'image_edit_fixed_demo_reference', source: 'remote-agent', summary: 'fixed', bullets: [], constraints: [], visualDirection: { subject: '', style: '', lighting: '', composition: '' }, shouldFail: false, createdAt: '2026-08-07T00:00:00.000Z' },
      { id: 'plan-user', intentId: 'intent-user', providerId: 'evolink-gpt-image-2', status: 'approved', operation: 'image_edit_user_reference', source: 'remote-agent', summary: 'user', bullets: [], constraints: [], visualDirection: { subject: '', style: '', lighting: '', composition: '' }, shouldFail: false, createdAt: '2026-08-07T00:00:00.000Z' },
    ];
    workspace.jobs = [
      { id: 'job-fixed', intentId: 'intent-fixed', planId: 'plan-fixed', providerId: 'evolink-gpt-image-2', operation: 'edit', targetCanvasObjectId: parent.id, status: 'processing', attempt: 1, createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:01.000Z' },
      { id: 'job-user', intentId: 'intent-user', planId: 'plan-user', providerId: 'evolink-gpt-image-2', operation: 'edit', targetCanvasObjectId: parent.id, status: 'processing', attempt: 1, createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:01.000Z' },
    ];
    workspace.versions = [
      { id: 'version-parent', canvasObjectId: parent.id, sequence: 0, status: 'ready', createdAt: '2026-08-07T00:00:00.000Z' },
      { id: 'version-fixed', canvasObjectId: fixedChild.id, parentCanvasObjectId: parent.id, parentVersionId: 'version-parent', jobId: 'job-fixed', sequence: 1, status: 'pending', createdAt: '2026-08-07T00:00:01.000Z' },
      { id: 'version-user', canvasObjectId: userChild.id, parentCanvasObjectId: parent.id, parentVersionId: 'version-parent', jobId: 'job-user', sequence: 1, status: 'pending', createdAt: '2026-08-07T00:00:01.000Z' },
    ];

    const serialized = serializeWorkspace(workspace);
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === STORAGE_KEY ? serialized : null } });
    const restored = loadWorkspace();

    expect(restored.jobs.find((job) => job.id === 'job-fixed')).toMatchObject({
      status: 'failed',
      error: { code: 'CORE008_RELOAD_STATUS_CHECK_REQUIRED', retryable: true, retryScope: 'status-only' },
    });
    expect(restored.jobs.find((job) => job.id === 'job-user')).toMatchObject({
      status: 'failed',
      error: { code: 'CORE007_RELOAD_STATUS_CHECK_REQUIRED', retryable: true, retryScope: 'status-only' },
    });
    expect(restored.nodes.find((node) => node.id === 'fixed-child')?.status).toBe('failed');
    expect(restored.nodes.find((node) => node.id === 'user-child')?.status).toBe('failed');
    expect(restored.versions.find((version) => version.id === 'version-fixed')?.status).toBe('failed');
    expect(restored.versions.find((version) => version.id === 'version-user')?.status).toBe('failed');
  });

  it('narrowly restores historical completed-provider result failures as local-result only', () => {
    const workspace = createBlankWorkspace() as any;
    const child = { ...makeMockNode('recovery-child', 'recover', undefined, { jobId: 'job-recovery', versionId: 'version-recovery' }), status: 'failed' };
    workspace.nodes = [child];
    workspace.intents = [{ id: 'intent-recovery', kind: 'create', operation: 'image_generate', source: 'remote-agent', prompt: 'recover', normalizedPrompt: 'recover', goal: 'recover', constraints: [], createdAt: '2026-08-07T00:00:00.000Z' }];
    workspace.plans = [{ id: 'plan-recovery', intentId: 'intent-recovery', providerId: 'evolink-gpt-image-2', status: 'approved', operation: 'image_generate', source: 'remote-agent', summary: 'recover', bullets: [], constraints: [], visualDirection: { subject: '', style: '', lighting: '', composition: '' }, shouldFail: false, createdAt: '2026-08-07T00:00:00.000Z' }];
    workspace.jobs = [{ id: 'job-recovery', intentId: 'intent-recovery', planId: 'plan-recovery', providerId: 'evolink-gpt-image-2', operation: 'generate', status: 'failed', attempt: 1, error: { code: 'CORE008_RESULT_INVALID', message: 'legacy', retryable: false, retryScope: 'none' }, createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:01:00.000Z' }];
    workspace.versions = [{ id: 'version-recovery', canvasObjectId: child.id, jobId: 'job-recovery', sequence: 1, status: 'failed', createdAt: '2026-08-07T00:00:00.000Z' }];

    const serialized = serializeWorkspace(workspace);
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === STORAGE_KEY ? serialized : null } });
    const restored = loadWorkspace();

    expect(restored.jobs[0]).toMatchObject({
      status: 'local_result_pending',
      error: { code: 'CORE008_RESULT_INVALID', retryable: true, retryScope: 'local-result' },
    });
    expect(restored.nodes[0].status).toBe('failed');
    expect(restored.versions[0].status).toBe('failed');
  });

  it('fails closed after reload for an in-flight Sora Job without resubmitting it', () => {
    const workspace = createBlankWorkspace() as any;
    workspace.creationMode = 'video';
    const child = { ...makeMockNode('video-child', 'animate', undefined, { jobId: 'job-video', versionId: 'version-video' }), status: 'generating' };
    workspace.nodes = [child];
    workspace.intents = [{ id: 'intent-video', kind: 'modify', operation: 'video_image_to_video', source: 'remote-agent', prompt: 'animate', normalizedPrompt: 'animate', goal: 'animate', constraints: [], targetCanvasObjectId: 'source-image', createdAt: '2026-08-10T00:00:00.000Z' }];
    workspace.plans = [{ id: 'plan-video', intentId: 'intent-video', providerId: 'evolink-sora-2-preview', status: 'approved', operation: 'video_image_to_video', source: 'remote-agent', summary: 'animate', bullets: [], constraints: [], visualDirection: { subject: '', style: '', lighting: '', composition: '' }, shouldFail: false, createdAt: '2026-08-10T00:00:00.000Z' }];
    workspace.jobs = [{ id: 'job-video', intentId: 'intent-video', planId: 'plan-video', providerId: 'evolink-sora-2-preview', operation: 'image-to-video', targetCanvasObjectId: 'source-image', status: 'processing', attempt: 1, createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:01.000Z' }];
    workspace.versions = [{ id: 'version-video', canvasObjectId: child.id, jobId: 'job-video', sequence: 1, status: 'pending', createdAt: '2026-08-10T00:00:00.000Z' }];

    const serialized = serializeWorkspace(workspace);
    vi.stubGlobal('window', { localStorage: { getItem: () => serialized } });
    const restored = loadWorkspace();

    expect(restored.creationMode).toBe('video');
    expect(restored.jobs[0]).toMatchObject({
      status: 'failed',
      error: { code: 'CORE009_RELOAD_STATUS_CHECK_REQUIRED', retryable: true, retryScope: 'status-only' },
    });
    expect(restored.nodes[0].status).toBe('failed');
    expect(restored.versions[0].status).toBe('failed');
  });
});

describe('CORE-012 project-scoped Workspace repository boundary', () => {
  const memoryStorage = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      value: (key: string) => values.get(key),
    };
  };

  it('keeps the sealed default key while writing a new project to its own key', () => {
    const storage = memoryStorage();
    const workspace = createBlankWorkspace();
    workspace.viewport = { x: 12, y: 34, scale: 1.2 };
    persistWorkspace(workspace, storage, 'project-a');

    expect(storage.value(STORAGE_KEY)).toBeUndefined();
    expect(JSON.parse(storage.value(workspaceStorageKey('project-a'))!)).toMatchObject({
      schemaVersion: PERSISTED_WORKSPACE_SCHEMA_VERSION,
      projectId: 'project-a',
      viewport: { x: 12, y: 34, scale: 1.2 },
    });
    const restored = readWorkspace('project-a', storage);
    expect(restored.status).toBe('ready');
    if (restored.status === 'ready') expect(restored.workspace.viewport).toEqual({ x: 12, y: 34, scale: 1.2 });
    expect(workspaceStorageKey(PROJECT_ID)).toBe(STORAGE_KEY);
  });

  it('reports a top-level project mismatch as corrupt and loadWorkspace throws instead of returning blank', () => {
    const workspace = createBlankWorkspace();
    const wrongProjectRecord = serializeWorkspace(workspace, 'project-a');
    const storage = memoryStorage({ [workspaceStorageKey('project-b')]: wrongProjectRecord });

    expect(readWorkspace('project-b', storage)).toMatchObject({
      status: 'corrupt',
      projectId: 'project-b',
      code: 'WORKSPACE_PROJECT_BOUNDARY_MISMATCH',
    });
    expect(() => loadWorkspace('project-b', storage)).toThrowError(WorkspacePersistenceError);
  });

  it('rejects a cross-project Blob locator both when serializing and reading', () => {
    const workspace = createBlankWorkspace() as any;
    workspace.assets = [{
      id: 'asset-a', kind: 'image', source: 'local-upload', providerId: 'local-upload', mimeType: 'image/png',
      prompt: 'safe', createdAt: '2026-08-15T00:00:00.000Z', metadata: { deterministic: false, width: 10, height: 10 },
      storage: {
        locator: 'indexeddb://elyra-assets/project-b/blob-a', projectId: 'project-b', blobKey: 'blob-a',
        sha256: 'a'.repeat(64), bytes: 10, mimeType: 'image/png', createdAt: '2026-08-15T00:00:00.000Z',
      },
    }];
    expect(() => serializeWorkspace(workspace, 'project-a')).toThrow('WORKSPACE_PROJECT_BOUNDARY_MISMATCH');

    const validForB = serializeWorkspace(workspace, 'project-b');
    const forged = JSON.parse(validForB);
    forged.projectId = 'project-a';
    const storage = memoryStorage({ [workspaceStorageKey('project-a')]: JSON.stringify(forged) });
    expect(readWorkspace('project-a', storage)).toMatchObject({ status: 'corrupt', code: 'WORKSPACE_PROJECT_BOUNDARY_MISMATCH' });
  });
});

describe('CORE-007 graph-safe deletion', () => {
  const graphWorkspace = () => {
    const workspace = createBlankWorkspace() as any;
    const parent = { ...makeReferenceNode(), id: 'parent', assetId: 'asset-parent', versionId: 'version-parent' };
    const child = { ...makeMockNode('child', 'secret', parent, { jobId: 'job-child', versionId: 'version-child' }), status: 'ready', assetId: 'asset-child' };
    workspace.nodes = [parent, child];
    workspace.selectedIds = ['child'];
    workspace.assets = [
      { id: 'asset-parent', kind: 'image', source: 'local-upload', providerId: 'local-upload', mimeType: 'image/png', prompt: 'redacted', createdAt: '2026-08-05T00:00:00.000Z', metadata: { deterministic: false, width: 10, height: 10 } },
      { id: 'asset-child', kind: 'image', source: 'remote-provider', providerId: 'evolink-gpt-image-2', mimeType: 'image/png', prompt: 'redacted', createdAt: '2026-08-05T00:00:00.000Z', metadata: { deterministic: false, width: 10, height: 10 } },
    ];
    workspace.versions = [
      { id: 'version-parent', canvasObjectId: 'parent', sequence: 0, status: 'ready', createdAt: '2026-08-05T00:00:00.000Z' },
      { id: 'version-child', canvasObjectId: 'child', parentVersionId: 'version-parent', parentCanvasObjectId: 'parent', jobId: 'job-child', sequence: 1, status: 'ready', createdAt: '2026-08-05T00:00:01.000Z' },
    ];
    workspace.jobs = [{ id: 'job-child', intentId: 'intent-child', planId: 'plan-child', providerId: 'evolink-gpt-image-2', operation: 'edit', targetCanvasObjectId: 'parent', status: 'succeeded', attempt: 1, createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z' }];
    return workspace;
  };

  it('forbids deleting a parent that still has a child lineage', () => {
    expect(deleteWorkspaceNodes(graphWorkspace(), ['parent'])).toEqual({ ok: false, reason: 'HAS_CHILDREN' });
  });

  it('deletes a leaf Version and reports its now-unreferenced Asset for physical cleanup', () => {
    const result = deleteWorkspaceNodes(graphWorkspace(), ['child']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.nodes.map((node) => node.id)).toEqual(['parent']);
    expect(result.workspace.versions.map((version) => version.id)).toEqual(['version-parent']);
    expect(result.workspace.assets.map((asset) => asset.id)).toEqual(['asset-parent']);
    expect(result.orphanedAssets.map((asset) => asset.id)).toEqual(['asset-child']);
    expect(result.workspace.jobs.map((job) => job.id)).toEqual(['job-child']);
  });

  it('soft-cancels a generating Job, retains audit, and removes only its placeholder/Version', () => {
    const workspace = graphWorkspace();
    workspace.nodes = workspace.nodes.map((node: any) => node.id === 'child' ? { ...node, status: 'generating', assetId: undefined } : node);
    workspace.versions = workspace.versions.map((version: any) => version.id === 'version-child' ? { ...version, status: 'pending' } : version);
    workspace.jobs = workspace.jobs.map((job: any) => ({ ...job, status: 'processing' }));
    const result = deleteWorkspaceNodes(workspace, ['child'], { reason: 'soft-cancel', atIso: '2026-08-05T02:00:00.000Z', timeLabel: '10:00' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.nodes.map((node) => node.id)).toEqual(['parent']);
    expect(result.workspace.versions.map((version) => version.id)).toEqual(['version-parent']);
    expect(result.workspace.jobs[0]).toMatchObject({ id: 'job-child', status: 'user_cancelled', error: { code: 'CORE007_USER_CANCELLED', retryable: false } });
    expect(result.workspace.messages.at(-1)).toMatchObject({ auditCode: 'CORE007_SOFT_CANCELLED', role: 'system' });
    expect(result.cancelledJobIds).toEqual(['job-child']);
  });

  it('soft-cancels before deleting a generating node and labels the delete audit separately', () => {
    const workspace = graphWorkspace();
    workspace.nodes = workspace.nodes.map((node: any) => node.id === 'child' ? { ...node, status: 'generating', assetId: undefined } : node);
    workspace.versions = workspace.versions.map((version: any) => version.id === 'version-child' ? { ...version, status: 'pending' } : version);
    workspace.jobs = workspace.jobs.map((job: any) => ({ ...job, status: 'processing' }));
    const result = deleteWorkspaceNodes(workspace, ['child'], { reason: 'delete', atIso: '2026-08-05T02:00:00.000Z', timeLabel: '10:00' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.nodes.some((node) => node.id === 'child')).toBe(false);
    expect(result.workspace.jobs[0]).toMatchObject({ status: 'user_cancelled' });
    expect(result.workspace.messages.at(-1)).toMatchObject({ auditCode: 'CORE007_DELETE_SOFT_CANCELLED' });
  });

  it('keeps a shared Asset until the final referencing leaf is removed', () => {
    const workspace = graphWorkspace();
    workspace.nodes.push({ ...workspace.nodes[1], id: 'sibling', parentId: undefined, versionId: 'version-sibling' });
    workspace.versions.push({ id: 'version-sibling', canvasObjectId: 'sibling', sequence: 1, status: 'ready', createdAt: '2026-08-05T00:00:02.000Z' });
    const result = deleteWorkspaceNodes(workspace, ['child']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orphanedAssets).toEqual([]);
    expect(result.workspace.assets.some((asset) => asset.id === 'asset-child')).toBe(true);
  });
});
