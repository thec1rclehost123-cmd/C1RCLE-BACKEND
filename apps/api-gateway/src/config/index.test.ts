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
    FIRESTORE_PROJECT_ID: 'c1rcle-v2',
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
  it('keeps process-wide workers off unless explicitly enabled', () => {
    expect(getGatewayConfig(productionEnvironment()).BACKGROUND_WORKERS_ENABLED).toBe(false);
    expect(
      getGatewayConfig(productionEnvironment({ BACKGROUND_WORKERS_ENABLED: 'false' }))
        .BACKGROUND_WORKERS_ENABLED,
    ).toBe(false);
  });

  it('keeps M5 private access disabled in production unless explicitly enabled', () => {
    expect(getGatewayConfig(productionEnvironment()).M5_PRIVATE_ACCESS_ENABLED).toBe(false);
    expect(
      getGatewayConfig(productionEnvironment({ M5_PRIVATE_ACCESS_ENABLED: 'true' }))
        .M5_PRIVATE_ACCESS_ENABLED,
    ).toBe(true);
  });

  it('keeps restricted eligibility sales disabled until explicitly approved', () => {
    expect(getGatewayConfig(productionEnvironment()).M5_ELIGIBILITY_RULES_ENABLED).toBe(false);
    expect(
      getGatewayConfig(productionEnvironment({ M5_ELIGIBILITY_RULES_ENABLED: 'true' }))
        .M5_ELIGIBILITY_RULES_ENABLED,
    ).toBe(true);
  });

  it('keeps ticket add-on sales disabled until accounting and tax treatment is approved', () => {
    expect(getGatewayConfig(productionEnvironment()).M5_TICKET_ADDONS_ENABLED).toBe(false);
    expect(
      getGatewayConfig(productionEnvironment({ M5_TICKET_ADDONS_ENABLED: 'true' }))
        .M5_TICKET_ADDONS_ENABLED,
    ).toBe(true);
  });

  it('keeps ticket transfers disabled until offline issuance is disabled and drained', () => {
    const defaults = getGatewayConfig(productionEnvironment());
    expect(defaults.M5_TICKET_TRANSFERS_ENABLED).toBe(false);
    expect(defaults.M5_OFFLINE_TICKET_MANIFESTS_ENABLED).toBe(true);
    expect(defaults.M5_OFFLINE_MANIFEST_DRAIN_COMPLETE).toBe(false);

    const drain = getGatewayConfig(
      productionEnvironment({
        M5_TICKET_TRANSFERS_ENABLED: 'true',
        M5_OFFLINE_TICKET_MANIFESTS_ENABLED: 'false',
        M5_OFFLINE_MANIFEST_DRAIN_COMPLETE: 'true',
      }),
    );
    expect(drain.M5_TICKET_TRANSFERS_ENABLED).toBe(true);
    expect(drain.M5_OFFLINE_TICKET_MANIFESTS_ENABLED).toBe(false);
    expect(drain.M5_OFFLINE_MANIFEST_DRAIN_COMPLETE).toBe(true);
  });

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

describe('strict Resend test-recipient configuration', () => {
  it('enables a single allowlisted recipient even under production-shaped configuration', () => {
    const config = getGatewayConfig(
      productionEnvironment({
        RESEND_ENFORCE_TEST_RECIPIENT_ALLOWLIST: 'true',
        RESEND_NON_PROD_TEST_RECIPIENT: 'AayushDivase2020333@gmail.com',
      }),
    );
    expect(config.RESEND_ENFORCE_TEST_RECIPIENT_ALLOWLIST).toBe(true);
    expect(config.RESEND_NON_PROD_TEST_RECIPIENT).toBe('aayushdivase2020333@gmail.com');
  });

  it('requires the exact allowlist recipient when strict enforcement is enabled', () => {
    expect(() =>
      getGatewayConfig(productionEnvironment({ RESEND_ENFORCE_TEST_RECIPIENT_ALLOWLIST: 'true' })),
    ).toThrow(/strict Resend test-recipient guard requires an exact allowlist recipient/i);
  });

  it('rejects a broader or alternate address for the strict founder guard', () => {
    expect(() =>
      getGatewayConfig(
        productionEnvironment({
          RESEND_ENFORCE_TEST_RECIPIENT_ALLOWLIST: 'true',
          RESEND_NON_PROD_TEST_RECIPIENT: 'other@example.test',
        }),
      ),
    ).toThrow(/allows only the approved founder address/i);
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

it('accepts only an HTTP(S) Guest deployment origin for invitation links', () => {
  expect(
    getGatewayConfig({ GUEST_PORTAL_URL: 'https://guest-staging.example.test' }).GUEST_PORTAL_URL,
  ).toBe('https://guest-staging.example.test');
  expect(() =>
    getGatewayConfig({ GUEST_PORTAL_URL: 'https://guest-staging.example.test/invite' }),
  ).toThrow();
  expect(() => getGatewayConfig({ GUEST_PORTAL_URL: 'javascript:alert(1)' })).toThrow();
});

describe('M4 non-production configuration safety', () => {
  const provider = {
    RAZORPAY_KEY_ID: 'rzp_test_syntheticConfig123',
    RAZORPAY_KEY_SECRET: 'synthetic-test-key-secret',
    RAZORPAY_WEBHOOK_SECRET: 'synthetic-test-webhook-secret',
  };
  it.each(['development', 'test', 'production'])(
    'defaults workers and payouts OFF in %s',
    (NODE_ENV) => {
      const config = getGatewayConfig(
        NODE_ENV === 'production' ? productionEnvironment() : { NODE_ENV },
      );
      expect(config.BACKGROUND_WORKERS_ENABLED).toBe(false);
      expect(config.PAYOUTS_ENABLED).toBe(false);
    },
  );
  it('permits intentional explicit worker configuration without changing M5 defaults', () => {
    expect(
      getGatewayConfig({ BACKGROUND_WORKERS_ENABLED: 'true' }).BACKGROUND_WORKERS_ENABLED,
    ).toBe(true);
  });
  it.each(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const)(
    'rejects incomplete provider credentials missing %s',
    (missing) => {
      expect(() => getGatewayConfig({ ...provider, [missing]: undefined })).toThrow(/RAZORPAY/);
    },
  );
  it.each(['arbitrary-nonempty', 'rzp_live_synthetic123', 'rzp_test_', 'rzp_test_bad/fragment'])(
    'rejects unsupported or Live Mode key IDs: %s',
    (RAZORPAY_KEY_ID) => {
      expect(() => getGatewayConfig({ ...provider, RAZORPAY_KEY_ID })).toThrow(
        /Razorpay Test Mode/,
      );
    },
  );
  it('accepts a complete synthetic Test Mode tuple without exposing secrets in errors', () => {
    expect(getGatewayConfig(provider).RAZORPAY_KEY_ID).toBe(provider.RAZORPAY_KEY_ID);
    try {
      getGatewayConfig({ ...provider, RAZORPAY_KEY_ID: 'rzp_live_synthetic123' });
    } catch (error) {
      expect(String(error)).not.toContain(provider.RAZORPAY_KEY_SECRET);
      expect(String(error)).not.toContain(provider.RAZORPAY_WEBHOOK_SECRET);
    }
  });
  it('requires the approved real Firestore project without constraining memory units', () => {
    expect(() =>
      getGatewayConfig(productionEnvironment({ FIRESTORE_PROJECT_ID: 'unapproved-project' })),
    ).toThrow(/c1rcle-v2/);
    expect(
      getGatewayConfig({ STORAGE_DRIVER: 'memory', FIRESTORE_PROJECT_ID: 'unit-project' })
        .FIRESTORE_PROJECT_ID,
    ).toBe('unit-project');
  });
  it.each(['127.0.0.1:8089', 'localhost:8089', '[::1]:8089'])(
    'allows explicit loopback Emulator synthetic projects: %s',
    (FIRESTORE_EMULATOR_HOST) => {
      expect(
        getGatewayConfig({
          STORAGE_DRIVER: 'firestore',
          FIRESTORE_PROJECT_ID: 'demo-m4-synthetic',
          FIRESTORE_EMULATOR_HOST,
          FIREBASE_CLIENT_EMAIL: 'synthetic@example.test',
          FIREBASE_PRIVATE_KEY: 'synthetic-key',
        }).FIRESTORE_PROJECT_ID,
      ).toBe('demo-m4-synthetic');
    },
  );
  it.each([
    'example.test:8089',
    '127.0.0.1.example.test:8089',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:8089/remote',
  ])('rejects non-loopback or malformed Emulator endpoints: %s', (FIRESTORE_EMULATOR_HOST) => {
    expect(() =>
      getGatewayConfig({
        STORAGE_DRIVER: 'firestore',
        FIRESTORE_PROJECT_ID: 'demo-m4-synthetic',
        FIRESTORE_EMULATOR_HOST,
        FIREBASE_CLIENT_EMAIL: 'synthetic@example.test',
        FIREBASE_PRIVATE_KEY: 'synthetic-key',
      }),
    ).toThrow(/FIRESTORE_EMULATOR_HOST/);
  });
});

describe('hosted agreement environment parsing', () => {
  const artifact = {
    version: 'staging-v1',
    status: 'staging_only',
    text: 'C1RCLE STAGING PROMOTER AGREEMENT — FOR TESTING ONLY',
    textSha256: 'a'.repeat(64),
  };
  it('keeps hosted environment and configured artifact explicit even with production Node mode', () => {
    const config = getGatewayConfig(
      productionEnvironment({
        DEPLOYMENT_ENVIRONMENT: 'staging',
        RENDER_SERVICE_ID: 'srv-daar7op42hec73ecesdg',
        PUBLIC_API_URL: 'https://circle-v2-backend.onrender.com',
        BETTER_AUTH_URL: 'https://circle-v2-backend.onrender.com',
        PROMOTER_AGREEMENT_ARTIFACT: JSON.stringify(artifact),
      }),
    );
    expect(config.NODE_ENV).toBe('production');
    expect(config.DEPLOYMENT_ENVIRONMENT).toBe('staging');
    expect(config.PROMOTER_AGREEMENT_ARTIFACT).toEqual(artifact);
    expect(getGatewayConfig(productionEnvironment()).PROMOTER_AGREEMENT_ARTIFACT).toBeUndefined();
  });
  it('rejects a staging flag without the independently identified staging service', () => {
    expect(() =>
      getGatewayConfig(
        productionEnvironment({
          DEPLOYMENT_ENVIRONMENT: 'staging',
          PROMOTER_AGREEMENT_ARTIFACT: JSON.stringify(artifact),
        }),
      ),
    ).toThrow();
  });
  it('rejects fixture status, malformed documents, and undeclared artifact properties', () => {
    for (const value of [
      '{',
      JSON.stringify({ ...artifact, status: 'test_fixture' }),
      JSON.stringify({ ...artifact, extra: 'forged' }),
    ])
      expect(() =>
        getGatewayConfig(productionEnvironment({ PROMOTER_AGREEMENT_ARTIFACT: value })),
      ).toThrow();
  });
});
