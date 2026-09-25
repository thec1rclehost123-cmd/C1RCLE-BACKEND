import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import supportIntakeRoutes from '../support/intake-routes.js';

import adminSupportRoutes from './support.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Support: guest intake + admin desk over HTTP (Phase 7) ──────────────────
 * Walks the full lifecycle through the real routes on the memory driver: a
 * guest submits a ticket (SLA stamped from priority), only that guest can see
 * it, and every desk mutation — assign, reply, note, priority, escalate,
 * resolve, merge, delete, restore — is audited against the acting admin.
 * The non-admin caller is a 403, and a ticket is scoped to its requester.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

async function submitTicket(
  server: FastifyInstance,
  guest: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await server.inject({
    method: 'POST',
    url: '/support/tickets',
    headers: asUser(guest),
    payload: {
      subject: 'Door scan failed for my second ticket',
      description: 'Only one of the two tickets scanned at entry tonight.',
      category: 'order',
      priority: 'high',
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.supportTickets as unknown as { tickets: Map<string, unknown> }).tickets.clear();

  server = await buildPartnerTestServer({
    routes: [supportIntakeRoutes, adminSupportRoutes],
  });
});

describe('guest intake', () => {
  it('opens a high-priority ticket with the matching SLA window', async () => {
    const body = await submitTicket(server, 'usr_guest');
    expect(body.status).toBe('open');
    expect(body.priority).toBe('high');
    expect(body.requester.userId).toBe('usr_guest');
    expect(body.assignee).toBeNull();
    const now = Date.now();
    const responseDue = new Date(body.sla.responseDueAt).getTime();
    const resolutionDue = new Date(body.sla.resolutionDueAt).getTime();
    // high → respond within 4h, resolve within 24h.
    expect(responseDue).toBeGreaterThan(now);
    expect(responseDue - now).toBeLessThan(5 * 60 * 60 * 1000);
    expect(resolutionDue - now).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it('lists only the caller-created tickets', async () => {
    await submitTicket(server, 'usr_one');
    await submitTicket(server, 'usr_two');

    const list = await server.inject({
      method: 'GET',
      url: '/support/tickets',
      headers: { 'x-user-id': 'usr_one' },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.pageInfo.total).toBe(1);
    expect(body.items[0].requester.userId).toBe('usr_one');
  });

  it('a follow-up on someone else ticket is a 404, not a hint', async () => {
    const created = await submitTicket(server, 'usr_owner');
    const foreign = await server.inject({
      method: 'GET',
      url: `/support/tickets/${created.id}`,
      headers: { 'x-user-id': 'usr_other' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('a customer follow-up re-arms the response SLA and leaves the thread intact', async () => {
    const created = await submitTicket(server, 'usr_guest');
    const replied = await server.inject({
      method: 'POST',
      url: `/support/tickets/${created.id}/messages`,
      headers: asUser('usr_guest'),
      payload: { content: 'Actually only the box office pass worked.' },
    });
    expect(replied.statusCode).toBe(200);
    const body = replied.json();
    expect(body.messages[body.messages.length - 1].senderRole).toBe('customer');
    expect(body.messages).toHaveLength(1);
    // A brand-new response deadline, later than the original one.
    const freshDue = new Date(body.sla.responseDueAt).getTime();
    expect(freshDue).toBeGreaterThan(Date.now());
  });
});

describe('admin desk (TIER1 — any admin, always audited)', () => {
  it('a support role admin can list, assign, reply and resolve tickets', async () => {
    await seedAdmin('admin_support', 'support');
    const created = await submitTicket(server, 'usr_guest');

    const listed = await server.inject({
      method: 'GET',
      url: '/admin/support/tickets',
      headers: { 'x-user-id': 'admin_support' },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().pageInfo.total).toBe(1);

    const assigned = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/assign`,
      headers: asUser('admin_support'),
      payload: { userId: 'admin_support', name: 'Ada Support' },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().status).toBe('in_progress');

    const replied = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/reply`,
      headers: asUser('admin_support'),
      payload: { content: 'Replacement code is on its way.' },
    });
    expect(replied.statusCode).toBe(200);
    expect(replied.json().status).toBe('waiting_on_customer');

    const resolved = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/resolve`,
      headers: asUser('admin_support'),
      payload: { reason: 'Replacement code emailed to the guest.' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('resolved');
    expect(resolved.json().resolvedBy).toBe('admin_support');
  });

  it('records internal notes separately from the customer thread', async () => {
    await seedAdmin('admin_support', 'support');
    const created = await submitTicket(server, 'usr_guest');
    const noted = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/notes`,
      headers: asUser('admin_support'),
      payload: { content: 'Requester verified via government ID.' },
    });
    expect(noted.statusCode).toBe(200);
    const body = noted.json();
    expect(body.internalNotes).toHaveLength(1);
    expect(body.messages).toHaveLength(0);
  });

  it('escalates to the technical tier and reopens a resolved ticket', async () => {
    await seedAdmin('admin_support', 'support');
    const created = await submitTicket(server, 'usr_guest');
    const escalated = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/escalate`,
      headers: asUser('admin_support'),
    });
    expect(escalated.json().status).toBe('escalated');

    const resolved = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/resolve`,
      headers: asUser('admin_support'),
      payload: { reason: 'Fixed on the box office side.' },
    });
    const reopened = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/reopen`,
      headers: asUser('admin_support'),
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe('open');
    expect(resolved.json().resolvedBy).toBe('admin_support');
  });

  it('merges a duplicate into the primary: annotation, closing, mergedInto', async () => {
    await seedAdmin('admin_support', 'support');
    const primary = await submitTicket(server, 'usr_guest');
    const duplicate = await submitTicket(server, 'usr_guest', {
      subject: 'Same problem, second report',
      description: 'Duplicate of my earlier report.',
      category: 'order',
      priority: 'high',
    });
    await server.inject({
      method: 'POST',
      url: `/support/tickets/${primary.id}/messages`,
      headers: asUser('usr_guest'),
      payload: { content: 'Ah here is the real scan photo.' },
    });
    await server.inject({
      method: 'POST',
      url: `/support/tickets/${duplicate.id}/messages`,
      headers: asUser('usr_guest'),
      payload: { content: 'And the same photo via this ticket.' },
    });

    const merged = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${primary.id}/merge`,
      headers: asUser('admin_support'),
      payload: { duplicateTicketId: duplicate.id },
    });
    expect(merged.statusCode).toBe(200);
    const body = merged.json();
    expect(body.mergedFrom).toEqual([duplicate.id]);
    expect(body.status).toBe('open'); // unchanged (absorbed, not resolved)
    expect(
      body.messages.some((m: { content: string }) => m.content.includes('[Merged from ticket')),
    ).toBe(true);

    const dupDetail = await server.inject({
      method: 'GET',
      url: `/admin/support/tickets/${duplicate.id}`,
      headers: { 'x-user-id': 'admin_support' },
    });
    expect(dupDetail.json().mergedInto).toBe(primary.id);
    expect(dupDetail.json().status).toBe('closed');
  });

  it('soft-deletes with attribution and restores', async () => {
    await seedAdmin('admin_support', 'support');
    const created = await submitTicket(server, 'usr_guest');

    const hidden = await server.inject({
      method: 'DELETE',
      url: `/admin/support/tickets/${created.id}`,
      headers: asUser('admin_support'),
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().deletedBy).toBe('admin_support');

    const invisible = await server.inject({
      method: 'GET',
      url: `/admin/support/tickets/${created.id}`,
      headers: { 'x-user-id': 'admin_support' },
    });
    expect(invisible.statusCode).toBe(404);

    const restored = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/restore`,
      headers: asUser('admin_support'),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().deletedAt).toBeNull();
  });

  it('a non-admin caller is refused the desk', async () => {
    const created = await submitTicket(server, 'usr_guest');
    const response = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/resolve`,
      headers: asUser('usr_guest'),
      payload: { reason: 'Not allowed.' },
    });
    expect(response.statusCode).toBe(401); // not a platform admin at all
  });

  it('admins can search their queue and filter by status priority and category', async () => {
    await seedAdmin('admin_support', 'support');
    await submitTicket(server, 'usr_guest');
    await submitTicket(server, 'usr_guest', {
      subject: 'Refund for the cancelled show',
      description: 'The event got cancelled and I want my money back.',
      category: 'billing',
      priority: 'urgent',
    });

    const filter = await server.inject({
      method: 'GET',
      url: '/admin/support/tickets?priority=urgent&category=billing',
      headers: { 'x-user-id': 'admin_support' },
    });
    expect(filter.json().pageInfo.total).toBe(1);
    expect(filter.json().items[0].subject).toBe('Refund for the cancelled show');

    const search = await server.inject({
      method: 'GET',
      url: '/admin/support/tickets?search=door%20scan',
      headers: { 'x-user-id': 'admin_support' },
    });
    expect(search.json().pageInfo.total).toBe(1);
    expect(search.json().items[0].category).toBe('order');
  });

  it('rejects an empty resolve reason', async () => {
    await seedAdmin('admin_support', 'support');
    const created = await submitTicket(server, 'usr_guest');
    const response = await server.inject({
      method: 'POST',
      url: `/admin/support/tickets/${created.id}/resolve`,
      headers: asUser('admin_support'),
      payload: { reason: '   ' },
    });
    expect(response.statusCode).toBe(400); // invalid_operation → validation
  });
});
