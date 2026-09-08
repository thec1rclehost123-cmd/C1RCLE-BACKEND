import { describe, expect, it } from 'vitest';

import {
  createTrustedProxyMatcher,
  getBetterAuthTrustedOrigins,
  getGatewayConfig,
  getTrustedProxyCidrs,
} from './index.js';

function productionEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    STORAGE_DRIVER: 'firestore',
    FIREBASE_CLIENT_EMAIL: 'firebase@example.test',
    FIREBASE_PRIVATE_KEY: 'private-key',
    BETTER_AUTH_SECRET: 'a'.repeat(64),
    EMAIL_OTP_SECRET: 'b'.repeat(64),
    PUBLIC_API_URL: 'https://api.example.test',
    BETTER_AUTH_URL: 'https://api.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    BETTER_AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
    TRUSTED_PROXY_CIDRS: '10.0.0.0/8,2001:db8::1',
    ...overrides,
  };
}

describe('gateway configuration', () => {
  it('uses the documented Render deploy SHA when BUILD_SHA is not explicit', () => {
    const config = getGatewayConfig(
      productionEnvironment({ BUILD_SHA: undefined, RENDER_GIT_COMMIT: 'a'.repeat(40) }),
    );

    expect(config.BUILD_SHA).toBe('a'.repeat(40));
  });

  it('requires an email OTP secret in production', () => {
    expect(() => getGatewayConfig(productionEnvironment({ EMAIL_OTP_SECRET: undefined }))).toThrow(
      /EMAIL_OTP_SECRET/,
    );
  });

  it('keeps an explicit BUILD_SHA ahead of Render metadata', () => {
    const config = getGatewayConfig(
      productionEnvironment({ BUILD_SHA: 'b'.repeat(40), RENDER_GIT_COMMIT: 'a'.repeat(40) }),
    );

    expect(config.BUILD_SHA).toBe('b'.repeat(40));
  });

  it('parses explicit origins and trusted proxy CIDRs', () => {
    const config = getGatewayConfig(productionEnvironment());
    expect(getBetterAuthTrustedOrigins(config)).toEqual(['https://app.example.test']);
    expect(getTrustedProxyCidrs(config)).toEqual(['10.0.0.0/8', '2001:db8::1']);

    const isTrusted = createTrustedProxyMatcher(getTrustedProxyCidrs(config));
    expect(isTrusted('10.42.0.8')).toBe(true);
    expect(isTrusted('198.51.100.8')).toBe(false);
  });

  it('rejects trust-all proxy configuration', () => {
    expect(() =>
      getGatewayConfig(productionEnvironment({ TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })),
    ).toThrow(/Invalid trusted proxy CIDR/);
  });

  it('rejects production memory storage and development origins/secrets', () => {
    expect(() =>
      getGatewayConfig(
        productionEnvironment({
          STORAGE_DRIVER: 'memory',
          BETTER_AUTH_SECRET: 'dev-only-change-me',
          ALLOWED_ORIGINS: 'http://localhost:3000',
          BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
          PUBLIC_API_URL: 'http://localhost:8080',
          BETTER_AUTH_URL: 'http://localhost:8080',
        }),
      ),
    ).toThrow(/Production requires STORAGE_DRIVER=firestore/);
  });

  it('fails closed when production Firestore credentials are missing', () => {
    expect(() =>
      getGatewayConfig(
        productionEnvironment({
          FIREBASE_CLIENT_EMAIL: '',
          FIREBASE_PRIVATE_KEY: '',
        }),
      ),
    ).toThrow(/FIREBASE_CLIENT_EMAIL: Required when STORAGE_DRIVER=firestore/);
  });
});
