import { describe, expect, it } from 'vitest';

import { createEvent } from '../../domain/models/event.js';
import { MemoryEventCoverPolicyRepository } from '../../infrastructure/memory/memory-event-cover-policy-repository.js';

import { EventCoverPolicyService } from './event-cover-policy-service.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const event = createEvent({
  id: 'event-1',
  organizationId: 'host-1',
  venueId: 'venue-1',
  title: 'Fixture event',
  startAt: '2026-11-01T20:00:00.000Z',
  now,
});
const venue = { id: 'venue-1', organizationId: 'venue-org-1', status: 'active' };
const terms = {
  eventId: 'event-1',
  venueOrganizationId: 'venue-org-1',
  merchantOrganizationId: 'venue-org-1',
  coverAmountPaise: 150_000,
  minimumSpendPaise: 50_000,
  redemptionOpensAt: '2026-11-01T18:00:00.000Z',
  redemptionClosesAt: '2026-11-02T02:00:00.000Z',
  eligibleCategories: ['food'],
  excludedCategories: ['alcohol'],
  alcoholRule: 'exclude_alcohol' as const,
  partialRedemption: true,
  splitTender: true,
  refundPolicy: 'unused_full_before_redemption' as const,
  transferUnusedOnly: true as const,
  commissionBasis: 'net_admission_after_allocated_discount' as const,
  unusedBalancePolicy: 'approved_minimum_spend_expiry' as const,
};

function createService(options: { hasPartnership?: boolean; targetEvent?: typeof event } = {}) {
  const targetEvent = options.targetEvent ?? event;
  let sequence = 0;
  const policies = new MemoryEventCoverPolicyRepository();
  const service = new EventCoverPolicyService({
    config: {
      clock: { now: () => now },
      ids: () => `cover-id-${++sequence}`,
      features: { m5CoverPolicyFixtures: true },
    },
    repositories: {
      events: { getById: async (id: string) => (id === targetEvent.id ? targetEvent : null) },
      venues: { getById: async (id: string) => (id === venue.id ? venue : null) },
      partnerships: {
        findByPair: async () =>
          options.hasPartnership === false ? null : { id: 'partnership-1', status: 'active' },
      },
      eventCoverPolicies: policies,
    },
  } as never);
  return { service, policies };
}

const hostActor = {
  userId: 'host-user-1',
  organizationId: 'host-1',
  role: 'owner' as const,
  capabilities: [],
};
const venueActor = {
  userId: 'venue-user-1',
  organizationId: 'venue-org-1',
  role: 'owner' as const,
  capabilities: [],
};

describe('EventCoverPolicyService', () => {
  it('requires Host ownership to propose and Venue organization access to accept', async () => {
    const { service } = createService();
    await expect(
      service.propose({ ...hostActor, organizationId: 'other' }, event.id, 'v1', terms),
    ).rejects.toThrow('Cross-tenant access denied');
    const proposal = await service.propose(hostActor, event.id, 'fixture-v1', terms);
    await expect(
      service.accept({ ...venueActor, organizationId: 'other' }, event.id, proposal.id),
    ).rejects.toThrow('Cross-tenant access denied');
    const acceptance = await service.accept(venueActor, event.id, proposal.id);
    expect(acceptance).toMatchObject({
      proposalId: proposal.id,
      proposalVersion: 'fixture-v1',
      termsDigest: proposal.termsDigest,
      acceptedByUserId: venueActor.userId,
    });
  });

  it('rejects accepting a proposal through a different event path', async () => {
    const { service } = createService();
    const proposal = await service.propose(hostActor, event.id, 'fixture-v1', terms);
    await expect(service.accept(venueActor, 'other-event', proposal.id)).rejects.toThrow(
      'does not belong to this event',
    );
  });

  it('allows Venue-owned events to configure their own policy without a partnership', async () => {
    const venueEvent = createEvent({
      id: 'venue-event',
      organizationId: venue.organizationId,
      venueId: venue.id,
      title: 'Venue-owned fixture',
      startAt: '2026-11-01T20:00:00.000Z',
      now,
    });
    const { service } = createService({ hasPartnership: false, targetEvent: venueEvent });
    const venueTerms = { ...terms, eventId: venueEvent.id };
    const proposal = await service.propose(venueActor, venueEvent.id, 'fixture-v1', venueTerms);
    await expect(service.accept(venueActor, venueEvent.id, proposal.id)).resolves.toMatchObject({
      proposalId: proposal.id,
      venueOrganizationId: venue.organizationId,
    });
  });

  it('requires an active partnership for Host-owned events', async () => {
    const { service } = createService({ hasPartnership: false });
    await expect(service.propose(hostActor, event.id, 'fixture-v1', terms)).rejects.toThrow(
      'active Host/Venue partnership',
    );
  });

  it('keeps acceptance unavailable when the non-production fixture gate is off', async () => {
    const { service } = createService();
    const proposal = await service.propose(hostActor, event.id, 'fixture-v1', terms);
    const gated = new EventCoverPolicyService({
      config: { clock: { now: () => now }, ids: () => 'unused', features: {} },
      repositories: {
        events: { getById: async () => event },
        venues: { getById: async () => venue },
        partnerships: { findByPair: async () => ({ id: 'partnership-1', status: 'active' }) },
        eventCoverPolicies: new MemoryEventCoverPolicyRepository(),
      },
    } as never);
    await expect(gated.accept(venueActor, event.id, proposal.id)).rejects.toThrow(
      'disabled until reviewed policy approval is recorded',
    );
    await expect(gated.listForEvent(venueActor, event.id)).resolves.toEqual({
      acceptanceEnabled: false,
      items: [],
    });
  });

  it('lists exact policy history only to the Host or participating Venue', async () => {
    const { service } = createService();
    const proposal = await service.propose(hostActor, event.id, 'fixture-v1', terms);
    await expect(service.listForEvent(hostActor, event.id)).resolves.toEqual({
      acceptanceEnabled: true,
      items: [{ proposal, acceptance: null }],
    });
    await expect(service.listForEvent(venueActor, event.id)).resolves.toEqual({
      acceptanceEnabled: true,
      items: [{ proposal, acceptance: null }],
    });
    await expect(
      service.listForEvent({ ...hostActor, organizationId: 'other' }, event.id),
    ).rejects.toThrow('Event cover policy');
  });
});
