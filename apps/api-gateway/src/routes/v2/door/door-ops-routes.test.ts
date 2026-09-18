import { beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';
import type { Entitlement } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import doorOpsRoutes from './door-ops-routes.js';
import doorCodeRoutes from './event-code-routes.js';
import phase5ScannerRoutes from './scanner-routes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Door operations HTTP ───────────────────────────────────────────────────
 *
 * The scanner app's non-camera surface: pick tonight's event, register the
 * handset, keep it alive, work the roster, confirm a couple, record a
 * refusal.
 *
 * As with the scanner suite, these pin behaviour that matters at a real door
 * rather than status codes for their own sake: that an unbound handset cannot
 * scan, that unbinding it mid-shift takes effect immediately, that a couple
 * confirmation cannot be replayed or aimed at another door, and that a
 * manual check-in cannot walk past a spent ticket.
 */

const services = createV2Services();

const ORG_ID = 'org_ops_1';
const OTHER_ORG_ID = 'org_ops_2';
const EVENT_ID = 'evt_ops_1';
const OTHER_EVENT_ID = 'evt_ops_2';
const DEVICE_ID = 'device_ops_0000000001';

const SEED_ACTOR: ActorContext = {
  userId: 'staff_ops_1',
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
  (repos.scannerDevices as unknown as { devices: Map<string, unknown> }).devices.clear();
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();
  (repos.scanLedger as unknown as { scans: Map<string, unknown> }).scans.clear();
  (repos.doorSales as unknown as { sales: Map<string, unknown> }).sales?.clear();

  currentActor = SEED_ACTOR;
  server = await buildPartnerTestServer({
    routes: [doorCodeRoutes, phase5ScannerRoutes, doorOpsRoutes],
  });
  server.addHook('onRequest', async (request) => {
    request.actor = { ...currentActor, platformRole: 'staff' };
  });

  await seedEvent(EVENT_ID, ORG_ID, new Date().toISOString());
  await seedEvent(OTHER_EVENT_ID, OTHER_ORG_ID, new Date().toISOString());
});

async function seedEvent(
  eventId: string,
  organizationId: string,
  startAt: string,
  capacity: number | null = null,
): Promise<void> {
  if (await services.repos().events.findById(eventId)) return;
  const now = new Date().toISOString();
  await services.repos().events.save({
    id: eventId,
    organizationId,
    venueId: null,
    slug: `door-ops-${eventId}`,
    title: 'Door Ops Test Event',
    summary: '',
    description: '',
    imageUrl: null,
    startAt,
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: [],
    startingPricePaise: null,
    isFree: false,
    cancellationReason: null,
    capacity,
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
    orderId: 'ord_ops_1',
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    tierId: 'tier_1',
    tierName: 'General',
    userId: 'guest_1',
    holderName: 'Ada Guest',
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

async function createDoorCode(): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: `/events/${EVENT_ID}/door-codes`,
    headers: HEADERS,
    payload: { type: 'full', gate: null, expiresAt: null },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().code;
}

async function startShift(deviceId = DEVICE_ID): Promise<{ token: string; body: unknown }> {
  const code = await createDoorCode();
  const response = await server.inject({
    method: 'POST',
    url: '/door/sessions',
    headers: HEADERS,
    payload: {
      eventId: EVENT_ID,
      code,
      deviceId,
      deviceName: 'Gate iPad',
      sessionType: 'staff',
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return { token: response.json().sessionToken, body: response.json() };
}

function scan(token: string, qrPayload: string) {
  return server.inject({
    method: 'POST',
    url: '/door/check-ins',
    headers: { ...HEADERS, 'x-scanner-session-token': token },
    payload: { eventId: EVENT_ID, qrPayload },
  });
}

describe('GET /door/events', () => {
  it('lists tonight’s events for this organization only', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/door/events?date=today',
      headers: HEADERS,
    });
    expect(response.statusCode, response.body).toBe(200);
    const ids = response.json().items.map((e: { id: string }) => e.id);
    expect(ids).toContain(EVENT_ID);
    // Another club's event on the same night is invisible.
    expect(ids).not.toContain(OTHER_EVENT_ID);
  });

  it('hides drafts — a draft door could only ever deny everyone', async () => {
    await seedEvent('evt_ops_draft', ORG_ID, new Date().toISOString());
    const draft = await services.repos().events.findById('evt_ops_draft');
    if (!draft) throw new Error('seed failed');
    await services.repos().events.save({ ...draft, status: 'draft', version: draft.version + 1 });

    const response = await server.inject({
      method: 'GET',
      url: '/door/events?date=today',
      headers: HEADERS,
    });
    const ids = response.json().items.map((e: { id: string }) => e.id);
    expect(ids).not.toContain('evt_ops_draft');
  });

  it('rejects a date that is neither `today` nor YYYY-MM-DD', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/door/events?date=tomorrow',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('POST /door/sessions (start shift)', () => {
  it('returns everything a device needs in one call', async () => {
    const { body } = await startShift();
    expect(body).toMatchObject({
      sessionId: expect.any(String),
      sessionToken: expect.any(String),
      event: { id: EVENT_ID },
      permissions: { canScan: true, canDoorEntry: true },
      tiers: expect.any(Array),
      device: { deviceId: DEVICE_ID },
      stats: { occupancy: { inside: 0, capacity: null, prebooked: 0 } },
    });
  });

  it('auto-binds the handset, so a shift never blocks on pre-registration', async () => {
    await startShift();
    const device = await services.repos().scannerDevices.findByDevice(ORG_ID, DEVICE_ID);
    expect(device?.status).toBe('active');
  });
});

describe('device binding', () => {
  it('refuses a scan once the handset is unbound', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-unbound');

    const unbound = await server.inject({
      method: 'POST',
      url: `/door/devices/${DEVICE_ID}/unbind`,
      headers: HEADERS,
      payload: { reason: 'handset lost' },
    });
    expect(unbound.statusCode, unbound.body).toBe(200);

    const response = await scan(token, entitlement.id);
    // Unbinding closes the handset's live sessions too, so this is refused at
    // the session layer. Either way the guest is not admitted and nothing is
    // spent — which is what a lost phone has to mean.
    expect([401, 403]).toContain(response.statusCode);
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);
  });

  it('refuses a scan from an unbound handset even while its session is live', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-unbound-live');

    // Unbind ONLY the device record, leaving the session untouched. This is
    // the binding check on its own: a cryptographically valid session token
    // is not enough if the venue no longer authorizes the handset.
    const repos = services.repos();
    const device = await repos.scannerDevices.findByDevice(ORG_ID, DEVICE_ID);
    if (!device) throw new Error('device was not auto-bound by the shift start');
    await repos.scannerDevices.save({ ...device, status: 'unbound', version: device.version + 1 });

    const response = await scan(token, entitlement.id);
    expect(response.statusCode).toBe(403);
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);
  });

  it('unbinding also closes the sessions that handset had open', async () => {
    const { token } = await startShift();
    await server.inject({
      method: 'POST',
      url: `/door/devices/${DEVICE_ID}/unbind`,
      headers: HEADERS,
      payload: { reason: 'stolen' },
    });
    const heartbeat = await server.inject({
      method: 'POST',
      url: '/door/heartbeat',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID },
    });
    expect(heartbeat.statusCode).toBe(401);
  });

  it('re-binding refreshes rather than resetting the device’s history', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-rebind');
    await scan(token, entitlement.id);

    const rebind = await server.inject({
      method: 'POST',
      url: '/door/devices',
      headers: HEADERS,
      payload: { deviceId: DEVICE_ID, deviceName: 'Gate iPad (renamed)' },
    });
    expect(rebind.statusCode, rebind.body).toBe(201);
    expect(rebind.json()).toMatchObject({ deviceName: 'Gate iPad (renamed)', status: 'active' });
    // The scan history a manager would look at survives a re-register.
    expect(rebind.json().scanCount).toBeGreaterThan(0);
  });

  it('lists this organization’s handsets and their liveness', async () => {
    await startShift();
    const response = await server.inject({
      method: 'GET',
      url: '/door/devices',
      headers: HEADERS,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({ deviceId: DEVICE_ID, status: 'active' });
  });
});

describe('POST /door/heartbeat', () => {
  it('keeps a live device visible', async () => {
    const { token } = await startShift();
    const response = await server.inject({
      method: 'POST',
      url: '/door/heartbeat',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, gate: 'north' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ deviceId: DEVICE_ID, lastGate: 'north' });
  });

  it('cannot be faked without a session token', async () => {
    await startShift();
    const response = await server.inject({
      method: 'POST',
      url: '/door/heartbeat',
      headers: { ...HEADERS, 'x-scanner-session-token': 'scn_not-a-real-token' },
      payload: { eventId: EVENT_ID },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('couple tickets (two-step admission)', () => {
  async function askForConfirmation(token: string, entitlementId: string) {
    const asked = await scan(token, entitlementId);
    expect(asked.json().status).toBe('confirmation_required');
    return asked.json().confirmation.token as string;
  }

  it('admits both guests on one claim when staff confirm', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-couple', { scanCountAllowed: 2 });
    const confirmationToken = await askForConfirmation(token, entitlement.id);

    const confirmed = await server.inject({
      method: 'POST',
      url: '/door/check-ins/confirm',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, confirmationToken, confirmed: true },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: 'consumed' });

    const stored = await services.repos().entitlements.findById(entitlement.id);
    expect(stored?.scanCount).toBe(2);
    expect(stored?.status).toBe('redeemed');

    // The door counted two people, on one record.
    const scanRow = await services.repos().scanLedger.findById(confirmed.json().checkInId);
    expect(scanRow?.admittedCount).toBe(2);
  });

  it('records a real denial when only one guest is present', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-couple-no', { scanCountAllowed: 2 });
    const confirmationToken = await askForConfirmation(token, entitlement.id);

    const refused = await server.inject({
      method: 'POST',
      url: '/door/check-ins/confirm',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, confirmationToken, confirmed: false },
    });
    expect(refused.statusCode, refused.body).toBe(200);
    expect(refused.json()).toMatchObject({ status: 'denied' });
    // Nothing spent — the pair can come back together.
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);
  });

  it('cannot be replayed to admit four people on a two-person ticket', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-couple-replay', { scanCountAllowed: 2 });
    const confirmationToken = await askForConfirmation(token, entitlement.id);
    const payload = { eventId: EVENT_ID, confirmationToken, confirmed: true };
    const headers = { ...HEADERS, 'x-scanner-session-token': token };

    const first = await server.inject({
      method: 'POST',
      url: '/door/check-ins/confirm',
      headers,
      payload,
    });
    expect(first.json().status).toBe('consumed');

    const replay = await server.inject({
      method: 'POST',
      url: '/door/check-ins/confirm',
      headers,
      payload,
    });
    // The token was minted against scanCount 0; it is now 2.
    expect(replay.json()).toMatchObject({ status: 'denied', denyReason: 'already_used' });
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(2);
  });

  it('rejects a confirmation aimed at a different door', async () => {
    const { token } = await startShift();
    const other = await startShift('device_ops_0000000002');
    const entitlement = await seedEntitlement('ENT-ops-couple-cross', { scanCountAllowed: 2 });
    const confirmationToken = await askForConfirmation(token, entitlement.id);

    const response = await server.inject({
      method: 'POST',
      url: '/door/check-ins/confirm',
      headers: { ...HEADERS, 'x-scanner-session-token': other.token },
      payload: { eventId: EVENT_ID, confirmationToken, confirmed: true },
    });
    expect(response.statusCode).toBe(401);
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);
  });

  it('rejects a forged confirmation token', async () => {
    const { token } = await startShift();
    const response = await server.inject({
      method: 'POST',
      url: '/door/check-ins/confirm',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: {
        eventId: EVENT_ID,
        confirmationToken: Buffer.from('a|b|c|d|0|2|99999999999').toString('base64url') + '.beef',
        confirmed: true,
      },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /door/staff-deny', () => {
  it('records the refusal WITHOUT burning the guest’s ticket', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-staffdeny');

    const response = await server.inject({
      method: 'POST',
      url: '/door/staff-deny',
      headers: { ...HEADERS, 'x-scanner-session-token': token },
      payload: { eventId: EVENT_ID, qrPayload: entitlement.id, reason: 'intoxicated' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'denied',
      admittedCount: 0,
      operatorUid: SEED_ACTOR.userId,
    });
    // The guest did not get in, so their entry is not spent — otherwise a
    // door judgement becomes a refund dispute.
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(0);
  });
});

describe('GET /door/guests', () => {
  it('merges online tickets with door sales, not-entered first', async () => {
    const { token } = await startShift();
    await seedEntitlement('ENT-ops-guest-a', { holderName: 'Zoe Zephyr' });
    const entered = await seedEntitlement('ENT-ops-guest-b', { holderName: 'Aaron Able' });
    await scan(token, entered.id);

    const response = await server.inject({
      method: 'GET',
      url: `/door/guests?eventId=${EVENT_ID}`,
      headers: HEADERS,
    });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as { name: string; status: string; source: string }[];
    // Not-entered first: the list exists to find people who have not come in.
    expect(items[0]).toMatchObject({ name: 'Zoe Zephyr', status: 'not_entered' });
    expect(items.find((g) => g.name === 'Aaron Able')).toMatchObject({ status: 'entered' });
    expect(items.every((g) => g.source === 'online')).toBe(true);
  });

  it('refuses another organization’s roster', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/door/guests?eventId=${OTHER_EVENT_ID}`,
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /door/guests/check-in', () => {
  it('admits a guest whose QR will not scan', async () => {
    await startShift();
    const entitlement = await seedEntitlement('ENT-ops-manual');

    const response = await server.inject({
      method: 'POST',
      url: '/door/guests/check-in',
      headers: HEADERS,
      payload: { eventId: EVENT_ID, entitlementId: entitlement.id },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      guest: { id: entitlement.id, status: 'entered' },
      checkInId: expect.any(String),
    });
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(1);

    // The ledger says a human did this, rather than borrowing a device's name.
    const scanRow = await services.repos().scanLedger.findById(response.json().checkInId);
    expect(scanRow).toMatchObject({ deviceId: null, deviceBound: false, admittedCount: 1 });
  });

  it('cannot be used to walk past an already-spent ticket', async () => {
    const { token } = await startShift();
    const entitlement = await seedEntitlement('ENT-ops-manual-spent');
    await scan(token, entitlement.id);

    const response = await server.inject({
      method: 'POST',
      url: '/door/guests/check-in',
      headers: HEADERS,
      payload: { eventId: EVENT_ID, entitlementId: entitlement.id },
    });
    expect(response.statusCode).toBe(400);
    expect((await services.repos().entitlements.findById(entitlement.id))?.scanCount).toBe(1);
  });

  it('cannot be used to admit a voided ticket', async () => {
    await startShift();
    const entitlement = await seedEntitlement('ENT-ops-manual-void', { status: 'void' });
    const response = await server.inject({
      method: 'POST',
      url: '/door/guests/check-in',
      headers: HEADERS,
      payload: { eventId: EVENT_ID, entitlementId: entitlement.id },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('occupancy in GET /door/stats via start shift', () => {
  it('reports a real capacity and remaining when the event configures one', async () => {
    await seedEvent('evt_ops_cap', ORG_ID, new Date().toISOString(), 300);
    const stats = await services.doorStats.getStats('evt_ops_cap', SEED_ACTOR);
    expect(stats.occupancy).toMatchObject({
      inside: 0,
      capacity: 300,
      remaining: 300,
      prebooked: 0,
      doorEntries: 0,
    });
  });

  it('reports null rather than inventing a capacity nobody set', async () => {
    const stats = await services.doorStats.getStats(EVENT_ID, SEED_ACTOR);
    expect(stats.occupancy.capacity).toBeNull();
    expect(stats.occupancy.remaining).toBeNull();
  });
});

describe('device re-authorization', () => {
  it('an ordinary register cannot resurrect an unbound handset', async () => {
    await startShift();
    await server.inject({
      method: 'POST',
      url: `/door/devices/${DEVICE_ID}/unbind`,
      headers: HEADERS,
      payload: { reason: 'stolen' },
    });

    // The open self-register path exists so staff can onboard a phone without
    // a manager. If it also reactivated, whoever took the phone — still
    // holding a staff login — could walk the revocation straight back.
    const response = await server.inject({
      method: 'POST',
      url: '/door/devices',
      headers: HEADERS,
      payload: { deviceId: DEVICE_ID, deviceName: 'Gate iPad' },
    });
    expect(response.statusCode).toBe(403);

    const device = await services.repos().scannerDevices.findByDevice(ORG_ID, DEVICE_ID);
    expect(device?.status).toBe('unbound');
  });

  it('a manager can re-authorize it deliberately', async () => {
    await startShift();
    await server.inject({
      method: 'POST',
      url: `/door/devices/${DEVICE_ID}/unbind`,
      headers: HEADERS,
      payload: { reason: 'misplaced, then found' },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/door/devices/${DEVICE_ID}/reauthorize`,
      headers: HEADERS,
      payload: { deviceName: 'Gate iPad' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'active', unboundReason: null });
  });

  it('starting a shift on an unbound handset is refused, not silently re-bound', async () => {
    await startShift();
    await server.inject({
      method: 'POST',
      url: `/door/devices/${DEVICE_ID}/unbind`,
      headers: HEADERS,
      payload: { reason: 'stolen' },
    });

    const code = await createDoorCode();
    const response = await server.inject({
      method: 'POST',
      url: '/door/sessions',
      headers: HEADERS,
      payload: {
        eventId: EVENT_ID,
        code,
        deviceId: DEVICE_ID,
        deviceName: 'Gate iPad',
        sessionType: 'staff',
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('production-shaped ids survive the round trip', () => {
  /**
   * Reported by the front-end team: `POST /door/devices` and
   * `POST /door/heartbeat` returned 500 against a real Firestore
   * organization. The composite device id overflowed `opaqueIdSchema`'s
   * 64-character cap, so the write succeeded and the *response* failed
   * validation. Every existing test passed because the fixtures use `org_1`.
   *
   * These use a UUID organization and a maximum-length device id — the shapes
   * production actually has.
   */
  const UUID_ORG = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const MAX_DEVICE = 'scanner_'.padEnd(128, 'a');

  beforeEach(() => {
    currentActor = { ...SEED_ACTOR, organizationId: UUID_ORG };
  });

  it('registers a device and serializes it back', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/door/devices',
      headers: { 'x-organization-id': UUID_ORG },
      payload: { deviceId: MAX_DEVICE, deviceName: 'Gate iPad' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().id.length).toBeLessThanOrEqual(64);
    expect(response.json().deviceId).toBe(MAX_DEVICE);
  });

  it('lists it back without blowing the id cap', async () => {
    await server.inject({
      method: 'POST',
      url: '/door/devices',
      headers: { 'x-organization-id': UUID_ORG },
      payload: { deviceId: MAX_DEVICE, deviceName: 'Gate iPad' },
    });
    const response = await server.inject({
      method: 'GET',
      url: '/door/devices',
      headers: { 'x-organization-id': UUID_ORG },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0].deviceId).toBe(MAX_DEVICE);
  });
});
