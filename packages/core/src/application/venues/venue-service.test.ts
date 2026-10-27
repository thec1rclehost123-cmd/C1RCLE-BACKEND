import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createOrganization } from '../../domain/models/organization.js';
import { approvePartnership, createPartnership } from '../../domain/models/partnership.js';
import { createVenue } from '../../domain/models/venue.js';
import { EchoObjectStorage } from '../../domain/ports/object-storage.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import {
  MemoryStaffCredentialProvisioner,
  MemoryStaffRotationStore,
  MemoryStaffUserDirectory,
} from '../../domain/ports/staff-credentials.js';
import { FormatCheckVerificationProvider } from '../../domain/ports/verification.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryEmailDeliveryRepository } from '../../infrastructure/memory/memory-email-delivery-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { noopLogger } from '../../telemetry/logger.js';
import { EventService } from '../events/event-service.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { VenueCalendarService, VenueService, VenueSlotRequestService } from './venue-service.js';

import type { ActorContext, ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');

function createTestDeps(): ServiceDeps {
  const config = createCoreConfig({
    redis: { url: 'redis://localhost:6379' },
    firestore: { projectId: 'test-project' },
    clock: { now: () => NOW },
  });

  const repositories = buildRepositories({
    STORAGE_DRIVER: 'memory',
    FIRESTORE_PROJECT_ID: 'test-project',
  });

  return {
    config,
    logger: noopLogger,
    outbox: new MemoryOutboxStore(),
    emailDeliveries: new MemoryEmailDeliveryRepository(),
    adminAudit: new MemoryAdminAuditRepository(),
    verification: new FormatCheckVerificationProvider(),
    objectStorage: new EchoObjectStorage(),
    emailSender: {
      name: 'test',
      sendStaffInvitationEmail: async () => {},
      sendOtpEmail: async () => {},
      sendPasswordResetEmail: async () => {},
      sendOnboardingChangesRequestedEmail: async () => {},
    },
    userDirectory: new MemoryStaffUserDirectory(),
    paymentProvider: new MemoryPaymentProvider('whsec'),
    pricing: new PricingService({ eventCatalog: repositories.catalog }),
    inventory: new InventoryService({
      eventCatalog: repositories.catalog,
      cartReservation: repositories.cartReservations,
      order: repositories.orders,
    }),
    repositories,
    credentialProvisioner: new MemoryStaffCredentialProvisioner(),
    rotationStore: new MemoryStaffRotationStore(),
  };
}

describe('VenueService — auto-provisioning resilience', () => {
  it('automatically provisions a default venue when a venue partner has none', async () => {
    const deps = createTestDeps();
    const service = new VenueService(deps);

    const org = createOrganization({
      id: 'org_venue_1',
      name: 'Club Velvet',
      slug: 'club-velvet',
      capabilities: ['venue'],
      ownerId: 'user_1',
      now: NOW,
    });
    await deps.repositories.organizations.save(org);

    const actor: ActorContext = {
      userId: 'user_1',
      organizationId: 'org_venue_1',
      role: 'owner',
      capabilities: ['venue'],
    };

    const firstList = await service.list(actor, { limit: 10, cursor: null });
    expect(firstList.items.length).toBe(1);
    expect(firstList.items[0]?.public.name).toBe('Club Velvet');
    expect(firstList.items[0]?.organizationId).toBe('org_venue_1');
    expect(firstList.items[0]?.status).toBe('active');

    // Subsequent listing returns the same venue without re-creating
    const secondList = await service.list(actor, { limit: 10, cursor: null });
    expect(secondList.items.length).toBe(1);
    expect(secondList.items[0]?.id).toBe(firstList.items[0]?.id);
  });

  it('provisions a venue when org has venue capability even if actor context capabilities lagged', async () => {
    const deps = createTestDeps();
    const service = new VenueService(deps);

    const org = createOrganization({
      id: 'org_venue_2',
      name: 'Sky Lounge',
      slug: 'sky-lounge',
      capabilities: ['venue'],
      ownerId: 'user_2',
      now: NOW,
    });
    await deps.repositories.organizations.save(org);

    const actorWithoutExplicitCap: ActorContext = {
      userId: 'user_2',
      organizationId: 'org_venue_2',
      role: 'owner',
      capabilities: [],
    };

    const list = await service.list(actorWithoutExplicitCap, { limit: 10, cursor: null });
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.public.name).toBe('Sky Lounge');
  });

  it('does not auto-provision a venue for non-venue organizations', async () => {
    const deps = createTestDeps();
    const service = new VenueService(deps);

    const org = createOrganization({
      id: 'org_host_1',
      name: 'Host Collective',
      slug: 'host-collective',
      capabilities: ['host'],
      ownerId: 'user_3',
      now: NOW,
    });
    await deps.repositories.organizations.save(org);

    const actor: ActorContext = {
      userId: 'user_3',
      organizationId: 'org_host_1',
      role: 'owner',
      capabilities: ['host'],
    };

    const list = await service.list(actor, { limit: 10, cursor: null });
    expect(list.items.length).toBe(0);
  });
});

describe('Venue availability and Host request lifecycle', () => {
  it('publishes an open offer, atomically holds it for one Host, then reserves it on acceptance', async () => {
    const deps = createTestDeps();
    const venue = createVenue({
      id: 'venue_m3_lifecycle',
      organizationId: 'venue_org_m3',
      ownerId: 'venue_owner_m3',
      name: 'M3 Test Venue',
      slug: 'm3-test-venue',
      now: NOW,
    });
    await deps.repositories.venues.save(venue);
    const partnership = createPartnership({
      id: 'partnership_m3_lifecycle',
      hostOrganizationId: 'host_org_m3',
      venueOrganizationId: venue.organizationId,
      venueId: venue.id,
      initiatedBy: 'host',
      now: NOW,
    });
    await deps.repositories.partnerships.save(
      approvePartnership(partnership, venue.organizationId, NOW),
    );
    const competingPartnership = createPartnership({
      id: 'partnership_m3_lifecycle_competitor',
      hostOrganizationId: 'host_org_m3_competitor',
      venueOrganizationId: venue.organizationId,
      venueId: venue.id,
      initiatedBy: 'host',
      now: NOW,
    });
    await deps.repositories.partnerships.save(
      approvePartnership(competingPartnership, venue.organizationId, NOW),
    );
    const venueActor: ActorContext = {
      userId: 'venue_owner_m3',
      organizationId: venue.organizationId,
      role: 'owner',
      capabilities: ['venue'],
    };
    const hostActor: ActorContext = {
      userId: 'host_owner_m3',
      organizationId: 'host_org_m3',
      role: 'owner',
      capabilities: ['host'],
    };
    const competingHostActor: ActorContext = {
      userId: 'host_owner_m3_competitor',
      organizationId: 'host_org_m3_competitor',
      role: 'owner',
      capabilities: ['host'],
    };
    const calendar = new VenueCalendarService(deps);
    const requestService = new VenueSlotRequestService(deps);

    const offered = await calendar.publishAvailability(venueActor, {
      venueId: venue.id,
      label: 'M3-HOST-E2E availability',
      startTime: '2026-11-04T12:30:00.000Z',
      endTime: '2026-11-04T16:30:00.000Z',
      timezone: 'Asia/Kolkata',
      visibleToHostIds: null,
    });
    expect(offered).toMatchObject({ status: 'open', timezone: 'Asia/Kolkata' });

    const contenders = await Promise.allSettled([
      requestService.create(hostActor, {
        venueId: venue.id,
        slotId: offered.id,
        eventId: null,
      }),
      requestService.create(competingHostActor, {
        venueId: venue.id,
        slotId: offered.id,
        eventId: null,
      }),
    ]);
    expect(contenders.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const requested = contenders.find((item) => item.status === 'fulfilled');
    if (!requested || requested.status !== 'fulfilled') throw new Error('No request won');
    const winner = requested.value;
    const winnerActor = winner.hostId === hostActor.organizationId ? hostActor : competingHostActor;
    expect(winner).toMatchObject({
      slotId: offered.id,
      hostId: winnerActor.organizationId,
      status: 'pending',
    });
    expect(await deps.repositories.venueSlots.getSlotById(offered.id)).toMatchObject({
      status: 'pending',
      slotRequestId: requested.value.id,
    });
    await expect(
      requestService.create(winnerActor, {
        venueId: venue.id,
        slotId: offered.id,
        eventId: null,
      }),
    ).rejects.toThrow(/already has a request|no longer open/);

    const accepted = await requestService.accept(venueActor, requested.value.id);
    expect(accepted.status).toBe('accepted');
    expect(await deps.repositories.venueSlots.getSlotById(offered.id)).toMatchObject({
      status: 'booked',
      slotRequestId: requested.value.id,
    });
  });

  it('reopens the offered time when Venue rejects a pending Host request', async () => {
    const deps = createTestDeps();
    const venue = createVenue({
      id: 'venue_m3_reject',
      organizationId: 'venue_org_m3_reject',
      ownerId: 'venue_owner_m3_reject',
      name: 'M3 Test Venue',
      slug: 'm3-test-venue-reject',
      now: NOW,
    });
    await deps.repositories.venues.save(venue);
    const partnership = createPartnership({
      id: 'partnership_m3_reject',
      hostOrganizationId: 'host_org_m3_reject',
      venueOrganizationId: venue.organizationId,
      venueId: venue.id,
      initiatedBy: 'host',
      now: NOW,
    });
    await deps.repositories.partnerships.save(
      approvePartnership(partnership, venue.organizationId, NOW),
    );
    const venueActor: ActorContext = {
      userId: 'venue_owner_m3_reject',
      organizationId: venue.organizationId,
      role: 'owner',
      capabilities: ['venue'],
    };
    const hostActor: ActorContext = {
      userId: 'host_owner_m3_reject',
      organizationId: 'host_org_m3_reject',
      role: 'owner',
      capabilities: ['host'],
    };
    const offered = await new VenueCalendarService(deps).publishAvailability(venueActor, {
      venueId: venue.id,
      label: 'M3 rejection slot',
      startTime: '2026-11-05T12:30:00.000Z',
      endTime: '2026-11-05T16:30:00.000Z',
      timezone: 'Asia/Kolkata',
    });
    const requests = new VenueSlotRequestService(deps);
    const created = await requests.create(hostActor, {
      venueId: venue.id,
      slotId: offered.id,
      eventId: null,
    });
    await requests.reject(venueActor, created.id);
    expect(await deps.repositories.venueSlots.getSlotById(offered.id)).toMatchObject({
      status: 'open',
      slotRequestId: null,
      requestingHostId: null,
    });
  });

  it('creates one Host event only from its accepted reservation and claims that request once', async () => {
    const deps = createTestDeps();
    const venue = createVenue({
      id: 'venue_m3_event_slot',
      organizationId: 'venue_org_m3_event_slot',
      ownerId: 'venue_owner_m3_event_slot',
      name: 'M3 Test Venue',
      slug: 'm3-test-venue-event-slot',
      now: NOW,
    });
    await deps.repositories.venues.save(venue);
    const partnership = createPartnership({
      id: 'partnership_m3_event_slot',
      hostOrganizationId: 'host_org_m3_event_slot',
      venueOrganizationId: venue.organizationId,
      venueId: venue.id,
      initiatedBy: 'host',
      now: NOW,
    });
    await deps.repositories.partnerships.save(
      approvePartnership(partnership, venue.organizationId, NOW),
    );
    const venueActor: ActorContext = {
      userId: 'venue_owner_m3_event_slot',
      organizationId: venue.organizationId,
      role: 'owner',
      capabilities: ['venue'],
    };
    const hostActor: ActorContext = {
      userId: 'host_owner_m3_event_slot',
      organizationId: 'host_org_m3_event_slot',
      role: 'owner',
      capabilities: ['host'],
    };
    const slot = await new VenueCalendarService(deps).publishAvailability(venueActor, {
      venueId: venue.id,
      label: 'M3 event reservation',
      startTime: '2026-11-06T12:30:00.000Z',
      endTime: '2026-11-06T16:30:00.000Z',
      timezone: 'Asia/Kolkata',
      visibleToHostIds: [hostActor.organizationId],
    });
    await expect(
      new EventService(deps).create(venueActor, {
        venueId: venue.id,
        title: 'Conflicting Venue event',
        startAt: '2026-11-06T13:00:00.000Z',
        endAt: '2026-11-06T15:00:00.000Z',
      }),
    ).rejects.toThrow(/conflicts with a Venue calendar slot/);
    const slotRequests = new VenueSlotRequestService(deps);
    const request = await slotRequests.create(hostActor, {
      venueId: venue.id,
      slotId: slot.id,
      eventId: null,
    });
    await slotRequests.accept(venueActor, request.id);
    const events = new EventService(deps);
    const command = {
      venueId: venue.id,
      slotRequestId: request.id,
      title: 'M3-HOST-E2E event',
      startAt: '2026-11-06T13:00:00.000Z',
      endAt: '2026-11-06T15:00:00.000Z',
    };
    const eventRepository = deps.repositories.events;
    const saveEvent = eventRepository.save.bind(eventRepository);
    let failNextSave = true;
    eventRepository.save = async (candidate, tx) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('simulated transient event-store failure');
      }
      return saveEvent(candidate, tx);
    };
    await expect(events.create(hostActor, command)).rejects.toThrow(
      'simulated transient event-store failure',
    );
    const claimedRequest = await deps.repositories.slotRequests.getById(request.id);
    if (!claimedRequest?.eventId) throw new Error('Expected accepted request to retain its claim');
    expect(await deps.repositories.events.getById(claimedRequest.eventId)).toBeNull();

    const event = await events.create(hostActor, command);
    expect(event).toMatchObject({ venueId: venue.id, organizationId: hostActor.organizationId });
    expect(await deps.repositories.slotRequests.getById(request.id)).toMatchObject({
      status: 'accepted',
      eventId: event.id,
    });
    await expect(events.create(hostActor, command)).resolves.toMatchObject({ id: event.id });
    await expect(
      events.create(hostActor, {
        venueId: venue.id,
        slotRequestId: request.id,
        title: 'Duplicate M3 event',
        startAt: '2026-11-06T13:00:00.000Z',
        endAt: '2026-11-06T15:00:00.000Z',
      }),
    ).rejects.toThrow(/unavailable for this Host/);
    await expect(
      events.create(hostActor, {
        venueId: venue.id,
        title: 'Unreserved Host event',
        startAt: '2026-11-06T13:00:00.000Z',
        endAt: '2026-11-06T15:00:00.000Z',
      }),
    ).rejects.toThrow(/accepted Venue slot request/);
  });
});
