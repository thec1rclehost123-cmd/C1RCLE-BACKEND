import { InvalidOperationError } from '../errors.js';

import type { EntityId } from '../identity.js';

export type FinanceReadModelVersion = 'legacy_ledger_v1' | 'financial_journal_v2';
export type JournalTransitionPhase = 'legacy_reads' | 'backfill' | 'comparison' | 'journal_reads';

export interface JournalTransitionDiscrepancy {
  readonly organizationId: EntityId;
  readonly legacyPayablePaise: number;
  readonly journalPayablePaise: number;
  readonly differencePaise: number;
  readonly comparedAt: string;
}

/**
 * Singleton control record for the legacy-ledger to journal transition.
 * Reads use exactly one selected model; values from the two models are never
 * added together. The checkpoint makes a backfill restartable.
 */
export interface JournalTransitionState {
  readonly id: 'singleton';
  readonly phase: JournalTransitionPhase;
  readonly readModel: FinanceReadModelVersion;
  readonly checkpointOrganizationId: EntityId | null;
  readonly backfilledEntries: number;
  readonly backfillCompletedAt: string | null;
  readonly comparisonCompletedAt: string | null;
  readonly discrepancies: readonly JournalTransitionDiscrepancy[];
  readonly cutoverAt: string | null;
  readonly rollbackAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

export const DEFAULT_JOURNAL_TRANSITION_STATE: Readonly<JournalTransitionState> = Object.freeze({
  id: 'singleton',
  phase: 'legacy_reads',
  readModel: 'legacy_ledger_v1',
  checkpointOrganizationId: null,
  backfilledEntries: 0,
  backfillCompletedAt: null,
  comparisonCompletedAt: null,
  discrepancies: Object.freeze([]),
  cutoverAt: null,
  rollbackAt: null,
  updatedAt: new Date(0).toISOString(),
  version: 1,
});

export function beginJournalBackfill(
  state: JournalTransitionState,
  now: Date,
): JournalTransitionState {
  if (state.readModel !== 'legacy_ledger_v1') {
    throw new InvalidOperationError('Rollback to legacy reads before restarting a backfill');
  }
  return {
    ...state,
    phase: 'backfill',
    comparisonCompletedAt: null,
    backfillCompletedAt: null,
    discrepancies: [],
    cutoverAt: null,
    rollbackAt: null,
    updatedAt: now.toISOString(),
    version: state.version + 1,
  };
}

export function completeJournalBackfill(
  state: JournalTransitionState,
  now: Date,
): JournalTransitionState {
  if (state.phase !== 'backfill') {
    throw new InvalidOperationError('Only an active backfill can be completed');
  }
  return {
    ...state,
    backfillCompletedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: state.version + 1,
  };
}

export function recordJournalBackfillCheckpoint(
  state: JournalTransitionState,
  organizationId: EntityId,
  entries: number,
  now: Date,
): JournalTransitionState {
  if (state.phase !== 'backfill') {
    throw new InvalidOperationError('A backfill checkpoint requires the backfill phase');
  }
  return {
    ...state,
    checkpointOrganizationId: organizationId,
    backfilledEntries: state.backfilledEntries + entries,
    updatedAt: now.toISOString(),
    version: state.version + 1,
  };
}

export function recordJournalComparison(
  state: JournalTransitionState,
  discrepancies: readonly JournalTransitionDiscrepancy[],
  now: Date,
): JournalTransitionState {
  if (
    (state.phase !== 'backfill' && state.phase !== 'comparison') ||
    state.backfillCompletedAt === null
  ) {
    throw new InvalidOperationError('Comparison requires a completed backfill');
  }
  return {
    ...state,
    phase: 'comparison',
    comparisonCompletedAt: now.toISOString(),
    discrepancies: [...discrepancies],
    updatedAt: now.toISOString(),
    version: state.version + 1,
  };
}

export function cutOverJournalReads(
  state: JournalTransitionState,
  now: Date,
): JournalTransitionState {
  if (state.phase !== 'comparison' || state.comparisonCompletedAt === null) {
    throw new InvalidOperationError('Journal cutover requires a completed comparison');
  }
  if (state.discrepancies.length > 0) {
    throw new InvalidOperationError('Journal cutover is blocked by comparison discrepancies');
  }
  return {
    ...state,
    phase: 'journal_reads',
    readModel: 'financial_journal_v2',
    cutoverAt: now.toISOString(),
    rollbackAt: null,
    updatedAt: now.toISOString(),
    version: state.version + 1,
  };
}

export function rollbackToLegacyReads(
  state: JournalTransitionState,
  now: Date,
): JournalTransitionState {
  if (state.readModel === 'legacy_ledger_v1') return state;
  return {
    ...state,
    phase: 'legacy_reads',
    readModel: 'legacy_ledger_v1',
    rollbackAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: state.version + 1,
  };
}
