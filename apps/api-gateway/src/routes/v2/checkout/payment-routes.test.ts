import { InvalidOperationError, MemoryPaymentProvider } from '@c1rcle/core/domain';
import { describe, expect, it, vi } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';

import checkoutRoutes from './checkout-routes.js';
import paymentRoutes from './payment-routes.js';

/**
 * ─── Payment attempts + client-redirect confirmation (Phase 4 PR2) ─────────
 * `services.paymentProvider` is `MemoryPaymentProvider` on `STORAGE_DRIVER=memory`
 * (the default `pnpm test` driver) — no network call, but the same HMAC
 * signature scheme as the real Razorpay adapter, so these tests exercise the
 * genuine signature-verification path (see that class's doc comment).
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
      checkoutRoutes,
      paymentRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const write = (org: string) => ({
  'x-organization-id': org,
  'idempotency-key': `catalog-key-${++keySeq}`,
});

async function seedHold(server: Server): Promise<{ holdId: string; grandTotalPaise: number }> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const org: string = created.json().id;
  const venue = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
  });
  const venueId: string = venue.json().id;
  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: { title: 'Sky Night', venueId, startAt: '2026-09-01T18:00:00Z' },
  });
  const eventId: string = event.json().id;
  const tier = await server.inject({
    method: 'POST',
    url: `/events/${eventId}/ticket-tiers`,
    headers: write(org),
    payload: { name: 'General', priceInPaise: 150_000, quantity: 100 },
  });
  const tierId: string = tier.json().id;

  const hold = await server.inject({
    method: 'POST',
    url: '/checkout/holds',
    headers: { 'idempotency-key': `hold-${++keySeq}` },
    payload: { eventId, lines: [{ tierId, quantity: 1 }] },
  });
  return { holdId: hold.json().holdId, grandTotalPaise: hold.json().pricing.grandTotalPaise };
}

function memoryProvider(): MemoryPaymentProvider {
  const provider = createV2Services().paymentProvider;
  if (!(provider instanceof MemoryPaymentProvider)) {
    throw new Error('expected the memory payment provider under STORAGE_DRIVER=memory');
  }
  return provider;
}

describe('POST /payments/attempts', () => {
  it('requires Idempotency-Key -> 422 validation', async () => {
    const server = await buildServer();
    const { holdId } = await seedHold(server);

    const response = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      payload: { holdId },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('idempotency-key');
    await server.close();
  });

  it('creates a payment intent for the amount of an active hold', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);

    const response = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': 'attempt-key-1' },
      payload: { holdId },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ amountPaise: grandTotalPaise });
    expect(response.json().paymentIntentId).toBeTruthy();
    await server.close();
  });

  it('hold not found -> 400 invalid_operation', async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': 'attempt-key-missing' },
      payload: { holdId: 'HOLD-does-not-exist' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });
});

describe('POST /payments/:id/verify', () => {
  it('fulfils the order once the provider confirms a captured payment with a valid signature', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const attempt = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': 'attempt-verify-1' },
      payload: { holdId },
    });
    const paymentIntentId: string = attempt.json().paymentIntentId;
    const paymentId = 'pay_test_verify_1';

    const provider = memoryProvider();
    // Stands in for "the guest paid at Razorpay's hosted page" — the one
    // fact a memory adapter cannot derive on its own.
    provider.simulateCapture(paymentId, grandTotalPaise, paymentIntentId);
    const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });

    const response = await server.inject({
      method: 'POST',
      url: `/payments/${paymentId}/verify`,
      payload: { holdId, paymentIntentId, signature },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.order).toMatchObject({
      status: 'paid',
      paymentId,
      grandTotalPaise,
    });
    expect(body.entitlements.length).toBeGreaterThan(0);
    await server.close();
  });

  it('a forged signature is rejected before any fulfillment happens', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const attempt = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': 'attempt-verify-forged' },
      payload: { holdId },
    });
    const paymentIntentId: string = attempt.json().paymentIntentId;
    const paymentId = 'pay_test_forged';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, paymentIntentId);

    const response = await server.inject({
      method: 'POST',
      url: `/payments/${paymentId}/verify`,
      payload: { holdId, paymentIntentId, signature: 'not-a-real-signature' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation' });
    await server.close();
  });

  it('is idempotent — verifying the same payment twice does not double-issue entitlements', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const attempt = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': 'attempt-verify-twice' },
      payload: { holdId },
    });
    const paymentIntentId: string = attempt.json().paymentIntentId;
    const paymentId = 'pay_test_twice';
    const provider = memoryProvider();
    provider.simulateCapture(paymentId, grandTotalPaise, paymentIntentId);
    const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
    const body = { holdId, paymentIntentId, signature };

    const first = await server.inject({
      method: 'POST',
      url: `/payments/${paymentId}/verify`,
      payload: body,
    });
    const second = await server.inject({
      method: 'POST',
      url: `/payments/${paymentId}/verify`,
      payload: body,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().order.id).toBe(first.json().order.id);
    expect(second.json().order.version).toBe(first.json().order.version);
    expect(second.json().entitlements).toEqual(first.json().entitlements);
    await server.close();
  });
});

// ─── Binding a payment to its hold, and finishing a half-fulfilled order ─────
// A valid signature, a captured payment and a matching amount prove the payment
// is REAL. None of them prove it is for THIS purchase, so fulfilment also
// requires the payment to have been made against the provider order bound to
// the hold at attempt time.

const attemptFor = async (server: Server, holdId: string, key: string) => {
  const response = await server.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { 'idempotency-key': key },
    payload: { holdId },
  });
  return {
    status: response.statusCode,
    paymentIntentId: response.json().paymentIntentId as string,
  };
};

const verifyPayment = (
  server: Server,
  args: { paymentId: string; holdId: string; paymentIntentId: string; signatureOrderId?: string },
) =>
  server.inject({
    method: 'POST',
    url: `/payments/${args.paymentId}/verify`,
    payload: {
      holdId: args.holdId,
      paymentIntentId: args.paymentIntentId,
      signature: memoryProvider().generateSignature({
        paymentId: args.paymentId,
        orderId: args.signatureOrderId ?? args.paymentIntentId,
      }),
    },
  });

describe('payment ↔ hold binding', () => {
  it('reuses the provider order for a hold instead of minting a second one', async () => {
    const server = await buildServer();
    const { holdId } = await seedHold(server);

    const first = await attemptFor(server, holdId, 'bind-attempt-1');
    const second = await attemptFor(server, holdId, 'bind-attempt-2-different-key');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.paymentIntentId).toBe(first.paymentIntentId);
    await server.close();
  });

  it('a genuine payment for one hold cannot fulfil another hold with the same total', async () => {
    const server = await buildServer();
    const a = await seedHold(server);
    const b = await seedHold(server);
    expect(a.grandTotalPaise).toBe(b.grandTotalPaise);
    const orderA = (await attemptFor(server, a.holdId, 'replay-a')).paymentIntentId;
    const orderB = (await attemptFor(server, b.holdId, 'replay-b')).paymentIntentId;
    const paymentId = 'pay_replay_1';
    memoryProvider().simulateCapture(paymentId, a.grandTotalPaise, orderA);

    // (1) Present A's payment with A's real signature, but against hold B.
    const wrongOrder = await verifyPayment(server, {
      paymentId,
      holdId: b.holdId,
      paymentIntentId: orderA,
    });
    // (2) Claim hold B's own order id and sign for it, hoping the signature
    //     alone is enough — the provider says the payment belongs to order A.
    const wrongPaymentOrder = await verifyPayment(server, {
      paymentId,
      holdId: b.holdId,
      paymentIntentId: orderB,
    });

    expect(wrongOrder.statusCode).toBe(400);
    expect(wrongPaymentOrder.statusCode).toBe(400);
    expect(await createV2Services().repos().orders.getByPaymentId(paymentId)).toBeNull();

    // The payment still fulfils the hold it was actually made for.
    const legit = await verifyPayment(server, {
      paymentId,
      holdId: a.holdId,
      paymentIntentId: orderA,
    });
    expect(legit.statusCode).toBe(200);
    await server.close();
  });

  it('refuses to fulfil a hold that never had a payment attempt', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const paymentId = 'pay_no_attempt';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, 'order_made_up');

    const response = await verifyPayment(server, {
      paymentId,
      holdId,
      paymentIntentId: 'order_made_up',
    });

    expect(response.statusCode).toBe(400);
    expect(await createV2Services().repos().orders.getByPaymentId(paymentId)).toBeNull();
    await server.close();
  });

  it('refuses a captured payment that does not name any order', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const { paymentIntentId } = await attemptFor(server, holdId, 'no-order-attempt');
    const paymentId = 'pay_orderless';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, null);

    const response = await verifyPayment(server, { paymentId, holdId, paymentIntentId });

    expect(response.statusCode).toBe(400);
    expect(await createV2Services().repos().orders.getByPaymentId(paymentId)).toBeNull();
    await server.close();
  });

  it('refuses a payment captured in a different currency', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const { paymentIntentId } = await attemptFor(server, holdId, 'currency-attempt');
    const paymentId = 'pay_usd';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, paymentIntentId, 'USD');

    const response = await verifyPayment(server, { paymentId, holdId, paymentIntentId });

    expect(response.statusCode).toBe(400);
    expect(await createV2Services().repos().orders.getByPaymentId(paymentId)).toBeNull();
    await server.close();
  });

  it("another user's hold is indistinguishable from a missing one", async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const { paymentIntentId } = await attemptFor(server, holdId, 'owner-attempt');
    const repos = createV2Services().repos();
    const hold = await repos.cartReservations.getById(holdId);
    // Re-home the hold to a different user: the caller is no longer its owner.
    if (hold) await repos.cartReservations.create({ ...hold, userId: 'someone_else' });
    const paymentId = 'pay_not_mine';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, paymentIntentId);

    const attempt = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': 'not-mine-attempt' },
      payload: { holdId },
    });
    const verify = await verifyPayment(server, { paymentId, holdId, paymentIntentId });
    const missing = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': 'missing-hold-attempt' },
      payload: { holdId: 'HOLD-does-not-exist' },
    });

    expect(attempt.statusCode).toBe(400);
    expect(verify.statusCode).toBe(400);
    expect(attempt.json().message).toBe(missing.json().message);
    expect(await repos.orders.getByPaymentId(paymentId)).toBeNull();
    await server.close();
  });
});

describe('resumable fulfilment', () => {
  async function paidHold(server: Server, label: string) {
    const { holdId, grandTotalPaise } = await seedHold(server);
    const { paymentIntentId } = await attemptFor(server, holdId, `${label}-attempt`);
    const paymentId = `pay_${label}`;
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, paymentIntentId);
    return { holdId, paymentId, paymentIntentId };
  }

  it('a retry finishes an order whose ticket issuance failed after the order was saved', async () => {
    const server = await buildServer();
    const paid = await paidHold(server, 'crash_tickets');
    const repos = createV2Services().repos();
    const realSave = repos.entitlements.save.bind(repos.entitlements);
    let armed = true;
    repos.entitlements.save = async (...args: Parameters<typeof realSave>) => {
      if (armed) {
        armed = false;
        throw new Error('simulated crash while issuing tickets');
      }
      return realSave(...args);
    };

    try {
      const first = await verifyPayment(server, paid);
      expect(first.statusCode).not.toBe(200);
      // The order exists, but the guest has no tickets yet.
      expect(await repos.orders.getByPaymentId(paid.paymentId)).not.toBeNull();
      expect(await repos.entitlements.getByOrderId(`ORD-${paid.paymentId}`)).toHaveLength(0);

      // A redelivered webhook / repeated redirect repairs it.
      const second = await verifyPayment(server, paid);
      expect(second.statusCode).toBe(200);
      expect(second.json().entitlements.length).toBeGreaterThan(0);
      expect(await repos.entitlements.getByOrderId(`ORD-${paid.paymentId}`)).toHaveLength(
        second.json().entitlements.length,
      );
      const hold = await repos.cartReservations.getById(paid.holdId);
      expect(hold?.status).toBe('converted');
    } finally {
      repos.entitlements.save = realSave;
    }
    await server.close();
  });

  it('a retry converts the hold when the crash happened before it was converted', async () => {
    const server = await buildServer();
    const paid = await paidHold(server, 'crash_convert');
    const repos = createV2Services().repos();
    const realConvert = repos.cartReservations.convertToOrder.bind(repos.cartReservations);
    let armed = true;
    repos.cartReservations.convertToOrder = async (...args: Parameters<typeof realConvert>) => {
      if (armed) {
        armed = false;
        throw new Error('simulated crash before the hold was converted');
      }
      return realConvert(...args);
    };

    try {
      const first = await verifyPayment(server, paid);
      expect(first.statusCode).not.toBe(200);
      expect((await repos.cartReservations.getById(paid.holdId))?.status).toBe('active');

      const second = await verifyPayment(server, paid);
      expect(second.statusCode).toBe(200);
      expect((await repos.cartReservations.getById(paid.holdId))?.status).toBe('converted');
      expect(second.json().entitlements.length).toBeGreaterThan(0);
    } finally {
      repos.cartReservations.convertToOrder = realConvert;
    }
    await server.close();
  });

  it('repeating a completed confirmation issues no extra tickets and writes no promo row', async () => {
    const server = await buildServer();
    const paid = await paidHold(server, 'idempotent');
    const repos = createV2Services().repos();

    const first = await verifyPayment(server, paid);
    const second = await verifyPayment(server, paid);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().entitlements).toHaveLength(first.json().entitlements.length);
    // No promo was applied, so there is no redemption (it used to write a
    // row with an empty promo id for every order).
    expect(await repos.promoRedemptions.getByOrderId(`ORD-${paid.paymentId}`)).toBeNull();
    await server.close();
  });
});

// ─── A payment that lands after the hold lapsed ─────────────────────────────
// The guest was inside Razorpay's checkout when the TTL ran out. Captured money
// must end in an order or a refund — never in neither.

describe('payment captured after the hold expired', () => {
  async function lapsedPaidHold(server: Server, label: string, status: 'expired' | 'released') {
    const { holdId, grandTotalPaise } = await seedHold(server);
    const { paymentIntentId } = await attemptFor(server, holdId, `${label}-attempt`);
    const repos = createV2Services().repos();
    const hold = await repos.cartReservations.getById(holdId);
    if (!hold) throw new Error('hold missing');
    // Lapse the hold the two ways it happens: TTL passes, or the sweep released it.
    await repos.cartReservations.create(
      status === 'expired'
        ? { ...hold, expiresAt: new Date(Date.now() - 60_000).toISOString() }
        : { ...hold, status: 'released' },
    );
    const paymentId = `pay_${label}`;
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, paymentIntentId);
    return { holdId, paymentId, paymentIntentId, grandTotalPaise, repos };
  }

  const inventoryOf = () =>
    (
      createV2Services().checkout as unknown as {
        deps: { inventory: { assertAvailable: (...a: unknown[]) => Promise<void> } };
      }
    ).deps.inventory;

  it.each(['expired', 'released'] as const)(
    'still fulfils the order when seats remain (%s hold)',
    async (status) => {
      const server = await buildServer();
      const paid = await lapsedPaidHold(server, `late_ok_${status}`, status);

      const response = await verifyPayment(server, paid);

      expect(response.statusCode).toBe(200);
      expect(response.json().order).toMatchObject({
        status: 'paid',
        grandTotalPaise: paid.grandTotalPaise,
      });
      expect(response.json().entitlements.length).toBeGreaterThan(0);
      expect((await paid.repos.cartReservations.getById(paid.holdId))?.status).toBe('converted');
      await server.close();
    },
  );

  it('refunds in full, once, when the seats are gone', async () => {
    const server = await buildServer();
    const paid = await lapsedPaidHold(server, 'late_soldout', 'expired');
    vi.spyOn(inventoryOf(), 'assertAvailable').mockRejectedValue(
      new InvalidOperationError('Insufficient inventory: 1 requested, 0 available'),
    );
    const refund = vi.spyOn(memoryProvider(), 'refundPayment');

    try {
      const first = await verifyPayment(server, paid);
      const second = await verifyPayment(server, paid); // a redelivered webhook / retry

      expect(first.statusCode).toBe(400);
      expect(first.json().message).toMatch(/refunded in full/i);
      expect(second.statusCode).toBe(400);
      // Money is returned, no order or tickets exist, and both calls used the same
      // idempotency key so the provider can only refund once.
      expect(refund).toHaveBeenCalledWith({
        paymentId: paid.paymentId,
        amountPaise: paid.grandTotalPaise,
        idempotencyKey: `autorefund:${paid.paymentId}`,
      });
      expect(new Set(refund.mock.calls.map(([r]) => r.idempotencyKey)).size).toBe(1);
      expect(await paid.repos.orders.getByPaymentId(paid.paymentId)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
    await server.close();
  });

  it('does not swallow an unexpected inventory failure by refunding', async () => {
    const server = await buildServer();
    const paid = await lapsedPaidHold(server, 'late_boom', 'expired');
    vi.spyOn(inventoryOf(), 'assertAvailable').mockRejectedValue(new Error('database unavailable'));
    const refund = vi.spyOn(memoryProvider(), 'refundPayment');

    try {
      const response = await verifyPayment(server, paid);
      expect(response.statusCode).not.toBe(200);
      // A transient error is not "sold out": no refund, so a retry can still succeed.
      expect(refund).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
    await server.close();
  });
});

// ─── Attendee capture ────────────────────────────────────────────────────────
// Every paid order used to carry the placeholder contact "Guest /
// guest@example.com", so tickets and receipts named nobody.

describe('attendee capture', () => {
  async function holdWith(server: Server, attendee: unknown) {
    const seeded = await seedHold(server);
    const repos = createV2Services().repos();
    const base = await repos.cartReservations.getById(seeded.holdId);
    if (!base) throw new Error('hold missing');
    // Re-create the same purchase with an attendee, through the real endpoint.
    const response = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: { 'idempotency-key': `attendee-hold-${++keySeq}` },
      payload: {
        eventId: base.eventId,
        lines: base.lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity })),
        attendee,
      },
    });
    return response;
  }

  it('carries the attendee from the hold onto the order and its tickets', async () => {
    const server = await buildServer();
    const response = await holdWith(server, {
      name: '  Asha Rao ',
      email: 'asha@example.com',
      phone: '+919876543210',
    });
    expect(response.statusCode).toBe(201);
    const holdId: string = response.json().holdId;
    const total: number = response.json().pricing.grandTotalPaise;
    const { paymentIntentId } = await attemptFor(server, holdId, `attendee-${keySeq}`);
    const paymentId = `pay_attendee_${keySeq}`;
    memoryProvider().simulateCapture(paymentId, total, paymentIntentId);

    const verified = await verifyPayment(server, { paymentId, holdId, paymentIntentId });

    expect(verified.statusCode).toBe(200);
    const repos = createV2Services().repos();
    const order = await repos.orders.getByPaymentId(paymentId);
    expect(order?.contact).toEqual({
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '+919876543210',
    });
    const tickets = await repos.entitlements.getByOrderId(`ORD-${paymentId}`);
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((t) => t.holderName === 'Asha Rao')).toBe(true);
    await server.close();
  });

  it('still works without an attendee, using the old placeholder', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const { paymentIntentId } = await attemptFor(server, holdId, `no-attendee-${keySeq}`);
    const paymentId = `pay_no_attendee_${keySeq}`;
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, paymentIntentId);

    expect((await verifyPayment(server, { paymentId, holdId, paymentIntentId })).statusCode).toBe(
      200,
    );
    const order = await createV2Services().repos().orders.getByPaymentId(paymentId);
    expect(order?.contact.email).toBe('guest@example.com');
    await server.close();
  });

  it.each([
    ['a missing name', { name: '', email: 'a@example.com' }],
    ['a malformed email', { name: 'Asha', email: 'not-an-email' }],
    ['an unknown field', { name: 'Asha', email: 'a@example.com', role: 'admin' }],
    ['an over-long phone', { name: 'Asha', email: 'a@example.com', phone: '9'.repeat(40) }],
  ])('rejects %s with a 422 and creates no hold', async (_label, attendee) => {
    const server = await buildServer();
    const response = await holdWith(server, attendee);
    expect(response.statusCode).toBe(422);
    await server.close();
  });
});
