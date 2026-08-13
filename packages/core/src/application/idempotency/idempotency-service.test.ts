import { describe, expect, it } from 'vitest';

import { MemoryIdempotencyStore } from '../../infrastructure/memory/memory-idempotency-store.js';

import { IdempotencyService } from './idempotency-service.js';

function makeService(ttlMs?: number) {
  const store = new MemoryIdempotencyStore({ ttlMs });
  return { service: new IdempotencyService(store), store };
}

const command = (overrides: Partial<Parameters<IdempotencyService['executeOnce']>[0]> = {}) => ({
  idempotencyKey: 'key-1',
  actorId: 'user-1',
  commandName: 'event.create',
  requestHash: 'hash-1',
  work: async () => ({ statusCode: 201, body: { id: 'evt_1' } }),
  ...overrides,
});

describe('IdempotencyService (B08)', () => {
  it('runs work once and replays the stored response', async () => {
    const { service } = makeService();
    let workCalls = 0;
    const cmd = command({
      work: async () => {
        workCalls += 1;
        return { statusCode: 201, body: { id: 'evt_1' } };
      },
    });
    const first = await service.executeOnce(cmd);
    const second = await service.executeOnce(cmd);
    expect(workCalls).toBe(1);
    expect(first).toEqual({ replayed: false, statusCode: 201, body: { id: 'evt_1' } });
    expect(second).toEqual({ replayed: true, statusCode: 201, body: { id: 'evt_1' } });
  });

  it('different actor for same key is a different idempotency slot', async () => {
    const { service } = makeService();
    const first = await service.executeOnce(command({ actorId: 'user-1' }));
    const second = await service.executeOnce(command({ actorId: 'user-2' }));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
  });

  it('same key with different request hash → conflict', async () => {
    const { service } = makeService();
    await service.executeOnce(command({ requestHash: 'hash-1' }));
    await expect(service.executeOnce(command({ requestHash: 'hash-2' }))).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('concurrent same-key execution → one winner, second sees in-flight', async () => {
    const { service } = makeService();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstPromise = service.executeOnce(
      command({
        work: async () => {
          await gate;
          return { statusCode: 201, body: { id: 'evt_1' } };
        },
      }),
    );
    // Second attempt while the first is still in flight.
    const secondPromise = service.executeOnce(command());
    await expect(secondPromise).rejects.toMatchObject({ code: 'idempotency_in_flight' });
    release?.();
    const first = await firstPromise;
    expect(first.replayed).toBe(false);
    // After completion, a retry replays instead of re-executing.
    const retry = await service.executeOnce(command());
    expect(retry.replayed).toBe(true);
  });

  it('failed work releases the claim so a retry can execute', async () => {
    const { service } = makeService();
    let calls = 0;
    const cmd = command({
      work: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { statusCode: 201, body: { id: 'evt_1' } };
      },
    });
    await expect(service.executeOnce(cmd)).rejects.toThrow('boom');
    const retry = await service.executeOnce(cmd);
    expect(retry.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('expired records are not replayed (TTL authority)', async () => {
    let now = 1_000_000;
    const store = new MemoryIdempotencyStore({ ttlMs: 100, now: () => now });
    const svc = new IdempotencyService(store);
    await svc.executeOnce(command());
    now += 200; // past the 24h-equivalent TTL
    const retry = await svc.executeOnce(command());
    expect(retry.replayed).toBe(false);
  });
});
