import { createHmac } from 'node:crypto';

import { getGatewayConfig } from '../config/index.js';

/**
 * ─── Phase 2 exit criterion: idempotency under a double-tap ────────────────
 *
 * `06-v1-vs-v2-and-rollout.md`'s Phase 2 exit criterion calls for "an actual
 * double-tap test under simulated flaky network," not just a code review.
 * There's no physical device or throttled network in this environment, but
 * the property that test protects — one user tap must never become two
 * charges — is testable directly: fire the SAME idempotency key TWICE,
 * concurrently, at the real backend, and assert exactly one charge landed.
 *
 * Concurrent is deliberately stricter than a sequential retry (already
 * covered by `e2e-scanner-check.ts`'s replay check): a flaky-network retry
 * from a real client can arrive at the server before the first attempt's
 * transaction has committed, which is exactly the shape that exposes a
 * check-then-act race a purely sequential test cannot.
 *
 * Requires `seed-scanner-e2e.ts` to have been run first.
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
  console.error('Usage: tsx e2e-double-tap-check.ts <fullDoorCode> <chargeDoorCode> <walletId>');
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
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
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

/**
 * The safe outcome of a true double-tap is not "both calls return the same
 * id" — it is "exactly one side effect happened". The atomic idempotency
 * claim (`FirestoreIdempotencyStore.claim`, via `runIdempotent`) makes the
 * losing concurrent request fail outright with a clean 409
 * `already in flight`, rather than silently deduping to the same response.
 * That is a pass, not a race: nothing was double-created, and the loser
 * got an honest, clean answer it can retry.
 */
function isCleanInFlightConflict(response: { status: number; json: unknown }): boolean {
  return (
    response.status === 409 &&
    isObj(response.json) &&
    typeof response.json.message === 'string' &&
    response.json.message.includes('already in flight')
  );
}

/**
 * Fires the same call twice, at the same instant, with the same
 * idempotency key — the actual race a client retry can produce, not an
 * approximation of one.
 */
async function doubleTap(
  makeCall: () => Promise<{ status: number; json: unknown }>,
): Promise<[{ status: number; json: unknown }, { status: number; json: unknown }]> {
  return Promise.all([makeCall(), makeCall()]);
}

async function main(): Promise<void> {
  const gateway = getGatewayConfig();
  if (!gateway.MAGIC_TICKET_SECRET) throw new Error('MAGIC_TICKET_SECRET required.');

  const login = await call(
    'POST',
    '/api/v2/auth/login',
    { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    {},
  );
  const accessToken = isObj(login.json) ? (login.json.accessToken as string) : '';
  const authHeaders = { authorization: `Bearer ${accessToken}`, 'x-organization-id': ORG_ID };

  const deviceId = `seed_e2e_dtap_${String(Date.now())}`;
  await call(
    'POST',
    '/api/v2/door/devices',
    { deviceId, deviceName: 'Double Tap Device' },
    authHeaders,
  );
  const redeem = await call(
    'POST',
    '/api/v2/door/sessions',
    {
      eventId: EVENT_ID,
      code: FULL_CODE,
      deviceId,
      deviceName: 'Double Tap Device',
      sessionType: 'staff',
    },
    authHeaders,
  );
  const sessionToken = isObj(redeem.json) ? (redeem.json.sessionToken as string) : '';
  const sessionHeaders = { ...authHeaders, 'x-scanner-session-token': sessionToken };
  check('setup: session redeemed', sessionToken.length > 0, redeem.json);

  // ── Walk-in ────────────────────────────────────────────────────────────
  {
    const key = `dtap_walkin_${String(Date.now())}`;
    const body = {
      eventId: EVENT_ID,
      guestName: 'Double Tap Walkin',
      totalGuests: 2,
      paymentMode: 'cash',
      idempotencyKey: key,
    };
    const [a, b] = await doubleTap(() =>
      call('POST', '/api/v2/door/walk-in', body, sessionHeaders),
    );
    const aId = isObj(a.json) ? a.json.id : undefined;
    const bId = isObj(b.json) ? b.json.id : undefined;
    const oneWinnerOneCleanConflict =
      (typeof aId === 'string' && isCleanInFlightConflict(b)) ||
      (typeof bId === 'string' && isCleanInFlightConflict(a));
    check(
      'walk-in double-tap: exactly one door-sale row created, the other cleanly rejected',
      oneWinnerOneCleanConflict,
      { a: a.json, b: b.json },
    );
  }

  // ── Dine-in ────────────────────────────────────────────────────────────
  {
    const key = `dtap_dinein_${String(Date.now())}`;
    const body = {
      eventId: EVENT_ID,
      guestName: 'Double Tap Dinein',
      totalGuests: 4,
      paymentMode: 'upi',
      idempotencyKey: key,
    };
    const [a, b] = await doubleTap(() =>
      call('POST', '/api/v2/door/dine-in', body, sessionHeaders),
    );
    const aId = isObj(a.json) ? a.json.id : undefined;
    const bId = isObj(b.json) ? b.json.id : undefined;
    const oneWinnerOneCleanConflict =
      (typeof aId === 'string' && isCleanInFlightConflict(b)) ||
      (typeof bId === 'string' && isCleanInFlightConflict(a));
    check(
      'dine-in double-tap: exactly one door-sale row created, the other cleanly rejected',
      oneWinnerOneCleanConflict,
      { a: a.json, b: b.json },
    );
  }

  // ── Ticket sale — the money call with the most to lose from a race ─────
  {
    const key = `dtap_sale_${String(Date.now())}`;
    const body = {
      eventId: EVENT_ID,
      tierId: TIER_ID,
      quantity: 1,
      paymentMode: 'cash',
      guestName: 'Double Tap Sale',
      idempotencyKey: key,
    };
    const [a, b] = await doubleTap(() =>
      call('POST', '/api/v2/door/ticket-sale', body, sessionHeaders),
    );
    const aOrder = isObj(a.json) ? a.json.orderId : undefined;
    const bOrder = isObj(b.json) ? b.json.orderId : undefined;
    // Same claim mechanics as walk-in/dine-in now (see door-ops-routes.ts):
    // the loser gets a clean in-flight 409, not a stored replay of the
    // winner's response — a genuine sequential retry (not a concurrent
    // double-tap) is what exercises the `replayed: true` path instead.
    const oneWinnerOneCleanConflict =
      (typeof aOrder === 'string' && isCleanInFlightConflict(b)) ||
      (typeof bOrder === 'string' && isCleanInFlightConflict(a));
    check(
      'ticket-sale double-tap: exactly one order/ticket created, the other cleanly rejected',
      oneWinnerOneCleanConflict,
      { a: a.json, b: b.json },
    );
  }

  // ── Cover-wallet charge ─────────────────────────────────────────────────
  {
    const chargeDeviceId = `seed_e2e_dtap_charge_${String(Date.now())}`;
    await call(
      'POST',
      '/api/v2/door/devices',
      { deviceId: chargeDeviceId, deviceName: 'Double Tap Charge Device' },
      authHeaders,
    );
    const chargeRedeem = await call(
      'POST',
      '/api/v2/door/sessions',
      {
        eventId: EVENT_ID,
        code: CHARGE_CODE,
        deviceId: chargeDeviceId,
        deviceName: 'Double Tap Charge Device',
        sessionType: 'staff',
      },
      authHeaders,
    );
    const chargeSessionToken = isObj(chargeRedeem.json)
      ? (chargeRedeem.json.sessionToken as string)
      : '';
    const chargeSessionHeaders = { ...authHeaders, 'x-scanner-session-token': chargeSessionToken };

    const windowStart = Math.floor(Date.now() / 1000 / 30) * 30;
    const walletHmac = createHmac('sha256', gateway.MAGIC_TICKET_SECRET)
      .update(`wallet:${WALLET_ID}:${String(windowStart)}`)
      .digest('hex');
    const walletQr = `cw:${WALLET_ID}:${String(windowStart)}:${walletHmac}`;

    const qrResolve = await call(
      'POST',
      '/api/v2/door/wallet-qr',
      { eventId: EVENT_ID, qrPayload: walletQr },
      chargeSessionHeaders,
    );
    const presetItems =
      isObj(qrResolve.json) && Array.isArray(qrResolve.json.presetItems)
        ? qrResolve.json.presetItems
        : [];
    const item = presetItems.find(isObj);
    const balanceBefore = isObj(qrResolve.json) ? (qrResolve.json.balancePaise as number) : 0;

    if (item === undefined) {
      check('wallet double-tap: had a preset item to charge', false, qrResolve.json);
    } else {
      const key = `dtap_charge_${String(Date.now())}`;
      const chargeBody = {
        eventId: EVENT_ID,
        qrPayload: walletQr,
        presetItemId: item.id,
        quantity: 1,
        idempotencyKey: key,
      };
      const [a, b] = await doubleTap(() =>
        call('POST', '/api/v2/door/wallet-charge', chargeBody, chargeSessionHeaders),
      );
      const aBalance = isObj(a.json) ? a.json.balancePaise : undefined;
      const bBalance = isObj(b.json) ? b.json.balancePaise : undefined;
      const amount = typeof item.amountPaise === 'number' ? item.amountPaise : 0;
      // Same claim mechanics as the other three now (see door-ops-routes.ts):
      // one side debits once, the other gets a clean in-flight 409 instead
      // of silently racing into a second debit.
      const oneWinnerOneCleanConflict =
        (aBalance === balanceBefore - amount && isCleanInFlightConflict(b)) ||
        (bBalance === balanceBefore - amount && isCleanInFlightConflict(a));
      check(
        'wallet double-tap: debited exactly once, the other side cleanly rejected',
        oneWinnerOneCleanConflict,
        { balanceBefore, amount, a: a.json, b: b.json },
      );
    }
  }

  console.info('');
  console.info(`═══ ${String(passed)} passed, ${String(failed)} failed ═══`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
