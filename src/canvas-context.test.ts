import { describe, expect, it } from 'vitest';
import type { AgentPlan, Asset, VersionRecord } from './agent';
import {
  buildCanvasContextGraphSnapshot,
  CanvasContextError,
  computeCanvasContextSemanticSha256,
  type CanvasContextGraphSnapshot,
} from './canvas-context';
import { createBlankWorkspace, type CanvasNode, type Workspace } from './domain';

const makeNode = ({ id, ...overrides }: Partial<CanvasNode> & Pick<CanvasNode, 'id'>): CanvasNode => ({
  id,
  kind: 'generated',
  name: `PRIVATE_FILE_${id}.png`,
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  version: 1,
  prompt: 'RAW_PRIVATE_PROMPT',
  createdAt: '2026-08-06T00:00:00.000Z',
  ...overrides,
});

const makeAsset = ({ id, ...overrides }: Partial<Asset> & Pick<Asset, 'id'>): Asset => ({
  id,
  kind: 'image',
  source: 'remote-provider',
  providerId: 'evolink-gpt-image-2',
  uri: 'https://temporary.provider.example/private.png?key=SECRET',
  mimeType: 'image/png',
  prompt: 'RAW_ASSET_PROMPT',
  createdAt: '2026-08-06T00:00:00.000Z',
  metadata: { deterministic: false, width: 1024, height: 1024 },
  ...overrides,
});

const makeVideoAsset = (overrides: Record<string, unknown> = {}): Asset => ({
  id: 'asset-video',
  kind: 'video',
  source: 'remote-provider',
  providerId: 'evolink-sora-2-preview',
  mimeType: 'video/mp4',
  prompt: 'RAW_VIDEO_PROMPT',
  createdAt: '2026-08-10T00:00:00.000Z',
  metadata: { deterministic: false, width: 1280, height: 720, durationSeconds: 4 },
  ...overrides,
} as unknown as Asset);

const makeVersion = ({ id, canvasObjectId, ...overrides }: Partial<VersionRecord> & Pick<VersionRecord, 'id' | 'canvasObjectId'>): VersionRecord => ({
  id,
  canvasObjectId,
  sequence: 1,
  status: 'ready',
  createdAt: '2026-08-06T00:00:00.000Z',
  ...overrides,
});

const makeWorkspace = (): Workspace => {
  const workspace = createBlankWorkspace();
  const parentAsset = makeAsset({ id: 'asset-parent' });
  const childAsset = makeAsset({ id: 'asset-child', source: 'local-upload' });
  const parentVersion = makeVersion({ id: 'version-parent', canvasObjectId: 'object-parent' });
  const childVersion = makeVersion({
    id: 'version-child',
    canvasObjectId: 'object-child',
    parentVersionId: parentVersion.id,
    parentCanvasObjectId: 'object-parent',
    sequence: 2,
  });
  const parent = makeNode({ id: 'object-parent', assetId: parentAsset.id, versionId: parentVersion.id });
  const child = makeNode({
    id: 'object-child',
    parentId: parent.id,
    assetId: childAsset.id,
    versionId: childVersion.id,
    version: 2,
    x: 450,
    createdAt: '2026-08-06T00:01:00.000Z',
  });
  return {
    ...workspace,
    viewport: { x: -80, y: 30, scale: 0.75 },
    nodes: [parent, child],
    selectedIds: [parent.id, child.id],
    assets: [parentAsset, childAsset],
    versions: [parentVersion, childVersion],
  };
};

const expectContextError = async (promise: Promise<unknown>, code: CanvasContextError['code']) => {
  await expect(promise).rejects.toMatchObject({ name: 'CanvasContextError', code });
};

describe('CanvasContextGraphSnapshot', () => {
  it('emits canonical selection, bounded object summaries, safe assets, lineage and a semantic SHA-256', async () => {
    const snapshot = await buildCanvasContextGraphSnapshot(makeWorkspace());

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.selectedObjectIds).toEqual(['object-child', 'object-parent']);
    expect(snapshot.objects.map(({ id, zOrder }) => ({ id, zOrder }))).toEqual([
      { id: 'object-child', zOrder: 1 },
      { id: 'object-parent', zOrder: 0 },
    ]);
    expect(snapshot.objects[0]).toMatchObject({
      parentObjectId: 'object-parent',
      assetId: 'asset-child',
      versionId: 'version-child',
      bounds: { x: 450, y: 20, width: 300, height: 200 },
    });
    expect(snapshot.objects[1]).toMatchObject({
      assetId: 'asset-parent',
      versionId: 'version-parent',
      bounds: { x: 10, y: 20, width: 300, height: 200 },
    });
    expect(snapshot.assets[0]).toEqual({
      id: 'asset-child',
      kind: 'image',
      source: 'local-upload',
      providerId: 'evolink-gpt-image-2',
      mimeType: 'image/png',
      width: 1024,
      height: 1024,
      deterministic: false,
    });
    expect(snapshot.versions[0]).toMatchObject({
      id: 'version-child',
      canvasObjectId: 'object-child',
      parentVersionId: 'version-parent',
      parentCanvasObjectId: 'object-parent',
    });
    expect(snapshot.semanticSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeCanvasContextSemanticSha256(withoutDigest(snapshot))).toBe(snapshot.semanticSha256);
  });

  it('keeps the same semantic hash when only canonical Asset, Version and selection arrays are reordered', async () => {
    const left = makeWorkspace();
    const right = makeWorkspace();
    right.assets.reverse();
    right.versions.reverse();
    right.selectedIds.reverse();

    const [leftSnapshot, rightSnapshot] = await Promise.all([
      buildCanvasContextGraphSnapshot(left),
      buildCanvasContextGraphSnapshot(right),
    ]);

    expect(rightSnapshot).toEqual(leftSnapshot);
  });

  it('emits only bounded approximately-four-second MP4 metadata for a video Asset', async () => {
    const workspace = makeWorkspace();
    workspace.assets.push(makeVideoAsset({
      metadata: { deterministic: false, width: 1280, height: 720, durationSeconds: 3.75 },
      uri: 'https://temporary.provider.example/private.mp4?token=SECRET',
      storage: {
        locator: 'indexeddb://elyra-assets/private/video',
        projectId: 'private',
        blobKey: 'video',
        sha256: 'a'.repeat(64),
        bytes: 128,
        mimeType: 'video/mp4',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
    }));

    const snapshot = await buildCanvasContextGraphSnapshot(workspace);
    expect(snapshot.assets.find((asset) => asset.id === 'asset-video')).toEqual({
      id: 'asset-video',
      kind: 'video',
      source: 'remote-provider',
      providerId: 'evolink-sora-2-preview',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 3.75,
      deterministic: false,
    });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['temporary.provider.example', 'indexeddb:', 'RAW_VIDEO_PROMPT', 'SECRET']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('accepts only the approved 3.5–4.5 second physical duration window', async () => {
    for (const durationSeconds of [3.5, 3.75, 4, 4.5]) {
      const accepted = makeWorkspace();
      accepted.assets.push(makeVideoAsset({
        metadata: { deterministic: false, width: 1280, height: 720, durationSeconds },
      }));
      await expect(buildCanvasContextGraphSnapshot(accepted)).resolves.toMatchObject({
        assets: expect.arrayContaining([expect.objectContaining({ durationSeconds })]),
      });
    }

    for (const durationSeconds of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 3.499, 4.501, 8]) {
      const rejected = makeWorkspace();
      rejected.assets.push(makeVideoAsset({
        metadata: { deterministic: false, width: 1280, height: 720, ...(durationSeconds === undefined ? {} : { durationSeconds }) },
      }));
      await expectContextError(buildCanvasContextGraphSnapshot(rejected), 'CANVAS_CONTEXT_INVALID_ASSET');
    }
  });

  it('fails closed for a video Asset with the wrong MIME type', async () => {
    const wrongMime = makeWorkspace();
    wrongMime.assets.push(makeVideoAsset({ mimeType: 'image/png' }));
    await expectContextError(buildCanvasContextGraphSnapshot(wrongMime), 'CANVAS_CONTEXT_INVALID_ASSET');
  });

  it('keeps true creation-based z-order and semantic hash stable when only the input node array is reordered', async () => {
    const lowerParent = makeWorkspace();
    const lowerChild = makeWorkspace();
    lowerChild.nodes.reverse();

    const [parentFirst, childFirst] = await Promise.all([
      buildCanvasContextGraphSnapshot(lowerParent),
      buildCanvasContextGraphSnapshot(lowerChild),
    ]);

    expect(parentFirst.objects.map(({ id, zOrder }) => ({ id, zOrder }))).toEqual([
      { id: 'object-child', zOrder: 1 },
      { id: 'object-parent', zOrder: 0 },
    ]);
    expect(childFirst).toEqual(parentFirst);
  });

  it('uses a strict allowlist that excludes prompts, URIs, Blob/storage locators, evidence and keys', async () => {
    const workspace = makeWorkspace() as Workspace & Record<string, unknown>;
    workspace.plannerEvidence = [{ authorization: 'Bearer SECRET' } as never];
    workspace.apiKey = 'SECRET';
    workspace.assets[0].storage = {
      locator: 'indexeddb://elyra-assets/private/blob',
      projectId: 'private',
      blobKey: 'private-file.png',
      sha256: 'a'.repeat(64),
      bytes: 99,
      mimeType: 'image/png',
      createdAt: '2026-08-06T00:00:00.000Z',
    };

    const serialized = JSON.stringify(await buildCanvasContextGraphSnapshot(workspace));
    for (const forbidden of ['RAW_PRIVATE_PROMPT', 'RAW_ASSET_PROMPT', 'temporary.provider', 'indexeddb:', 'private-file', 'Bearer SECRET', 'apiKey', 'SECRET']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(collectKeys(JSON.parse(serialized))).not.toEqual(expect.arrayContaining([
      'uri', 'blob', 'storage', 'locator', 'prompt', 'plannerEvidence', 'apiKey', 'authorization',
    ]));
  });

  it('fails closed for a dangling selected object', async () => {
    const workspace = makeWorkspace();
    workspace.selectedIds.push('object-missing');
    await expectContextError(buildCanvasContextGraphSnapshot(workspace), 'CANVAS_CONTEXT_DANGLING_SELECTION');
  });

  it('fails closed for dangling object, Asset and Version references', async () => {
    const missingParent = makeWorkspace();
    missingParent.nodes[1].parentId = 'object-missing';
    await expectContextError(buildCanvasContextGraphSnapshot(missingParent), 'CANVAS_CONTEXT_DANGLING_OBJECT');

    const missingAsset = makeWorkspace();
    missingAsset.nodes[0].assetId = 'asset-missing';
    await expectContextError(buildCanvasContextGraphSnapshot(missingAsset), 'CANVAS_CONTEXT_DANGLING_ASSET');

    const missingVersion = makeWorkspace();
    missingVersion.nodes[0].versionId = 'version-missing';
    await expectContextError(buildCanvasContextGraphSnapshot(missingVersion), 'CANVAS_CONTEXT_DANGLING_VERSION');
  });

  it('fails closed for incomplete, mismatched or cyclic Version lineage', async () => {
    const incomplete = makeWorkspace();
    incomplete.versions[0].parentVersionId = 'version-child';
    await expectContextError(buildCanvasContextGraphSnapshot(incomplete), 'CANVAS_CONTEXT_LINEAGE_MISMATCH');

    const mismatch = makeWorkspace();
    mismatch.versions[1].parentCanvasObjectId = 'object-child';
    await expectContextError(buildCanvasContextGraphSnapshot(mismatch), 'CANVAS_CONTEXT_LINEAGE_MISMATCH');

    const missingVersionParent = makeWorkspace();
    delete missingVersionParent.versions[1].parentVersionId;
    delete missingVersionParent.versions[1].parentCanvasObjectId;
    await expectContextError(buildCanvasContextGraphSnapshot(missingVersionParent), 'CANVAS_CONTEXT_LINEAGE_MISMATCH');

    const wrongSequence = makeWorkspace();
    wrongSequence.versions[1].sequence = 9;
    wrongSequence.nodes[1].version = 9;
    await expectContextError(buildCanvasContextGraphSnapshot(wrongSequence), 'CANVAS_CONTEXT_LINEAGE_MISMATCH');

    const nodeVersionMismatch = makeWorkspace();
    nodeVersionMismatch.nodes[1].version = 7;
    await expectContextError(buildCanvasContextGraphSnapshot(nodeVersionMismatch), 'CANVAS_CONTEXT_LINEAGE_MISMATCH');

    const cycle = makeWorkspace();
    cycle.nodes[0].parentId = 'object-child';
    await expectContextError(buildCanvasContextGraphSnapshot(cycle), 'CANVAS_CONTEXT_LINEAGE_CYCLE');
  });

  it.each([
    { field: 'x', value: Number.NaN },
    { field: 'y', value: Number.POSITIVE_INFINITY },
    { field: 'width', value: 0 },
    { field: 'height', value: -1 },
  ] as const)('fails closed for invalid bounds: $field=$value', async ({ field, value }) => {
    const workspace = makeWorkspace();
    workspace.nodes[0][field] = value;
    await expectContextError(buildCanvasContextGraphSnapshot(workspace), 'CANVAS_CONTEXT_INVALID_BOUNDS');
  });

  it('fails closed for an invalid viewport', async () => {
    const workspace = makeWorkspace();
    workspace.viewport.scale = 0;
    await expectContextError(buildCanvasContextGraphSnapshot(workspace), 'CANVAS_CONTEXT_INVALID_VIEWPORT');
  });

  it('fails closed when an input or requested limit exceeds the bounded policy', async () => {
    const workspace = makeWorkspace();
    await expectContextError(buildCanvasContextGraphSnapshot(workspace, { maxObjects: 1 }), 'CANVAS_CONTEXT_LIMIT_EXCEEDED');
    await expectContextError(buildCanvasContextGraphSnapshot(workspace, { maxObjects: 101 }), 'CANVAS_CONTEXT_INVALID_LIMIT');
  });

  it('fails closed when the independent Asset limit is exceeded', async () => {
    const workspace = makeWorkspace();
    await expectContextError(
      buildCanvasContextGraphSnapshot(workspace, { maxAssets: 1 }),
      'CANVAS_CONTEXT_LIMIT_EXCEEDED',
    );
  });

  it('fails closed when the independent Version limit is exceeded', async () => {
    const workspace = makeWorkspace();
    await expectContextError(
      buildCanvasContextGraphSnapshot(workspace, { maxVersions: 1 }),
      'CANVAS_CONTEXT_LIMIT_EXCEEDED',
    );
  });

  it('changes its semantic hash for a real viewport or object delta without mutating the workspace', async () => {
    const workspace = makeWorkspace();
    const before = JSON.stringify(workspace);
    const first = await buildCanvasContextGraphSnapshot(workspace);
    workspace.viewport.x += 1;
    const second = await buildCanvasContextGraphSnapshot(workspace);

    expect(second.semanticSha256).not.toBe(first.semanticSha256);
    workspace.viewport.x -= 1;
    expect(JSON.stringify(workspace)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.objects)).toBe(true);
  });

  it('includes only a bounded current Plan summary and the last verified delta hash', async () => {
    const workspace = makeWorkspace();
    const plan = {
      id: 'plan-current',
      intentId: 'intent-private',
      providerId: 'evolink-gpt-image-2',
      status: 'proposed' as const,
      operation: 'image_generate' as const,
      source: 'remote-agent' as const,
      summary: 'PRIVATE_PLAN_SUMMARY',
      bullets: ['PRIVATE_PLAN_STEP'],
      constraints: ['PRIVATE_PLAN_CONSTRAINT'],
      visualDirection: { subject: 'private', style: 'private', lighting: 'private', composition: 'private' },
      shouldFail: false,
      createdAt: '2026-08-06T00:00:00.000Z',
    };
    const delta = 'd'.repeat(64);
    const snapshot = await buildCanvasContextGraphSnapshot(workspace, { currentPlan: plan, lastVerifiedDeltaSha256: delta });
    expect(snapshot.currentPlan).toEqual({
      id: 'plan-current',
      operation: 'image_generate',
      source: 'remote-agent',
      status: 'proposed',
      providerId: 'evolink-gpt-image-2',
    });
    expect(snapshot.lastVerifiedDeltaSha256).toBe(delta);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['PRIVATE_PLAN_SUMMARY', 'PRIVATE_PLAN_STEP', 'PRIVATE_PLAN_CONSTRAINT', 'intent-private']) expect(serialized).not.toContain(forbidden);
    await expectContextError(buildCanvasContextGraphSnapshot(workspace, { currentPlan: { ...plan, status: 'invalid' as never } }), 'CANVAS_CONTEXT_INVALID_PLAN');
    await expectContextError(buildCanvasContextGraphSnapshot(workspace, { lastVerifiedDeltaSha256: 'not-a-sha' }), 'CANVAS_CONTEXT_INVALID_DELTA');
  });

  it('accepts the fixed CORE-009 image-to-video Plan operation in the bounded summary', async () => {
    const workspace = makeWorkspace();
    const plan = {
      id: 'plan-video',
      intentId: 'intent-video',
      providerId: 'evolink-sora-2-preview',
      status: 'approved',
      operation: 'video_image_to_video',
      source: 'remote-agent',
      summary: 'private',
      bullets: [],
      constraints: [],
      visualDirection: { subject: 'private', style: 'private', lighting: 'private', composition: 'private' },
      shouldFail: false,
      createdAt: '2026-08-10T00:00:00.000Z',
    } as unknown as AgentPlan;

    expect((await buildCanvasContextGraphSnapshot(workspace, { currentPlan: plan })).currentPlan).toEqual({
      id: 'plan-video',
      operation: 'video_image_to_video',
      source: 'remote-agent',
      status: 'approved',
      providerId: 'evolink-sora-2-preview',
    });
  });
});

const withoutDigest = ({ semanticSha256: _digest, ...payload }: CanvasContextGraphSnapshot) => payload;

const collectKeys = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
};
