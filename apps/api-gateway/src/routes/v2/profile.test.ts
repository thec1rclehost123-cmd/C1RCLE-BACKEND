import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../test-utils/partner-test-server.js';

import guestProfileRoutes from './profile.js';

const buildServer = () => buildPartnerTestServer({ routes: [guestProfileRoutes] });

const BODY = {
  displayName: 'Aayush',
  dateOfBirth: '2000-01-01',
  city: 'Pune',
  tastes: ['Rooftops', 'Live music', 'Art & culture'],
  intents: ['Find events'],
};

describe('GET /profile/me', () => {
  it('404s before any profile is saved', async () => {
    const server = await buildServer();
    const res = await server.inject({ method: 'GET', url: '/profile/me' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });

  it('isolates profiles by session user', async () => {
    const server = await buildServer();
    const put = await server.inject({
      method: 'PUT',
      url: '/profile/me',
      headers: { 'x-user-id': 'user_A' },
      payload: BODY,
    });
    expect(put.statusCode).toBe(200);

    const other = await server.inject({
      method: 'GET',
      url: '/profile/me',
      headers: { 'x-user-id': 'user_B' },
    });
    expect(other.statusCode).toBe(404);

    const own = await server.inject({
      method: 'GET',
      url: '/profile/me',
      headers: { 'x-user-id': 'user_A' },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ userId: 'user_A', city: 'Pune' });
    await server.close();
  });
});

describe('PUT /profile/me', () => {
  it('creates then fully replaces the profile', async () => {
    const server = await buildServer();
    const first = await server.inject({ method: 'PUT', url: '/profile/me', payload: BODY });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      userId: 'user_1',
      displayName: 'Aayush',
      city: 'Pune',
    });

    const second = await server.inject({
      method: 'PUT',
      url: '/profile/me',
      payload: { ...BODY, city: 'Mumbai' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ city: 'Mumbai' });
    expect(second.json().createdAt).toBe(first.json().createdAt);
    await server.close();
  });

  it('422s short tastes lists and unknown keys (strict body)', async () => {
    const server = await buildServer();
    const short = await server.inject({
      method: 'PUT',
      url: '/profile/me',
      payload: { ...BODY, tastes: ['Rooftops'] },
    });
    expect(short.statusCode).toBe(422);

    const hacked = await server.inject({
      method: 'PUT',
      url: '/profile/me',
      payload: { ...BODY, role: 'admin' },
    });
    expect(hacked.statusCode).toBe(422);
    await server.close();
  });

  it('400s under-18 dates of birth from the domain guard', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/profile/me',
      payload: { ...BODY, dateOfBirth: '2015-01-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'validation',
      message: 'Guest must be at least 18 years old.',
    });
    await server.close();
  });
});
