#!/usr/bin/env node
/**
 * ─── Roll production back to the last known-good deploy ──────────────────────
 * Runs only when post-deploy smoke tests fail on main. Finds the most recent
 * live deploy that is NOT the one under test and asks Render to restore it.
 *
 *   RENDER_API_KEY=... RENDER_SERVICE_ID=... node scripts/ci/render-rollback.mjs
 *
 * Optional: --sha <commit> to exclude explicitly (defaults to $GITHUB_SHA).
 *           --dry-run to print the target without triggering the rollback.
 *
 * Exit codes: 0 rollback triggered (or dry run) · 1 could not roll back.
 */

const API = 'https://api.render.com/v1';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const apiKey = process.env.RENDER_API_KEY;
const serviceId = process.env.RENDER_SERVICE_ID;
const badSha = arg('sha', process.env.GITHUB_SHA ?? '');
const dryRun = has('dry-run');

if (!apiKey || !serviceId) {
  console.error('::error::RENDER_API_KEY and RENDER_SERVICE_ID are required to roll back.');
  process.exit(1);
}

async function render(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

const deploys = await render(`/services/${serviceId}/deploys?limit=20`);
if (!deploys.ok) {
  console.error(
    `::error::Render API returned ${deploys.status} listing deploys: ${JSON.stringify(deploys.body)}`,
  );
  process.exit(1);
}

// The list endpoint wraps each entry as { deploy: {...}, cursor }.
const entries = (Array.isArray(deploys.body) ? deploys.body : []).map((e) => e.deploy ?? e);
const live = entries.filter((d) => d?.status === 'live');

console.log('Recent live deploys:');
for (const d of live.slice(0, 6)) {
  console.log(`  ${d.id}  ${String(d.commit?.id ?? '').slice(0, 7)}  ${d.finishedAt ?? ''}`);
}

const target = live.find((d) => d.commit?.id !== badSha);
if (!target) {
  console.error(
    '::error::No previous live deploy found to roll back to. Roll back manually from the ' +
      'Render dashboard (Deploys tab -> the last green deploy -> Rollback).',
  );
  process.exit(1);
}

console.log(
  `Rolling back to deploy ${target.id} (commit ${String(target.commit?.id ?? '?').slice(0, 7)})`,
);

if (dryRun) {
  console.log('Dry run — no rollback triggered.');
  process.exit(0);
}

const rollback = await render(`/services/${serviceId}/rollback`, {
  method: 'POST',
  body: JSON.stringify({ deployId: target.id }),
});

if (!rollback.ok) {
  console.error(
    `::error::Rollback request failed with ${rollback.status}: ${JSON.stringify(rollback.body)}`,
  );
  process.exit(1);
}

console.log(`::notice::Rollback to ${target.id} triggered. Watch the Render dashboard for it.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Rollback triggered\n\nRestored deploy \`${target.id}\` ` +
      `(commit \`${String(target.commit?.id ?? '?').slice(0, 7)}\`).\n\n`,
  );
}
