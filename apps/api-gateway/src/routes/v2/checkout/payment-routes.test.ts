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
    provider.simulateCapture(paymentId, grandTotalPaise);
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
    memoryProvider().simulateCapture(paymentId, grandTotalPaise);

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
    provider.simulateCapture(paymentId, grandTotalPaise);
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
