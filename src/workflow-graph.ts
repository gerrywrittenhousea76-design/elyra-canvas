import type { CanvasNode, ImageProviderId, Workspace } from './domain';

export type WorkflowKind = 'text' | 'image' | 'video';
export type WorkflowModel = ImageProviderId | 'evolink-sora-2-preview';
export interface WorkflowInput {
  sourceId: string;
  role: 'text' | 'image';
  assetId?: string;
  versionId?: string;
}
export interface WorkflowData {
  kind: WorkflowKind;
  text: string;
  model: WorkflowModel;
  inputs: WorkflowInput[];
}
export type WorkflowCommand =
  | { type: 'create'; node: CanvasNode; sourceId?: string }
  | { type: 'update'; nodeId: string; text?: string; model?: WorkflowModel }
  | { type: 'connect' | 'disconnect'; sourceId: string; targetId: string };

export const workflowLabels: Record<WorkflowKind, string> = { text: '文本', image: '图片任务', video: '视频任务' };
export const makeWorkflowNode = (kind: WorkflowKind, id: string, x: number, y: number, text = ''): CanvasNode => ({
  id, kind: 'workflow', name: `${workflowLabels[kind]}节点`, x, y, width: 340, height: kind === 'text' ? 240 : 350,
  status: 'ready', version: 0, prompt: '', createdAt: new Date().toISOString(),
  workflow: { kind, text, model: kind === 'video' ? 'evolink-sora-2-preview' : 'deterministic-mock', inputs: [] },
});

/** Only node-authored content is stored here. Legacy chat, provider URLs and
 * raw historical prompts keep their existing redaction boundary. */
export const persistWorkflowData = (data: WorkflowData): WorkflowData => {
  if (!['text', 'image', 'video'].includes(data.kind) || typeof data.text !== 'string' || data.text.length > 12000 || !Array.isArray(data.inputs) || data.inputs.length > 9) throw new Error('节点数据无效，原工程保持不变。');
  if (data.kind === 'video' ? data.model !== 'evolink-sora-2-preview' : !['deterministic-mock', 'evolink-gpt-image-2'].includes(data.model)) throw new Error('节点模型不支持此任务。');
  return { kind: data.kind, text: data.text, model: data.model, inputs: data.inputs.map(input => {
    if (!input || typeof input.sourceId !== 'string' || !input.sourceId || !['text', 'image'].includes(input.role)
      || (input.assetId !== undefined && typeof input.assetId !== 'string')
      || (input.versionId !== undefined && typeof input.versionId !== 'string')) throw new Error('节点引用无效。');
    return { sourceId: input.sourceId, role: input.role, ...(input.assetId ? { assetId: input.assetId } : {}), ...(input.versionId ? { versionId: input.versionId } : {}) };
  }) };
};

const inputRole = (workspace: Workspace, node: CanvasNode): WorkflowInput['role'] => {
  if (node.workflow?.kind === 'text') return 'text';
  if (node.workflow?.kind === 'video' || workspace.assets.find(asset => asset.id === node.assetId)?.kind === 'video') throw new Error('当前图片和视频任务只接受文本或图片输入。');
  return 'image';
};

export const validateWorkflowGraph = (workspace: Workspace): void => {
  const nodes = new Map(workspace.nodes.map(node => [node.id, node]));
  for (const node of workspace.nodes) {
    if (node.kind !== 'workflow') continue;
    if (!node.workflow) throw new Error('工作流节点缺少参数。');
    persistWorkflowData(node.workflow);
    const unique = new Set<string>();
    let imageInputs = 0;
    for (const input of node.workflow.inputs) {
      const source = nodes.get(input.sourceId);
      if (!source || unique.has(input.sourceId)) throw new Error('连线端点不存在或重复。');
      if (node.workflow.kind === 'text' || input.role !== inputRole(workspace, source)) throw new Error('节点输入类型不匹配。');
      unique.add(input.sourceId);
      if (input.role === 'image') imageInputs += 1;
    }
    if (imageInputs > 1) throw new Error('现有生成服务一次只支持一张参考图，请先移除其他图片连线。');
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('连线会形成循环，请调整上下游关系。');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const input of nodes.get(id)?.workflow?.inputs ?? []) visit(input.sourceId);
    // A generated result is downstream of the task that produced it.
    const origin = nodes.get(id)?.workflowOriginId;
    if (origin && nodes.has(origin)) visit(origin);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
};

/** One immutable transaction for both Agent commands and manual editing. */
export const applyWorkflowCommand = (workspace: Workspace, command: WorkflowCommand): Workspace => {
  let next = workspace;
  if (command.type === 'create') {
    if (workspace.nodes.length >= 100) throw new Error('当前画布最多支持 100 个节点。');
    if (workspace.nodes.some(node => node.id === command.node.id)) throw new Error('节点编号已存在。');
    if (!command.node.workflow) throw new Error('节点参数缺失。');
    next = { ...workspace, nodes: [...workspace.nodes, { ...command.node, workflow: persistWorkflowData(command.node.workflow) }], selectedIds: [command.node.id] };
    if (command.sourceId) next = applyWorkflowCommand(next, { type: 'connect', sourceId: command.sourceId, targetId: command.node.id });
  } else if (command.type === 'update') {
    const node = workspace.nodes.find(item => item.id === command.nodeId);
    if (!node?.workflow) throw new Error('未找到可编辑的任务节点。');
    const data = persistWorkflowData({ ...node.workflow, ...(command.text !== undefined ? { text: command.text } : {}), ...(command.model !== undefined ? { model: command.model } : {}) });
    next = { ...workspace, nodes: workspace.nodes.map(item => item.id === node.id ? { ...item, workflow: data } : item) };
  } else {
    const source = workspace.nodes.find(node => node.id === command.sourceId);
    const target = workspace.nodes.find(node => node.id === command.targetId);
    if (!source || !target?.workflow) throw new Error('请选择一个来源和一个任务节点。');
    const inputs = target.workflow.inputs.filter(input => input.sourceId !== source.id);
    if (command.type === 'connect') inputs.push({ sourceId: source.id, role: inputRole(workspace, source), ...(source.assetId ? { assetId: source.assetId } : {}), ...(source.versionId ? { versionId: source.versionId } : {}) });
    next = { ...workspace, nodes: workspace.nodes.map(node => node.id === target.id ? { ...node, workflow: { ...target.workflow!, inputs } } : node) };
  }
  validateWorkflowGraph(next);
  return next;
};

export const resolveWorkflowRequest = (workspace: Workspace, nodeId: string): { prompt: string; reference?: CanvasNode; model: WorkflowModel; kind: 'image' | 'video' } => {
  validateWorkflowGraph(workspace);
  const node = workspace.nodes.find(item => item.id === nodeId);
  if (!node?.workflow || node.workflow.kind === 'text') throw new Error('请选择图片或视频任务节点。');
  const texts: string[] = [];
  let reference: CanvasNode | undefined;
  for (const input of node.workflow.inputs) {
    let source = workspace.nodes.find(item => item.id === input.sourceId)!;
    if (input.role === 'text') { texts.push(source.workflow!.text.trim()); continue; }
    if (source.workflow) {
      const output = [...workspace.nodes].reverse().find(item => item.workflowOriginId === source.id && item.status === 'ready' && item.assetId);
      if (!output) throw new Error('上游图片节点尚未产出，请先运行上游节点。');
      source = output;
    } else if (input.assetId !== source.assetId || input.versionId !== source.versionId) throw new Error('引用版本已变化，请重新连接确认。');
    if (source.status !== 'ready') throw new Error('参考图片尚未完成。');
    reference = source;
  }
  texts.push(node.workflow.text.trim());
  const prompt = texts.filter(Boolean).join('\n\n');
  if (!prompt) throw new Error('请填写节点提示词，或连接一个有内容的文本节点。');
  if (prompt.length > 12000) throw new Error('合并后的提示词超过 12000 字，请缩短内容。');
  if (node.workflow.kind === 'video' && (!reference?.assetId || !workspace.assets.find(asset => asset.id === reference.assetId)?.storage)) throw new Error('视频节点需要连接一张已保存到本机的图片。');
  return { prompt, reference, model: node.workflow.model, kind: node.workflow.kind };
};
