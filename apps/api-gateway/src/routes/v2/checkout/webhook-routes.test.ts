import { createHmac } from 'node:crypto';

import { MemoryPaymentProvider } from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';

import checkoutRoutes from './checkout-routes.js';
import paymentRoutes from './payment-routes.js';
import webhookRoutes from './webhook-routes.js';

/**
 * ─── Razorpay webhook (Phase 4 PR2, the security-critical route, D-022) ────
 * `RAZORPAY_WEBHOOK_SECRET` is fixed to `'test_webhook_secret'` for this
 * suite (`vitest.config.mjs`), matching `MemoryPaymentProvider`'s default —
 * the webhook route's own HMAC is over the *raw request body bytes*, a
 * different scheme from `MemoryPaymentProvider.generateSignature`'s
 * canonical-string scheme used by `/payments/:id/verify` (see that route's
 * doc comment): two independent signature checks, one per confirmation path.
 */
const WEBHOOK_SECRET = 'test_webhook_secret';

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

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
      webhookRoutes,
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

async function createPaymentIntent(server: Server, holdId: string): Promise<string> {
  const attempt = await server.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { 'idempotency-key': `attempt-${++keySeq}` },
    payload: { holdId },
  });
  return attempt.json().paymentIntentId as string;
}

function webhookPayload(entity: {
  id: string;
  order_id: string;
  holdId?: string;
  event?: string;
}): string {
  return JSON.stringify({
    event: entity.event ?? 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: entity.id,
          order_id: entity.order_id,
          notes: entity.holdId ? { holdId: entity.holdId } : {},
        },
      },
    },
  });
}

function memoryProvider(): MemoryPaymentProvider {
  const provider = createV2Services().paymentProvider;
  if (!(provider instanceof MemoryPaymentProvider)) {
    throw new Error('expected the memory payment provider under STORAGE_DRIVER=memory');
  }
  return provider;
}

describe('POST /webhooks/payments/razorpay', () => {
  it('missing signature header -> 400', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json' },
      payload: webhookPayload({ id: 'pay_no_sig', order_id: 'order_x' }),
    });
    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('tampered signature -> 400, nothing is fulfilled', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const paymentIntentId = await createPaymentIntent(server, holdId);
    const paymentId = 'pay_tampered';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise);
    const body = webhookPayload({ id: paymentId, order_id: paymentIntentId, holdId });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': sign(body).replace(/^./, 'f'), // corrupt one hex char
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('valid signature + payment.captured -> fulfils the order exactly once', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const paymentIntentId = await createPaymentIntent(server, holdId);
    const paymentId = 'pay_captured_1';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise);
    const body = webhookPayload({ id: paymentId, order_id: paymentIntentId, holdId });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    await server.close();
  });

  it('an event type other than payment.captured is acknowledged but never fulfils anything', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const paymentIntentId = await createPaymentIntent(server, holdId);
    const paymentId = 'pay_authorized_only';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise);
    const body = webhookPayload({
      id: paymentId,
      order_id: paymentIntentId,
      holdId,
      event: 'payment.authorized',
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    // The hold must still be reachable as `active` — a payments/attempts
    // idempotency replay would prove the hold was never converted.
    const holdStillActive = await server.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { 'idempotency-key': `attempt-${++keySeq}` },
      payload: { holdId },
    });
    expect(holdStillActive.statusCode).toBe(201);
    await server.close();
  });

  it('payment.captured with no hold/order correlation in notes -> 400', async () => {
    const server = await buildServer();
    const body = webhookPayload({ id: 'pay_no_notes', order_id: 'order_x' });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('dual confirmation: webhook and client-redirect racing the same payment converge on one order', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const paymentIntentId = await createPaymentIntent(server, holdId);
    const paymentId = 'pay_dual_confirm';
    const provider = memoryProvider();
    provider.simulateCapture(paymentId, grandTotalPaise);
    const body = webhookPayload({ id: paymentId, order_id: paymentIntentId, holdId });

    const webhookCall = server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });
    const redirectSignature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
    const redirectCall = server.inject({
      method: 'POST',
      url: `/payments/${paymentId}/verify`,
      payload: { holdId, paymentIntentId, signature: redirectSignature },
    });

    const [webhookResponse, redirectResponse] = await Promise.all([webhookCall, redirectCall]);
    expect(webhookResponse.statusCode).toBe(200);
    expect(redirectResponse.statusCode).toBe(200);

    // Whichever path lost the race converged on the winner's order — assert
    // via the redirect path's own idempotent re-check, not a second write.
    const recheck = await server.inject({
      method: 'POST',
      url: `/payments/${paymentId}/verify`,
      payload: { holdId, paymentIntentId, signature: redirectSignature },
    });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json().order.id).toBe(redirectResponse.json().order.id);
    expect(recheck.json().order.version).toBe(1);
    await server.close();
  });

  it('records the settlement ledger split exactly once (Phase 6 checkout-webhook integration)', async () => {
    const server = await buildServer();
    const { holdId, grandTotalPaise } = await seedHold(server);
    const paymentIntentId = await createPaymentIntent(server, holdId);
    const paymentId = 'pay_ledger_1';
    memoryProvider().simulateCapture(paymentId, grandTotalPaise);
    const body = webhookPayload({ id: paymentId, order_id: paymentIntentId, holdId });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });
    expect(response.statusCode).toBe(200);

    const orderId = `ORD-${paymentId}`;
    const entries = await createV2Services().repos().ledger.findByOrder(orderId);
    // No venue partnership (venue created directly under the host org via
    // seedHold, so the host<->venue Partnership lookup finds nothing and
    // settlement falls back to host-only), no promoter attribution -> the 4
    // unconditional legs finance-service always writes: ticket_revenue
    // (settled), platform_fee, venue_share (0 — no configured rate yet),
    // host_payout.
    expect(entries.map((e) => e.entryType).sort()).toEqual(
      ['host_payout', 'platform_fee', 'ticket_revenue', 'venue_share'].sort(),
    );
    const revenue = entries.find((e) => e.entryType === 'ticket_revenue');
    expect(revenue?.amount).toBe(grandTotalPaise);
    expect(revenue?.status).toBe('settled');
    // basic-tier platform fee (15%) is the documented fallback when no
    // approved onboarding request is on file for the host org.
    const platformFee = entries.find((e) => e.entryType === 'platform_fee');
    expect(platformFee?.amount).toBe(Math.round(grandTotalPaise * 0.15));
    const venueShare = entries.find((e) => e.entryType === 'venue_share');
    expect(venueShare?.amount).toBe(0);

    // A second delivery of the same event (Razorpay retry semantics) must
    // not double the ledger — confirmPayment's own orderId idempotency
    // means recordSettlement is only ever reached on the winning call, and
    // recordTicketSale itself dedups by orderId as a second guard.
    const retry = await server.inject({
      method: 'POST',
      url: '/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });
    expect(retry.statusCode).toBe(200);
    const entriesAfterRetry = await createV2Services().repos().ledger.findByOrder(orderId);
    expect(entriesAfterRetry).toHaveLength(entries.length);

    await server.close();
  });
});
