import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { getGatewayConfig } from './config/index.js';

function config(overrides: Record<string, string> = {}) {
  return getGatewayConfig({
    NODE_ENV: 'test',
    STORAGE_DRIVER: 'memory',
    TRUSTED_PROXY_CIDRS: '127.0.0.1',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

async function readiness(overrides: Record<string, string>) {
  const app = await buildApp({ config: config(overrides) });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v2/internal/readiness' });
    return response.json<{ ok: boolean; checks: Record<string, string> }>();
  } finally {
    await app.close();
  }
}

describe('payment-provider readiness', () => {
  it('stays out of readiness when no Razorpay variable is set (payments intentionally off)', async () => {
    const body = await readiness({});
    expect(body.checks).not.toHaveProperty('paymentProvider');
  });

  it('flags a partial Razorpay configuration as down', async () => {
    // Keys without the webhook secret: payments look configured but cannot
    // verify webhooks. This must be visible, not silently skipped.
    const body = await readiness({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret' });
    expect(body.checks.paymentProvider).toBe('down');
  });

  it('reports up when all three Razorpay variables are set', async () => {
    const body = await readiness({
      RAZORPAY_KEY_ID: 'rzp_test_x',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec',
    });
    expect(body.checks.paymentProvider).toBe('up');
  });
});
