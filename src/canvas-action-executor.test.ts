import { describe, expect, it, vi } from 'vitest';
import type { GenerationJob, VersionRecord } from './agent';
import { createCanvasActionExecutor } from './canvas-action-executor';
import { createBlankWorkspace, type CanvasNode, type Workspace } from './domain';

const workspaceFixture = (): Workspace => {
  const parent: CanvasNode = { id: 'object-parent', kind: 'reference', name: 'parent', x: 100, y: 100, width: 200, height: 160, status: 'ready', version: 0, prompt: '', createdAt: '2026-08-06T00:00:00.000Z', versionId: 'version-parent' };
  const child: CanvasNode = { id: 'object-child', kind: 'generated', name: 'child', x: 500, y: 220, width: 200, height: 160, status: 'generating', version: 1, prompt: '', createdAt: '2026-08-06T00:00:01.000Z', jobId: 'job-child' };
  const parentVersion: VersionRecord = { id: 'version-parent', canvasObjectId: parent.id, sequence: 0, status: 'ready', createdAt: parent.createdAt };
  const job: GenerationJob = { id: 'job-child', intentId: 'intent-1', planId: 'plan-1', providerId: 'deterministic-mock', operation: 'edit', targetCanvasObjectId: parent.id, status: 'running', attempt: 1, createdAt: child.createdAt, updatedAt: child.createdAt };
  return { ...createBlankWorkspace(), nodes: [parent, child], versions: [parentVersion], jobs: [job] };
};

const runtimeInput = (action: any, key = 'run:step:action:attempt-1') => ({ runId: 'run-1', stepId: 'step-1', idempotencyKey: key, action, signal: new AbortController().signal });

describe('CORE-008 canvas typed-action executor', () => {
  it('selects and focuses known objects with explicit semantic deltas', async () => {
    let workspace = workspaceFixture();
    const write = vi.fn((next: Workspace) => { workspace = next; });
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: vi.fn() });
    const selected = await executor.executeOnce(runtimeInput({ type: 'select_objects', actionId: 'select-1', objectIds: ['object-child', 'object-parent'] }));
    expect(selected).toMatchObject({ ok: true, changed: true, outputIds: ['object-child', 'object-parent'] });
    expect(workspace.selectedIds).toEqual(['object-child', 'object-parent']);
    const focused = await executor.executeOnce(runtimeInput({ type: 'focus_objects', actionId: 'focus-1', objectIds: ['object-child'] }, 'focus-key'));
    expect(focused).toMatchObject({ ok: true, changed: true });
    expect(workspace.viewport).not.toEqual({ x: 0, y: 0, scale: 1 });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('creates one non-destructive child Version and preserves the parent', async () => {
    let workspace = workspaceFixture();
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: (next) => { workspace = next; }, createImageJob: vi.fn(), now: () => '2026-08-06T00:00:02.000Z' });
    const receipt = await executor.executeOnce(runtimeInput({ type: 'create_version', actionId: 'version-action', parentCanvasObjectId: 'object-parent', parentVersionId: 'version-parent', jobId: 'job-child' }));
    expect(receipt).toMatchObject({ ok: true, changed: true, outputIds: ['object-child'] });
    expect(workspace.versions).toHaveLength(2);
    expect(workspace.versions[0]).toMatchObject({ id: 'version-parent', canvasObjectId: 'object-parent' });
    expect(workspace.versions[1]).toMatchObject({ id: 'version-action:version', parentVersionId: 'version-parent', parentCanvasObjectId: 'object-parent', canvasObjectId: 'object-child' });
  });

  it('creates three sibling Versions atomically for one multi-output Job', async () => {
    let workspace = workspaceFixture();
    workspace.nodes.push(
      { ...workspace.nodes[1], id: 'object-front', x: 720 },
      { ...workspace.nodes[1], id: 'object-right45', x: 940 },
    );
    const write = vi.fn((next: Workspace) => { workspace = next; });
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: vi.fn(), now: () => '2026-08-21T00:00:02.000Z' });
    const input = runtimeInput({ type: 'create_version', actionId: 'multi-version', parentCanvasObjectId: 'object-parent', parentVersionId: 'version-parent', jobId: 'job-child' }, 'multi-version-key');

    const first = await executor.executeOnce(input);
    const second = await executor.executeOnce(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, changed: true, outputIds: ['object-child', 'object-front', 'object-right45'] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(workspace.versions.filter((version) => version.jobId === 'job-child')).toHaveLength(3);
    expect(workspace.versions.filter((version) => version.jobId === 'job-child')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'multi-version:version:object-child', canvasObjectId: 'object-child', parentVersionId: 'version-parent', parentCanvasObjectId: 'object-parent', sequence: 1 }),
      expect.objectContaining({ id: 'multi-version:version:object-front', canvasObjectId: 'object-front', parentVersionId: 'version-parent', parentCanvasObjectId: 'object-parent', sequence: 1 }),
      expect.objectContaining({ id: 'multi-version:version:object-right45', canvasObjectId: 'object-right45', parentVersionId: 'version-parent', parentCanvasObjectId: 'object-parent', sequence: 1 }),
    ]));
  });

  it('creates none of three sibling Versions when any lineage is invalid', async () => {
    const workspace = workspaceFixture();
    workspace.nodes.push(
      { ...workspace.nodes[1], id: 'object-front', x: 720 },
      { ...workspace.nodes[1], id: 'object-right45', x: 940, version: 99 },
    );
    const before = JSON.stringify(workspace);
    const write = vi.fn();
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: vi.fn() });

    const result = await executor.executeOnce(runtimeInput({ type: 'create_version', actionId: 'multi-invalid', parentCanvasObjectId: 'object-parent', parentVersionId: 'version-parent', jobId: 'job-child' }, 'multi-invalid-key'));

    expect(result).toMatchObject({ ok: false, errorCode: 'VERSION_LINEAGE_CONFLICT' });
    expect(JSON.stringify(workspace)).toBe(before);
    expect(write).not.toHaveBeenCalled();
  });

  it('fails atomically for missing objects or conflicting lineage', async () => {
    const workspace = workspaceFixture();
    const before = JSON.stringify(workspace);
    const write = vi.fn();
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: vi.fn() });
    expect(await executor.executeOnce(runtimeInput({ type: 'select_objects', actionId: 'select-missing', objectIds: ['object-missing'] }))).toMatchObject({ ok: false, errorCode: 'CANVAS_OBJECT_NOT_FOUND' });
    expect(JSON.stringify(workspace)).toBe(before);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects generate Jobs, wrong edit targets and pre-existing conflicting child lineage', async () => {
    const action = { type: 'create_version' as const, actionId: 'version-action', parentCanvasObjectId: 'object-parent', parentVersionId: 'version-parent', jobId: 'job-child' };

    const cases: Array<{ mutate(workspace: Workspace): void; errorCode: string }> = [
      { mutate(workspace) { workspace.jobs[0].operation = 'generate'; workspace.jobs[0].targetCanvasObjectId = undefined; }, errorCode: 'VERSION_JOB_BINDING_INVALID' },
      { mutate(workspace) { workspace.jobs[0].targetCanvasObjectId = 'object-other'; }, errorCode: 'VERSION_JOB_BINDING_INVALID' },
      { mutate(workspace) { workspace.nodes[1].version = 99; }, errorCode: 'VERSION_LINEAGE_CONFLICT' },
    ];
    for (const [index, { mutate, errorCode }] of cases.entries()) {
      const workspace = workspaceFixture();
      mutate(workspace);
      const before = JSON.stringify(workspace);
      const write = vi.fn();
      const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: vi.fn() });
      const receipt = await executor.executeOnce(runtimeInput(action, `lineage-${index}`));
      expect(receipt).toMatchObject({ ok: false, errorCode });
      expect(JSON.stringify(workspace)).toBe(before);
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('deduplicates paid action execution by the runtime idempotency key', async () => {
    let workspace = workspaceFixture();
    const paid = vi.fn(async () => ({ ok: true as const, changed: true, summary: 'Job 已创建。', outputIds: ['job-real-1'], costUsd: 1 }));
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: (next) => { workspace = next; }, createImageJob: paid });
    const action = { type: 'create_image_job' as const, actionId: 'paid-1', intentId: 'intent-1', planId: 'plan-1', operation: 'image_generate' as const, paid: true, estimatedCostUsd: 1 };
    const first = await executor.executeOnce(runtimeInput(action));
    const second = await executor.executeOnce(runtimeInput(action));
    expect(first).toEqual(second);
    expect(paid).toHaveBeenCalledTimes(1);
  });

  it('fails closed when cancelled before any mutation or paid callback', async () => {
    const workspace = workspaceFixture();
    const paid = vi.fn();
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: vi.fn(), createImageJob: paid });
    const controller = new AbortController();
    controller.abort();
    const result = await executor.executeOnce({ ...runtimeInput({ type: 'create_image_job', actionId: 'paid-1', intentId: 'intent-1', planId: 'plan-1', operation: 'image_generate', paid: true, estimatedCostUsd: 1 }), signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'ACTION_ABORTED' });
    expect(paid).not.toHaveBeenCalled();
  });

  it('validates and deduplicates one strongly-bound video Job callback', async () => {
    let workspace = workspaceFixture();
    workspace.nodes[0].assetId = 'asset-source';
    workspace.assets = [{ id: 'asset-source', kind: 'image', source: 'remote-provider', providerId: 'evolink-gpt-image-2', mimeType: 'image/png', prompt: 'source', createdAt: workspace.nodes[0].createdAt, metadata: { deterministic: false, width: 1024, height: 1024 } }];
    const createVideoJob = vi.fn(async () => ({ ok: true as const, changed: true, summary: '视频 Job 已创建。', outputIds: ['job-video'], costUsd: 1 }));
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: (next) => { workspace = next; }, createImageJob: vi.fn(), createVideoJob });
    const action = { type: 'create_video_job' as const, actionId: 'video-action', intentId: 'intent-video', planId: 'plan-video', operation: 'video_image_to_video' as const, sourceCanvasObjectId: 'object-parent', sourceVersionId: 'version-parent', sourceAssetId: 'asset-source', paid: true, estimatedCostUsd: 1 };
    const first = await executor.executeOnce(runtimeInput(action, 'video-key'));
    const second = await executor.executeOnce(runtimeInput(action, 'video-key'));
    expect(first).toEqual(second);
    expect(createVideoJob).toHaveBeenCalledTimes(1);

    workspace.nodes[0].versionId = 'version-replaced';
    expect(await executor.executeOnce(runtimeInput(action, 'video-stale'))).toMatchObject({ ok: false, errorCode: 'CORE009_VIDEO_SOURCE_BINDING_STALE' });
    expect(createVideoJob).toHaveBeenCalledTimes(1);
  });

  it('allows a video Job to create a non-destructive child Version', async () => {
    let workspace = workspaceFixture();
    workspace.jobs[0].operation = 'video';
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: (next) => { workspace = next; }, createImageJob: vi.fn(), now: () => '2026-08-06T00:00:02.000Z' });
    const result = await executor.executeOnce(runtimeInput({ type: 'create_version', actionId: 'video-version', parentCanvasObjectId: 'object-parent', parentVersionId: 'version-parent', jobId: 'job-child' }, 'video-version-key'));
    expect(result).toMatchObject({ ok: true, changed: true, outputIds: ['object-child'] });
    expect(workspace.versions.at(-1)).toMatchObject({ parentCanvasObjectId: 'object-parent', parentVersionId: 'version-parent', canvasObjectId: 'object-child' });
  });
});
