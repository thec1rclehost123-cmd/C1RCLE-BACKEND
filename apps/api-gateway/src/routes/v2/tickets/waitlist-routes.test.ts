import { afterEach, describe, expect, it, vi } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import waitlistRoutes from './waitlist-routes.js';

const services = createV2Services();
afterEach(() => {
  vi.restoreAllMocks();
});
describe('V1 waitlist boundaries', () => {
  it.each([
    {
      method: 'POST' as const,
      url: '/waitlist',
      payload: { eventId: 'event_waitlist', tierId: 'tier_waitlist' },
    },
    { method: 'POST' as const, url: '/waitlist/entry_waitlist/accept', payload: {} },
    { method: 'DELETE' as const, url: '/waitlist/entry_waitlist' },
    { method: 'GET' as const, url: '/waitlist' },
    { method: 'GET' as const, url: '/waitlist/entry_waitlist' },
    {
      method: 'POST' as const,
      url: '/events/event_waitlist/tiers/tier_waitlist/waitlist/offer-next',
      payload: {},
    },
    { method: 'GET' as const, url: '/events/event_waitlist/tiers/tier_waitlist/waitlist' },
    {
      method: 'POST' as const,
      url: '/admin/events/event_waitlist/tiers/tier_waitlist/waitlist/offer-next',
      payload: {},
    },
    { method: 'GET' as const, url: '/admin/events/event_waitlist/tiers/tier_waitlist/waitlist' },
  ])(
    'keeps $method $url unavailable without reaching the preserved domain service',
    async ({ method, url, ...rest }) => {
      const calls = [
        vi.spyOn(services.waitlist, 'join'),
        vi.spyOn(services.waitlist, 'accept'),
        vi.spyOn(services.waitlist, 'offerNext'),
        vi.spyOn(services.waitlist, 'offerNextForPartner'),
        vi.spyOn(services.waitlist, 'getAcceptedOffer'),
        vi.spyOn(services.waitlist, 'listMine'),
      ];
      const server = await buildPartnerTestServer({ routes: [waitlistRoutes], actorRole: 'owner' });
      try {
        const response = await server.inject({
          method,
          url,
          ...rest,
          headers: {
            'x-user-id': 'guest_waitlist',
            'x-organization-id': 'org_waitlist',
            'idempotency-key': 'waitlist-v1-block',
          },
        });
        expect(response.statusCode, response.body).toBe(410);
        expect(response.json()).toEqual({
          error: { code: 'not_available', message: 'Waitlists are not available in V1.' },
        });
        for (const call of calls) expect(call).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );
});
