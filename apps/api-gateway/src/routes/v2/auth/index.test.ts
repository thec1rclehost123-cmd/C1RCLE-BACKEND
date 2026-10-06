import { OrganizationService, type ServiceDeps } from '@c1rcle/core/application';
import {
  MemoryStaffRotationStore,
  createInvitation as makeDomainInvitation,
} from '@c1rcle/core/domain';
import { MemoryInvitationRepository } from '@c1rcle/core/infrastructure';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import rateLimitPlugin from '../../../plugins/rate-limit.js';
import validateV2Plugin from '../../../plugins/validate-v2.js';

import authRoutes from './index.js';

import type { BetterAuthInstance } from '../../../plugins/auth.js';
import type { FastifyInstance } from 'fastify';

/**
 * The auth routes only build a real Better Auth instance on
 * `STORAGE_DRIVER=firestore`, so these tests inject a fake `auth` whose
 * `api.signInEmail` / `api.signUpEmail` return the failure `Response` Better
 * Auth would. The point of interest is `forwardAuthErrorResponse`: on the
 * `login` path every 4xx must collapse to one constant body (no
 * account-existence oracle — spec §11.7 / D-024).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeAuth(overrides: {
  signInEmail?: () => Promise<Response>;
  signUpEmail?: () => Promise<Response>;
  getSession?: () => Promise<{
    user: { id: string; email: string; name: string };
    session: { token: string };
  } | null>;
  changePassword?: () => Promise<unknown>;
}): BetterAuthInstance {
  return {
    api: {
      signInEmail: overrides.signInEmail ?? (() => Promise.resolve(jsonResponse(401, {}))),
      signUpEmail: overrides.signUpEmail ?? (() => Promise.resolve(jsonResponse(400, {}))),
      getSession: overrides.getSession ?? (() => Promise.resolve(null)),
      changePassword: overrides.changePassword ?? (() => Promise.resolve({ status: true })),
    },
  } as unknown as BetterAuthInstance;
}

function sessionFor(userId: string) {
  return {
    user: { id: userId, email: 'staff@example.com', name: 'Staff' },
    session: { token: 'sess_tok', expiresAt: new Date('2026-02-01T00:00:00.000Z') },
  };
}

/** Fresh invitation store + service per app — `listMyInvitations` only reads. */
function testOrganizations(): {
  organizations: OrganizationService;
  invitations: MemoryInvitationRepository;
} {
  const invitations = new MemoryInvitationRepository();
  const organizations = new OrganizationService({
    repositories: { invitations },
  } as unknown as ServiceDeps);
  return { organizations, invitations };
}

async function buildTestApp(auth: BetterAuthInstance): Promise<FastifyInstance> {
  // Fixed request id so two failure responses are byte-comparable.
  const app = Fastify({ genReqId: () => 'req_test', logger: false });
  await app.register(validateV2Plugin);
  await app.register(rateLimitPlugin, { enabled: false });
  await app.register(
    async (instance) =>
      authRoutes(instance, {
        auth,
        rotationStore: new MemoryStaffRotationStore(),
        organizations: testOrganizations().organizations,
      }),
    {
      prefix: '/api/v2/auth',
    },
  );
  return app;
}

describe('auth routes — login failure is not an account-existence oracle', () => {
  it('returns a byte-identical body for an unknown email and a wrong password', async () => {
    const unknownEmailApp = await buildTestApp(
      fakeAuth({
        signInEmail: () => Promise.resolve(jsonResponse(401, { message: 'User not found' })),
      }),
    );
    const wrongPasswordApp = await buildTestApp(
      fakeAuth({
        signInEmail: () => Promise.resolve(jsonResponse(401, { message: 'Invalid password' })),
      }),
    );

    const unknownEmail = await unknownEmailApp.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever1' },
    });
    const wrongPassword = await wrongPasswordApp.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'partner@example.com', password: 'wrongpass1' },
    });

    expect(unknownEmail.statusCode).toBe(400);
    expect(wrongPassword.statusCode).toBe(400);
    // The whole body, verbatim — message, code, status and requestId all match.
    expect(unknownEmail.body).toBe(wrongPassword.body);
    expect(unknownEmail.json().message).toBe('Authentication failed');
    expect(unknownEmail.json()).not.toHaveProperty('message', 'User not found');

    await unknownEmailApp.close();
    await wrongPasswordApp.close();
  });

  it('does not leak the provider message even when Better Auth returns a 400', async () => {
    const app = await buildTestApp(
      fakeAuth({
        signInEmail: () =>
          Promise.resolve(jsonResponse(400, { message: 'No account exists for this email' })),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Authentication failed');
    await app.close();
  });

  it('still forwards the provider message on signup (the genericization is login-only)', async () => {
    const app = await buildTestApp(
      fakeAuth({
        signUpEmail: () =>
          Promise.resolve(jsonResponse(400, { message: 'Email already registered' })),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/signup',
      payload: { email: 'taken@example.com', password: 'longenough1', displayName: 'Taken' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Email already registered');
    await app.close();
  });
});

describe('auth routes — first-login password rotation', () => {
  async function buildRotationApp(
    rotationStore: MemoryStaffRotationStore,
    auth: BetterAuthInstance,
  ): Promise<FastifyInstance> {
    const app = Fastify({ genReqId: () => 'req_test', logger: false });
    await app.register(validateV2Plugin);
    await app.register(rateLimitPlugin, { enabled: false });
    await app.register(
      async (instance) =>
        authRoutes(instance, {
          auth,
          rotationStore,
          organizations: testOrganizations().organizations,
        }),
      {
        prefix: '/api/v2/auth',
      },
    );
    return app;
  }

  it('clears the rotation flag on a successful change and returns a fresh session', async () => {
    const rotationStore = new MemoryStaffRotationStore();
    await rotationStore.setRequired('user_staff', true);
    const app = await buildRotationApp(
      rotationStore,
      fakeAuth({
        getSession: () => Promise.resolve(sessionFor('user_staff')),
        changePassword: () => Promise.resolve({ status: true }),
        signInEmail: () =>
          Promise.resolve(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'application/json', 'set-auth-token': 'tok_fresh' },
            }),
          ),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/change-password',
      payload: { currentPassword: 'TempPass12345678', newPassword: 'brand-new-password-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.mustChangePassword).toBe(false);
    // The old sessions were revoked by design — the client must get a fresh
    // token, never the dead one.
    expect(res.json().accessToken).toBe('tok_fresh');
    expect(await rotationStore.isRequired('user_staff')).toBe(false);
    await app.close();
  });

  it('rejects a wrong current password without clearing the flag', async () => {
    const rotationStore = new MemoryStaffRotationStore();
    await rotationStore.setRequired('user_staff', true);
    const app = await buildRotationApp(
      rotationStore,
      fakeAuth({
        getSession: () => Promise.resolve(sessionFor('user_staff')),
        changePassword: () =>
          Promise.reject(Object.assign(new Error('Invalid password'), { status: 400 })),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/change-password',
      payload: { currentPassword: 'wrong-password', newPassword: 'brand-new-password-1' },
    });

    expect(res.statusCode).toBe(400);
    expect(await rotationStore.isRequired('user_staff')).toBe(true);
    await app.close();
  });

  it('rejects a new password identical to the current one at validation', async () => {
    const app = await buildTestApp(fakeAuth({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/change-password',
      payload: { currentPassword: 'same-password-1', newPassword: 'same-password-1' },
    });

    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('surfaces the rotation flag on the session read', async () => {
    const rotationStore = new MemoryStaffRotationStore();
    await rotationStore.setRequired('user_staff', true);
    const app = await buildRotationApp(
      rotationStore,
      fakeAuth({ getSession: () => Promise.resolve(sessionFor('user_staff')) }),
    );

    const res = await app.inject({ method: 'GET', url: '/api/v2/auth/session' });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.mustChangePassword).toBe(true);
    await app.close();
  });
});

describe('auth routes — my invitations', () => {
  async function buildMineApp(): Promise<{
    app: FastifyInstance;
    invitations: MemoryInvitationRepository;
  }> {
    const { organizations, invitations } = testOrganizations();
    const app = Fastify({ genReqId: () => 'req_test', logger: false });
    await app.register(validateV2Plugin);
    await app.register(rateLimitPlugin, { enabled: false });
    await app.register(
      async (instance) =>
        authRoutes(instance, {
          auth: fakeAuth({ getSession: () => Promise.resolve(sessionFor('user_staff')) }),
          rotationStore: new MemoryStaffRotationStore(),
          organizations,
        }),
      { prefix: '/api/v2/auth' },
    );
    return { app, invitations };
  }

  function seedInvite(
    invitations: MemoryInvitationRepository,
    overrides: Partial<Parameters<typeof makeDomainInvitation>[0]>,
  ): Promise<void> {
    return invitations.save(
      makeDomainInvitation({
        id: `inv_${Math.random().toString(36).slice(2, 10)}`,
        organizationId: 'org_1',
        email: 'staff@example.com',
        role: 'member',
        invitedBy: 'user_owner',
        ...overrides,
      }),
    );
  }

  it("lists only the caller's own pending invitations", async () => {
    const { app, invitations } = await buildMineApp();
    await seedInvite(invitations, { id: 'inv_mine', email: 'staff@example.com' });
    await seedInvite(invitations, { id: 'inv_other', email: 'someone-else@example.com' });
    await seedInvite(invitations, {
      id: 'inv_expired',
      email: 'staff@example.com',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v2/auth/invitations/mine' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(['inv_mine']);
    await app.close();
  });

  it('returns an empty list when nothing is pending', async () => {
    const { app } = await buildMineApp();

    const res = await app.inject({ method: 'GET', url: '/api/v2/auth/invitations/mine' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], pageInfo: { total: 0 } });
    await app.close();
  });
});
