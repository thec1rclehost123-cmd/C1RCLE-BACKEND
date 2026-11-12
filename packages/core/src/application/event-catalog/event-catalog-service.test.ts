import { describe, expect, it, vi } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createPromoterAssignment, createTicketTier } from '../../domain/models/event-catalog.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { MemoryEventCatalogRepository } from '../../infrastructure/memory/memory-repositories.js';

import { EventCatalogService } from './event-catalog-service.js';

import type { ServiceDeps } from '../context.js';

describe('Promoter assignment expiry worker', () => {
  it('transitions due assignments once and emits one deterministic event', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() - 60_000).toISOString();
    const futureExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    const catalog = new MemoryEventCatalogRepository();
    const dueAssignment = createPromoterAssignment({
      id: 'assignment_due',
      eventId: 'event_1',
      promoterId: 'promoter_1',
      terms: { version: 1, ratePercent: 10, flatPaise: 0 },
      status: 'accepted',
      expiresAt,
      now: new Date('2026-10-28T00:00:00.000Z'),
    });
    const futureAssignment = createPromoterAssignment({
      id: 'assignment_future',
      eventId: 'event_1',
      promoterId: 'promoter_1',
      terms: { version: 1, ratePercent: 10, flatPaise: 0 },
      status: 'accepted',
      expiresAt: futureExpiresAt,
      now: new Date('2026-10-28T00:00:00.000Z'),
    });
    await catalog.saveAssignment(dueAssignment);
    await catalog.saveAssignment(futureAssignment);
    const outbox = new MemoryOutboxStore();
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
        clock: { now: () => now },
      }),
      outbox,
      repositories: {
        catalog,
        events: {
          getById: async () => ({ id: 'event_1', organizationId: 'host_1', title: 'Sky Night' }),
        },
      },
    } as unknown as ServiceDeps;
    const service = new EventCatalogService(deps);

    expect(await service.expireDuePromoterAssignments()).toBe(1);
    expect(await service.expireDuePromoterAssignments()).toBe(0);
    expect(await catalog.getAssignmentById(dueAssignment.id)).toMatchObject({
      status: 'expired',
      version: dueAssignment.version + 1,
    });
    expect(await catalog.getAssignmentById(futureAssignment.id)).toMatchObject({
      status: 'accepted',
    });
    const events = await outbox.listPending();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'promoter.assignment.expired',
      aggregateId: dueAssignment.id,
      payload: {
        id: events[0]?.id,
        type: 'promoter.assignment.expired',
        organizationId: 'host_1',
        actorId: 'system',
        payload: {
          assignmentId: dueAssignment.id,
          eventId: 'event_1',
          promoterId: 'promoter_1',
          eventTitle: 'Sky Night',
          expiresAt,
        },
      },
    });
  });
});

describe('Host ticket tier limits', () => {
  async function setupTier(accessType: 'ENTRY' | 'RSVP' = 'ENTRY') {
    const now = new Date('2026-11-02T00:00:00.000Z');
    const catalog = new MemoryEventCatalogRepository();
    const tier = createTicketTier({
      id: `tier_${accessType}`,
      eventId: 'event_limits',
      organizationId: 'host_limits',
      name: accessType === 'RSVP' ? 'Free RSVP' : 'General Entry',
      priceInPaise: accessType === 'RSVP' ? undefined : 50_000,
      quantity: 20,
      accessType,
      maxPerOrder: accessType === 'RSVP' ? null : null,
      now,
    });
    await catalog.saveTier(tier);
    const outbox = new MemoryOutboxStore();
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
        clock: { now: () => now },
      }),
      outbox,
      repositories: {
        catalog,
        events: {
          getById: async (id: string) =>
            id === 'event_limits'
              ? { id, organizationId: 'host_limits', title: 'Acceptance event' }
              : null,
        },
      },
    } as unknown as ServiceDeps;
    return { service: new EventCatalogService(deps), catalog, outbox, tier };
  }

  it('updates only the order cap and records a tier-limit audit event', async () => {
    const { service, catalog, outbox, tier } = await setupTier();
    const updated = await service.updateTierLimits(
      {
        userId: 'host_user',
        organizationId: 'host_limits',
        role: 'owner',
        capabilities: ['host'],
      },
      {
        eventId: 'event_limits',
        tierId: tier.id,
        expectedVersion: tier.version,
        maxPerOrder: 10,
      },
    );

    expect(updated).toMatchObject({
      maxPerOrder: 10,
      priceInPaise: 50_000,
      quantity: 20,
      version: tier.version + 1,
    });
    expect(await catalog.getTierById(tier.id)).toEqual(updated);
    expect(await outbox.listPending()).toContainEqual(
      expect.objectContaining({
        type: 'event.ticket_tier_limits_updated',
        aggregateId: tier.id,
        payload: expect.objectContaining({
          payload: expect.objectContaining({
            maxPerOrder: 10,
            tierId: tier.id,
          }),
        }),
      }),
    );
  });

  it('defaults a newly-created RSVP to one per order and rejects any other RSVP cap', async () => {
    const { service, tier } = await setupTier('RSVP');
    expect(tier.maxPerOrder).toBe(1);
    await expect(
      service.updateTierLimits(
        {
          userId: 'host_user',
          organizationId: 'host_limits',
          role: 'owner',
          capabilities: ['host'],
        },
        {
          eventId: 'event_limits',
          tierId: tier.id,
          expectedVersion: tier.version,
          maxPerOrder: 2,
        },
      ),
    ).rejects.toThrow('Free RSVP tickets are limited to one per order');
  });

  it('recovers an ambiguous retry after the tier write but before the audit outbox append', async () => {
    const { service, catalog, outbox, tier } = await setupTier();
    vi.spyOn(outbox, 'append').mockRejectedValueOnce(new Error('temporary outbox failure'));
    const actor = {
      userId: 'host_user',
      organizationId: 'host_limits',
      role: 'owner' as const,
      capabilities: ['host' as const],
    };
    const command = {
      eventId: 'event_limits',
      tierId: tier.id,
      expectedVersion: tier.version,
      maxPerOrder: 9,
    };

    await expect(service.updateTierLimits(actor, command)).rejects.toThrow(
      'temporary outbox failure',
    );
    const retry = await service.updateTierLimits(actor, command);

    expect(retry).toMatchObject({ maxPerOrder: 9, version: tier.version + 1 });
    expect(await catalog.getTierById(tier.id)).toEqual(retry);
    expect(await outbox.listPending()).toHaveLength(1);
  });
  it('updates inventory and future price without rewriting commercial snapshots', async () => {
    const { service, catalog, tier } = await setupTier();
    const actor = {
      userId: 'host_user',
      organizationId: 'host_limits',
      role: 'owner' as const,
      capabilities: ['host' as const],
    };
    const updated = await service.updateTierLimits(actor, {
      eventId: 'event_limits',
      tierId: tier.id,
      expectedVersion: tier.version,
      quantity: 40,
      priceInPaise: 70_000,
    });
    expect(updated).toMatchObject({ quantity: 40, priceInPaise: 70_000, maxPerOrder: null });
    expect(tier).toMatchObject({ quantity: 20, priceInPaise: 50_000 });
    expect(await catalog.getTierById(tier.id)).toEqual(updated);
  });

  it.each(['STUDENT', 'MEMBER'] as const)('rejects new V1 %s tiers', async (audienceType) => {
    const { service } = await setupTier();
    await expect(
      service.createTier(
        {
          userId: 'host_user',
          organizationId: 'host_limits',
          role: 'owner',
          capabilities: ['host'],
        },
        {
          eventId: 'event_limits',
          name: audienceType,
          quantity: 20,
          priceInPaise: 50_000,
          audienceType,
        },
      ),
    ).rejects.toThrow('not available in V1');
  });
});

describe('Host Promoter commission proposal validation', () => {
  function setup() {
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      repositories: {
        organizations: {
          getById: async () => ({ platformFeePercent: 10 }),
        },
        partnerships: { findByPair: async () => ({ venueShareRate: 10 }) },
      },
    } as unknown as ServiceDeps;
    const service = new EventCatalogService(deps);
    vi.spyOn(service, 'assertPromoterAssignable').mockResolvedValue();
    return service;
  }

  it('derives eligible paid tiers with the same canonical rules used at final assignment', async () => {
    const service = setup();
    await expect(
      service.validateProposedPromoterAssignment(
        {
          userId: 'host_user',
          organizationId: 'host_org',
          role: 'owner',
          capabilities: ['host'],
        },
        {
          venueId: 'venue_1',
          promoterId: 'promoter_1',
          tiers: [
            {
              id: 'paid',
              accessType: 'ENTRY',
              commissionEligible: true,
              priceInPaise: 5_000,
              doorPriceInPaise: null,
            },
            {
              id: 'rsvp',
              accessType: 'RSVP',
              commissionEligible: false,
              priceInPaise: 0,
              doorPriceInPaise: null,
            },
            {
              id: 'excluded',
              accessType: 'ENTRY',
              commissionEligible: false,
              priceInPaise: 5_000,
              doorPriceInPaise: null,
            },
          ],
          term: { version: 1, ratePercent: 15, flatPaise: 0 },
        },
      ),
    ).resolves.toEqual(['paid']);
  });

  it('rejects a paid event assignment with no eligible tiers before Venue review', async () => {
    const service = setup();
    await expect(
      service.validateProposedPromoterAssignment(
        {
          userId: 'host_user',
          organizationId: 'host_org',
          role: 'owner',
          capabilities: ['host'],
        },
        {
          venueId: 'venue_1',
          promoterId: 'promoter_1',
          tiers: [
            {
              id: 'paid',
              accessType: 'ENTRY',
              commissionEligible: true,
              priceInPaise: 5_000,
              doorPriceInPaise: null,
            },
          ],
          term: { version: 1, ratePercent: 0, flatPaise: 0 },
          eligibleTierIds: [],
        },
      ),
    ).rejects.toThrow(/at least one paid ticket tier/);
  });
});
