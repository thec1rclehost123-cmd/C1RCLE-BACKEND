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
  const bus = new InProcessEventBus(store);
  bus.subscribe('event.published', createAuditConsumer(audits));
  return { audits, bus, store };
}

describe('InProcessEventBus (B09) — EventPublished → audit/consumer wiring', () => {
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
    const bus = new InProcessEventBus(store, { maxAttempts: 3 });
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
