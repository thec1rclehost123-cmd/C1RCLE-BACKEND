#!/usr/bin/env node
/**
 * ─── Post-deploy smoke tests ─────────────────────────────────────────────────
 * Black-box assertions against the live gateway. Every check below was verified
 * against https://circle-v2-backend.onrender.com before being written, so a
 * failure here means the deployment actually regressed — not that the test was
 * guessed wrong.
 *
 *   node scripts/ci/smoke.mjs --url https://circle-v2-backend.onrender.com
 *                             [--timeout 20000] [--retries 3]
 *
 * The readiness and version endpoints sit behind an nginx gate that answers
 * 404 without an X-Readiness-Token header. Wire the value via the
 * NGINX_READINESS_TOKEN env var (CI repo secret) or --token; without it those
 * two checks are skipped with a warning rather than failed, so the script
 * still exercises the 4 un-gated checks.
 *
 * Exit codes: 0 all non-skipped checks pass · 1 one or more checks failed.
 */

const args = process.argv;
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const baseUrl = (arg('url') ?? '').replace(/\/+$/, '');
const timeoutMs = Number(arg('timeout', '20000'));
const retries = Number(arg('retries', '3'));
const readinessToken = process.env.NGINX_READINESS_TOKEN ?? arg('token', '');

if (!baseUrl) {
  console.error('::error::smoke needs --url');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(readinessToken ? { 'x-readiness-token': readinessToken } : {}),
          ...(init.headers ?? {}),
        },
      });
      if (response.status >= 500) {
        // Transient 5xx is the free-tier cold-start window (the instance spins
        // up on first request and readiness can probe Firestore mid-startup).
        // Retry with backoff like an external health checker would.
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        const text = await response.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        return { status: response.status, headers: response.headers, body };
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    // Render free/starter instances cold-start; the first request can time out
    // or return a transient 5xx. Back off and retry.
    if (attempt < retries) await sleep(attempt * 3000);
  }
  throw lastError;
}

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log(`Smoke testing ${baseUrl}\n`);

// 1. Liveness — the probe Render itself uses.
await check('GET /api/v2/internal/health returns 200 {ok:true}', async () => {
  const { status, body } = await request('/api/v2/internal/health');
  assert(status === 200, `expected 200, got ${status}`);
  assert(body?.ok === true, `expected ok:true, got ${JSON.stringify(body)}`);
  assert(typeof body.uptimeMs === 'number', 'expected numeric uptimeMs');
});

// Checks 2 and 3 sit behind the nginx readiness gate: without the token the
// gate itself returns 404, so reporting that as a failure would be a
// misdiagnosis. Skip them with a visible warning when no token is configured;
// CI always provides one via the repo secret.
const gated = (name, fn) => {
  if (!readinessToken) {
    console.warn(`  SKIP  ${name} — set NGINX_READINESS_TOKEN to enable this check`);
    results.push({ name, ok: true, skipped: true });
    return;
  }
  return check(name, fn);
};

// 2. Readiness — dependency roll-up.
await gated('GET /api/v2/internal/readiness reports gateway up', async () => {
  const { status, body } = await request('/api/v2/internal/readiness');
  assert(status === 200, `expected 200, got ${status}`);
  assert(body?.ok === true, `expected ok:true, got ${JSON.stringify(body)}`);
  assert(
    body?.checks?.gateway === 'up',
    `expected checks.gateway="up", got ${JSON.stringify(body?.checks)}`,
  );
});

// 3. Version — must be a semver-shaped string.
await gated('GET /api/v2/internal/version returns a semantic version', async () => {
  const { status, body } = await request('/api/v2/internal/version');
  assert(status === 200, `expected 200, got ${status}`);
  assert(/^\d+\.\d+\.\d+/.test(String(body?.version)), `expected semver, got ${body?.version}`);
});

// 4. Auth is actually enforced. A 404 here would mean the route vanished; a 200
//    would mean the gateway is serving org data to anonymous callers.
await check('GET /api/v2/organizations without a session returns 401', async () => {
  const { status, body } = await request('/api/v2/organizations');
  assert(status === 401, `expected 401, got ${status}`);
  assert(body?.code === 'unauthorized', `expected code "unauthorized", got ${body?.code}`);
});

// 5. The shared error envelope survives in production (status/code/message/requestId).
await check('unknown routes return the 404 error envelope', async () => {
  const { status, body } = await request('/api/v2/__smoke_test_missing_route__');
  assert(status === 404, `expected 404, got ${status}`);
  assert(body?.code === 'not_found', `expected code "not_found", got ${body?.code}`);
  assert(typeof body?.requestId === 'string' && body.requestId.length > 0, 'expected a requestId');
});

// 6. Request correlation — every error carries a distinct id.
await check('each response carries a unique requestId', async () => {
  const [a, b] = await Promise.all([
    request('/api/v2/__smoke_a__'),
    request('/api/v2/__smoke_b__'),
  ]);
  assert(a.body?.requestId && b.body?.requestId, 'both responses must carry a requestId');
  assert(a.body.requestId !== b.body.requestId, 'requestIds must not repeat across requests');
});

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const summary = [
  `### Smoke tests — \`${baseUrl}\``,
  '',
  '| Check | Result |',
  '| --- | :--- |',
  ...results.map((r) =>
    r.skipped
      ? `| ${r.name} | ⏭️ skipped (no readiness token) |`
      : `| ${r.name} | ${r.ok ? '✅ pass' : `❌ ${r.error}`} |`,
  ),
  '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

const ran = results.length - skipped.length;
console.log(
  `\n${ran - failed.length}/${ran} checks passed` +
    (skipped.length > 0 ? ` (${skipped.length} skipped — no readiness token)` : ''),
);
if (failed.length > 0) {
  console.error(`::error::Smoke tests failed: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
