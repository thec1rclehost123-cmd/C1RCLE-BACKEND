import {
  calculatePricing,
  createOrder,
  createTicketTier,
  issueEntitlements,
} from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { seedApprovedPartnerOrganization } from '../../../test-utils/approved-partner-organization.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerSettingsRoutes from './settings.js';

let sequence = 0;
const makeServer = () => buildPartnerTestServer({ routes: [partnerSettingsRoutes] });
const orgHeaders = (organizationId: string) => ({ 'x-organization-id': organizationId });

async function makeOrganization(capability: 'host' | 'venue' | 'promoter' = 'host') {
  sequence += 1;
  return seedApprovedPartnerOrganization({
    name: `Settings Org ${sequence}`,
    slug: `settings-org-${sequence}`,
    capabilities: [capability],
  });
}

describe('partner settings routes', () => {
  it('rejects a malformed organization header before reading settings', async () => {
    const server = await makeServer();
    const org = await makeOrganization('venue');
    const response = await server.inject({
      url: `/organizations/${org.id}/partner-settings`,
      headers: orgHeaders('invalid/org/id'),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('x-organization-id');
    await server.close();
  });

  it('returns safe aggregate statistics and default in-app preferences for a member organization', async () => {
    const server = await makeServer();
    const org = await makeOrganization('host');
    const response = await server.inject({
      url: `/organizations/${org.id}/partner-settings`,
      headers: orgHeaders(org.id),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organizationId: org.id,
      displayName: org.name,
      privacy: { profileVisible: true, showGuestList: false },
      inAppNotifications: {
        eventUpdates: true,
        orderUpdates: true,
        requests: true,
        partnerships: true,
        payouts: true,
      },
      stats: { connections: 0 },
    });
    expect(response.json()).not.toHaveProperty('stats.revenue');
    expect(response.json()).not.toHaveProperty('guestIdentities');
    await server.close();
  });

  it('uses current orders and admissions instead of a stale overview projection for profile stats', async () => {
    const server = await makeServer();
    const org = await makeOrganization('venue');
    const services = createV2Services();
    const repositories = services.repos();
    const eventId = `event-settings-stats-${sequence}`;
    const now = new Date('2026-11-12T00:00:00.000Z');
    const tier = createTicketTier({
      id: `tier-settings-stats-${sequence}`,
      eventId,
      organizationId: org.id,
      name: 'General',
      priceInPaise: 10_000,
      quantity: 1,
      now,
    });
    const order = {
      ...createOrder({
        id: `order-settings-stats-${sequence}`,
        eventId,
        organizationId: org.id,
        contact: { name: 'Guest', email: '', phone: '' },
        pricing: calculatePricing({ lines: [{ tier, quantity: 1 }] }),
        now,
      }),
      status: 'paid' as const,
      paymentIntentId: null,
      paymentId: `payment-settings-stats-${sequence}`,
      paidAt: now.toISOString(),
    };
    await repositories.orders.save(order);
    await Promise.all(
      issueEntitlements({ order, now }).map((ticket) =>
        repositories.entitlements.save({ ...ticket, status: 'redeemed', scanCount: 1 }),
      ),
    );
    await repositories.analytics.saveOrganizationOverview({
      organizationId: org.id,
      totalEvents: 1,
      publishedEvents: 0,
      totalRevenuePaise: 0,
      totalTicketsSold: 0,
      totalCheckIns: 0,
      topEvents: [],
      lastEventAt: null,
    });

    const response = await server.inject({
      url: `/organizations/${org.id}/partner-settings`,
      headers: orgHeaders(org.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().stats).toMatchObject({ ticketsSold: 1, checkIns: 1 });
    await server.close();
  });

  it('persists public profile, privacy, in-app preferences, and Promoter handle changes', async () => {
    const server = await makeServer();
    const org = await makeOrganization('promoter');
    const response = await server.inject({
      method: 'PATCH',
      url: `/organizations/${org.id}/partner-settings`,
      headers: { ...orgHeaders(org.id), 'idempotency-key': `settings-${++sequence}` },
      payload: {
        displayName: 'Ace Promoter',
        handle: 'ace-promoter',
        profile: { bio: 'Independent event promoter', city: 'Mumbai', genres: ['House'] },
        privacy: { profileVisible: false },
        inAppNotifications: { eventUpdates: false },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      displayName: 'Ace Promoter',
      handle: 'ace-promoter',
      profile: { bio: 'Independent event promoter', city: 'Mumbai', genres: ['House'] },
      privacy: { profileVisible: false },
      inAppNotifications: { eventUpdates: false, orderUpdates: true },
    });
    const readback = await server.inject({
      url: `/organizations/${org.id}/partner-settings`,
      headers: orgHeaders(org.id),
    });
    expect(readback.json()).toMatchObject({
      handle: 'ace-promoter',
      privacy: { profileVisible: false },
    });
    await server.close();
  });

  it('rejects a handle change from a non-Promoter organization', async () => {
    const server = await makeServer();
    const org = await makeOrganization('host');
    const response = await server.inject({
      method: 'PATCH',
      url: `/organizations/${org.id}/partner-settings`,
      headers: { ...orgHeaders(org.id), 'idempotency-key': `settings-${++sequence}` },
      payload: { handle: 'host-handle' },
    });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('calculates Promoter aggregate counts without exposing financial values', async () => {
    const server = await makeServer();
    const org = await makeOrganization('promoter');
    const response = await server.inject({
      url: `/organizations/${org.id}/partner-settings`,
      headers: orgHeaders(org.id),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().stats).toMatchObject({
      events: 0,
      ticketsSold: 0,
      checkIns: null,
      connections: 0,
    });
    expect(JSON.stringify(response.json().stats)).not.toMatch(/paise|revenue|commission|payout/i);
    await server.close();
  });

  it('issues a scoped public profile-media upload grant without exposing storage credentials', async () => {
    const server = await makeServer();
    const org = await makeOrganization('venue');
    const response = await server.inject({
      method: 'POST',
      url: `/organizations/${org.id}/partner-profile-media/upload-url`,
      headers: { ...orgHeaders(org.id), 'idempotency-key': `settings-${++sequence}` },
      payload: { contentType: 'image/webp', fileName: 'profile.webp' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      method: 'PUT',
      publicUrl: expect.stringContaining('/partner-profiles/'),
    });
    expect(response.json()).not.toHaveProperty('credential');
    await server.close();
  });
});
