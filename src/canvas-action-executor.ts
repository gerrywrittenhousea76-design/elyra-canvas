import type { VersionRecord } from './agent';
import type { ActionExecutionReceipt, AgentActionExecutorPort, CreateImageJobAction, CreateVideoJobAction } from './agent-runtime';
import { parseAgentAction } from './agent-runtime';
import { buildCanvasContextGraphSnapshot } from './canvas-context';
import { clone, type Workspace } from './domain';

export interface CanvasActionExecutorDependencies {
  readWorkspace(): Workspace;
  writeWorkspace(next: Workspace): void;
  createImageJob(action: CreateImageJobAction, signal: AbortSignal): Promise<ActionExecutionReceipt>;
  createVideoJob?(action: CreateVideoJobAction, signal: AbortSignal): Promise<ActionExecutionReceipt>;
  now?: () => string;
}

/**
 * Executes CORE-008 typed actions against the existing Workspace boundary.
 * The runtime owns confirmation and bounded looping; this adapter owns atomic
 * canvas mutation plus active-runtime de-duplication receipts. Process-loss
 * recovery is fail-closed in the runtime before this adapter can replay an
 * EXECUTING side effect. It never reads a Provider key.
 */
export const createCanvasActionExecutor = (dependencies: CanvasActionExecutorDependencies): AgentActionExecutorPort => {
  const receipts = new Map<string, ActionExecutionReceipt>();
  const pending = new Map<string, Promise<ActionExecutionReceipt>>();
  const requestBindings = new Map<string, string>();
  const now = dependencies.now ?? (() => new Date().toISOString());

  return {
    async executeOnce({ idempotencyKey, action, signal }) {
      const binding = JSON.stringify(action);
      if (requestBindings.has(idempotencyKey) && requestBindings.get(idempotencyKey) !== binding) {
        return failure('CANVAS_ACTION_IDEMPOTENCY_CONFLICT', '同一动作编号不能绑定不同参数。');
      }
      requestBindings.set(idempotencyKey, binding);
      const previous = receipts.get(idempotencyKey);
      if (previous) return clone(previous);
      const inFlight = pending.get(idempotencyKey);
      if (inFlight) return clone(await inFlight);

      const execution = (async (): Promise<ActionExecutionReceipt> => {
        if (signal.aborted) return failure('ACTION_ABORTED', '动作已取消。');
        if (action.type === 'create_image_job') return dependencies.createImageJob(action, signal);
        if (action.type === 'create_video_job') {
          const workspace = dependencies.readWorkspace();
          const source = workspace.nodes.find((node) => node.id === action.sourceCanvasObjectId && node.status === 'ready');
          const sourceAsset = workspace.assets.find((asset) => asset.id === action.sourceAssetId && asset.kind === 'image');
          const sourceVersion = workspace.versions.find((version) => version.id === action.sourceVersionId && version.canvasObjectId === action.sourceCanvasObjectId && version.status === 'ready');
          if (!source || source.assetId !== action.sourceAssetId || source.versionId !== action.sourceVersionId || !sourceAsset || !sourceVersion) {
            return failure('CORE009_VIDEO_SOURCE_BINDING_STALE', '图生视频的源对象、Asset 或 Version 已变化。');
          }
          if (!dependencies.createVideoJob) return failure('CORE009_VIDEO_EXECUTOR_NOT_CONFIGURED', '视频 Job 执行器未配置。');
          return dependencies.createVideoJob(action, signal);
        }

        const before = dependencies.readWorkspace();
        const beforeSnapshot = await buildCanvasContextGraphSnapshot(before);
        const next = clone(before);

        if (action.type === 'transform_objects') {
          try { parseAgentAction(action); } catch { return failure('CANVAS_TRANSFORM_INVALID', '画布变换参数无效。'); }
          if (beforeSnapshot.semanticSha256 !== action.expectedSemanticSha256) {
            return failure('CANVAS_CONTEXT_STALE', '画布已发生变化，请根据当前选区重新发送。');
          }
          if (!allObjectsExist(next, action.transforms.map(item => item.objectId)) || action.transforms.some(item => next.nodes.find(node => node.id === item.objectId)?.status !== 'ready')) {
            return failure('CANVAS_OBJECT_NOT_READY', '仅可修改已就绪的画布对象。');
          }
          const patches = new Map(action.transforms.map(item => [item.objectId, item]));
          next.nodes = next.nodes.map(node => {
            const patch = patches.get(node.id);
            return patch ? { ...node, x: patch.x, y: patch.y, width: patch.width, height: patch.height } : node;
          });
        } else if (action.type === 'select_objects') {
          if (!allObjectsExist(next, action.objectIds)) return failure('CANVAS_OBJECT_NOT_FOUND', '选择对象不存在。');
          next.selectedIds = canonicalIds(action.objectIds);
        } else if (action.type === 'focus_objects') {
          const objects = next.nodes.filter((node) => action.objectIds.includes(node.id));
          if (objects.length !== action.objectIds.length) return failure('CANVAS_OBJECT_NOT_FOUND', '聚焦对象不存在。');
          const left = Math.min(...objects.map((node) => node.x));
          const top = Math.min(...objects.map((node) => node.y));
          const right = Math.max(...objects.map((node) => node.x + node.width));
          const bottom = Math.max(...objects.map((node) => node.y + node.height));
          next.viewport = {
            ...next.viewport,
            x: normalizeCoordinate(400 - ((left + right) / 2) * next.viewport.scale),
            y: normalizeCoordinate(300 - ((top + bottom) / 2) * next.viewport.scale),
          };
          next.selectedIds = canonicalIds(action.objectIds);
        } else if (action.type === 'create_version') {
          const parent = next.nodes.find((node) => node.id === action.parentCanvasObjectId);
          const parentVersion = next.versions.find((version) => version.id === action.parentVersionId && version.canvasObjectId === parent?.id);
          const children = next.nodes.filter((node) => node.jobId === action.jobId);
          const job = next.jobs.find((candidate) => candidate.id === action.jobId);
          if (!parent || !parentVersion || children.length === 0 || !job) return failure('VERSION_CONTEXT_NOT_FOUND', '无法建立版本关系。');
          if ((job.operation !== 'edit' && job.operation !== 'video') || job.targetCanvasObjectId !== parent.id) return failure('VERSION_JOB_BINDING_INVALID', 'Job 不属于该父对象的编辑或图生视频任务。');
          const pendingVersions: Array<{ child: typeof children[number]; version: VersionRecord }> = [];
          for (const child of children) {
            if (
              child.id === parent.id
              || (child.parentId && child.parentId !== parent.id)
              || child.version !== parentVersion.sequence + 1
            ) return failure('VERSION_LINEAGE_CONFLICT', '版本关系与现有对象冲突。');
            const existing = child.versionId ? next.versions.find((version) => version.id === child.versionId) : undefined;
            if (child.versionId && !existing) return failure('VERSION_RECORD_MISSING', '子对象引用的 Version 不存在。');
            if (existing) {
              if (
                existing.canvasObjectId !== child.id
                || existing.parentVersionId !== parentVersion.id
                || existing.parentCanvasObjectId !== parent.id
                || existing.jobId !== job.id
                || existing.sequence !== parentVersion.sequence + 1
              ) return failure('VERSION_LINEAGE_CONFLICT', '版本关系与现有记录冲突。');
              continue;
            }
            const versionId = children.length === 1
              ? `${action.actionId}:version`
              : `${action.actionId}:version:${child.id}`;
            if (
              next.versions.some((version) => version.id === versionId)
              || pendingVersions.some((entry) => entry.version.id === versionId)
            ) return failure('VERSION_ID_CONFLICT', '版本 ID 已存在。');
            pendingVersions.push({
              child,
              version: {
                id: versionId,
                canvasObjectId: child.id,
                parentVersionId: parentVersion.id,
                parentCanvasObjectId: parent.id,
                jobId: job.id,
                sequence: parentVersion.sequence + 1,
                status: child.status === 'ready' ? 'ready' : child.status === 'failed' ? 'failed' : child.status === 'user_cancelled' ? 'user_cancelled' : 'pending',
                createdAt: now(),
              },
            });
          }
          for (const { child, version } of pendingVersions) {
            next.versions.push(version);
            child.parentId = parent.id;
            child.version = version.sequence;
            child.versionId = version.id;
          }
        } else if (action.type === 'ask_user' || action.type === 'finish') {
          return { ok: true, changed: false, summary: action.type === 'ask_user' ? '等待用户补充信息。' : action.summary, costUsd: 0 };
        }

        if (signal.aborted) return failure('ACTION_ABORTED', '动作已取消。');
        const afterSnapshot = await buildCanvasContextGraphSnapshot(next);
        if (signal.aborted) return failure('ACTION_ABORTED', '动作已取消。');
        if (action.type === 'transform_objects') {
          const currentWorkspace = dependencies.readWorkspace();
          const currentSnapshot = await buildCanvasContextGraphSnapshot(currentWorkspace);
          if (signal.aborted) return failure('ACTION_ABORTED', '动作已取消。');
          if (dependencies.readWorkspace() !== currentWorkspace || currentSnapshot.semanticSha256 !== beforeSnapshot.semanticSha256) return failure('CANVAS_CONTEXT_STALE', '画布已发生变化，未覆盖手动操作。');
        }
        const changed = beforeSnapshot.semanticSha256 !== afterSnapshot.semanticSha256;
        if (changed) dependencies.writeWorkspace(next);
        return {
          ok: true,
          changed,
          summary: changed ? '画布动作已应用并验证。' : '画布动作未产生变化。',
          deltaSha256: afterSnapshot.semanticSha256,
          outputIds: action.type === 'create_version'
            ? next.nodes.filter((node) => node.jobId === action.jobId).map((node) => node.id)
            : action.type === 'transform_objects' ? action.transforms.map(item => item.objectId)
              : action.type === 'select_objects' || action.type === 'focus_objects' ? action.objectIds : [],
          costUsd: 0,
        };
      })();

      pending.set(idempotencyKey, execution);
      try {
        const receipt = await execution;
        receipts.set(idempotencyKey, clone(receipt));
        return clone(receipt);
      } finally {
        pending.delete(idempotencyKey);
      }
    },
  };
};

const allObjectsExist = (workspace: Workspace, ids: readonly string[]) => ids.every((id) => workspace.nodes.some((node) => node.id === id));
const canonicalIds = (ids: readonly string[]) => [...ids].sort((left, right) => left.localeCompare(right, 'en'));
const normalizeCoordinate = (value: number) => Number(value.toFixed(4));
const failure = (errorCode: string, summary: string): ActionExecutionReceipt => ({ ok: false, errorCode, summary, retryable: false, costUsd: 0 });
