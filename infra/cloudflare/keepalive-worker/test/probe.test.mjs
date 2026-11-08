import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { probe } from '../src/index.js';

const noSleep = async () => {};

test('returns ok on the first healthy response', async () => {
  const calls = [];
  const result = await probe(
    'https://x.test/h',
    async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    },
    noSleep,
  );
  assert.deepEqual(result, { ok: true, status: 200, attempt: 1 });
  assert.equal(calls.length, 1);
});

test('retries after a failure and reports the attempt that succeeded', async () => {
  let n = 0;
  const result = await probe(
    'https://x.test/h',
    async () => {
      n += 1;
      if (n === 1) throw new Error('timeout');
      if (n === 2) return { ok: false, status: 524 };
      return { ok: true, status: 200 };
    },
    noSleep,
  );
  assert.deepEqual(result, { ok: true, status: 200, attempt: 3 });
});

test('gives up after three attempts and keeps the last reason', async () => {
  const result = await probe('https://x.test/h', async () => ({ ok: false, status: 524 }), noSleep);
  assert.deepEqual(result, { ok: false, error: 'status 524', attempt: 3 });
});

test('scheduled() refuses a missing or non-https HEALTH_URL', async () => {
  await assert.rejects(worker.scheduled({}, {}), /HEALTH_URL/);
  await assert.rejects(worker.scheduled({}, { HEALTH_URL: 'http://x.test' }), /HEALTH_URL/);
});
