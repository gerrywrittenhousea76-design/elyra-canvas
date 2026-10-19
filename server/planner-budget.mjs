import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { mkdir, rmdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const LEDGER_FILE = 'ledger.json';
const LOCK_DIRECTORY = '.ledger.lock';
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export const DEFAULT_PLANNER_BUDGET_DIRECTORY = resolve(process.cwd(), '.elyra-runtime', 'planner-budget');

export const createPlannerBudgetLedger = ({
  directory = DEFAULT_PLANNER_BUDGET_DIRECTORY,
  now = () => Date.now(),
  reservationId = () => randomUUID(),
  initialSpentUsd = 0,
} = {}) => {
  const ledgerDirectory = resolve(directory);
  const ledgerPath = resolve(ledgerDirectory, LEDGER_FILE);
  const lockPath = resolve(ledgerDirectory, LOCK_DIRECTORY);

  const ensureDirectory = () => {
    mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 });
    chmodSync(ledgerDirectory, 0o700);
    const metadata = statSync(ledgerDirectory);
    if (!metadata.isDirectory()) throw new PlannerBudgetLedgerError('Planner budget path is not a directory.');
  };

  const readState = () => {
    if (!existsSync(ledgerPath)) return emptyState(now, initialSpentUsd);
    let state;
    try {
      state = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    } catch {
      throw new PlannerBudgetLedgerError('Planner budget ledger is unreadable.');
    }
    validateState(state);
    return state;
  };

  const writeState = (state) => {
    validateState(state);
    ensureDirectory();
    const temporaryPath = resolve(ledgerDirectory, `.ledger.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, ledgerPath);
      chmodSync(ledgerPath, 0o600);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  };

  const withLock = async (operation) => {
    ensureDirectory();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new PlannerBudgetLedgerError('Planner budget lock could not be created.');
        await removeStaleLock(lockPath);
        if (Date.now() >= deadline) throw new PlannerBudgetLedgerError('Planner budget ledger is busy.');
        await delay(LOCK_WAIT_MS);
      }
    }
    try {
      return await operation();
    } finally {
      try { await rmdir(lockPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw new PlannerBudgetLedgerError('Planner budget lock could not be released.');
      }
    }
  };

  return {
    directory: ledgerDirectory,
    path: ledgerPath,

    getStatusSync({ capUsd, reservationPerAttemptUsd }) {
      validateMoney(capUsd, 'capUsd');
      validateMoney(reservationPerAttemptUsd, 'reservationPerAttemptUsd');
      ensureDirectory();
      const state = readState();
      const usedUsd = roundUsd(committedUsd(state));
      if (usedUsd > capUsd + Number.EPSILON) throw new PlannerBudgetExceededError(usedUsd);
      return budgetStatus(state, capUsd, reservationPerAttemptUsd);
    },

    async reserve({ capUsd, amountUsd }) {
      validateMoney(capUsd, 'capUsd');
      validateMoney(amountUsd, 'amountUsd');
      return withLock(async () => {
        const state = readState();
        const usedUsd = committedUsd(state);
        if (usedUsd + amountUsd > capUsd + Number.EPSILON) throw new PlannerBudgetExceededError(roundUsd(usedUsd));
        const id = reservationId();
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || state.reservations.some((entry) => entry.id === id)) {
          throw new PlannerBudgetLedgerError('Planner budget reservation ID is invalid.');
        }
        state.reservations.push({
          id,
          capUsd: roundUsd(capUsd),
          reservedUsd: roundUsd(amountUsd),
          reservedAt: isoTime(now()),
          settledUsd: null,
          settledAt: null,
        });
        state.updatedAt = isoTime(now());
        writeState(state);
        return { id, usedUsd: roundUsd(committedUsd(state)) };
      });
    },

    async settle({ id, actualUsd, capUsd }) {
      if (typeof id !== 'string' || !id) throw new PlannerBudgetLedgerError('Planner budget reservation ID is required.');
      if (actualUsd !== null) validateNonNegativeMoney(actualUsd, 'actualUsd');
      if (capUsd !== undefined) validateMoney(capUsd, 'capUsd');
      return withLock(async () => {
        const state = readState();
        const reservation = state.reservations.find((entry) => entry.id === id);
        if (!reservation) throw new PlannerBudgetLedgerError('Planner budget reservation was not found.');
        const effectiveCapUsd = reservation.capUsd ?? capUsd;
        if (!Number.isFinite(effectiveCapUsd) || effectiveCapUsd <= 0) throw new PlannerBudgetLedgerError('Planner budget settlement cap is unavailable.');
        if (capUsd !== undefined && reservation.capUsd !== undefined && Math.abs(capUsd - reservation.capUsd) > Number.EPSILON) {
          throw new PlannerBudgetLedgerError('Planner budget settlement cap does not match its reservation.');
        }
        if (reservation.settledAt !== null) {
          return { billedUsd: reservation.settledUsd, usedUsd: roundUsd(committedUsd(state)) };
        }
        const billedUsd = roundUsd(actualUsd === null ? reservation.reservedUsd : actualUsd);
        const usedWithoutThisReservation = roundUsd(committedUsd(state) - reservation.reservedUsd);
        const projectedUsedUsd = roundUsd(usedWithoutThisReservation + billedUsd);
        if (projectedUsedUsd > effectiveCapUsd + Number.EPSILON) {
          // The Provider call may already have happened. Atomically saturate the
          // ledger at the approved cap, then fail the caller closed; never write
          // a value above the human-approved milestone limit.
          const cappedBillUsd = roundUsd(Math.max(0, effectiveCapUsd - usedWithoutThisReservation));
          reservation.settledUsd = cappedBillUsd;
          reservation.settledAt = isoTime(now());
          state.spentUsd = roundUsd(state.spentUsd + cappedBillUsd);
          state.updatedAt = isoTime(now());
          writeState(state);
          throw new PlannerBudgetExceededError(roundUsd(committedUsd(state)));
        }
        reservation.settledUsd = billedUsd;
        reservation.settledAt = isoTime(now());
        state.spentUsd = roundUsd(state.spentUsd + billedUsd);
        state.updatedAt = isoTime(now());
        writeState(state);
        return { billedUsd, usedUsd: roundUsd(committedUsd(state)) };
      });
    },
  };
};

const emptyState = (now, initialSpentUsd) => {
  validateNonNegativeMoney(initialSpentUsd, 'initialSpentUsd');
  return { spentUsd: roundUsd(initialSpentUsd), reservations: [], updatedAt: isoTime(now()) };
};

const budgetStatus = (state, capUsd, reservationPerAttemptUsd) => ({
  capUsd,
  usedUsd: roundUsd(committedUsd(state)),
  reservationPerAttemptUsd,
});

const committedUsd = (state) => state.spentUsd + state.reservations
  .filter((entry) => entry.settledAt === null)
  .reduce((total, entry) => total + entry.reservedUsd, 0);

const validateState = (state) => {
  if (!isRecord(state) || !hasExactKeys(state, ['spentUsd', 'reservations', 'updatedAt'])) throw new PlannerBudgetLedgerError('Planner budget ledger shape is invalid.');
  validateNonNegativeMoney(state.spentUsd, 'spentUsd');
  validateTime(state.updatedAt, 'updatedAt');
  if (!Array.isArray(state.reservations)) throw new PlannerBudgetLedgerError('Planner budget reservations are invalid.');
  const ids = new Set();
  for (const reservation of state.reservations) {
    const legacyKeys = ['id', 'reservedUsd', 'reservedAt', 'settledUsd', 'settledAt'];
    const cappedKeys = ['id', 'capUsd', 'reservedUsd', 'reservedAt', 'settledUsd', 'settledAt'];
    if (!isRecord(reservation) || (!hasExactKeys(reservation, legacyKeys) && !hasExactKeys(reservation, cappedKeys))) throw new PlannerBudgetLedgerError('Planner budget reservation shape is invalid.');
    if (typeof reservation.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(reservation.id) || ids.has(reservation.id)) throw new PlannerBudgetLedgerError('Planner budget reservation ID is invalid.');
    ids.add(reservation.id);
    validateMoney(reservation.reservedUsd, 'reservedUsd');
    if (Object.hasOwn(reservation, 'capUsd')) {
      validateMoney(reservation.capUsd, 'capUsd');
      if (reservation.reservedUsd > reservation.capUsd + Number.EPSILON) throw new PlannerBudgetLedgerError('Planner budget reservation exceeds its cap.');
    }
    validateTime(reservation.reservedAt, 'reservedAt');
    if (reservation.settledAt === null) {
      if (reservation.settledUsd !== null) throw new PlannerBudgetLedgerError('Planner budget settlement is incomplete.');
    } else {
      validateTime(reservation.settledAt, 'settledAt');
      validateNonNegativeMoney(reservation.settledUsd, 'settledUsd');
      if (Object.hasOwn(reservation, 'capUsd') && reservation.settledUsd > reservation.capUsd + Number.EPSILON) throw new PlannerBudgetLedgerError('Planner budget settlement exceeds its cap.');
    }
  }
};

const validateMoney = (value, label) => {
  if (!Number.isFinite(value) || value <= 0) throw new PlannerBudgetLedgerError(`${label} must be positive.`);
};

const validateNonNegativeMoney = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new PlannerBudgetLedgerError(`${label} must be non-negative.`);
};

const validateTime = (value, label) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new PlannerBudgetLedgerError(`${label} is invalid.`);
};

const isoTime = (value) => {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new PlannerBudgetLedgerError('Planner budget time is invalid.');
  return new Date(milliseconds).toISOString();
};

const removeStaleLock = async (lockPath) => {
  try {
    const metadata = await stat(lockPath);
    if (Date.now() - metadata.mtimeMs > STALE_LOCK_MS) await rmdir(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw new PlannerBudgetLedgerError('Planner budget lock could not be inspected.');
  }
};

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const roundUsd = (value = 0) => Number(value.toFixed(8));

export class PlannerBudgetExceededError extends Error {
  constructor(usedUsd) {
    super('Planner budget cap reached.');
    this.usedUsd = usedUsd;
  }
}

export class PlannerBudgetLedgerError extends Error {}
