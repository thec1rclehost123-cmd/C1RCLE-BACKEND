import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTrustedProxyMatcher,
  getAllowedOrigins,
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
    MAGIC_TICKET_SECRET: 'c'.repeat(64),
    ENCRYPTION_KEY: 'd'.repeat(64),
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

  it('requires a real bank-encryption key in production', () => {
    // Without it the core seals bank-account numbers with a secret published in
    // the repo, so production must refuse to boot rather than fall back.
    expect(() => getGatewayConfig(productionEnvironment({ ENCRYPTION_KEY: undefined }))).toThrow(
      /ENCRYPTION_KEY/,
    );
    expect(() => getGatewayConfig(productionEnvironment({ ENCRYPTION_KEY: 'short' }))).toThrow(
      /ENCRYPTION_KEY/,
    );
    expect(getGatewayConfig(productionEnvironment()).ENCRYPTION_KEY).toHaveLength(64);
  });

  it('requires a long email OTP secret in production, not just a present one', () => {
    expect(() => getGatewayConfig(productionEnvironment({ EMAIL_OTP_SECRET: 'short' }))).toThrow(
      /EMAIL_OTP_SECRET/,
    );
  });

  it('requires an email OTP secret in production', () => {
    // A forged magic-ticket key forges entry to a paid event, so production
    // must refuse to boot on the well-known development default rather than
    // silently using it (which every deploy did until this was wired).
    expect(() =>
      getGatewayConfig(productionEnvironment({ MAGIC_TICKET_SECRET: undefined })),
    ).toThrow(/MAGIC_TICKET_SECRET/);
    expect(() => getGatewayConfig(productionEnvironment({ MAGIC_TICKET_SECRET: 'short' }))).toThrow(
      /MAGIC_TICKET_SECRET/,
    );
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

describe('allowedBrowserOrigins (CORS_ALLOWED_ORIGINS)', () => {
  const ADMIN = 'https://c1rcle-v2-admin-console.vercel.app';

  /**
   * `getGatewayConfig` caches the first successful parse, so each case re-imports
   * the module to get a fresh cache. The base is staging's `productionEnvironment`
   * (firestore + the production secrets), because the memory-in-production
   * escape hatch is staging's shape and `BASE` no longer exists here.
   */
  const BASE = productionEnvironment();

  beforeEach(() => {
    vi.resetModules();
  });

  async function loadConfig() {
    vi.resetModules();
    return import('./index.js');
  }

  it('parses a comma-separated list, trimming whitespace and trailing slashes', async () => {
    const { getGatewayConfig, allowedBrowserOrigins } = await loadConfig();
    const config = getGatewayConfig({
      ...BASE,
      CORS_ALLOWED_ORIGINS: ` ${ADMIN}/ , https://partners.example.com,${ADMIN}`,
    });
    expect(allowedBrowserOrigins(config)).toEqual([ADMIN, 'https://partners.example.com']);
  });

  it('allows no cross-origin browsers in production when unset', async () => {
    const { getGatewayConfig, allowedBrowserOrigins } = await loadConfig();
    // Fails closed: the dev localhost ports must never leak into production.
    expect(allowedBrowserOrigins(getGatewayConfig({ ...BASE }))).toEqual([]);
  });

  it('defaults to the local dev frontends outside production', async () => {
    const { getGatewayConfig, allowedBrowserOrigins } = await loadConfig();
    const config = getGatewayConfig({ NODE_ENV: 'development' });
    expect(allowedBrowserOrigins(config)).toEqual([
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
    ]);
  });

  it.each([
    ['a wildcard', '*'],
    ['a wildcard subdomain', 'https://*.vercel.app'],
    ['a path', `${ADMIN}/login`],
    ['a non-http scheme', 'ftp://example.com'],
    ['garbage', 'not a url'],
  ])('rejects %s', async (_label, value) => {
    const { getGatewayConfig } = await loadConfig();
    expect(() => getGatewayConfig({ ...BASE, CORS_ALLOWED_ORIGINS: value })).toThrow(
      /CORS_ALLOWED_ORIGINS/,
    );
  });

  it('rejects an http:// origin in production', async () => {
    const { getGatewayConfig } = await loadConfig();
    expect(() =>
      getGatewayConfig({ ...BASE, CORS_ALLOWED_ORIGINS: 'http://admin.example.com' }),
    ).toThrow(/must be https/);
  });
});

describe('origin allow-lists', () => {
  it('normalises entries to the canonical form browsers send in Origin', () => {
    const config = getGatewayConfig(
      productionEnvironment({
        ALLOWED_ORIGINS:
          'https://Admin.Example.test/, https://partners.example.test:443,https://admin.example.test',
        BETTER_AUTH_TRUSTED_ORIGINS: 'https://Admin.Example.test/',
      }),
    );
    expect(getAllowedOrigins(config)).toEqual([
      'https://admin.example.test',
      'https://partners.example.test',
    ]);
    expect(getBetterAuthTrustedOrigins(config)).toEqual(['https://admin.example.test']);
  });

  // TruffleHog's URI detector matches any `scheme://user:pass@host` and its
  // unverified result fails the security gate (exit 183). The userinfo below is
  // a synthetic fixture — a reserved `.test` host that resolves nowhere — and
  // the row exists precisely to assert such origins are REJECTED. The ignore tag
  // must stay on the same physical line as the secret to be honoured.
  it.each([
    ['a query string', 'https://app.example.test/?x=1'],
    ['a fragment', 'https://app.example.test/#x'],
    ['credentials', 'https://user:pass@app.example.test'], // trufflehog:ignore
  ])('rejects an origin with %s', (_label, value) => {
    expect(() =>
      getGatewayConfig(
        productionEnvironment({ ALLOWED_ORIGINS: value, BETTER_AUTH_TRUSTED_ORIGINS: value }),
      ),
    ).toThrow(/ALLOWED_ORIGINS/);
  });
});
