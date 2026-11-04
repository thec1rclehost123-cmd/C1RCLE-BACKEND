import { MemoryStaffRotationStore } from '@c1rcle/core/domain';
import { MemoryUserBanRepository } from '@c1rcle/core/infrastructure';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { OrganizationRepository } from '@c1rcle/core/domain';

import authContextPlugin from './auth.js';
import rbacPlugin from './rbac.js';

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
  ({
    getById: () =>
      Promise.resolve(member ? { status: 'active', members: [{ ...member, userId: 'u1' }] } : null),
  }) as unknown as OrganizationRepository;

async function actorFor(opts: {
  user: { id: string; role?: string } | null;
  member?: unknown;
  headers?: Record<string, string>;
}) {
  const app = Fastify({ logger: false });
  await app.register(authContextPlugin, {
    auth: fakeAuth(opts.user),
    organizations: fakeOrgRepo(opts.member ?? null),
    rotationStore: new MemoryStaffRotationStore(),
    userBans: new MemoryUserBanRepository(),
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
  it('denies organization access on the next request after membership removal', async () => {
    let member = true;
    const app = Fastify({ logger: false });
    await app.register(authContextPlugin, {
      auth: fakeAuth({ id: 'u1' }),
      rotationStore: new MemoryStaffRotationStore(),
      userBans: new MemoryUserBanRepository(),
      organizations: {
        getById: async () => ({
          status: 'active',
          members: member ? [{ userId: 'u1', role: 'owner', capabilities: ['host'] }] : [],
        }),
      } as unknown as OrganizationRepository,
    });
    await app.register(rbacPlugin);
    app.get(
      '/organizations/:organizationId',
      { preHandler: app.requirePermission('organization.read') },
      () => ({}),
    );
    const request = { url: '/organizations/org_a', headers: { 'x-organization-id': 'org_a' } };
    expect((await app.inject(request)).statusCode).toBe(200);
    member = false;
    expect((await app.inject(request)).statusCode).toBe(403);
    await app.close();
  });

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

describe('auth plugin — first-login rotation enforcement', () => {
  it('fails closed on rotation-store outage while keeping sign-out available', async () => {
    const app = Fastify({ logger: false });
    await app.register(authContextPlugin, {
      auth: fakeAuth({ id: 'u1' }),
      organizations: fakeOrgRepo(null),
      userBans: new MemoryUserBanRepository(),
      rotationStore: {
        isRequired: async () => {
          throw new Error('private rotation failure');
        },
        setRequired: async () => {},
      },
    });
    app.get('/probe', () => ({ reached: true }));
    app.post('/api/v2/auth/logout', () => ({ reached: true }));
    const response = await app.inject('/probe');
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private rotation failure');
    expect((await app.inject({ method: 'POST', url: '/api/v2/auth/logout' })).statusCode).toBe(200);
    await app.close();
  });

  async function probeApp(flaggedUserIds: readonly string[]) {
    const rotationStore = new MemoryStaffRotationStore();
    for (const userId of flaggedUserIds) {
      await rotationStore.setRequired(userId, true);
    }
    const app = Fastify({ logger: false });
    await app.register(authContextPlugin, {
      auth: fakeAuth({ id: 'u1' }),
      organizations: fakeOrgRepo(null),
      rotationStore,
      userBans: new MemoryUserBanRepository(),
    });
    app.get('/probe', (request, reply) => reply.send({ actor: request.actor ?? null }));
    return app;
  }

  it('403s non-auth routes while the rotation is owed', async () => {
    const app = await probeApp(['u1']);
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Change your temporary password before continuing.');
    expect(res.json().details).toMatchObject({ passwordChangeRequired: true });
    await app.close();
  });

  it('lets unflagged users through untouched', async () => {
    const app = await probeApp([]);
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.json().actor).toMatchObject({ userId: 'u1' });
    await app.close();
  });
});

describe('auth boundary — bans and suspended organizations', () => {
  async function fixture() {
    const bans = new MemoryUserBanRepository();
    let unavailable = false;
    let status = 'active';
    let organizationUnavailable = false;
    const app = Fastify({ logger: false });
    await app.register(authContextPlugin, {
      auth: fakeAuth({ id: 'u1', role: 'partner' }),
      userBans: {
        getByUserId: async (id: string) => {
          if (unavailable) throw new Error('private repository failure');
          return bans.getByUserId(id);
        },
        save: (ban: Parameters<MemoryUserBanRepository['save']>[0]) => bans.save(ban),
      },
      organizations: {
        getById: async (id: string) => {
          if (organizationUnavailable) throw new Error('private organization error');
          return {
            id,
            status: id === 'org-a' ? status : 'active',
            members: [{ userId: 'u1', role: 'owner', capabilities: ['host'] }],
          };
        },
      } as unknown as OrganizationRepository,
      rotationStore: new MemoryStaffRotationStore(),
    });
    for (const path of ['/probe', '/api/v2/auth/session', '/api/v2/admin/recover'])
      app.get(path, (request) => ({ actor: request.actor ?? null }));
    app.post('/probe', (request) => ({ actor: request.actor ?? null }));
    app.post('/api/v2/auth/logout', () => ({ signedOut: true }));
    return {
      app,
      bans,
      suspend: () => {
        status = 'suspended';
      },
      organizationOutage: () => {
        organizationUnavailable = true;
      },
      outage: () => {
        unavailable = true;
      },
    };
  }

  it('blocks existing sessions regardless of organization headers and restores access after unban', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject('/probe')).statusCode).toBe(200);
      const ban = {
        id: 'u1',
        userId: 'u1',
        isBanned: true,
        bannedAt: new Date().toISOString(),
        bannedBy: 'admin',
        banReason: 'Synthetic',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await f.bans.save(ban);
      for (const org of [undefined, 'org-a', 'org-b', 'bad/path', '']) {
        const response = await f.app.inject({
          url: '/probe',
          headers: org ? { 'x-organization-id': org } : {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'forbidden', status: 403 });
      }
      expect((await f.app.inject('/api/v2/auth/session')).statusCode).toBe(403);
      expect((await f.app.inject('/api/v2/admin/recover')).statusCode).toBe(403);
      expect((await f.app.inject({ method: 'POST', url: '/api/v2/auth/logout' })).statusCode).toBe(
        200,
      );
      await f.bans.save({ ...ban, isBanned: false, version: 2 });
      expect((await f.app.inject('/probe')).statusCode).toBe(200);
    } finally {
      await f.app.close();
    }
  });

  it('fails closed when ban state cannot be read without leaking the repository error', async () => {
    const f = await fixture();
    try {
      f.outage();
      const response = await f.app.inject('/probe');
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private repository');
      expect((await f.app.inject({ method: 'POST', url: '/api/v2/auth/logout' })).statusCode).toBe(
        200,
      );
    } finally {
      await f.app.close();
    }
  });

  it('blocks suspended scoped access while preserving sign-out and independent admin recovery', async () => {
    const f = await fixture();
    const headers = { 'x-organization-id': 'org-a' };
    try {
      expect((await f.app.inject({ url: '/probe', headers })).statusCode).toBe(200);
      f.suspend();
      expect((await f.app.inject({ url: '/probe', headers })).statusCode).toBe(403);
      expect((await f.app.inject({ method: 'POST', url: '/probe', headers })).statusCode).toBe(403);
      expect(
        (await f.app.inject({ url: '/probe', headers: { 'x-organization-id': 'org-b' } }))
          .statusCode,
      ).toBe(200);
      expect(
        (await f.app.inject({ method: 'POST', url: '/api/v2/auth/logout', headers })).statusCode,
      ).toBe(200);
      // This probe tests only the suspension hook exemption. Production admin
      // handlers retain their separate platform-admin authorization.
      expect((await f.app.inject({ url: '/api/v2/admin/recover', headers })).statusCode).toBe(200);
    } finally {
      await f.app.close();
    }
  });
  it('fails closed on organization lookup failure without blocking sign-out or recovery', async () => {
    const f = await fixture();
    const headers = { 'x-organization-id': 'org-a' };
    try {
      f.organizationOutage();
      const response = await f.app.inject({ url: '/probe', headers });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private organization');
      expect(
        (await f.app.inject({ method: 'POST', url: '/api/v2/auth/logout', headers })).statusCode,
      ).toBe(200);
      expect((await f.app.inject({ url: '/api/v2/admin/recover', headers })).statusCode).toBe(200);
    } finally {
      await f.app.close();
    }
  });
});
