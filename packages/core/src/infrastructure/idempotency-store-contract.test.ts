import { describe, expect, it } from 'vitest';

import { MemoryIdempotencyStore } from './memory/memory-idempotency-store.js';

import type { IdempotencyStore } from '../domain/ports/idempotency.js';

/**
 * ─── Idempotency store contract ──────────────────────────────────────────────
 *
 * `claim` is the whole guarantee: of N concurrent callers holding the same key,
 * exactly one may proceed. Everything else about idempotency is bookkeeping on
 * top of that one atomic step, so it is what a store must be judged on.
 *
 * The Firestore adapter satisfies the same contract using `create()` (which
 * fails when the document exists); it is exercised against the real project by
 * the Firestore integration suite rather than here, so this stays hermetic.
 */
function runIdempotencyStoreContract(name: string, make: () => IdempotencyStore): void {
  const future = () => Date.now() + 60_000;

  it(`[${name}] gives the slot to the first caller only`, async () => {
    const store = make();

    const first = await store.claim('k1', 'hash-a', future());
    const second = await store.claim('k1', 'hash-a', future());

    // null means "you won"; a record means "someone else holds it".
    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(second?.status).toBe('IN_PROGRESS');
  });

  it(`[${name}] yields exactly one winner under concurrent claims`, async () => {
    const store = make();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claim('race', 'hash-a', future())),
    );

    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it(`[${name}] replays the stored response after completion`, async () => {
    const store = make();
    await store.claim('k2', 'hash-a', future());
    await store.complete('k2', 201, { id: 'org_1' });

    const record = await store.get('k2');
    expect(record).toMatchObject({
      status: 'COMPLETED',
      statusCode: 201,
      responseBody: { id: 'org_1' },
    });
  });

  it(`[${name}] frees the key again after release, so a failure stays retryable`, async () => {
    const store = make();
    await store.claim('k3', 'hash-a', future());
    await store.release('k3');

    expect(await store.get('k3')).toBeNull();
    // A fresh caller wins the slot rather than inheriting a dead claim.
    expect(await store.claim('k3', 'hash-a', future())).toBeNull();
  });

  it(`[${name}] treats an expired record as absent`, async () => {
    const store = make();
    // Already past: a claim nobody ever completed must not block the key forever.
    await store.claim('k4', 'hash-a', Date.now() - 1);

    expect(await store.get('k4')).toBeNull();
    expect(await store.claim('k4', 'hash-a', future())).toBeNull();
  });

  it(`[${name}] preserves the request hash so reuse with a different body is detectable`, async () => {
    const store = make();
    await store.claim('k5', 'hash-original', future());

    const existing = await store.claim('k5', 'hash-different', future());
    // The store reports what was originally claimed; the service compares.
    expect(existing?.requestHash).toBe('hash-original');
  });
}

describe('idempotency store contract', () => {
  runIdempotencyStoreContract('memory', () => new MemoryIdempotencyStore());
});
