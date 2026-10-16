import { describe, expect, it } from 'vitest';

import { MemoryJournalTransitionRepository } from '../infrastructure/memory/memory-journal-transition-repository.js';

import { VersionConflictError } from './errors.js';
import {
  beginJournalBackfill,
  completeJournalBackfill,
  cutOverJournalReads,
  DEFAULT_JOURNAL_TRANSITION_STATE,
  recordJournalBackfillCheckpoint,
  recordJournalComparison,
  rollbackToLegacyReads,
} from './models/journal-transition.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');

describe('journal transition state machine', () => {
  it('requires ordered backfill, comparison and discrepancy-free cutover', () => {
    const initial = { ...DEFAULT_JOURNAL_TRANSITION_STATE };
    expect(() => completeJournalBackfill(initial, NOW)).toThrow('active backfill');
    expect(() => recordJournalBackfillCheckpoint(initial, 'org_1', 1, NOW)).toThrow(
      'backfill phase',
    );
    expect(() => recordJournalComparison(initial, [], NOW)).toThrow('completed backfill');
    expect(() => cutOverJournalReads(initial, NOW)).toThrow('completed comparison');

    const started = beginJournalBackfill(initial, NOW);
    const checkpointed = recordJournalBackfillCheckpoint(started, 'org_1', 2, NOW);
    expect(checkpointed).toMatchObject({
      phase: 'backfill',
      checkpointOrganizationId: 'org_1',
      backfilledEntries: 2,
    });
    expect(() => recordJournalComparison(checkpointed, [], NOW)).toThrow('completed backfill');

    const completed = completeJournalBackfill(checkpointed, NOW);
    const discrepancy = {
      organizationId: 'org_1',
      legacyPayablePaise: 100,
      journalPayablePaise: 90,
      differencePaise: -10,
      comparedAt: NOW.toISOString(),
    };
    const mismatched = recordJournalComparison(completed, [discrepancy], NOW);
    expect(() => cutOverJournalReads(mismatched, NOW)).toThrow('blocked');

    const compared = recordJournalComparison(mismatched, [], NOW);
    const cutover = cutOverJournalReads(compared, NOW);
    expect(cutover).toMatchObject({
      phase: 'journal_reads',
      readModel: 'financial_journal_v2',
    });
    expect(() => beginJournalBackfill(cutover, NOW)).toThrow('Rollback');

    const rolledBack = rollbackToLegacyReads(cutover, NOW);
    expect(rolledBack).toMatchObject({ phase: 'legacy_reads', readModel: 'legacy_ledger_v1' });
    expect(rollbackToLegacyReads(rolledBack, NOW)).toBe(rolledBack);
  });

  it('optimistically persists transition state', async () => {
    const repository = new MemoryJournalTransitionRepository();
    const started = beginJournalBackfill(await repository.get(), NOW);
    await repository.save(started);
    expect((await repository.get()).phase).toBe('backfill');

    await expect(repository.save(started)).rejects.toBeInstanceOf(VersionConflictError);
  });
});
