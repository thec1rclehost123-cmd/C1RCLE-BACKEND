import { describe, expect, it } from 'vitest';

import { getGoogleAuthConfig } from './google-auth.js';

describe('Google provider configuration', () => {
  it('is unavailable without configuration', () => expect(getGoogleAuthConfig({})).toBeUndefined());
  it('requires both credentials and does not disclose them in errors', () => {
    expect(() => getGoogleAuthConfig({ GOOGLE_CLIENT_SECRET: 'synthetic-secret' })).toThrow(
      'Invalid Google authentication configuration.',
    );
    expect(() => getGoogleAuthConfig({ GOOGLE_CLIENT_ID: 'synthetic-id' })).toThrow();
  });
  it('returns paired credentials for the native provider', () => {
    expect(
      getGoogleAuthConfig({
        GOOGLE_CLIENT_ID: 'synthetic-id',
        GOOGLE_CLIENT_SECRET: 'synthetic-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
      }),
    ).toEqual({
      clientId: 'synthetic-id',
      clientSecret: 'synthetic-secret',
      redirectURI: 'http://localhost:3000/api/auth/google/callback',
    });
  });
  it.each([
    'http://guest.example/api/auth/google/callback',
    'https://guest.example/callback-without-credentials',
    'https://guest.example/other',
  ])('rejects unsafe callback configuration %s', (redirectURI) => {
    expect(() =>
      getGoogleAuthConfig({
        GOOGLE_CLIENT_ID: 'synthetic-id',
        GOOGLE_CLIENT_SECRET: 'synthetic-secret',
        GOOGLE_REDIRECT_URI: redirectURI,
      }),
    ).toThrow();
  });
});
