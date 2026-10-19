import { useRef } from 'react';
import { useProviderLabels } from './ProviderSettings';
import type { CanvasNode } from './domain';
import { workflowLabels, type WorkflowModel } from './workflow-graph';

export function WorkflowCard({ node, selected, locked, running, hasResult, error, onPointerDown, onUpdate, onRun, onSelect }: {
  node: CanvasNode; selected: boolean; locked: boolean; running: boolean; hasResult: boolean; error?: string;
  onPointerDown: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void;
  onUpdate: (text: string, model: WorkflowModel, continueTextEdit?: boolean) => void; onRun: () => void; onSelect: () => void;
}) {
  const data = node.workflow!;
  const providerLabels = useProviderLabels();
  const editing = useRef(false);
  return <article className={`workflow-card ${selected ? 'selected' : ''}`} data-testid="canvas-node" data-node-id={node.id} style={{ width: node.width, minHeight: node.height, transform: `translate(${node.x}px, ${node.y}px)` }} onPointerDown={event => onPointerDown(event, node)}>
    <header><strong>{node.name}</strong><span>{running ? '运行中' : error ? '未完成' : hasResult ? '已有输出' : data.kind === 'text' ? '可编辑' : '待运行'}</span></header>
    <div className="workflow-editor" onPointerDown={event => { event.stopPropagation(); onSelect(); }}>
      <label htmlFor={`text-${node.id}`}>{data.kind === 'text' ? '文字内容' : '提示词'}</label>
      <textarea id={`text-${node.id}`} aria-label={`${workflowLabels[data.kind]}节点内容`} value={data.text} disabled={locked} maxLength={12000} placeholder={data.kind === 'text' ? '写下脚本、分镜描述或提示词，可连接到下游任务…' : '填写要求，已连接的文本将自动作为输入…'} onFocus={() => { editing.current = false; }} onChange={event => { onUpdate(event.target.value, data.model, editing.current); editing.current = true; }} onBlur={() => { editing.current = false; }} />
      <div className="workflow-input-summary">{data.inputs.length ? `${data.inputs.length} 个输入 · ${data.inputs.filter(input => input.role === 'image').length} 张参考图` : data.kind === 'text' ? '连接右侧输出端口以复用这段内容' : '左侧端口接入文本或图片'}</div>
      {data.kind !== 'text' && <>
        <select aria-label="节点模型" value={data.model} disabled={locked} onChange={event => onUpdate(data.text, event.target.value as WorkflowModel)}>
          {data.kind === 'image' ? <><option value="deterministic-mock">本地流程演练（固定示例图）</option><option value="evolink-gpt-image-2">{providerLabels.image}</option></> : <option value="evolink-sora-2-preview">{providerLabels.video} · 4 秒</option>}
        </select>
        <button type="button" data-testid="run-workflow-node" disabled={locked || running} onClick={onRun}>{running ? '正在运行…' : data.model === 'deterministic-mock' ? '运行本地演练' : '运行节点'}</button>
        {error && <p className="workflow-error" role="alert">{error}</p>}
      </>}
    </div>
  </article>;
}
