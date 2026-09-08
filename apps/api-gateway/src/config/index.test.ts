import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── Config fail-closed guards ────────────────────────────────────────────────
 * `getGatewayConfig` caches after the first successful parse, so every case
 * re-imports the module to get a fresh cache. A guard that is never exercised
 * is a guard that quietly stops working.
 */

const BASE = {
  NODE_ENV: 'production',
  STORAGE_DRIVER: 'memory',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'https://circle-v2-backend.onrender.com',
  EMAIL_OTP_SECRET: 'b'.repeat(32),
} satisfies NodeJS.ProcessEnv;

async function loadConfig() {
  vi.resetModules();
  return import('./index.js');
}

describe('getGatewayConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('accepts a well-formed production environment', async () => {
    const { getGatewayConfig } = await loadConfig();
    const config = getGatewayConfig({ ...BASE });
    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(8080);
  });

  it('rejects the development signing secret in production', async () => {
    const { getGatewayConfig, GatewayConfigError } = await loadConfig();
    // Better Auth signs sessions with this value and the default is committed
    // to a public repository, so shipping it means anyone can mint a session.
    expect(() => getGatewayConfig({ ...BASE, BETTER_AUTH_SECRET: 'dev-only-change-me' })).toThrow(
      GatewayConfigError,
    );
  });

  it('rejects a short signing secret in production', async () => {
    const { getGatewayConfig } = await loadConfig();
    expect(() => getGatewayConfig({ ...BASE, BETTER_AUTH_SECRET: 'too-short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('rejects an http:// auth URL in production', async () => {
    const { getGatewayConfig } = await loadConfig();
    // Session cookies issued against an http:// origin are not marked Secure.
    expect(() => getGatewayConfig({ ...BASE, BETTER_AUTH_URL: 'http://example.com' })).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it('rejects a missing email-OTP secret in production', async () => {
    const { getGatewayConfig } = await loadConfig();
    const { EMAIL_OTP_SECRET: _omit, ...withoutSecret } = BASE;
    expect(() => getGatewayConfig(withoutSecret)).toThrow(/EMAIL_OTP_SECRET/);
  });

  it('allows the development defaults outside production', async () => {
    const { getGatewayConfig } = await loadConfig();
    const config = getGatewayConfig({ NODE_ENV: 'development' });
    expect(config.BETTER_AUTH_SECRET).toBe('dev-only-change-me');
    expect(config.BETTER_AUTH_URL).toBe('http://localhost:8080');
  });

  it('refuses STORAGE_DRIVER=firestore without credentials', async () => {
    const { getGatewayConfig } = await loadConfig();
    // Must fail the boot rather than degrade silently to the in-memory store.
    expect(() => getGatewayConfig({ ...BASE, STORAGE_DRIVER: 'firestore' })).toThrow(
      /FIREBASE_CLIENT_EMAIL/,
    );
  });

  it('accepts STORAGE_DRIVER=firestore with credentials', async () => {
    const { getGatewayConfig } = await loadConfig();
    const config = getGatewayConfig({
      ...BASE,
      STORAGE_DRIVER: 'firestore',
      FIREBASE_CLIENT_EMAIL: 'svc@example.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
    });
    expect(config.STORAGE_DRIVER).toBe('firestore');
  });

  it('caches after the first successful parse', async () => {
    const { getGatewayConfig } = await loadConfig();
    const first = getGatewayConfig({ ...BASE, LOG_LEVEL: 'debug' });
    const second = getGatewayConfig({ ...BASE, LOG_LEVEL: 'error' });
    expect(second).toBe(first);
    expect(second.LOG_LEVEL).toBe('debug');
  });
});
