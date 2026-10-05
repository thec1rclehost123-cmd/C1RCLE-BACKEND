import { createEventSchema, createTicketTierSchema, ticketTierDtoSchema } from '@c1rcle/contracts';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';

/**
 * ─── Create-event contract (frontend <-> backend) ────────────────────────────
 * Production create-event broke because the deployed backend lacked the tier
 * schema the partner-dashboard sends. The payloads below are the EXACT shapes
 * `publishVenueEvent` (partner-dashboard `venue-event-repository.ts`) builds:
 * RSVP tiers carry no price/phases/door price/commission; paid tiers always
 * carry `pricingPhases` (possibly empty) with ISO `startsAt`/`endsAt`.
 *
 * Part 1 parses them with the shared `@c1rcle/contracts` schemas (drift guard).
 * Part 2 pushes them through the real route stack (memory driver):
 * create event -> tiers -> review -> publish -> public discovery.
 */

const startsAt = '2030-01-01T00:00:00.000Z';
const endsAt = '2030-01-10T00:00:00.000Z';

const EVENT_PAYLOAD = {
  venueId: 'placeholder',
  title: 'Contract Night',
  imageUrl: null,
  startAt: '2030-02-01T18:00:00.000Z',
  endAt: '2030-02-02T02:00:00.000Z',
  tags: ['techno', 'DJ X'],
  compensation: null,
};

const GA_PAID = {
  name: 'General Admission',
  priceInPaise: 150_000,
  quantity: 100,
  accessType: 'ENTRY',
  audienceType: 'GENERAL',
  doorPriceInPaise: 200_000,
  pricingPhases: [
    { id: 'p1', name: 'Early Bird', priceInPaise: 100_000, startsAt, endsAt, quantity: 20 },
    {
      id: 'p2',
      name: 'Phase 2',
      priceInPaise: 130_000,
      startsAt: '2030-01-11T00:00:00.000Z',
      endsAt: '2030-01-20T00:00:00.000Z',
      quantity: null,
    },
  ],
  benefits: ['Entry', 'Welcome drink'],
  minAge: 21,
  maxAge: 60,
  minPerOrder: 1,
  maxPerUser: 6,
  maxPerOrder: 6,
  commissionEligible: true,
};

/** RSVP / free: the frontend omits price, door price, phases, commission. */
const RSVP = {
  name: 'Guestlist RSVP',
  quantity: 50,
  accessType: 'RSVP',
  audienceType: 'GENERAL',
  benefits: ['Free entry before 11pm'],
  minAge: 18,
};

const TABLE = {
  name: 'VIP Table',
  priceInPaise: 2_500_000,
  quantity: 10,
  accessType: 'TABLE',
  audienceType: 'GENERAL',
  guestCount: 6,
  pricingPhases: [],
  tableConfig: {
    capacity: 6,
    minimumSpendPaise: 2_000_000,
    redeemableAmountPaise: 1_000_000,
    tableCount: 10,
  },
  commissionEligible: false,
};

const FIXTURES = { GA_PAID, RSVP, TABLE } as const;

describe('schema parity: frontend-shaped payloads parse with @c1rcle/contracts', () => {
  it('accepts the create-event body', () => {
    const parsed = createEventSchema.safeParse({ ...EVENT_PAYLOAD, venueId: 'ven_1' });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it.each(Object.entries(FIXTURES))('accepts the %s tier body', (_name, fixture) => {
    const parsed = createTicketTierSchema.safeParse(fixture);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('keeps every tier field the frontend sends (strict schema must know them all)', () => {
    const keys = new Set(Object.keys(createTicketTierSchema.parse(GA_PAID)));
    for (const k of Object.keys(GA_PAID)) expect(keys.has(k), k).toBe(true);
    const tableKeys = new Set(Object.keys(createTicketTierSchema.parse(TABLE)));
    expect(tableKeys.has('tableConfig')).toBe(true);
  });

  it('still rejects unknown fields, negative prices, and priced RSVPs', () => {
    expect(createTicketTierSchema.safeParse({ ...GA_PAID, surprise: 1 }).success).toBe(false);
    expect(createTicketTierSchema.safeParse({ ...GA_PAID, priceInPaise: -1 }).success).toBe(false);
    expect(createTicketTierSchema.safeParse({ ...RSVP, priceInPaise: 100 }).success).toBe(false);
    expect(createTicketTierSchema.safeParse({ ...GA_PAID, priceInPaise: undefined }).success).toBe(
      false,
    );
  });

  it('parses the tier DTO shape the client enforces on responses', () => {
    const dto = {
      id: 'tier_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'VIP Table',
      description: '',
      entryType: 'table',
      currency: 'INR',
      priceInPaise: 2_500_000,
      quantity: 10,
      status: 'active',
      salesStartAt: null,
      salesEndAt: null,
      maxPerOrder: null,
      accessType: 'TABLE',
      audienceType: 'GENERAL',
      tableConfig: TABLE.tableConfig,
      version: 1,
      createdAt: startsAt,
      updatedAt: startsAt,
    };
    const parsed = ticketTierDtoSchema.safeParse(dto);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

let keySeq = 0;
const key = () => `contract-key-${++keySeq}-${Date.now()}`;

async function bootstrap() {
  const server = await buildApp({});
  const created = await server.inject({
    method: 'POST',
    url: '/api/v2/organizations',
    headers: { 'x-user-id': 'host_contract', 'idempotency-key': key() },
    payload: { name: 'Contract Hosts', slug: `contract-hosts-${keySeq}-${Date.now()}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  const org: string = created.json().id;
  const h = () => ({
    'x-user-id': 'host_contract',
    'x-organization-id': org,
    'idempotency-key': key(),
  });
  const venue = await server.inject({
    method: 'POST',
    url: `/api/v2/organizations/${org}/venues`,
    headers: h(),
    payload: { name: 'Contract Hall', slug: `contract-hall-${keySeq}-${Date.now()}` },
  });
  expect(venue.statusCode, venue.body).toBe(201);
  const event = await server.inject({
    method: 'POST',
    url: `/api/v2/organizations/${org}/events`,
    headers: h(),
    payload: { ...EVENT_PAYLOAD, venueId: venue.json().id },
  });
  expect(event.statusCode, event.body).toBe(201);
  return { server, org, h, eventId: event.json().id as string };
}

describe('create-event workflow over the real route stack', () => {
  it('accepts every frontend tier shape, publishes, and shows the event publicly', async () => {
    const { server, h, eventId } = await bootstrap();
    const created: Record<string, Record<string, unknown>> = {};

    for (const [name, payload] of Object.entries(FIXTURES)) {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v2/events/${eventId}/ticket-tiers`,
        headers: h(),
        payload,
      });
      expect(res.statusCode, `${name}: ${res.body}`).toBe(201);
      const parsed = ticketTierDtoSchema.safeParse(res.json());
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      created[name] = res.json();
    }

    expect(created.GA_PAID).toMatchObject({
      accessType: 'ENTRY',
      audienceType: 'GENERAL',
      priceInPaise: 150_000,
      doorPriceInPaise: 200_000,
      benefits: ['Entry', 'Welcome drink'],
      minAge: 21,
      commissionEligible: true,
    });
    expect((created.GA_PAID?.pricingPhases as unknown[]).length).toBe(2);
    expect(created.RSVP).toMatchObject({ accessType: 'RSVP', priceInPaise: 0, minAge: 18 });
    expect(created.TABLE).toMatchObject({
      accessType: 'TABLE',
      tableConfig: TABLE.tableConfig,
      guestCount: 6,
    });

    const review = await server.inject({
      method: 'POST',
      url: `/api/v2/events/${eventId}/review`,
      headers: h(),
    });
    expect(review.statusCode, review.body).toBe(200);
    const publish = await server.inject({
      method: 'POST',
      url: `/api/v2/events/${eventId}/publish`,
      headers: h(),
    });
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.json().isPublic).toBe(true);

    const pub = await server.inject({ method: 'GET', url: `/api/v2/public/events/${eventId}` });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().title).toBe('Contract Night');

    const list = await server.inject({ method: 'GET', url: '/api/v2/public/events?limit=50' });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(eventId);

    const tiers = await server.inject({
      method: 'GET',
      url: `/api/v2/public/events/${eventId}/ticket-tiers`,
    });
    expect(tiers.statusCode, tiers.body).toBe(200);
    expect(tiers.json()).toHaveLength(3);

    const sell = await server.inject({
      method: 'GET',
      url: `/api/v2/public/events/${eventId}/tiers`,
    });
    expect(sell.statusCode, sell.body).toBe(200);
    expect(sell.json().items).toHaveLength(3);
    await server.close();
  });

  it('keeps strict-schema rejections: unknown field, negative price, overlapping phases', async () => {
    const { server, h, eventId } = await bootstrap();
    const post = (payload: unknown) =>
      server.inject({
        method: 'POST',
        url: `/api/v2/events/${eventId}/ticket-tiers`,
        headers: h(),
        payload: payload as object,
      });

    const unknown = await post({ ...GA_PAID, surprise: true });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().fieldErrors).toBeDefined();

    const negative = await post({ ...GA_PAID, priceInPaise: -5 });
    expect(negative.statusCode).toBe(422);
    expect(negative.json().fieldErrors).toHaveProperty('priceInPaise');

    const pricedRsvp = await post({ ...RSVP, priceInPaise: 100 });
    expect(pricedRsvp.statusCode).toBe(422);

    const overlap = await post({
      ...GA_PAID,
      pricingPhases: [
        { id: 'a', name: 'A', priceInPaise: 1000, startsAt, endsAt, quantity: null },
        {
          id: 'b',
          name: 'B',
          priceInPaise: 2000,
          startsAt: '2030-01-05T00:00:00.000Z',
          endsAt: '2030-01-15T00:00:00.000Z',
          quantity: null,
        },
      ],
    });
    expect(overlap.statusCode).toBeGreaterThanOrEqual(400);
    expect(overlap.statusCode).toBeLessThan(500);

    const tableNoConfig = await post({ ...TABLE, tableConfig: undefined });
    expect(tableNoConfig.statusCode).toBeGreaterThanOrEqual(400);
    expect(tableNoConfig.statusCode).toBeLessThan(500);
    await server.close();
  });
});
