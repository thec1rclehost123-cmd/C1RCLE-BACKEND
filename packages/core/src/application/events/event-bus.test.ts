import { describe, expect, it } from 'vitest';

import { domainEvent } from '../../domain/events.js';
import { MemoryAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';

import { createAuditConsumer } from './audit-consumers.js';
import { InProcessEventBus } from './event-bus.js';

function makeEvent(overrides: Partial<Parameters<typeof domainEvent>[0]> = {}) {
  return domainEvent({
    type: 'event.published',
    aggregateId: 'evt_1',
    organizationId: 'org_1',
    actorId: 'usr_1',
    payload: { title: 'Headliner Night' },
    id: 'evt_pub_1',
    occurredAt: 1_700_000_000_000,
    ...overrides,
  });
}

function makeAuditBus(store: MemoryOutboxStore = new MemoryOutboxStore()) {
  const audits = new MemoryAuditRepository();
  const bus = new InProcessEventBus(store, { baseRetryDelayMs: 0 });
  bus.subscribe('event.published', createAuditConsumer(audits));
  return { audits, bus, store };
}

describe('InProcessEventBus (B09) — EventPublished → audit/consumer wiring', () => {
  it('dispatches the appended event without claiming unrelated pending outbox rows', async () => {
    const store = new MemoryOutboxStore();
    await store.append(makeEvent({ id: 'evt_unrelated_backlog' }));
    const bus = new InProcessEventBus(store);
    const seen: string[] = [];
    bus.subscribe('event.published', async (event) => {
      seen.push(event.id);
    });

    await bus.append(makeEvent({ id: 'evt_newly_appended' }));

    expect(seen).toEqual(['evt_newly_appended']);
    expect(store.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'evt_unrelated_backlog', status: 'pending' }),
        expect.objectContaining({ id: 'evt_newly_appended', status: 'processed' }),
      ]),
    );

    await bus.drain();
    expect(seen).toEqual(['evt_newly_appended', 'evt_unrelated_backlog']);
  });

  it('does not lose a scoped append that arrives while another event is dispatching', async () => {
    const store = new MemoryOutboxStore();
    const bus = new InProcessEventBus(store);
    const seen: string[] = [];
    let enteredFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    bus.subscribe('event.published', async (event) => {
      seen.push(event.id);
      if (event.id === 'evt_dispatch_first') {
        enteredFirst?.();
        await firstGate;
      }
    });

    const firstAppend = bus.append(makeEvent({ id: 'evt_dispatch_first' }));
    await firstEntered;
    await bus.append(makeEvent({ id: 'evt_dispatch_second' }));
    releaseFirst?.();
    await firstAppend;

    expect(seen).toEqual(['evt_dispatch_first', 'evt_dispatch_second']);
    expect(store.all().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'evt_dispatch_first', status: 'processed' },
      { id: 'evt_dispatch_second', status: 'processed' },
    ]);
  });

  it('one publish produces exactly one audit record', async () => {
    const { audits, bus } = makeAuditBus();
    await bus.append(makeEvent());
    expect(audits.all()).toHaveLength(1);
    expect(audits.all()[0]).toMatchObject({
      id: 'evt_pub_1',
      eventType: 'event.published',
      aggregateId: 'evt_1',
      organizationId: 'org_1',
      actorId: 'usr_1',
    });
  });

  it('no consumer for an event type → row still processed (no dead pending)', async () => {
    const store = new MemoryOutboxStore();
    const bus = new InProcessEventBus(store);
    await bus.append(makeEvent({ type: 'event.created', id: 'evt_cre_1' }));
    expect(store.all().find((r) => r.id === 'evt_cre_1')?.status).toBe('processed');
  });

  it('retry never duplicates the audit record (at-least-once + idempotent sink)', async () => {
    const { audits, bus } = makeAuditBus();
    let fails = 1;
    bus.subscribe('event.published', async (event) => {
      // A second consumer that flaky-fails once, simulating a retried row.
      if (fails-- > 0) throw new Error('transient failure');
      void event;
    });
    await bus.append(makeEvent());
    // First drain: audit wrote, flaky consumer failed → row left pending.
    expect(audits.all()).toHaveLength(1);
    // Second drain: retry succeeds; audit consumer must NOT write again.
    await bus.drain();
    expect(audits.all()).toHaveLength(1);
  });

  it('kill-after-commit: fresh bus on same store still yields exactly one audit', async () => {
    const store = new MemoryOutboxStore();
    const { bus } = makeAuditBus(store);
    // Row committed to the outbox but the process dies before draining.
    await store.append(makeEvent());
    // New process boots: new bus, new dedupe sets, same outbox store.
    const { audits, bus: rebooted } = makeAuditBus(store);
    expect(bus).toBeDefined();
    await rebooted.drain();
    expect(audits.all()).toHaveLength(1);
  });

  it('failing consumer exhausts attempts and lands in the DLQ', async () => {
    const store = new MemoryOutboxStore();
    const audits = new MemoryAuditRepository();
    const bus = new InProcessEventBus(store, { maxAttempts: 3, baseRetryDelayMs: 0 });
    bus.subscribe('event.published', async () => {
      throw new Error('poison message');
    });
    await store.append(makeEvent());
    // Row stays pending while attempts < max, then fails (DLQ: not retried).
    await bus.drain();
    await bus.drain();
    expect(store.all()[0]?.status).toBe('pending');
    await bus.drain();
    expect(store.all()[0]?.status).toBe('failed');
    expect(await store.listPending()).toHaveLength(0);
    expect(audits.all()).toHaveLength(0); // never falsely reported as delivered
  });
});

describe('DomainEvent identity (B09)', () => {
  it('dedupes by exact event id across cloned payloads', async () => {
    const { audits, bus } = makeAuditBus();
    const id = 'evt_pub_1';
    await bus.append(makeEvent({ id, payload: { title: 'first' } }));
    await bus.append(makeEvent({ id, payload: { title: 'second' } }));
    expect(audits.all()).toHaveLength(1);
  });
});

describe('durable outbox claiming', () => {
  it('leases one row to only one worker and reclaims it after expiry', async () => {
    const store = new MemoryOutboxStore();
    await store.append(makeEvent());

    const first = await store.claimPending({
      workerId: 'worker-a',
      now: 1_700_000_000_000,
      leaseMs: 1_000,
    });
    const raced = await store.claimPending({
      workerId: 'worker-b',
      now: 1_700_000_000_000,
      leaseMs: 1_000,
    });
    const recovered = await store.claimPending({
      workerId: 'worker-b',
      now: 1_700_000_001_000,
      leaseMs: 1_000,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'processing', attempts: 1, leaseOwner: 'worker-a' });
    expect(raced).toHaveLength(0);
    expect(recovered[0]).toMatchObject({
      status: 'processing',
      attempts: 2,
      leaseOwner: 'worker-b',
    });
  });

  it('respects retry scheduling and duplicate appends do not reset completed work', async () => {
    const store = new MemoryOutboxStore();
    const event = makeEvent();
    await store.append(event);
    const [claimed] = await store.claimPending({
      workerId: 'worker-a',
      now: event.occurredAt,
      leaseMs: 1_000,
    });
    if (!claimed) throw new Error('test outbox row was not claimed');
    await store.scheduleRetry(
      claimed.id,
      event.occurredAt + 5_000,
      'temporary failure',
      claimed.leaseToken ?? undefined,
    );

    expect(
      await store.claimPending({
        workerId: 'worker-b',
        now: event.occurredAt + 4_999,
        leaseMs: 1_000,
      }),
    ).toHaveLength(0);
    const [retried] = await store.claimPending({
      workerId: 'worker-b',
      now: event.occurredAt + 5_000,
      leaseMs: 1_000,
    });
    if (!retried) throw new Error('test outbox row was not retried');
    await store.markProcessed(
      retried.id,
      event.occurredAt + 5_001,
      retried.leaseToken ?? undefined,
    );
    await store.append({ ...event, payload: { title: 'changed replay' } });

    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ status: 'processed', attempts: 2 });
  });

  it('fences a stale worker after its lease is reclaimed', async () => {
    const store = new MemoryOutboxStore();
    const event = makeEvent();
    await store.append(event);
    const [stale] = await store.claimPending({
      workerId: 'worker-a',
      now: event.occurredAt,
      leaseMs: 1_000,
    });
    const [winner] = await store.claimPending({
      workerId: 'worker-b',
      now: event.occurredAt + 1_000,
      leaseMs: 1_000,
    });
    if (!stale?.leaseToken || !winner?.leaseToken) throw new Error('expected lease tokens');

    await store.markProcessed(winner.id, event.occurredAt + 1_001, winner.leaseToken);
    await store.scheduleRetry(stale.id, event.occurredAt + 2_000, 'late failure', stale.leaseToken);

    expect(store.all()[0]).toMatchObject({ status: 'processed', attempts: 2 });
  });
});

describe('InProcessEventBus — multiple subscribers per event type (Phase 8)', () => {
  it('delivers to every anonymous subscriber, not just the first', async () => {
    const bus = new InProcessEventBus(new MemoryOutboxStore());
    const seen: string[] = [];
    const makeAnonymous = (label: string) => async () => {
      seen.push(label);
    };
    bus.subscribe('event.published', makeAnonymous('audit'));
    bus.subscribe('event.published', makeAnonymous('fan-out'));
    await bus.append(makeEvent());
    expect(seen).toEqual(['audit', 'fan-out']);
  });
});
