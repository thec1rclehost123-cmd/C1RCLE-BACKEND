import { describe, expect, it } from 'vitest';

import { createCoreConfig, guestPortalOrigin } from './index.js';

const credentialedOrigin = new URL('https://guest.example.test');
credentialedOrigin.username = 'fixture-user';
credentialedOrigin.password = 'not-a-real-password';

describe('configured Guest invitation origin', () => {
  it('defaults to the canonical origin and supports a configured staging deployment', () => {
    expect(guestPortalOrigin()).toBe('https://thec1rcle.com');
    expect(guestPortalOrigin('https://guest-preview.example.test/')).toBe(
      'https://guest-preview.example.test',
    );
    expect(
      createCoreConfig({
        redis: { url: 'redis://localhost' },
        firestore: { projectId: 'test' },
        guestPortalUrl: 'http://localhost:3000',
      }).guestPortalUrl,
    ).toBe('http://localhost:3000');
  });
  it.each([
    'javascript:alert(1)',
    'https://guest.example.test/attacker',
    credentialedOrigin.href,
    'https://guest.example.test?next=evil',
    'https://guest.example.test/#evil',
  ])('rejects unsafe or non-origin configuration %s', (origin) => {
    expect(() => guestPortalOrigin(origin)).toThrow('HTTP(S) origin');
  });
});
