import type { AgentAction, AgentBudgetMilestone, AgentRun, Evaluation } from './agent-runtime';
import { PROJECT_ID } from './domain';
import { projectAgentRunStorageKey } from './local-projects';

export const AGENT_RUN_PRESENTATION_STORAGE_KEY = 'elyra-core-008-agent-run-v1';
export const AGENT_RUN_PRESENTATION_SCHEMA_VERSION = 1 as const;

export interface PersistedAgentRunPresentation {
  schemaVersion: typeof AGENT_RUN_PRESENTATION_SCHEMA_VERSION;
  /** Legacy records omit this field; non-legacy projects must bind it. */
  projectId?: string;
  runId: string;
  state: AgentRun['state'];
  creationMode?: AgentRun['creationMode'];
  budgetMilestone?: AgentBudgetMilestone;
  contextSha256?: string;
  selectedObjectIds: string[];
  referencedObjectIds: string[];
  objectCount: number;
  stepIndex: number;
  currentActionType?: AgentAction['type'];
  verificationOutcome?: Evaluation['outcome'];
  verificationSummary?: string;
  remainingSteps: number;
  maxSteps: number;
  paused: boolean;
  pendingConfirmationKind?: 'ACTION' | 'PAID_ACTION' | 'USER_RESPONSE';
  budget: { capUsd: number; spentUsd: number; reservedUsd: number };
  outputIds: string[];
  stopReason?: AgentRun['stopReason'];
  failureCode?: string;
  checkpointId?: string;
  updatedAt: string;
}

/**
 * The durable browser record is a presentation/checkpoint index, not a copy of
 * the runtime transcript. User prompts, plan prose, Provider payloads, raw
 * observations and private reasoning therefore have no persistence route.
 * A reload may display this record, but never auto-resumes or re-submits work.
 */
export const agentRunPresentationRecord = (
  run: AgentRun,
  projectId = PROJECT_ID,
): PersistedAgentRunPresentation => {
  // projectAgentRunStorageKey is also the canonical project-id validator.
  projectAgentRunStorageKey(projectId);
  const latestStep = run.steps.at(-1);
  const context = run.currentObservation?.context ?? latestStep?.observationAfter?.context ?? latestStep?.observationBefore.context;
  const outputIds = latestStep?.toolResults.flatMap((result) => result.outputIds) ?? [];
  return {
    schemaVersion: AGENT_RUN_PRESENTATION_SCHEMA_VERSION,
    ...(projectId === PROJECT_ID ? {} : { projectId }),
    runId: run.id,
    state: run.state,
    ...(run.creationMode ? { creationMode: run.creationMode } : {}),
    ...(run.budgetMilestone ? { budgetMilestone: run.budgetMilestone } : {}),
    ...(context?.semanticSha256 ? { contextSha256: context.semanticSha256 } : {}),
    selectedObjectIds: canonicalIds(context?.selectedObjectIds ?? []),
    referencedObjectIds: canonicalIds(context?.objects.map((object) => object.id) ?? []),
    objectCount: context?.objects.length ?? 0,
    stepIndex: latestStep?.index ?? 0,
    ...(latestStep?.action?.type ? { currentActionType: latestStep.action.type } : {}),
    ...(latestStep?.evaluation?.outcome ? { verificationOutcome: latestStep.evaluation.outcome } : {}),
    ...(latestStep?.evaluation?.summary ? { verificationSummary: latestStep.evaluation.summary.slice(0, 160) } : {}),
    remainingSteps: run.remainingSteps,
    maxSteps: run.maxSteps,
    paused: run.paused,
    ...(run.pendingConfirmation?.kind ? { pendingConfirmationKind: run.pendingConfirmation.kind } : {}),
    budget: {
      capUsd: run.budget.capUsd,
      spentUsd: run.budget.spentUsd,
      reservedUsd: run.budget.reservedUsd,
    },
    outputIds: canonicalIds(outputIds),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.failureCode ? { failureCode: run.failureCode } : {}),
    ...(run.latestCheckpointId ? { checkpointId: run.latestCheckpointId } : {}),
    updatedAt: run.updatedAt,
  };
};

export const persistAgentRunPresentation = (
  run: AgentRun,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
  projectId = PROJECT_ID,
) => storage.setItem(projectAgentRunStorageKey(projectId), JSON.stringify(agentRunPresentationRecord(run, projectId)));

export const loadAgentRunPresentation = (
  storage: Pick<Storage, 'getItem'> = window.localStorage,
  projectId = PROJECT_ID,
): PersistedAgentRunPresentation | undefined => {
  try {
    const raw = storage.getItem(projectAgentRunStorageKey(projectId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as unknown;
    return validatePresentation(value, projectId) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const clearAgentRunPresentation = (
  storage: Pick<Storage, 'removeItem'> = window.localStorage,
  projectId = PROJECT_ID,
) => storage.removeItem(projectAgentRunStorageKey(projectId));

export const reconcilePersistedAgentRunBudget = (
  authoritative: { milestone: AgentBudgetMilestone; capUsd: number; usedUsd: number },
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
  nowIso = new Date().toISOString(),
  projectId = PROJECT_ID,
): PersistedAgentRunPresentation | undefined => {
  const record = loadAgentRunPresentation(storage, projectId);
  if (!record || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(record.state)) return undefined;
  const recordMilestone = persistedAgentRunBudgetMilestone(record);
  const capMatches = authoritative.capUsd === record.budget.capUsd
    || (recordMilestone === 'CORE009' && record.budget.capUsd === 2 && authoritative.capUsd === 5);
  if (
    !Number.isFinite(authoritative.capUsd)
    || !Number.isFinite(authoritative.usedUsd)
    || authoritative.milestone !== recordMilestone
    || !capMatches
    || authoritative.usedUsd < record.budget.spentUsd
    || authoritative.usedUsd > authoritative.capUsd
    || !Number.isFinite(Date.parse(nowIso))
  ) return undefined;
  const reconciled: PersistedAgentRunPresentation = {
    ...record,
    budgetMilestone: recordMilestone,
    budget: { capUsd: authoritative.capUsd, spentUsd: authoritative.usedUsd, reservedUsd: 0 },
    updatedAt: nowIso,
  };
  storage.setItem(projectAgentRunStorageKey(projectId), JSON.stringify(reconciled));
  return reconciled;
};

export const persistedAgentRunBudgetMilestone = (record: PersistedAgentRunPresentation): AgentBudgetMilestone => (
  record.budgetMilestone ?? (record.budget.capUsd === 2 ? 'CORE009' : 'CORE008')
);

const canonicalIds = (ids: readonly string[]) => [...new Set(ids.filter(isId))].sort((left, right) => left.localeCompare(right, 'en'));
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const validatePresentation = (
  value: unknown,
  expectedProjectId = PROJECT_ID,
): value is PersistedAgentRunPresentation => {
  try {
    projectAgentRunStorageKey(expectedProjectId);
  } catch {
    return false;
  }
  if (!isRecord(value) || value.schemaVersion !== AGENT_RUN_PRESENTATION_SCHEMA_VERSION || !isId(value.runId)) return false;
  if (expectedProjectId === PROJECT_ID) {
    if (value.projectId !== undefined && value.projectId !== PROJECT_ID) return false;
  } else if (value.projectId !== expectedProjectId) return false;
  if (!['OBSERVING', 'PLANNING', 'AWAITING_CONFIRMATION', 'EXECUTING', 'VERIFYING', 'REPLANNING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(String(value.state))) return false;
  if (value.contextSha256 !== undefined && !isSha256(value.contextSha256)) return false;
  if (!Array.isArray(value.selectedObjectIds) || !Array.isArray(value.referencedObjectIds) || !Array.isArray(value.outputIds)) return false;
  if (![...value.selectedObjectIds, ...value.referencedObjectIds, ...value.outputIds].every(isId)) return false;
  if (![value.objectCount, value.stepIndex, value.remainingSteps, value.maxSteps].every((item) => Number.isInteger(item) && Number(item) >= 0)) return false;
  if (typeof value.paused !== 'boolean' || !isRecord(value.budget)) return false;
  if (![value.budget.capUsd, value.budget.spentUsd, value.budget.reservedUsd].every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0)) return false;
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  if (value.creationMode !== undefined && !['agent', 'image', 'video'].includes(String(value.creationMode))) return false;
  if (value.budgetMilestone !== undefined && !['CORE008', 'CORE009'].includes(String(value.budgetMilestone))) return false;
  if (value.currentActionType !== undefined && !['create_image_job', 'create_video_job', 'select_objects', 'focus_objects', 'transform_objects', 'create_version', 'ask_user', 'finish'].includes(String(value.currentActionType))) return false;
  if (value.verificationOutcome !== undefined && !['DELTA', 'NO_DELTA', 'WAITING_FOR_USER', 'COMPLETE'].includes(String(value.verificationOutcome))) return false;
  if (value.pendingConfirmationKind !== undefined && !['ACTION', 'PAID_ACTION', 'USER_RESPONSE'].includes(String(value.pendingConfirmationKind))) return false;
  return true;
};
