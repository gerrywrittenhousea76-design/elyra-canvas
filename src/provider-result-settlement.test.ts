import { describe, expect, it } from 'vitest';
import type {
  Asset,
  GenerationJob,
  ProviderMediaOutput,
  ProviderOutputSet,
  ProviderOutputSlot,
  ProviderRunResult,
} from './agent';
import { createBlankWorkspace, type CanvasNode, type Workspace } from './domain';
import { buildProviderResultSettlement, validateProviderRunSuccess } from './provider-result-settlement';

const AT = '2026-08-21T02:30:00.000Z';
const PROJECT_ID = 'core013-test-project';

const makeJob = (): GenerationJob => ({
  id: 'job-core013',
  intentId: 'intent-core013',
  planId: 'plan-core013',
  providerId: 'deterministic-mock',
  operation: 'generate',
  status: 'running',
  attempt: 1,
  createdAt: AT,
  updatedAt: AT,
});

const makeWorkspace = (): Workspace => {
  const workspace = createBlankWorkspace();
  const parent: CanvasNode = {
    id: 'parent',
    kind: 'reference',
    name: '参考图',
    x: 100,
    y: 100,
    width: 200,
    height: 200,
    status: 'ready',
    version: 0,
    prompt: '参考',
    createdAt: AT,
    versionId: 'version-parent',
  };
  const placeholder: CanvasNode = {
    id: 'placeholder',
    kind: 'generated',
    name: 'v1 · 生成版本',
    x: 360,
    y: 100,
    width: 390,
    height: 390,
    status: 'generating',
    parentId: parent.id,
    version: 1,
    prompt: '生成三视图',
    createdAt: AT,
    jobId: 'job-core013',
    versionId: 'version-placeholder',
  };
  return {
    ...workspace,
    nodes: [parent, placeholder],
    jobs: [makeJob()],
    versions: [
      { id: 'version-parent', canvasObjectId: parent.id, sequence: 0, status: 'ready', createdAt: AT },
      {
        id: 'version-placeholder',
        canvasObjectId: placeholder.id,
        parentCanvasObjectId: parent.id,
        parentVersionId: 'version-parent',
        jobId: 'job-core013',
        sequence: 1,
        status: 'pending',
        createdAt: AT,
      },
    ],
  };
};

const makeOutput = <Slot extends ProviderOutputSlot>(
  slot: Slot,
  index: number,
): ProviderMediaOutput<Slot> => {
  const blob = new Blob([`core013-${slot}`], { type: 'image/png' });
  return {
    slot,
    blob,
    asset: {
      id: `asset-${slot}`,
      kind: 'image',
      source: 'deterministic-mock',
      providerId: 'deterministic-mock',
      jobId: 'job-core013',
      mimeType: 'image/png',
      prompt: '生成三视图',
      createdAt: AT,
      metadata: { deterministic: true, width: 640, height: 640, outputSlot: slot },
      storage: {
        locator: `indexeddb://elyra-assets/${PROJECT_ID}/blob-${slot}`,
        projectId: PROJECT_ID,
        blobKey: `blob-${slot}`,
        sha256: String(index + 1).repeat(64),
        bytes: blob.size,
        mimeType: 'image/png',
        createdAt: AT,
      },
    },
  };
};

const makeOutputSet = (): ProviderOutputSet => [
  makeOutput('left45', 0),
  makeOutput('front', 1),
  makeOutput('right45', 2),
];

describe('CORE-013 Provider result settlement', () => {
  it('preserves the legacy single-result contract and reuses its placeholder lineage', () => {
    const workspace = makeWorkspace();
    const asset: Asset = {
      id: 'asset-single',
      kind: 'image',
      source: 'deterministic-mock',
      providerId: 'deterministic-mock',
      jobId: 'job-core013',
      uri: '/assets/elyra-speaker.png',
      mimeType: 'image/png',
      prompt: '单图结果',
      createdAt: AT,
      metadata: { deterministic: true, width: 640, height: 640 },
    };
    const result: ProviderRunResult = { ok: true, asset };

    const settled = buildProviderResultSettlement({
      workspace,
      projectId: PROJECT_ID,
      jobId: 'job-core013',
      placeholderNodeId: 'placeholder',
      result,
      settledAt: AT,
    });

    expect(settled).toMatchObject({
      ok: true,
      kind: 'single',
      outputIds: {
        nodeIds: ['placeholder'],
        versionIds: ['version-placeholder'],
        assetIds: ['asset-single'],
      },
    });
    if (!settled.ok) throw new Error(settled.code);
    expect(settled.workspace.nodes).toHaveLength(2);
    expect(settled.workspace.nodes[1]).toMatchObject({ id: 'placeholder', status: 'ready', assetId: 'asset-single' });
    expect(settled.workspace.jobs[0]).toMatchObject({ status: 'succeeded', progress: 1 });
    expect(settled.workspace.versions[1]).toMatchObject({ id: 'version-placeholder', status: 'ready' });
  });

  it('settles exactly three ordered outputs as stable sibling Canvas Objects and Versions', () => {
    const workspace = makeWorkspace();
    const before = JSON.stringify(workspace);
    const result: ProviderRunResult = { ok: true, outputs: makeOutputSet() };

    const settled = buildProviderResultSettlement({
      workspace,
      projectId: PROJECT_ID,
      jobId: 'job-core013',
      placeholderNodeId: 'placeholder',
      result,
      settledAt: AT,
    });

    expect(JSON.stringify(workspace)).toBe(before);
    expect(settled).toMatchObject({
      ok: true,
      kind: 'set',
      outputIds: {
        nodeIds: [
          'placeholder',
          'core013-output-node-job-core013-front',
          'core013-output-node-job-core013-right45',
        ],
        versionIds: [
          'version-placeholder',
          'core013-output-version-job-core013-front',
          'core013-output-version-job-core013-right45',
        ],
        assetIds: ['asset-left45', 'asset-front', 'asset-right45'],
      },
    });
    if (!settled.ok) throw new Error(settled.code);
    const outputs = settled.workspace.nodes.filter((node) => node.jobId === 'job-core013');
    expect(outputs).toHaveLength(3);
    expect(outputs.map((node) => node.parentId)).toEqual(['parent', 'parent', 'parent']);
    expect(outputs.map((node) => node.assetId)).toEqual(['asset-left45', 'asset-front', 'asset-right45']);
    expect(new Set(outputs.map((node) => node.id)).size).toBe(3);
    const versions = settled.workspace.versions.filter((version) => version.jobId === 'job-core013');
    expect(versions).toHaveLength(3);
    expect(versions.map((version) => ({ parentCanvasObjectId: version.parentCanvasObjectId, parentVersionId: version.parentVersionId, sequence: version.sequence }))).toEqual([
      { parentCanvasObjectId: 'parent', parentVersionId: 'version-parent', sequence: 1 },
      { parentCanvasObjectId: 'parent', parentVersionId: 'version-parent', sequence: 1 },
      { parentCanvasObjectId: 'parent', parentVersionId: 'version-parent', sequence: 1 },
    ]);
    expect(settled.workspace.selectedIds).toEqual(settled.outputIds.nodeIds);
    expect(settled.workspace.assets.map((asset) => asset.metadata.outputSlot)).toEqual(['left45', 'front', 'right45']);
  });

  it('rejects a reordered slot set before any Workspace mutation', () => {
    const workspace = makeWorkspace();
    const before = JSON.stringify(workspace);
    const outputs = makeOutputSet();
    const malformed = [outputs[1], outputs[0], outputs[2]] as unknown as ProviderOutputSet;
    const result: ProviderRunResult = { ok: true, outputs: malformed };

    expect(validateProviderRunSuccess(result, workspace.jobs[0])).toEqual({ ok: false, code: 'CORE013_OUTPUT_SLOT_INVALID' });
    expect(buildProviderResultSettlement({ workspace, projectId: PROJECT_ID, jobId: 'job-core013', placeholderNodeId: 'placeholder', result, settledAt: AT })).toEqual({
      ok: false,
      code: 'CORE013_OUTPUT_SLOT_INVALID',
    });
    expect(JSON.stringify(workspace)).toBe(before);
  });

  it('rejects a partial or empty Blob set and never creates partial siblings', () => {
    const workspace = makeWorkspace();
    const outputs = makeOutputSet();
    const malformed = [
      outputs[0],
      { ...outputs[1], blob: new Blob([], { type: 'image/png' }) },
      outputs[2],
    ] as ProviderOutputSet;
    const result: ProviderRunResult = { ok: true, outputs: malformed };

    expect(buildProviderResultSettlement({ workspace, projectId: PROJECT_ID, jobId: 'job-core013', placeholderNodeId: 'placeholder', result, settledAt: AT })).toEqual({
      ok: false,
      code: 'CORE013_OUTPUT_BLOB_INVALID',
    });
    expect(workspace.nodes.filter((node) => node.jobId === 'job-core013')).toHaveLength(1);
  });

  it('requires all three Blob storage receipts before producing a candidate', () => {
    const workspace = makeWorkspace();
    const outputs = makeOutputSet();
    const withoutStorage = [
      outputs[0],
      { ...outputs[1], asset: { ...outputs[1].asset, storage: undefined } },
      outputs[2],
    ] as ProviderOutputSet;
    const result: ProviderRunResult = { ok: true, outputs: withoutStorage };

    expect(buildProviderResultSettlement({ workspace, projectId: PROJECT_ID, jobId: 'job-core013', placeholderNodeId: 'placeholder', result, settledAt: AT })).toEqual({
      ok: false,
      code: 'CORE013_OUTPUT_STORAGE_INVALID',
    });
    expect(workspace.assets).toEqual([]);
    expect(workspace.nodes.filter((node) => node.jobId === 'job-core013')).toHaveLength(1);
  });

  it('fails closed when a stable sibling ID already belongs to another object', () => {
    const workspace = makeWorkspace();
    workspace.nodes.push({
      ...workspace.nodes[1],
      id: 'core013-output-node-job-core013-front',
      jobId: undefined,
      versionId: 'unrelated-version',
      status: 'ready',
    });
    const result: ProviderRunResult = { ok: true, outputs: makeOutputSet() };

    expect(buildProviderResultSettlement({ workspace, projectId: PROJECT_ID, jobId: 'job-core013', placeholderNodeId: 'placeholder', result, settledAt: AT })).toEqual({
      ok: false,
      code: 'CORE013_SETTLEMENT_ID_CONFLICT',
    });
  });

  it('rejects duplicate IDs and mismatched Job, Provider, outputSlot or MIME before settlement', () => {
    const cases: Array<{ mutate(outputs: ProviderOutputSet): ProviderOutputSet; code: string }> = [
      {
        mutate(outputs) {
          return [outputs[0], { ...outputs[1], asset: { ...outputs[1].asset, id: outputs[0].asset.id } }, outputs[2]];
        },
        code: 'CORE013_OUTPUT_ASSET_ID_DUPLICATE',
      },
      {
        mutate(outputs) {
          return [outputs[0], { ...outputs[1], asset: { ...outputs[1].asset, jobId: 'job-other' } }, outputs[2]];
        },
        code: 'CORE013_OUTPUT_ASSET_INVALID',
      },
      {
        mutate(outputs) {
          return [outputs[0], { ...outputs[1], asset: { ...outputs[1].asset, providerId: 'provider-other' } }, outputs[2]];
        },
        code: 'CORE013_OUTPUT_ASSET_INVALID',
      },
      {
        mutate(outputs) {
          return [outputs[0], { ...outputs[1], asset: { ...outputs[1].asset, metadata: { ...outputs[1].asset.metadata, outputSlot: 'left45' } } } as ProviderMediaOutput<'front'>, outputs[2]];
        },
        code: 'CORE013_OUTPUT_ASSET_INVALID',
      },
      {
        mutate(outputs) {
          return [outputs[0], { ...outputs[1], blob: new Blob(['jpeg bytes'], { type: 'image/jpeg' }) } as ProviderMediaOutput<'front'>, outputs[2]];
        },
        code: 'CORE013_OUTPUT_BLOB_INVALID',
      },
    ];

    for (const { mutate, code } of cases) {
      const workspace = makeWorkspace();
      const before = JSON.stringify(workspace);
      const result: ProviderRunResult = { ok: true, outputs: mutate(makeOutputSet()) };
      expect(buildProviderResultSettlement({ workspace, projectId: PROJECT_ID, jobId: 'job-core013', placeholderNodeId: 'placeholder', result, settledAt: AT })).toEqual({ ok: false, code });
      expect(JSON.stringify(workspace)).toBe(before);
    }
  });

  it('treats a repeated settlement as a no-op failure with no duplicate records', () => {
    const result: ProviderRunResult = { ok: true, outputs: makeOutputSet() };
    const first = buildProviderResultSettlement({ workspace: makeWorkspace(), projectId: PROJECT_ID, jobId: 'job-core013', placeholderNodeId: 'placeholder', result, settledAt: AT });
    if (!first.ok) throw new Error(first.code);
    const beforeReplay = JSON.stringify(first.workspace);

    expect(buildProviderResultSettlement({ workspace: first.workspace, projectId: PROJECT_ID, jobId: 'job-core013', placeholderNodeId: 'placeholder', result, settledAt: AT })).toEqual({
      ok: false,
      code: 'CORE013_JOB_NOT_SETTLEABLE',
    });
    expect(JSON.stringify(first.workspace)).toBe(beforeReplay);
    expect(first.workspace.assets).toHaveLength(3);
    expect(first.workspace.nodes.filter((node) => node.jobId === 'job-core013')).toHaveLength(3);
    expect(first.workspace.versions.filter((version) => version.jobId === 'job-core013')).toHaveLength(3);
  });
});
