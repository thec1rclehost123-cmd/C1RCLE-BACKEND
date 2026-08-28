import { beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';
import type { Entitlement } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import phase5ScannerRoutes from './scanner-routes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Phase 5 door/scanner HTTP wiring ───────────────────────────────────────
 * One 2xx happy-path + one 4xx per real route, using `buildPartnerTestServer`
 * the same way `partner/events.test.ts` does. Seed data goes in directly via
 * `services.repos()`/`services.scanner`, matching `onboarding.test.ts`'s
 * pattern (`repos()` is documented as "seed/test wiring only").
 *
 * KNOWN PRE-EXISTING GAP (not introduced by this file, not fixed by it):
 * `services.actor` (`buildActorContext` in
 * packages/core/src/infrastructure/utils.ts) throws whenever `request.actor`
 * is unset, with no fallback for the memory/test storage driver, and
 * `buildPartnerTestServer` never populates `request.actor` (no `auth.ts`
 * plugin is registered there). Reproduces identically on the reference
 * template: `partner/events.test.ts`'s "creates an event" (expects 201, gets
 * 401) and "GET one returns 404" (expects 404, gets 401) already fail this
 * exact way, on routes this file never touched — proving it's cross-cutting,
 * not specific to Phase 5 scanner routes. See the wiring report for the full
 * writeup; that gap is left unfixed (it's outside this slice, and a real fix
 * needs storage-driver-aware plumbing this function doesn't have).
 *
 * The `server.addHook('onRequest', ...)` below is a TEST-LOCAL workaround —
 * it populates `request.actor` only on this file's own server instance, so
 * these tests can actually exercise the route/service logic instead of
 * universally hitting that gap. It does not touch `partner-test-server.ts`
 * or any shared plugin, and it does not fix the production bug.
 */

const services = createV2Services();

const ORG_ID = 'org_1';
const EVENT_ID = 'evt_1';
const SEED_ACTOR: ActorContext = {
  userId: 'staff_1',
  organizationId: ORG_ID,
  role: 'owner',
  capabilities: [],
};

const HEADERS = { 'x-organization-id': ORG_ID };

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.eventCodes as unknown as { codes: Map<string, unknown>; byCode: Map<string, string> }).codes.clear();
  (repos.eventCodes as unknown as { codes: Map<string, unknown>; byCode: Map<string, string> }).byCode.clear();
  (
    repos.scannerSessions as unknown as {
      sessions: Map<string, unknown>;
      byTokenHash: Map<string, string>;
    }
  ).sessions.clear();
  (
    repos.scannerSessions as unknown as {
      sessions: Map<string, unknown>;
      byTokenHash: Map<string, string>;
    }
  ).byTokenHash.clear();
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();

  server = await buildPartnerTestServer({ routes: [phase5ScannerRoutes] });
  // Test-local workaround for the pre-existing actor-context gap described
  // above — real request.actor population belongs in a shared auth plugin,
  // not here.
  server.addHook('onRequest', async (request) => {
    // `request.actor`'s Fastify augmentation (plugins/auth.ts) carries an
    // extra `platformRole` field ActorContext doesn't have.
    request.actor = { ...SEED_ACTOR, platformRole: 'staff' };
  });
});

async function seedEventCode(overrides: Partial<Parameters<typeof services.scanner.createEventCode>[0]> = {}) {
  return services.scanner.createEventCode(
    {
      eventId: EVENT_ID,
      organizationId: ORG_ID,
      venueId: null,
      type: 'full',
      gate: null,
      createdBy: SEED_ACTOR.userId,
      createdByName: 'Staff One',
      expiresAt: null,
      ...overrides,
    },
    SEED_ACTOR,
  );
}

async function seedEntitlement(id: string): Promise<Entitlement> {
  const now = new Date().toISOString();
  const entitlement: Entitlement = {
    id,
    orderId: 'ord_1',
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    tierId: 'tier_1',
    tierName: 'General',
    userId: null,
    holderName: 'Test Guest',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await services.repos().entitlements.save(entitlement);
  return entitlement;
}

describe('POST /door/sessions', () => {
  it('creates a scanner session from a valid event code (2xx)', async () => {
    const eventCode = await seedEventCode();
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: EVENT_ID,
        code: eventCode.code,
        deviceId: 'device_1',
        deviceName: 'Gate iPad 1',
        sessionType: 'staff',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      eventId: EVENT_ID,
      status: 'active',
      permissions: { canScan: true, canDoorEntry: true, canWalkIn: true, canCharge: false },
    });
    expect(typeof body.sessionToken).toBe('string');
    expect(body.sessionToken.length).toBeGreaterThan(0);
  });

  it('404s on an unknown event code', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: EVENT_ID,
        code: 'C1R-NOPE99',
        deviceId: 'device_1',
        deviceName: 'Gate iPad 1',
        sessionType: 'staff',
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('GET /door/sessions/:sessionId', () => {
  it('404s for an unknown session id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/door/sessions/no-such-session',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('POST /door/check-ins', () => {
  it('404s for an unknown event', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/check-ins',
      headers: HEADERS,
      payload: {
        eventId: 'no-such-event',
        qrPayload: 'ENT-does-not-matter',
        scannedBy: { uid: 'staff_1', name: 'Staff One', role: 'staff' },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('POST /door/check-ins/verify', () => {
  it('404s for an unknown event (read-only preview)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/check-ins/verify',
      headers: HEADERS,
      payload: {
        eventId: 'no-such-event',
        qrPayload: 'ENT-does-not-matter',
        scannedBy: { uid: 'staff_1', name: 'Staff One', role: 'staff' },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('GET /door/check-ins/:checkInId', () => {
  it('404s for an unknown check-in id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/door/check-ins/no-such-scan',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('POST /door/lookup', () => {
  it('404s for an unknown event', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/lookup',
      headers: HEADERS,
      payload: {
        eventId: 'no-such-event',
        qrPayload: 'ENT-does-not-matter',
        scannedBy: { uid: 'staff_1', name: 'Staff One', role: 'staff' },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('POST /door/override (honest stub)', () => {
  it('returns 501 — no denied->consumed FSM transition or service method exists', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/override',
      headers: HEADERS,
      payload: { checkInId: 'scan_1', reason: 'manager override at the door' },
    });
    expect(response.statusCode).toBe(501);
  });
});

describe('GET /door/offline-manifest (honest stub)', () => {
  it('returns 501 — no manifest-signing service method or verification path exists', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/door/offline-manifest?eventId=${EVENT_ID}&scannerSessionId=sess_1&expiresAt=${encodeURIComponent(new Date().toISOString())}`,
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(501);
  });
});

describe('POST /door/offline-sync', () => {
  it('404s for an unknown scanner session', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/offline-sync',
      headers: HEADERS,
      payload: {
        scannerSessionId: 'no-such-session',
        scans: [{ payload: 'ENT-does-not-matter', scannedAt: new Date().toISOString(), deviceId: 'device_1' }],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('GET /tickets/:ticketId/qr', () => {
  it('generates the current rotating magic-ticket QR (2xx)', async () => {
    await seedEntitlement('ENT-test-1');
    const response = await server.inject({
      method: 'GET',
      url: '/tickets/ENT-test-1/qr',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.qrPayload).toBe('string');
    expect(body.qrPayload.split(':')).toHaveLength(3);
    expect(body.refreshIntervalSec).toBe(30);
    expect(typeof body.expiresAt).toBe('string');
  });

  it('404s for an unknown ticket', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/tickets/no-such-ticket/qr',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});
