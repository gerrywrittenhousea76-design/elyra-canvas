import { describe, expect, it } from 'vitest';
import { createBlankWorkspace, makeReferenceNode, makeReferenceVersion, serializeWorkspace, readWorkspace } from './domain';
import { applyWorkflowCommand, makeWorkflowNode, resolveWorkflowRequest } from './workflow-graph';
import { buildCanvasContextGraphSnapshot } from './canvas-context';

const fixture = () => {
  const workspace = createBlankWorkspace();
  workspace.nodes = [makeReferenceNode(), makeWorkflowNode('text', 'text-1', 10, 20, '柔和晨光'), makeWorkflowNode('image', 'image-1', 400, 20, '保持主体')];
  workspace.versions = [makeReferenceVersion()];
  return workspace;
};

describe('node workflow contracts', () => {
  it('refuses damaged node records on reload without replacing the saved bytes', () => {
    for (const damage of ['missing-data', 'broken-input', 'wrong-type', 'cycle']) {
      const record = JSON.parse(serializeWorkspace(fixture()));
      const node = record.nodes.find((item: { id: string }) => item.id === 'image-1');
      if (damage === 'missing-data') delete node.workflow;
      if (damage === 'broken-input') node.workflow.inputs = [{ sourceId: 'missing', role: 'image' }];
      if (damage === 'wrong-type') node.workflow.inputs = [{ sourceId: 'reference-demo', role: 'image', versionId: 42 }];
      if (damage === 'cycle') node.workflow.inputs = [{ sourceId: 'image-1', role: 'image' }];
      const bytes = JSON.stringify(record);
      const storage = { getItem: () => bytes };
      expect(readWorkspace(undefined, storage).status).toBe('corrupt');
      expect(storage.getItem()).toBe(bytes);
    }
  });

  it('text and media task inputs share the persisted workspace and semantic context', async () => {
    let workspace = fixture();
    workspace = applyWorkflowCommand(workspace, { type: 'connect', sourceId: 'text-1', targetId: 'image-1' });
    workspace = applyWorkflowCommand(workspace, { type: 'connect', sourceId: 'reference-demo', targetId: 'image-1' });
    const request = resolveWorkflowRequest(workspace, 'image-1');
    expect(request.prompt).toBe('柔和晨光\n\n保持主体');
    expect(request.reference?.id).toBe('reference-demo');
    const bytes = serializeWorkspace(workspace);
    const reopened = readWorkspace(undefined, { getItem: () => bytes });
    expect(reopened.status).toBe('ready');
    if (reopened.status !== 'ready') throw Error('reload failed');
    expect(resolveWorkflowRequest(reopened.workspace, 'image-1').prompt).toBe(request.prompt);
    expect(reopened.workspace.nodes.find(n => n.id === 'image-1')?.workflow?.inputs).toEqual(workspace.nodes.find(n => n.id === 'image-1')?.workflow?.inputs);
    const before = await buildCanvasContextGraphSnapshot(workspace);
    const after = await buildCanvasContextGraphSnapshot(applyWorkflowCommand(workspace, { type: 'update', nodeId: 'text-1', text: '傍晚逆光' }));
    expect(before.semanticSha256).not.toBe(after.semanticSha256);
    expect(JSON.stringify(after)).not.toContain('傍晚逆光');
    expect(workspace.jobs).toHaveLength(0);
  });

  it('rejects invalid, stale and cyclic connections', () => {
    let workspace = fixture();
    expect(() => applyWorkflowCommand(workspace, { type: 'connect', sourceId: 'absent', targetId: 'image-1' })).toThrow();
    expect(() => applyWorkflowCommand(workspace, { type: 'connect', sourceId: 'image-1', targetId: 'image-1' })).toThrow();
    workspace = applyWorkflowCommand(workspace, { type: 'create', node: makeWorkflowNode('image', 'image-2', 800, 20) });
    workspace = applyWorkflowCommand(workspace, { type: 'connect', sourceId: 'image-1', targetId: 'image-2' });
    expect(() => applyWorkflowCommand(workspace, { type: 'connect', sourceId: 'image-2', targetId: 'image-1' })).toThrow();
    expect(() => resolveWorkflowRequest(workspace, 'image-2')).toThrow(/尚未/);
    workspace = applyWorkflowCommand(workspace, { type: 'connect', sourceId: 'reference-demo', targetId: 'image-1' });
    workspace.nodes[0] = { ...workspace.nodes[0], versionId: 'changed' };
    expect(() => resolveWorkflowRequest(workspace, 'image-1')).toThrow(/版本/);
  });

  it('derived node and typed input are atomic; snapshots and reload retain source identity', () => {
    const before = fixture();
    const child = makeWorkflowNode('image', 'child', 700, 500);
    const after = applyWorkflowCommand(before, { type: 'create', node: child, sourceId: 'reference-demo' });
    expect(before.nodes).toHaveLength(3);
    expect(after.nodes).toHaveLength(4);
    expect(after.nodes.at(-1)?.workflow?.inputs[0].versionId).toBe(before.nodes[0].versionId);
    expect(after.assets).toEqual(before.assets);
    expect(after.versions).toEqual(before.versions);
    expect(after.jobs).toEqual(before.jobs);
    expect(() => applyWorkflowCommand(before, { type: 'create', node: child, sourceId: 'missing' })).toThrow();
    expect(before.nodes).toHaveLength(3);
    const disconnected = applyWorkflowCommand(after, { type: 'disconnect', sourceId: 'reference-demo', targetId: 'child' });
    expect(disconnected.nodes.at(-1)?.workflow?.inputs).toHaveLength(0);
    expect(after.nodes.at(-1)?.workflow?.inputs).toHaveLength(1);
  });

  it('keeps task model choices and refuses empty prompts or unsupported video references', () => {
    const workspace = fixture();
    const updated = applyWorkflowCommand(workspace, { type: 'update', nodeId: 'image-1', model: 'evolink-gpt-image-2' });
    expect(resolveWorkflowRequest(updated, 'image-1').model).toBe('evolink-gpt-image-2');
    const video = applyWorkflowCommand(workspace, { type: 'create', node: makeWorkflowNode('video', 'video-1', 20, 700, '缓慢推进') });
    expect(() => resolveWorkflowRequest(video, 'video-1')).toThrow(/图片/);
    expect(() => applyWorkflowCommand(video, { type: 'update', nodeId: 'video-1', model: 'deterministic-mock' })).toThrow();
  });
});
