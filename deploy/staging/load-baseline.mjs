import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.STAGING_BASE_URL ?? '').replace(/\/$/, '');
const requestPath = process.env.STAGING_LOAD_PATH ?? '/api/v2/internal/health';
const method = (process.env.STAGING_LOAD_METHOD ?? 'GET').toUpperCase();
const requestCount = Number(process.env.STAGING_LOAD_REQUESTS ?? 100);
const concurrency = Number(process.env.STAGING_LOAD_CONCURRENCY ?? 4);
const timeoutMs = Number(process.env.STAGING_LOAD_TIMEOUT_MS ?? 10000);

if (!baseUrl.startsWith('https://')) throw new Error('STAGING_BASE_URL must use HTTPS');
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

const body = process.env.STAGING_LOAD_BODY_FILE
  ? await fs.readFile(process.env.STAGING_LOAD_BODY_FILE, 'utf8')
  : process.env.STAGING_LOAD_BODY;
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

const url = requestPath.startsWith('http') ? requestPath : `${baseUrl}${requestPath}`;
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
