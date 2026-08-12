import { beforeEach, describe, expect, it } from 'vitest';

import { createCoreConfig } from '../config/index.js';
import {
  EventNotFoundError,
  ForbiddenError,
  StateTransitionError,
  VersionConflictError,
} from '../domain/errors.js';
import { createOrganization } from '../domain/models/organization.js';
import { MemoryAuditRepository, MemoryOutbox } from '../infrastructure/memory/memory-outbox.js';
import {
  MemoryAnalyticsReadModelRepository,
  MemoryEventCatalogRepository,
  MemoryEventRepository,
  MemoryOrganizationRepository,
  MemorySlotRequestRepository,
  MemoryVenueRepository,
  MemoryVenueSlotRepository,
} from '../infrastructure/memory/memory-repositories.js';
import { noopLogger } from '../telemetry/logger.js';

import { EventService } from './events/event-service.js';
import { OrganizationService } from './organizations/organization-service.js';
import { VenueService } from './venues/venue-service.js';

import type { ActorContext, ServiceDeps } from './context.js';

/**
 * ─── B06 + B07: repositories and application services ────────────────────────
 * Gates: "repo-port tests green with zero infra imports" and "all service tests
 * green". Everything runs against the in-memory adapters, so the domain is
 * proven independent of transport and storage.
 */

const PAGE = { limit: 20, cursor: null };

function buildDeps(): ServiceDeps {
  // One instance is writer + reader + unit of work; services publish through it.
  const outbox = new MemoryOutbox();
  return {
    config: createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
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
      audit: new MemoryAuditRepository(),
    },
    outbox,
    unitOfWork: outbox,
  };
}

const actorFor = (organizationId: string, userId = 'user_1'): ActorContext => ({
  userId,
  organizationId,
  role: 'owner',
  capabilities: ['host', 'venue', 'promoter'],
});

describe('memory repositories — port round-trip', () => {
  it('round-trips an organization and lists it for its member', async () => {
    const repo = new MemoryOrganizationRepository();
    const org = createOrganization({
      id: 'org_1',
      name: 'Skyline',
      slug: 'skyline',
      ownerId: 'user_1',
    });

    await repo.save(org);

    expect(await repo.getById('org_1')).toEqual(org);
    expect(await repo.getById('missing')).toBeNull();

    const page = await repo.listForMember('user_1', PAGE);
    expect(page.items).toHaveLength(1);

    const strangers = await repo.listForMember('user_stranger', PAGE);
    expect(strangers.items).toHaveLength(0);

    expect(await repo.getMember('org_1', 'user_1')).toMatchObject({ role: 'owner' });
    expect(await repo.getMember('org_1', 'user_2')).toBeNull();

    await repo.delete('org_1');
    expect(await repo.getById('org_1')).toBeNull();
  });

  it('paginates with an opaque cursor and reports the next page', async () => {
    const repo = new MemoryOrganizationRepository();
    for (let index = 0; index < 5; index++) {
      await repo.save(
        createOrganization({
          id: `org_${index}`,
          name: `Org ${index}`,
          slug: `org-${index}`,
          ownerId: 'user_1',
        }),
      );
    }

    const first = await repo.listForMember('user_1', { limit: 2, cursor: null });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.listForMember('user_1', { limit: 2, cursor: first.nextCursor });
    expect(second.items).toHaveLength(2);
    expect(second.items.map((item) => item.id)).not.toEqual(first.items.map((item) => item.id));

    const third = await repo.listForMember('user_1', { limit: 10, cursor: second.nextCursor });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });
});

describe('OrganizationService', () => {
  let deps: ServiceDeps;
  let service: OrganizationService;

  beforeEach(() => {
    deps = buildDeps();
    service = new OrganizationService(deps);
  });

  it('creates an organization with the actor as owner', async () => {
    const org = await service.create(actorFor('org_seed'), { name: 'Skyline', slug: 'skyline' });
    expect(org.version).toBe(1);
    expect(org.members[0]).toMatchObject({ userId: 'user_1', role: 'owner' });
  });

  it('denies cross-tenant reads', async () => {
    const org = await service.create(actorFor('org_seed'), { name: 'Skyline', slug: 'skyline' });
    await expect(service.get(actorFor('other_org', 'user_2'), org.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('lists only organizations the actor belongs to', async () => {
    const mine = await service.create(actorFor('org_seed'), { name: 'Mine', slug: 'mine' });
    await service.create(actorFor('org_seed', 'user_other'), { name: 'Theirs', slug: 'theirs' });

    const page = await service.list(actorFor(mine.id), PAGE);
    expect(page.items.map((item) => item.id)).toEqual([mine.id]);
  });

  it('bumps the version on update', async () => {
    const org = await service.create(actorFor('org_seed'), { name: 'Skyline', slug: 'skyline' });
    const updated = await service.update(actorFor(org.id), {
      actor: actorFor(org.id),
      organizationId: org.id,
      expectedVersion: org.version,
      props: { name: 'Skyline Renamed' },
    });
    expect(updated).toMatchObject({ name: 'Skyline Renamed', version: org.version + 1 });
  });

  it('throws VersionConflictError on a stale expected version', async () => {
    const org = await service.create(actorFor('org_seed'), { name: 'Skyline', slug: 'skyline' });
    await expect(
      service.update(actorFor(org.id), {
        actor: actorFor(org.id),
        organizationId: org.id,
        expectedVersion: 99,
        props: { name: 'Nope' },
      }),
    ).rejects.toThrow(VersionConflictError);
  });

  it('invites a member', async () => {
    const org = await service.create(actorFor('org_seed'), { name: 'Skyline', slug: 'skyline' });
    const updated = await service.inviteMember(actorFor(org.id), {
      organizationId: org.id,
      userId: 'user_2',
      role: 'manager',
    });
    expect(updated.members).toHaveLength(2);

    const members = await service.listMembers(actorFor(org.id), org.id, PAGE);
    expect(members.items).toHaveLength(2);
  });
});

describe('EventService — lifecycle', () => {
  let deps: ServiceDeps;
  let events: EventService;
  let venues: VenueService;
  const actor = actorFor('org_1');

  beforeEach(() => {
    deps = buildDeps();
    events = new EventService(deps);
    venues = new VenueService(deps);
  });

  async function seedEvent() {
    const venue = await venues.create(actor, { name: 'Sky Bar', slug: 'sky-bar' });
    return events.create(actor, {
      venueId: venue.id,
      title: 'Sky Night',
      startAt: '2026-09-01T18:00:00.000Z',
      endAt: null,
    });
  }

  it('creates a draft scoped to the actor organization', async () => {
    const event = await seedEvent();
    expect(event).toMatchObject({ status: 'draft', organizationId: 'org_1', isPublic: false });
  });

  it('runs review → publish → pause → resume and keeps isPublic consistent', async () => {
    const event = await seedEvent();

    const reviewed = await events.review(actor, event.id);
    expect(reviewed.status).toBe('review');

    // publish() walks review→scheduled→published; each edge is FSM-validated.
    const published = await events.publish(actor, event.id);
    expect(published).toMatchObject({ status: 'published', isPublic: true });

    const paused = await events.pauseSales(actor, event.id);
    expect(paused).toMatchObject({ status: 'sales_paused', isPublic: true });

    const resumed = await events.resumeSales(actor, event.id);
    expect(resumed).toMatchObject({ status: 'published', isPublic: true });
  });

  it('cancels and refuses any later transition', async () => {
    const event = await seedEvent();
    const cancelled = await events.cancel(actor, event.id, 'weather');
    expect(cancelled).toMatchObject({ status: 'cancelled', isPublic: false });
    await expect(events.publish(actor, event.id)).rejects.toThrow();
  });

  it('duplicates an event back into draft', async () => {
    const event = await seedEvent();
    await events.review(actor, event.id);
    await events.publish(actor, event.id);
    const copy = await events.duplicate(actor, event.id);
    expect(copy.id).not.toBe(event.id);
    expect(copy).toMatchObject({ status: 'draft', isPublic: false, version: 1 });
  });

  it('hides cross-tenant events behind not-found (IDOR guard, never an oracle)', async () => {
    const event = await seedEvent();
    await expect(events.get(actorFor('org_other', 'user_2'), event.id)).rejects.toThrow(
      EventNotFoundError,
    );
  });

  it('refuses to publish straight from draft — review is not skippable', async () => {
    const event = await seedEvent();
    await expect(events.publish(actor, event.id)).rejects.toThrow(StateTransitionError);
  });
});
