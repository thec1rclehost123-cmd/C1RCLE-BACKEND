import { describe, expect, it, beforeEach } from 'vitest';

import { createDoorService, type DoorServiceDeps } from '../application/door/door-service.js';
import { PricingService } from '../application/pricing/pricing-service.js';
import { createCoreConfig } from '../config/index.js';
import { createTicketTier } from '../domain/models/event-catalog.js';
import { createEvent } from '../domain/models/event.js';
import { noopLogger } from '../telemetry/logger.js';

import { FirestoreDoorSaleRepository } from './firestore/firestore-door-sale-repository.js';
import { MemoryAdminAuditRepository } from './memory/memory-audit-repository.js';
import {
  MemoryCoverWalletRepository,
  MemoryCoverWalletTxnRepository,
  sharedTxns,
} from './memory/memory-cover-wallet-repository.js';
import { MemoryDoorSaleRepository } from './memory/memory-door-sale-repository.js';
import { MemoryOutboxStore } from './memory/memory-outbox-store.js';
import {
  MemoryEventCatalogRepository,
  MemoryEventRepository,
} from './memory/memory-repositories.js';

import type { ActorContext } from '../application/context.js';
import type { DoorSale, DoorSaleCreateInput } from '../domain/models/door-sale.js';

/**
 * ─── Phase 5 door-sale regressions ──────────────────────────────────────────
 *
 * Two behaviour bugs this file locks down:
 *
 * 1. Adapter parity on `create`. `DoorSaleRepository.create` is declared
 *    `create(input: DoorSaleCreateInput): Promise<DoorSale>` — the repository
 *    mints the entity. The memory adapter honoured that; the Firestore adapter
 *    was written as `create(sale: DoorSale)` and persisted whatever the caller
 *    had already built (it only compiled because TS method parameters are
 *    bivariant). The same call therefore returned a different id depending on
 *    which adapter was wired, and a port-shaped call would have written a
 *    document with `id: undefined`.
 *
 * 2. Unconditional wallet refund on void. The cover-wallet debit at sale
 *    creation is conditional (`canWalletDebit`), but `voidSale` refunded
 *    `sale.amountPaise` whenever a wallet existed — minting balance for sales
 *    whose debit was skipped. The transaction ledger is the source of truth.
 *
 * Kept out of `contract-suite.test.ts` deliberately: that file is being
 * reworked for the scan-ledger slice in parallel.
 */

// ─── Bug 1: adapter parity ──────────────────────────────────────────────────

const DOOR_SALES_COLLECTION = 'v2_door_sales';
const IDEMPOTENCY_COLLECTION = 'v2_door_sale_idempotency';

interface FakeDocSnapshot {
  data(): Record<string, unknown> | undefined;
}

interface FakeDocRef {
  set(data: Record<string, unknown>): Promise<void>;
  get(): Promise<FakeDocSnapshot>;
}

interface FakeCollectionRef {
  doc(id: string): FakeDocRef;
}

/**
 * Hermetic stand-in for the Firestore handle — a Map per collection, enough
 * of the surface for the door-sale adapter (`collection().doc().set/get`).
 * The repository's constructor takes firebase-admin's `Firestore` class, which
 * cannot be implemented structurally, so the handle is `any` at that seam
 * only (no `as`-cast; `any` in a `.test.ts` matches `contract-suite.test.ts`'s
 * existing style). The rest of the repo's live Firestore coverage stays in
 * `firestore/firestore-repositories.integration.test.ts`, which is
 * network-gated and skipped by default.
 */
function createFakeFirestore() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();

  function storeFor(name: string): Map<string, Record<string, unknown>> {
    let store = collections.get(name);
    if (!store) {
      store = new Map<string, Record<string, unknown>>();
      collections.set(name, store);
    }
    return store;
  }

  // `any` only at the constructor seam — see the doc comment above.
  const db: any = {
    collection(name: string): FakeCollectionRef {
      const store = storeFor(name);
      return {
        doc(id: string): FakeDocRef {
          return {
            async set(data: Record<string, unknown>): Promise<void> {
              store.set(id, data);
            },
            async get(): Promise<FakeDocSnapshot> {
              return { data: () => store.get(id) };
            },
          };
        },
      };
    },
  };

  return {
    db,
    written: (name: string): Record<string, unknown>[] => [...storeFor(name).values()],
  };
}

function doorSaleInput(overrides: Partial<DoorSaleCreateInput> = {}): DoorSaleCreateInput {
  return {
    eventId: 'evt_test',
    organizationId: 'org_test',
    venueId: 'venue_test',
    category: 'walkin',
    guestName: 'John Doe',
    guestPhone: '+1234567890',
    guestAge: 25,
    gender: 'male',
    contact: 'john@example.com',
    totalGuests: 2,
    tableNumber: null,
    gate: 'Gate A',
    paymentMode: 'cash',
    amountPaise: 50000,
    createdBy: 'usr_operator',
    createdByName: 'Operator',
    idempotencyKey: 'idem_parity_1',
    ...overrides,
  };
}

/** Everything except the values the factory generates fresh on every call. */
function comparableFields(sale: DoorSale): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...sale };
  delete copy.id;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

describe('DoorSaleRepository.create — memory/Firestore adapter parity', () => {
  it('both adapters mint the entity from the same DoorSaleCreateInput', async () => {
    const memory = new MemoryDoorSaleRepository();
    const firestore = new FirestoreDoorSaleRepository(createFakeFirestore().db);
    const input = doorSaleInput();

    const fromMemory = await memory.create(input);
    const fromFirestore = await firestore.create(doorSaleInput());

    // The adapter mints — the caller never supplies an id.
    expect(typeof fromFirestore.id).toBe('string');
    expect(fromFirestore.id.startsWith('DS-')).toBe(true);
    expect(fromFirestore.version).toBe(1);
    expect(fromFirestore.status).toBe('active');
    expect(fromFirestore.paymentStatus).toBe('collected');

    // Same input in, entities that differ only in the generated id/timestamps.
    expect(comparableFields(fromFirestore)).toEqual(comparableFields(fromMemory));
  });

  it('persists the minted id (never an undefined document id) and the idempotency pointer', async () => {
    const fake = createFakeFirestore();
    const firestore = new FirestoreDoorSaleRepository(fake.db);

    const created = await firestore.create(doorSaleInput({ idempotencyKey: 'idem_parity_2' }));

    const [saved] = fake.written(DOOR_SALES_COLLECTION);
    expect(saved?.id).toBe(created.id);
    expect(saved?.id).toBeTypeOf('string');
    expect(saved?.version).toBe(1);

    const [pointer] = fake.written(IDEMPOTENCY_COLLECTION);
    expect(pointer?.saleId).toBe(created.id);

    // Round-trips through the adapter's own reader.
    const found = await firestore.findByIdempotencyKey('idem_parity_2');
    expect(found?.id).toBe(created.id);
  });
});

// ─── Bug 2: wallet refunds follow the ledger ────────────────────────────────

const ACTOR: ActorContext = {
  userId: 'usr_operator',
  organizationId: 'org_test',
  role: 'owner',
  capabilities: [],
};

const EVENT_ID = 'evt_door_test';
const WALK_IN_PRICE_PAISE = 50000;

/** Records what the service hands the repository's `create`. */
class RecordingDoorSaleRepository extends MemoryDoorSaleRepository {
  createCalls: DoorSaleCreateInput[] = [];

  override async create(input: DoorSaleCreateInput): Promise<DoorSale> {
    this.createCalls.push(input);
    return super.create(input);
  }
}

async function buildDoorFixture() {
  const doorSales = new RecordingDoorSaleRepository();
  const events = new MemoryEventRepository();
  const catalog = new MemoryEventCatalogRepository();
  const coverWallets = new MemoryCoverWalletRepository();
  const coverWalletTxns = new MemoryCoverWalletTxnRepository();

  const deps: DoorServiceDeps = {
    doorSales,
    events,
    catalog,
    coverWallets,
    coverWalletTxns,
    config: createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
    }),
    logger: noopLogger,
    outbox: new MemoryOutboxStore(),
    adminAudit: new MemoryAdminAuditRepository(),
    pricing: new PricingService({ eventCatalog: catalog }),
  };

  await events.save(
    createEvent({
      id: EVENT_ID,
      organizationId: 'org_test',
      venueId: 'venue_test',
      title: 'Door Sale Regression Night',
      startAt: '2026-09-01T18:00:00Z',
    }),
  );
  await catalog.saveTier(
    createTicketTier({
      id: 'tier_walkin',
      eventId: EVENT_ID,
      organizationId: 'org_test',
      name: 'Walk-in',
      entryType: 'walkin',
      priceInPaise: WALK_IN_PRICE_PAISE,
      quantity: 100,
    }),
  );

  return { deps, doorSales, coverWallets, coverWalletTxns, service: createDoorService(deps) };
}

function walkInPayload(idempotencyKey: string) {
  return {
    eventId: EVENT_ID,
    guestName: 'Ada Lovelace',
    totalGuests: 1,
    paymentMode: 'cash' as const,
    idempotencyKey,
  };
}

beforeEach(() => {
  sharedTxns.clear();
});

describe('DoorService.createWalkIn — the repository mints, the service uses what it returns', () => {
  it('hands the repository a bare create input, not an already-built entity', async () => {
    const { doorSales, service } = await buildDoorFixture();

    const sale = await service.createWalkIn(walkInPayload('idem-mint-1'), ACTOR);

    const [recorded] = doorSales.createCalls;
    expect(doorSales.createCalls).toHaveLength(1);
    // A pre-built `DoorSale` would carry these; a `DoorSaleCreateInput` never does.
    expect(Object.keys(recorded ?? {})).not.toContain('id');
    expect(Object.keys(recorded ?? {})).not.toContain('version');
    expect(Object.keys(recorded ?? {})).not.toContain('createdAt');
    expect(Object.keys(recorded ?? {})).not.toContain('status');

    // The returned entity is the persisted one — the same id under any adapter.
    const stored = await doorSales.findById(sale.id);
    expect(stored?.id).toBe(sale.id);
    expect(sale.amountPaise).toBe(WALK_IN_PRICE_PAISE);
  });
});

describe('DoorService.voidSale — refunds follow the wallet transaction ledger', () => {
  it('does not credit the wallet when the sale never debited it', async () => {
    const { coverWallets, coverWalletTxns, service } = await buildDoorFixture();

    // Balance below the walk-in price: `canWalletDebit` rejects, the service
    // skips the debit, and the sale still goes through.
    const wallet = await coverWallets.create({
      userId: ACTOR.userId,
      eventId: EVENT_ID,
      organizationId: 'org_test',
      venueId: 'venue_test',
      openingBalance: 100,
    });

    const sale = await service.createWalkIn(walkInPayload('idem-no-debit'), ACTOR);
    expect(await coverWalletTxns.findByReference(sale.id, 'door_sale')).toHaveLength(0);

    const voided = await service.voidSale(sale.id, 'guest left', ACTOR);
    expect(voided.status).toBe('voided');

    const after = await coverWallets.findById(wallet.id);
    expect(after?.balance).toBe(100);
    expect(after?.totalRefunds).toBe(0);
    expect(await coverWalletTxns.findByReference(sale.id, 'refund')).toHaveLength(0);
  });

  it('refunds exactly the committed debit when the wallet was debited', async () => {
    const { coverWallets, coverWalletTxns, service } = await buildDoorFixture();

    const wallet = await coverWallets.create({
      userId: ACTOR.userId,
      eventId: EVENT_ID,
      organizationId: 'org_test',
      venueId: 'venue_test',
      openingBalance: 200000,
    });

    const sale = await service.createWalkIn(walkInPayload('idem-debited'), ACTOR);
    expect(await coverWalletTxns.findByReference(sale.id, 'door_sale')).toHaveLength(1);

    const debited = await coverWallets.findById(wallet.id);
    expect(debited?.balance).toBe(200000 - WALK_IN_PRICE_PAISE);

    await service.voidSale(sale.id, 'duplicate entry', ACTOR);

    const after = await coverWallets.findById(wallet.id);
    expect(after?.balance).toBe(200000);
    expect(after?.totalRefunds).toBe(WALK_IN_PRICE_PAISE);
  });

  it('voids cleanly when the event has no cover wallet at all', async () => {
    const { coverWalletTxns, service } = await buildDoorFixture();

    const sale = await service.createWalkIn(walkInPayload('idem-no-wallet'), ACTOR);
    const voided = await service.voidSale(sale.id, 'no wallet', ACTOR);

    expect(voided.status).toBe('voided');
    expect(await coverWalletTxns.findByReference(sale.id, 'refund')).toHaveLength(0);
  });
});

describe('DoorService.refundSale — same ledger rule as void', () => {
  it('does not credit the wallet for a partial refund when no debit occurred', async () => {
    const { coverWallets, coverWalletTxns, service } = await buildDoorFixture();

    const wallet = await coverWallets.create({
      userId: ACTOR.userId,
      eventId: EVENT_ID,
      organizationId: 'org_test',
      venueId: 'venue_test',
      openingBalance: 100,
    });

    const sale = await service.createWalkIn(walkInPayload('idem-refund-no-debit'), ACTOR);
    const refunded = await service.refundSale(sale.id, 20000, ACTOR);

    expect(refunded.status).toBe('refunded');
    expect(refunded.refundedAmountPaise).toBe(20000);

    const after = await coverWallets.findById(wallet.id);
    expect(after?.balance).toBe(100);
    expect(await coverWalletTxns.findByReference(sale.id, 'refund')).toHaveLength(0);
  });

  it('still credits a partial refund back to a wallet that was debited', async () => {
    const { coverWallets, service } = await buildDoorFixture();

    const wallet = await coverWallets.create({
      userId: ACTOR.userId,
      eventId: EVENT_ID,
      organizationId: 'org_test',
      venueId: 'venue_test',
      openingBalance: 200000,
    });

    const sale = await service.createWalkIn(walkInPayload('idem-refund-debited'), ACTOR);
    await service.refundSale(sale.id, 20000, ACTOR);

    const after = await coverWallets.findById(wallet.id);
    expect(after?.balance).toBe(200000 - WALK_IN_PRICE_PAISE + 20000);
    expect(after?.totalRefunds).toBe(20000);
  });
});
