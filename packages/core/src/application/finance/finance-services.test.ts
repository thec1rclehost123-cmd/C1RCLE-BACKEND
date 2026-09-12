import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { ForbiddenError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { createLedgerEntry } from '../../domain/models/ledger.js';
import { MemoryBankAccountRepository } from '../../infrastructure/memory/memory-bank-account-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import { MemoryPayoutRepository } from '../../infrastructure/memory/memory-payout-repository.js';

import { createBankAccountService } from './bank-account-service.js';
import { createFinanceService } from './finance-service.js';
import { createPayoutService } from './payout-service.js';

import type { ActorContext } from '../context.js';

/**
 * ─── Phase 6 finance services over the memory driver ─────────────────────────
 * The route suite (apps/api-gateway/finance-routes.test.ts) covers the happy
 * path over HTTP; these unit tests pin the service rules directly — idempotent
 * ledger replays, balance bucketing, payout draw-down guards (min amount,
 * available balance, ownership) and the account-number-at-rest flow.
 */

const ORG = 'org_1';
const HOST = 'org_host';
const VENUE = 'org_venue';
const PROMOTER = 'org_promoter';
const NOW = new Date('2026-09-07T00:00:00.000Z');

const config = createCoreConfig({
  redis: { url: 'redis://localhost:6379' },
  firestore: { projectId: 'test-project' },
  clock: { now: () => NOW },
});

const actor = (organizationId: string): ActorContext => ({
  userId: 'user_1',
  organizationId,
  role: 'owner',
  capabilities: [],
});

function seedLedger(repo: MemoryLedgerRepository, organizationId: string) {
  return repo.createBatch([
    createLedgerEntry({
      id: 'led-1',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'ticket_revenue',
      amount: 100_000,
      status: 'settled',
      idempotencyKey: 'order_1:ticket_revenue',
      now: NOW,
    }),
    createLedgerEntry({
      id: 'led-2',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'host_payout',
      amount: 70_000,
      status: 'pending',
      idempotencyKey: 'order_1:host_payout',
      now: NOW,
    }),
    createLedgerEntry({
      id: 'led-3',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'venue_share',
      amount: 10_000,
      status: 'settled',
      idempotencyKey: 'order_1:venue_share',
      now: NOW,
    }),
    createLedgerEntry({
      id: 'led-4',
      organizationId,
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'venue_share',
      amount: 10_000,
      status: 'paid_out',
      idempotencyKey: 'order_1:venue_share:paid',
      now: NOW,
    }),
  ]);
}

describe('createFinanceService', () => {
  it('rejects a cross-tenant recordTicketSale', async () => {
    const service = createFinanceService({ ledger: new MemoryLedgerRepository(), config });
    await expect(
      service.recordTicketSale(
        {
          organizationId: 'org_other',
          orderId: 'order_x',
          eventId: 'evt_x',
          grossAmount: 100_000,
          hostOrganizationId: HOST,
          venueOrganizationId: VENUE,
          promoterOrganizationId: null,
          platformFeeRate: 0.15,
          venueShareRate: 0.1,
          promoterCommissionRate: null,
        },
        actor('org_1'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('records a full split (host/venue/promoter) and sums to gross', async () => {
    const repo = new MemoryLedgerRepository();
    const service = createFinanceService({ ledger: repo, config });
    const entries = await service.recordTicketSale(
      {
        organizationId: ORG,
        orderId: 'order_1',
        eventId: 'evt_1',
        grossAmount: 100_000,
        hostOrganizationId: HOST,
        venueOrganizationId: VENUE,
        promoterOrganizationId: PROMOTER,
        platformFeeRate: 0.15,
        venueShareRate: 0.1,
        promoterCommissionRate: 0.05,
      },
      actor(ORG),
    );

    expect(entries).toHaveLength(5);
    const types = entries.map((e) => e.entryType).sort();
    expect(types).toEqual([
      'host_payout',
      'platform_fee',
      'promoter_commission',
      'ticket_revenue',
      'venue_share',
    ]);
    // Settlement split legs sum to gross (separate from the ticket_revenue leg).
    const splitEntries = entries.filter((e) => e.entryType !== 'ticket_revenue');
    const splitSum = splitEntries.reduce((sum, e) => sum + e.amount, 0);
    expect(splitSum).toBe(100_000);
    // host_payout is derived as the remainder (gross - shares).
    const host = entries.find((e) => e.entryType === 'host_payout');
    expect(host?.amount).toBe(70_000);
  });

  it('is idempotent: a replayed orderId returns the existing entries untouched', async () => {
    const repo = new MemoryLedgerRepository();
    const service = createFinanceService({ ledger: repo, config });
    const input = {
      organizationId: ORG,
      orderId: 'order_1',
      eventId: 'evt_1',
      grossAmount: 100_000,
      hostOrganizationId: HOST,
      venueOrganizationId: VENUE,
      promoterOrganizationId: null,
      platformFeeRate: 0.15,
      venueShareRate: 0.1,
      promoterCommissionRate: null,
    };
    const first = await service.recordTicketSale(input, actor(ORG));
    const second = await service.recordTicketSale(input, actor(ORG));
    expect(second).toHaveLength(first.length);
    expect(await repo.findByOrder('order_1')).toHaveLength(first.length);
  });

  it('keeps ledger entry ids within the 64-char opaque-id cap for long order/org ids', async () => {
    const repo = new MemoryLedgerRepository();
    const service = createFinanceService({ ledger: repo, config });
    // Razorpay-style long order id + UUID orgs — reproduces the scenario-suite
    // bug where `led-{orderId}-{entryType}-{orgId}` exceeded 64 chars and the
    // frozen wire contract's opaqueIdSchema (max 64) rejected the ledger DTO.
    const input = {
      orderId: 'ORD-pay_2xUeF1PdGqJ7Qj3Z9k8LmW5yvAaCcNnO',
      eventId: 'evt_1',
      grossAmount: 100_000,
      organizationId: 'd0ef124c-a769-4baa-98c7-ed462a81f746',
      hostOrganizationId: 'd0ef124c-a769-4baa-98c7-ed462a81f746',
      venueOrganizationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      promoterOrganizationId: null,
      platformFeeRate: 0.15,
      venueShareRate: 0.1,
      promoterCommissionRate: null,
    };
    const entries = await service.recordTicketSale(input, actor(input.organizationId));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id.length).toBeLessThanOrEqual(64);
      expect(entry.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
      expect(entry.id).not.toContain(':');
    }
    // Replay must produce the same deterministic ids (idempotency preserved).
    const replay = await service.recordTicketSale(input, actor(input.organizationId));
    expect(replay.map((e) => e.id).sort()).toEqual(entries.map((e) => e.id).sort());
  });

  it('getBalances buckets pending/settled/paid_out per the ledger', async () => {
    const repo = new MemoryLedgerRepository();
    await seedLedger(repo, ORG);
    const service = createFinanceService({ ledger: repo, config });

    const balances = await service.getBalances(ORG, actor(ORG));
    // host_payout 70k pending; venue_share 10k settled minus 10k paid out.
    expect(balances).toEqual({
      availablePaise: 0,
      pendingPaise: 70_000,
      lifetimePaise: 90_000,
    });
  });

  it('getBalances reflects settled inflow minus paid out when nothing is pending', async () => {
    const repo = new MemoryLedgerRepository();
    await repo.createBatch([
      createLedgerEntry({
        id: 'led-a',
        organizationId: ORG,
        orderId: 'order_a',
        eventId: 'evt_a',
        entryType: 'host_payout',
        amount: 50_000,
        status: 'settled',
        idempotencyKey: 'order_a:host_payout',
        now: NOW,
      }),
      createLedgerEntry({
        id: 'led-b',
        organizationId: ORG,
        orderId: 'order_a',
        eventId: 'evt_a',
        entryType: 'host_payout',
        amount: 20_000,
        status: 'paid_out',
        idempotencyKey: 'order_a:host_payout:paid',
        now: NOW,
      }),
    ]);
    const service = createFinanceService({ ledger: repo, config });
    const balances = await service.getBalances(ORG, actor(ORG));
    expect(balances.availablePaise).toBe(30_000);
    expect(balances.pendingPaise).toBe(0);
    expect(balances.lifetimePaise).toBe(70_000);
  });

  it('listLedgerEntries pages in reverse-chronological order', async () => {
    const repo = new MemoryLedgerRepository();
    await seedLedger(repo, ORG);
    const service = createFinanceService({ ledger: repo, config });

    const page1 = await service.listLedgerEntries(ORG, actor(ORG), { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(4);
    const page2 = await service.listLedgerEntries(ORG, actor(ORG), {
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((e) => e.id);
    expect(ids).toEqual(['led-1', 'led-2', 'led-3', 'led-4']);
  });

  it('listLedgerEntries rejects cross-tenant access', async () => {
    const service = createFinanceService({ ledger: new MemoryLedgerRepository(), config });
    await expect(
      service.listLedgerEntries('org_other', actor(ORG), { limit: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('createPayoutService', () => {
  function makeDeps() {
    const payouts = new MemoryPayoutRepository();
    const bankAccounts = new MemoryBankAccountRepository();
    const ledger = new MemoryLedgerRepository();
    const service = createPayoutService({ payouts, bankAccounts, ledger, config });
    return { payouts, bankAccounts, ledger, service };
  }

  async function seedDefaults(deps: ReturnType<typeof makeDeps>) {
    const { bankAccounts, ledger } = deps;
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led-avail',
        organizationId: ORG,
        orderId: 'order_avail',
        eventId: 'evt_1',
        entryType: 'host_payout',
        amount: 100_000,
        status: 'settled',
        idempotencyKey: 'order_avail:host_payout',
        now: NOW,
      }),
    ]);
    await bankAccounts.create(
      createBankAccountFixture('bank_1', ORG, true, '••1234', 'envelope-1'),
    );
  }

  function createBankAccountFixture(
    id: string,
    organizationId: string,
    isDefault: boolean,
    last4 = '1234',
    encryptedAccountNumber = 'iv:tag:cipher',
  ) {
    return {
      id,
      organizationId,
      bankName: 'HDFC Bank',
      accountHolder: 'Test Org',
      last4,
      encryptedAccountNumber,
      ifscCode: 'HDFC0001234',
      isDefault,
      verified: false,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
  }

  it('requestPayout draws down the default account', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000 },
      actor(ORG),
    );
    expect(payout.status).toBe('requested');
    expect(payout.bankAccountId).toBe('bank_1');
    expect(payout.requestedBy).toBe('user_1');
  });

  it('requestPayout honors an explicit bankAccountId', async () => {
    const deps = makeDeps();
    const { bankAccounts, ledger } = deps;
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led-avail',
        organizationId: ORG,
        orderId: 'order_avail',
        eventId: 'evt_1',
        entryType: 'host_payout',
        amount: 100_000,
        status: 'settled',
        idempotencyKey: 'order_avail:host_payout',
        now: NOW,
      }),
    ]);
    await bankAccounts.create(createBankAccountFixture('bank_a', ORG, true));
    await bankAccounts.create(createBankAccountFixture('bank_b', ORG, false));
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 25_000, bankAccountId: 'bank_b' },
      actor(ORG),
    );
    expect(payout.bankAccountId).toBe('bank_b');
  });

  it('requestPayout throws NotFoundError when the bank account is missing', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    await expect(
      deps.service.requestPayout(
        { organizationId: ORG, amount: 50_000, bankAccountId: 'bank_nope' },
        actor(ORG),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requestPayout throws ForbiddenError for an account from another org', async () => {
    const deps = makeDeps();
    const { bankAccounts, ledger } = deps;
    await ledger.createBatch([
      createLedgerEntry({
        id: 'led-avail',
        organizationId: ORG,
        orderId: 'order_avail',
        eventId: 'evt_1',
        entryType: 'host_payout',
        amount: 100_000,
        status: 'settled',
        idempotencyKey: 'order_avail:host_payout',
        now: NOW,
      }),
    ]);
    await bankAccounts.create(createBankAccountFixture('bank_other', 'org_other', true));
    await expect(
      deps.service.requestPayout(
        { organizationId: ORG, amount: 50_000, bankAccountId: 'bank_other' },
        actor(ORG),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('requestPayout rejects amounts above the available balance', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    await expect(
      deps.service.requestPayout({ organizationId: ORG, amount: 200_000 }, actor(ORG)),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('beginProcessing → complete moves a payout to paid with a processedAt', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000 },
      actor(ORG),
    );
    const processing = await deps.service.beginProcessingPayout(payout.id, actor(ORG));
    expect(processing.status).toBe('processing');
    expect(processing.version).toBe(2);
    const paid = await deps.service.completePayout(payout.id, actor(ORG));
    expect(paid.status).toBe('paid');
    expect(paid.processedAt).toBe(NOW.toISOString());
    expect(paid.version).toBe(3);
  });

  it('failPayout marks a requested payout failed with a reason', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000 },
      actor(ORG),
    );
    const failed = await deps.service.failPayout(payout.id, 'insufficient funds', actor(ORG));
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('insufficient funds');
    expect(failed.processedAt).toBe(NOW.toISOString());
  });

  it('beginProcessingPayout throws NotFoundError for an unknown payout', async () => {
    const deps = makeDeps();
    await expect(
      deps.service.beginProcessingPayout('payout_nope', actor(ORG)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('completePayout rejects cross-tenant access', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000 },
      actor(ORG),
    );
    await expect(deps.service.completePayout(payout.id, actor('org_other'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('listPayouts returns only this org payouts', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    const { payouts } = deps;
    for (const [idx, amount] of [10_000, 20_000, 30_000].entries()) {
      await payouts.create({
        id: `payout-${ORG}-${idx}`,
        organizationId: ORG,
        bankAccountId: 'bank_1',
        amount,
        status: 'requested',
        failureReason: null,
        requestedBy: 'user_1',
        processedAt: null,
        previousStatus: null,
        version: 1,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    }
    await payouts.create({
      id: `payout-org_other-0`,
      organizationId: 'org_other',
      bankAccountId: 'bank_x',
      amount: 10_000,
      status: 'requested',
      failureReason: null,
      requestedBy: 'user_1',
      processedAt: null,
      previousStatus: null,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const page = await deps.service.listPayouts(ORG, actor(ORG), { limit: 10 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(3);
  });

  it('getPayout returns null for a missing payout and the payout when found', async () => {
    const deps = makeDeps();
    await seedDefaults(deps);
    expect(await deps.service.getPayout('payout_nope', actor(ORG))).toBeNull();
    const payout = await deps.service.requestPayout(
      { organizationId: ORG, amount: 50_000 },
      actor(ORG),
    );
    expect((await deps.service.getPayout(payout.id, actor(ORG)))?.id).toBe(payout.id);
  });
});

describe('createBankAccountService', () => {
  function makeDeps() {
    const bankAccounts = new MemoryBankAccountRepository();
    const service = createBankAccountService({ bankAccounts, config });
    return { bankAccounts, service };
  }

  it('adds a bank account as default when it is the first, with masked + encrypted number', async () => {
    const { service, bankAccounts } = makeDeps();
    const account = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC Bank',
        accountHolder: 'Test Org',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    expect(account.isDefault).toBe(true);
    expect(account.last4).toBe('7890');
    expect(account.encryptedAccountNumber).toContain(':');
    expect(account.encryptedAccountNumber).not.toBe('00001234567890');
    expect(bankAccounts.accounts.size).toBe(1);
  });

  it('adds subsequent accounts as non-default', async () => {
    const { service } = makeDeps();
    await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    const second = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'ICICI',
        accountHolder: 'B',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
      actor(ORG),
    );
    expect(second.isDefault).toBe(false);
    expect(second.last4).toBe('8877');
  });

  it('rejects cross-tenant account creation', async () => {
    const { service } = makeDeps();
    await expect(
      service.addBankAccount(
        {
          organizationId: 'org_other',
          bankName: 'HDFC',
          accountHolder: 'A',
          accountNumber: '00001234567890',
          ifscCode: 'HDFC0001234',
        },
        actor(ORG),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('setDefaultBankAccount unsets the previous default', async () => {
    const { service, bankAccounts } = makeDeps();
    const first = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    const second = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'ICICI',
        accountHolder: 'B',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
      actor(ORG),
    );
    const madeDefault = await service.setDefaultBankAccount(second.id, actor(ORG));
    expect(madeDefault.isDefault).toBe(true);
    const after = await bankAccounts.findById(first.id);
    expect(after?.isDefault).toBe(false);
  });

  it('setDefaultBankAccount throws NotFoundError for a missing account', async () => {
    const { service } = makeDeps();
    await expect(service.setDefaultBankAccount('bank_nope', actor(ORG))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('removeAccount removes a non-default account and rejects a default', async () => {
    const { service, bankAccounts } = makeDeps();
    const defaultAccount = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    const second = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'ICICI',
        accountHolder: 'B',
        accountNumber: '00009999888877',
        ifscCode: 'ICIC0001234',
      },
      actor(ORG),
    );
    await expect(service.removeAccount(defaultAccount.id, actor(ORG))).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
    await service.removeAccount(second.id, actor(ORG));
    expect(await bankAccounts.findById(second.id)).toBeNull();
  });

  it('removeAccount rejects cross-tenant access', async () => {
    const { service, bankAccounts } = makeDeps();
    const account = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    await expect(service.removeAccount(account.id, actor('org_other'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(bankAccounts.accounts.size).toBe(1);
  });

  it('getFullAccountNumber round-trips the decrypted number', async () => {
    const { service } = makeDeps();
    const account = await service.addBankAccount(
      {
        organizationId: ORG,
        bankName: 'HDFC',
        accountHolder: 'A',
        accountNumber: '00001234567890',
        ifscCode: 'HDFC0001234',
      },
      actor(ORG),
    );
    expect(await service.getFullAccountNumber(account.id, actor(ORG))).toBe('00001234567890');
  });

  it('getFullAccountNumber throws InvalidOperationError when the field is unset', async () => {
    const { bankAccounts } = makeDeps();
    const deps = { bankAccounts, config };
    const service = createBankAccountService(deps);
    const account = {
      id: 'bank_plain',
      organizationId: ORG,
      bankName: 'HDFC',
      accountHolder: 'A',
      last4: '7890',
      encryptedAccountNumber: '',
      ifscCode: 'HDFC0001234',
      isDefault: true,
      verified: false,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    await bankAccounts.create(account);
    await expect(service.getFullAccountNumber(account.id, actor(ORG))).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
  });
});
