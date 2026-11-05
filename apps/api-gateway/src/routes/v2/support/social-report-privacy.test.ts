import { addInternalNote, createSupportTicket } from '@c1rcle/core/domain';
import { expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import supportIntakeRoutes from './intake-routes.js';

it('keeps Admin moderation notes and their timeline entries out of Guest support responses', async () => {
  const services = createV2Services();
  const note = 'Synthetic confidential moderation investigation';
  const created = createSupportTicket({
    id: 'social-report-privacy-fixture',
    subject: 'Synthetic Guest report',
    description: 'Synthetic report for privacy regression only.',
    category: 'account',
    priority: 'medium',
    requester: { userId: 'reporter-guest', email: null, organizationId: null },
  });
  await services.repos().supportTickets.save(created);
  const ticket = addInternalNote(
    created,
    { userId: 'synthetic-moderator', name: 'Synthetic Moderator' },
    note,
  );
  await services.repos().supportTickets.save(ticket);
  const app = await buildPartnerTestServer({ routes: [supportIntakeRoutes] });
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/support/tickets/${ticket.id}`,
      headers: { 'x-user-id': 'reporter-guest' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(
      (await services.repos().supportTickets.getById(ticket.id))?.internalNotes[0]?.content,
    ).toBe(note);
    expect(JSON.stringify(response.json())).not.toContain(note);
    expect(response.json<{ internalNotes: unknown[] }>().internalNotes).toEqual([]);
    expect(
      response
        .json<{ timeline: { type: string }[] }>()
        .timeline.some((entry) => entry.type === 'internal_note'),
    ).toBe(false);
  } finally {
    await app.close();
  }
});
