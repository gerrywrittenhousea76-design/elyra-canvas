import type { CreationMode } from './agent';
import type { CanvasContextGraphSnapshot } from './canvas-context';

export type AgentRunState =
  | 'OBSERVING'
  | 'PLANNING'
  | 'AWAITING_CONFIRMATION'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REPLANNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type AgentStopReason =
  | 'FINISHED'
  | 'MAX_STEPS'
  | 'NO_PROGRESS'
  | 'DEADLINE_EXCEEDED'
  | 'INVALID_ACTION'
  | 'ACTION_FAILED'
  | 'RETRY_EXHAUSTED'
  | 'CONFIRMATION_DENIED'
  | 'BUDGET_DENIED'
  | 'BUDGET_EXCEEDED'
  | 'USER_CANCELLED';

export interface CreateImageJobAction {
  type: 'create_image_job';
  actionId: string;
  intentId: string;
  planId: string;
  operation: 'image_generate' | 'image_edit_fixed_demo_reference' | 'image_edit_user_reference';
  paid: boolean;
  estimatedCostUsd: number;
}

export interface CreateVideoJobAction {
  type: 'create_video_job';
  actionId: string;
  intentId: string;
  planId: string;
  operation: 'video_image_to_video';
  sourceCanvasObjectId: string;
  sourceVersionId: string;
  sourceAssetId: string;
  paid: boolean;
  estimatedCostUsd: number;
}

export interface SelectObjectsAction {
  type: 'select_objects';
  actionId: string;
  objectIds: string[];
}

export interface FocusObjectsAction {
  type: 'focus_objects';
  actionId: string;
  objectIds: string[];
}

export interface TransformObjectsAction {
  type: 'transform_objects';
  actionId: string;
  expectedSemanticSha256: string;
  transforms: Array<{ objectId: string; x: number; y: number; width: number; height: number }>;
}

export interface CreateVersionAction {
  type: 'create_version';
  actionId: string;
  parentCanvasObjectId: string;
  parentVersionId: string;
  jobId: string;
}

export interface AskUserAction {
  type: 'ask_user';
  actionId: string;
  prompt: string;
}

export interface FinishAction {
  type: 'finish';
  actionId: string;
  summary: string;
}

export type AgentAction =
  | CreateImageJobAction
  | CreateVideoJobAction
  | SelectObjectsAction
  | FocusObjectsAction
  | TransformObjectsAction
  | CreateVersionAction
  | AskUserAction
  | FinishAction;

export interface Observation {
  id: string;
  capturedAt: string;
  context: CanvasContextGraphSnapshot;
  semanticSha256: string;
}

export interface ToolCall {
  id: string;
  actionId: string;
  actionType: AgentAction['type'];
  idempotencyKey: string;
  attempt: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  startedAt?: string;
  completedAt?: string;
}

export interface ToolResult {
  id: string;
  toolCallId: string;
  ok: boolean;
  changed: boolean;
  summary: string;
  deltaSha256?: string;
  outputIds: string[];
  costUsd: number;
  retryable: boolean;
  errorCode?: string;
  completedAt: string;
}

export interface Evaluation {
  id: string;
  beforeSha256: string;
  afterSha256: string;
  verifiedDelta: boolean;
  outcome: 'DELTA' | 'NO_DELTA' | 'WAITING_FOR_USER' | 'COMPLETE';
  summary: string;
  evaluatedAt: string;
}

export interface AgentStep {
  id: string;
  index: number;
  state: AgentRunState;
  observationBefore: Observation;
  action?: AgentAction;
  actionValidation?: { ok: true } | { ok: false; code: string };
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  observationAfter?: Observation;
  evaluation?: Evaluation;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStateTransition {
  from: AgentRunState | 'CREATED';
  to: AgentRunState;
  at: string;
}

export interface AgentBudget {
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
}

export type AgentBudgetMilestone = 'CORE008' | 'CORE009';

export type PendingConfirmation =
  | {
      kind: 'ACTION' | 'PAID_ACTION';
      actionId: string;
      stepId: string;
      estimatedCostUsd?: number;
    }
  | {
      kind: 'USER_RESPONSE';
      actionId: string;
      stepId: string;
      publicPrompt: string;
    };

export interface AgentRun {
  schemaVersion: 1;
  id: string;
  agent: 'CreativeDirectorAgent';
  publicGoal: string;
  planSummary: string;
  creationMode?: CreationMode;
  generationPolicy?: 'single-xor';
  budgetMilestone?: AgentBudgetMilestone;
  state: AgentRunState;
  steps: AgentStep[];
  currentObservation?: Observation;
  maxSteps: number;
  remainingSteps: number;
  consecutiveNoDelta: number;
  maxConsecutiveNoDelta: 2;
  startedAt: string;
  updatedAt: string;
  deadlineAt: string;
  budget: AgentBudget;
  confirmedActionIds: string[];
  pendingConfirmation?: PendingConfirmation;
  paused: boolean;
  stopReason?: AgentStopReason;
  failureCode?: string;
  latestCheckpointId?: string;
  checkpointSequence: number;
  transitions: AgentStateTransition[];
}

export interface AgentCheckpoint {
  schemaVersion: 1;
  id: string;
  runId: string;
  sequence: number;
  createdAt: string;
  runSha256: string;
  run: AgentRun;
}

export interface AgentPlanningInput {
  runId: string;
  publicGoal: string;
  planSummary: string;
  currentStep: number;
  remainingSteps: number;
  observation: Observation;
  lastEvaluation?: Evaluation;
  /** One transient, explicit answer to the immediately preceding ask_user action. */
  userResponse?: string;
}

export interface AgentPlannerPort {
  nextAction(input: AgentPlanningInput, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentObserverPort {
  observe(signal?: AbortSignal): Promise<CanvasContextGraphSnapshot>;
}

export type ActionExecutionReceipt =
  | {
      ok: true;
      changed: boolean;
      summary: string;
      deltaSha256?: string;
      outputIds?: string[];
      costUsd?: number;
    }
  | {
      ok: false;
      summary: string;
      errorCode: string;
      retryable: boolean;
      costUsd?: number;
    };

export interface AgentActionExecutorPort {
  /**
   * Implementations de-duplicate concurrent/repeated calls by `idempotencyKey`
   * for the lifetime of the active runtime. This runtime never replays an
   * EXECUTING checkpoint after process loss unless a future implementation
   * supplies a durable receipt boundary; it fails closed instead.
   */
  executeOnce(input: {
    runId: string;
    stepId: string;
    idempotencyKey: string;
    action: AgentAction;
    signal: AbortSignal;
  }): Promise<ActionExecutionReceipt>;
}

export interface AgentCheckpointStore {
  save(checkpoint: AgentCheckpoint): Promise<void>;
  load(runId: string): Promise<AgentCheckpoint | undefined>;
}

export interface CreativeDirectorRuntimeDependencies {
  observer: AgentObserverPort;
  planner: AgentPlannerPort;
  executor: AgentActionExecutorPort;
  checkpointStore: AgentCheckpointStore;
  now?: () => number;
  idFactory?: (prefix: string) => string;
}

export interface StartAgentRunInput {
  publicGoal: string;
  planSummary: string;
  budgetCapUsd: number;
  budgetSpentUsd?: number;
  creationMode?: CreationMode;
  generationPolicy?: 'single-xor';
  budgetMilestone?: AgentBudgetMilestone;
  maxSteps?: number;
  deadlineMs?: number;
}

export interface ContinueAgentRunOptions {
  /** Kept only in memory long enough for the next planner call; never checkpointed. */
  userResponse?: string;
}

const TERMINAL_STATES = new Set<AgentRunState>(['COMPLETED', 'FAILED', 'CANCELLED']);
const ACTION_TYPES = new Set<AgentAction['type']>([
  'create_image_job',
  'create_video_job',
  'select_objects',
  'focus_objects',
  'transform_objects',
  'create_version',
  'ask_user',
  'finish',
]);

const LEGAL_TRANSITIONS: Readonly<Record<AgentRunState, readonly AgentRunState[]>> = {
  OBSERVING: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['AWAITING_CONFIRMATION', 'EXECUTING', 'FAILED', 'CANCELLED'],
  AWAITING_CONFIRMATION: ['EXECUTING', 'REPLANNING', 'FAILED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['OBSERVING', 'REPLANNING', 'AWAITING_CONFIRMATION', 'COMPLETED', 'FAILED', 'CANCELLED'],
  REPLANNING: ['OBSERVING', 'PLANNING', 'AWAITING_CONFIRMATION', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

class AgentActionValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentActionValidationError';
  }
}

class AgentDeadlineExceededError extends Error {
  constructor() {
    super('RUN_DEADLINE_EXCEEDED');
    this.name = 'AgentDeadlineExceededError';
  }
}

export class CreativeDirectorRuntime {
  private readonly now: () => number;
  private readonly idFactory: (prefix: string) => string;
  private readonly activeRuns = new Map<string, AgentRun>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly drivePromises = new Map<string, Promise<AgentRun>>();
  private readonly checkpointTails = new Map<string, Promise<void>>();
  private readonly pendingUserResponses = new Map<string, string>();

  constructor(private readonly dependencies: CreativeDirectorRuntimeDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.idFactory = dependencies.idFactory ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`);
  }

  async start(input: StartAgentRunInput): Promise<AgentRun> {
    const publicGoal = requirePublicText(input.publicGoal, 'PUBLIC_GOAL_INVALID');
    const planSummary = requirePublicText(input.planSummary, 'PLAN_SUMMARY_INVALID');
    const capUsd = requireMoney(input.budgetCapUsd, 'BUDGET_CAP_INVALID', true);
    const spentUsd = requireMoney(input.budgetSpentUsd ?? 0, 'BUDGET_SPENT_INVALID', true);
    if (spentUsd > capUsd) throw new Error('BUDGET_SPENT_EXCEEDS_CAP');
    const maxSteps = input.maxSteps ?? 4;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) throw new Error('MAX_STEPS_INVALID');
    const deadlineMs = input.deadlineMs ?? 120_000;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 3_600_000) throw new Error('DEADLINE_INVALID');

    const started = this.now();
    const startedAt = toIso(started);
    const run: AgentRun = {
      schemaVersion: 1,
      id: this.idFactory('agent-run'),
      agent: 'CreativeDirectorAgent',
      publicGoal,
      planSummary,
      ...(input.creationMode ? { creationMode: input.creationMode } : {}),
      ...(input.generationPolicy ? { generationPolicy: input.generationPolicy } : {}),
      ...(input.budgetMilestone ? { budgetMilestone: input.budgetMilestone } : {}),
      state: 'OBSERVING',
      steps: [],
      maxSteps,
      remainingSteps: maxSteps,
      consecutiveNoDelta: 0,
      maxConsecutiveNoDelta: 2,
      startedAt,
      updatedAt: startedAt,
      deadlineAt: toIso(started + deadlineMs),
      budget: { capUsd, spentUsd, reservedUsd: 0 },
      confirmedActionIds: [],
      paused: false,
      checkpointSequence: 0,
      transitions: [{ from: 'CREATED', to: 'OBSERVING', at: startedAt }],
    };
    this.activeRuns.set(run.id, run);
    await this.checkpoint(run);
    return this.drive(run);
  }

  async continueRun(run: AgentRun, options: ContinueAgentRunOptions = {}): Promise<AgentRun> {
    assertSerializableRun(run);
    run = this.activeRuns.get(run.id) ?? run;
    this.activeRuns.set(run.id, run);
    if (TERMINAL_STATES.has(run.state)) return run;
    run.paused = false;
    if (run.state === 'AWAITING_CONFIRMATION') {
      if (run.pendingConfirmation?.kind === 'PAID_ACTION' || run.pendingConfirmation?.kind === 'ACTION') return run;
      if (options.userResponse === undefined) return run;
      const userResponse = requirePublicText(options.userResponse, 'USER_RESPONSE_INVALID');
      this.pendingUserResponses.set(run.id, userResponse);
      run.pendingConfirmation = undefined;
      this.transition(run, 'REPLANNING');
      await this.checkpoint(run);
    }
    await this.awaitActiveDrive(run.id);
    if (TERMINAL_STATES.has(run.state) || run.paused || run.state === 'AWAITING_CONFIRMATION') return run;
    return this.drive(run);
  }

  async confirmAction(run: AgentRun, approved: boolean): Promise<AgentRun> {
    assertSerializableRun(run);
    run = this.activeRuns.get(run.id) ?? run;
    this.activeRuns.set(run.id, run);
    if (TERMINAL_STATES.has(run.state)) return run;
    const pending = run.pendingConfirmation;
    const step = currentStep(run);
    if (
      run.state !== 'AWAITING_CONFIRMATION'
      || (pending?.kind !== 'ACTION' && pending?.kind !== 'PAID_ACTION')
      || !pending.actionId
      || !step?.action
    ) {
      throw new Error('NO_ACTION_AWAITING_CONFIRMATION');
    }
    if (step.id !== pending.stepId || step.action.actionId !== pending.actionId || !isGenerationJobAction(step.action)) throw new Error('CONFIRMATION_ACTION_MISMATCH');
    const paid = step.action.paid;
    if ((paid && pending.kind !== 'PAID_ACTION') || (!paid && pending.kind !== 'ACTION')) throw new Error('CONFIRMATION_KIND_MISMATCH');
    if (!approved) {
      run.pendingConfirmation = undefined;
      return this.fail(run, 'CONFIRMATION_DENIED', paid ? 'PAID_ACTION_REJECTED' : 'ACTION_REJECTED');
    }
    if (paid) {
      const estimate = pending.estimatedCostUsd ?? step.action.estimatedCostUsd;
      if (run.budget.spentUsd + run.budget.reservedUsd + estimate > run.budget.capUsd) {
        run.pendingConfirmation = undefined;
        return this.fail(run, 'BUDGET_DENIED', 'MILESTONE_BUDGET_CAP_EXCEEDED');
      }
      run.budget.reservedUsd = roundMoney(run.budget.reservedUsd + estimate);
    }
    const capabilityId = confirmationCapabilityId(step.id, step.action.actionId);
    if (!run.confirmedActionIds.includes(capabilityId)) run.confirmedActionIds.push(capabilityId);
    run.pendingConfirmation = undefined;
    this.transition(run, 'EXECUTING');
    await this.checkpoint(run);
    await this.awaitActiveDrive(run.id);
    if (TERMINAL_STATES.has(run.state) || run.paused) return run;
    return this.drive(run);
  }

  async confirmPaidAction(run: AgentRun, approved: boolean): Promise<AgentRun> {
    assertSerializableRun(run);
    const activeRun = this.activeRuns.get(run.id) ?? run;
    if (!TERMINAL_STATES.has(activeRun.state) && activeRun.pendingConfirmation?.kind !== 'PAID_ACTION') {
      throw new Error('NO_PAID_ACTION_AWAITING_CONFIRMATION');
    }
    return this.confirmAction(activeRun, approved);
  }

  async pause(run: AgentRun): Promise<AgentRun> {
    assertSerializableRun(run);
    run = this.activeRuns.get(run.id) ?? run;
    if (TERMINAL_STATES.has(run.state)) return run;
    run.paused = true;
    run.updatedAt = toIso(this.now());
    this.activeRuns.set(run.id, run);
    await this.checkpoint(run);
    return run;
  }

  async cancel(run: AgentRun): Promise<AgentRun> {
    assertSerializableRun(run);
    run = this.activeRuns.get(run.id) ?? run;
    this.activeRuns.set(run.id, run);
    if (TERMINAL_STATES.has(run.state)) return run;
    this.abortControllers.get(run.id)?.abort();
    this.pendingUserResponses.delete(run.id);
    run.pendingConfirmation = undefined;
    run.budget.reservedUsd = 0;
    run.stopReason = 'USER_CANCELLED';
    this.transition(run, 'CANCELLED');
    await this.checkpoint(run);
    return run;
  }

  /**
   * A paid Provider may settle after the user has stopped local waiting. The
   * server ledger is authoritative, so terminal runs may be reconciled without
   * reviving execution or accepting a late tool result.
   */
  async reconcileAuthoritativeTerminalSpend(runId: string, authoritativeSpentUsd: number): Promise<AgentRun | undefined> {
    requireIdentifier(runId, 'RUN_ID_INVALID');
    const spentUsd = requireMoney(authoritativeSpentUsd, 'BUDGET_SPENT_INVALID', true);
    const run = this.activeRuns.get(runId);
    if (!run || !TERMINAL_STATES.has(run.state)) return undefined;
    if (spentUsd > run.budget.capUsd) throw new Error('AUTHORITATIVE_SPEND_EXCEEDS_CAP');
    if (spentUsd < run.budget.spentUsd) throw new Error('AUTHORITATIVE_SPEND_REGRESSION');
    if (spentUsd === run.budget.spentUsd && run.budget.reservedUsd === 0) return run;
    run.budget.spentUsd = spentUsd;
    run.budget.reservedUsd = 0;
    run.updatedAt = toIso(this.now());
    await this.checkpoint(run);
    return run;
  }

  async load(runId: string): Promise<AgentRun | undefined> {
    requireIdentifier(runId, 'RUN_ID_INVALID');
    await this.checkpointTails.get(runId);
    const checkpoint = await this.dependencies.checkpointStore.load(runId);
    if (!checkpoint) return undefined;
    await validateCheckpoint(checkpoint);
    const run = clone(checkpoint.run);
    this.activeRuns.set(run.id, run);
    return run;
  }

  async resume(runId: string, options: ContinueAgentRunOptions = {}): Promise<AgentRun | undefined> {
    const run = await this.load(runId);
    if (!run) return undefined;
    if (run.state === 'EXECUTING') {
      return this.fail(run, 'ACTION_FAILED', 'RESUME_EXECUTING_CHECKPOINT_UNSAFE');
    }
    const lastStep = currentStep(run);
    if (
      run.state === 'REPLANNING'
      && lastStep?.action?.type === 'ask_user'
      && lastStep.evaluation?.outcome === 'WAITING_FOR_USER'
    ) {
      run.pendingConfirmation = {
        kind: 'USER_RESPONSE',
        actionId: lastStep.action.actionId,
        stepId: lastStep.id,
        publicPrompt: lastStep.action.prompt,
      };
      this.transition(run, 'AWAITING_CONFIRMATION');
      await this.checkpoint(run);
      if (options.userResponse === undefined) return run;
    }
    return this.continueRun(run, options);
  }

  private drive(run: AgentRun): Promise<AgentRun> {
    const active = this.drivePromises.get(run.id);
    if (active) return active;
    let drivePromise: Promise<AgentRun>;
    drivePromise = this.driveLoop(run).finally(() => {
      if (this.drivePromises.get(run.id) === drivePromise) this.drivePromises.delete(run.id);
    });
    this.drivePromises.set(run.id, drivePromise);
    return drivePromise;
  }

  private async awaitActiveDrive(runId: string): Promise<void> {
    const active = this.drivePromises.get(runId);
    if (active) await active;
  }

  private async driveLoop(run: AgentRun): Promise<AgentRun> {
    while (!TERMINAL_STATES.has(run.state) && !run.paused) {
      if (this.deadlineExceeded(run)) return this.fail(run, 'DEADLINE_EXCEEDED', 'RUN_DEADLINE_EXCEEDED');
      if (run.state === 'AWAITING_CONFIRMATION') return run;

      if (run.state === 'REPLANNING') {
        this.transition(run, 'OBSERVING');
        await this.checkpoint(run);
        continue;
      }

      if (run.state === 'OBSERVING') {
        if (run.steps.length >= run.maxSteps) return this.fail(run, 'MAX_STEPS', 'RUN_MAX_STEPS_REACHED');
        try {
          run.currentObservation = await this.observe(run);
        } catch (error) {
          if (TERMINAL_STATES.has(run.state as AgentRunState)) return run;
          if (error instanceof AgentDeadlineExceededError) return this.fail(run, 'DEADLINE_EXCEEDED', 'RUN_DEADLINE_EXCEEDED');
          return this.fail(run, 'ACTION_FAILED', 'OBSERVATION_FAILED');
        }
        this.transition(run, 'PLANNING');
        await this.checkpoint(run);
        continue;
      }

      if (run.state === 'PLANNING') {
        const observation = run.currentObservation;
        if (!observation) return this.fail(run, 'ACTION_FAILED', 'OBSERVATION_MISSING');
        let action: AgentAction;
        const userResponse = this.pendingUserResponses.get(run.id);
        try {
          const raw = await this.withDeadline(run, (signal) => this.dependencies.planner.nextAction({
              runId: run.id,
              publicGoal: run.publicGoal,
              planSummary: run.planSummary,
              currentStep: run.steps.length + 1,
              remainingSteps: run.maxSteps - run.steps.length,
              observation,
              lastEvaluation: run.steps.at(-1)?.evaluation,
              ...(userResponse ? { userResponse } : {}),
            }, signal));
          action = parseAgentAction(raw);
          validateGenerationActionForRun(run, observation, action);
        } catch (error) {
          if (TERMINAL_STATES.has(run.state as AgentRunState)) return run;
          if (error instanceof AgentDeadlineExceededError) return this.fail(run, 'DEADLINE_EXCEEDED', 'RUN_DEADLINE_EXCEEDED');
          const at = toIso(this.now());
          const validationCode = error instanceof AgentActionValidationError ? error.code : 'PLANNER_FAILED';
          const step: AgentStep = {
            id: this.idFactory('agent-step'),
            index: run.steps.length + 1,
            state: 'PLANNING',
            observationBefore: observation,
            actionValidation: { ok: false, code: validationCode },
            toolCalls: [],
            toolResults: [],
            createdAt: at,
            updatedAt: at,
          };
          run.steps.push(step);
          run.remainingSteps = Math.max(0, run.maxSteps - run.steps.length);
          return this.fail(run, 'INVALID_ACTION', validationCode);
        } finally {
          if (userResponse) this.pendingUserResponses.delete(run.id);
        }

        const at = toIso(this.now());
        const step: AgentStep = {
          id: this.idFactory('agent-step'),
          index: run.steps.length + 1,
          state: 'PLANNING',
          observationBefore: observation,
          action,
          actionValidation: { ok: true },
          toolCalls: [],
          toolResults: [],
          createdAt: at,
          updatedAt: at,
        };
        run.steps.push(step);
        run.remainingSteps = Math.max(0, run.maxSteps - run.steps.length);
        const capabilityId = confirmationCapabilityId(step.id, action.actionId);
        if (isGenerationJobAction(action) && !run.confirmedActionIds.includes(capabilityId)) {
          if (action.paid) {
            if (run.budget.spentUsd + run.budget.reservedUsd + action.estimatedCostUsd > run.budget.capUsd) {
              return this.fail(run, 'BUDGET_DENIED', 'MILESTONE_BUDGET_CAP_EXCEEDED');
            }
            run.pendingConfirmation = { kind: 'PAID_ACTION', actionId: action.actionId, stepId: step.id, estimatedCostUsd: action.estimatedCostUsd };
          } else {
            run.pendingConfirmation = { kind: 'ACTION', actionId: action.actionId, stepId: step.id };
          }
          this.transition(run, 'AWAITING_CONFIRMATION');
        } else {
          this.transition(run, 'EXECUTING');
        }
        await this.checkpoint(run);
        continue;
      }

      if (run.state === 'EXECUTING') {
        const step = currentStep(run);
        if (!step?.action) return this.fail(run, 'ACTION_FAILED', 'ACTION_MISSING');
        if (isGenerationJobAction(step.action) && !run.confirmedActionIds.includes(confirmationCapabilityId(step.id, step.action.actionId))) {
          return this.fail(run, 'ACTION_FAILED', step.action.paid ? 'PAID_ACTION_NOT_CONFIRMED' : 'ACTION_NOT_CONFIRMED');
        }
        const result = await this.executeCurrentAction(run, step);
        if (TERMINAL_STATES.has(run.state)) return run;
        if (!result) continue;
        if (!result.ok) {
          const paid = isGenerationJobAction(step.action) && step.action.paid;
          if (!paid && result.retryable && step.toolCalls.length < 2) {
            await this.checkpoint(run);
            continue;
          }
          return this.fail(run, result.retryable && !paid ? 'RETRY_EXHAUSTED' : 'ACTION_FAILED', result.errorCode ?? 'ACTION_EXECUTION_FAILED');
        }
        this.transition(run, 'VERIFYING');
        await this.checkpoint(run);
        continue;
      }

      if (run.state === 'VERIFYING') {
        const step = currentStep(run);
        const action = step?.action;
        const toolResult = step?.toolResults.at(-1);
        if (!step || !action || !toolResult?.ok) return this.fail(run, 'ACTION_FAILED', 'VERIFICATION_INPUT_MISSING');
        try {
          step.observationAfter = await this.observe(run);
        } catch (error) {
          if (TERMINAL_STATES.has(run.state as AgentRunState)) return run;
          if (error instanceof AgentDeadlineExceededError) return this.fail(run, 'DEADLINE_EXCEEDED', 'RUN_DEADLINE_EXCEEDED');
          return this.fail(run, 'ACTION_FAILED', 'VERIFICATION_OBSERVATION_FAILED');
        }
        const evaluation = this.evaluate(step, action, toolResult);
        step.evaluation = evaluation;
        step.state = 'VERIFYING';
        step.updatedAt = evaluation.evaluatedAt;
        run.currentObservation = step.observationAfter;

        if (evaluation.outcome === 'COMPLETE') {
          run.stopReason = 'FINISHED';
          this.transition(run, 'COMPLETED');
        } else if (evaluation.outcome === 'WAITING_FOR_USER') {
          if (action.type !== 'ask_user') return this.fail(run, 'ACTION_FAILED', 'USER_PROMPT_ACTION_MISMATCH');
          run.pendingConfirmation = { kind: 'USER_RESPONSE', actionId: action.actionId, stepId: step.id, publicPrompt: action.prompt };
          this.transition(run, 'AWAITING_CONFIRMATION');
        } else if (evaluation.verifiedDelta) {
          run.consecutiveNoDelta = 0;
          this.transition(run, 'OBSERVING');
        } else {
          run.consecutiveNoDelta += 1;
          if (run.consecutiveNoDelta >= run.maxConsecutiveNoDelta) {
            return this.fail(run, 'NO_PROGRESS', 'TWO_CONSECUTIVE_NO_DELTA_STEPS');
          }
          this.transition(run, 'REPLANNING');
        }
        await this.checkpoint(run);
        continue;
      }

      return this.fail(run, 'ACTION_FAILED', 'UNHANDLED_RUNTIME_STATE');
    }
    return run;
  }

  private async observe(run: AgentRun): Promise<Observation> {
    const context = await this.withDeadline(run, (signal) => this.dependencies.observer.observe(signal));
    if (!context || context.schemaVersion !== 1 || !isSha256(context.semanticSha256)) throw new Error('CONTEXT_SNAPSHOT_INVALID');
    return {
      id: this.idFactory('observation'),
      capturedAt: toIso(this.now()),
      context,
      semanticSha256: context.semanticSha256,
    };
  }

  private async executeCurrentAction(run: AgentRun, step: AgentStep): Promise<ToolResult | undefined> {
    const action = step.action;
    if (!action) return undefined;
    const attempt = step.toolCalls.length + 1;
    let toolCall = step.toolCalls.at(-1);
    // A `running` call can appear in a checkpoint created by an overlapping
    // pause. Resume it with the same idempotency key; never manufacture a new
    // attempt merely because the process did not persist its receipt yet.
    if (!toolCall || (toolCall.status !== 'pending' && toolCall.status !== 'running')) {
      toolCall = {
        id: this.idFactory('tool-call'),
        actionId: action.actionId,
        actionType: action.type,
        idempotencyKey: `${run.id}:${step.id}:${action.actionId}:attempt-${attempt}`,
        attempt,
        status: 'pending',
      };
      step.toolCalls.push(toolCall);
      step.updatedAt = toIso(this.now());
      await this.checkpoint(run);
    }

    toolCall.status = 'running';
    toolCall.startedAt = toIso(this.now());
    let receipt: ActionExecutionReceipt;
    try {
      receipt = await this.withDeadline(run, (signal) => this.dependencies.executor.executeOnce({
          runId: run.id,
          stepId: step.id,
          idempotencyKey: toolCall.idempotencyKey,
          action,
          signal,
        }));
    } catch (error) {
      if (run.state === 'CANCELLED') return undefined;
      if (error instanceof AgentDeadlineExceededError) {
        await this.fail(run, 'DEADLINE_EXCEEDED', 'RUN_DEADLINE_EXCEEDED');
        return undefined;
      }
      receipt = {
        ok: false,
        summary: '动作执行失败。',
        errorCode: 'ACTION_EXECUTOR_ERROR',
        retryable: false,
      };
    }

    // Cancellation wins over a late executor receipt. No post-cancel domain
    // record or checkpoint is created here.
    if (run.state === 'CANCELLED') return undefined;
    if (this.deadlineExceeded(run)) return this.fail(run, 'DEADLINE_EXCEEDED', 'RUN_DEADLINE_EXCEEDED').then(() => undefined);

    const normalized = normalizeExecutionReceipt(receipt);
    const completedAt = toIso(this.now());
    toolCall.status = normalized.ok ? 'succeeded' : 'failed';
    toolCall.completedAt = completedAt;
    const result: ToolResult = normalized.ok
      ? {
          id: this.idFactory('tool-result'),
          toolCallId: toolCall.id,
          ok: true,
          changed: normalized.changed,
          summary: normalized.summary,
          ...(normalized.deltaSha256 ? { deltaSha256: normalized.deltaSha256 } : {}),
          outputIds: normalized.outputIds ?? [],
          costUsd: roundMoney(normalized.costUsd ?? 0),
          retryable: false,
          completedAt,
        }
      : {
          id: this.idFactory('tool-result'),
          toolCallId: toolCall.id,
          ok: false,
          changed: false,
          summary: normalized.summary,
          outputIds: [],
          costUsd: roundMoney(normalized.costUsd ?? 0),
          retryable: normalized.retryable,
          errorCode: normalized.errorCode,
          completedAt,
        };
    step.toolResults.push(result);
    step.updatedAt = completedAt;
    try {
      this.applyCost(run, action, result.costUsd);
    } catch {
      await this.fail(run, 'ACTION_FAILED', 'ACTION_COST_POLICY_VIOLATION');
      return undefined;
    }
    if (run.budget.spentUsd > run.budget.capUsd) {
      await this.fail(run, 'BUDGET_EXCEEDED', 'ACTUAL_COST_EXCEEDED_MILESTONE_CAP');
      return undefined;
    }
    return result;
  }

  private evaluate(step: AgentStep, action: AgentAction, result: ToolResult): Evaluation {
    const after = step.observationAfter;
    if (!after) throw new Error('OBSERVATION_AFTER_MISSING');
    const contextChanged = step.observationBefore.semanticSha256 !== after.semanticSha256;
    const verifiedDelta = contextChanged && result.changed;
    const outcome: Evaluation['outcome'] = action.type === 'finish'
      ? 'COMPLETE'
      : action.type === 'ask_user'
        ? 'WAITING_FOR_USER'
        : verifiedDelta
          ? 'DELTA'
          : 'NO_DELTA';
    return {
      id: this.idFactory('evaluation'),
      beforeSha256: step.observationBefore.semanticSha256,
      afterSha256: after.semanticSha256,
      verifiedDelta,
      outcome,
      summary: action.type === 'finish'
        ? action.summary
        : outcome === 'WAITING_FOR_USER'
          ? '等待用户补充信息。'
          : verifiedDelta
            ? '已验证真实画布变化。'
            : '未检测到可验证的画布变化。',
      evaluatedAt: toIso(this.now()),
    };
  }

  private applyCost(run: AgentRun, action: AgentAction, actualCostUsd: number) {
    if (!isGenerationJobAction(action) || !action.paid) {
      if (actualCostUsd !== 0) throw new Error('NON_PAID_ACTION_REPORTED_COST');
      return;
    }
    run.budget.reservedUsd = roundMoney(Math.max(0, run.budget.reservedUsd - action.estimatedCostUsd));
    run.budget.spentUsd = roundMoney(run.budget.spentUsd + actualCostUsd);
  }

  private deadlineExceeded(run: AgentRun) {
    return this.now() >= Date.parse(run.deadlineAt);
  }

  private async withDeadline<T>(run: AgentRun, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const remainingMs = Date.parse(run.deadlineAt) - this.now();
    if (remainingMs <= 0) throw new AgentDeadlineExceededError();
    const controller = new AbortController();
    this.abortControllers.set(run.id, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort('RUN_DEADLINE_EXCEEDED');
        reject(new AgentDeadlineExceededError());
      }, remainingMs);
    });
    try {
      const operationPromise = operation(controller.signal).catch((error) => {
        if (controller.signal.aborted && controller.signal.reason === 'RUN_DEADLINE_EXCEEDED') {
          throw new AgentDeadlineExceededError();
        }
        throw error;
      });
      const result = await Promise.race([operationPromise, deadline]);
      if (this.deadlineExceeded(run)) {
        controller.abort('RUN_DEADLINE_EXCEEDED');
        throw new AgentDeadlineExceededError();
      }
      return result;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (this.abortControllers.get(run.id) === controller) this.abortControllers.delete(run.id);
    }
  }

  private transition(run: AgentRun, to: AgentRunState) {
    if (!LEGAL_TRANSITIONS[run.state].includes(to)) throw new Error(`ILLEGAL_AGENT_STATE_TRANSITION:${run.state}->${to}`);
    const from = run.state;
    const at = toIso(this.now());
    run.state = to;
    run.updatedAt = at;
    const step = currentStep(run);
    if (step) {
      step.state = to;
      step.updatedAt = at;
    }
    run.transitions.push({ from, to, at });
  }

  private async fail(run: AgentRun, reason: Exclude<AgentStopReason, 'FINISHED' | 'USER_CANCELLED'>, failureCode: string): Promise<AgentRun> {
    if (TERMINAL_STATES.has(run.state)) return run;
    this.pendingUserResponses.delete(run.id);
    run.pendingConfirmation = undefined;
    run.budget.reservedUsd = 0;
    run.stopReason = reason;
    run.failureCode = failureCode;
    this.transition(run, 'FAILED');
    await this.checkpoint(run);
    return run;
  }

  private async checkpoint(run: AgentRun): Promise<AgentCheckpoint> {
    run.checkpointSequence += 1;
    const id = this.idFactory('checkpoint');
    run.latestCheckpointId = id;
    run.updatedAt = toIso(this.now());
    const snapshot = clone(run);
    const checkpoint: AgentCheckpoint = {
      schemaVersion: 1,
      id,
      runId: run.id,
      sequence: run.checkpointSequence,
      createdAt: run.updatedAt,
      runSha256: '',
      run: snapshot,
    };
    const previous = this.checkpointTails.get(run.id) ?? Promise.resolve();
    let savePromise: Promise<void>;
    savePromise = previous.catch(() => undefined).then(async () => {
      checkpoint.runSha256 = await sha256(stableStringify(checkpoint.run));
      await this.dependencies.checkpointStore.save(checkpoint);
    });
    this.checkpointTails.set(run.id, savePromise);
    try {
      await savePromise;
    } finally {
      if (this.checkpointTails.get(run.id) === savePromise) this.checkpointTails.delete(run.id);
    }
    return checkpoint;
  }
}

export const createCreativeDirectorRuntime = (dependencies: CreativeDirectorRuntimeDependencies) => new CreativeDirectorRuntime(dependencies);

export const createMemoryCheckpointStore = (): AgentCheckpointStore & { entries: Map<string, AgentCheckpoint> } => {
  const entries = new Map<string, AgentCheckpoint>();
  return {
    entries,
    async save(checkpoint) {
      const previous = entries.get(checkpoint.runId);
      if (previous && previous.sequence >= checkpoint.sequence) throw new Error('CHECKPOINT_SEQUENCE_NOT_MONOTONIC');
      entries.set(checkpoint.runId, clone(checkpoint));
    },
    async load(runId) {
      const checkpoint = entries.get(runId);
      return checkpoint ? clone(checkpoint) : undefined;
    },
  };
};

const validateGenerationActionForRun = (run: AgentRun, observation: Observation, action: AgentAction) => {
  if (!isGenerationJobAction(action)) return;
  if (run.creationMode === 'image' && action.type !== 'create_image_job') throw new AgentActionValidationError('CORE009_IMAGE_MODE_VIDEO_FORBIDDEN');
  if (run.creationMode === 'video' && action.type !== 'create_video_job') throw new AgentActionValidationError('CORE009_VIDEO_MODE_IMAGE_FORBIDDEN');
  if (run.generationPolicy === 'single-xor') {
    const previous = run.steps.flatMap((step) => step.action ? [step.action] : []).filter(isGenerationJobAction);
    if (previous.length > 0) throw new AgentActionValidationError('CORE009_GENERATION_SUBMISSION_LIMIT');
  }
  if (action.type !== 'create_video_job') return;
  const context = observation.context;
  if (context.selectedObjectIds.length !== 1 || context.selectedObjectIds[0] !== action.sourceCanvasObjectId) {
    throw new AgentActionValidationError('CORE009_VIDEO_REQUIRES_ONE_SELECTED_IMAGE');
  }
  const object = context.objects.find((candidate) => candidate.id === action.sourceCanvasObjectId);
  const asset = context.assets.find((candidate) => candidate.id === action.sourceAssetId);
  const version = context.versions.find((candidate) => candidate.id === action.sourceVersionId);
  if (
    !object
    || object.status !== 'ready'
    || object.assetId !== action.sourceAssetId
    || object.versionId !== action.sourceVersionId
    || !asset
    || asset.kind !== 'image'
    || !version
    || version.canvasObjectId !== object.id
    || version.status !== 'ready'
  ) throw new AgentActionValidationError('CORE009_VIDEO_SOURCE_BINDING_STALE');
};

export const parseAgentAction = (value: unknown): AgentAction => {
  if (!isPlainRecord(value)) throw new AgentActionValidationError('ACTION_NOT_OBJECT');
  const type = value.type;
  if (typeof type !== 'string' || !ACTION_TYPES.has(type as AgentAction['type'])) throw new AgentActionValidationError('ACTION_TYPE_NOT_ALLOWED');
  requireIdentifier(value.actionId, 'ACTION_ID_INVALID');

  if (type === 'create_image_job') {
    requireExactKeys(value, ['type', 'actionId', 'intentId', 'planId', 'operation', 'paid', 'estimatedCostUsd']);
    requireIdentifier(value.intentId, 'INTENT_ID_INVALID');
    requireIdentifier(value.planId, 'PLAN_ID_INVALID');
    if (!['image_generate', 'image_edit_fixed_demo_reference', 'image_edit_user_reference'].includes(String(value.operation))) {
      throw new AgentActionValidationError('IMAGE_OPERATION_INVALID');
    }
    if (typeof value.paid !== 'boolean') throw new AgentActionValidationError('PAID_FLAG_INVALID');
    const estimatedCostUsd = requireMoney(value.estimatedCostUsd, 'ESTIMATED_COST_INVALID', !value.paid);
    if (!value.paid && estimatedCostUsd !== 0) throw new AgentActionValidationError('FREE_ACTION_COST_INVALID');
    return { type, actionId: value.actionId as string, intentId: value.intentId as string, planId: value.planId as string, operation: value.operation as CreateImageJobAction['operation'], paid: value.paid, estimatedCostUsd };
  }
  if (type === 'create_video_job') {
    requireExactKeys(value, ['type', 'actionId', 'intentId', 'planId', 'operation', 'sourceCanvasObjectId', 'sourceVersionId', 'sourceAssetId', 'paid', 'estimatedCostUsd']);
    requireIdentifier(value.intentId, 'INTENT_ID_INVALID');
    requireIdentifier(value.planId, 'PLAN_ID_INVALID');
    requireIdentifier(value.sourceCanvasObjectId, 'SOURCE_OBJECT_ID_INVALID');
    requireIdentifier(value.sourceVersionId, 'SOURCE_VERSION_ID_INVALID');
    requireIdentifier(value.sourceAssetId, 'SOURCE_ASSET_ID_INVALID');
    if (value.operation !== 'video_image_to_video') throw new AgentActionValidationError('VIDEO_OPERATION_INVALID');
    if (typeof value.paid !== 'boolean') throw new AgentActionValidationError('PAID_FLAG_INVALID');
    const estimatedCostUsd = requireMoney(value.estimatedCostUsd, 'ESTIMATED_COST_INVALID', !value.paid);
    if (!value.paid && estimatedCostUsd !== 0) throw new AgentActionValidationError('FREE_ACTION_COST_INVALID');
    return {
      type,
      actionId: value.actionId as string,
      intentId: value.intentId as string,
      planId: value.planId as string,
      operation: 'video_image_to_video',
      sourceCanvasObjectId: value.sourceCanvasObjectId as string,
      sourceVersionId: value.sourceVersionId as string,
      sourceAssetId: value.sourceAssetId as string,
      paid: value.paid,
      estimatedCostUsd,
    };
  }
  if (type === 'select_objects' || type === 'focus_objects') {
    requireExactKeys(value, ['type', 'actionId', 'objectIds']);
    const objectIds = requireIdentifiers(value.objectIds, 'OBJECT_IDS_INVALID');
    return { type, actionId: value.actionId as string, objectIds };
  }
  if (type === 'transform_objects') {
    requireExactKeys(value, ['type', 'actionId', 'expectedSemanticSha256', 'transforms']);
    if (!isSha256(value.expectedSemanticSha256) || !Array.isArray(value.transforms) || !value.transforms.length || value.transforms.length > 100) {
      throw new AgentActionValidationError('CANVAS_TRANSFORM_INVALID');
    }
    const ids = new Set<string>();
    const transforms = value.transforms.map((entry) => {
      if (!isPlainRecord(entry)) throw new AgentActionValidationError('CANVAS_TRANSFORM_INVALID');
      requireExactKeys(entry, ['objectId', 'x', 'y', 'width', 'height']);
      requireIdentifier(entry.objectId, 'OBJECT_IDS_INVALID');
      if (ids.has(entry.objectId as string)) throw new AgentActionValidationError('CANVAS_TRANSFORM_DUPLICATE');
      ids.add(entry.objectId as string);
      for (const field of ['x', 'y', 'width', 'height'] as const) {
        if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]) || Math.abs(entry[field] as number) > 10000) {
          throw new AgentActionValidationError('CANVAS_TRANSFORM_INVALID');
        }
      }
      if ((entry.width as number) < 16 || (entry.height as number) < 16 || (entry.width as number) > 4096 || (entry.height as number) > 4096) {
        throw new AgentActionValidationError('CANVAS_TRANSFORM_SIZE_INVALID');
      }
      return { objectId: entry.objectId as string, x: entry.x as number, y: entry.y as number, width: entry.width as number, height: entry.height as number };
    });
    return { type, actionId: value.actionId as string, expectedSemanticSha256: value.expectedSemanticSha256 as string, transforms };
  }
  if (type === 'create_version') {
    requireExactKeys(value, ['type', 'actionId', 'parentCanvasObjectId', 'parentVersionId', 'jobId']);
    requireIdentifier(value.parentCanvasObjectId, 'PARENT_OBJECT_ID_INVALID');
    requireIdentifier(value.parentVersionId, 'PARENT_VERSION_ID_INVALID');
    requireIdentifier(value.jobId, 'JOB_ID_INVALID');
    return {
      type,
      actionId: value.actionId as string,
      parentCanvasObjectId: value.parentCanvasObjectId as string,
      parentVersionId: value.parentVersionId as string,
      jobId: value.jobId as string,
    };
  }
  if (type === 'ask_user') {
    requireExactKeys(value, ['type', 'actionId', 'prompt']);
    return { type, actionId: value.actionId as string, prompt: requirePublicText(value.prompt, 'ASK_USER_PROMPT_INVALID') };
  }
  requireExactKeys(value, ['type', 'actionId', 'summary']);
  return { type: 'finish', actionId: value.actionId as string, summary: requirePublicText(value.summary, 'FINISH_SUMMARY_INVALID') };
};

export const validateCheckpoint = async (checkpoint: AgentCheckpoint): Promise<void> => {
  if (!isPlainRecord(checkpoint) || checkpoint.schemaVersion !== 1 || !isIdentifier(checkpoint.id) || !isIdentifier(checkpoint.runId)) throw new Error('CHECKPOINT_INVALID');
  if (!Number.isInteger(checkpoint.sequence) || checkpoint.sequence < 1 || !isSha256(checkpoint.runSha256)) throw new Error('CHECKPOINT_METADATA_INVALID');
  assertSerializableRun(checkpoint.run);
  if (checkpoint.run.id !== checkpoint.runId || checkpoint.run.latestCheckpointId !== checkpoint.id || checkpoint.run.checkpointSequence !== checkpoint.sequence) {
    throw new Error('CHECKPOINT_RUN_BINDING_INVALID');
  }
  const digest = await sha256(stableStringify(checkpoint.run));
  if (digest !== checkpoint.runSha256) throw new Error('CHECKPOINT_SHA256_MISMATCH');
};

const normalizeExecutionReceipt = (value: unknown): ActionExecutionReceipt => {
  if (!isPlainRecord(value) || typeof value.ok !== 'boolean') return { ok: false, summary: '执行器返回无效结果。', errorCode: 'EXECUTOR_RECEIPT_INVALID', retryable: false };
  if (value.ok) {
    const allowed = ['ok', 'changed', 'summary', 'deltaSha256', 'outputIds', 'costUsd'];
    if (!hasOnlyKeys(value, allowed) || typeof value.changed !== 'boolean' || typeof value.summary !== 'string' || !value.summary.trim()) {
      return { ok: false, summary: '执行器返回无效结果。', errorCode: 'EXECUTOR_RECEIPT_INVALID', retryable: false };
    }
    if (value.deltaSha256 !== undefined && !isSha256(value.deltaSha256)) return { ok: false, summary: '执行器返回无效摘要。', errorCode: 'EXECUTOR_RECEIPT_INVALID', retryable: false };
    let outputIds: string[] | undefined;
    if (value.outputIds !== undefined) {
      try { outputIds = requireIdentifiers(value.outputIds, 'OUTPUT_IDS_INVALID'); } catch { return { ok: false, summary: '执行器返回无效对象。', errorCode: 'EXECUTOR_RECEIPT_INVALID', retryable: false }; }
    }
    let costUsd: number | undefined;
    if (value.costUsd !== undefined) {
      try { costUsd = requireMoney(value.costUsd, 'COST_INVALID', true); } catch { return { ok: false, summary: '执行器返回无效费用。', errorCode: 'EXECUTOR_RECEIPT_INVALID', retryable: false }; }
    }
    return { ok: true, changed: value.changed, summary: value.summary.trim().slice(0, 600), ...(value.deltaSha256 ? { deltaSha256: value.deltaSha256 } : {}), ...(outputIds ? { outputIds } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
  }
  if (!hasOnlyKeys(value, ['ok', 'summary', 'errorCode', 'retryable', 'costUsd']) || typeof value.summary !== 'string' || !value.summary.trim() || !isSafeCode(value.errorCode) || typeof value.retryable !== 'boolean') {
    return { ok: false, summary: '执行器返回无效结果。', errorCode: 'EXECUTOR_RECEIPT_INVALID', retryable: false };
  }
  let costUsd: number | undefined;
  if (value.costUsd !== undefined) {
    try { costUsd = requireMoney(value.costUsd, 'COST_INVALID', true); } catch { return { ok: false, summary: '执行器返回无效费用。', errorCode: 'EXECUTOR_RECEIPT_INVALID', retryable: false }; }
  }
  return { ok: false, summary: value.summary.trim().slice(0, 600), errorCode: value.errorCode as string, retryable: value.retryable, ...(costUsd !== undefined ? { costUsd } : {}) };
};

const assertSerializableRun = (run: AgentRun) => {
  if (!isPlainRecord(run) || run.schemaVersion !== 1 || !isIdentifier(run.id) || run.agent !== 'CreativeDirectorAgent') throw new Error('AGENT_RUN_INVALID');
  if (!Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, run.state) || !Array.isArray(run.steps) || !Array.isArray(run.transitions)) throw new Error('AGENT_RUN_STATE_INVALID');
  if (!Number.isInteger(run.maxSteps) || run.maxSteps < 1 || run.maxSteps > 32 || run.maxConsecutiveNoDelta !== 2) throw new Error('AGENT_RUN_LIMITS_INVALID');
  if (run.creationMode !== undefined && !['agent', 'image', 'video'].includes(run.creationMode)) throw new Error('AGENT_RUN_CREATION_MODE_INVALID');
  if (run.generationPolicy !== undefined && run.generationPolicy !== 'single-xor') throw new Error('AGENT_RUN_GENERATION_POLICY_INVALID');
  if (run.budgetMilestone !== undefined && !['CORE008', 'CORE009'].includes(run.budgetMilestone)) throw new Error('AGENT_RUN_BUDGET_MILESTONE_INVALID');
  if (!Number.isFinite(Date.parse(run.deadlineAt)) || !Number.isFinite(Date.parse(run.startedAt)) || Date.parse(run.deadlineAt) <= Date.parse(run.startedAt)) throw new Error('AGENT_RUN_DEADLINE_INVALID');
  if (!Number.isFinite(run.budget.capUsd) || run.budget.capUsd < 0 || run.budget.spentUsd < 0 || run.budget.reservedUsd < 0) throw new Error('AGENT_RUN_BUDGET_INVALID');
  if (
    !Array.isArray(run.confirmedActionIds)
    || new Set(run.confirmedActionIds).size !== run.confirmedActionIds.length
    || !run.confirmedActionIds.every(isConfirmationCapabilityId)
  ) throw new Error('AGENT_RUN_CONFIRMATIONS_INVALID');
  if (run.pendingConfirmation !== undefined) assertPendingConfirmation(run.pendingConfirmation);
  for (const step of run.steps) {
    if (step.action !== undefined) parseAgentAction(step.action);
  }
};

const currentStep = (run: AgentRun) => run.steps.at(-1);
const isGenerationJobAction = (action: AgentAction): action is CreateImageJobAction | CreateVideoJobAction => action.type === 'create_image_job' || action.type === 'create_video_job';
const confirmationCapabilityId = (stepId: string, actionId: string) => `${stepId}:${actionId}`;
const isConfirmationCapabilityId = (value: unknown): value is string => typeof value === 'string' && value.length >= 3 && value.length <= 257 && /^[A-Za-z0-9._:-]+$/.test(value);

const assertPendingConfirmation = (pending: PendingConfirmation) => {
  if (!isPlainRecord(pending) || !isIdentifier(pending.actionId) || !isIdentifier(pending.stepId)) throw new Error('PENDING_CONFIRMATION_INVALID');
  if (pending.kind === 'USER_RESPONSE') {
    if (!hasOnlyKeys(pending, ['kind', 'actionId', 'stepId', 'publicPrompt']) || Object.keys(pending).length !== 4) throw new Error('PENDING_CONFIRMATION_INVALID');
    requirePublicText(pending.publicPrompt, 'PENDING_CONFIRMATION_PROMPT_INVALID');
    return;
  }
  if (pending.kind !== 'ACTION' && pending.kind !== 'PAID_ACTION') throw new Error('PENDING_CONFIRMATION_INVALID');
  const allowed = pending.kind === 'PAID_ACTION'
    ? ['kind', 'actionId', 'stepId', 'estimatedCostUsd']
    : ['kind', 'actionId', 'stepId'];
  if (!hasOnlyKeys(pending, allowed) || Object.keys(pending).length !== allowed.length) throw new Error('PENDING_CONFIRMATION_INVALID');
  if (pending.kind === 'PAID_ACTION') requireMoney(pending.estimatedCostUsd, 'PENDING_CONFIRMATION_COST_INVALID', false);
};

const requireExactKeys = (value: Record<string, unknown>, expected: string[]) => {
  if (!hasOnlyKeys(value, expected) || Object.keys(value).length !== expected.length) throw new AgentActionValidationError('ACTION_EXTRA_OR_MISSING_FIELDS');
};

const hasOnlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

const requireIdentifiers = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new AgentActionValidationError(code);
  const ids = value.map((item) => requireIdentifier(item, code));
  if (new Set(ids).size !== ids.length) throw new AgentActionValidationError(code);
  return ids;
};

const requireIdentifier = (value: unknown, code: string): string => {
  if (!isIdentifier(value)) throw new AgentActionValidationError(code);
  return value;
};

const isIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const isSafeCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(value);
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

const requirePublicText = (value: unknown, code: string) => {
  if (typeof value !== 'string') throw new AgentActionValidationError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > 600) throw new AgentActionValidationError(code);
  return normalized;
};

const requireMoney = (value: unknown, code: string, allowZero: boolean) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || value > 1_000_000) throw new AgentActionValidationError(code);
  return roundMoney(value);
};

const roundMoney = (value: number) => Number(value.toFixed(6));
const toIso = (milliseconds: number) => new Date(milliseconds).toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isPlainRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const stableStringify = (value: unknown): string => JSON.stringify(sortJson(value));

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
