/* eslint-disable no-restricted-syntax -- Explicit disposable emulator seed, with loopback guard in the fixture factory. */
import { writeFile } from 'node:fs/promises';

import {
  createOrganization,
  createEvent,
  createTicketTier,
  calculatePricing,
  createOrder,
  attachPaymentIntent,
  markPaid,
  issueEntitlements,
} from '@c1rcle/core/domain';

import { createPartnerRefinementFixture } from './partner-refinement-fixture.js';
// Disposable loopback-only fixture, never a production seed.
const fixture = await createPartnerRefinementFixture();
const { app, services, accounts } = fixture;
const partner = accounts.find((a) => a.persona === 'partner');
if (!partner) throw new Error('Missing synthetic Partner');
await writeFile(
  '/tmp/c1rcle-partner-refinement-fixture.json',
  JSON.stringify({
    email: partner.email,
    password: partner.password,
    organizationId: 'preview-partner-ui',
    projectId: fixture.projectId,
  }),
);
const org = createOrganization({
  id: 'preview-partner-ui',
  name: 'C1RCLE Studio',
  slug: 'preview-partner-ui',
  ownerId: partner.id,
  capabilities: ['host', 'venue'],
});
await services.repos().organizations.save(org);
for (const [index, title] of ['Neon Nights', 'Sunset Sessions'].entries()) {
  const event = {
    ...createEvent({
      id: `preview-event-${index}`,
      organizationId: org.id,
      venueId: 'synthetic-venue',
      title,
      startAt: '2026-11-21T15:30:00Z',
    }),
    status: 'published' as const,
    isPublic: true,
    isFree: false,
    startingPricePaise: 90000,
    capacity: 400,
    imageUrl:
      'https://c1-rcle-frontend-partner-dashboard.vercel.app/partner-v3/venue/neon-nights-poster.jpg',
  };
  await services.repos().events.save(event);
  for (const [tierIndex, name] of ['General Admission', 'VIP'].entries()) {
    const tier = createTicketTier({
      id: `preview-tier-${index}-${tierIndex}`,
      eventId: event.id,
      organizationId: org.id,
      name,
      priceInPaise: tierIndex ? 180000 : 90000,
      quantity: 200,
    });
    await services.repos().catalog.saveTier(tier);
    for (const [n, guest] of accounts.filter((a) => a.persona !== 'partner').entries()) {
      const now = new Date(Date.now() - (index * 2 + tierIndex + n) * 86400000);
      let order = createOrder({
        id: `preview-order-${index}-${tierIndex}-${n}`,
        eventId: event.id,
        organizationId: org.id,
        userId: guest.id,
        contact: { name: n ? 'Rhea Shah' : 'Aisha Menon', email: guest.email, phone: '' },
        pricing: calculatePricing({ lines: [{ tier, quantity: n + 1 }] }),
        now,
      });
      await services.repos().orders.save(order);
      order = attachPaymentIntent(order, `synthetic-provider-${order.id}`, now);
      await services.repos().orders.save(order);
      order = markPaid(order, `synthetic-payment-${order.id}`, now);
      await services.repos().orders.save(order);
      for (const ticket of issueEntitlements({ order, now }))
        await services.repos().entitlements.save({
          ...ticket,
          currentHolderUserId: guest.id,
          holderName: order.contact.name,
        });
    }
  }
}
await writeFile(
  '/tmp/c1rcle-partner-refinement-fixture.json',
  JSON.stringify({
    email: partner.email,
    password: partner.password,
    organizationId: org.id,
    projectId: fixture.projectId,
  }),
);
for (const [id, name, capability] of [
  ['synthetic-host-one', 'After Hours Collective', 'host'],
  ['synthetic-promoter-one', 'Night Shift', 'promoter'],
] as const) {
  await services.repos().organizations.save(
    createOrganization({
      id,
      name,
      slug: id,
      ownerId: `owner-${id}`,
      capabilities: [capability],
    }),
  );
}
const staffSignup = await app.inject({
  method: 'POST',
  url: '/api/v2/auth/partner/signup',
  payload: {
    email: `staff@${fixture.projectId}.invalid`,
    password: 'Synthetic-profile-password-16',
    displayName: 'Kabir Mehta',
  },
});
if (staffSignup.statusCode !== 201) throw new Error('Synthetic staff signup failed');
const staffId = staffSignup.json<{ user: { id: string } }>().user.id;
await fixture.db.collection('v2_auth_users').doc(staffId).update({ emailVerified: true });
await fixture.db
  .collection('v2_organizations')
  .doc(org.id)
  .update({
    members: [
      ...org.members,
      {
        userId: staffId,
        name: 'Kabir Mehta',
        email: 'kabir@example.invalid',
        role: 'manager',
        capabilities: ['venue'],
        joinedAt: new Date().toISOString(),
      },
    ],
  });
await app.listen({ host: '127.0.0.1', port: 4301 });
console.log(
  'Disposable Partner preview listening on 4301. Local account details in /tmp/c1rcle-partner-refinement-fixture.json',
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void fixture.close().then(() => process.exit(0));
  });
