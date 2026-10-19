import { describe, expect, it } from 'vitest';
import { captureCanvasTargetBinding, canvasTargetBindingMatches, resolvePendingImageActionId, resolvePendingVideoActionId } from './agent-target-binding';
import type { AgentPlan, UserIntent } from './agent';
import type { AgentRun } from './agent-runtime';
import { createBlankWorkspace, makeReferenceNode, makeReferenceVersion, type Workspace } from './domain';

const workspaceWithReference = (): Workspace => {
  const workspace = createBlankWorkspace();
  const node = makeReferenceNode();
  const version = makeReferenceVersion();
  return { ...workspace, nodes: [node], versions: [version], selectedIds: [node.id] };
};

describe('Canvas target binding', () => {
  it('binds the exact ready object and version', () => {
    const workspace = workspaceWithReference();
    const binding = captureCanvasTargetBinding(workspace, 'reference-demo');
    expect(binding).toEqual({ objectId: 'reference-demo', versionId: 'version-reference-demo' });
    expect(binding && canvasTargetBindingMatches(workspace, binding)).toBe(true);
  });

  it('fails closed after object deletion or version replacement', () => {
    const workspace = workspaceWithReference();
    const binding = captureCanvasTargetBinding(workspace, 'reference-demo')!;
    expect(canvasTargetBindingMatches({ ...workspace, nodes: [] }, binding)).toBe(false);
    expect(canvasTargetBindingMatches({
      ...workspace,
      nodes: workspace.nodes.map((node) => ({ ...node, versionId: 'version-replaced' })),
      versions: [{ ...workspace.versions[0], id: 'version-replaced' }],
    }, binding)).toBe(false);
  });

  it('binds and revalidates an asset-backed object', () => {
    const workspace = workspaceWithReference();
    workspace.nodes[0] = { ...workspace.nodes[0], assetId: 'asset-1' };
    workspace.assets = [{
      id: 'asset-1', kind: 'image', source: 'deterministic-mock', providerId: 'deterministic-mock',
      uri: '/assets/elyra-speaker.png', mimeType: 'image/png', prompt: 'demo', createdAt: new Date(0).toISOString(),
      metadata: { deterministic: true, width: 1024, height: 1024 },
    }];
    const binding = captureCanvasTargetBinding(workspace, 'reference-demo')!;
    expect(binding.assetId).toBe('asset-1');
    expect(canvasTargetBindingMatches({ ...workspace, assets: [] }, binding)).toBe(false);
  });

  it.each([
    ['step', (run: AgentRun) => { run.pendingConfirmation!.stepId = 'step-other'; }],
    ['action', (run: AgentRun) => { run.pendingConfirmation!.actionId = 'action-other'; }],
    ['intent', (run: AgentRun) => { const action = run.steps[0].action; if (action?.type === 'create_image_job') action.intentId = 'intent-other'; }],
    ['plan', (run: AgentRun) => { const action = run.steps[0].action; if (action?.type === 'create_image_job') action.planId = 'plan-other'; }],
    ['operation', (run: AgentRun) => { const action = run.steps[0].action; if (action?.type === 'create_image_job') action.operation = 'image_generate'; }],
  ] as const)('fails closed for a mismatched pending %s binding', (_label, mutate) => {
    const { run, intent, plan } = pendingActionFixture();
    mutate(run);
    expect(resolvePendingImageActionId(run, intent, plan)).toBeUndefined();
  });

  it('resolves only the exact pending image action represented by the visible Intent and Plan', () => {
    const { run, intent, plan } = pendingActionFixture();
    expect(resolvePendingImageActionId(run, intent, plan)).toBe('action-1');
    expect(resolvePendingImageActionId(run, intent, { ...plan, intentId: 'intent-other' })).toBeUndefined();
  });

  it('resolves a video action only when object, Asset and Version are all bound', () => {
    const { run, intent, plan } = pendingActionFixture();
    intent.operation = 'video_image_to_video';
    plan.operation = 'video_image_to_video';
    plan.providerId = 'evolink-sora-2-preview';
    const step = run.steps[0];
    step.action = {
      type: 'create_video_job', actionId: 'action-1', intentId: intent.id, planId: plan.id, operation: 'video_image_to_video',
      sourceCanvasObjectId: 'reference-demo', sourceVersionId: 'version-reference-demo', sourceAssetId: 'asset-1', paid: true, estimatedCostUsd: 1,
    };
    const binding = { objectId: 'reference-demo', versionId: 'version-reference-demo', assetId: 'asset-1' };
    expect(resolvePendingVideoActionId(run, intent, plan, binding)).toBe('action-1');
    expect(resolvePendingVideoActionId(run, intent, plan, { ...binding, assetId: 'asset-other' })).toBeUndefined();
    expect(resolvePendingImageActionId(run, intent, plan)).toBeUndefined();
  });
});

const pendingActionFixture = (): { run: AgentRun; intent: UserIntent; plan: AgentPlan } => {
  const intent: UserIntent = {
    id: 'intent-1', kind: 'modify', operation: 'image_edit_fixed_demo_reference', source: 'remote-agent',
    prompt: 'demo', normalizedPrompt: 'demo', goal: 'demo', constraints: [], targetCanvasObjectId: 'reference-demo', createdAt: new Date(0).toISOString(),
  };
  const plan: AgentPlan = {
    id: 'plan-1', intentId: intent.id, providerId: 'evolink-gpt-image-2', status: 'approved', operation: intent.operation,
    source: 'remote-agent', summary: 'demo', bullets: [], constraints: [], visualDirection: { subject: 'demo', style: 'demo', lighting: 'demo', composition: 'demo' },
    shouldFail: false, createdAt: new Date(0).toISOString(),
  };
  const at = new Date(0).toISOString();
  const run = {
    schemaVersion: 1, id: 'run-1', agent: 'CreativeDirectorAgent', publicGoal: 'demo', planSummary: 'demo', state: 'AWAITING_CONFIRMATION',
    steps: [{
      id: 'step-1', index: 1, state: 'PLANNING', observationBefore: { id: 'observation-1', capturedAt: at, semanticSha256: 'a'.repeat(64), context: { schemaVersion: 1, viewport: { x: 0, y: 0, scale: 1 }, selectedObjectIds: [], objects: [], assets: [], versions: [], semanticSha256: 'a'.repeat(64) } },
      action: { type: 'create_image_job', actionId: 'action-1', intentId: intent.id, planId: plan.id, operation: 'image_edit_fixed_demo_reference', paid: true, estimatedCostUsd: 1 },
      actionValidation: { ok: true }, toolCalls: [], toolResults: [], createdAt: at, updatedAt: at,
    }],
    maxSteps: 4, remainingSteps: 3, consecutiveNoDelta: 0, maxConsecutiveNoDelta: 2, startedAt: at, updatedAt: at,
    deadlineAt: new Date(120_000).toISOString(), budget: { capUsd: 5, spentUsd: 0, reservedUsd: 0 }, confirmedActionIds: [],
    pendingConfirmation: { kind: 'PAID_ACTION', actionId: 'action-1', stepId: 'step-1', estimatedCostUsd: 1 }, paused: false,
    checkpointSequence: 1, transitions: [{ from: 'CREATED', to: 'OBSERVING', at }],
  } satisfies AgentRun;
  return { run, intent, plan };
};
