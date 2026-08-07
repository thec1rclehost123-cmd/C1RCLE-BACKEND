import {
  VenueNotFoundError,
  SlotRequestNotFoundError,
  VersionConflictError,
} from '../../domain/errors.js';
import {
  createVenue,
  updateVenue,
  createSlotRequest,
  transitionSlotRequest,
} from '../../domain/models/venue.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  Venue,
  VenueUpdate,
  VenuePublicProfile,
  VenuePrivateProfile,
  SlotRequest,
} from '../../domain/models/venue.js';
import type {
  VenueRepository,
  SlotRequestRepository,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateVenueCommand {
  name: string;
  slug: string;
}

export interface UpdateVenueCommand {
  venueId: EntityId;
  expectedVersion: number | null;
  update: VenueUpdate;
}

export interface CreateSlotRequestCommand {
  venueId: EntityId;
  eventId: EntityId | null;
  hostId: EntityId;
  message?: string;
}

export class VenueService {
  constructor(private deps: ServiceDeps) {}

  private get repo(): VenueRepository {
    return this.deps.repositories.venues;
  }

  async create(actor: ActorContext, command: CreateVenueCommand): Promise<Venue> {
    const venue = createVenue({
      id: this.deps.config.ids(),
      organizationId: actor.organizationId,
      ownerId: actor.userId,
      name: command.name,
      slug: command.slug,
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(venue);
    return venue;
  }

  async get(actor: ActorContext, venueId: EntityId): Promise<Venue> {
    return this.fetchOwned(actor, venueId);
  }

  async list(actor: ActorContext, query: PaginationQuery) {
    return this.repo.listByOrganization(actor.organizationId, query);
  }

  async update(actor: ActorContext, command: UpdateVenueCommand): Promise<Venue> {
    const venue = await this.fetchOwned(actor, command.venueId);
    if (command.expectedVersion !== null && venue.version !== command.expectedVersion) {
      throw new VersionConflictError(command.expectedVersion, venue.version);
    }
    const updated = updateVenue(venue, command.update, this.deps.config.clock.now());
    if (updated === venue) return venue;
    await this.repo.save(updated);
    return updated;
  }

  async getPublicProfile(actor: ActorContext, venueId: EntityId): Promise<VenuePublicProfile> {
    const venue = await this.fetchOwned(actor, venueId);
    return venue.public;
  }

  async updatePrivate(
    actor: ActorContext,
    venueId: EntityId,
    patch: Partial<VenuePrivateProfile>,
  ): Promise<Venue> {
    const venue = await this.fetchOwned(actor, venueId);
    const updated = updateVenue(venue, { private: patch }, this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }

  private async fetchOwned(actor: ActorContext, venueId: EntityId): Promise<Venue> {
    requireOrgAccess(actor, actor.organizationId);
    const venue = await this.repo.getById(venueId);
    if (!venue) throw new VenueNotFoundError(venueId);
    if (venue.organizationId !== actor.organizationId) {
      throw new VenueNotFoundError(venueId);
    }
    return venue;
  }
}

export class VenueCalendarService {
  constructor(private deps: ServiceDeps) {}

  async getSlots(actor: ActorContext, venueId: EntityId, from: string, to: string) {
    const venues = this.deps.repositories.venues;
    const venue = await venues.getById(venueId);
    if (!venue || venue.organizationId !== actor.organizationId) {
      throw new VenueNotFoundError(venueId);
    }
    return this.deps.repositories.venueSlots.listSlots(venueId, from, to);
  }
}

export class VenueSlotRequestService {
  constructor(private deps: ServiceDeps) {}

  private get repo(): SlotRequestRepository {
    return this.deps.repositories.slotRequests;
  }

  private async assertOwnedRequest(
    actor: ActorContext,
    slotRequestId: EntityId,
  ): Promise<SlotRequest> {
    const request = await this.repo.getById(slotRequestId);
    if (!request) throw new SlotRequestNotFoundError(slotRequestId);
    // Tenant check: only the venue's org may accept/reject its slot requests.
    const venues = this.deps.repositories.venues;
    const venue = await venues.getById(request.venueId);
    if (!venue || venue.organizationId !== actor.organizationId) {
      throw new SlotRequestNotFoundError(slotRequestId);
    }
    return request;
  }

  async create(actor: ActorContext, command: CreateSlotRequestCommand): Promise<SlotRequest> {
    const request = createSlotRequest({
      id: this.deps.config.ids(),
      venueId: command.venueId,
      eventId: command.eventId,
      hostId: command.hostId,
      message: command.message,
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(request);
    return request;
  }

  async listForVenue(actor: ActorContext, venueId: EntityId, query: PaginationQuery) {
    const venues = this.deps.repositories.venues;
    const venue = await venues.getById(venueId);
    if (!venue || venue.organizationId !== actor.organizationId) {
      throw new VenueNotFoundError(venueId);
    }
    return this.repo.listByVenue(venueId, query);
  }

  async accept(actor: ActorContext, slotRequestId: EntityId): Promise<SlotRequest> {
    const request = await this.assertOwnedRequest(actor, slotRequestId);
    const updated = transitionSlotRequest(request, 'accepted', this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }

  async reject(actor: ActorContext, slotRequestId: EntityId): Promise<SlotRequest> {
    const request = await this.assertOwnedRequest(actor, slotRequestId);
    const updated = transitionSlotRequest(request, 'rejected', this.deps.config.clock.now());
    await this.repo.save(updated);
    return updated;
  }
}
