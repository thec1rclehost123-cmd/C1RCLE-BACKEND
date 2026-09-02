#!/usr/bin/env node
/**
 * ─── Coverage ratchet ─────────────────────────────────────────────────────────
 * Enforces "coverage may not go down", instead of an absolute number nobody
 * calibrated. The baseline is whatever the default branch last recorded; it is
 * carried between runs in the GitHub Actions cache, so the very first run on a
 * fresh repository passes and simultaneously establishes the floor.
 *
 *   node scripts/ci/coverage-ratchet.mjs \
 *     --summary coverage/coverage-summary.json \
 *     [--baseline .coverage-baseline/coverage-summary.json] \
 *     [--tolerance 0.5] \
 *     [--write-baseline .coverage-baseline/coverage-summary.json]
 *
 * Optional hard floor: set the COVERAGE_MIN_LINES repository variable (and/or
 * COVERAGE_MIN_STATEMENTS / _FUNCTIONS / _BRANCHES) to add an absolute gate on
 * top of the ratchet.
 *
 * Exit codes: 0 pass · 1 regression or floor breach · 2 cannot check.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const METRICS = ['lines', 'statements', 'functions', 'branches'];

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fail(message, code = 2) {
  console.error(`::error::${message}`);
  process.exit(code);
}

function readSummary(path) {
  if (!existsSync(path)) return null;
  try {
    const total = JSON.parse(readFileSync(path, 'utf8')).total;
    if (!total) return null;
    return Object.fromEntries(METRICS.map((m) => [m, Number(total[m]?.pct ?? 0)]));
  } catch (error) {
    fail(`Could not parse coverage summary at ${path}: ${error.message}`);
  }
}

const summaryPath = arg('summary', 'coverage/coverage-summary.json');
const baselinePath = arg('baseline');
const seedPath = arg('seed');
const writeBaselinePath = arg('write-baseline');
const tolerance = Number(arg('tolerance', '0.5'));

const current = readSummary(summaryPath);
if (!current) {
  fail(
    `No coverage summary at ${summaryPath}. Did \`pnpm test:coverage\` run, and is ` +
      `"json-summary" in the reporter list of vitest.config.mjs?`,
  );
}

// Prefer the cached default-branch baseline. Fall back to the committed seed so
// the gate still has a floor when the Actions cache is cold or was evicted.
const cachedBaseline = baselinePath ? readSummary(baselinePath) : null;
const seedBaseline = seedPath ? readSummary(seedPath) : null;
const baseline = cachedBaseline ?? seedBaseline;
const baselineSource = cachedBaseline ? 'default-branch cache' : seedBaseline ? seedPath : null;
const floors = Object.fromEntries(
  METRICS.map((m) => [m, Number(process.env[`COVERAGE_MIN_${m.toUpperCase()}`] ?? NaN)]),
);

const rows = [];
const failures = [];

for (const metric of METRICS) {
  const now = current[metric];
  const was = baseline?.[metric];
  const delta = was === undefined ? null : now - was;

  let verdict = 'ok';
  if (delta !== null && delta < -tolerance) {
    verdict = 'regression';
    failures.push(
      `${metric}: ${now.toFixed(2)}% is ${Math.abs(delta).toFixed(2)}pt below the ` +
        `default-branch baseline of ${was.toFixed(2)}% (tolerance ${tolerance}pt)`,
    );
  }
  const floor = floors[metric];
  if (Number.isFinite(floor) && now < floor) {
    verdict = 'below floor';
    failures.push(`${metric}: ${now.toFixed(2)}% is below the required floor of ${floor}%`);
  }

  rows.push({ metric, now, was, delta, verdict });
}

const table = [
  '| Metric | Coverage | Baseline | Delta | |',
  '| --- | ---: | ---: | ---: | :--- |',
  ...rows.map(
    (r) =>
      `| ${r.metric} | ${r.now.toFixed(2)}% | ${r.was === undefined ? '—' : `${r.was.toFixed(2)}%`}` +
      ` | ${r.delta === null ? '—' : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}pt`}` +
      ` | ${r.verdict === 'ok' ? '✅' : '❌ ' + r.verdict} |`,
  ),
].join('\n');

const heading = baseline
  ? `### Coverage ratchet\n\n_Baseline source: ${baselineSource}._`
  : '### Coverage ratchet\n\n_No baseline recorded yet — this run establishes it._';

console.log(`${heading}\n\n${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${heading}\n\n${table}\n\n`);
}

if (writeBaselinePath) {
  mkdirSync(dirname(writeBaselinePath), { recursive: true });
  writeFileSync(writeBaselinePath, readFileSync(summaryPath, 'utf8'));
  console.log(`Baseline written to ${writeBaselinePath}`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`::error::Coverage gate: ${f}`);
  process.exit(1);
}

console.log('Coverage gate: pass');
