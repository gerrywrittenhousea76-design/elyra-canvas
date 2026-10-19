import { describe, expect, it } from 'vitest';
import type { Asset } from './agent';
import { deleteCanvasNodesKeepingProjectAssets, generationOutcomeOutputIds, persistWorkspaceBeforeProjectExit, reuseProjectAssetOnCanvas } from './App';
import { createBlankWorkspace, workspaceStorageKey, type Workspace } from './domain';

const storedAsset = (): Asset => ({
  id: 'asset-project-a',
  kind: 'image',
  source: 'local-upload',
  providerId: 'local-upload',
  mimeType: 'image/png',
  prompt: 'redacted',
  createdAt: '2026-08-15T00:00:00.000Z',
  metadata: { deterministic: false, width: 1200, height: 800 },
  storage: {
    locator: 'indexeddb://elyra-assets/project-a/blob-a',
    projectId: 'project-a',
    blobKey: 'blob-a',
    sha256: 'a'.repeat(64),
    bytes: 128,
    mimeType: 'image/png',
    createdAt: '2026-08-15T00:00:00.000Z',
  },
});

const workspaceWithAsset = (): Workspace => ({
  ...createBlankWorkspace(),
  assets: [storedAsset()],
  messages: [],
});

describe('CORE-012 project asset reuse', () => {
  it('reuses one Asset and Blob locator while creating a new root Canvas Object and Version', () => {
    const before = workspaceWithAsset();
    const after = reuseProjectAssetOnCanvas(before, 'asset-project-a', {
      canvasObjectId: 'canvas-reuse-1',
      versionId: 'version-reuse-1',
      createdAt: '2026-08-15T00:01:00.000Z',
    });

    expect(after).toBeDefined();
    expect(after?.assets).toEqual(before.assets);
    expect(after?.assets).toHaveLength(1);
    expect(after?.nodes).toEqual([expect.objectContaining({
      id: 'canvas-reuse-1',
      assetId: 'asset-project-a',
      versionId: 'version-reuse-1',
      status: 'ready',
    })]);
    expect(after?.nodes[0]).not.toHaveProperty('parentId');
    expect(after?.versions).toEqual([expect.objectContaining({
      id: 'version-reuse-1',
      canvasObjectId: 'canvas-reuse-1',
      status: 'ready',
    })]);
    expect(after?.versions[0]).not.toHaveProperty('parentCanvasObjectId');
    expect(after?.versions[0]).not.toHaveProperty('parentVersionId');
  });

  it('allows repeated placements without duplicating the project Asset', () => {
    const first = reuseProjectAssetOnCanvas(workspaceWithAsset(), 'asset-project-a', {
      canvasObjectId: 'canvas-reuse-1',
      versionId: 'version-reuse-1',
      createdAt: '2026-08-15T00:01:00.000Z',
    });
    const second = first && reuseProjectAssetOnCanvas(first, 'asset-project-a', {
      canvasObjectId: 'canvas-reuse-2',
      versionId: 'version-reuse-2',
      createdAt: '2026-08-15T00:02:00.000Z',
    });

    expect(second?.assets).toHaveLength(1);
    expect(second?.nodes.map((node) => node.assetId)).toEqual(['asset-project-a', 'asset-project-a']);
    expect(second?.versions).toHaveLength(2);
  });

  it('keeps Asset metadata and Blob locator when the last Canvas Object is deleted', () => {
    const reused = reuseProjectAssetOnCanvas(workspaceWithAsset(), 'asset-project-a', {
      canvasObjectId: 'canvas-reuse-1',
      versionId: 'version-reuse-1',
      createdAt: '2026-08-15T00:01:00.000Z',
    });
    if (!reused) throw new Error('fixture reuse failed');
    const deleted = deleteCanvasNodesKeepingProjectAssets(reused, ['canvas-reuse-1']);

    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.workspace.nodes).toEqual([]);
    expect(deleted.workspace.versions).toEqual([]);
    expect(deleted.workspace.assets).toEqual(reused.assets);
    expect(deleted.workspace.assets[0]?.storage?.locator).toBe('indexeddb://elyra-assets/project-a/blob-a');
  });

  it('does not preserve orphan placeholder assets on soft cancellation', () => {
    const reused = reuseProjectAssetOnCanvas(workspaceWithAsset(), 'asset-project-a', {
      canvasObjectId: 'canvas-reuse-1',
      versionId: 'version-reuse-1',
      createdAt: '2026-08-15T00:01:00.000Z',
    });
    if (!reused) throw new Error('fixture reuse failed');
    const cancelled = deleteCanvasNodesKeepingProjectAssets(reused, ['canvas-reuse-1'], 'soft-cancel');

    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.workspace.assets).toEqual([]);
    expect(cancelled.orphanedAssets.map((asset) => asset.id)).toEqual(['asset-project-a']);
  });
});

describe('CORE-012 project switch durability', () => {
  it('synchronously seals the current workspace into its own project key before unmount', () => {
    const values = new Map<string, string>();
    const workspace = workspaceWithAsset();
    persistWorkspaceBeforeProjectExit(workspace, 'project-a', {
      setItem: (key, value) => { values.set(key, value); },
    });

    const serialized = values.get(workspaceStorageKey('project-a'));
    expect(serialized).toBeDefined();
    expect(JSON.parse(serialized ?? '{}')).toMatchObject({ projectId: 'project-a' });
    expect(values.has(workspaceStorageKey('project-b'))).toBe(false);
  });

  it('fails closed when local persistence rejects the project switch seal', () => {
    const storageError = new Error('quota');
    expect(() => persistWorkspaceBeforeProjectExit(workspaceWithAsset(), 'project-a', {
      setItem: () => { throw storageError; },
    })).toThrow(storageError);
  });
});

describe('CORE-013 multi-output typed-action receipt', () => {
  it('emits one Job plus three ordered Asset/Object/Version triples', () => {
    const outputIds = generationOutcomeOutputIds({
      jobId: 'job-three',
      outputs: ['left45', 'front', 'right45'].map((slot) => ({
        assetId: `asset-${slot}`,
        nodeId: `node-${slot}`,
        versionId: `version-${slot}`,
      })),
    });

    expect(outputIds).toEqual([
      'job-three',
      'asset-left45', 'node-left45', 'version-left45',
      'asset-front', 'node-front', 'version-front',
      'asset-right45', 'node-right45', 'version-right45',
    ]);
    expect(new Set(outputIds).size).toBe(10);
  });
});
