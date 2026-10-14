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
