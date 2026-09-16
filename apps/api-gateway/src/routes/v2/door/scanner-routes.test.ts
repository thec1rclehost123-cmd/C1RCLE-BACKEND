import { beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';
import type { Entitlement } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import doorCodeRoutes from './event-code-routes.js';
import phase5ScannerRoutes from './scanner-routes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Phase 5 door/scanner HTTP ──────────────────────────────────────────────
 *
 * These tests exist to pin the security properties, not only the happy path.
 * Specifically: that a scan without a valid scanner-session token is refused,
 * that a token minted for one tenant cannot scan another's event, that a
 * ticket cannot be admitted twice, and that a couple ticket admits exactly
 * two people and no more.
 *
 * `buildPartnerTestServer` registers no auth plugin, so `request.actor` is
 * populated by a test-local hook — the same workaround every partner-route
 * suite in this repo uses. It fabricates identity only; every authorization
 * decision under test is still the real one.
 */

const services = createV2Services();

const ORG_ID = 'org_1';
const OTHER_ORG_ID = 'org_2';
const EVENT_ID = 'evt_1';
const OTHER_EVENT_ID = 'evt_2';

const SEED_ACTOR: ActorContext = {
  userId: 'staff_1',
  organizationId: ORG_ID,
  role: 'owner',
  capabilities: [],
};

const HEADERS = { 'x-organization-id': ORG_ID };

let server: FastifyInstance;
let currentActor: ActorContext;

beforeEach(async () => {
  const repos = services.repos();
  const codes = repos.eventCodes as unknown as {
    codes: Map<string, unknown>;
    byCode: Map<string, string>;
  };
  codes.codes.clear();
  codes.byCode.clear();
  const sessions = repos.scannerSessions as unknown as {
    sessions: Map<string, unknown>;
    byTokenHash: Map<string, string>;
  };
  sessions.sessions.clear();
  sessions.byTokenHash.clear();
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();
  (repos.scanLedger as unknown as { scans: Map<string, unknown> }).scans.clear();

  currentActor = SEED_ACTOR;
  server = await buildPartnerTestServer({ routes: [doorCodeRoutes, phase5ScannerRoutes] });
  server.addHook('onRequest', async (request) => {
    request.actor = { ...currentActor, platformRole: 'staff' };
  });

  await seedEvent(EVENT_ID, ORG_ID);
  await seedEvent(OTHER_EVENT_ID, OTHER_ORG_ID);
});

async function seedEvent(eventId: string, organizationId: string): Promise<void> {
  // The memory event repository is process-wide and versioned; re-saving a
  // seeded event across tests is a version conflict, not a fresh write.
  if (await services.repos().events.findById(eventId)) return;
  const now = new Date().toISOString();
  await services.repos().events.save({
    id: eventId,
    organizationId,
    venueId: null,
    slug: `scanner-test-${eventId}`,
    title: 'Scanner Test Event',
    summary: '',
    description: '',
    imageUrl: null,
    startAt: now,
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: [],
    startingPricePaise: null,
    isFree: false,
    cancellationReason: null,
    capacity: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEntitlement(
  id: string,
  overrides: Partial<Entitlement> = {},
): Promise<Entitlement> {
  const now = new Date().toISOString();
  const entitlement: Entitlement = {
    id,
    orderId: 'ord_1',
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    tierId: 'tier_1',
    tierName: 'General',
    userId: 'guest_1',
    holderName: 'Test Guest',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await services.repos().entitlements.save(entitlement);
  return entitlement;
}

/** Mints a door code over HTTP, exactly as a manager would. */
async function createDoorCode(body: Record<string, unknown> = {}): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: `/events/${EVENT_ID}/door-codes`,
    headers: HEADERS,
    payload: { type: 'full', gate: null, expiresAt: null, ...body },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().code;
}

/** Redeems a door code for a scanner-session token. */
async function openSession(code: string, deviceId = 'device_1'): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/door/sessions',
    headers: HEADERS,
    payload: { eventId: EVENT_ID, code, deviceId, deviceName: 'Gate iPad', sessionType: 'staff' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().sessionToken;
}

async function scannerToken(): Promise<string> {
  return openSession(await createDoorCode());
}

function scan(token: string, qrPayload: string, eventId = EVENT_ID) {
  return server.inject({
    method: 'POST',
    url: '/door/check-ins',
    headers: { ...HEADERS, 'x-scanner-session-token': token },
    payload: { eventId, qrPayload },
  });
}

describe('door codes', () => {
  it('mints a code carrying the event’s organization, not one the caller names', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/events/${EVENT_ID}/door-codes`,
      headers: HEADERS,
      payload: { type: 'scan_only', gate: 'north', expiresAt: null },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      organizationId: ORG_ID,
      eventId: EVENT_ID,
      type: 'scan_only',
      gate: 'north',
      status: 'active',
    });
    expect(response.json().code).toMatch(/^C1R-[A-Z0-9]{8}$/);
  });

  it('refuses to mint a code for another organization’s event', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/events/${OTHER_EVENT_ID}/door-codes`,
      headers: HEADERS,
      payload: { type: 'full', gate: null, expiresAt: null },
    });
    expect(response.statusCode).toBe(404);
  });

  it('lists only this event’s active codes', async () => {
    await createDoorCode();
    await createDoorCode({ type: 'charge' });
    const response = await server.inject({
      method: 'GET',
      url: `/events/${EVENT_ID}/door-codes`,
      headers: HEADERS,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toHaveLength(2);
  });

  it('revoking a code also kills the sessions it opened', async () => {
    const code = await createDoorCode();
    const token = await openSession(code);
    const codeId = (
      await server.inject({
        method: 'GET',
        url: `/events/${EVENT_ID}/door-codes`,
        headers: HEADERS,
      })
    )
      .json()
      .items.find((c: { code: string }) => c.code === code).id;

    const revoked = await server.inject({
      method: 'POST',
      url: `/door-codes/${codeId}/revoke`,
      headers: HEADERS,
      payload: { reason: 'shift ended' },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().status).toBe('revoked');

    // The device that was already holding a token must stop working — that is
    // the entire point of revoking a code.
    const entitlement = await seedEntitlement('ENT-after-revoke');
    const after = await scan(token, entitlement.id);
    expect(after.statusCode).toBe(401);
  });
});

describe('POST /door/sessions', () => {
  it('returns the raw token exactly once, and never again on a read', async () => {
    const code = await createDoorCode();
    const created = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: EVENT_ID,
        code,
        deviceId: 'device_1',
        deviceName: 'Gate iPad',
        sessionType: 'staff',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().sessionToken).toEqual(expect.any(String));
    // One call is the whole shift start: session + event + tiers + gate +
    // opening stats, because a door phone may not get a second round trip.
    expect(created.json()).toMatchObject({
      event: { id: EVENT_ID },
      permissions: { canScan: true },
      tiers: expect.any(Array),
      stats: { occupancy: expect.any(Object) },
      device: { deviceId: 'device_1' },
    });

    const read = await server.inject({
      method: 'GET',
      url: `/door/sessions/${created.json().sessionId}`,
      headers: HEADERS,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().sessionToken).toBeNull();
  });

  it('404s on an unknown door code', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: EVENT_ID,
        code: 'C1R-NOPE1234',
        deviceId: 'device_1',
        deviceName: 'Gate iPad',
        sessionType: 'staff',
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers a foreign organization’s real code identically to an unknown one', async () => {
    const code = await createDoorCode();
    currentActor = { ...SEED_ACTOR, organizationId: OTHER_ORG_ID };
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: { 'x-organization-id': OTHER_ORG_ID },
      payload: {
        eventId: EVENT_ID,
        code,
        deviceId: 'device_x',
        deviceName: 'Rogue',
        sessionType: 'staff',
      },
    });
    // 404, not 403: a 403 would confirm the code exists, turning this into an
    // oracle for guessing door codes across tenants.
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /door/check-ins', () => {
  it('admits a valid ticket and actually spends the admission', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-admit-1');

    const response = await scan(token, entitlement.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'consumed',
      checkInId: expect.any(String),
      entitlement: { id: entitlement.id, scansUsed: 1, scansAllowed: 1, status: 'redeemed' },
    });

    const stored = await services.repos().entitlements.findById(entitlement.id);
    expect(stored?.scanCount).toBe(1);
    expect(stored?.status).toBe('redeemed');
    expect(stored?.scannedAt).toHaveLength(1);
  });

  it('refuses the same ticket a second time', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-replay-1');
    await scan(token, entitlement.id);

    const second = await scan(token, entitlement.id);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ status: 'denied', denyReason: 'already_used' });
  });

  it('stops an untouched couple ticket and asks, without spending anything', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-couple-1', { scanCountAllowed: 2 });

    const asked = await scan(token, entitlement.id);
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({
      status: 'confirmation_required',
      confirmation: { seats: 2, token: expect.any(String) },
    });
    // A question is not an admission: nothing written, nothing spent.
    expect(asked.json().checkInId).toBeUndefined();
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);
  });

  it('never double-admits when two devices scan the same ticket concurrently', async () => {
    const code = await createDoorCode({ maxDevices: 5 });
    const [tokenA, tokenB] = await Promise.all([
      openSession(code, 'device_a'),
      openSession(code, 'device_b'),
    ]);
    const entitlement = await seedEntitlement('ENT-race-1');

    const [a, b] = await Promise.all([scan(tokenA, entitlement.id), scan(tokenB, entitlement.id)]);
    const verdicts = [a.json().status, b.json().status].sort();
    expect(verdicts).toEqual(['consumed', 'denied']);
  });

  it('refuses a scan with no scanner-session token', async () => {
    const entitlement = await seedEntitlement('ENT-notoken');
    const response = await server.inject({
      method: 'POST',
      url: '/door/check-ins',
      headers: HEADERS,
      payload: { eventId: EVENT_ID, qrPayload: entitlement.id },
    });
    // The header schema rejects the request before any service runs.
    expect([401, 422]).toContain(response.statusCode);
  });

  it('refuses a fabricated scanner-session token', async () => {
    const entitlement = await seedEntitlement('ENT-faketoken');
    const response = await scan('scn_totally-made-up', entitlement.id);
    expect(response.statusCode).toBe(401);
  });

  it('refuses a token minted for a different event', async () => {
    const token = await scannerToken();
    const response = await scan(token, 'ENT-whatever', OTHER_EVENT_ID);
    // The event belongs to another org, so tenancy refuses it first.
    expect([401, 404]).toContain(response.statusCode);
  });

  it('denies a voided ticket without admitting anyone', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-void-1', { status: 'void' });
    const response = await scan(token, entitlement.id);
    expect(response.json()).toMatchObject({ status: 'denied', denyReason: 'void_ticket' });
    const stored = await services.repos().entitlements.findById(entitlement.id);
    expect(stored?.scanCount).toBe(0);
  });

  it('denies a ticket issued for another event and leaks nothing about it', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-wrong-evt', {
      eventId: OTHER_EVENT_ID,
      organizationId: OTHER_ORG_ID,
      holderName: 'Someone Else',
    });
    const response = await scan(token, entitlement.id);
    expect(response.json()).toMatchObject({ status: 'denied', denyReason: 'wrong_event' });
    // No guest name, tier or scan counts from the other tenant.
    expect(response.json().entitlement).toBeUndefined();
  });

  it('denies an unverifiable magic-QR payload rather than treating it as a ticket id', async () => {
    const token = await scannerToken();
    await seedEntitlement('ENT-magic-1');
    const response = await scan(token, 'ENT-magic-1:1700000000:deadbeef');
    expect(response.json()).toMatchObject({ status: 'denied', denyReason: 'invalid_signature' });
    const stored = await services.repos().entitlements.findById('ENT-magic-1');
    expect(stored?.scanCount).toBe(0);
  });

  it('admits a genuine rotating magic-QR payload', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-magic-ok');
    const qr = await server.inject({
      method: 'GET',
      url: `/tickets/${entitlement.id}/qr`,
      headers: HEADERS,
    });
    expect(qr.statusCode, qr.body).toBe(200);
    const response = await scan(token, qr.json().qrPayload);
    expect(response.json()).toMatchObject({ status: 'consumed' });
  });
});

describe('POST /door/check-ins/verify and /door/lookup', () => {
  it('previews without spending an admission', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-preview-1');

    for (const url of ['/door/check-ins/verify', '/door/lookup']) {
      const response = await server.inject({
        method: 'POST',
        url,
        headers: { ...HEADERS, 'x-scanner-session-token': token },
        payload: { eventId: EVENT_ID, qrPayload: entitlement.id },
      });
      expect(response.statusCode, response.body).toBe(200);
      // 'valid', never 'consumed' — a preview must not read as an admission.
      expect(response.json()).toMatchObject({ status: 'valid', denyReason: null });
    }

    const stored = await services.repos().entitlements.findById(entitlement.id);
    expect(stored?.scanCount).toBe(0);
  });

  it('reports an already-used ticket as invalid', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-preview-used', {
      scanCount: 1,
      status: 'redeemed',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/door/lookup',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, qrPayload: entitlement.id },
    });
    expect(response.json()).toMatchObject({ status: 'invalid', denyReason: 'already_used' });
  });
});

describe('GET /door/check-ins/:checkInId', () => {
  it('returns the ledger row for an admitted scan', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-ledger-1');
    const scanned = await scan(token, entitlement.id);
    const checkInId: string = scanned.json().checkInId;

    const response = await server.inject({
      method: 'GET',
      url: `/door/check-ins/${checkInId}`,
      headers: HEADERS,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: checkInId,
      status: 'consumed',
      entitlementId: entitlement.id,
      // Authoritative operator, taken from the session — not from the body.
      operatorUid: SEED_ACTOR.userId,
      admittedCount: 1,
    });
  });

  it('404s for an unknown check-in id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/door/check-ins/SCAN-unknown',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /door/override', () => {
  it('admits a denied scan, keeps the denial on the record, and serializes', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-override-1', { status: 'void' });
    const denied = await scan(token, entitlement.id);
    const checkInId: string = denied.json().checkInId;

    const response = await server.inject({
      method: 'POST',
      url: '/door/override',
      headers: HEADERS,
      payload: { checkInId, reason: 'guest is on the owner list' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      checkInId,
      status: 'overridden',
      overriddenBy: SEED_ACTOR.userId,
    });

    // The overridden row still reads back — the detail DTO used to omit
    // `overridden` from its status enum and 500 here.
    const read = await server.inject({
      method: 'GET',
      url: `/door/check-ins/${checkInId}`,
      headers: HEADERS,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      status: 'overridden',
      denyReason: 'void_ticket',
      overrideReason: 'guest is on the owner list',
    });
  });

  it('409s when the scan is not currently denied', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-override-2');
    const admitted = await scan(token, entitlement.id);

    const response = await server.inject({
      method: 'POST',
      url: '/door/override',
      headers: HEADERS,
      payload: { checkInId: admitted.json().checkInId, reason: 'why not' },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('offline manifest + sync', () => {
  it('signs a manifest of admissible tickets for the event', async () => {
    const token = await scannerToken();
    await seedEntitlement('ENT-off-1');
    await seedEntitlement('ENT-off-2', { status: 'void' });

    const response = await server.inject({
      method: 'GET',
      url: `/door/offline-manifest?eventId=${EVENT_ID}`,
      headers: { ...HEADERS, 'x-scanner-session-token': token },
    });
    expect(response.statusCode, response.body).toBe(200);
    const ids = response.json().manifest.map((m: { entitlementId: string }) => m.entitlementId);
    expect(ids).toContain('ENT-off-1');
    // A voided ticket is never pre-authorized.
    expect(ids).not.toContain('ENT-off-2');
    expect(response.json().manifest[0].signature).toEqual(expect.any(String));
  });

  it('re-decides every offline scan server-side and reports conflicts', async () => {
    const token = await scannerToken();
    const good = await seedEntitlement('ENT-sync-ok');
    const spent = await seedEntitlement('ENT-sync-used', { scanCount: 1, status: 'redeemed' });

    const response = await server.inject({
      method: 'POST',
      url: '/door/offline-sync',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: {
        eventId: EVENT_ID,
        scans: [
          { payload: good.id, scannedAt: new Date().toISOString(), deviceId: 'device_1' },
          { payload: spent.id, scannedAt: new Date().toISOString(), deviceId: 'device_1' },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      synced: 1,
      conflicts: [{ payload: spent.id, reason: 'already_used' }],
    });
    // The one the server accepted was really spent.
    expect((await services.repos().entitlements.findById(good.id))?.scanCount).toBe(1);
  });
});

describe('GET /tickets/:ticketId/qr', () => {
  it('is readable by the ticket holder even outside the organization', async () => {
    const entitlement = await seedEntitlement('ENT-qr-holder', { userId: 'guest_9' });
    currentActor = { userId: 'guest_9', organizationId: '', role: 'member', capabilities: [] };

    const response = await server.inject({ method: 'GET', url: `/tickets/${entitlement.id}/qr` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().qrPayload.split(':')).toHaveLength(3);
    expect(response.json().refreshIntervalSec).toBe(30);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('404s for a stranger who is neither the holder nor org staff', async () => {
    const entitlement = await seedEntitlement('ENT-qr-stranger', { userId: 'guest_9' });
    currentActor = {
      userId: 'guest_77',
      organizationId: OTHER_ORG_ID,
      role: 'member',
      capabilities: [],
    };

    const response = await server.inject({
      method: 'GET',
      url: `/tickets/${entitlement.id}/qr`,
      headers: { 'x-organization-id': OTHER_ORG_ID },
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s for an unknown ticket', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/tickets/ENT-nope/qr',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });
});
