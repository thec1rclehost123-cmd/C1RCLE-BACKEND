import { sharedTxns } from '@c1rcle/core/infrastructure';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';
import type { CoverWallet } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import doorOpsRoutes from './door-ops-routes.js';
import doorCodeRoutes from './event-code-routes.js';
import phase5ScannerRoutes from './scanner-routes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Door commerce: cover-wallet tabs and the paid walk-up sale ─────────────
 *
 * The two places money moves at a door. Both are tested for the thing that
 * actually costs someone money if it is wrong: that the scanner can never
 * name a price, that a retry never charges twice, and that a session without
 * the right permission cannot take money at all.
 */

const services = createV2Services();

const ORG_ID = 'org_com_1';
const EVENT_ID = 'evt_com_1';
const DEVICE_ID = 'device_com_0000000001';

const SEED_ACTOR: ActorContext = {
  userId: 'staff_com_1',
  organizationId: ORG_ID,
  role: 'owner',
  capabilities: [],
};
const HEADERS = { 'x-organization-id': ORG_ID };

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  const codes = repos.eventCodes as unknown as {
    codes: Map<string, unknown>;
    byCode: Map<string, string>;
  };
  codes.codes.clear();
  codes.byCode.clear();
  const sessions = repos.scannerSessions as unknown as {
    sessions: Map<string, unknown>;
    byTokenHash: Map<string, string>;
  };
  sessions.sessions.clear();
  sessions.byTokenHash.clear();
  (repos.scannerDevices as unknown as { devices: Map<string, unknown> }).devices.clear();
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();
  (repos.scanLedger as unknown as { scans: Map<string, unknown> }).scans.clear();
  (repos.coverWallets as unknown as { wallets: Map<string, unknown> }).wallets?.clear();
  // The memory transaction store is process-wide, and the velocity limit
  // (3 debits/minute/device) counts across it — leaving yesterday's test
  // charges in place would make an unrelated test fail as "too fast".
  sharedTxns.clear();

  server = await buildPartnerTestServer({
    routes: [doorCodeRoutes, phase5ScannerRoutes, doorOpsRoutes],
  });
  server.addHook('onRequest', async (request) => {
    request.actor = { ...SEED_ACTOR, platformRole: 'staff' };
  });

  await seedEvent();
});

async function seedEvent(): Promise<void> {
  if (await services.repos().events.findById(EVENT_ID)) return;
  const now = new Date().toISOString();
  await services.repos().events.save({
    id: EVENT_ID,
    organizationId: ORG_ID,
    venueId: null,
    slug: 'door-commerce-event',
    title: 'Door Commerce Night',
    summary: '',
    description: '',
    imageUrl: null,
    startAt: now,
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: [],
    startingPricePaise: null,
    isFree: false,
    cancellationReason: null,
    capacity: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

/** Opens a shift on a code of the given type and returns its session token. */
async function startShift(type: 'full' | 'scan_only' | 'charge' = 'charge'): Promise<string> {
  const code = await server.inject({
    method: 'POST',
    url: `/events/${EVENT_ID}/door-codes`,
    headers: HEADERS,
    payload: { type, gate: null, expiresAt: null },
  });
  expect(code.statusCode, code.body).toBe(201);

  const shift = await server.inject({
    method: 'POST',
    url: '/door/sessions',
    headers: HEADERS,
    payload: {
      eventId: EVENT_ID,
      code: code.json().code,
      deviceId: `${DEVICE_ID}_${type}`,
      deviceName: 'Bar iPad',
      sessionType: 'staff',
    },
  });
  expect(shift.statusCode, shift.body).toBe(201);
  return shift.json().sessionToken;
}

async function seedWallet(balancePaise = 200_000): Promise<CoverWallet> {
  const wallet = await services.repos().coverWallets.create({
    userId: 'guest_com_1',
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    venueId: null,
    openingBalance: balancePaise,
    metadata: { guestName: 'Priya Sharma' },
    rules: {
      presetItems: [
        { id: 'item_drink', label: 'Drink', amountPaise: 50_000, isAvailable: true },
        { id: 'item_shot', label: 'Shot', amountPaise: 30_000, isAvailable: true },
        { id: 'item_offmenu', label: 'Off menu', amountPaise: 10_000, isAvailable: false },
      ],
    },
  });
  return wallet;
}

/**
 * The rotating tab QR, minted as the GUEST — which is the only way it can be
 * minted. Staff cannot produce one, so a tab cannot be charged with nobody
 * standing at the bar.
 */
const GUEST_ACTOR: ActorContext = {
  userId: 'guest_com_1',
  organizationId: '',
  role: 'member',
  capabilities: [],
};

async function walletQr(walletId: string): Promise<string> {
  const qr = await services.coverWallet.generateWalletQr(walletId, GUEST_ACTOR);
  return qr.qrPayload;
}

describe('POST /door/wallet-qr', () => {
  it('shows the guest’s first name, balance and the venue’s available items', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();

    const response = await server.inject({
      method: 'POST',
      url: '/door/wallet-qr',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, qrPayload: await walletQr(wallet.id) },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      walletId: wallet.id,
      // First name only: enough to greet a guest, not to identify them.
      guestFirstName: 'Priya',
      balancePaise: 200_000,
      status: 'active',
    });
    const itemIds = response.json().presetItems.map((i: { id: string }) => i.id);
    expect(itemIds).toEqual(['item_drink', 'item_shot']);
    // A live balance must never sit in a cache.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a scan_only session — an entrance handset is not a bar', async () => {
    const token = await startShift('scan_only');
    const wallet = await seedWallet();

    const response = await server.inject({
      method: 'POST',
      url: '/door/wallet-qr',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, qrPayload: await walletQr(wallet.id) },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a forged tab QR rather than treating it as a wallet id', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();

    for (const payload of [wallet.id, `cw:${wallet.id}:1700000000:deadbeef`]) {
      const response = await server.inject({
        method: 'POST',
        url: '/door/wallet-qr',
        headers: { ...HEADERS, 'x-scanner-session-token': token },
        payload: { eventId: EVENT_ID, qrPayload: payload },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('POST /door/wallet-charge', () => {
  async function charge(token: string, qr: string, body: Record<string, unknown>) {
    return server.inject({
      method: 'POST',
      url: '/door/wallet-charge',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: {
        eventId: EVENT_ID,
        qrPayload: qr,
        quantity: 1,
        idempotencyKey: `chg-${Math.random().toString(36).slice(2)}`,
        ...body,
      },
    });
  }

  it('charges the venue’s price for the named item and updates the balance', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();
    const qr = await walletQr(wallet.id);

    const response = await charge(token, qr, { presetItemId: 'item_drink' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      charged: { itemId: 'item_drink', label: 'Drink', quantity: 1, amountPaise: 50_000 },
      balancePaise: 150_000,
    });
  });

  it('multiplies by quantity, still from the venue’s price', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();
    const response = await charge(token, await walletQr(wallet.id), {
      presetItemId: 'item_shot',
      quantity: 3,
    });
    expect(response.json().charged.amountPaise).toBe(90_000);
    expect(response.json().balancePaise).toBe(110_000);
  });

  it('rejects an amount sent by the client — the price list is the only source', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();
    const response = await charge(token, await walletQr(wallet.id), {
      presetItemId: 'item_drink',
      amountPaise: 1,
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses an item the venue has switched off, and one that does not exist', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();
    const qr = await walletQr(wallet.id);

    expect((await charge(token, qr, { presetItemId: 'item_offmenu' })).statusCode).toBe(400);
    expect((await charge(token, qr, { presetItemId: 'item_nope' })).statusCode).toBe(400);
  });

  it('refuses a charge the tab cannot cover, without partially charging', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet(20_000);
    const response = await charge(token, await walletQr(wallet.id), {
      presetItemId: 'item_drink',
    });
    expect(response.statusCode).toBe(400);
    const after = await services.repos().coverWallets.findById(wallet.id);
    expect(after?.balance).toBe(20_000);
  });

  it('never double-bills on a retry of the same charge', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();
    const qr = await walletQr(wallet.id);
    const idempotencyKey = 'chg-retry-1';

    const first = await server.inject({
      method: 'POST',
      url: '/door/wallet-charge',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: {
        eventId: EVENT_ID,
        qrPayload: qr,
        presetItemId: 'item_drink',
        quantity: 1,
        idempotencyKey,
      },
    });
    const retry = await server.inject({
      method: 'POST',
      url: '/door/wallet-charge',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: {
        eventId: EVENT_ID,
        qrPayload: qr,
        presetItemId: 'item_drink',
        quantity: 1,
        idempotencyKey,
      },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(first.json().balancePaise).toBe(150_000);
    expect(retry.json().balancePaise).toBe(150_000);
    const after = await services.repos().coverWallets.findById(wallet.id);
    expect(after?.balance).toBe(150_000);
  });

  it('refuses a frozen tab', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();
    await services.coverWallet.freezeWallet(wallet.id, SEED_ACTOR);

    const response = await charge(token, await walletQr(wallet.id), {
      presetItemId: 'item_drink',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /door/ticket-sale', () => {
  async function seedTier(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    const tier = {
      id: `tier_com_${Math.random().toString(36).slice(2, 8)}`,
      eventId: EVENT_ID,
      organizationId: ORG_ID,
      name: 'Stag Entry',
      description: '',
      entryType: 'stag',
      currency: 'INR',
      priceInPaise: 150_000,
      quantity: 10,
      status: 'active' as const,
      salesStartAt: null,
      salesEndAt: null,
      minPerOrder: null,
      maxPerOrder: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    await services.repos().catalog.saveTier(tier);
    return tier;
  }

  async function sell(token: string, body: Record<string, unknown>) {
    return server.inject({
      method: 'POST',
      url: '/door/ticket-sale',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: {
        eventId: EVENT_ID,
        quantity: 1,
        paymentMode: 'cash',
        guestName: 'Rahul Verma',
        idempotencyKey: `sale-${Math.random().toString(36).slice(2)}`,
        ...body,
      },
    });
  }

  it('sells at the tier’s price, issues tickets, and admits the guest immediately', async () => {
    const token = await startShift('full');
    const tier = await seedTier();

    const response = await sell(token, { tierId: tier.id, quantity: 2 });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      amountPaise: 300_000,
      quantity: 2,
      paymentMode: 'cash',
      replayed: false,
    });
    expect(response.json().ticketIds).toHaveLength(2);
    // The guest is standing at the door — they are in, not pending.
    expect(response.json().checkInIds).toHaveLength(2);

    const order = await services.repos().orders.getById(response.json().orderId);
    expect(order).toMatchObject({ status: 'paid', grandTotalPaise: 300_000 });
    // A cash sale carries no gateway fee or GST-on-fees — inventing one would
    // be charging the guest for something nobody is paying.
    expect(order).toMatchObject({ platformFeePaise: 0, paymentFeePaise: 0, gstPaise: 0 });

    const ticket = await services.repos().entitlements.findById(response.json().ticketIds[0]);
    expect(ticket?.scanCount).toBe(1);
    expect(ticket?.status).toBe('redeemed');
  });

  it('settles door revenue into the same finance ledger as an online sale', async () => {
    const token = await startShift('full');
    const tier = await seedTier();
    const response = await sell(token, { tierId: tier.id });
    expect(response.statusCode, response.body).toBe(201);

    const entries = await services.repos().ledger.findByOrder(response.json().orderId);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('ignores any price the client tries to send', async () => {
    const token = await startShift('full');
    const tier = await seedTier();
    const response = await sell(token, { tierId: tier.id, amountPaise: 1 });
    // There is no amount field on the wire, and `.strict()` refuses one.
    expect(response.statusCode).toBe(422);
  });

  it('charges once when a dropped response is retried', async () => {
    const token = await startShift('full');
    const tier = await seedTier();
    const idempotencyKey = 'sale-retry-1';

    const first = await sell(token, { tierId: tier.id, idempotencyKey });
    const retry = await sell(token, { tierId: tier.id, idempotencyKey });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ orderId: first.json().orderId, replayed: true });
    // One sale, one set of tickets — not two of each.
    const tickets = await services.repos().entitlements.getByOrderId(first.json().orderId);
    expect(tickets).toHaveLength(1);
  });

  it('will not oversell the room', async () => {
    const token = await startShift('full');
    const tier = await seedTier({ quantity: 1 });

    expect((await sell(token, { tierId: tier.id })).statusCode).toBe(201);
    const second = await sell(token, { tierId: tier.id });
    expect(second.statusCode).toBe(400);
  });

  it('refuses a scan_only session — selling entry is not scanning it', async () => {
    const token = await startShift('scan_only');
    const tier = await seedTier();
    const response = await sell(token, { tierId: tier.id });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a tier belonging to another event', async () => {
    const token = await startShift('full');
    const tier = await seedTier({ eventId: 'evt_somewhere_else' });
    const response = await sell(token, { tierId: tier.id });
    expect(response.statusCode).toBe(404);
  });

  it('enforces the same guest rules as the walk-in form', async () => {
    const token = await startShift('full');
    const tier = await seedTier();
    expect((await sell(token, { tierId: tier.id, guestPhone: '98765' })).statusCode).toBe(422);
    expect((await sell(token, { tierId: tier.id, guestAge: 17 })).statusCode).toBe(422);
  });
});

describe('GET /cover-wallets/:walletId/qr', () => {
  it('mints a rotating tab QR the scanner then accepts', async () => {
    const token = await startShift('charge');
    const wallet = await seedWallet();

    // Minted through the same service the guest-facing route calls, then fed
    // straight back into the scanner — the two halves must agree.
    const qr = await services.coverWallet.generateWalletQr(wallet.id, GUEST_ACTOR);
    expect(qr.qrPayload.startsWith('cw:')).toBe(true);
    expect(qr.refreshIntervalSec).toBe(30);

    const response = await server.inject({
      method: 'POST',
      url: '/door/wallet-qr',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, qrPayload: qr.qrPayload },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().walletId).toBe(wallet.id);
  });

  it('is refused for a stranger', async () => {
    const wallet = await seedWallet();
    await expect(
      services.coverWallet.generateWalletQr(wallet.id, {
        userId: 'stranger',
        organizationId: 'org_somewhere_else',
        role: 'member',
        capabilities: [],
      }),
    ).rejects.toThrow();
  });

  it('is refused for VENUE STAFF — otherwise a tab could be charged with nobody there', async () => {
    const wallet = await seedWallet();
    // Staff can read a tab once the guest presents it, but they cannot
    // produce the guest's QR. That is what keeps a charge tied to somebody
    // actually standing at the bar.
    await expect(services.coverWallet.generateWalletQr(wallet.id, SEED_ACTOR)).rejects.toThrow();
  });
});
