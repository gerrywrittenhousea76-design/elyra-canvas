import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ID, STORAGE_KEY } from './domain';
import {
  COMMUNITY_ITEMS,
  HOME_WORKSPACE_HANDOFF_KEY,
  HOME_WORKSPACE_HANDOFF_TTL_MS,
  clearPortalDraft,
  consumeHomeWorkspaceHandoff,
  consumePortalDraft,
  createHomeWorkspaceHandoff,
  getPortalProjectSummary,
  getPortalProjectSummaries,
  isHomeWorkspaceHandoffV1,
  parsePortalRoute,
  peekHomeWorkspaceHandoff,
  peekPortalDraft,
  saveHomeWorkspaceHandoff,
  savePortalDraft,
  setPortalTheme,
  writePortalRoute,
} from './portal-state';

const memoryStorage = (seed: Record<string, string> = {}) => {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    value: (key: string) => values.get(key),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('CORE-010 portal routes', () => {
  it('accepts only exact allowlisted hash routes and fails safe to Home', () => {
    expect(parsePortalRoute('#/home')).toBe('home');
    expect(parsePortalRoute('#/community')).toBe('community');
    expect(parsePortalRoute('#/projects/')).toBe('projects');
    expect(parsePortalRoute('#/assets')).toBe('assets');
    expect(parsePortalRoute('#/workspace')).toBe('workspace');
    for (const unsafe of ['', '#/unknown', '#/workspace?prompt=secret', '#//workspace', 'https://example.com']) {
      expect(parsePortalRoute(unsafe)).toBe('home');
    }
  });

  it('writes only an allowlisted local hash', () => {
    const location = { hash: '' };
    vi.stubGlobal('window', { location });
    writePortalRoute('community');
    expect(location.hash).toBe('#/community');
  });
});

describe('CORE-010 local project summary and theme', () => {
  it('derives a privacy-safe summary from the existing single Workspace record', () => {
    const workspace = {
      schemaVersion: 3,
      projectId: PROJECT_ID,
      theme: 'light',
      nodes: [{ id: 'object-1', prompt: 'must-not-leak', createdAt: '2026-08-12T10:00:00.000Z' }],
      assets: [
        { id: 'image-1', kind: 'image', uri: 'https://provider.example/private', createdAt: '2026-08-12T11:00:00.000Z' },
        { id: 'video-1', kind: 'video', createdAt: '2026-08-12T12:00:00.000Z' },
      ],
      versions: [{ id: 'version-1', createdAt: '2026-08-12T10:30:00.000Z' }],
      jobs: [{ id: 'job-1', updatedAt: '2026-08-12T13:00:00.000Z' }],
      messages: [{ body: 'private chat' }],
    };
    const localStorage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(workspace) });
    vi.stubGlobal('window', { localStorage });

    const summary = getPortalProjectSummary();
    expect(summary).toEqual({
      id: PROJECT_ID,
      title: '便携式无线音箱视觉创作',
      theme: 'light',
      objectCount: 1,
      imageCount: 1,
      videoCount: 1,
      versionCount: 1,
      updatedAt: '2026-08-12T13:00:00.000Z',
      hasLocalContent: true,
    });
    expect(JSON.stringify(summary)).not.toMatch(/prompt|private|provider\.example|messages|uri/);
  });

  it('updates the existing Workspace theme without changing its other fields', () => {
    const original = { schemaVersion: 3, projectId: PROJECT_ID, theme: 'dark', nodes: [], marker: 'preserved' };
    const localStorage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(original) });
    vi.stubGlobal('window', { localStorage });

    expect(setPortalTheme('light')).toBe(true);
    expect(JSON.parse(localStorage.value(STORAGE_KEY)!)).toEqual({ ...original, theme: 'light' });
  });

  it('does not overwrite a corrupt or unrelated Workspace record', () => {
    const localStorage = memoryStorage({ [STORAGE_KEY]: '{broken' });
    vi.stubGlobal('window', { localStorage });
    expect(setPortalTheme('light')).toBe(false);
    expect(localStorage.value(STORAGE_KEY)).toBe('{broken');
  });

  it('summarizes and themes each catalog project from its own storage key', () => {
    const projectA = 'elyra-project-a';
    const projectB = 'elyra-project-b';
    const storageKeyA = `elyra-core-012-workspace-v1:${projectA}`;
    const storageKeyB = `elyra-core-012-workspace-v1:${projectB}`;
    const localStorage = memoryStorage({
      [storageKeyA]: JSON.stringify({
        schemaVersion: 3, projectId: projectA, theme: 'light',
        nodes: [{ id: 'a-node' }], assets: [{ id: 'a-asset', kind: 'image' }], versions: [], jobs: [],
      }),
      [storageKeyB]: JSON.stringify({
        schemaVersion: 3, projectId: projectB, theme: 'dark',
        nodes: [], assets: [{ id: 'b-video', kind: 'video' }], versions: [{ id: 'b-version' }], jobs: [],
      }),
    });

    expect(getPortalProjectSummaries([
      { id: projectA, title: '项目 A' },
      { id: projectB, title: '项目 B' },
    ], localStorage as any)).toEqual([
      expect.objectContaining({ id: projectA, title: '项目 A', theme: 'light', objectCount: 1, imageCount: 1, videoCount: 0 }),
      expect.objectContaining({ id: projectB, title: '项目 B', theme: 'dark', objectCount: 0, imageCount: 0, videoCount: 1, versionCount: 1 }),
    ]);

    expect(setPortalTheme('light', projectB, localStorage as any)).toBe(true);
    expect(JSON.parse(localStorage.value(storageKeyB)!).theme).toBe('light');
    expect(JSON.parse(localStorage.value(storageKeyA)!).theme).toBe('light');
    expect(() => getPortalProjectSummary('../escape', 'unsafe', localStorage as any)).toThrow('PORTAL_PROJECT_ID_INVALID');
  });
});

describe('CORE-010 inspiration handoff', () => {
  it('keeps a prompt in sessionStorage only and consumes it once', () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage, sessionStorage });

    expect(savePortalDraft('  创建一个本地海报  ')).toBe(true);
    expect(localStorage.value(STORAGE_KEY)).toBeUndefined();
    expect(peekPortalDraft()).toBe('创建一个本地海报');
    expect(peekPortalDraft()).toBe('创建一个本地海报');
    expect(consumePortalDraft()).toBe('创建一个本地海报');
    expect(consumePortalDraft()).toBeUndefined();
    clearPortalDraft();
  });

  it('ships only fixed local demonstrations with no social or external fields', () => {
    expect(COMMUNITY_ITEMS.length).toBeGreaterThan(0);
    expect(new Set(COMMUNITY_ITEMS.map((item) => item.id)).size).toBe(COMMUNITY_ITEMS.length);
    for (const item of COMMUNITY_ITEMS) {
      expect(item.localDemo).toBe(true);
      expect(JSON.stringify(item)).not.toMatch(/https?:|likes|comments|followers|author|provider/i);
    }
  });
});

describe('CORE-011 versioned Home -> Workspace handoff', () => {
  const NOW = Date.parse('2026-08-15T02:00:00.000Z');

  const handoffInput = (handoffId: string) => ({
    handoffId,
    source: 'home-composer' as const,
    prompt: '  保留这一条提示词的原始空格  ',
    creationMode: 'image' as const,
    imageProviderId: 'evolink-gpt-image-2' as const,
    preset: { id: 'local-demo-product-studio', category: '产品视觉' },
  });

  it('stores an exact V1 allowlisted record for five minutes and consumes one id once', () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage, sessionStorage });

    const created = createHomeWorkspaceHandoff(handoffInput('handoff-core011-once'), NOW);
    expect(created).toMatchObject({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      action: 'prefill',
      explicitSend: true,
      videoProviderId: 'evolink-sora-2-preview',
      createdAt: '2026-08-15T02:00:00.000Z',
      expiresAt: '2026-08-15T02:05:00.000Z',
    });
    expect(created?.prompt).toBe('  保留这一条提示词的原始空格  ');
    expect(isHomeWorkspaceHandoffV1(created)).toBe(true);
    expect(saveHomeWorkspaceHandoff(created!, NOW)).toBe(true);
    expect(localStorage.value(STORAGE_KEY)).toBeUndefined();

    expect(peekHomeWorkspaceHandoff(NOW)?.handoffId).toBe('handoff-core011-once');
    expect(peekHomeWorkspaceHandoff(NOW)?.handoffId).toBe('handoff-core011-once');
    expect(consumeHomeWorkspaceHandoff('another-id', NOW)).toBeUndefined();
    expect(consumeHomeWorkspaceHandoff('handoff-core011-once', NOW)?.prompt).toBe('  保留这一条提示词的原始空格  ');
    expect(sessionStorage.value(HOME_WORKSPACE_HANDOFF_KEY)).toBeUndefined();
    expect(consumeHomeWorkspaceHandoff('handoff-core011-once', NOW)).toBeUndefined();
  });

  it('expires at the five-minute boundary and removes stale metadata', () => {
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', { sessionStorage });
    expect(saveHomeWorkspaceHandoff(handoffInput('handoff-core011-expired'), NOW)).toBe(true);
    expect(peekHomeWorkspaceHandoff(NOW + HOME_WORKSPACE_HANDOFF_TTL_MS - 1)).toBeDefined();
    expect(peekHomeWorkspaceHandoff(NOW + HOME_WORKSPACE_HANDOFF_TTL_MS)).toBeUndefined();
    expect(sessionStorage.value(HOME_WORKSPACE_HANDOFF_KEY)).toBeUndefined();
  });

  it('rejects unknown schema fields, modes and providers instead of coercing them', () => {
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', { sessionStorage });

    expect(saveHomeWorkspaceHandoff({ ...handoffInput('handoff-core011-unknown'), imageProviderId: 'future-provider' } as any, NOW)).toBe(false);
    expect(saveHomeWorkspaceHandoff({ ...handoffInput('handoff-core011-extra'), secret: 'must-not-cross' } as any, NOW)).toBe(false);

    const valid = createHomeWorkspaceHandoff(handoffInput('handoff-core011-schema'), NOW)!;
    sessionStorage.setItem(HOME_WORKSPACE_HANDOFF_KEY, JSON.stringify({ ...valid, schemaVersion: 2 }));
    expect(peekHomeWorkspaceHandoff(NOW)).toBeUndefined();
    expect(sessionStorage.value(HOME_WORKSPACE_HANDOFF_KEY)).toBeUndefined();
  });

  it('allows only current-project sanitized PNG metadata and never serializes bytes or file names', () => {
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', { sessionStorage });
    const storage = {
      locator: `indexeddb://elyra-assets/${PROJECT_ID}/blob-core011-reference` as const,
      projectId: PROJECT_ID,
      blobKey: 'blob-core011-reference',
      sha256: 'a'.repeat(64),
      bytes: 128,
      mimeType: 'image/png' as const,
      createdAt: '2026-08-15T01:59:59.000Z',
    };
    const input = {
      ...handoffInput('handoff-core011-reference'),
      stagedReference: { assetId: 'asset-local-core011', width: 640, height: 480, storage },
    };
    expect(saveHomeWorkspaceHandoff(input, NOW)).toBe(true);
    expect(sessionStorage.value(HOME_WORKSPACE_HANDOFF_KEY)).not.toMatch(/blob\"|fileName|data:image|local path/i);
    expect(peekHomeWorkspaceHandoff(NOW)?.stagedReference).toEqual(input.stagedReference);

    const unsafeStorage = { ...storage, fileName: '/Users/private/customer.png' };
    expect(saveHomeWorkspaceHandoff({
      ...handoffInput('handoff-core011-unsafe-reference'),
      stagedReference: { ...input.stagedReference, storage: unsafeStorage },
    } as any, NOW)).toBe(false);
    expect(saveHomeWorkspaceHandoff({
      ...handoffInput('handoff-core011-wrong-project'),
      stagedReference: { ...input.stagedReference, storage: { ...storage, projectId: 'another-project' } },
    } as any, NOW)).toBe(false);
  });

  it('binds a handoff and its staged Blob to one project and rejects cross-project reads without erasing it', () => {
    const projectId = 'elyra-project-catalog-b';
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', { sessionStorage });
    const storage = {
      locator: `indexeddb://elyra-assets/${projectId}/blob-reference-b` as const,
      projectId,
      blobKey: 'blob-reference-b',
      sha256: 'b'.repeat(64),
      bytes: 256,
      mimeType: 'image/png' as const,
      createdAt: '2026-08-15T01:59:59.000Z',
    };
    const input = {
      ...handoffInput('handoff-core012-project-b'),
      projectId,
      stagedReference: { assetId: 'asset-project-b', width: 640, height: 480, storage },
    };
    const created = createHomeWorkspaceHandoff(input, NOW, projectId);
    expect(created?.projectId).toBe(projectId);
    expect(isHomeWorkspaceHandoffV1(created, projectId)).toBe(true);
    expect(isHomeWorkspaceHandoffV1(created, PROJECT_ID)).toBe(false);
    expect(saveHomeWorkspaceHandoff(created!, NOW, projectId)).toBe(true);

    expect(peekHomeWorkspaceHandoff(NOW, PROJECT_ID)).toBeUndefined();
    expect(sessionStorage.value(HOME_WORKSPACE_HANDOFF_KEY)).toBeDefined();
    expect(consumeHomeWorkspaceHandoff(created!.handoffId, NOW, PROJECT_ID)).toBeUndefined();
    expect(peekHomeWorkspaceHandoff(NOW, projectId)?.handoffId).toBe(created!.handoffId);
    expect(consumeHomeWorkspaceHandoff(created!.handoffId, NOW, projectId)?.projectId).toBe(projectId);

    expect(createHomeWorkspaceHandoff({
      ...input,
      stagedReference: { ...input.stagedReference, storage: { ...storage, projectId: PROJECT_ID } },
    }, NOW, projectId)).toBeUndefined();
  });
});
