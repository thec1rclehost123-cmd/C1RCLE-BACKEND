import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { getGatewayConfig } from '../config/index.js';

import { payoutsEnabled, requirePayoutsEnabled } from './payouts-gate.js';

const devEnv = {
  NODE_ENV: 'test',
  STORAGE_DRIVER: 'memory',
  TRUSTED_PROXY_CIDRS: '127.0.0.1',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
};

describe('payoutsEnabled', () => {
  it('is ON by default outside production, so development and tests keep working', () => {
    expect(payoutsEnabled({ NODE_ENV: 'development', PAYOUTS_ENABLED: undefined })).toBe(true);
    expect(payoutsEnabled({ NODE_ENV: 'test', PAYOUTS_ENABLED: undefined })).toBe(true);
  });

  it('is OFF by default in production: an unapproved deploy cannot move payout state', () => {
    expect(payoutsEnabled({ NODE_ENV: 'production', PAYOUTS_ENABLED: undefined })).toBe(false);
  });

  it('lets an explicit setting win in either direction', () => {
    expect(payoutsEnabled({ NODE_ENV: 'production', PAYOUTS_ENABLED: true })).toBe(true);
    expect(payoutsEnabled({ NODE_ENV: 'development', PAYOUTS_ENABLED: false })).toBe(false);
  });
});

describe('PAYOUTS_ENABLED configuration', () => {
  it('parses true and false, leaves unset as undefined, and rejects anything else', () => {
    expect(getGatewayConfig({ ...devEnv, PAYOUTS_ENABLED: 'true' }).PAYOUTS_ENABLED).toBe(true);
    expect(getGatewayConfig({ ...devEnv, PAYOUTS_ENABLED: 'false' }).PAYOUTS_ENABLED).toBe(false);
    expect(getGatewayConfig(devEnv).PAYOUTS_ENABLED).toBeUndefined();
    // Not "yes"/"1": a typo must fail loudly rather than silently pick a side.
    expect(() => getGatewayConfig({ ...devEnv, PAYOUTS_ENABLED: 'yes' })).toThrow(
      /PAYOUTS_ENABLED/,
    );
  });
});

describe('requirePayoutsEnabled', () => {
  async function app(enabled: boolean) {
    const server = Fastify();
    let handlerRuns = 0;
    const config = { ...getGatewayConfig(devEnv), PAYOUTS_ENABLED: enabled };
    server.post('/x', { preHandler: [requirePayoutsEnabled(() => config)] }, async () => {
      handlerRuns += 1;
      return { ok: true };
    });
    return { server, runs: () => handlerRuns };
  }

  it('answers 503 in the standard error envelope and never runs the handler when off', async () => {
    const { server, runs } = await app(false);
    const response = await server.inject({ method: 'POST', url: '/x' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 503,
      message: 'Payouts are not enabled on this deployment.',
    });
    expect(runs()).toBe(0);
    await server.close();
  });

  it('lets the request through when on', async () => {
    const { server, runs } = await app(true);
    const response = await server.inject({ method: 'POST', url: '/x' });

    expect(response.statusCode).toBe(200);
    expect(runs()).toBe(1);
    await server.close();
  });
});
