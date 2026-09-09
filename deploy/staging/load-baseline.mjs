import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// The load harness must never send a file it has not been explicitly told
// to use, nor to a host it has not been explicitly pointed at. Both inputs
// are operator-supplied env vars, but this script is also reviewable as a
// pipeline: the body is a JSON fixture confined to deploy/staging/baselines/
// and the request only ever goes to STAGING_BASE_URL over HTTPS.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASELINES_DIR = path.join(SCRIPT_DIR, 'baselines');
const MAX_FIXTURE_BYTES = 1 * 1024 * 1024;

const baseUrl = (process.env.STAGING_BASE_URL ?? '').replace(/\/$/, '');
const requestPath = process.env.STAGING_LOAD_PATH ?? '/api/v2/internal/health';
const method = (process.env.STAGING_LOAD_METHOD ?? 'GET').toUpperCase();
const requestCount = Number(process.env.STAGING_LOAD_REQUESTS ?? 100);
const concurrency = Number(process.env.STAGING_LOAD_CONCURRENCY ?? 4);
const timeoutMs = Number(process.env.STAGING_LOAD_TIMEOUT_MS ?? 10000);

if (!Number.isInteger(requestCount) || requestCount < 1)
  throw new Error('STAGING_LOAD_REQUESTS must be a positive integer');
if (!Number.isInteger(concurrency) || concurrency < 1)
  throw new Error('STAGING_LOAD_CONCURRENCY must be a positive integer');
if (method !== 'GET' && process.env.STAGING_LOAD_ALLOW_MUTATION !== 'YES') {
  throw new Error('Set STAGING_LOAD_ALLOW_MUTATION=YES before loading a mutation');
}
if (method !== 'GET' && !process.env.STAGING_LOAD_IDEMPOTENCY_KEY) {
  throw new Error('Provide STAGING_LOAD_IDEMPOTENCY_KEY before loading a mutation');
}

// Resolve the effective request URL. STAGING_BASE_URL must be HTTPS and every
// request is confined to its origin: a full requestPath is only accepted when
// it targets the same host (never a raw http:// scheme, never a redirect to a
// different origin). A plain path is resolved against the base origin.
function resolveRequestUrl(base, requestPath) {
  let baseUrlObject;
  try {
    baseUrlObject = new URL(base);
  } catch {
    throw new Error('STAGING_BASE_URL must be a valid absolute URL');
  }
  if (baseUrlObject.protocol !== 'https:' || baseUrlObject.hostname === '') {
    throw new Error('STAGING_BASE_URL must use HTTPS and have a host');
  }

  const resolved = requestPath.startsWith('/')
    ? new URL(requestPath, baseUrlObject)
    : new URL(requestPath);
  if (resolved.protocol !== 'https:') {
    throw new Error('STAGING_LOAD_PATH must resolve over HTTPS');
  }
  if (resolved.origin !== baseUrlObject.origin) {
    throw new Error('STAGING_LOAD_PATH must stay on the STAGING_BASE_URL origin');
  }
  return resolved.toString();
}

// Load the mutation body. There are two supported sources:
//   - STAGING_LOAD_BODY: an inline JSON document
//   - STAGING_LOAD_BODY_FILE: a JSON fixture inside deploy/staging/baselines/
// The body is always validated as JSON so the default content-type header
// matches what is actually sent, and the file variant is size-capped.
async function loadBody() {
  const bodyFromEnv = process.env.STAGING_LOAD_BODY;
  const bodyFile = process.env.STAGING_LOAD_BODY_FILE;

  if (bodyFromEnv === undefined && bodyFile === undefined) return undefined;

  let rawBody;
  if (bodyFile !== undefined) {
    const fixturePath = path.resolve(BASELINES_DIR, bodyFile);
    const relative = path.relative(BASELINES_DIR, fixturePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('STAGING_LOAD_BODY_FILE must live under deploy/staging/baselines/');
    }
    const stat = await fs.stat(fixturePath);
    if (!stat.isFile()) throw new Error('STAGING_LOAD_BODY_FILE is not a file');
    if (stat.size > MAX_FIXTURE_BYTES) {
      throw new Error(`STAGING_LOAD_BODY_FILE exceeds ${MAX_FIXTURE_BYTES} bytes`);
    }
    rawBody = await fs.readFile(fixturePath, 'utf8');
  } else {
    rawBody = bodyFromEnv;
  }
  // Tolerate editors that persist a UTF-8 BOM (Windows PowerShell, Notepad
  // via Save As, etc.) without re-encoding the fixture to UTF-8.
  if (rawBody.length > 0 && rawBody.charCodeAt(0) === 0xfeff) {
    rawBody = rawBody.slice(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
  return JSON.stringify(parsed);
}

const url = resolveRequestUrl(baseUrl, requestPath);
const body = await loadBody();
const headers = { accept: 'application/json' };
if (body !== undefined) headers['content-type'] = 'application/json';
if (process.env.STAGING_ACCESS_TOKEN)
  headers.authorization = `Bearer ${process.env.STAGING_ACCESS_TOKEN}`;
if (process.env.STAGING_COOKIE) headers.cookie = process.env.STAGING_COOKIE;
if (process.env.STAGING_ORGANIZATION_ID)
  headers['x-organization-id'] = process.env.STAGING_ORGANIZATION_ID;
if (process.env.STAGING_IF_MATCH) headers['if-match'] = process.env.STAGING_IF_MATCH;
if (process.env.STAGING_LOAD_IDEMPOTENCY_KEY)
  headers['idempotency-key'] = process.env.STAGING_LOAD_IDEMPOTENCY_KEY;
const latencies = [];
const statuses = new Map();
let errors = 0;
let nextRequest = 0;

async function request() {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
      keepalive: true,
    });
    await response.arrayBuffer();
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    if (response.status >= 400) errors += 1;
  } catch {
    errors += 1;
    statuses.set('network_error', (statuses.get('network_error') ?? 0) + 1);
  } finally {
    latencies.push(performance.now() - started);
  }
}

async function worker() {
  while (true) {
    const current = nextRequest;
    nextRequest += 1;
    if (current >= requestCount) return;
    await request();
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, worker));
const elapsedMs = performance.now() - started;
latencies.sort((left, right) => left - right);

function percentile(percent) {
  const index = Math.max(0, Math.ceil((percent / 100) * latencies.length) - 1);
  return Number(latencies[index].toFixed(2));
}

const statusCounts = Object.fromEntries(
  [...statuses.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))),
);
const report = {
  url,
  method,
  requests: requestCount,
  concurrency,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  throughputRps: Number((requestCount / (elapsedMs / 1000)).toFixed(2)),
  latencyMs: { p50: percentile(50), p95: percentile(95), p99: percentile(99) },
  errors,
  errorRate: Number((errors / requestCount).toFixed(4)),
  statuses: statusCounts,
};
console.log(JSON.stringify(report));

if (process.env.STAGING_LOAD_EXPECT_429 === 'YES' && !Object.hasOwn(statusCounts, '429')) {
  console.error('Expected at least one 429 response in the rate-limit scenario');
  process.exitCode = 1;
}
