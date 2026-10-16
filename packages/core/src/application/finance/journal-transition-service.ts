import {
  createPostedJournal,
  DEFAULT_ACCOUNTING_POLICY,
} from '../../domain/models/financial-journal.js';
import {
  beginJournalBackfill,
  completeJournalBackfill,
  cutOverJournalReads,
  recordJournalBackfillCheckpoint,
  recordJournalComparison,
  rollbackToLegacyReads,
} from '../../domain/models/journal-transition.js';

import type { EntityId } from '../../domain/identity.js';
import type { AccountCode, FinancialJournal } from '../../domain/models/financial-journal.js';
import type {
  JournalTransitionDiscrepancy,
  JournalTransitionState,
} from '../../domain/models/journal-transition.js';
import type { LedgerEntry, LedgerEntryType } from '../../domain/models/ledger.js';
import type { ServiceDeps } from '../context.js';

const PAYABLE_ACCOUNT: Partial<Record<LedgerEntryType, AccountCode>> = {
  host_payout: 'host_payable',
  venue_share: 'venue_payable',
  promoter_commission: 'promoter_payable',
};

export interface JournalBackfillPreview {
  readonly organizations: readonly EntityId[];
  readonly journals: readonly FinancialJournal[];
  readonly projectionRepairs: readonly FinancialJournal[];
  readonly nextCursor: string | null;
}

/**
 * Migration coordinator. It never changes the active finance read model as a
 * side effect of backfill or comparison; cutover is a separate guarded call.
 */
export class JournalTransitionService {
  constructor(private readonly deps: ServiceDeps) {}

  getState(): Promise<JournalTransitionState> {
    return this.deps.repositories.journalTransition.get();
  }

  async previewNextBatch(limit = 25): Promise<JournalBackfillPreview> {
    const state = await this.getState();
    const page = await this.deps.repositories.organizations.listAll({
      cursor: state.checkpointOrganizationId,
      limit,
    });
    const journals: FinancialJournal[] = [];
    const projectionRepairs: FinancialJournal[] = [];
    for (const organization of page.items) {
      const plan = await this.buildBackfillForOrganization(organization.id);
      journals.push(...plan.journals);
      projectionRepairs.push(...plan.projectionRepairs);
    }
    return {
      organizations: page.items.map((organization) => organization.id),
      journals,
      projectionRepairs,
      nextCursor: page.nextCursor,
    };
  }

  async backfillNextBatch(limit = 25): Promise<{
    state: JournalTransitionState;
    posted: readonly FinancialJournal[];
    nextCursor: string | null;
  }> {
    let state = await this.getState();
    if (state.phase === 'legacy_reads') {
      state = beginJournalBackfill(state, this.deps.config.clock.now());
      await this.deps.repositories.journalTransition.save(state);
    }
    const preview = await this.previewNextBatch(limit);
    const posted: FinancialJournal[] = [];
    for (let index = 0; index < preview.projectionRepairs.length; index += 100) {
      await this.deps.repositories.financialJournals.postBatch(
        preview.projectionRepairs.slice(index, index + 100),
      );
    }
    for (let index = 0; index < preview.journals.length; index += 100) {
      posted.push(
        ...(await this.deps.repositories.financialJournals.postBatch(
          preview.journals.slice(index, index + 100),
        )),
      );
    }
    const lastOrganizationId = preview.organizations.at(-1);
    if (lastOrganizationId) {
      state = recordJournalBackfillCheckpoint(
        state,
        lastOrganizationId,
        posted.length,
        this.deps.config.clock.now(),
      );
      await this.deps.repositories.journalTransition.save(state);
    }
    if (preview.nextCursor === null) {
      state = completeJournalBackfill(state, this.deps.config.clock.now());
      await this.deps.repositories.journalTransition.save(state);
    }
    return { state, posted, nextCursor: preview.nextCursor };
  }

  async compare(): Promise<JournalTransitionState> {
    let cursor: string | null = null;
    const discrepancies: JournalTransitionDiscrepancy[] = [];
    do {
      const page = await this.deps.repositories.organizations.listAll({ cursor, limit: 100 });
      for (const organization of page.items) {
        const [legacyPayablePaise, journalPayablePaise] = await Promise.all([
          this.legacyPayable(organization.id),
          this.deps.repositories.financialJournals.sumPayableByOrganization(organization.id),
        ]);
        if (legacyPayablePaise !== journalPayablePaise) {
          discrepancies.push({
            organizationId: organization.id,
            legacyPayablePaise,
            journalPayablePaise,
            differencePaise: journalPayablePaise - legacyPayablePaise,
            comparedAt: this.deps.config.clock.now().toISOString(),
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    const current = await this.getState();
    const compared = recordJournalComparison(current, discrepancies, this.deps.config.clock.now());
    await this.deps.repositories.journalTransition.save(compared);
    return compared;
  }

  async cutover(): Promise<JournalTransitionState> {
    const next = cutOverJournalReads(await this.getState(), this.deps.config.clock.now());
    await this.deps.repositories.journalTransition.save(next);
    return next;
  }

  async rollback(): Promise<JournalTransitionState> {
    const current = await this.getState();
    const next = rollbackToLegacyReads(current, this.deps.config.clock.now());
    if (next !== current) await this.deps.repositories.journalTransition.save(next);
    return next;
  }

  private async buildBackfillForOrganization(organizationId: EntityId): Promise<{
    journals: FinancialJournal[];
    projectionRepairs: FinancialJournal[];
  }> {
    let cursor: string | null = null;
    const entries: LedgerEntry[] = [];
    do {
      const page = await this.deps.repositories.ledger.listByOrganization(organizationId, {
        cursor,
        limit: 100,
      });
      entries.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    const journals: FinancialJournal[] = [];
    const projectionRepairs = new Map<EntityId, FinancialJournal>();
    for (const entry of entries) {
      const account = PAYABLE_ACCOUNT[entry.entryType];
      if (!account || entry.amount === 0) continue;
      const existing = await this.deps.repositories.financialJournals.findByOrderId(entry.orderId);
      const representedBy = existing.find((journal) =>
        journal.lines.some(
          (line) => line.account === account && line.organizationId === entry.organizationId,
        ),
      );
      if (representedBy) {
        projectionRepairs.set(representedBy.id, representedBy);
        continue;
      }
      journals.push(buildLegacyPayableJournal(entry, account));
    }
    return { journals, projectionRepairs: [...projectionRepairs.values()] };
  }

  private async legacyPayable(organizationId: EntityId): Promise<number> {
    const sums = await this.deps.repositories.ledger.sumByOrganizationAndType(organizationId);
    return (['host_payout', 'venue_share', 'promoter_commission'] as const).reduce(
      (total, type) => total + sums[type].pending + sums[type].settled + sums[type].paidOut,
      0,
    );
  }
}

function buildLegacyPayableJournal(entry: LedgerEntry, account: AccountCode): FinancialJournal {
  return createPostedJournal({
    organizationId: entry.organizationId,
    currency: 'INR',
    source: {
      type: 'legacy_backfill',
      id: entry.id,
      orderId: entry.orderId,
      paymentId: null,
      eventId: entry.eventId,
    },
    idempotencyKey: `m2:legacy-backfill:${entry.id}`,
    accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
    postedAt: new Date(entry.createdAt),
    lines: [
      {
        account: 'ticket_collection_control',
        side: 'debit',
        amountPaise: entry.amount,
        organizationId: entry.organizationId,
        component: null,
        memo: `Legacy ${entry.entryType} backfill`,
      },
      {
        account,
        side: 'credit',
        amountPaise: entry.amount,
        organizationId: entry.organizationId,
        component: null,
        memo: `Legacy ${entry.entryType} payable`,
      },
    ],
  });
}
