import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerOrganizationRoutes from './organizations.js';
import promoterConnectionRoutes from './promoter-connections.js';

/**
 * ─── Promoter connections over HTTP (Phase 1) ────────────────────────────────
 * The asymmetry is what matters: the recipient approves, only the promoter
 * revokes.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({ routes: [partnerOrganizationRoutes, promoterConnectionRoutes] });

type Server = Awaited<ReturnType<typeof buildServer>>;
const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({ ...read(org), 'idempotency-key': `pc-key-${++keySeq}` });

async function createOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Org', slug: `org-${keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

/** A promoter org opening a connection to a venue org. */
async function pending(server: Server) {
  const promoter = await createOrganization(server);
  const target = await createOrganization(server);
  const created = await server.inject({
    method: 'POST',
    url: '/promoter-connections',
    headers: write(promoter),
    payload: { counterpartyId: target, targetType: 'venue', initiatedBy: 'promoter' },
  });
  const connectionId: string = created.json().id;
  return { promoter, target, connectionId, created };
}

describe('opening a connection', () => {
  it('starts pending with the caller as the promoter side', async () => {
    const server = await buildServer();
    const { promoter, target, created } = await pending(server);

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: 'pending',
      promoterId: promoter,
      targetId: target,
      targetType: 'venue',
    });
    await server.close();
  });

  it('refuses a second live connection for the same pair', async () => {
    const server = await buildServer();
    const { promoter, target } = await pending(server);

    const second = await server.inject({
      method: 'POST',
      url: '/promoter-connections',
      headers: write(promoter),
      payload: { counterpartyId: target, targetType: 'venue', initiatedBy: 'promoter' },
    });

    // v1's "BUG-2" fix: pending OR active blocks, not pending alone.
    expect(second.statusCode).toBe(400);
    await server.close();
  });
});

describe('answering', () => {
  it('lets the recipient approve', async () => {
    const server = await buildServer();
    const { target, connectionId } = await pending(server);

    const response = await server.inject({
      method: 'POST',
      url: `/promoter-connections/${connectionId}/approve`,
      headers: write(target),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'active' });
    await server.close();
  });

  it('refuses approval by the promoter who opened it', async () => {
    const server = await buildServer();
    const { promoter, connectionId } = await pending(server);

    const response = await server.inject({
      method: 'POST',
      url: `/promoter-connections/${connectionId}/approve`,
      headers: write(promoter),
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('lets only the promoter revoke — not the target', async () => {
    const server = await buildServer();
    const { promoter, target, connectionId } = await pending(server);

    const byTarget = await server.inject({
      method: 'POST',
      url: `/promoter-connections/${connectionId}/revoke`,
      headers: write(target),
    });
    expect(byTarget.statusCode).toBe(400);

    // Withdrawing is not the counterparty refusing you — that is `reject`.
    const byPromoter = await server.inject({
      method: 'POST',
      url: `/promoter-connections/${connectionId}/revoke`,
      headers: write(promoter),
    });
    expect(byPromoter.json()).toMatchObject({ status: 'revoked' });
    await server.close();
  });

  it('hides a connection between two other organizations', async () => {
    const server = await buildServer();
    const { connectionId } = await pending(server);
    const stranger = await createOrganization(server);

    const response = await server.inject({
      method: 'POST',
      url: `/promoter-connections/${connectionId}/approve`,
      headers: write(stranger),
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('lists from either side', async () => {
    const server = await buildServer();
    const { promoter, target } = await pending(server);

    for (const org of [promoter, target]) {
      const listed = await server.inject({
        method: 'GET',
        url: `/organizations/${org}/promoter-connections`,
        headers: read(org),
      });
      expect(listed.json().items).toHaveLength(1);
    }
    await server.close();
  });
});
