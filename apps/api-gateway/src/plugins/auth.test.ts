import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { OrganizationRepository } from '@c1rcle/core/domain';

import authContextPlugin from './auth.js';

import type { BetterAuthInstance } from './auth.js';

/**
 * The onRequest hook must produce a *session-only* actor for an authenticated
 * user who is not yet scoped to an organization — otherwise `buildActorContext`
 * 401s the whole signup → onboarding → first-org journey on the firestore
 * driver. (The memory driver fabricates an actor, so only firestore ever
 * exercised this path.)
 */

function fakeAuth(user: { id: string; role?: string } | null): BetterAuthInstance {
  return {
    api: { getSession: () => Promise.resolve(user ? { user } : null) },
  } as unknown as BetterAuthInstance;
}

const fakeOrgRepo = (member: unknown): OrganizationRepository =>
  ({ getMember: () => Promise.resolve(member) }) as unknown as OrganizationRepository;

async function actorFor(opts: {
  user: { id: string; role?: string } | null;
  member?: unknown;
  headers?: Record<string, string>;
}) {
  const app = Fastify({ logger: false });
  await app.register(authContextPlugin, {
    auth: fakeAuth(opts.user),
    organizations: fakeOrgRepo(opts.member ?? null),
  });
  app.get('/probe', (request, reply) => reply.send({ actor: request.actor ?? null }));
  const res = await app.inject({ method: 'GET', url: '/probe', headers: opts.headers });
  await app.close();
  return res.json().actor as null | {
    userId: string;
    organizationId: string;
    role: string;
    capabilities: string[];
    platformRole: string;
  };
}

describe('auth context hook — actor resolution', () => {
  it('sets a session-only actor when authenticated but no org header', async () => {
    const actor = await actorFor({ user: { id: 'u1' } });
    expect(actor).toMatchObject({
      userId: 'u1',
      organizationId: '',
      role: 'member',
      capabilities: [],
    });
  });

  it('keeps the session-only actor when the org header names an org the user is not in', async () => {
    const actor = await actorFor({
      user: { id: 'u1' },
      member: null,
      headers: { 'x-organization-id': 'org_x' },
    });
    expect(actor).toMatchObject({ userId: 'u1', organizationId: '' });
  });

  it('upgrades to a full membership actor when one resolves', async () => {
    const actor = await actorFor({
      user: { id: 'u1', role: 'partner' },
      member: { role: 'owner', capabilities: ['venue'] },
      headers: { 'x-organization-id': 'org_1' },
    });
    expect(actor).toMatchObject({
      userId: 'u1',
      organizationId: 'org_1',
      role: 'owner',
      capabilities: ['venue'],
      platformRole: 'partner',
    });
  });

  it('sets no actor at all when there is no session', async () => {
    expect(await actorFor({ user: null })).toBeNull();
  });
});
