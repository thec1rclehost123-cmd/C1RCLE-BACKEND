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
const FRONTEND_SCHEMAS = join(FRONTEND, 'packages/api-client/dist/schemas.js');
const FRONTEND_ERRORS = join(FRONTEND, 'packages/api-client/dist/errors.js');

if (!existsSync(FRONTEND_SCHEMAS) || !existsSync(FRONTEND_ERRORS)) {
  console.error('Contract parity: cannot locate the frontend contract.');
  console.error(`  looked in: ${FRONTEND}`);
  console.error('  pass --frontend <path> or set C1RCLE_FRONTEND_PATH.');
  console.error('  (the frontend must be built: pnpm --filter @c1rcle/api-client build)');
  process.exit(2);
}

const frontend = await import(pathToFileURL(FRONTEND_SCHEMAS).href);
const frontendErrors = await import(pathToFileURL(FRONTEND_ERRORS).href);
const backend = await import(pathToFileURL(join(ROOT, 'packages/contracts/src/client.ts')).href);
const backendEnvelope = await import(
  pathToFileURL(join(ROOT, 'packages/contracts/src/index.ts')).href
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

const VALID_USER = {
  id: 'usr_1',
  email: 'partner@example.com',
  displayName: 'Sky Partner',
  role: 'partner',
  avatarUrl: null,
};

/* ── role ─────────────────────────────────────────────────────────────────── */
for (const role of ['guest', 'partner', 'admin']) {
  agree('roleSchema', `accepts ${role}`, role, true);
}
agree('roleSchema', 'rejects an unknown role', 'superadmin', false);
agree('roleSchema', 'rejects a non-string', 3, false);

/* ── user ─────────────────────────────────────────────────────────────────── */
agree('userSchema', 'accepts the canonical user', VALID_USER, true);
agree(
  'userSchema',
  'accepts an https avatar',
  { ...VALID_USER, avatarUrl: 'https://cdn.example.com/a.png' },
  true,
);
agree('userSchema', 'rejects a malformed email', { ...VALID_USER, email: 'not-an-email' }, false);
agree('userSchema', 'rejects a non-url avatar', { ...VALID_USER, avatarUrl: 'nope' }, false);
agree(
  'userSchema',
  'rejects a missing displayName',
  { ...VALID_USER, displayName: undefined },
  false,
);
agree('userSchema', 'rejects an unknown role', { ...VALID_USER, role: 'owner' }, false);

/* ── session ──────────────────────────────────────────────────────────────── */
agree(
  'sessionSchema',
  'accepts user + epoch ms',
  { user: VALID_USER, expiresAt: 1_800_000_000_000 },
  true,
);
agree(
  'sessionSchema',
  'rejects an ISO string expiry (epoch ms is the contract)',
  { user: VALID_USER, expiresAt: '2026-08-11T00:00:00Z' },
  false,
);
agree('sessionSchema', 'rejects a missing user', { expiresAt: 1 }, false);

/* ── pagination ───────────────────────────────────────────────────────────── */
const VALID_PAGE_INFO = { page: 1, pageSize: 20, total: 3, hasNextPage: false };
agree('pageInfoSchema', 'accepts the canonical page info', VALID_PAGE_INFO, true);
agree(
  'pageInfoSchema',
  'rejects a missing hasNextPage',
  { page: 1, pageSize: 20, total: 3 },
  false,
);
agree('pageInfoSchema', 'rejects a string page', { ...VALID_PAGE_INFO, page: '1' }, false);

/* ── 204 semantics ────────────────────────────────────────────────────────── */
agree('noContentSchema', 'accepts undefined (204, no body)', undefined, true);
agree('noContentSchema', 'rejects a body', {}, false);

/* ── paginated<T> (function, checked separately) ──────────────────────────── */
{
  const { z } = await import(zodUrl);
  const itemSchema = z.object({ id: z.string() });
  const item = { id: 'x' };
  const frontPaginated = frontend.paginatedSchema(itemSchema);
  const backPaginated = backend.paginatedSchema(itemSchema);
  const good = { items: [item], pageInfo: VALID_PAGE_INFO };
  const bad = { items: [item] };
  for (const [label, value, expected] of [
    ['accepts items + pageInfo', good, true],
    ['rejects a missing pageInfo', bad, false],
  ]) {
    const frontOk = frontPaginated.safeParse(value).success;
    const backOk = backPaginated.safeParse(value).success;
    checks.push(`paginatedSchema: ${label}`);
    if (frontOk !== backOk) {
      failures.push(
        `DRIFT paginatedSchema — "${label}": frontend ${frontOk ? 'accepts' : 'rejects'}, ` +
          `backend ${backOk ? 'accepts' : 'rejects'}`,
      );
    } else if (frontOk !== expected) {
      failures.push(`BOTH WRONG paginatedSchema — "${label}"`);
    }
  }
}

/* ── error envelope: status → code map ────────────────────────────────────── */
for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 418]) {
  const front = frontendErrors.statusToErrorCode(status);
  const back = backendEnvelope.errorCodeForStatus(status);
  checks.push(`errorCodeForStatus: ${status}`);
  // 4xx outside the mapped set is the one deliberate difference: the frontend
  // collapses it to 'unknown', and so must the backend.
  if (front !== back) {
    failures.push(`DRIFT status→code for ${status}: frontend "${front}", backend "${back}"`);
  }
}

/* ── error codes: the closed union must match exactly ─────────────────────── */
{
  const FRONTEND_CODES = [
    'network',
    'timeout',
    'aborted',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'validation',
    'rate_limited',
    'server',
    'parse',
    'unknown',
  ];
  // Backend codes are a type, not a value — probe the builder instead.
  const unreachable = FRONTEND_CODES.filter((code) => {
    const body = backendEnvelope.buildV2ErrorResponse({ status: 400, message: 'x', code });
    return body.code !== code;
  });
  checks.push('ApiErrorCode union');
  if (unreachable.length > 0) {
    failures.push(
      `DRIFT error codes unsupported by the backend envelope: ${unreachable.join(', ')}`,
    );
  }
}

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
