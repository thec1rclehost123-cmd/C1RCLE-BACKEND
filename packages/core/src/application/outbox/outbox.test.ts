import { beforeEach, describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { newDomainEvent } from '../../domain/events/domain-events.js';
import { OUTBOX_MAX_ATTEMPTS } from '../../domain/ports/outbox.js';
import { MemoryAuditRepository, MemoryOutbox } from '../../infrastructure/memory/memory-outbox.js';
import {
  MemoryAnalyticsReadModelRepository,
  MemoryEventCatalogRepository,
  MemoryEventRepository,
  MemoryOrganizationRepository,
  MemorySlotRequestRepository,
  MemoryVenueRepository,
  MemoryVenueSlotRepository,
} from '../../infrastructure/memory/memory-repositories.js';
import { noopLogger } from '../../telemetry/logger.js';
import { EventService } from '../events/event-service.js';
import { VenueService } from '../venues/venue-service.js';

import { AUDIT_CONSUMER, registerAuditConsumer } from './audit-consumer.js';
import { EventBus, OutboxRelay } from './event-bus.js';

import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── B09 / T11–T13: outbox, event bus, DLQ ───────────────────────────────────
 * Gate: "one publish produces exactly one audit record even under retry."
 */

const NOW = new Date('2026-08-11T10:00:00.000Z');
const actor: ActorContext = {
  userId: 'user_1',
  organizationId: 'org_1',
  role: 'owner',
  capabilities: ['host', 'venue', 'promoter'],
};

function buildHarness() {
  const outbox = new MemoryOutbox(() => NOW);
  const audit = new MemoryAuditRepository();
  const bus = new EventBus(noopLogger);
  registerAuditConsumer(bus, audit);
  const relay = new OutboxRelay(outbox, bus, noopLogger, () => NOW);

  let seq = 0;
  const deps: ServiceDeps = {
    config: createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
      clock: { now: () => NOW },
      ids: () => `id_${++seq}`,
    }),
    logger: noopLogger,
    repositories: {
      organizations: new MemoryOrganizationRepository(),
      venues: new MemoryVenueRepository(),
      slotRequests: new MemorySlotRequestRepository(),
      venueSlots: new MemoryVenueSlotRepository(),
      events: new MemoryEventRepository(),
      catalog: new MemoryEventCatalogRepository(),
      analytics: new MemoryAnalyticsReadModelRepository(),
      audit,
    },
    outbox,
    unitOfWork: outbox,
  };

  return {
    outbox,
    audit,
    bus,
    relay,
    events: new EventService(deps),
    venues: new VenueService(deps),
  };
}

const anEvent = (id: string) =>
  newDomainEvent({
    id,
    type: 'event.published',
    aggregateId: 'evt_1',
    organizationId: 'org_1',
    actorId: 'user_1',
    occurredAt: NOW,
    payload: {},
  });

describe('outbox — transactional write', () => {
  it('commits the business write and its event together', async () => {
    const harness = buildHarness();
    const venue = await harness.venues.create(actor, { name: 'Sky Bar', slug: 'sky-bar' });
    await harness.events.create(actor, {
      venueId: venue.id,
      title: 'Sky Night',
      startAt: '2026-09-01T18:00:00.000Z',
    });

    const rows = harness.outbox.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(rows[0]?.event.type).toBe('event.created');
  });

  it('discards the event when the transaction fails (no event without its write)', async () => {
    const outbox = new MemoryOutbox(() => NOW);
    await expect(
      outbox.runInTransaction(async (tx) => {
        await outbox.append(anEvent('evt_lost'), tx);
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');

    expect(outbox.all()).toHaveLength(0);
  });

  it('refuses an append against a closed scope', async () => {
    const outbox = new MemoryOutbox(() => NOW);
    let captured: { kind: 'tx'; id: string } | null = null;
    await outbox.runInTransaction(async (tx) => {
      captured = tx;
    });
    await expect(outbox.append(anEvent('evt_late'), captured)).rejects.toThrow(/already-committed/);
  });
});

describe('event bus + relay — delivery', () => {
  let harness: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('produces exactly one audit record per publish, even when drained twice', async () => {
    const venue = await harness.venues.create(actor, { name: 'Sky Bar', slug: 'sky-bar' });
    const event = await harness.events.create(actor, {
      venueId: venue.id,
      title: 'Sky Night',
      startAt: '2026-09-01T18:00:00.000Z',
    });
    await harness.events.review(actor, event.id);
    await harness.events.publish(actor, event.id);

    const first = await harness.relay.drain();
    expect(first.processed).toBe(3); // created + updated(review) + published
    expect(first.failed).toBe(0);

    // Draining again must not duplicate anything: rows are processed, and the
    // bus would refuse re-delivery anyway.
    const second = await harness.relay.drain();
    expect(second.processed).toBe(0);

    const records = await harness.audit.listForOrganization('org_1');
    expect(records).toHaveLength(3);
    expect(records.filter((record) => record.action === 'event.published')).toHaveLength(1);
  });

  it('re-runs only the failing consumer on retry (at-least-once, effectively once)', async () => {
    const outbox = new MemoryOutbox(() => NOW);
    const audit = new MemoryAuditRepository();
    const bus = new EventBus(noopLogger);
    registerAuditConsumer(bus, audit);

    let attempts = 0;
    bus.subscribe('flaky-projection', ['event.published'], async () => {
      attempts++;
      if (attempts === 1) throw new Error('projection unavailable');
    });

    const relay = new OutboxRelay(outbox, bus, noopLogger, () => NOW);
    await outbox.append(anEvent('evt_retry'));

    const first = await relay.drain();
    expect(first.failed).toBe(1);
    // The audit consumer succeeded on the first pass despite the sibling failure.
    expect(audit.all()).toHaveLength(1);

    const second = await relay.drain();
    expect(second.processed).toBe(1);
    expect(attempts).toBe(2);
    // Still exactly one audit record — the successful consumer was not re-run.
    expect(audit.all()).toHaveLength(1);
    expect(bus.hasDelivered('evt_retry', AUDIT_CONSUMER)).toBe(true);
  });

  it('dead-letters a poisoned row after the attempt limit, keeping the error trail', async () => {
    const outbox = new MemoryOutbox(() => NOW);
    const bus = new EventBus(noopLogger);
    bus.subscribe('always-fails', ['event.published'], async () => {
      throw new Error('permanent failure');
    });
    const relay = new OutboxRelay(outbox, bus, noopLogger, () => NOW);
    await outbox.append(anEvent('evt_poison'));

    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS; attempt++) {
      await relay.drain();
    }

    const dead = await outbox.listDeadLettered();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ attempts: OUTBOX_MAX_ATTEMPTS, status: 'dead_letter' });
    expect(dead[0]?.lastError).toContain('permanent failure');

    // A dead-lettered row stops retrying — it is visible, not silently looping.
    const after = await relay.drain();
    expect(after.processed).toBe(0);
    expect(after.failed).toBe(0);
  });

  it('never crosses tenants in the audit trail', async () => {
    const venue = await harness.venues.create(actor, { name: 'Sky Bar', slug: 'sky-bar' });
    await harness.events.create(actor, {
      venueId: venue.id,
      title: 'Sky Night',
      startAt: '2026-09-01T18:00:00.000Z',
    });
    await harness.relay.drain();

    expect(await harness.audit.listForOrganization('org_1')).toHaveLength(1);
    expect(await harness.audit.listForOrganization('org_other')).toHaveLength(0);
  });
});
