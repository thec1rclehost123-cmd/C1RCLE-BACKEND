import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerAnalyticsRoutes from './analytics.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Partner analytics over HTTP (Phase 1) ───────────────────────────────────
 * Read-model routes. The interesting cases are the empty state (a legitimate
 * answer, not an error) and the tenancy guard.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerAnalyticsRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;
const read = (org: string) => ({ 'x-organization-id': org });

async function seedOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

describe('organization analytics overview', () => {
  it('returns real zeroes for an organization with no history', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/overview`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    // An empty dashboard is a legitimate state — not a 404, not an error.
    expect(response.json()).toMatchObject({
      organizationId: org,
      totalEvents: 0,
      totalRevenuePaise: 0,
      topEvents: [],
      lastEventAt: null,
    });
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/overview',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('event analytics', () => {
  it('hides another tenant’s event behind not-found', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/events/evt_someone_else/analytics',
      headers: read(org),
    });

    // Never confirms whether that event exists.
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('computes event analytics on request when no read model exists yet', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'Sky Night',
        venueId: venue.json().id,
        startAt: '2026-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/analytics`,
      headers: read(org),
    });

    // The projection has not run, so the read model is absent — the service
    // falls back to a bounded compute-on-request instead of a fabricated 404.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ eventId, totalRevenuePaise: 0, ticketsSold: 0 });
    await server.close();
  });
});

/**
 * ─── Organization trends + calendar ──────────────────────────────────────────
 * Both are derived, not projected, so the cases that matter are the ones a
 * "just return an array" implementation gets wrong: gaps, reversed bounds, and
 * events that should not be on a calendar at all.
 */

describe('GET /organizations/:organizationId/analytics/trends', () => {
  const trends = (server: Server, org: string, query: string) =>
    server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/trends?${query}`,
      headers: read(org),
    });

  it('returns a dense zero-filled series for an org with no sales', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await trends(server, org, 'from=2026-09-01&to=2026-09-07');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Granularity defaults to `day`, so a caller that does not ask still gets
    // the documented default rather than an error.
    expect(body.granularity).toBe('day');
    // Seven days requested, seven days returned — a gap here would let a chart
    // compress a quiet week into a busy one.
    expect(body.buckets).toHaveLength(7);
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
    ]);
    expect(body.buckets.every((b: { tickets: number }) => b.tickets === 0)).toBe(true);
    expect(body.totals).toEqual({ revenuePaise: 0, tickets: 0, checkIns: 0 });
    await server.close();
  });

  it('buckets a single day into 24 hourly points', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (
      await trends(server, org, 'from=2026-09-01&to=2026-09-01&granularity=hour')
    ).json();

    // "Today, by the hour" needs hours; a single daily point would be a
    // one-bar chart, which is not a chart.
    expect(body.granularity).toBe('hour');
    expect(body.buckets).toHaveLength(24);
    expect(body.buckets[0].key).toBe('2026-09-01T00:00');
    expect(body.buckets[23].key).toBe('2026-09-01T23:00');
    await server.close();
  });

  it('buckets by month across a long range', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (
      await trends(server, org, 'from=2026-01-01&to=2026-09-30&granularity=month')
    ).json();

    expect(body.granularity).toBe('month');
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    await server.close();
  });

  it('does not drift month boundaries when the range starts mid-month', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (
      await trends(server, org, 'from=2026-01-31&to=2026-04-30&granularity=month')
    ).json();

    // `addMonths` normalises to the 1st first; a naive `getUTCMonth() + n` on
    // Jan 31 would roll into March and produce a duplicate or missing month.
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
    await server.close();
  });

  it('rejects an unknown granularity rather than falling back silently', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await trends(
      server,
      org,
      'from=2026-09-01&to=2026-09-07&granularity=fortnight',
    );

    // A typo'd granularity that quietly became `day` would return a plausible
    // series at the wrong width — the exact failure this param exists to avoid.
    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('swaps reversed bounds instead of returning an empty series', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // A mistyped range must not 500 a dashboard, and must not silently answer
    // "nothing happened" — it should read the range the user obviously meant.
    const response = await trends(server, org, 'from=2026-09-07&to=2026-09-01');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.from).toBe('2026-09-01');
    expect(body.to).toBe('2026-09-07');
    expect(body.buckets).toHaveLength(7);
    await server.close();
  });

  it('clamps an oversized range rather than scanning one', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await trends(server, org, 'from=2000-01-01&to=2026-09-07');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The contract caps the series; the scan is bounded by the same constant,
    // so an unbounded range cannot turn one request into a full-history walk.
    expect(body.buckets.length).toBeLessThanOrEqual(400);
    expect(body.from).toBe('2000-01-01');
    await server.close();
  });

  it('rejects a malformed bound rather than guessing at it', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // 422 is the gateway's schema-validation status (see `validateV2`), not 400.
    expect((await trends(server, org, 'from=nonsense&to=2026-09-07')).statusCode).toBe(422);
    expect((await trends(server, org, 'from=2026-09-07')).statusCode).toBe(422);
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/trends?from=2026-09-01&to=2026-09-07',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('GET /organizations/:organizationId/analytics/events', () => {
  const cards = (server: Server, org: string, query = '') =>
    server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/events${query}`,
      headers: read(org),
    });

  /** A venue that *has* declared a capacity, so `capacity` is not `null`. */
  async function seedVenueWithCapacity(
    server: Server,
    org: string,
    capacity: number,
  ): Promise<string> {
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `card-venue-${++keySeq}` },
      payload: { name: `Hall ${keySeq}`, slug: `hall-${keySeq}`, capacity },
    });
    return created.json().id;
  }

  /**
   * `venueId` is always supplied: `createEventSchema` requires it, so an event
   * with no venue is not reachable through the public write path. The
   * `venueId: null` branch in the service is therefore defensive rather than
   * covered here.
   */
  async function seedEvent(
    server: Server,
    org: string,
    startAt: string,
    venueId: string,
  ): Promise<string> {
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `card-event-${++keySeq}` },
      payload: { title: `Show ${keySeq}`, startAt, venueId },
    });
    return created.json().id;
  }

  it('returns an empty list for an org with no events', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await cards(server, org);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ organizationId: org, items: [] });
    await server.close();
  });

  it('resolves the venue name and capacity server-side', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 400);
    await seedEvent(server, org, '2099-06-01T18:00:00Z', venueId);

    const body = (await cards(server, org)).json();

    // The client never has to join these; it gets a card it can render as-is.
    expect(body.items[0]).toMatchObject({
      venueName: expect.stringContaining('Hall'),
      capacity: 400,
    });
    await server.close();
  });

  it('keeps capacity null when the venue never declared one', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    // The default venue has no capacity — the create payload omits it.
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `card-venue-${++keySeq}` },
      payload: { name: 'Unlisted Room', slug: `unlisted-${keySeq}` },
    });
    await seedEvent(server, org, '2099-06-02T18:00:00Z', created.json().id);

    const body = (await cards(server, org)).json();

    // `null` means "not declared". `0` here would make the card divide by zero,
    // and would be indistinguishable from a sold-out zero-capacity room.
    expect(body.items[0].capacity).toBeNull();
    await server.close();
  });

  it('resolves one venue once across several cards', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 250);
    await seedEvent(server, org, '2099-06-03T18:00:00Z', venueId);
    await seedEvent(server, org, '2099-06-04T18:00:00Z', venueId);

    const body = (await cards(server, org)).json();

    // Both cards carry the same resolved venue; the service fetches it once.
    expect(body.items).toHaveLength(2);
    expect(body.items.every((c: { venueId: string }) => c.venueId === venueId)).toBe(true);
    expect(new Set(body.items.map((c: { venueName: string }) => c.venueName)).size).toBe(1);
    await server.close();
  });

  it('orders cards soonest-first and honours the limit', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 100);
    await seedEvent(server, org, '2099-09-01T18:00:00Z', venueId);
    await seedEvent(server, org, '2099-07-01T18:00:00Z', venueId);
    await seedEvent(server, org, '2099-08-01T18:00:00Z', venueId);

    const body = (await cards(server, org, '?limit=2')).json();

    // "Next event" must be the *next* one, not the first inserted.
    expect(body.items.map((c: { startAt: string }) => c.startAt)).toEqual([
      '2099-07-01T18:00:00Z',
      '2099-08-01T18:00:00Z',
    ]);
    await server.close();
  });

  it('omits events that have already started', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 100);
    await seedEvent(server, org, '2000-01-01T18:00:00Z', venueId);

    const body = (await cards(server, org)).json();

    expect(body.items).toEqual([]);
    await server.close();
  });

  it('rejects an out-of-range limit instead of clamping silently', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // An unbounded limit would let one request ask for every event in the org.
    expect((await cards(server, org, '?limit=0')).statusCode).toBe(422);
    expect((await cards(server, org, '?limit=5000')).statusCode).toBe(422);
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/events',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('GET /organizations/:organizationId/analytics/calendar', () => {
  const calendar = (server: Server, org: string, month: string) =>
    server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/calendar?month=${month}`,
      headers: read(org),
    });

  async function seedEvent(server: Server, org: string, startAt: string): Promise<void> {
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `cal-venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `cal-venue-${keySeq}` },
    });
    await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `cal-event-${++keySeq}` },
      payload: { title: `Event ${keySeq}`, venueId: venue.json().id, startAt },
    });
  }

  it('returns every day of the month, zero-filled', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await calendar(server, org, '2026-09');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.days).toHaveLength(30);
    expect(body.days[0]).toEqual({ day: 1, eventCount: 0 });
    expect(body.days[29]).toEqual({ day: 30, eventCount: 0 });
    await server.close();
  });

  it('counts events on their start day', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await seedEvent(server, org, '2026-09-14T18:00:00Z');
    await seedEvent(server, org, '2026-09-14T21:00:00Z');

    const body = (await calendar(server, org, '2026-09')).json();

    // Two events on the same day — a date-truncated match, not a day-1 bucket.
    expect(body.days[13]).toEqual({ day: 14, eventCount: 2 });
    await server.close();
  });

  it('does not count events from another month', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await seedEvent(server, org, '2026-10-05T18:00:00Z');

    const body = (await calendar(server, org, '2026-09')).json();

    expect(body.days.every((d: { eventCount: number }) => d.eventCount === 0)).toBe(true);
    await server.close();
  });

  it('handles a leap February', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (await calendar(server, org, '2028-02')).json();

    expect(body.days).toHaveLength(29);
    expect(body.days[28]).toEqual({ day: 29, eventCount: 0 });
    await server.close();
  });

  it('reports the weekday of the 1st with Monday as 0', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // 2026-09-01 is a Tuesday → offset 1. Computed server-side so client and
    // server cannot disagree about where the month starts.
    expect((await calendar(server, org, '2026-09')).json().firstDayOffset).toBe(1);
    // 2026-06-01 is a Monday → offset 0.
    expect((await calendar(server, org, '2026-06')).json().firstDayOffset).toBe(0);
    // 2026-09-06 is a Sunday → offset 6.
    expect((await calendar(server, org, '2026-09')).json().firstDayOffset).toBe(1);
    await server.close();
  });

  it('rejects a malformed month', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    expect((await calendar(server, org, '2026-9')).statusCode).toBe(422);
    expect((await calendar(server, org, 'september')).statusCode).toBe(422);
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/calendar?month=2026-09',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});
