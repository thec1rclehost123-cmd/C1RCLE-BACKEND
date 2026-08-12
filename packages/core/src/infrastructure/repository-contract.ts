import { expect, it } from 'vitest';

import { createEvent } from '../domain/models/event.js';
import { createOrganization } from '../domain/models/organization.js';
import { createVenue } from '../domain/models/venue.js';

import type {
  EventRepository,
  OrganizationRepository,
  VenueRepository,
} from '../domain/ports/repositories.js';

/**
 * ─── Repository contract suite (B12 / T18) ───────────────────────────────────
 *
 * ONE suite, run against every adapter. This is what makes "storage is an
 * implementation detail" a fact rather than an aspiration: if an adapter
 * cannot pass this, the domain cannot use it — and any behaviour the domain
 * relies on but the suite does not assert is a gap in the suite, not a licence
 * for adapters to differ.
 *
 * Adapters are supplied as factories so each case starts from an empty store.
 */

export interface RepositoryFactories {
  organizations: () => OrganizationRepository;
  venues: () => VenueRepository;
  events: () => EventRepository;
}

const PAGE = { limit: 20, cursor: null };

export function runRepositoryContract(adapterName: string, factories: RepositoryFactories): void {
  const org = (id: string, ownerId = 'user_1') =>
    createOrganization({ id, name: `Org ${id}`, slug: `slug-${id}`, ownerId });

  it(`[${adapterName}] round-trips an organization`, async () => {
    const repo = factories.organizations();
    const subject = org('org_1');

    expect(await repo.getById('org_1')).toBeNull();
    await repo.save(subject);
    expect(await repo.getById('org_1')).toEqual(subject);

    await repo.delete('org_1');
    expect(await repo.getById('org_1')).toBeNull();
  });

  it(`[${adapterName}] overwrites on save rather than duplicating`, async () => {
    const repo = factories.organizations();
    await repo.save(org('org_1'));
    await repo.save({ ...org('org_1'), name: 'Renamed', version: 2 });

    const stored = await repo.getById('org_1');
    expect(stored).toMatchObject({ name: 'Renamed', version: 2 });
    expect((await repo.listForMember('user_1', PAGE)).items).toHaveLength(1);
  });

  it(`[${adapterName}] lists organizations only for their members`, async () => {
    const repo = factories.organizations();
    await repo.save(org('org_1', 'user_1'));
    await repo.save(org('org_2', 'user_2'));

    expect((await repo.listForMember('user_1', PAGE)).items.map((item) => item.id)).toEqual([
      'org_1',
    ]);
    expect((await repo.listForMember('user_nobody', PAGE)).items).toEqual([]);
  });

  it(`[${adapterName}] resolves members and reports absent ones as null`, async () => {
    const repo = factories.organizations();
    await repo.save(org('org_1', 'user_1'));

    expect(await repo.getMember('org_1', 'user_1')).toMatchObject({ role: 'owner' });
    expect(await repo.getMember('org_1', 'user_2')).toBeNull();
    expect(await repo.getMember('org_missing', 'user_1')).toBeNull();
  });

  it(`[${adapterName}] paginates with an opaque cursor and terminates`, async () => {
    const repo = factories.organizations();
    for (let index = 0; index < 5; index++) await repo.save(org(`org_${index}`));

    const first = await repo.listForMember('user_1', { limit: 2, cursor: null });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.listForMember('user_1', { limit: 2, cursor: first.nextCursor });
    const seen = new Set([...first.items, ...second.items].map((item) => item.id));
    expect(seen.size).toBe(4);

    const last = await repo.listForMember('user_1', { limit: 10, cursor: second.nextCursor });
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  });

  it(`[${adapterName}] never leaks another tenant's venues`, async () => {
    const repo = factories.venues();
    await repo.save(
      createVenue({
        id: 'ven_1',
        organizationId: 'org_1',
        ownerId: 'user_1',
        name: 'A',
        slug: 'a',
      }),
    );
    await repo.save(
      createVenue({
        id: 'ven_2',
        organizationId: 'org_2',
        ownerId: 'user_2',
        name: 'B',
        slug: 'b',
      }),
    );

    const page = await repo.listByOrganization('org_1', PAGE);
    expect(page.items.map((item) => item.id)).toEqual(['ven_1']);
  });

  it(`[${adapterName}] round-trips a venue and resolves it by slug within its tenant`, async () => {
    const repo = factories.venues();
    const venue = createVenue({
      id: 'ven_1',
      organizationId: 'org_1',
      ownerId: 'user_1',
      name: 'Sky Bar',
      slug: 'sky-bar',
    });
    await repo.save(venue);

    expect(await repo.getById('ven_1')).toEqual(venue);
    expect(await repo.getBySlug('sky-bar', 'org_1')).toMatchObject({ id: 'ven_1' });
    // Same slug, different tenant → not found. Slugs are not global.
    expect(await repo.getBySlug('sky-bar', 'org_2')).toBeNull();
  });

  it(`[${adapterName}] round-trips an event and scopes lists by tenant and venue`, async () => {
    const repo = factories.events();
    const base = {
      organizationId: 'org_1',
      venueId: 'ven_1',
      startAt: '2026-09-01T18:00:00.000Z',
    };
    await repo.save(createEvent({ id: 'evt_1', title: 'One', ...base }));
    await repo.save(createEvent({ id: 'evt_2', title: 'Two', ...base, venueId: 'ven_2' }));
    await repo.save(createEvent({ id: 'evt_3', title: 'Three', ...base, organizationId: 'org_2' }));

    expect(await repo.getById('evt_1')).toMatchObject({ title: 'One' });
    expect((await repo.listByOrganization('org_1', PAGE)).items.map((item) => item.id)).toEqual([
      'evt_1',
      'evt_2',
    ]);
    expect((await repo.listByVenue('ven_2', PAGE)).items.map((item) => item.id)).toEqual(['evt_2']);
  });

  it(`[${adapterName}] exposes only public events to the public list`, async () => {
    const repo = factories.events();
    const base = {
      organizationId: 'org_1',
      venueId: 'ven_1',
      startAt: '2026-09-01T18:00:00.000Z',
    };
    await repo.save(createEvent({ id: 'evt_draft', title: 'Draft', ...base }));
    await repo.save({
      ...createEvent({ id: 'evt_live', title: 'Live', ...base }),
      status: 'published' as const,
      isPublic: true,
    });

    const published = await repo.listPublic(PAGE);
    expect(published.items.map((item) => item.id)).toEqual(['evt_live']);
  });

  it(`[${adapterName}] bounds a page to the requested limit`, async () => {
    const repo = factories.events();
    for (let index = 0; index < 30; index++) {
      await repo.save(
        createEvent({
          id: `evt_${index}`,
          organizationId: 'org_1',
          venueId: 'ven_1',
          title: `E${index}`,
          startAt: '2026-09-01T18:00:00.000Z',
        }),
      );
    }
    const page = await repo.listByOrganization('org_1', { limit: 10, cursor: null });
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();
  });
}
