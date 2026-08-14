import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerReferralLinkRoutes from './referral-links.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Referral links over HTTP (Phase 1) ──────────────────────────────────────
 * The rule under test: a link carries attribution but never owns it, so
 * deactivating one must not erase what it already produced.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerReferralLinkRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;
const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({ ...read(org), 'idempotency-key': `ref-key-${++keySeq}` });

async function seed(server: Server): Promise<{ org: string; eventId: string }> {
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
  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: {
      title: 'Sky Night',
      venueId: venue.json().id,
      startAt: '2026-09-01T18:00:00Z',
    },
  });
  const eventId: string = event.json().id;
  return { org, eventId };
}

describe('creating referral links', () => {
  it('creates a link with a supplied code and lists it', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_1', code: 'summer-24', label: 'Instagram' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      // Normalized: a flyer may print it lower-case or hyphenated.
      code: 'SUMMER24',
      label: 'Instagram',
      isActive: true,
      clicks: 0,
      conversions: 0,
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/referral-links`,
      headers: read(org),
    });
    expect(listed.json().items).toHaveLength(1);
    await server.close();
  });

  it('generates a code when none is given', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_1' },
    });

    const code: string = created.json().code;
    expect(code).toHaveLength(8);
    // No look-alike characters: these get read aloud and typed by hand.
    expect(code).not.toMatch(/[O0IL1]/);
    await server.close();
  });

  it('refuses a duplicate code for the same event', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const payload = { promoterId: 'promoter_1', code: 'DUPE24' };

    await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { ...payload, promoterId: 'promoter_2' },
    });

    // A collision would silently hand one promoter another's attribution.
    expect(second.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a code with unusable characters', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_1', code: 'BAD!!CODE' },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('hides another tenant’s event behind not-found', async () => {
    const server = await buildServer();
    const { org } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: '/events/evt_someone_else/referral-links',
      headers: write(org),
      payload: { promoterId: 'promoter_1' },
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });
});

describe('deactivating a link', () => {
  it('stops new attributions but keeps the record', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_1', code: 'OLDLINK' },
    });
    const linkId: string = created.json().id;

    const deactivated = await server.inject({
      method: 'POST',
      url: `/referral-links/${linkId}/deactivate`,
      headers: write(org),
    });

    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ isActive: false, code: 'OLDLINK' });

    // Still listed: past attributions must stay explicable.
    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/referral-links`,
      headers: read(org),
    });
    expect(listed.json().items).toHaveLength(1);
    await server.close();
  });
});
