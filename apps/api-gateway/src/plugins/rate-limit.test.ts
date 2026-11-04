import { MemoryStaffRotationStore } from '@c1rcle/core/domain';
import { MemoryUserBanRepository } from '@c1rcle/core/infrastructure';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { OrganizationRepository } from '@c1rcle/core/domain';

import authContextPlugin, { type BetterAuthInstance } from './auth.js';
import rateLimitPlugin, { RATE_LIMIT_CLASSES, type RateLimitClass } from './rate-limit.js';

const apps: ReturnType<typeof Fastify>[] = [];
const classes = ['SENSITIVE_COMMAND', 'OTP_SEND', 'OTP_VERIFY'] as const;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(authenticated = false) {
  const app = Fastify({ logger: false });
  apps.push(app);
  let now = 1_000;
  await app.register(authContextPlugin, {
    auth: {
      api: {
        getSession: () =>
          Promise.resolve(authenticated ? { user: { id: 'user-1', role: 'partner' } } : null),
      },
    } as unknown as BetterAuthInstance,
    organizations: {
      getById: (organizationId: string) =>
        Promise.resolve(
          ['org-a', 'org-b'].includes(organizationId)
            ? {
                status: 'active',
                members: [{ userId: 'user-1', role: 'owner', capabilities: ['venue'] }],
              }
            : null,
        ),
    } as unknown as OrganizationRepository,
    rotationStore: new MemoryStaffRotationStore(),
    userBans: new MemoryUserBanRepository(),
  });
  await app.register(rateLimitPlugin, { now: () => now });
  for (const limitClass of classes) {
    app.post(`/${limitClass}`, { preHandler: app.rateLimit(limitClass) }, () => ({ ok: true }));
  }
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    hit: (limitClass: RateLimitClass, organizationId?: string | string[], ip = '192.0.2.1') =>
      app.inject({
        method: 'POST',
        url: `/${limitClass}`,
        remoteAddress: ip,
        headers: organizationId === undefined ? {} : { 'x-organization-id': organizationId },
      }),
  };
}

describe('rate-limit identity through the authentication boundary', () => {
  it.each(classes)(
    '%s cannot reset an anonymous budget by rotating organization headers',
    async (limitClass) => {
      const { hit, advance } = await fixture();
      const budget = RATE_LIMIT_CLASSES[limitClass];
      for (let i = 0; i < budget.limit; i += 1) {
        expect((await hit(limitClass, `org-${i}`)).statusCode).toBe(200);
      }
      for (const header of [undefined, 'fresh-org', 'invalid/path', '', ['org-a', 'org-b']]) {
        const response = await hit(limitClass, header);
        expect(response.statusCode).toBe(429);
        expect(response.headers['retry-after']).toBe('60');
        expect(response.json()).toMatchObject({
          status: 429,
          code: 'rate_limited',
          message: 'Too many requests',
          requestId: expect.any(String),
        });
      }
      advance(budget.windowMs);
      expect((await hit(limitClass, 'another-org')).statusCode).toBe(200);
    },
  );

  it('keeps anonymous IPs and rate-limit classes independent', async () => {
    const { hit } = await fixture();
    for (let i = 0; i < RATE_LIMIT_CLASSES.OTP_SEND.limit; i += 1) {
      expect((await hit('OTP_SEND')).statusCode).toBe(200);
    }
    expect((await hit('OTP_SEND')).statusCode).toBe(429);
    expect((await hit('OTP_SEND', undefined, '192.0.2.2')).statusCode).toBe(200);
    expect((await hit('OTP_VERIFY')).statusCode).toBe(200);
    expect((await hit('SENSITIVE_COMMAND')).statusCode).toBe(200);
  });

  it('preserves verified organization isolation and keeps unverified headers unscoped', async () => {
    const { hit } = await fixture(true);
    for (let i = 0; i < RATE_LIMIT_CLASSES.OTP_SEND.limit; i += 1) {
      expect((await hit('OTP_SEND', 'org-a')).statusCode).toBe(200);
      expect((await hit('OTP_SEND')).statusCode).toBe(200);
    }
    expect((await hit('OTP_SEND', 'org-a')).statusCode).toBe(429);
    expect((await hit('OTP_SEND', 'org-b')).statusCode).toBe(200);
    for (const header of [undefined, 'not-a-member', 'invalid/path']) {
      expect((await hit('OTP_SEND', header)).statusCode).toBe(429);
    }
  });
});
