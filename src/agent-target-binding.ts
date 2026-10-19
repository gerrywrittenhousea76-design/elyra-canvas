import type { AgentPlan, UserIntent } from './agent';
import type { AgentRun } from './agent-runtime';
import type { Workspace } from './domain';

export interface CanvasTargetBinding {
  objectId: string;
  versionId: string;
  assetId?: string;
}

/**
 * Captures the immutable object identity that a confirmed edit is allowed to
 * operate on. The prompt/plan may outlive a selection change, but it must not
 * outlive deletion or replacement of the referenced object/version/asset.
 */
export const captureCanvasTargetBinding = (workspace: Workspace, objectId: string): CanvasTargetBinding | undefined => {
  const node = workspace.nodes.find((candidate) => candidate.id === objectId && candidate.status === 'ready');
  if (!node?.versionId) return undefined;
  const version = workspace.versions.find((candidate) => candidate.id === node.versionId && candidate.canvasObjectId === node.id && candidate.status === 'ready');
  if (!version) return undefined;
  if (node.assetId && !workspace.assets.some((asset) => asset.id === node.assetId)) return undefined;
  return { objectId: node.id, versionId: node.versionId, ...(node.assetId ? { assetId: node.assetId } : {}) };
};

export const canvasTargetBindingMatches = (workspace: Workspace, binding: CanvasTargetBinding): boolean => {
  const current = captureCanvasTargetBinding(workspace, binding.objectId);
  return Boolean(
    current
    && current.versionId === binding.versionId
    && current.assetId === binding.assetId,
  );
};

/**
 * Resolves the one image-action capability represented by the visible Plan.
 * UI state alone is never authority: run, pending step, action and the
 * Intent/Plan/operation tuple must all match before a ticket can be issued.
 */
export const resolvePendingImageActionId = (
  run: AgentRun | null | undefined,
  intent: Pick<UserIntent, 'id' | 'operation'>,
  plan: Pick<AgentPlan, 'id' | 'intentId' | 'operation'>,
): string | undefined => {
  const actionId = resolvePendingGenerationActionId(run, intent, plan);
  const action = run?.steps.at(-1)?.action;
  return action?.type === 'create_image_job' ? actionId : undefined;
};

export const resolvePendingVideoActionId = (
  run: AgentRun | null | undefined,
  intent: Pick<UserIntent, 'id' | 'operation' | 'targetCanvasObjectId'>,
  plan: Pick<AgentPlan, 'id' | 'intentId' | 'operation'>,
  binding: CanvasTargetBinding,
): string | undefined => {
  const actionId = resolvePendingGenerationActionId(run, intent, plan);
  const action = run?.steps.at(-1)?.action;
  if (
    action?.type !== 'create_video_job'
    || action.operation !== 'video_image_to_video'
    || intent.targetCanvasObjectId !== binding.objectId
    || action.sourceCanvasObjectId !== binding.objectId
    || action.sourceVersionId !== binding.versionId
    || action.sourceAssetId !== binding.assetId
  ) return undefined;
  return actionId;
};

export const resolvePendingGenerationActionId = (
  run: AgentRun | null | undefined,
  intent: Pick<UserIntent, 'id' | 'operation'>,
  plan: Pick<AgentPlan, 'id' | 'intentId' | 'operation'>,
): string | undefined => {
  if (
    !run
    || run.state !== 'AWAITING_CONFIRMATION'
    || (run.pendingConfirmation?.kind !== 'ACTION' && run.pendingConfirmation?.kind !== 'PAID_ACTION')
    || !run.pendingConfirmation.actionId
    || plan.intentId !== intent.id
    || plan.operation !== intent.operation
  ) return undefined;
  const step = run.steps.at(-1);
  const action = step?.action;
  if (
    !step
    || step.id !== run.pendingConfirmation.stepId
    || (action?.type !== 'create_image_job' && action?.type !== 'create_video_job')
    || action.actionId !== run.pendingConfirmation.actionId
    || action.intentId !== intent.id
    || action.planId !== plan.id
    || action.operation !== intent.operation
  ) return undefined;
  return action.actionId;
};
