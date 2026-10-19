import { createHash, randomUUID } from 'node:crypto';
import { ClientInputError, EvoLinkHttpError } from './evolink.mjs';
import { PlannerBudgetExceededError, PlannerBudgetLedgerError } from './planner-budget.mjs';
import { ReferenceJobError, resolveProviderResultImage } from './reference-jobs.mjs';
import { ReferenceImageError } from './reference-image.mjs';

export const CORE008_BUDGET_CAP_USD = 5;
export const CORE008_IMAGE_RESERVATION_USD = 1;
const TASK_ID = /^task-unified-[A-Za-z0-9_-]+$/;
const RESULT_ID = /^image-result-[a-f0-9]{32}$/;
const CLIENT_JOB_ID = /^job-[A-Za-z0-9_-]{1,190}$/;

export class Core008BudgetError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'Core008BudgetError';
    this.status = status;
    this.code = code;
    this.retryable = false;
  }
}

/**
 * The browser-side runtime is presentation only. This service is the
 * authoritative milestone budget gate for text and fixed-reference image
 * submissions. Planner and CORE-007 upload/edit services receive the same
 * ledger instance from the controlled server entry, so every paid operation shares one cap.
 */
export const createCore008ImageGateway = ({
  client,
  budgetLedger,
  ensureConfigured,
  budgetCapUsd = CORE008_BUDGET_CAP_USD,
  budgetMilestone = 'CORE008',
  imageReservationUsd = CORE008_IMAGE_RESERVATION_USD,
  resolveProviderResult = resolveProviderResultImage,
  createResultId = () => `image-result-${randomUUID().replaceAll('-', '')}`,
} = {}) => {
  if (!client || !budgetLedger || typeof ensureConfigured !== 'function') {
    throw new TypeError('CORE008 image gateway requires Provider, ledger and configuration preflight.');
  }
  if (!['CORE008', 'CORE009'].includes(budgetMilestone)) throw new TypeError('Image budget milestone must be CORE008 or CORE009.');

  const sessions = new Map();
  const results = new Map();
  // Process-local sessions are already the recovery boundary for these image
  // routes. Bind each browser Job to exactly one canonical request before the
  // first await so reordered and concurrent duplicate submissions cannot
  // reserve budget or reach the Provider twice.
  const clientJobs = new Map();

  const budgetStatus = () => {
    try {
      return budgetLedger.getStatusSync({ capUsd: budgetCapUsd, reservationPerAttemptUsd: imageReservationUsd });
    } catch (error) {
      throw mapLedgerError(error, budgetMilestone, budgetCapUsd);
    }
  };

  const submit = (operationKind, input, operation) => {
    let binding;
    try {
      binding = createClientJobBinding(operationKind, input);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = clientJobs.get(binding.clientJobId);
    if (existing) {
      if (existing.requestSha256 !== binding.requestSha256) {
        return Promise.reject(new Core008BudgetError(409, 'CORE008_JOB_BINDING_CONFLICT', '本地 Job ID 已绑定其他图片请求，不得改写或跨操作复用。'));
      }
      if (existing.promise) return existing.promise;
      if (existing.taskId) {
        const session = sessions.get(existing.taskId);
        if (!session || session.clientJobId !== binding.clientJobId || session.requestSha256 !== binding.requestSha256) {
          return Promise.reject(new Core008BudgetError(503, 'CORE008_JOB_SESSION_INVALID', '已有图片任务的本地会话绑定无法验证，已拒绝重提。'));
        }
        return Promise.resolve(publicTask(session));
      }
      if (existing.state === 'blocked') {
        return Promise.reject(new Core008BudgetError(409, 'CORE008_JOB_RETRY_UNSAFE', '该图片请求的 Provider 提交结果不确定；为防止重复计费，不会再次预留预算或重提。'));
      }
    }

    const record = existing ?? {
      clientJobId: binding.clientJobId,
      requestSha256: binding.requestSha256,
      state: 'retryable',
    };
    record.state = 'in-flight';
    clientJobs.set(binding.clientJobId, record);
    let attempt;
    attempt = submitOnce(record, operation).finally(() => {
      if (record.promise === attempt) delete record.promise;
    });
    record.promise = attempt;
    return attempt;
  };

  const submitOnce = async (record, operation) => {
    // Missing local credentials are not a paid attempt and must not mutate the
    // milestone ledger. The token itself is neither returned nor retained.
    try {
      await ensureConfigured();
    } catch (error) {
      markRetryable(record);
      throw error;
    }
    let reservation;
    try {
      reservation = await budgetLedger.reserve({ capUsd: budgetCapUsd, amountUsd: imageReservationUsd });
    } catch (error) {
      markRetryable(record);
      throw mapLedgerError(error, budgetMilestone, budgetCapUsd);
    }

    try {
      const result = await operation();
      // Validate the opaque task identifier before settlement. A malformed
      // response is still conservatively charged in the catch path, but the
      // same reservation must never be settled twice.
      const taskId = requireTaskId(result?.id);
      let settlement;
      try {
        settlement = await budgetLedger.settle({ id: reservation.id, actualUsd: null, capUsd: budgetCapUsd });
      } catch (error) {
        markBlocked(record);
        throw mapLedgerError(error, budgetMilestone, budgetCapUsd);
      }
      const previousSession = sessions.get(taskId);
      if (previousSession && (previousSession.clientJobId !== record.clientJobId || previousSession.requestSha256 !== record.requestSha256)) {
        markBlocked(record);
        throw new Core008BudgetError(502, 'CORE008_PROVIDER_TASK_REUSED', 'Provider 返回了已绑定其他本地 Job 的任务标识，已拒绝覆盖。');
      }
      const budget = {
          capUsd: budgetCapUsd,
          usedUsd: settlement.usedUsd,
          chargedUsd: settlement.billedUsd,
      };
      const session = {
        id: taskId,
        status: normalizeTaskStatus(result?.status),
        progress: safeProgress(result?.progress),
        budget,
        providerCompleted: false,
        clientJobId: record.clientJobId,
        requestSha256: record.requestSha256,
      };
      sessions.set(taskId, session);
      record.state = 'submitted';
      record.taskId = taskId;
      return publicTask(session);
    } catch (error) {
      if (record.state === 'blocked') throw error;
      // ClientInputError is guaranteed to precede Provider activity. Every
      // other error is conservatively charged because a remote submit may have
      // happened before the failure became observable.
      const retryableWithoutProvider = error instanceof ClientInputError;
      try {
        await budgetLedger.settle({
          id: reservation.id,
          actualUsd: retryableWithoutProvider ? 0 : null,
          capUsd: budgetCapUsd,
        });
      } catch (settlementError) {
        if (retryableWithoutProvider) markRetryable(record);
        else markBlocked(record);
        throw mapLedgerError(settlementError, budgetMilestone, budgetCapUsd);
      }
      if (retryableWithoutProvider) markRetryable(record);
      else markBlocked(record);
      throw error;
    }
  };

  const recoverExistingTask = (input) => {
    let binding;
    try {
      binding = createRecoveryBinding(input);
    } catch (error) {
      return Promise.reject(error);
    }

    let record = clientJobs.get(binding.clientJobId);
    const taskSession = sessions.get(binding.taskId);
    if (record) {
      if (!record.taskId || record.taskId !== binding.taskId) {
        return Promise.reject(new Core008BudgetError(409, 'CORE008_RECOVERY_JOB_BINDING_CONFLICT', '本地 Job 已绑定其他 Provider 任务，不得改写。'));
      }
      const jobSession = sessions.get(record.taskId);
      if (!jobSession || jobSession !== taskSession
        || jobSession.clientJobId !== binding.clientJobId
        || jobSession.requestSha256 !== record.requestSha256) {
        return Promise.reject(new Core008BudgetError(503, 'CORE008_JOB_SESSION_INVALID', '已有图片任务的双向本地绑定无法验证。'));
      }
    } else if (taskSession) {
      return Promise.reject(new Core008BudgetError(409, 'CORE008_RECOVERY_TASK_BINDING_CONFLICT', 'Provider 任务已绑定其他本地 Job，不得复用。'));
    } else {
      const currentBudget = budgetStatus();
      record = {
        clientJobId: binding.clientJobId,
        requestSha256: binding.requestSha256,
        taskId: binding.taskId,
        state: 'recovering',
      };
      const session = {
        id: binding.taskId,
        status: 'pending',
        budget: {
          capUsd: currentBudget.capUsd,
          usedUsd: currentBudget.usedUsd,
          chargedUsd: 0,
        },
        providerCompleted: false,
        clientJobId: binding.clientJobId,
        requestSha256: binding.requestSha256,
      };
      // Install both sides before the first await. Concurrent recovery cannot
      // race another Job onto the same Provider task or vice versa.
      clientJobs.set(binding.clientJobId, record);
      sessions.set(binding.taskId, session);
    }

    const session = sessions.get(binding.taskId);
    if (record.promise) return record.promise;
    if (session.status === 'completed') return Promise.resolve(publicTask(session));

    let attempt;
    attempt = (session.providerCompletedTask
      ? materializeCompletedTask(session, session.providerCompletedTask, {})
      : recoverExistingTaskOnce(session, binding.taskId))
      .finally(() => {
        if (record.promise === attempt) delete record.promise;
      });
    record.promise = attempt;
    return attempt;
  };

  const recoverExistingTaskOnce = async (session, taskId) => {
    // Recovery is status-only. It deliberately has no reserve, settle or
    // create operation and therefore cannot increase the milestone ledger.
    await ensureConfigured();
    const providerTask = await client.getTask(taskId);
    const returnedTaskId = requireTaskId(providerTask?.id);
    if (returnedTaskId !== taskId) {
      throw new Core008BudgetError(502, 'CORE008_RECOVERY_TASK_ID_MISMATCH', 'Provider 返回的任务标识与恢复请求不一致。');
    }
    if (providerTask?.status !== 'completed') {
      throw new Core008BudgetError(409, 'CORE008_RECOVERY_TASK_NOT_COMPLETED', '只有 Provider 已明确完成的图片任务可以恢复。');
    }
    session.providerCompleted = true;
    session.providerCompletedTask = providerTask;
    return materializeCompletedTask(session, providerTask, {});
  };

  return {
    getBudgetStatus: budgetStatus,
    createImageJob(input) {
      return submit('image-generate', input, () => client.createImageJob(input));
    },
    createImageEditJob(input) {
      return submit('image-edit-fixed', input, () => client.createImageEditJob(input));
    },
    recoverExistingTask,
    async getTask(taskId, options = {}) {
      const session = requireSession(sessions, taskId);
      if (session.status === 'completed' || (session.status === 'failed' && session.error?.retryScope !== 'status-only')) return publicTask(session);
      if (session.providerCompletedTask) return materializeCompletedTask(session, session.providerCompletedTask, options);

      let providerTask;
      try {
        providerTask = await client.getTask(taskId, options);
      } catch (error) {
        if (!(error instanceof EvoLinkHttpError)) throw error;
        const retryable = error.status === 429 || error.status >= 500;
        session.status = 'failed';
        session.error = {
          code: safeStatusErrorCode(error.status),
          message: retryable ? '已提交的 EvoLink 图片任务状态暂时无法查询。' : '已提交的 EvoLink 图片任务状态查询被拒绝。',
          retryable,
          retryScope: retryable ? 'status-only' : 'none',
        };
        return publicTask(session);
      }
      if (providerTask?.status === 'completed') {
        session.providerCompleted = true;
        session.providerCompletedTask = providerTask;
        return materializeCompletedTask(session, providerTask, options);
      }
      if (providerTask?.status === 'failed') {
        session.status = 'failed';
        session.progress = safeProgress(providerTask?.progress);
        session.error = safeTaskFailure(providerTask);
        return publicTask(session);
      }
      session.status = normalizeTaskStatus(providerTask?.status);
      session.progress = safeProgress(providerTask?.progress);
      delete session.error;
      return publicTask(session);
    },
    getTaskForClientJob(clientJobId) {
      if (typeof clientJobId !== 'string' || !CLIENT_JOB_ID.test(clientJobId)) {
        throw new Core008BudgetError(400, 'CORE008_JOB_ID_INVALID', '本地 Job ID 无效。');
      }
      const record = clientJobs.get(clientJobId);
      if (!record?.taskId) {
        throw new Core008BudgetError(404, 'CORE008_LOCAL_TASK_HANDLE_MISSING', '本机未保留该 Job 的 Provider 任务绑定；不会创建新的付费任务。');
      }
      const session = requireSession(sessions, record.taskId);
      if (session.clientJobId !== clientJobId || session.requestSha256 !== record.requestSha256) {
        throw new Core008BudgetError(503, 'CORE008_JOB_SESSION_INVALID', '已有图片任务的本地会话绑定无法验证。');
      }
      return publicTask(session);
    },
    result(resultId) {
      if (!RESULT_ID.test(resultId)) throw new Core008BudgetError(400, 'CORE008_RESULT_ID_INVALID', '本地图片结果 ID 无效。');
      const result = results.get(resultId);
      if (!result) throw new Core008BudgetError(404, 'CORE008_RESULT_NOT_FOUND', '本地图片结果已不存在。');
      const session = sessions.get(result.taskId);
      if (!session || session.status !== 'completed' || session.resultId !== resultId) {
        throw new Core008BudgetError(410, 'CORE008_RESULT_UNAVAILABLE', '本地图片结果不可用。');
      }
      return result;
    },
  };

  async function materializeCompletedTask(session, providerTask, options) {
    try {
      const sanitized = await resolveProviderResult(providerTask, options);
      if (!sanitized || !Buffer.isBuffer(sanitized.buffer) || sanitized.mimeType !== 'image/png'
        || !Number.isInteger(sanitized.width) || sanitized.width < 1
        || !Number.isInteger(sanitized.height) || sanitized.height < 1
        || sanitized.bytes !== sanitized.buffer.length) {
        throw new Core008BudgetError(502, 'CORE008_RESULT_INVALID', 'Provider 结果未通过本地图片边界。');
      }
      const resultId = createResultId();
      if (!RESULT_ID.test(resultId) || results.has(resultId)) throw new Core008BudgetError(500, 'CORE008_RESULT_ID_INVALID', '无法创建唯一的本地图片结果 ID。');
      results.set(resultId, { ...sanitized, taskId: session.id });
      session.resultId = resultId;
      session.result = {
        mimeType: 'image/png',
        width: sanitized.width,
        height: sanitized.height,
        bytes: sanitized.bytes,
      };
      session.status = 'completed';
      session.progress = 100;
      delete session.error;
      delete session.providerCompletedTask;
    } catch (error) {
      const safe = safeLocalResultFailure(error);
      // The paid Provider task is already complete. Preserve its task payload
      // for a local-only retry even when the current decoder rejects it. A
      // validation or implementation fix must never force another generation.
      session.status = 'local_result_pending';
      session.error = {
        code: safe.code,
        message: 'Provider 已完成生成，但本地结果尚未取回；只能重试本地取回，不会再次提交付费生成。',
        // Retryability here means local-only materialization, not another
        // Provider submission. Keeping it true makes the recovery action
        // available after decoder, CDN-header or local transport fixes.
        retryable: true,
        retryScope: 'local-result',
      };
    }
    return publicTask(session);
  }
};

const createClientJobBinding = (operationKind, input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ClientInputError('图片任务必须是对象。');
  if (typeof input.clientJobId !== 'string' || !CLIENT_JOB_ID.test(input.clientJobId)) throw new ClientInputError('本地 Job ID 无效。');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim().replace(/\r\n?/g, '\n') : null;
  const canonical = JSON.stringify({
    version: 1,
    operationKind,
    clientJobId: input.clientJobId,
    prompt,
    size: input.size ?? '1:1',
    quality: input.quality ?? 'medium',
    n: input.n ?? 1,
    referenceUrlSha256: operationKind === 'image-edit-fixed'
      ? sha256(typeof input.referenceUrl === 'string' ? input.referenceUrl : '')
      : null,
  });
  return {
    clientJobId: input.clientJobId,
    requestSha256: sha256(`ELYRA_CORE008_IMAGE_JOB_V1\n${canonical}`),
  };
};

const createRecoveryBinding = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Core008BudgetError(400, 'CORE008_RECOVERY_INPUT_INVALID', '恢复请求必须是对象。');
  }
  if (Object.keys(input).sort().join('|') !== 'clientJobId|taskId') {
    throw new Core008BudgetError(400, 'CORE008_RECOVERY_INPUT_INVALID', '恢复请求字段无效。');
  }
  if (typeof input.clientJobId !== 'string' || !CLIENT_JOB_ID.test(input.clientJobId)) {
    throw new Core008BudgetError(400, 'CORE008_JOB_ID_INVALID', '本地 Job ID 无效。');
  }
  if (typeof input.taskId !== 'string' || !TASK_ID.test(input.taskId)) {
    throw new Core008BudgetError(400, 'CORE008_TASK_ID_INVALID', '图片任务 ID 无效。');
  }
  const taskId = input.taskId;
  return {
    clientJobId: input.clientJobId,
    taskId,
    requestSha256: sha256(`ELYRA_CORE008_RECOVER_EXISTING_V1\n${input.clientJobId}\n${taskId}`),
  };
};

const markRetryable = (record) => {
  record.state = 'retryable';
  delete record.taskId;
};

const markBlocked = (record) => {
  record.state = 'blocked';
  delete record.taskId;
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const requireTaskId = (value) => {
  if (typeof value !== 'string' || !TASK_ID.test(value)) throw new Core008BudgetError(502, 'CORE008_TASK_ID_INVALID', 'EvoLink 未返回有效任务标识。');
  return value;
};

const requireSession = (sessions, taskId) => {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new Core008BudgetError(400, 'CORE008_TASK_ID_INVALID', '图片任务 ID 无效。');
  const session = sessions.get(taskId);
  if (!session) throw new Core008BudgetError(404, 'CORE008_TASK_NOT_FOUND', '本地图片任务不存在。');
  return session;
};

const normalizeTaskStatus = (value) => value === 'processing' ? 'processing' : 'pending';
const safeProgress = (value) => Number.isFinite(value) ? Math.max(0, Math.min(99, Math.round(value))) : undefined;
const safeTaskFailure = (task) => {
  const status = Number(task?.error?.status ?? task?.error?.http_status ?? task?.status_code);
  const retryable = status === 429 || status >= 500;
  return {
    code: retryable ? 'EVOLINK_TASK_TRANSIENT_FAILURE' : 'EVOLINK_TASK_FAILED',
    message: retryable ? 'EvoLink 图片任务因明确的临时状态失败。' : 'EvoLink 图片任务失败；不会向浏览器暴露 Provider 原始响应。',
    retryable,
    retryScope: retryable ? 'new-provider-job' : 'none',
  };
};
const safeStatusErrorCode = (status) => status === 401 || status === 403 ? 'EVOLINK_STATUS_AUTH_FAILED' : status === 402 ? 'EVOLINK_STATUS_BALANCE_REQUIRED' : status === 429 ? 'EVOLINK_STATUS_RATE_LIMITED' : status >= 500 ? 'EVOLINK_STATUS_UNAVAILABLE' : 'EVOLINK_STATUS_REJECTED';

const SAFE_LOCAL_RESULT_CODES = new Set([
  'EVOLINK_RESULT_SCHEMA_INVALID',
  'EVOLINK_RESULT_URL_INVALID',
  'EVOLINK_RESULT_DNS_UNAVAILABLE',
  'EVOLINK_RESULT_NETWORK_BOUNDARY',
  'EVOLINK_RESULT_NETWORK_ERROR',
  'EVOLINK_RESULT_REDIRECT_INVALID',
  'EVOLINK_RESULT_REDIRECT_LIMIT',
  'EVOLINK_RESULT_DOWNLOAD_FAILED',
  'EVOLINK_RESULT_TOO_LARGE',
  'EVOLINK_RESULT_MIME_INVALID',
  'EVOLINK_RESULT_EMPTY',
]);

const safeLocalResultFailure = (error) => {
  if (error instanceof ReferenceJobError) {
    return {
      code: SAFE_LOCAL_RESULT_CODES.has(error.code) ? error.code : 'CORE008_RESULT_INVALID',
      retryable: Boolean(error.retryable),
    };
  }
  if (error instanceof ReferenceImageError) {
    return {
      code: ['RESULT_IMAGE_INVALID', 'RESULT_IMAGE_DECODE_FAILED'].includes(error.code)
        ? error.code
        : 'CORE008_RESULT_IMAGE_INVALID',
      retryable: false,
    };
  }
  return { code: 'CORE008_RESULT_INVALID', retryable: false };
};

const publicTask = (session) => ({
  id: session.id,
  status: session.status,
  ...(Number.isFinite(session.progress) ? { progress: session.progress } : {}),
  ...(session.resultId ? { resultId: session.resultId } : {}),
  ...(session.result ? { result: session.result } : {}),
  ...(session.error ? { error: session.error } : {}),
  ...(session.budget ? { budget: session.budget } : {}),
  providerCompleted: Boolean(session.providerCompleted),
});

const mapLedgerError = (error, budgetMilestone, budgetCapUsd) => {
  if (error instanceof PlannerBudgetExceededError) {
    return new Core008BudgetError(402, `${budgetMilestone}_BUDGET_EXCEEDED`, `${budgetMilestone.replace('CORE', 'CORE-')} 的 ${budgetCapUsd} 美元里程碑预算已达到上限。`);
  }
  if (error instanceof PlannerBudgetLedgerError) {
    return new Core008BudgetError(503, `${budgetMilestone}_BUDGET_LEDGER_UNAVAILABLE`, `${budgetMilestone.replace('CORE', 'CORE-')} 预算账本不可用。`);
  }
  return error;
};
