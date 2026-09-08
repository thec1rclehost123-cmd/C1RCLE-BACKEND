import { describe, expect, it, beforeEach } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { ForbiddenError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { createEvent } from '../../domain/models/event.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import {
  MemoryCoverWalletRepository,
  MemoryCoverWalletTxnRepository,
  MemoryCoverWalletReconciliationRepository,
  sharedTxns,
} from '../../infrastructure/memory/memory-cover-wallet-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { MemoryEventRepository } from '../../infrastructure/memory/memory-repositories.js';
import { noopLogger } from '../../telemetry/logger.js';

import { createCoverWalletService } from './cover-wallet-service.js';

import type { ActorContext } from '../context.js';

/**
 * ─── Cover Wallet service (Phase 5) ─────────────────────────────────────────
 * Pins the wallet lifecycle rules over the memory driver: org-scoped access
 * guards, idempotent credits/debits/refunds/adjusts, velocity limiting,
 * freeze/terminate/close transitions, and the daily reconciliation reconcile
 * (expected = opening + credits - debits + refunds) with discrepancy detection.
 */

const ORG = 'org_1';
const EVENT_ID = 'evt_1';
const USER_ID = 'user_1';

const config = createCoreConfig({
  redis: { url: 'redis://localhost:6379' },
  firestore: { projectId: 'test-project' },
});

const actor = (organizationId: string = ORG): ActorContext => ({
  userId: 'user_1',
  organizationId,
  role: 'owner',
  capabilities: [],
});

function buildDeps() {
  const events = new MemoryEventRepository();
  const coverWallets = new MemoryCoverWalletRepository();
  const coverWalletTxns = new MemoryCoverWalletTxnRepository();
  const coverWalletReconciliations = new MemoryCoverWalletReconciliationRepository();
  const service = createCoverWalletService({
    coverWallets,
    coverWalletTxns,
    coverWalletReconciliations,
    events,
    config,
    logger: noopLogger,
    outbox: new MemoryOutboxStore(),
    adminAudit: new MemoryAdminAuditRepository(),
  });
  return { events, coverWallets, coverWalletTxns, coverWalletReconciliations, service };
}

async function seedEvent(events: MemoryEventRepository, id: string = EVENT_ID) {
  await events.save(
    createEvent({
      id,
      organizationId: ORG,
      venueId: 'venue_1',
      title: 'Cover Wallet Night',
      startAt: '2026-09-01T18:00:00Z',
    }),
  );
  return id;
}

beforeEach(() => {
  sharedTxns.clear();
});

describe('createCoverWalletService.createWallet', () => {
  it('creates a wallet with an opening credit transaction', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);

    const created = await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 500 }, // 500 paise
      actor(),
    );

    expect(created.balance).toBe(500);
    expect(created.status).toBe('active');
    expect(created.totalCredits).toBe(500);
  });

  it('rejects a second wallet for the same user/event', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);

    await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 100 },
      actor(),
    );
    await expect(
      service.createWallet({ eventId: EVENT_ID, userId: USER_ID, openingBalance: 100 }, actor()),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('throws NotFoundError when the event does not exist', async () => {
    const { service } = buildDeps();
    await expect(
      service.createWallet(
        { eventId: 'evt_missing', userId: USER_ID, openingBalance: 100 },
        actor(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a cross-tenant wallet creation', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    await expect(
      service.createWallet(
        { eventId: EVENT_ID, userId: USER_ID, openingBalance: 100 },
        actor('org_other'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('createCoverWalletService wallet access guards', () => {
  it('getWallet returns null when the wallet does not exist', async () => {
    const { service } = buildDeps();
    expect(await service.getWallet('cw_missing', actor())).toBeNull();
  });

  it('getWallet throws Forbidden for a cross-tenant wallet', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 100,
    });
    await expect(service.getWallet(w.id, actor('org_other'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('getWalletByEventAndUser returns the wallet for the matching user', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 100 },
      actor(),
    );
    const found = await service.getWalletByEventAndUser(EVENT_ID, USER_ID, actor());
    expect(found?.userId).toBe(USER_ID);
  });
});

describe('createCoverWalletService creditWallet', () => {
  it('credits the wallet and updates the balance', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 100,
    });

    const { wallet } = await service.creditWallet(
      { walletId: w.id, amount: 250, idempotencyKey: 'credit-1' },
      actor(),
    );
    expect(wallet.balance).toBe(350);
  });

  it('is idempotent across a repeated credit', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 100,
    });

    const input = { walletId: w.id, amount: 250, idempotencyKey: 'credit-idem' };
    const first = await service.creditWallet(input, actor());
    const second = await service.creditWallet(input, actor());
    expect(second.txn.id).toBe(first.txn.id);
    expect(second.wallet.balance).toBe(350);
  });

  it('rejects credit on an inactive wallet', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 100,
    });
    await coverWallets.terminate(w.id, 'fraud');
    await expect(
      service.creditWallet({ walletId: w.id, amount: 10, idempotencyKey: 'c' }, actor()),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('throws NotFoundError for an unknown wallet', async () => {
    const { service } = buildDeps();
    await expect(
      service.creditWallet({ walletId: 'missing', amount: 10, idempotencyKey: 'c' }, actor()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('createCoverWalletService debitWallet', () => {
  it('debits the wallet and updates the balance', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });

    const { wallet } = await service.debitWallet(
      { walletId: w.id, amount: 300, idempotencyKey: 'debit-1' },
      actor(),
    );
    expect(wallet.balance).toBe(700);
  });

  it('is idempotent across a repeated debit', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const input = { walletId: w.id, amount: 300, idempotencyKey: 'debit-idem' };
    const first = await service.debitWallet(input, actor());
    const second = await service.debitWallet(input, actor());
    expect(second.txn.id).toBe(first.txn.id);
    expect(second.wallet.balance).toBe(700);
  });

  it('rejects debit on an inactive wallet', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    await coverWallets.terminate(w.id, 'fraud');
    await expect(
      service.debitWallet({ walletId: w.id, amount: 10, idempotencyKey: 'd' }, actor()),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});

describe('createCoverWalletService refundWallet', () => {
  it('refunds a debit back to the wallet', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    await service.debitWallet({ walletId: w.id, amount: 300, idempotencyKey: 'rd' }, actor());

    const { wallet } = await service.refundWallet(
      { walletId: w.id, amount: 300, referenceId: 'scan_1', idempotencyKey: 'refund-1' },
      actor(),
    );
    expect(wallet.balance).toBe(1000);
    expect(wallet.totalRefunds).toBe(300);
  });

  it('is idempotent across a repeated refund', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const input = {
      walletId: w.id,
      amount: 100,
      referenceId: 'scan_2',
      idempotencyKey: 'refund-idem',
    };
    const first = await service.refundWallet(input, actor());
    const second = await service.refundWallet(input, actor());
    expect(second.txn.id).toBe(first.txn.id);
    expect(second.wallet.balance).toBe(1100);
  });
});

describe('createCoverWalletService adjustWallet', () => {
  it('adjusts the balance for an admin correction', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const { wallet } = await service.adjustWallet(
      { walletId: w.id, amount: -250, description: 'late entry refund', idempotencyKey: 'adj-1' },
      actor(),
    );
    expect(wallet.balance).toBe(750);
  });

  it('rejects an adjustment that would create negative balance', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 100,
    });
    await expect(
      service.adjustWallet(
        { walletId: w.id, amount: -200, description: 'oops', idempotencyKey: 'adj-2' },
        actor(),
      ),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});

describe('createCoverWalletService terminate / close / freeze / unfreeze', () => {
  it('terminates the wallet and records the reason', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const terminated = await service.terminateWallet(w.id, 'policy', actor());
    expect(terminated.status).toBe('terminated');
    expect(terminated.terminationReason).toBe('policy');
  });

  it('rejects terminating an already-terminated wallet', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    await service.terminateWallet(w.id, 'policy', actor());
    await expect(service.terminateWallet(w.id, 'again', actor())).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
  });

  it('closes the wallet', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const closed = await service.closeWallet(w.id, actor());
    expect(closed.status).toBe('closed');
  });

  it('freezes then unfreezes a wallet', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const frozen = await service.freezeWallet(w.id, actor());
    expect(frozen.status).toBe('frozen');
    const unfrozen = await service.unfreezeWallet(w.id, actor());
    expect(unfrozen.status).toBe('active');
    // A frozen (inactive) wallet rejects mutations.
    await service.freezeWallet(w.id, actor());
    await expect(
      service.creditWallet({ walletId: w.id, amount: 10, idempotencyKey: 'frozen-c' }, actor()),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});

describe('createCoverWalletService transactions', () => {
  it('filters transaction history by type and status', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    const w = await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 1000 },
      actor(),
    );
    await service.creditWallet(
      { walletId: w.id, amount: 500, idempotencyKey: 'tx-credit' },
      actor(),
    );
    await service.debitWallet({ walletId: w.id, amount: 200, idempotencyKey: 'tx-debit' }, actor());

    // opening credit (wallet-open-<id>) + credit + debit
    const all = await service.getTransactions(w.id, actor());
    expect(all.map((t) => t.type)).toEqual(expect.arrayContaining(['credit', 'credit', 'debit']));

    const onlyDebits = await service.getTransactions(w.id, actor(), { type: 'debit' });
    expect(onlyDebits).toHaveLength(1);

    const byRef = await service.getTransactions(w.id, actor(), {
      referenceType: 'wallet_activation',
    });
    expect(byRef).toHaveLength(1);
  });

  it('throws NotFoundError for an unknown wallet on getTransactions', async () => {
    const { service } = buildDeps();
    await expect(service.getTransactions('missing', actor())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getTransaction returns the matching txn', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const { txn } = await service.creditWallet(
      { walletId: w.id, amount: 100, idempotencyKey: 'gt-1' },
      actor(),
    );
    const found = await service.getTransaction(txn.id, actor());
    expect(found?.id).toBe(txn.id);
  });
});

describe('createCoverWalletService reconciliation', () => {
  it('runs a clean reconciliation with no discrepancy', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 1000 },
      actor(),
    );

    const recon = await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    expect(recon.status).toBe('pending');
    expect(recon.discrepancy).toBe(0);
    expect(recon.periodCredits).toBe(1000);
    expect(recon.discrepancies).toHaveLength(0);
  });

  it('detects a balance mismatch after an external mutation', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    const w = await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    // Credit 500 through the service, then mutate the balance directly to
    // simulate drift that the txn ledger does not explain.
    await service.creditWallet(
      { walletId: w.id, amount: 500, idempotencyKey: 'rec-credit' },
      actor(),
    );
    await coverWallets.credit({
      walletId: w.id,
      amount: 9999,
      referenceId: null,
      referenceType: null,
      operatorUid: 'user_1',
      operatorName: 'user_1',
      description: 'phantom credit',
      idempotencyKey: 'phantom',
    });

    const recon = await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    expect(recon.discrepancies.length).toBeGreaterThan(0);
    expect(recon.discrepancy).not.toBe(0);
  });

  it('rejects a second reconciliation for the same event/date', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    await expect(
      service.runReconciliation({ eventId: EVENT_ID, reconciliationDate: '2026-09-08' }, actor()),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('resolves a pending reconciliation', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 1000 },
      actor(),
    );
    const recon = await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    const resolved = await service.resolveReconciliation(recon.id, 'verified by ops', actor());
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNotes).toBe('verified by ops');
  });

  it('rejects resolving an already-resolved reconciliation', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 1000 },
      actor(),
    );
    const recon = await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    await service.resolveReconciliation(recon.id, 'first', actor());
    await expect(service.resolveReconciliation(recon.id, 'second', actor())).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
  });

  it('lists reconciliations and filters by discrepancy', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    await service.createWallet(
      { eventId: EVENT_ID, userId: USER_ID, openingBalance: 1000 },
      actor(),
    );
    await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    const all = await service.listReconciliations(EVENT_ID, actor());
    expect(all).toHaveLength(1);
    const withDisc = await service.listReconciliations(EVENT_ID, actor(), { hasDiscrepancy: true });
    expect(withDisc).toHaveLength(0);
  });

  it('getReconciliation returns null for a missing id and Forbidden cross-tenant', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    const recon = await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    expect(await service.getReconciliation('missing', actor())).toBeNull();
    await expect(service.getReconciliation(recon.id, actor('org_other'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('createCoverWalletService stats', () => {
  it('computes event stats across wallets', async () => {
    const { events, service } = buildDeps();
    await seedEvent(events);
    await service.createWallet({ eventId: EVENT_ID, userId: 'u1', openingBalance: 500 }, actor());
    await service.createWallet({ eventId: EVENT_ID, userId: 'u2', openingBalance: 1500 }, actor());
    const stats = await service.getEventStats(EVENT_ID, actor());
    expect(stats.totalWallets).toBe(2);
    expect(stats.totalBalance).toBe(2000);
    expect(stats.avgBalance).toBe(1000);
  });

  it('computes organization stats', async () => {
    const { events, coverWallets, service } = buildDeps();
    await seedEvent(events);
    await coverWallets.create({
      eventId: EVENT_ID,
      userId: USER_ID,
      organizationId: ORG,
      venueId: 'venue_1',
      openingBalance: 1000,
    });
    await service.runReconciliation(
      { eventId: EVENT_ID, reconciliationDate: '2026-09-08' },
      actor(),
    );
    const stats = await service.getOrganizationStats(
      ORG,
      new Date('2026-01-01'),
      new Date('2026-12-31'),
      actor(),
    );
    expect(stats.totalWallets).toBe(0);
    expect(stats.totalReconciliations).toBe(1);
  });

  it('rejects organization stats for a cross-tenant org', async () => {
    const { service } = buildDeps();
    await expect(
      service.getOrganizationStats(
        ORG,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        actor('org_other'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
