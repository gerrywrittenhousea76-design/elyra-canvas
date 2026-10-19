import { makeUploadedReferenceNode, type Workspace } from './domain';
import type { Asset } from './agent';
import type { FrontstageStagedReference } from './ProductFrontstage';
import { compileSkill, type SkillDefinition, type SkillValues } from './skills';
import { applyWorkflowCommand, makeWorkflowNode, type WorkflowModel } from './workflow-graph';

export interface SkillLaunchDraft {
  skill: SkillDefinition; values: SkillValues; model: WorkflowModel;
  reference?: FrontstageStagedReference; transferConsent: boolean;
}
export interface PendingSkillRun { id: string; projectId: string; nodeId: string; prompt: string; model: WorkflowModel; transferConsent: boolean; expiresAt: number }

/** A ticket only lives in Root memory. Reloading/restoring a project cannot authorize a new submission. */
export class SkillRunGate {
  private ticket?: PendingSkillRun;
  arm(ticket: PendingSkillRun) { this.ticket = { ...ticket }; }
  claim(id: string, projectId: string, now = Date.now()): boolean {
    if (!this.ticket || this.ticket.id !== id || this.ticket.projectId !== projectId) return false;
    const fresh = now < this.ticket.expiresAt;
    this.ticket = undefined;
    return fresh;
  }
  clear() { this.ticket = undefined; }
}

/** All graph changes are prepared before the single durable commit in Root. */
export function materializeSkill(current: Workspace, draft: SkillLaunchDraft, id: string, projectId: string): { workspace: Workspace; nodeId: string; prompt: string } {
  const prompt = compileSkill(draft.skill, draft.values, !!draft.reference);
  if (draft.skill.output === 'image' ? !['deterministic-mock', 'evolink-gpt-image-2'].includes(draft.model) : draft.model !== 'evolink-sora-2-preview') throw new Error('Skill 与所选模型能力不匹配。');
  if (draft.reference && draft.model !== 'deterministic-mock' && !draft.transferConsent) throw new Error('请确认将参考图发送给所选模型服务。');
  if (current.nodes.length + (draft.reference ? 2 : 1) > 100) throw new Error('画布节点已满，请新建项目后使用。');
  const nodeId = `skill-task-${id}`;
  if (current.nodes.some(node => node.id === nodeId)) throw new Error('这个 Skill 已经添加到画布，请勿重复提交。');
  const x = current.nodes.length ? Math.max(...current.nodes.map(node => node.x + node.width)) + 100 : 80;
  let next = current;
  let referenceNodeId: string | undefined;
  if (draft.reference) {
    const reference = draft.reference;
    if (reference.storage.projectId !== projectId || reference.storage.mimeType !== 'image/png' || !reference.assetId
      || reference.width < 1 || reference.height < 1 || current.assets.some(asset => asset.id === reference.assetId)) throw new Error('参考图归属或状态有误，请重新上传。');
    referenceNodeId = `skill-reference-${id}`;
    const versionId = `skill-reference-version-${id}`;
    const asset: Asset = { id: reference.assetId, kind: 'image', source: 'local-upload', providerId: 'local-upload', mimeType: 'image/png', storage: reference.storage,
      prompt: '用户有权使用的本地参考图', createdAt: reference.storage.createdAt, metadata: { deterministic: false, width: reference.width, height: reference.height } };
    const node = { ...makeUploadedReferenceNode({ id: referenceNodeId, assetId: asset.id, versionId, width: reference.width, height: reference.height }), x, y: 100 };
    next = { ...current, assets: [...current.assets, asset], nodes: [...current.nodes, node], versions: [...current.versions, { id: versionId, canvasObjectId: node.id, sequence: 0, status: 'ready', createdAt: reference.storage.createdAt }] };
  }
  const node = makeWorkflowNode(draft.skill.output, nodeId, x + (draft.reference ? 440 : 0), 100, prompt);
  node.name = `${draft.skill.name} · v${draft.skill.version}`;
  node.workflow!.model = draft.model;
  next = applyWorkflowCommand(next, { type: 'create', node, sourceId: referenceNodeId });
  return { workspace: { ...next, viewport: { x: 60 - x, y: 20, scale: 1 }, messages: [...next.messages, { id: `skill-message-${id}`, role: 'agent', body: `已调用「${draft.skill.name}」。需求已保存到任务节点，将在画布上执行；你可以修改节点继续创作。`, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }] }, nodeId, prompt };
}
