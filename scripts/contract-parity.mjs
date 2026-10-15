/**
 * ─── Frontend ↔ backend contract parity (B02 / B13) ──────────────────────────
 *
 * Two repos, one wire contract. `C1RCLE-FRONTEND` owns `@c1rcle/types` +
 * `@c1rcle/api-client`; this repo owns `packages/contracts`. Nothing is
 * published yet, so drift is caught here instead of in production.
 *
 * The check is **behavioural, not textual**: every fixture below is parsed by
 * BOTH the frontend schema and the backend schema, and the two must agree on
 * accept/reject. A formatting change can never fail this; a real constraint
 * change always will.
 *
 * The fixtures themselves live in packages/contracts/parity/cases.mjs.
 *
 * Usage:  node scripts/contract-parity.mjs [--frontend <path>]
 * Exit 0 = contracts agree. Exit 1 = drift (CI fails). Exit 2 = cannot check.
 */
import { existsSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The frontend's compiled schemas import a bare `zod`, which they cannot
 * resolve from outside their own workspace. Redirect that specifier to this
 * repo's zod. Both sides then build their schemas with the SAME zod build, so
 * any disagreement below is a real constraint difference rather than a
 * version artefact — which is exactly the comparison we want.
 */
// Resolved from the contracts package, which is the workspace that declares zod.
const zodRequire = createRequire(join(ROOT, 'packages/contracts/package.json'));
const zodUrl = pathToFileURL(zodRequire.resolve('zod')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'zod') return { url: zodUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

function frontendRoot() {
  const flagIndex = process.argv.indexOf('--frontend');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return resolve(process.argv[flagIndex + 1]);
  }
  if (process.env.C1RCLE_FRONTEND_PATH) return resolve(process.env.C1RCLE_FRONTEND_PATH);
  return resolve(ROOT, '..', 'C1RCLE-FRONTEND');
}

const FRONTEND = frontendRoot();

/*
 * The frontend wire contract lives in its own generated package,
 * `<frontend>/packages/contracts` (spec §5 — mirrored from this repo by
 * `scripts/export-contracts.mjs`, built to `dist/` because Next does not
 * transpile workspace TS). Its `./client` entry mirrors this repo's
 * `packages/contracts/src/client.ts` export-for-export, so it is what we read.
 *
 * Before Phase 2 that package does not exist. The pre-Phase-2 home for the
 * shared schemas was `packages/api-client/dist/schemas.js`, but it only ever
 * carried role / user / session / pagination — not the auth-bridge, onboarding,
 * organization or partner schemas this check now covers. So when the contracts
 * package is absent we cannot run a meaningful check: exit 2 ("cannot check"),
 * never a crash.
 */
const FE_CONTRACTS_DIR = join(FRONTEND, 'packages/contracts/dist');
const FE_CONTRACTS_MAIN = join(FE_CONTRACTS_DIR, 'index.js');
const FE_CONTRACTS_CLIENT = join(FE_CONTRACTS_DIR, 'client.js');
const FE_APICLIENT_SCHEMAS = join(FRONTEND, 'packages/api-client/dist/schemas.js'); // pre-Phase-2 (legacy)
const FRONTEND_ERRORS = join(FRONTEND, 'packages/api-client/dist/errors.js');

if (!existsSync(FE_CONTRACTS_MAIN) || !existsSync(FE_CONTRACTS_CLIENT)) {
  console.error('Contract parity: the frontend @c1rcle/contracts package is not built yet.');
  console.error(`  expected: ${FE_CONTRACTS_CLIENT}`);
  console.error(`  frontend root: ${FRONTEND}  (--frontend <path> or C1RCLE_FRONTEND_PATH)`);
  console.error('  This lands in Phase 2 — scaffold packages/contracts, then:');
  console.error('    node ../C1RCLE-BACKEND/scripts/export-contracts.mjs --frontend .');
  console.error('    pnpm --filter @c1rcle/contracts build');
  if (existsSync(FE_APICLIENT_SCHEMAS)) {
    console.error(`  (legacy ${FE_APICLIENT_SCHEMAS} exists but predates these schemas.)`);
  }
  process.exit(2);
}

if (!existsSync(FRONTEND_ERRORS)) {
  console.error('Contract parity: cannot locate the frontend error module.');
  console.error(`  expected: ${FRONTEND_ERRORS}  (build: pnpm --filter @c1rcle/api-client build)`);
  process.exit(2);
}

/*
 * Both sides are read from BUILT output. This repo's `packages/contracts/src`
 * uses NodeNext `.js` import specifiers that plain `node` cannot resolve back to
 * `.ts` under type-stripping, so the check reads `packages/contracts/dist`
 * instead — symmetric with the frontend (also `dist`), and it means the check
 * validates exactly what a consumer resolves.
 */
const BACKEND_DIR = join(ROOT, 'packages/contracts/dist');
const BACKEND_CLIENT = join(BACKEND_DIR, 'client.js');
const BACKEND_INDEX = join(BACKEND_DIR, 'index.js');
if (!existsSync(BACKEND_CLIENT) || !existsSync(BACKEND_INDEX)) {
  console.error('Contract parity: packages/contracts is not built.');
  console.error(`  expected: ${BACKEND_CLIENT}`);
  console.error('  build it: pnpm --filter @c1rcle/contracts build');
  process.exit(2);
}

const FRONTEND_SCHEMAS = FE_CONTRACTS_CLIENT;

const frontend = await import(pathToFileURL(FRONTEND_SCHEMAS).href);
const frontendErrors = await import(pathToFileURL(FRONTEND_ERRORS).href);
const backend = await import(pathToFileURL(BACKEND_CLIENT).href);
const backendEnvelope = await import(pathToFileURL(BACKEND_INDEX).href);
// The fixtures live with the contracts they pin, not in this script.
const { runParityCases } = await import(
  pathToFileURL(join(ROOT, 'packages/contracts/parity/cases.mjs')).href
);

const failures = [];
const checks = [];

/** Asserts both schemas reach the same verdict on one fixture. */
function agree(schemaName, label, value, expected) {
  const front = frontend[schemaName];
  const back = backend[schemaName];
  if (!front) {
    failures.push(`frontend is missing schema \`${schemaName}\``);
    return;
  }
  if (!back) {
    failures.push(`backend packages/contracts is missing schema \`${schemaName}\``);
    return;
  }
  const frontOk = front.safeParse(value).success;
  const backOk = back.safeParse(value).success;
  checks.push(`${schemaName}: ${label}`);

  if (frontOk !== backOk) {
    failures.push(
      `DRIFT ${schemaName} — "${label}": frontend ${frontOk ? 'accepts' : 'rejects'}, ` +
        `backend ${backOk ? 'accepts' : 'rejects'}`,
    );
    return;
  }
  if (frontOk !== expected) {
    failures.push(
      `BOTH WRONG ${schemaName} — "${label}": expected ${expected ? 'accept' : 'reject'}, ` +
        `both ${frontOk ? 'accepted' : 'rejected'}`,
    );
  }
}

await runParityCases({
  agree,
  frontend,
  backend,
  frontendErrors,
  backendEnvelope,
  zodUrl,
  checks,
  failures,
});

/* ── door / scanner surface (phase 5) ─────────────────────────────────────── */
/*
 * M3: the scanner app hand-transcribes these shapes (`apps/scanner-app/src/api/
 * schemas.ts`) instead of importing the shared contracts, so drift there is
 * invisible to the graph. These fixtures at least pin the door surface between
 * the two contract copies, and give the scanner migration a target to match.
 */
const VALID_DOOR_ENTITLEMENT = {
  id: 'ent_1',
  tierId: 'tier_1',
  tierName: 'General',
  holderName: 'Guest',
  scansUsed: 1,
  scansAllowed: 2,
  status: 'active',
};

/* scan outcome (the camera path) */
agree(
  'scanResponseSchema',
  'accepts a consumed scan with an entitlement',
  { status: 'consumed', checkInId: 'chk_1', entitlement: VALID_DOOR_ENTITLEMENT },
  true,
);
agree(
  'scanResponseSchema',
  'accepts a denied scan with a reason',
  { status: 'denied', denyReason: 'already_used', denyMessage: 'Ticket already used' },
  true,
);
agree(
  'scanResponseSchema',
  'accepts a couple confirmation with no checkInId',
  {
    status: 'confirmation_required',
    confirmation: { token: 'tok_abcdefghij', expiresAt: ISO, seats: 2 },
  },
  true,
);
agree('scanResponseSchema', 'rejects an unknown scan status', { status: 'admitted' }, false);

/* non-mutating preview — its own valid | invalid vocabulary */
agree(
  'ticketLookupResponseSchema',
  'accepts a valid preview with an entitlement',
  { status: 'valid', denyReason: null, denyMessage: null, entitlement: VALID_DOOR_ENTITLEMENT },
  true,
);
agree(
  'ticketLookupResponseSchema',
  'accepts an invalid preview with a deny reason',
  { status: 'invalid', denyReason: 'expired', denyMessage: 'Ticket expired' },
  true,
);
agree(
  'ticketLookupResponseSchema',
  'rejects the check-in `consumed` vocabulary',
  { status: 'consumed', denyReason: null, denyMessage: null },
  false,
);

/* door ledger row */
const VALID_CHECK_IN = {
  id: 'chk_1',
  eventId: 'evt_1',
  status: 'consumed',
  denyReason: null,
  denyMessage: null,
  entitlementId: 'ent_1',
  tierId: 'tier_1',
  tierName: 'General',
  operatorUid: 'usr_1',
  operatorName: 'Ops',
  operatorRole: 'staff',
  gate: 'A',
  deviceId: 'dev_1',
  guestName: 'Guest',
  scannedAt: ISO,
  admittedCount: 1,
  scanCountUsed: 1,
  scanCountAllowed: 2,
  isOffline: false,
  overriddenBy: null,
  overrideReason: null,
  createdAt: ISO,
};
agree('checkInDtoSchema', 'accepts a canonical consumed ledger row', VALID_CHECK_IN, true);
agree(
  'checkInDtoSchema',
  'rejects an unknown ledger status',
  { ...VALID_CHECK_IN, status: 'used' },
  false,
);

/* override */
agree(
  'overrideResponseSchema',
  'accepts an override result',
  {
    checkInId: 'chk_1',
    status: 'overridden',
    overriddenBy: 'usr_1',
    overrideReason: 'Manager approved',
  },
  true,
);
agree(
  'overrideResponseSchema',
  'rejects a non-overridden status',
  { checkInId: 'chk_1', status: 'consumed', overriddenBy: 'usr_1', overrideReason: 'x' },
  false,
);

/* door stats snapshot */
const VALID_DOOR_STATS = {
  eventId: 'evt_1',
  occupancy: { inside: 10, capacity: 100, remaining: 90, prebooked: 5, doorEntries: 3 },
  byEntryType: { general: 5 },
  scans: {
    total: 10,
    consumed: 8,
    denied: 1,
    pending: 0,
    revoked: 0,
    overridden: 1,
    expired: 0,
    cancelled: 0,
  },
  doorSales: { count: 2, grossPaise: 2000 },
  coverWallet: {
    activeWallets: 1,
    totalBalancePaise: 5000,
    totalCreditsPaise: 5000,
    totalDebitsPaise: 0,
  },
  generatedAt: ISO,
};
agree('doorStatsDtoSchema', 'accepts a canonical door stats snapshot', VALID_DOOR_STATS, true);
agree(
  'doorStatsDtoSchema',
  'rejects a negative occupancy count',
  { ...VALID_DOOR_STATS, occupancy: { ...VALID_DOOR_STATS.occupancy, inside: -1 } },
  false,
);

/* roster */
const VALID_DOOR_GUEST = {
  id: 'ent_1',
  name: 'Guest',
  ticketType: 'General',
  entryType: 'general',
  quantity: 1,
  source: 'online',
  status: 'entered',
  enteredAt: ISO,
  scansUsed: 1,
  scansAllowed: 1,
};
agree('doorGuestSchema', 'accepts a canonical door guest', VALID_DOOR_GUEST, true);
agree(
  'doorGuestSchema',
  'rejects an unknown guest status',
  { ...VALID_DOOR_GUEST, status: 'used' },
  false,
);
agree(
  'doorGuestListResponseSchema',
  'accepts items + truncated',
  { items: [VALID_DOOR_GUEST], truncated: false },
  true,
);
agree(
  'doorGuestListResponseSchema',
  'rejects a roster missing the truncated flag',
  { items: [VALID_DOOR_GUEST] },
  false,
);
agree(
  'manualCheckInResponseSchema',
  'accepts a manual admission result',
  { guest: VALID_DOOR_GUEST, checkInId: 'chk_1' },
  true,
);

/* door sales */
const VALID_DOOR_SALE = {
  id: 'sale_1',
  eventId: 'evt_1',
  category: 'walkin',
  guestName: 'Guest',
  totalGuests: 2,
  amountPaise: 1000,
  paymentMode: 'cash',
  status: 'active',
  createdAt: ISO,
};
agree('doorSaleResponseSchema', 'accepts a canonical door sale', VALID_DOOR_SALE, true);
agree(
  'doorSaleResponseSchema',
  'rejects an unknown sale category',
  { ...VALID_DOOR_SALE, category: 'takeaway' },
  false,
);
agree(
  'doorSalesListResponseSchema',
  'accepts items + pageInfo',
  { items: [VALID_DOOR_SALE], pageInfo: VALID_PAGE_INFO },
  true,
);
agree(
  'doorSalesListResponseSchema',
  'rejects a list missing pageInfo',
  { items: [VALID_DOOR_SALE] },
  false,
);

/* staff deny body */
agree(
  'staffDenyBodySchema',
  'accepts a staff deny body',
  { eventId: 'evt_1', reason: 'Guest refused entry' },
  true,
);
agree('staffDenyBodySchema', 'rejects a missing reason', { eventId: 'evt_1' }, false);

/* scanner session + device */
const VALID_SCANNER_SESSION = {
  id: 'ses_1',
  eventId: 'evt_1',
  codeId: 'code_1',
  sessionToken: 'tok_abcdefghij',
  sessionExpiresAt: ISO,
  deviceId: 'dev_1',
  deviceName: 'Door Phone',
  permissions: { canScan: true, canDoorEntry: true, canWalkIn: true, canCharge: true },
  status: 'active',
  createdAt: ISO,
};
agree('scannerSessionDtoSchema', 'accepts an active scanner session', VALID_SCANNER_SESSION, true);
agree(
  'scannerSessionDtoSchema',
  'accepts a revoked session with a null token',
  { ...VALID_SCANNER_SESSION, status: 'revoked', sessionToken: null },
  true,
);
agree(
  'scannerSessionDtoSchema',
  'rejects an unknown session status',
  { ...VALID_SCANNER_SESSION, status: 'closed' },
  false,
);

const VALID_SCANNER_DEVICE = {
  id: 'dev_row_1',
  deviceId: 'dev_1',
  deviceName: 'Door Phone',
  venueId: 'ven_1',
  status: 'active',
  boundAt: ISO,
  unboundAt: null,
  unboundReason: null,
  lastSeenAt: ISO,
  lastEventId: null,
  lastGate: null,
  scanCount: 0,
  lastScanAt: null,
  lastScanResult: null,
};
agree('scannerDeviceDtoSchema', 'accepts a canonical scanner device', VALID_SCANNER_DEVICE, true);
agree(
  'scannerDeviceDtoSchema',
  'rejects an unknown device status',
  { ...VALID_SCANNER_DEVICE, status: 'retired' },
  false,
);

/* door event summary */
const VALID_DOOR_EVENT = {
  id: 'evt_1',
  title: 'Neon Night',
  slug: 'neon-night',
  venueId: 'ven_1',
  startAt: ISO,
  endAt: null,
  status: 'published',
  capacity: 100,
};
agree('doorEventSummarySchema', 'accepts a door event summary', VALID_DOOR_EVENT, true);
agree(
  'doorEventSummarySchema',
  'accepts a null capacity (unconfigured)',
  { ...VALID_DOOR_EVENT, capacity: null },
  true,
);
agree(
  'doorEventSummarySchema',
  'rejects a missing title',
  { ...VALID_DOOR_EVENT, title: undefined },
  false,
);

/* start shift — one round trip, must carry the stats snapshot */
agree(
  'startShiftResponseSchema',
  'accepts a full shift-start payload',
  {
    sessionId: 'ses_1',
    sessionToken: 'tok_abcdefghij',
    sessionExpiresAt: ISO,
    event: VALID_DOOR_EVENT,
    permissions: { canScan: true, canDoorEntry: true, canWalkIn: true, canCharge: true },
    gate: null,
    tiers: [
      { id: 'tier_1', name: 'General', entryType: 'general', pricePaise: 500, available: 100 },
    ],
    stats: VALID_DOOR_STATS,
    device: { deviceId: 'dev_1', deviceName: 'Door Phone' },
  },
  true,
);
agree(
  'startShiftResponseSchema',
  'rejects a shift payload missing the stats snapshot',
  {
    sessionId: 'ses_1',
    sessionToken: 'tok_abcdefghij',
    sessionExpiresAt: ISO,
    event: VALID_DOOR_EVENT,
    permissions: { canScan: true, canDoorEntry: true, canWalkIn: true, canCharge: true },
    gate: null,
    tiers: [],
    device: { deviceId: 'dev_1', deviceName: 'Door Phone' },
  },
  false,
);

/* couple confirmation body */
agree(
  'confirmCoupleBodySchema',
  'accepts a couple confirmation body',
  { eventId: 'evt_1', confirmationToken: 'confirmation_token_value', confirmed: true },
  true,
);
agree(
  'confirmCoupleBodySchema',
  'rejects a missing confirmed flag',
  { eventId: 'evt_1', confirmationToken: 'confirmation_token_value' },
  false,
);

/* paid walk-up ticket sale response */
agree(
  'doorTicketSaleResponseSchema',
  'accepts a replayed door ticket sale',
  {
    orderId: 'ord_1',
    amountPaise: 1000,
    quantity: 1,
    paymentMode: 'cash',
    ticketIds: ['tkt_1'],
    checkInIds: ['chk_1'],
    replayed: true,
  },
  true,
);
agree(
  'doorTicketSaleResponseSchema',
  'rejects a fractional quantity',
  {
    orderId: 'ord_1',
    amountPaise: 1000,
    quantity: 1.5,
    paymentMode: 'cash',
    ticketIds: [],
    checkInIds: [],
    replayed: false,
  },
  false,
);

/* cover wallet */
const VALID_COVER_WALLET = {
  id: 'wal_1',
  eventId: 'evt_1',
  userId: 'usr_1',
  balancePaise: 5000,
  status: 'active',
  openingBalancePaise: 5000,
  totalCreditsPaise: 5000,
  totalDebitsPaise: 0,
  terminatedAt: null,
  createdAt: ISO,
};
agree('coverWalletResponseSchema', 'accepts an active cover wallet', VALID_COVER_WALLET, true);
agree(
  'coverWalletResponseSchema',
  'rejects an unknown wallet status',
  { ...VALID_COVER_WALLET, status: 'paused' },
  false,
);

/* ── report ───────────────────────────────────────────────────────────────── */
if (failures.length > 0) {
  console.error(`Contract parity: ${failures.length} problem(s) across ${checks.length} checks\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    '\nContracts are backend-owned: fix packages/contracts first, then the frontend copy.',
  );
  process.exit(1);
}

console.log(`Contract parity: clean — ${checks.length} checks agree with ${FRONTEND}`);
