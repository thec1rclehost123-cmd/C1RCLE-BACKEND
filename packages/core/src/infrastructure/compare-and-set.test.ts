import { describe, expect, it } from 'vitest';

import { VersionConflictError } from '../domain/errors.js';
import { createEvent } from '../domain/models/event.js';
import { createOrganization, updateOrganization } from '../domain/models/organization.js';

import {
  MemoryEventRepository,
  MemoryOrganizationRepository,
} from './memory/memory-repositories.js';

/**
 * ─── Compare-and-set (D-002 gap) ─────────────────────────────────────────────
 *
 * The service checks `expectedVersion` and then writes, which is not atomic:
 * two callers can both read version 1, both pass the check, and both write
 * version 2 — the second erasing the first while `If-Match` appears to be
 * working. These tests exercise the adapter directly, because that is the only
 * layer where the race can actually be closed.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');
const LATER = new Date('2026-08-13T11:00:00.000Z');

const org = () =>
  createOrganization({
    id: 'org_1',
    name: 'Skyline',
    slug: 'skyline',
    ownerId: 'user_1',
    now: NOW,
  });

describe('memory adapter compare-and-set', () => {
  it('accepts a create, then the write that follows it', async () => {
    const repo = new MemoryOrganizationRepository();
    const created = org();
    await repo.save(created);

    const updated = updateOrganization(created, { name: 'Renamed' }, LATER);
    await repo.save(updated);

    expect(await repo.getById('org_1')).toMatchObject({ name: 'Renamed', version: 2 });
  });

  it('refuses the SECOND of two writers who both read version 1 (the lost update)', async () => {
    const repo = new MemoryOrganizationRepository();
    const base = org();
    await repo.save(base);

    // Both callers hold the same v1 snapshot — exactly what happens when two
    // requests interleave between the service's read and its write.
    const writerA = updateOrganization(base, { name: 'A wins' }, LATER);
    const writerB = updateOrganization(base, { name: 'B overwrites' }, LATER);

    await repo.save(writerA);
    await expect(repo.save(writerB)).rejects.toThrow(VersionConflictError);

    // A's write survives. Without CAS, B would have silently replaced it.
    expect(await repo.getById('org_1')).toMatchObject({ name: 'A wins', version: 2 });
  });

  it('reports the version that actually won, so the client can refetch', async () => {
    const repo = new MemoryOrganizationRepository();
    const base = org();
    await repo.save(base);
    await repo.save(updateOrganization(base, { name: 'A' }, LATER));

    const stale = updateOrganization(base, { name: 'B' }, LATER);
    await expect(repo.save(stale)).rejects.toMatchObject({
      code: 'version_conflict',
      currentVersion: 2,
    });
  });

  it('refuses a versioned write when the row is gone', async () => {
    const repo = new MemoryOrganizationRepository();
    const base = org();
    await repo.save(base);
    await repo.delete('org_1');

    // The state the caller decided against no longer exists — the same class
    // of failure as a stale version, not a silent resurrection.
    await expect(repo.save(updateOrganization(base, { name: 'Zombie' }, LATER))).rejects.toThrow(
      VersionConflictError,
    );
  });

  it('lets a retry succeed once it is based on the current version', async () => {
    const repo = new MemoryOrganizationRepository();
    const base = org();
    await repo.save(base);
    await repo.save(updateOrganization(base, { name: 'A' }, LATER));

    const fresh = await repo.getById('org_1');
    expect(fresh).not.toBeNull();
    const retried = updateOrganization(fresh ?? base, { name: 'B after refetch' }, LATER);
    await repo.save(retried);

    expect(await repo.getById('org_1')).toMatchObject({ name: 'B after refetch', version: 3 });
  });

  it('applies to every versioned aggregate, not just organizations', async () => {
    const repo = new MemoryEventRepository();
    const event = createEvent({
      id: 'evt_1',
      organizationId: 'org_1',
      venueId: 'ven_1',
      title: 'Sky Night',
      startAt: '2026-09-01T18:00:00.000Z',
      now: NOW,
    });
    await repo.save(event);

    // Version 3 skips 2: nothing in storage can satisfy "must find N-1".
    await expect(repo.save({ ...event, version: 3 })).rejects.toThrow(VersionConflictError);
  });
});
