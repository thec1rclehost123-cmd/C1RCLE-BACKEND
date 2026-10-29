import {
  buildRotatingQr,
  checkRotatingQr,
  parseRotatingQr,
  verifyManifest,
} from '@c1rcle/core/application';
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
    adminOverride: false,
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

function scan(token: string, qrPayload: string, eventId = EVENT_ID, eligibilityVerified = false) {
  return server.inject({
    method: 'POST',
    url: '/door/check-ins',
    headers: { ...HEADERS, 'x-scanner-session-token': token },
    payload: { eventId, qrPayload, ...(eligibilityVerified ? { eligibilityVerified: true } : {}) },
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

const GEOFENCED_EVENT_ID = 'evt_geofenced';
const GEOFENCED_VENUE_ID = 'venue_geofenced';
// Real coordinates so the distance math is meaningful: this is central Delhi.
const VENUE_LAT = 28.6139;
const VENUE_LNG = 77.209;

async function seedGeofencedEventAndVenue(): Promise<void> {
  if (await services.repos().events.findById(GEOFENCED_EVENT_ID)) return;
  const now = new Date().toISOString();
  await services.repos().events.save({
    id: GEOFENCED_EVENT_ID,
    organizationId: ORG_ID,
    venueId: GEOFENCED_VENUE_ID,
    slug: 'scanner-test-geofenced',
    title: 'Geofenced Scanner Test Event',
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
    adminOverride: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await services.repos().venues.save({
    id: GEOFENCED_VENUE_ID,
    organizationId: ORG_ID,
    ownerId: 'staff_1',
    status: 'active',
    public: {
      name: 'Geofenced Test Venue',
      slug: 'geofenced-test-venue',
      description: '',
      photoUrl: null,
      address: { lat: VENUE_LAT, lng: VENUE_LNG },
      facilities: [],
      menu: { sections: [], updatedAt: null },
      settings: { showGuestList: false, activityEnabled: false },
      capacity: null,
    },
    private: { contactEmail: null, contactPhone: null, socials: {}, internalNotes: '' },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe('POST /door/sessions — D-030 geofence', () => {
  beforeEach(async () => {
    await seedGeofencedEventAndVenue();
  });

  async function mintCodeFor(eventId: string): Promise<string> {
    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/door-codes`,
      headers: HEADERS,
      payload: { type: 'full', gate: null, expiresAt: null },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().code;
  }

  it('opens the shift when the device fix is inside the radius', async () => {
    const code = await mintCodeFor(GEOFENCED_EVENT_ID);
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: GEOFENCED_EVENT_ID,
        code,
        deviceId: 'device_geo_near',
        deviceName: 'Gate iPad',
        sessionType: 'staff',
        // ~50m from the venue — well inside the 500m radius.
        deviceLocation: { lat: VENUE_LAT + 0.00045, lng: VENUE_LNG },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
  });

  it('refuses to open the shift when the device fix is far from the venue', async () => {
    const code = await mintCodeFor(GEOFENCED_EVENT_ID);
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: GEOFENCED_EVENT_ID,
        code,
        deviceId: 'device_geo_far',
        deviceName: 'Gate iPad',
        sessionType: 'staff',
        // Mumbai — ~1150km from the Delhi venue coords above.
        deviceLocation: { lat: 19.076, lng: 72.8777 },
      },
    });
    // This route masks every ForbiddenError as 404 (`hideForbidden: true`,
    // same IDOR guard as a cross-tenant event lookup) — the geofence denial
    // is not a special case, it reuses that existing convention rather than
    // adding a new distinguishable status code.
    expect(response.statusCode).toBe(404);
  });

  it('skips the check (opens the shift) when the device sends no fix at all', async () => {
    const code = await mintCodeFor(GEOFENCED_EVENT_ID);
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: GEOFENCED_EVENT_ID,
        code,
        deviceId: 'device_geo_nolocation',
        deviceName: 'Gate iPad',
        sessionType: 'staff',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
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
  it('refuses admission after the event is cancelled without spending the ticket', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-cancelled-event');
    const eventRepository = services.repos().events as unknown as {
      events: Map<string, Record<string, unknown>>;
    };
    const original = eventRepository.events.get(EVENT_ID);
    if (!original) throw new Error('missing seeded event');
    eventRepository.events.set(EVENT_ID, {
      ...original,
      status: 'cancelled',
      isPublic: false,
      cancellationReason: 'weather',
    });

    try {
      const response = await scan(token, entitlement.id);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: 'validation' });
      expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);
    } finally {
      eventRepository.events.set(EVENT_ID, original);
    }
  });

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

  it('requires an explicit scanner eligibility check for restricted entitlements', async () => {
    const token = await scannerToken();
    const entitlement = await seedEntitlement('ENT-restricted', {
      eligibility: {
        audienceType: 'WOMEN_ONLY',
        minAge: null,
        maxAge: null,
        attested: true,
        attestedAt: new Date().toISOString(),
      },
    });

    const preview = await server.inject({
      method: 'POST',
      url: '/door/lookup',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, qrPayload: entitlement.id },
    });
    expect(preview.json()).toMatchObject({
      status: 'valid',
      entitlement: {
        eligibilityPolicy: { audienceType: 'WOMEN_ONLY', minAge: null, maxAge: null },
      },
    });

    const refused = await scan(token, entitlement.id);
    expect(refused.json()).toMatchObject({ status: 'denied', denyReason: 'eligibility_required' });
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);

    const admitted = await scan(token, entitlement.id, EVENT_ID, true);
    expect(admitted.json()).toMatchObject({ status: 'consumed' });
  });

  it('uses the current tier policy for legacy entitlements without an eligibility snapshot', async () => {
    const token = await scannerToken();
    const now = new Date().toISOString();
    const tierId = 'tier_legacy_eligibility';
    if (!(await services.repos().catalog.getTierById(tierId))) {
      await services.repos().catalog.saveTier({
        id: tierId,
        eventId: EVENT_ID,
        organizationId: ORG_ID,
        name: 'Student legacy tier',
        description: '',
        entryType: 'ENTRY',
        currency: 'INR',
        priceInPaise: 100,
        quantity: 10,
        status: 'active',
        salesStartAt: null,
        salesEndAt: null,
        maxPerOrder: 10,
        accessMode: 'public',
        audienceType: 'STUDENT',
        guestCount: 1,
        admissionMode: 'per_person',
        pricingPhases: [],
        doorPriceInPaise: null,
        benefits: [],
        minAge: null,
        maxAge: null,
        minPerOrder: null,
        maxPerUser: null,
        tableConfig: null,
        commissionEligible: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    const entitlement = await seedEntitlement('ENT-legacy-restricted', { tierId });

    const preview = await server.inject({
      method: 'POST',
      url: '/door/lookup',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, qrPayload: entitlement.id },
    });
    expect(preview.json()).toMatchObject({
      status: 'valid',
      entitlement: { eligibilityPolicy: { audienceType: 'STUDENT' } },
    });
    const refused = await scan(token, entitlement.id);
    expect(refused.json()).toMatchObject({ status: 'denied', denyReason: 'eligibility_required' });
    const admitted = await scan(token, entitlement.id, EVENT_ID, true);
    expect(admitted.json()).toMatchObject({ status: 'consumed' });
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

describe('POST /door/ticket-addons/redeem', () => {
  it('redeems an active extra with a scanner session without consuming admission', async () => {
    const token = await scannerToken();
    const now = new Date().toISOString();
    const entitlement = await seedEntitlement('ENT-addon-redemption', {
      ticketAddons: [
        {
          id: 'ADDON-ENT-1',
          addonId: 'ADDON-1',
          name: 'Parking',
          kind: 'parking',
          unitPricePaise: 500,
          status: 'active',
          createdAt: now,
          redeemedAt: null,
        },
      ],
    });

    const response = await server.inject({
      method: 'POST',
      url: '/door/ticket-addons/redeem',
      headers: {
        ...HEADERS,
        'x-scanner-session-token': token,
        'idempotency-key': 'addon-redeem-route-1',
      },
      payload: {
        eventId: EVENT_ID,
        entitlementId: entitlement.id,
        addonEntitlementId: 'ADDON-ENT-1',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      entitlementId: entitlement.id,
      addon: { id: 'ADDON-ENT-1', status: 'redeemed', redeemedAt: expect.any(String) },
    });
    const stored = await services.repos().entitlements.findById(entitlement.id);
    expect(stored?.scanCount).toBe(0);
    expect(stored?.ticketAddons?.[0]?.status).toBe('redeemed');
  });

  it('refuses redemption without a scanner session token', async () => {
    const now = new Date().toISOString();
    const entitlement = await seedEntitlement('ENT-addon-no-session', {
      ticketAddons: [
        {
          id: 'ADDON-ENT-2',
          addonId: 'ADDON-2',
          name: 'Cloakroom',
          kind: 'cloakroom',
          unitPricePaise: 200,
          status: 'active',
          createdAt: now,
          redeemedAt: null,
        },
      ],
    });

    const response = await server.inject({
      method: 'POST',
      url: '/door/ticket-addons/redeem',
      headers: { ...HEADERS, 'idempotency-key': 'addon-redeem-no-session' },
      payload: {
        eventId: EVENT_ID,
        entitlementId: entitlement.id,
        addonEntitlementId: 'ADDON-ENT-2',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(
      (await services.repos().entitlements.findById(entitlement.id))?.ticketAddons?.[0]?.status,
    ).toBe('active');
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
    await seedEntitlement('ENT-off-couple', { scanCountAllowed: 2 });
    await seedEntitlement('ENT-off-half', { scanCountAllowed: 2, scanCount: 1 });

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
    const body = response.json();
    expect(body).toMatchObject({ version: 1, eventId: EVENT_ID });
    // Each entry carries its own verification key; the next suite pins that a
    // ticket's key verifies that ticket's codes and no other ticket's.
    const entry = body.manifest.find(
      (m: { entitlementId: string }) => m.entitlementId === 'ENT-off-1',
    );
    expect(entry.ticketKey).toMatch(/^[0-9a-f]{64}$/);
    // Seats still admissible, so a device can count its own offline admissions.
    const seats = Object.fromEntries(
      body.manifest.map((m: { entitlementId: string; seatsRemaining: number }) => [
        m.entitlementId,
        m.seatsRemaining,
      ]),
    );
    expect(seats['ENT-off-1']).toBe(1);
    expect(seats['ENT-off-couple']).toBe(2);
    expect(seats['ENT-off-half']).toBe(1);
    // The device can verify the whole manifest with only the public key.
    const signed = {
      eventId: body.eventId,
      signedAt: body.signedAt,
      expiresAt: body.expiresAt,
      entries: body.manifest,
    };
    expect(verifyManifest(body.publicKey, signed, body.manifestSignature)).toBe(true);
    expect(
      verifyManifest(
        body.publicKey,
        { ...signed, eventId: OTHER_EVENT_ID },
        body.manifestSignature,
      ),
    ).toBe(false);
  });

  it('refuses offline manifests when an active restricted ticket requires a door check', async () => {
    const token = await scannerToken();
    await seedEntitlement('ENT-off-restricted', {
      eligibility: {
        audienceType: 'STUDENT',
        minAge: null,
        maxAge: null,
        attested: true,
        attestedAt: new Date().toISOString(),
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/door/offline-manifest?eventId=${EVENT_ID}`,
      headers: { ...HEADERS, 'x-scanner-session-token': token },
    });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ code: 'server' });
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

describe('offline verification and sync of rotating QR codes', () => {
  const HOUR_MS = 60 * 60 * 1000;

  function must<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) throw new Error('expected a value');
    return value;
  }

  function keyFor(manifest: { entitlementId: string; ticketKey: string }[], id: string): string {
    return must(manifest.find((m) => m.entitlementId === id)).ticketKey;
  }

  async function manifestFor(token: string) {
    const response = await server.inject({
      method: 'GET',
      url: `/door/offline-manifest?eventId=${EVENT_ID}`,
      headers: { ...HEADERS, 'x-scanner-session-token': token },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body: { manifest: { entitlementId: string; ticketKey: string }[] } = response.json();
    return body;
  }

  function sync(token: string, scans: { payload: string; scannedAt: string }[]) {
    return server.inject({
      method: 'POST',
      url: '/door/offline-sync',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, scans: scans.map((s) => ({ ...s, deviceId: 'device_1' })) },
    });
  }

  it('lets a device verify, with only its manifest key, the QR the server issues', async () => {
    const token = await scannerToken();
    const ticket = await seedEntitlement('ENT-dev-1');
    const { manifest } = await manifestFor(token);
    const ticketKey = keyFor(manifest, ticket.id);

    const qr = await server.inject({
      method: 'GET',
      url: `/tickets/${ticket.id}/qr`,
      headers: HEADERS,
    });
    const parsed = must(parseRotatingQr(qr.json().qrPayload));
    expect(checkRotatingQr({ ticketKey, parsed, atMs: Date.now() })).toBe(true);
    // The same code does not verify against another ticket's key.
    const other = await seedEntitlement('ENT-dev-2');
    const otherKey =
      manifest.find((m) => m.entitlementId === other.id)?.ticketKey ?? 'x'.repeat(64);
    expect(checkRotatingQr({ ticketKey: otherKey, parsed, atMs: Date.now() })).toBe(false);
  });

  it('accepts a code scanned hours ago, because it is verified at the time of the scan', async () => {
    const token = await scannerToken();
    const ticket = await seedEntitlement('ENT-late-1');
    const { manifest } = await manifestFor(token);
    const ticketKey = keyFor(manifest, ticket.id);

    const scannedAtMs = Date.now() - 3 * HOUR_MS;
    const payload = buildRotatingQr(ticketKey, ticket.id, scannedAtMs);
    const response = await sync(token, [
      { payload, scannedAt: new Date(scannedAtMs).toISOString() },
    ]);
    expect(response.json()).toMatchObject({ synced: 1, conflicts: [] });
    expect((await services.repos().entitlements.findById(ticket.id))?.scanCount).toBe(1);
  });

  it('still refuses a stale screenshot claimed as a fresh scan', async () => {
    const token = await scannerToken();
    const ticket = await seedEntitlement('ENT-replay-1');
    const { manifest } = await manifestFor(token);
    const ticketKey = keyFor(manifest, ticket.id);

    // Code minted three hours ago, but the device claims it scanned it just now.
    const payload = buildRotatingQr(ticketKey, ticket.id, Date.now() - 3 * HOUR_MS);
    const response = await sync(token, [{ payload, scannedAt: new Date().toISOString() }]);
    expect(response.json()).toMatchObject({
      synced: 0,
      conflicts: [{ payload, reason: 'invalid_signature' }],
    });
    expect((await services.repos().entitlements.findById(ticket.id))?.scanCount).toBe(0);
  });

  it('refuses a tampered signature without spending the ticket', async () => {
    const token = await scannerToken();
    const ticket = await seedEntitlement('ENT-tamper-1');
    const { manifest } = await manifestFor(token);
    const ticketKey = keyFor(manifest, ticket.id);

    const good = buildRotatingQr(ticketKey, ticket.id, Date.now());
    const payload = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
    const response = await sync(token, [{ payload, scannedAt: new Date().toISOString() }]);
    expect(response.json()).toMatchObject({
      synced: 0,
      conflicts: [{ reason: 'invalid_signature' }],
    });
    expect((await services.repos().entitlements.findById(ticket.id))?.scanCount).toBe(0);
  });

  it('bounds the device clock: too old and in-the-future scans are refused as offline_expired', async () => {
    const token = await scannerToken();
    const ticket = await seedEntitlement('ENT-clock-1');
    const { manifest } = await manifestFor(token);
    const ticketKey = keyFor(manifest, ticket.id);

    const old = Date.now() - 40 * HOUR_MS;
    const future = Date.now() + HOUR_MS;
    const response = await sync(token, [
      {
        payload: buildRotatingQr(ticketKey, ticket.id, old),
        scannedAt: new Date(old).toISOString(),
      },
      {
        payload: buildRotatingQr(ticketKey, ticket.id, future),
        scannedAt: new Date(future).toISOString(),
      },
    ]);
    expect(response.json().synced).toBe(0);
    expect(response.json().conflicts.map((c: { reason: string }) => c.reason)).toEqual([
      'offline_expired',
      'offline_expired',
    ]);
    expect((await services.repos().entitlements.findById(ticket.id))?.scanCount).toBe(0);
  });

  it('admits a ticket once when two offline devices both scanned it', async () => {
    const token = await scannerToken();
    const ticket = await seedEntitlement('ENT-dup-1');
    const { manifest } = await manifestFor(token);
    const ticketKey = keyFor(manifest, ticket.id);

    const at = Date.now() - HOUR_MS;
    const payload = buildRotatingQr(ticketKey, ticket.id, at);
    const scannedAt = new Date(at).toISOString();
    const first = await sync(token, [{ payload, scannedAt }]);
    const second = await sync(token, [{ payload, scannedAt }]);
    expect(first.json()).toMatchObject({ synced: 1 });
    expect(second.json()).toMatchObject({ synced: 0, conflicts: [{ reason: 'already_used' }] });
    expect((await services.repos().entitlements.findById(ticket.id))?.scanCount).toBe(1);
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

  it.each([
    ['void', { status: 'void' as const }],
    [
      'refund-locked',
      { refundLock: { refundRequestId: 'REF-qr', frozenAt: new Date().toISOString() } },
    ],
  ])(
    'does not mint a QR for an authorized holder whose ticket is %s',
    async (_state, overrides) => {
      const entitlement = await seedEntitlement(`ENT-qr-${_state}`, {
        userId: 'guest_9',
        ...overrides,
      });
      currentActor = { userId: 'guest_9', organizationId: '', role: 'member', capabilities: [] };

      const response = await server.inject({ method: 'GET', url: `/tickets/${entitlement.id}/qr` });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'conflict', status: 409 });
    },
  );

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
