import { createLogger } from '@c1rcle/core';
import { UnauthorizedError } from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { getGatewayConfig } from '../config/index.js';

import { actorFromRequest, createV2Services } from './v2-services.js';

function silentLogger() {
  return createLogger({
    info: () => {},
    warn: () => {},
    error: () => {},
  });
}

function fakeRequest(organizationId = 'org_1', userId = 'usr_1') {
  return {
    user: { uid: userId },
    authContext: {
      activeMembership: {
        organizationId,
        role: 'owner',
        capabilities: ['host', 'venue', 'promoter'],
      },
    },
    headers: { 'x-organization-id': organizationId },
  } as unknown as Parameters<ReturnType<typeof createV2Services>['actor']>[0];
}

describe('V2 services wiring (B09) — EventPublished → audit trail end-to-end', () => {
  it('keeps the memory actor fallback out of production', () => {
    const productionConfig = getGatewayConfig({
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'firestore',
      FIREBASE_CLIENT_EMAIL: 'firebase@example.test',
      FIREBASE_PRIVATE_KEY: 'private-key',
      BETTER_AUTH_SECRET: 'a'.repeat(64),
      PUBLIC_API_URL: 'https://api.example.test',
      BETTER_AUTH_URL: 'https://api.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
      TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    });

    expect(() =>
      actorFromRequest(productionConfig, {
        headers: { 'x-user-id': 'attacker', 'x-organization-id': 'org_1' },
      } as never),
    ).toThrow(UnauthorizedError);
  });

  it('one publish through the real service bundle yields exactly one audit record', async () => {
    const services = createV2Services(silentLogger());
    const actor = services.actor(fakeRequest());

    const event = await services.events.create(actor, {
      title: 'Headliner Night',
      venueId: 'ven_1',
      startAt: '2026-08-01T18:00:00.000Z',
    });
    await services.events.review(actor, event.id);
    await services.events.transitionTo(actor, event.id, 'scheduled');
    await services.events.publish(actor, event.id);

    const audit = services.audits.all();
    const published = audit.filter((record) => record.eventType === 'event.published');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      organizationId: 'org_1',
      actorId: 'usr_1',
      aggregateId: event.id,
      snapshot: { title: 'Headliner Night' },
    });
    // Created rows for consumer-less types are processed, never leaked as failed.
    expect(audit.some((record) => record.eventType === 'event.created')).toBe(false);
  });

  it('cancelling after publish does not disturb existing audit records', async () => {
    const services = createV2Services(silentLogger());
    const actor = services.actor(fakeRequest());

    const event = await services.events.create(actor, {
      title: 'Rain Check',
      venueId: 'ven_1',
      startAt: '2026-08-01T18:00:00.000Z',
    });
    await services.events.review(actor, event.id);
    await services.events.transitionTo(actor, event.id, 'scheduled');
    await services.events.publish(actor, event.id);
    await services.events.cancel(actor, event.id, 'weather');

    // Consumers are wired for published/updated only; a publish stays exactly
    // one record — cancel emission never corrupts the trail.
    const types = services.audits.all().map((record) => record.eventType);
    expect(types.filter((type) => type === 'event.published')).toHaveLength(1);
    expect(types.filter((type) => type === 'event.cancelled')).toHaveLength(0);
  });
});
