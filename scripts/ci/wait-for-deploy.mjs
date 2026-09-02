#!/usr/bin/env node
/**
 * ─── Wait for Render to finish deploying THIS commit ─────────────────────────
 * Render auto-deploys on push, out of band from GitHub Actions. Smoke-testing
 * immediately after a push would hit the PREVIOUS build and pass, which is
 * worse than not testing at all.
 *
 * This polls `/api/v2/internal/version` until the reported `commit` matches the
 * SHA under test, then exits 0 so the smoke job can run against the right build.
 *
 *   node scripts/ci/wait-for-deploy.mjs \
 *     --url https://circle-v2-backend.onrender.com \
 *     --sha $GITHUB_SHA [--timeout 900] [--interval 15] [--grace 240]
 *
 * If the live build predates the `commit` field (it reports null), the script
 * cannot identify the build. It then waits `--grace` seconds for a restart,
 * and if the field never appears it exits 0 with a warning rather than
 * blocking the pipeline on a missing feature it cannot detect.
 *
 * Exit codes: 0 deployed (or unidentifiable, warned) · 1 timed out.
 */

const args = process.argv;
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const baseUrl = (arg('url') ?? '').replace(/\/+$/, '');
const targetSha = arg('sha', '');
const timeoutSec = Number(arg('timeout', '900'));
const intervalSec = Number(arg('interval', '15'));
const graceSec = Number(arg('grace', '240'));

if (!baseUrl || !targetSha) {
  console.error('::error::wait-for-deploy needs --url and --sha');
  process.exit(1);
}

const versionUrl = `${baseUrl}/api/v2/internal/version`;
const short = (sha) => sha.slice(0, 7);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(versionUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { state: 'http', detail: String(response.status) };
    const body = await response.json();
    return { state: 'ok', commit: body.commit ?? null, version: body.version ?? null };
  } catch (error) {
    return { state: 'unreachable', detail: error.message };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`Waiting for ${short(targetSha)} at ${versionUrl} (timeout ${timeoutSec}s)`);

const startedAt = Date.now();
let sawNullCommit = false;
let attempt = 0;

while ((Date.now() - startedAt) / 1000 < timeoutSec) {
  attempt += 1;
  const result = await probe();
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  if (result.state === 'ok' && result.commit) {
    if (result.commit === targetSha || result.commit.startsWith(short(targetSha))) {
      console.log(`Deployed: ${short(result.commit)} live after ${elapsed}s`);
      process.exit(0);
    }
    console.log(
      `[${elapsed}s] live commit ${short(result.commit)} != ${short(targetSha)} — waiting`,
    );
  } else if (result.state === 'ok') {
    sawNullCommit = true;
    console.log(`[${elapsed}s] live build reports no commit field — cannot identify build`);
    if (elapsed >= graceSec) {
      console.log(
        `::warning::The live build does not expose a commit SHA, so this deploy could not be ` +
          `positively identified. Smoke tests will run against whatever is currently live. ` +
          `This resolves itself once a build carrying RENDER_GIT_COMMIT is deployed.`,
      );
      process.exit(0);
    }
  } else {
    console.log(`[${elapsed}s] ${result.state}: ${result.detail} — retrying`);
  }

  await sleep(intervalSec * 1000);
}

console.error(
  `::error::Timed out after ${timeoutSec}s waiting for ${short(targetSha)} at ${versionUrl}. ` +
    (sawNullCommit
      ? 'The service answered but never reported a commit SHA.'
      : 'Check the Render dashboard for a failed or stuck deploy.') +
    ` (${attempt} probes)`,
);
process.exit(1);
