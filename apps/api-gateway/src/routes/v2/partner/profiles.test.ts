import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { seedApprovedPartnerOrganization } from '../../../test-utils/approved-partner-organization.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerProfileRoutes from './profiles.js';
import partnerSettingsRoutes from './settings.js';

let seq = 0;
const makeServer = () =>
  buildPartnerTestServer({ routes: [partnerProfileRoutes, partnerSettingsRoutes] });
const headers = (organizationId: string) => ({ 'x-organization-id': organizationId });

describe('partner public profile route', () => {
  it('returns only public profile fields and hides a profile when its owner disables visibility', async () => {
    const server = await makeServer();
    const viewer = await seedApprovedPartnerOrganization({
      name: 'Viewer',
      slug: `viewer-${++seq}`,
      capabilities: ['host'],
    });
    const promoter = await seedApprovedPartnerOrganization({
      name: 'Public Promoter',
      slug: `promoter-${++seq}`,
      capabilities: ['promoter'],
    });
    const bucket = createV2Services().config().storage.kycBucket;
    const update = await server.inject({
      method: 'PATCH',
      url: `/organizations/${promoter.id}/partner-settings`,
      headers: { ...headers(promoter.id), 'idempotency-key': `profile-update-${seq}` },
      payload: {
        profile: {
          bio: 'Live events in Mumbai',
          city: 'Mumbai',
          genres: ['House'],
          photoUrl: `https://storage.googleapis.com/${bucket}/partner-profiles/${promoter.id}/photo.webp`,
        },
      },
    });
    expect(update.statusCode).toBe(200);
    const visible = await server.inject({
      url: `/organizations/${viewer.id}/partner-profiles/${promoter.id}?kind=promoter`,
      headers: headers(viewer.id),
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({
      name: 'Public Promoter',
      city: 'Mumbai',
      bio: 'Live events in Mumbai',
      photoUrl: expect.stringContaining('/partner-profiles/'),
    });
    expect(visible.json()).not.toHaveProperty('organizationId');
    expect(visible.json()).not.toHaveProperty('email');
    expect(visible.json()).not.toHaveProperty('revenuePaise');

    const hide = await server.inject({
      method: 'PATCH',
      url: `/organizations/${promoter.id}/partner-settings`,
      headers: { ...headers(promoter.id), 'idempotency-key': `profile-hide-${seq}` },
      payload: { privacy: { profileVisible: false } },
    });
    expect(hide.statusCode).toBe(200);
    const hidden = await server.inject({
      url: `/organizations/${viewer.id}/partner-profiles/${promoter.id}?kind=promoter`,
      headers: headers(viewer.id),
    });
    expect(hidden.statusCode).toBe(404);
    await server.close();
  });
});
