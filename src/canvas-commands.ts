import { buildCanvasContextGraphSnapshot } from './canvas-context';
import { parseAgentAction, type TransformObjectsAction } from './agent-runtime';
import type { CanvasNode, Workspace } from './domain';

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
export const resizeCanvasNode = (node: CanvasNode, corner: ResizeCorner, dx: number, dy: number): CanvasNode => {
  if (![dx, dy, node.width, node.height].every(Number.isFinite) || node.width <= 0 || node.height <= 0) throw new Error('无效的节点尺寸');
  const horizontal = (corner.endsWith('w') ? -dx : dx) / node.width;
  const vertical = (corner.startsWith('n') ? -dy : dy) / node.height;
  const change = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
  const factor = Math.min(4096 / Math.max(node.width, node.height), Math.max(32 / Math.min(node.width, node.height), 1 + change));
  const width = node.width * factor;
  const height = node.height * factor;
  return { ...node, width, height, x: corner.endsWith('w') ? node.x + node.width - width : node.x, y: corner.startsWith('n') ? node.y + node.height - height : node.y };
};

export type CanvasCommand =
  | { kind: 'arrange'; layout: 'row' | 'column' | 'grid'; all: boolean }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'scale'; factor: number };

/** Only explicit geometry commands are handled locally. Creative requests
 * continue to use the existing Planner and media adapters. */
export const parseCanvasCommand = (input: string): CanvasCommand | null => {
  const text = input.trim().replace(/[。！!\s]/g, '');
  const arrangement = /^(?:把|将)?(全部|所有|选中|选中的)?(?:对象|图片|素材)?(?:按)?(横向排列|纵向排列|网格排列|横向排布|纵向排布|网格排布)$/.exec(text);
  if (arrangement) return { kind: 'arrange', all: ['全部', '所有'].includes(arrangement[1]), layout: arrangement[2].startsWith('横') ? 'row' : arrangement[2].startsWith('纵') ? 'column' : 'grid' };
  const movement = /^(?:把|将)?(?:选中|选中的)?(?:对象|图片|素材)?向(左|右|上|下)移动(\d+(?:\.\d+)?)(?:px|像素)?$/i.exec(text);
  if (movement) {
    const amount = Number(movement[2]);
    return { kind: 'move', dx: movement[1] === '右' ? amount : movement[1] === '左' ? -amount : 0, dy: movement[1] === '下' ? amount : movement[1] === '上' ? -amount : 0 };
  }
  const scale = /^(?:把|将)?(?:选中|选中的)?(?:对象|图片|素材)?(?:缩放到|放大到|缩小到)(\d+(?:\.\d+)?)%$/.exec(text);
  return scale ? { kind: 'scale', factor: Number(scale[1]) / 100 } : null;
};

export const planCanvasCommand = async (command: CanvasCommand, workspace: Workspace, actionId: string): Promise<TransformObjectsAction> => {
  if (workspace.jobs.some(job => ['queued', 'running', 'submitted', 'processing', 'uploading'].includes(job.status))) throw new Error('请等当前任务结束，再调整画布。');
  const nodes = workspace.nodes.filter(node => command.kind === 'arrange' && command.all ? true : workspace.selectedIds.includes(node.id));
  if (!nodes.length) throw new Error('先在画布上选择对象，再告诉我如何调整；也可以输入“全部对象网格排列”。');
  if (nodes.some(node => node.status !== 'ready')) throw new Error('选区里有未完成对象，暂时无法调整。');
  if (command.kind === 'move' && Math.max(Math.abs(command.dx), Math.abs(command.dy)) > 2000) throw new Error('一次移动请控制在 2000 像素以内。');
  if (command.kind === 'scale' && (command.factor < .1 || command.factor > 4)) throw new Error('缩放范围为 10% 至 400%。');
  const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const left = Math.min(...nodes.map(node => node.x));
  const top = Math.min(...nodes.map(node => node.y));
  const columns = Math.ceil(Math.sqrt(nodes.length));
  const cellWidth = Math.max(...nodes.map(node => node.width)) + 40;
  const cellHeight = Math.max(...nodes.map(node => node.height)) + 64;
  let offset = 0;
  const transforms = ordered.map((node, index) => {
    let { x, y, width, height } = node;
    if (command.kind === 'move') { x += command.dx; y += command.dy; }
    else if (command.kind === 'scale') {
      x = left + (x - left) * command.factor;
      y = top + (y - top) * command.factor;
      width *= command.factor;
      height *= command.factor;
    } else if (command.layout === 'row') { x = left + offset; y = top; offset += width + 40; }
    else if (command.layout === 'column') { x = left; y = top + offset; offset += height + 64; }
    else { x = left + (index % columns) * cellWidth; y = top + Math.floor(index / columns) * cellHeight; }
    return { objectId: node.id, x, y, width, height };
  });
  const snapshot = await buildCanvasContextGraphSnapshot(workspace);
  return parseAgentAction({ type: 'transform_objects', actionId, expectedSemanticSha256: snapshot.semanticSha256, transforms }) as TransformObjectsAction;
};
