import { describe, expect, it } from 'vitest';

import { newDomainEvent } from '../domain/events/domain-events.js';
import { createEvent } from '../domain/models/event.js';

import {
  MemoryEventRepository,
  MemoryOrganizationRepository,
  MemoryVenueRepository,
} from './memory/memory-repositories.js';
import { runRepositoryContract } from './repository-contract.js';
import {
  SqliteEventRepository,
  SqliteOrganizationRepository,
  SqliteOutbox,
  SqliteVenueRepository,
  createSqliteDatabase,
} from './sqlite/sqlite-repositories.js';

/**
 * ─── B12 gate ────────────────────────────────────────────────────────────────
 * "repository contract suite passes against Memory AND the real adapter (same
 * suite, swapped dependency)." Identical assertions, two storage engines.
 */

describe('repository contract', () => {
  runRepositoryContract('memory', {
    organizations: () => new MemoryOrganizationRepository(),
    venues: () => new MemoryVenueRepository(),
    events: () => new MemoryEventRepository(),
  });

  runRepositoryContract('sqlite', {
    organizations: () => new SqliteOrganizationRepository(createSqliteDatabase()),
    venues: () => new SqliteVenueRepository(createSqliteDatabase()),
    events: () => new SqliteEventRepository(createSqliteDatabase()),
  });
});

describe('sqlite outbox — real transactional guarantee', () => {
  const anEvent = (id: string) =>
    newDomainEvent({
      id,
      type: 'event.created',
      aggregateId: 'evt_1',
      organizationId: 'org_1',
      actorId: 'user_1',
      occurredAt: new Date('2026-08-12T10:00:00.000Z'),
      payload: {},
    });

  it('commits the business row and its event together', async () => {
    const db = createSqliteDatabase();
    const events = new SqliteEventRepository(db);
    const outbox = new SqliteOutbox(db);

    await outbox.runInTransaction(async (tx) => {
      await events.save(
        createEvent({
          id: 'evt_1',
          organizationId: 'org_1',
          venueId: 'ven_1',
          title: 'Committed',
          startAt: '2026-09-01T18:00:00.000Z',
        }),
        tx,
      );
      await outbox.append(anEvent('out_1'), tx);
    });

    expect(await events.getById('evt_1')).not.toBeNull();
    expect(await outbox.listPending(10)).toHaveLength(1);
  });

  it('rolls BOTH back when the unit of work throws', async () => {
    const db = createSqliteDatabase();
    const events = new SqliteEventRepository(db);
    const outbox = new SqliteOutbox(db);

    await expect(
      outbox.runInTransaction(async (tx) => {
        await events.save(
          createEvent({
            id: 'evt_rollback',
            organizationId: 'org_1',
            venueId: 'ven_1',
            title: 'Doomed',
            startAt: '2026-09-01T18:00:00.000Z',
          }),
          tx,
        );
        await outbox.append(anEvent('out_rollback'), tx);
        throw new Error('publish failed after the write');
      }),
    ).rejects.toThrow('publish failed after the write');

    // Neither half survived: no orphan row, no event describing a write that
    // never happened.
    expect(await events.getById('evt_rollback')).toBeNull();
    expect(await outbox.listPending(10)).toHaveLength(0);
  });

  it('dead-letters after the attempt limit', async () => {
    const db = createSqliteDatabase();
    const outbox = new SqliteOutbox(db);
    await outbox.append(anEvent('out_poison'));

    for (let attempt = 0; attempt < 10; attempt++) {
      await outbox.markFailed('out_poison', 'permanent failure', new Date());
    }

    // Stops retrying, stays visible with its error trail — never a silent drop.
    expect(await outbox.listPending(10)).toHaveLength(0);
    const dead = await outbox.listDeadLettered();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ attempts: 10, status: 'dead_letter' });
    expect(dead[0]?.lastError).toBe('permanent failure');
  });
});
