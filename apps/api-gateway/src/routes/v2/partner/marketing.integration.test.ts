import { createOrganization } from '@c1rcle/core/domain';
import { expect, it } from 'vitest';

import { createPartnerRefinementFixture } from '../../../scripts/partner-refinement-fixture.js';

it.runIf(process.env.FIRESTORE_EMULATOR_HOST)(
  'protects Marketing with native auth, membership and private responses',
  async () => {
    const fixture = await createPartnerRefinementFixture();
    try {
      const partner = fixture.accounts.find((a) => a.persona === 'partner')!;
      const guest = fixture.accounts.find((a) => a.persona === 'guest-a')!;
      const org = createOrganization({
        id: 'marketing-native-org',
        name: 'Studio',
        slug: 'marketing-native-org',
        ownerId: partner.id,
        capabilities: ['host'],
      });
      await fixture.services.repos().organizations.save(org);
      const path = `/api/v2/organizations/${org.id}/marketing/audience`;
      const headers = { ...partner.headers, 'x-organization-id': org.id };
      const result = await fixture.app.inject({ method: 'GET', url: path, headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.json()).toEqual({
        rows: [],
        events: [],
        tiers: [],
        total: 0,
        nextOffset: null,
      });
      for (const actor of [
        {},
        { ...guest.headers, 'x-organization-id': org.id },
        { ...partner.headers, 'x-organization-id': 'other-org' },
      ]) {
        const denied = await fixture.app.inject({ method: 'GET', url: path, headers: actor });
        expect([401, 403]).toContain(denied.statusCode);
      }
      const crossed = await fixture.app.inject({
        method: 'GET',
        url: '/api/v2/organizations/other-org/marketing/audience',
        headers,
      });
      expect(crossed.statusCode).toBe(403);
      const insightsPath = `/api/v2/organizations/${org.id}/analytics/ticket-tiers?from=2026-11-01&to=2026-11-04`;
      const insights = await fixture.app.inject({ method: 'GET', url: insightsPath, headers });
      expect(insights.statusCode).toBe(200);
      expect(insights.headers['cache-control']).toBe('private, no-store');
      expect(insights.json()).toEqual({
        rows: [],
        channels: { promoter: 0, unattributed: 0 },
        purchaseDays: [0, 0, 0, 0, 0, 0, 0],
      });
      const anonymousInsights = await fixture.app.inject({ method: 'GET', url: insightsPath });
      expect(anonymousInsights.statusCode).toBe(401);
      const invalid = await fixture.app.inject({
        method: 'GET',
        url: path + '?email=guest@example.invalid',
        headers,
      });
      expect(invalid.statusCode).toBe(422);
    } finally {
      await fixture.close();
    }
  },
  60000,
);
