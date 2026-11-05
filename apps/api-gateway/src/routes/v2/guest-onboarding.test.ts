import { createGuestProfileService } from '@c1rcle/core/application';
import { MemoryGuestProfileRepository } from '@c1rcle/core/infrastructure';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import rateLimit from '../../plugins/rate-limit.js';
import validate from '../../plugins/validate-v2.js';

import { registerGuestOnboarding } from './guest-onboarding.js';

async function build() {
  const service = createGuestProfileService({
    guestProfiles: new MemoryGuestProfileRepository(),
    config: { clock: { now: () => new Date('2026-11-04T00:00:00Z') } } as never,
  });
  const app = Fastify();
  await app.register(rateLimit, { enabled: true });
  await app.register(validate);
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-user'])
      request.actor = { userId: request.headers['x-test-user'] } as never;
  });
  await registerGuestOnboarding(app, service, {
    name: 'synthetic-capture',
    verify: async (request) => ({
      passed: request.proofToken === 'synthetic-valid',
      provider: 'firebase-phone',
    }),
  });
  return { app, service };
}
describe('private Guest onboarding endpoints', () => {
  it('requires a session and isolates persisted caller progress', async () => {
    const { app } = await build();
    expect((await app.inject('/profile/onboarding')).statusCode).toBe(401);
    const headers = { 'x-test-user': 'guest-a' };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/profile/onboarding',
          headers,
          payload: { displayName: 'Guest A', dateOfBirth: '2000-01-01', tastes: ['House'] },
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject({ url: '/profile/onboarding', headers })).json()).toMatchObject({
      displayName: 'Guest A',
      complete: false,
      phoneVerified: false,
    });
    expect(
      (
        await app.inject({ url: '/profile/onboarding', headers: { 'x-test-user': 'guest-b' } })
      ).json(),
    ).toMatchObject({ displayName: '', dateOfBirth: '', phoneNumber: null });
    await app.close();
  });
  it('rejects client verification flags and completes only after bound proof', async () => {
    const { app } = await build();
    const headers = { 'x-test-user': 'guest-a' };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/profile/onboarding',
          headers,
          payload: { phoneVerified: true },
        })
      ).statusCode,
    ).toBe(422);
    await app.inject({
      method: 'PUT',
      url: '/profile/onboarding',
      headers,
      payload: { displayName: 'Guest', dateOfBirth: '2000-01-01', tastes: ['House'] },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/profile/onboarding/phone',
          headers,
          payload: { phoneNumber: '+919876543210', proofToken: 'wrong' },
        })
      ).statusCode,
    ).not.toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/profile/onboarding/phone',
          headers,
          payload: { phoneNumber: '+919876543210', proofToken: 'synthetic-valid' },
        })
      ).statusCode,
    ).toBe(204);
    const response = await app.inject({ url: '/profile/onboarding', headers });
    expect(response.json()).toMatchObject({ complete: true, phoneVerified: true });
    expect(response.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });
});
