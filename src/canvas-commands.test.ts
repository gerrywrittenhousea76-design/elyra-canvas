import { describe, expect, it, vi } from 'vitest';
import { createBlankWorkspace, makeReferenceNode, makeReferenceVersion, serializeWorkspace, readWorkspace, clone, PROJECT_ID } from './domain';
import { createCanvasActionExecutor } from './canvas-action-executor';
import { parseCanvasCommand, planCanvasCommand, resizeCanvasNode } from './canvas-commands';
import { parseAgentAction } from './agent-runtime';

const fixture = () => {
  const workspace = createBlankWorkspace();
  const first = makeReferenceNode();
  const second = { ...first, id: 'second', versionId: 'second-version', x: 750, y: 320 };
  workspace.nodes = [first, second];
  workspace.versions = [makeReferenceVersion(), { ...makeReferenceVersion(), id: 'second-version', canvasObjectId: 'second' }];
  workspace.selectedIds = workspace.nodes.map(node => node.id);
  return workspace;
};

describe('single Agent canvas geometry tools', () => {
  it('resizes from opposite fixed corners without stretching media or changing its identity', () => {
    const node = { ...makeReferenceNode(), width: 400, height: 200, x: 100, y: 100 };
    const resized = resizeCanvasNode(node, 'nw', -200, -100);
    expect(resized).toMatchObject({ x: -100, y: 0, width: 600, height: 300, id: node.id, versionId: node.versionId });
    expect(resizeCanvasNode(node, 'se', -1000, -1000)).toMatchObject({ x: 100, y: 100, width: 64, height: 32 });
    expect(() => resizeCanvasNode(node, 'se', NaN, 0)).toThrow();
  });
  it('does not capture ordinary creative prompts or incomplete commands', () => {
    expect(parseCanvasCommand('为产品做一张海报，把主体放大')).toBeNull();
    expect(parseCanvasCommand('向右移动')).toBeNull();
    expect(parseCanvasCommand('把选中对象向右移动 100 像素')).toEqual({ kind: 'move', dx: 100, dy: 0 });
  });
  it('applies a real atomic move once, preserving Assets, Versions and media jobs', async () => {
    let workspace = fixture();
    const before = clone(workspace);
    const media = vi.fn();
    const write = vi.fn(next => { workspace = next; });
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: media, createVideoJob: media });
    const action = await planCanvasCommand({ kind: 'move', dx: 100, dy: 0 }, workspace, 'move-1');
    const input = { action, idempotencyKey: 'move-1', signal: new AbortController().signal, runId: 'test-run', stepId: 'test-step' };
    const receipt = await executor.executeOnce(input);
    expect(receipt).toMatchObject({ ok: true, changed: true, costUsd: 0 });
    expect(workspace.nodes[0].x).toBe(before.nodes[0].x + 100);
    expect(workspace.versions).toEqual(before.versions);
    expect(workspace.assets).toEqual(before.assets);
    expect(workspace.jobs).toEqual(before.jobs);
    expect(media).not.toHaveBeenCalled();
    expect(await executor.executeOnce(input)).toEqual(receipt);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await executor.executeOnce({ ...input, action: { ...action, actionId: 'changed' } })).toMatchObject({ ok: false, errorCode: 'CANVAS_ACTION_IDEMPOTENCY_CONFLICT' });
  });
  it('fails closed when a manual canvas change follows planning', async () => {
    let workspace = fixture();
    const action = await planCanvasCommand({ kind: 'arrange', layout: 'row', all: true }, workspace, 'row-1');
    workspace.nodes[0].y += 8;
    const before = clone(workspace);
    const write = vi.fn(next => { workspace = next; });
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: vi.fn() });
    expect(await executor.executeOnce({ action, idempotencyKey: 'row-1', signal: new AbortController().signal, runId: 'test-run', stepId: 'test-step' })).toMatchObject({ ok: false, errorCode: 'CANVAS_CONTEXT_STALE' });
    expect(workspace).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });
  it('preserves geometry, selection and lineage after persistence and reopen', async () => {
    let workspace = fixture();
    const action = await planCanvasCommand({ kind: 'arrange', layout: 'row', all: true }, workspace, 'row-2');
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: next => { workspace = next; }, createImageJob: vi.fn() });
    await executor.executeOnce({ action, idempotencyKey: 'row-2', signal: new AbortController().signal, runId: 'test-run', stepId: 'test-step' });
    const bytes = serializeWorkspace(workspace);
    const restored = readWorkspace(PROJECT_ID, { getItem: () => bytes });
    if (restored.status !== 'ready' && restored.status !== 'migrated') throw new Error('reopen failed');
    expect(restored.workspace.nodes.map(node => [node.id, node.x, node.y, node.width, node.height, node.versionId])).toEqual(workspace.nodes.map(node => [node.id, node.x, node.y, node.width, node.height, node.versionId]));
    expect(restored.workspace.selectedIds).toEqual(workspace.selectedIds);
  });
  it('rejects empty selection, excessive scale, duplicate targets and bad dimensions', async () => {
    await expect(planCanvasCommand({ kind: 'move', dx: 100, dy: 0 }, createBlankWorkspace(), 'empty')).rejects.toThrow('选择对象');
    await expect(planCanvasCommand({ kind: 'scale', factor: 5 }, fixture(), 'large')).rejects.toThrow('400%');
    const action = await planCanvasCommand({ kind: 'scale', factor: 1.2 }, fixture(), 'scale');
    expect(() => parseAgentAction({ ...action, transforms: [action.transforms[0], action.transforms[0]] })).toThrow();
    expect(() => parseAgentAction({ ...action, transforms: [{ ...action.transforms[0], width: 0 }] })).toThrow();
  });
  it('cancels before mutation', async () => {
    const workspace = fixture();
    const action = await planCanvasCommand({ kind: 'move', dx: 100, dy: 0 }, workspace, 'cancel');
    const controller = new AbortController(); controller.abort();
    const write = vi.fn();
    const executor = createCanvasActionExecutor({ readWorkspace: () => workspace, writeWorkspace: write, createImageJob: vi.fn() });
    expect(await executor.executeOnce({ action, idempotencyKey: 'cancel', signal: controller.signal, runId: 'test-run', stepId: 'test-step' })).toMatchObject({ ok: false, errorCode: 'ACTION_ABORTED' });
    expect(write).not.toHaveBeenCalled();
  });
});
