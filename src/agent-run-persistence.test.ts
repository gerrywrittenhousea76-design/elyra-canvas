import { describe, expect, it } from 'vitest';
import type { AgentRun } from './agent-runtime';
import {
  AGENT_RUN_PRESENTATION_STORAGE_KEY,
  agentRunPresentationRecord,
  clearAgentRunPresentation,
  loadAgentRunPresentation,
  persistedAgentRunBudgetMilestone,
  persistAgentRunPresentation,
  reconcilePersistedAgentRunBudget,
} from './agent-run-persistence';
import { projectAgentRunStorageKey } from './local-projects';

const runFixture = (): AgentRun => ({
  schemaVersion: 1,
  id: 'agent-run-1',
  agent: 'CreativeDirectorAgent',
  publicGoal: 'RAW_PRIVATE_USER_PROMPT',
  planSummary: 'RAW_PRIVATE_PLAN_SUMMARY',
  state: 'AWAITING_CONFIRMATION',
  currentObservation: {
    id: 'observation-1',
    capturedAt: '2026-08-06T07:00:00.000Z',
    semanticSha256: 'a'.repeat(64),
    context: {
      schemaVersion: 1,
      viewport: { x: 0, y: 0, scale: 1 },
      selectedObjectIds: ['object-b', 'object-a'],
      objects: [
        { id: 'object-b', kind: 'generated', status: 'ready', bounds: { x: 1, y: 1, width: 10, height: 10 }, zOrder: 1 },
        { id: 'object-a', kind: 'reference', status: 'ready', bounds: { x: 0, y: 0, width: 10, height: 10 }, zOrder: 0 },
      ],
      assets: [],
      versions: [],
      semanticSha256: 'a'.repeat(64),
    },
  },
  steps: [],
  maxSteps: 4,
  remainingSteps: 4,
  consecutiveNoDelta: 0,
  maxConsecutiveNoDelta: 2,
  startedAt: '2026-08-06T07:00:00.000Z',
  updatedAt: '2026-08-06T07:00:01.000Z',
  deadlineAt: '2026-08-06T07:02:00.000Z',
  budget: { capUsd: 5, spentUsd: 0, reservedUsd: 1 },
  confirmedActionIds: [],
  pendingConfirmation: { kind: 'PAID_ACTION', actionId: 'action-1', stepId: 'step-1', estimatedCostUsd: 1 },
  paused: false,
  latestCheckpointId: 'checkpoint-1',
  checkpointSequence: 3,
  transitions: [{ from: 'CREATED', to: 'OBSERVING', at: '2026-08-06T07:00:00.000Z' }],
});

describe('CORE-008 AgentRun presentation persistence', () => {
  it('stores only the bounded UI/checkpoint index and excludes prompt, plan and raw observation data', () => {
    const record = agentRunPresentationRecord(runFixture());
    expect(record).toMatchObject({
      runId: 'agent-run-1',
      state: 'AWAITING_CONFIRMATION',
      selectedObjectIds: ['object-a', 'object-b'],
      referencedObjectIds: ['object-a', 'object-b'],
      objectCount: 2,
      remainingSteps: 4,
      checkpointId: 'checkpoint-1',
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('RAW_PRIVATE_USER_PROMPT');
    expect(serialized).not.toContain('RAW_PRIVATE_PLAN_SUMMARY');
    expect(serialized).not.toContain('viewport');
    expect(serialized).not.toContain('bounds');
    expect(serialized).not.toContain('steps');
    expect(serialized).not.toContain('transitions');
  });

  it('round-trips a valid allowlisted record and rejects tampering', () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    };
    persistAgentRunPresentation(runFixture(), storage);
    expect(loadAgentRunPresentation(storage)).toEqual(agentRunPresentationRecord(runFixture()));
    values.set(AGENT_RUN_PRESENTATION_STORAGE_KEY, JSON.stringify({ ...agentRunPresentationRecord(runFixture()), contextSha256: 'bad' }));
    expect(loadAgentRunPresentation(storage)).toBeUndefined();
    clearAgentRunPresentation(storage);
    expect(values.has(AGENT_RUN_PRESENTATION_STORAGE_KEY)).toBe(false);
  });

  it('allows a free action confirmation marker without persisting any capability token', () => {
    const run = runFixture();
    run.pendingConfirmation = { kind: 'ACTION', actionId: 'action-free', stepId: 'step-free' };
    run.budget = { capUsd: 0, spentUsd: 0, reservedUsd: 0 };
    const record = agentRunPresentationRecord(run);
    expect(record.pendingConfirmationKind).toBe('ACTION');
    expect(JSON.stringify(record)).not.toContain('token');
  });

  it('persists the allowlisted video mode and action label without source payloads', () => {
    const run = runFixture();
    run.creationMode = 'video';
    run.steps = [{
      id: 'step-video', index: 1, state: 'PLANNING', observationBefore: run.currentObservation!,
      action: { type: 'create_video_job', actionId: 'video-1', intentId: 'intent-1', planId: 'plan-1', operation: 'video_image_to_video', sourceCanvasObjectId: 'object-a', sourceVersionId: 'version-a', sourceAssetId: 'asset-a', paid: true, estimatedCostUsd: 1 },
      actionValidation: { ok: true }, toolCalls: [], toolResults: [], createdAt: run.startedAt, updatedAt: run.updatedAt,
    }];
    const record = agentRunPresentationRecord(run);
    expect(record).toMatchObject({ creationMode: 'video', currentActionType: 'create_video_job' });
    expect(JSON.stringify(record)).not.toContain('sourceAssetId');
    const values = new Map([[AGENT_RUN_PRESENTATION_STORAGE_KEY, JSON.stringify(record)]]);
    expect(loadAgentRunPresentation({ getItem: (key) => values.get(key) ?? null })).toEqual(record);
  });

  it('reconciles only a terminal presentation with a non-regressing authoritative milestone ledger', () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
    };
    const terminal = runFixture();
    terminal.state = 'CANCELLED';
    terminal.stopReason = 'USER_CANCELLED';
    terminal.pendingConfirmation = undefined;
    terminal.budget = { capUsd: 5, spentUsd: 0.1, reservedUsd: 1 };
    storage.setItem(AGENT_RUN_PRESENTATION_STORAGE_KEY, JSON.stringify(agentRunPresentationRecord(terminal)));

    expect(reconcilePersistedAgentRunBudget({ milestone: 'CORE008', capUsd: 5, usedUsd: 0.3 }, storage, '2026-08-07T00:00:00.000Z')).toMatchObject({
      state: 'CANCELLED',
      budgetMilestone: 'CORE008',
      budget: { capUsd: 5, spentUsd: 0.3, reservedUsd: 0 },
      updatedAt: '2026-08-07T00:00:00.000Z',
    });
    expect(reconcilePersistedAgentRunBudget({ milestone: 'CORE008', capUsd: 5, usedUsd: 0.2 }, storage)).toBeUndefined();

    const active = runFixture();
    storage.setItem(AGENT_RUN_PRESENTATION_STORAGE_KEY, JSON.stringify(agentRunPresentationRecord(active)));
    expect(reconcilePersistedAgentRunBudget({ milestone: 'CORE008', capUsd: 5, usedUsd: 0.4 }, storage)).toBeUndefined();
  });

  it('migrates a legacy CORE-009 two-dollar presentation to the approved five-dollar ledger without confusing CORE-008', () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
    };
    const legacy = runFixture();
    legacy.state = 'FAILED';
    legacy.creationMode = 'video';
    legacy.budget = { capUsd: 2, spentUsd: 1.0038556, reservedUsd: 0 };
    const legacyRecord = agentRunPresentationRecord(legacy);
    expect(legacyRecord.budgetMilestone).toBeUndefined();
    expect(persistedAgentRunBudgetMilestone(legacyRecord)).toBe('CORE009');
    storage.setItem(AGENT_RUN_PRESENTATION_STORAGE_KEY, JSON.stringify(legacyRecord));

    expect(reconcilePersistedAgentRunBudget({ milestone: 'CORE008', capUsd: 5, usedUsd: 1.0038556 }, storage)).toBeUndefined();
    expect(reconcilePersistedAgentRunBudget({ milestone: 'CORE009', capUsd: 5, usedUsd: 1.0038556 }, storage, '2026-08-11T01:13:01.000Z')).toMatchObject({
      budgetMilestone: 'CORE009',
      budget: { capUsd: 5, spentUsd: 1.0038556, reservedUsd: 0 },
      updatedAt: '2026-08-11T01:13:01.000Z',
    });
  });

  it('keeps explicit CORE-009 and CORE-008 presentations isolated when both ledgers have the same five-dollar cap', () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
    };
    const terminal = runFixture();
    terminal.state = 'COMPLETED';
    terminal.creationMode = 'video';
    terminal.budgetMilestone = 'CORE009';
    terminal.budget = { capUsd: 5, spentUsd: 1.1, reservedUsd: 0 };
    storage.setItem(AGENT_RUN_PRESENTATION_STORAGE_KEY, JSON.stringify(agentRunPresentationRecord(terminal)));

    expect(reconcilePersistedAgentRunBudget({ milestone: 'CORE008', capUsd: 5, usedUsd: 4.1 }, storage)).toBeUndefined();
    expect(reconcilePersistedAgentRunBudget({ milestone: 'CORE009', capUsd: 5, usedUsd: 1.2 }, storage, '2026-08-11T01:30:00.000Z')).toMatchObject({
      budgetMilestone: 'CORE009',
      budget: { capUsd: 5, spentUsd: 1.2, reservedUsd: 0 },
    });
  });

  it('isolates presentation and reconciliation records by local project id', () => {
    const projectA = 'elyra-project-agent-a';
    const projectB = 'elyra-project-agent-b';
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    };
    const runA = runFixture();
    runA.id = 'agent-run-project-a';
    const runB = runFixture();
    runB.id = 'agent-run-project-b';

    persistAgentRunPresentation(runA, storage, projectA);
    persistAgentRunPresentation(runB, storage, projectB);
    expect(values.has(AGENT_RUN_PRESENTATION_STORAGE_KEY)).toBe(false);
    expect(loadAgentRunPresentation(storage, projectA)).toMatchObject({ projectId: projectA, runId: runA.id });
    expect(loadAgentRunPresentation(storage, projectB)).toMatchObject({ projectId: projectB, runId: runB.id });

    const terminalA = runA;
    terminalA.state = 'COMPLETED';
    terminalA.pendingConfirmation = undefined;
    terminalA.budget = { capUsd: 5, spentUsd: 0.1, reservedUsd: 0 };
    persistAgentRunPresentation(terminalA, storage, projectA);
    expect(reconcilePersistedAgentRunBudget(
      { milestone: 'CORE008', capUsd: 5, usedUsd: 0.2 },
      storage,
      '2026-08-15T03:00:00.000Z',
      projectA,
    )).toMatchObject({ projectId: projectA, budget: { spentUsd: 0.2 } });
    expect(loadAgentRunPresentation(storage, projectB)?.runId).toBe(runB.id);

    clearAgentRunPresentation(storage, projectA);
    expect(loadAgentRunPresentation(storage, projectA)).toBeUndefined();
    expect(loadAgentRunPresentation(storage, projectB)?.runId).toBe(runB.id);
  });

  it('fails closed when a record is copied across project keys or an invalid id is used', () => {
    const projectA = 'elyra-project-copy-a';
    const projectB = 'elyra-project-copy-b';
    const recordA = agentRunPresentationRecord(runFixture(), projectA);
    const values = new Map<string, string>([
      [projectAgentRunStorageKey(projectB), JSON.stringify(recordA)],
    ]);
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    };
    expect(loadAgentRunPresentation(storage, projectB)).toBeUndefined();
    expect(() => persistAgentRunPresentation(runFixture(), storage, '../escape')).toThrow('LOCAL_PROJECT_ID_INVALID');
    expect(loadAgentRunPresentation(storage, '../escape')).toBeUndefined();
  });
});
