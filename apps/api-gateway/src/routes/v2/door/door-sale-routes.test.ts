import { describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import phase5DoorSaleRoutes from './door-sale-routes.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * `buildPartnerTestServer` never registers `plugins/auth.ts` (that plugin is
 * a no-op on `STORAGE_DRIVER=memory` — see its own header comment), so
 * nothing populates `request.actor` for these routes the way the real
 * Better Auth `onRequest` hook would on the firestore driver. This local
 * stand-in mirrors that hook: derive an actor straight from the test-supplied
 * `x-organization-id` header, exactly as `plugins/auth.ts` derives it from
 * the header + session. Local to this test file only — not a shared plugin.
 */
async function fakeAuthPlugin(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const organizationId = request.headers['x-organization-id'];
    if (typeof organizationId === 'string' && organizationId.length > 0) {
      request.actor = {
        userId: 'user_1',
        organizationId,
        role: 'owner',
        capabilities: [],
        platformRole: 'partner',
      };
    }
  });
}

const buildServer = () =>
  buildPartnerTestServer({ routes: [fakeAuthPlugin, phase5DoorSaleRoutes] });

const HEADERS = { 'x-organization-id': 'org_1' };

/** Core `ActorContext` has no `platformRole` — that field only exists on the
 * gateway-level `request.actor` shape (`plugins/auth.ts`'s module
 * augmentation). `fakeAuthPlugin` below adds it back on top of this. */
const ACTOR: ActorContext = {
  userId: 'user_1',
  organizationId: 'org_1',
  role: 'owner',
  capabilities: [],
};

/** Seeds an event plus a walk-in and a dine-in ticket tier via the same
 * cached `createV2Services()` singleton the routes read from — no dedicated
 * Phase 5 route creates tiers, so this goes through `EventCatalogService`
 * directly, the same repository the door routes are wired to. */
async function seedEventWithTiers() {
  const services = createV2Services();
  const event = await services.events.create(ACTOR, {
    venueId: 'ven_1',
    title: 'Door Sale Test Night',
    startAt: '2026-09-01T18:00:00Z',
  });
  const walkInTier = await services.catalog.createTier(ACTOR, {
    eventId: event.id,
    name: 'Walk-in',
    entryType: 'walkin',
    priceInPaise: 50000,
    quantity: 100,
  });
  const dineInTier = await services.catalog.createTier(ACTOR, {
    eventId: event.id,
    name: 'Dine-in',
    entryType: 'dinein',
    priceInPaise: 150000,
    quantity: 50,
  });
  return { event, walkInTier, dineInTier };
}

describe('V2 door sales slice — walk-in / dine-in / sales list', () => {
  it('creates a walk-in sale priced server-side, ignoring the client-sent tierId/quantity', async () => {
    const server = await buildServer();
    const { event, walkInTier } = await seedEventWithTiers();

    const response = await server.inject({
      method: 'POST',
      url: '/door/walk-in',
      headers: HEADERS,
      payload: {
        eventId: event.id,
        guestName: 'Ada Lovelace',
        totalGuests: 2,
        paymentMode: 'cash',
        // Adversarial: a tierId that doesn't exist, and a quantity that
        // would multiply the price under a naive "trust the client" model.
        // DoorService.createWalkIn ignores both fields entirely — price
        // always comes from catalog.findWalkInTier(eventId) server-side.
        tierId: 'tier_does_not_exist',
        quantity: 5,
        idempotencyKey: 'idem-walkin-1',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.amountPaise).toBe(walkInTier.priceInPaise);
    expect(body.amountPaise).not.toBe(walkInTier.priceInPaise * 5);
    expect(body).toMatchObject({
      eventId: event.id,
      category: 'walkin',
      guestName: 'Ada Lovelace',
      totalGuests: 2,
      paymentMode: 'cash',
      status: 'active',
    });
    expect(typeof body.id).toBe('string');
    await server.close();
  });

  it('creates a dine-in sale priced server-side from the dine-in tier', async () => {
    const server = await buildServer();
    const { event, dineInTier } = await seedEventWithTiers();

    const response = await server.inject({
      method: 'POST',
      url: '/door/dine-in',
      headers: HEADERS,
      payload: {
        eventId: event.id,
        guestName: 'Grace Hopper',
        totalGuests: 4,
        tableNumber: 'T-12',
        paymentMode: 'card',
        tierId: 'tier_does_not_exist',
        quantity: 1,
        idempotencyKey: 'idem-dinein-1',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.amountPaise).toBe(dineInTier.priceInPaise);
    expect(body).toMatchObject({
      eventId: event.id,
      category: 'dinein',
      guestName: 'Grace Hopper',
      totalGuests: 4,
      paymentMode: 'card',
      status: 'active',
    });
    await server.close();
  });

  it('lists door sales for an event, filterable by category', async () => {
    const server = await buildServer();
    const { event } = await seedEventWithTiers();

    await server.inject({
      method: 'POST',
      url: '/door/walk-in',
      headers: HEADERS,
      payload: {
        eventId: event.id,
        guestName: 'Walk-in Guest',
        totalGuests: 1,
        paymentMode: 'cash',
        tierId: 'tier_does_not_exist',
        quantity: 1,
        idempotencyKey: 'idem-walkin-list-1',
      },
    });
    await server.inject({
      method: 'POST',
      url: '/door/dine-in',
      headers: HEADERS,
      payload: {
        eventId: event.id,
        guestName: 'Dine-in Guest',
        totalGuests: 2,
        tableNumber: 'T-1',
        paymentMode: 'upi',
        tierId: 'tier_does_not_exist',
        quantity: 1,
        idempotencyKey: 'idem-dinein-list-1',
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/door/sales?eventId=${event.id}&category=walkin`,
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ category: 'walkin', guestName: 'Walk-in Guest' });
    expect(body.pageInfo.total).toBe(1);
    await server.close();
  });

  it('returns 404 with V2 shape for a walk-in against an unknown event', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/door/walk-in',
      headers: HEADERS,
      payload: {
        eventId: 'event_does_not_exist',
        guestName: 'Nobody',
        totalGuests: 1,
        paymentMode: 'cash',
        tierId: 'tier_does_not_exist',
        quantity: 1,
        idempotencyKey: 'idem-walkin-404',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });
});
