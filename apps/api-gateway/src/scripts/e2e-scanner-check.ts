import { createHmac } from 'node:crypto';

import { getGatewayConfig } from '../config/index.js';

/**
 * ─── Scanner-app manual E2E, driven at the HTTP layer ───────────────────────
 *
 * This is NOT a substitute for the documented manual walkthrough (pair →
 * redeem → scan → … → heartbeat, against a real device/camera) — this
 * environment has no browser-automation tool, so nothing here can click a
 * button in the actual running app. What it CAN do, and does: send the exact
 * request sequence `apps/scanner-app/src/api/scannerApiClient.ts` sends, at
 * every step this session's schema fixes touched, and assert the response
 * matches what that client's zod schemas expect. That is precisely the class
 * of bug found twice already this session (schema fields that don't exist on
 * the real response) — one that `tsc`/`eslint` cannot catch and only a real
 * round-trip against a real backend can.
 *
 * Requires `seed-scanner-e2e.ts` to have been run first, and the gateway
 * running on GATEWAY_URL.
 */

const GATEWAY_URL = 'http://localhost:8080';
const OWNER_EMAIL = 'seed_e2e_owner@c1rcle.test';
const OWNER_PASSWORD = 'SeedE2E-Owner-2026!';
const ORG_ID = 'seed_e2e_org';
const EVENT_ID = 'seed_e2e_event';
const TIER_ID = 'seed_e2e_tier';
const FULL_CODE = process.argv[2];
const CHARGE_CODE = process.argv[3];
const WALLET_ID = process.argv[4];

if (!FULL_CODE || !CHARGE_CODE || !WALLET_ID) {
  console.error('Usage: tsx e2e-scanner-check.ts <fullDoorCode> <chargeDoorCode> <walletId>');
  console.error(
    '(printed by seed-scanner-e2e.ts — the wallet QR itself expires in ~30s, so this script mints a fresh one from the wallet id)',
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.info(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
    if (detail !== undefined) console.error(`       ${JSON.stringify(detail)}`);
  }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = { unparsable: text };
  }
  return { status: response.status, json };
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function main(): Promise<void> {
  const gateway = getGatewayConfig();
  if (!gateway.MAGIC_TICKET_SECRET)
    throw new Error('MAGIC_TICKET_SECRET required to mint a fresh wallet QR.');

  console.info('── auth ──────────────────────────────────────────────────');
  const login = await call('POST', '/api/v2/auth/login', {
    body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  check('login: 200', login.status === 200, login.json);
  const loginBody = login.json;
  check(
    'login: {user, accessToken, expiresAt} shape',
    isObj(loginBody) &&
      isObj(loginBody.user) &&
      typeof loginBody.accessToken === 'string' &&
      typeof loginBody.expiresAt === 'number',
    loginBody,
  );
  const accessToken = isObj(loginBody) ? (loginBody.accessToken as string) : '';
  const authHeaders = { authorization: `Bearer ${accessToken}`, 'x-organization-id': ORG_ID };

  console.info('── pairing ───────────────────────────────────────────────');
  const deviceId = `seed_e2e_device_${String(Date.now())}`;
  const register = await call('POST', '/api/v2/door/devices', {
    body: { deviceId, deviceName: 'Seed E2E Device' },
    headers: authHeaders,
  });
  check(
    'register device: 200/201',
    register.status === 200 || register.status === 201,
    register.json,
  );

  console.info('── redeem (full code: scan + door entry + walk-in) ──────');
  const redeemFull = await call('POST', '/api/v2/door/sessions', {
    body: {
      eventId: EVENT_ID,
      code: FULL_CODE,
      deviceId,
      deviceName: 'Seed E2E Device',
      sessionType: 'staff',
    },
    headers: authHeaders,
  });
  check('redeem: 201', redeemFull.status === 201 || redeemFull.status === 200, redeemFull.json);
  const redeemBody = redeemFull.json;
  check(
    'redeem: {sessionToken, sessionId, sessionExpiresAt, event, permissions, gate, tiers, device} shape',
    isObj(redeemBody) &&
      typeof redeemBody.sessionToken === 'string' &&
      typeof redeemBody.sessionId === 'string' &&
      isObj(redeemBody.event) &&
      isObj(redeemBody.permissions) &&
      Array.isArray(redeemBody.tiers) &&
      isObj(redeemBody.device),
    redeemBody,
  );
  const sessionToken = isObj(redeemBody) ? (redeemBody.sessionToken as string) : '';
  const sessionHeaders = { ...authHeaders, 'x-scanner-session-token': sessionToken };

  console.info('── scan: valid ticket ────────────────────────────────────');
  const validId = 'ENT-e215f710e157d38c1aa9ee64695c3276';
  const scanValid = await call('POST', '/api/v2/door/check-ins', {
    body: { eventId: EVENT_ID, qrPayload: validId },
    headers: sessionHeaders,
  });
  check(
    'scan valid: 200/201',
    scanValid.status === 200 || scanValid.status === 201,
    scanValid.json,
  );
  check(
    'scan valid: status=consumed, {checkInId, entitlement}',
    isObj(scanValid.json) &&
      scanValid.json.status === 'consumed' &&
      typeof scanValid.json.checkInId === 'string' &&
      isObj(scanValid.json.entitlement),
    scanValid.json,
  );

  console.info('── scan: couple ticket → confirmation_required → confirm ─');
  const coupleId = 'ENT-e9694bbdf8d30bd2ae7d019521cd4904';
  const scanCouple = await call('POST', '/api/v2/door/check-ins', {
    body: { eventId: EVENT_ID, qrPayload: coupleId },
    headers: sessionHeaders,
  });
  check(
    'scan couple: status=confirmation_required, {confirmation:{token,expiresAt,seats}, entitlement}',
    isObj(scanCouple.json) &&
      scanCouple.json.status === 'confirmation_required' &&
      isObj(scanCouple.json.confirmation) &&
      typeof scanCouple.json.confirmation.token === 'string',
    scanCouple.json,
  );
  const confirmToken =
    isObj(scanCouple.json) && isObj(scanCouple.json.confirmation)
      ? (scanCouple.json.confirmation.token as string)
      : '';
  const confirm = await call('POST', '/api/v2/door/check-ins/confirm', {
    body: { eventId: EVENT_ID, confirmationToken: confirmToken, confirmed: true },
    headers: sessionHeaders,
  });
  check(
    'confirm couple: status=consumed',
    isObj(confirm.json) && confirm.json.status === 'consumed',
    confirm.json,
  );

  console.info('── scan: already-used ticket ────────────────────────────');
  const usedId = 'ENT-c75d7c97e4eb0cad6de8beaffa879942';
  const scanUsed = await call('POST', '/api/v2/door/check-ins', {
    body: { eventId: EVENT_ID, qrPayload: usedId },
    headers: sessionHeaders,
  });
  check(
    'scan used: status=denied, {checkInId, denyReason, denyMessage}',
    isObj(scanUsed.json) &&
      scanUsed.json.status === 'denied' &&
      typeof scanUsed.json.denyReason === 'string' &&
      typeof scanUsed.json.denyMessage === 'string',
    scanUsed.json,
  );

  console.info('── guests roster + manual check-in ──────────────────────');
  const guests = await call('GET', `/api/v2/door/guests?eventId=${EVENT_ID}&status=not_entered`, {
    headers: sessionHeaders,
  });
  check(
    'guests: 200, no cursor field',
    guests.status === 200 && isObj(guests.json) && !('cursor' in guests.json),
    guests.json,
  );
  const guestItems =
    isObj(guests.json) && Array.isArray(guests.json.items) ? guests.json.items : [];
  const firstGuest = guestItems.find(isObj);
  check(
    'guest row: {id,name,ticketType,entryType,quantity,source,status,enteredAt,scansUsed,scansAllowed}',
    firstGuest !== undefined &&
      typeof firstGuest.id === 'string' &&
      typeof firstGuest.name === 'string' &&
      typeof firstGuest.ticketType === 'string' &&
      typeof firstGuest.entryType === 'string' &&
      (firstGuest.status === 'entered' || firstGuest.status === 'not_entered'),
    firstGuest,
  );
  if (firstGuest !== undefined) {
    const manualCheckIn = await call('POST', '/api/v2/door/guests/check-in', {
      body: { eventId: EVENT_ID, entitlementId: firstGuest.id },
      headers: sessionHeaders,
    });
    check(
      'manual check-in: {guest, checkInId} — NOT the camera-scan union',
      isObj(manualCheckIn.json) &&
        isObj(manualCheckIn.json.guest) &&
        typeof manualCheckIn.json.checkInId === 'string' &&
        !('status' in manualCheckIn.json),
      manualCheckIn.json,
    );
  } else {
    console.warn('  (skipped manual check-in — no not_entered guest found)');
  }

  console.info('── heartbeat ─────────────────────────────────────────────');
  const heartbeat = await call('POST', '/api/v2/door/heartbeat', {
    body: { eventId: EVENT_ID },
    headers: sessionHeaders,
  });
  check('heartbeat: 2xx', heartbeat.status >= 200 && heartbeat.status < 300, heartbeat.json);

  console.info('── door entry: walk-in + dine-in ────────────────────────');
  const walkInKey = `seed_e2e_walkin_${String(Date.now())}`;
  const walkIn = await call('POST', '/api/v2/door/walk-in', {
    body: {
      eventId: EVENT_ID,
      guestName: 'Seed Walkin Guest',
      totalGuests: 1,
      paymentMode: 'cash',
      idempotencyKey: walkInKey,
    },
    headers: sessionHeaders,
  });
  check(
    'walk-in: {id,eventId,category,guestName,totalGuests,amountPaise,paymentMode,status,createdAt}',
    isObj(walkIn.json) &&
      walkIn.json.category === 'walkin' &&
      typeof walkIn.json.amountPaise === 'number' &&
      typeof walkIn.json.totalGuests === 'number',
    walkIn.json,
  );
  const dineInKey = `seed_e2e_dinein_${String(Date.now())}`;
  const dineIn = await call('POST', '/api/v2/door/dine-in', {
    body: {
      eventId: EVENT_ID,
      guestName: 'Seed Dinein Guest',
      totalGuests: 3,
      paymentMode: 'card',
      idempotencyKey: dineInKey,
    },
    headers: sessionHeaders,
  });
  check(
    'dine-in: category=dinein, totalGuests=3',
    isObj(dineIn.json) && dineIn.json.category === 'dinein' && dineIn.json.totalGuests === 3,
    dineIn.json,
  );

  const sales = await call('GET', `/api/v2/door/sales?eventId=${EVENT_ID}&category=walkin`, {
    headers: sessionHeaders,
  });
  check(
    'door sales: 200, items array',
    sales.status === 200 && isObj(sales.json) && Array.isArray(sales.json.items),
    sales.json,
  );

  console.info('── ticket sale + idempotent replay ──────────────────────');
  const saleKey = `seed_e2e_sale_${String(Date.now())}`;
  const saleBody = {
    eventId: EVENT_ID,
    tierId: TIER_ID,
    quantity: 1,
    paymentMode: 'cash',
    guestName: 'Seed Sale Guest',
    idempotencyKey: saleKey,
  };
  const sale1 = await call('POST', '/api/v2/door/ticket-sale', {
    body: saleBody,
    headers: sessionHeaders,
  });
  check(
    'ticket-sale: {orderId,amountPaise,quantity,paymentMode,ticketIds,checkInIds,replayed:false}',
    isObj(sale1.json) &&
      typeof sale1.json.orderId === 'string' &&
      Array.isArray(sale1.json.ticketIds) &&
      sale1.json.replayed === false,
    sale1.json,
  );
  const sale2 = await call('POST', '/api/v2/door/ticket-sale', {
    body: saleBody,
    headers: sessionHeaders,
  });
  check(
    'ticket-sale retry (same idempotencyKey): replayed=true, same orderId — guest not charged twice',
    isObj(sale2.json) &&
      sale2.json.replayed === true &&
      isObj(sale1.json) &&
      sale2.json.orderId === sale1.json.orderId,
    sale2.json,
  );

  console.info('── staff-deny + override ────────────────────────────────');
  const staffDeny = await call('POST', '/api/v2/door/staff-deny', {
    body: { eventId: EVENT_ID, reason: 'Seed E2E: refused, no ticket presented' },
    headers: sessionHeaders,
  });
  check(
    // The real response is the full CheckInDto (`id`, not `checkInId`) —
    // confirmed against a live gateway response after the contract doc's
    // abbreviated shape turned out not to match.
    'staff-deny: {id, status:denied, denyReason}',
    isObj(staffDeny.json) &&
      staffDeny.json.status === 'denied' &&
      typeof staffDeny.json.id === 'string',
    staffDeny.json,
  );
  const deniedCheckInId = isObj(staffDeny.json) ? (staffDeny.json.id as string) : '';
  const override = await call('POST', '/api/v2/door/override', {
    body: { checkInId: deniedCheckInId, reason: 'Seed E2E: manager override test' },
    headers: sessionHeaders,
  });
  check(
    'override: {checkInId, status:overridden, overriddenBy, overrideReason}',
    isObj(override.json) &&
      override.json.status === 'overridden' &&
      typeof override.json.overriddenBy === 'string',
    override.json,
  );

  console.info('── stats ─────────────────────────────────────────────────');
  const stats = await call('GET', `/api/v2/door/stats?eventId=${EVENT_ID}`, {
    headers: sessionHeaders,
  });
  check(
    'stats: {eventId, occupancy:{inside,capacity,remaining,prebooked}}',
    isObj(stats.json) &&
      isObj(stats.json.occupancy) &&
      typeof stats.json.occupancy.inside === 'number',
    stats.json,
  );

  console.info('── cover-wallet charging (charge-only code) ─────────────');
  const deviceId2 = `seed_e2e_device_charge_${String(Date.now())}`;
  await call('POST', '/api/v2/door/devices', {
    body: { deviceId: deviceId2, deviceName: 'Seed E2E Charge Device' },
    headers: authHeaders,
  });
  const redeemCharge = await call('POST', '/api/v2/door/sessions', {
    body: {
      eventId: EVENT_ID,
      code: CHARGE_CODE,
      deviceId: deviceId2,
      deviceName: 'Seed E2E Charge Device',
      sessionType: 'staff',
    },
    headers: authHeaders,
  });
  check(
    'redeem charge code: 200/201',
    redeemCharge.status === 200 || redeemCharge.status === 201,
    redeemCharge.json,
  );
  const chargeSessionToken = isObj(redeemCharge.json)
    ? (redeemCharge.json.sessionToken as string)
    : '';
  const chargeSessionHeaders = { ...authHeaders, 'x-scanner-session-token': chargeSessionToken };
  check(
    'charge code grants canCharge, not canWalkIn',
    isObj(redeemCharge.json) &&
      isObj(redeemCharge.json.permissions) &&
      redeemCharge.json.permissions.canCharge === true &&
      redeemCharge.json.permissions.canWalkIn === false,
    isObj(redeemCharge.json) ? redeemCharge.json.permissions : undefined,
  );

  const windowStart = Math.floor(Date.now() / 1000 / 30) * 30;
  const walletHmac = createHmac('sha256', gateway.MAGIC_TICKET_SECRET)
    .update(`wallet:${WALLET_ID}:${String(windowStart)}`)
    .digest('hex');
  const freshWalletQr = `cw:${WALLET_ID}:${String(windowStart)}:${walletHmac}`;

  const walletQr = await call('POST', '/api/v2/door/wallet-qr', {
    body: { eventId: EVENT_ID, qrPayload: freshWalletQr },
    headers: chargeSessionHeaders,
  });
  check(
    'wallet-qr: {walletId,eventId,guestFirstName,status,balancePaise,presetItems,minChargePaise,maxChargePaise}',
    isObj(walletQr.json) &&
      walletQr.json.walletId === WALLET_ID &&
      Array.isArray(walletQr.json.presetItems) &&
      walletQr.json.status === 'active',
    walletQr.json,
  );
  const presetItems =
    isObj(walletQr.json) && Array.isArray(walletQr.json.presetItems)
      ? walletQr.json.presetItems
      : [];
  const firstItem = presetItems.find(isObj);
  if (firstItem !== undefined) {
    const chargeKey = `seed_e2e_charge_${String(Date.now())}`;
    const charge = await call('POST', '/api/v2/door/wallet-charge', {
      body: {
        eventId: EVENT_ID,
        qrPayload: freshWalletQr,
        presetItemId: firstItem.id,
        quantity: 1,
        idempotencyKey: chargeKey,
      },
      headers: chargeSessionHeaders,
    });
    check(
      'wallet-charge: {charged:{itemId,label,quantity,amountPaise}, balancePaise}',
      isObj(charge.json) &&
        isObj(charge.json.charged) &&
        typeof charge.json.balancePaise === 'number',
      charge.json,
    );
  } else {
    console.warn('  (skipped wallet-charge — no preset item found)');
  }

  console.info('');
  console.info(`═══ ${String(passed)} passed, ${String(failed)} failed ═══`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
