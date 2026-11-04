import { ConflictError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { TicketTier } from '../../domain/models/event-catalog.js';
import type { Event } from '../../domain/models/event.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { CheckoutService } from '../checkout/checkout-service.js';
import type { ActorContext, ServiceDeps } from '../context.js';

const OFFER_TTL_MS = 10 * 60 * 1000;

export class WaitlistService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly checkout: CheckoutService,
    private readonly authority: AdminAuthorityService,
  ) {}

  async join(input: {
    userId: EntityId;
    eventId: EntityId;
    tierId: EntityId;
    accessGrantId?: EntityId | null;
    eligibilityAttested?: boolean;
  }) {
    const user = await this.deps.repositories.users.getById(input.userId);
    if (!user?.emailVerified) {
      throw new InvalidOperationError('A verified account is required to join a waitlist');
    }
    const event = await this.deps.repositories.events.getById(input.eventId);
    if (!event) throw new NotFoundError('event', input.eventId);
    const tier = await this.deps.repositories.catalog.getTierById(input.tierId);
    if (
      !tier ||
      tier.eventId !== event.id ||
      tier.status !== 'active' ||
      tier.accessType === 'RSVP'
    ) {
      throw new NotFoundError('ticket_tier', input.tierId);
    }
    const actor = guestActor(input.userId, event.organizationId);
    const accessGrantId = input.accessGrantId ?? null;
    const eligibilityAttested = input.eligibilityAttested === true;
    // Quote rechecks private grants, current sale state, eligibility and the
    // exact server price before the account enters the queue.
    await this.checkout.quote({
      actor,
      eventId: event.id,
      lines: [
        {
          tierId: tier.id,
          quantity: 1,
          ...(accessGrantId ? { accessGrantId } : {}),
          ...(eligibilityAttested ? { eligibilityAttested: true } : {}),
        },
      ],
      promoCode: null,
      referralCode: null,
    });
    if ((await this.deps.inventory.getAvailableQuantity(event.id, tier.id)) > 0) {
      throw new ConflictError('Tickets remain available; waitlist entry is not needed');
    }
    return this.deps.repositories.waitlist.join({
      id: this.deps.config.ids(),
      eventId: event.id,
      organizationId: event.organizationId,
      tierId: tier.id,
      userId: input.userId,
      accessGrantId,
      eligibilityAttested,
      now: this.deps.config.clock.now(),
    });
  }

  async listMine(userId: EntityId, query: { limit: number; cursor: string | null }) {
    const page = await this.deps.repositories.waitlist.listByUser(userId, query);
    const now = this.deps.config.clock.now();
    for (const entry of page.items) {
      if (
        (entry.status === 'offered' || entry.status === 'accepted') &&
        entry.offerExpiresAt &&
        Date.parse(entry.offerExpiresAt) <= now.getTime()
      ) {
        await this.expire(entry.id, now);
      }
    }
    return this.deps.repositories.waitlist.listByUser(userId, query);
  }

  async cancel(userId: EntityId, entryId: EntityId) {
    const entry = await this.deps.repositories.waitlist.getById(entryId);
    if (!entry || entry.userId !== userId) throw new NotFoundError('waitlist_entry', entryId);
    const cancelled = await this.deps.repositories.waitlist.cancel({
      entryId,
      userId,
      now: this.deps.config.clock.now(),
    });
    if (entry.offerReservationId) {
      const hold = await this.deps.repositories.cartReservations.getById(entry.offerReservationId);
      if (hold?.status === 'active') await this.deps.repositories.cartReservations.release(hold.id);
    }
    return cancelled;
  }

  async accept(userId: EntityId, entryId: EntityId) {
    const user = await this.deps.repositories.users.getById(userId);
    const entry = await this.deps.repositories.waitlist.getById(entryId);
    if (!user?.emailVerified || !entry || entry.userId !== userId) {
      throw new NotFoundError('waitlist_entry', entryId);
    }
    if (!entry.offerReservationId)
      throw new ConflictError('Waitlist entry has no active inventory offer');
    const hold = await this.deps.repositories.cartReservations.getById(entry.offerReservationId);
    if (
      !hold ||
      hold.userId !== userId ||
      hold.status !== 'active' ||
      hold.eventId !== entry.eventId ||
      Date.parse(hold.expiresAt) <= this.deps.config.clock.now().getTime()
    ) {
      if (
        entry.offerExpiresAt &&
        Date.parse(entry.offerExpiresAt) <= this.deps.config.clock.now().getTime()
      ) {
        await this.expire(entry.id, this.deps.config.clock.now());
      }
      throw new ConflictError('Waitlist reservation is no longer active');
    }
    const accepted = await this.deps.repositories.waitlist.acceptOffer({
      entryId,
      userId,
      now: this.deps.config.clock.now(),
    });
    return { entry: accepted, holdId: hold.id, expiresAt: hold.expiresAt, pricing: hold.pricing };
  }

  async getAcceptedOffer(userId: EntityId, entryId: EntityId) {
    const entry = await this.deps.repositories.waitlist.getById(entryId);
    if (!entry || entry.userId !== userId || entry.status !== 'accepted') {
      throw new NotFoundError('waitlist_entry', entryId);
    }
    const now = this.deps.config.clock.now();
    if (!entry.offerExpiresAt || Date.parse(entry.offerExpiresAt) <= now.getTime()) {
      await this.expire(entry.id, now);
      throw new ConflictError('Waitlist reservation has expired');
    }
    const hold = entry.offerReservationId
      ? await this.deps.repositories.cartReservations.getById(entry.offerReservationId)
      : null;
    if (
      !hold ||
      hold.userId !== userId ||
      hold.eventId !== entry.eventId ||
      hold.status !== 'active' ||
      Date.parse(hold.expiresAt) <= now.getTime()
    ) {
      if (hold?.status === 'active') await this.deps.repositories.cartReservations.release(hold.id);
      await this.expire(entry.id, now);
      throw new ConflictError('Waitlist reservation is no longer active');
    }
    return { entry, holdId: hold.id, expiresAt: hold.expiresAt, pricing: hold.pricing };
  }

  async offerNext(adminUserId: EntityId, eventId: EntityId, tierId: EntityId) {
    const admin = await this.authority.authorize(adminUserId, 'WAITLIST_OFFER_MANAGE');
    const { event, tier } = await this.getEventAndTier(eventId, tierId);
    if (tier.status !== 'active' || tier.accessType === 'RSVP') {
      throw new NotFoundError('ticket_tier', tierId);
    }
    const offer = await this.issueNextOffer(admin.id, event, tier);
    if (!offer) return null;
    await this.authority.record(admin, {
      action: 'WAITLIST_OFFER.issue',
      targetType: 'waitlist_entry',
      targetId: offer.entry.id,
      before: { status: 'waiting' },
      after: { status: offer.entry.status, holdId: offer.holdId, expiresAt: offer.expiresAt },
      reason: 'Next eligible waitlist account offered a bounded reservation',
    });
    return offer;
  }

  async offerNextForPartner(actor: ActorContext, eventId: EntityId, tierId: EntityId) {
    const { event, tier } = await this.getEventAndTier(eventId, tierId);
    requireOrgAccess(actor, event.organizationId);
    if (tier.status !== 'active' || tier.accessType === 'RSVP') {
      throw new NotFoundError('ticket_tier', tierId);
    }
    return this.issueNextOffer(actor.userId, event, tier);
  }

  async listForPartner(
    actor: ActorContext,
    eventId: EntityId,
    tierId: EntityId,
    query: { limit: number; cursor: string | null },
  ) {
    const { event } = await this.getEventAndTier(eventId, tierId);
    requireOrgAccess(actor, event.organizationId);
    return this.deps.repositories.waitlist.listByEventTier(event.id, tierId, query);
  }

  private async getEventAndTier(eventId: EntityId, tierId: EntityId) {
    const event = await this.deps.repositories.events.getById(eventId);
    const tier = await this.deps.repositories.catalog.getTierById(tierId);
    if (!event) throw new NotFoundError('event', eventId);
    if (!tier || tier.eventId !== event.id) throw new NotFoundError('ticket_tier', tierId);
    return { event, tier };
  }

  private async issueNextOffer(actorId: EntityId, event: Event, tier: TicketTier) {
    const queued = await this.deps.repositories.waitlist.getNextWaiting(event.id, tier.id);
    if (!queued) return null;
    const recipient = await this.deps.repositories.users.getById(queued.userId);
    if (!recipient?.emailVerified) {
      throw new ConflictError('The next waitlist account is no longer verified and needs review');
    }
    const actor = guestActor(queued.userId, event.organizationId);
    const now = this.deps.config.clock.now();
    const { pricing, attribution } = await this.checkout.quote({
      actor,
      eventId: event.id,
      lines: [
        {
          tierId: tier.id,
          quantity: 1,
          ...(queued.accessGrantId ? { accessGrantId: queued.accessGrantId } : {}),
          ...(queued.eligibilityAttested ? { eligibilityAttested: true } : {}),
        },
      ],
      promoCode: null,
      referralCode: null,
    });
    const hold = await this.checkout.createHold({
      actor,
      eventId: event.id,
      organizationId: event.organizationId,
      lines: pricing.lines.map((line) => ({
        tierId: line.tierId,
        tierName: line.tierName,
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
        ...(line.admissionUnitPricePaise === undefined
          ? {}
          : { admissionUnitPricePaise: line.admissionUnitPricePaise }),
        ...(line.coverUnitPricePaise === undefined
          ? {}
          : { coverUnitPricePaise: line.coverUnitPricePaise }),
        ...(line.coverPolicy === undefined ? {} : { coverPolicy: line.coverPolicy }),
        ...(queued.accessGrantId ? { accessGrantId: queued.accessGrantId } : {}),
        ...(queued.eligibilityAttested ? { eligibilityAttested: true } : {}),
      })),
      pricing,
      appliedPromoCode: pricing.appliedPromoCode,
      attribution,
      userId: queued.userId,
      attendee: null,
      idempotencyKey: `waitlist-offer:${queued.id}`,
      reservationTtlMs: OFFER_TTL_MS,
    });
    if (
      hold.status !== 'active' ||
      (await this.deps.inventory.firstOverbookedTier(hold)) !== null
    ) {
      if (hold.status === 'active') await this.deps.repositories.cartReservations.release(hold.id);
      throw new ConflictError('No reservable inventory remains for the next waitlist offer');
    }
    const offered = await this.deps.repositories.waitlist.offerNext({
      eventId: event.id,
      tierId: tier.id,
      actorId,
      reservationId: hold.id,
      expiresAt: hold.expiresAt,
      now,
    });
    if (!offered || offered.id !== queued.id) {
      await this.deps.repositories.cartReservations.release(hold.id);
      throw new ConflictError('Waitlist order changed while reserving the offer');
    }
    return { entry: offered, holdId: hold.id, expiresAt: hold.expiresAt, pricing };
  }

  async listForAdmin(
    adminUserId: EntityId,
    eventId: EntityId,
    tierId: EntityId,
    query: { limit: number; cursor: string | null },
  ) {
    await this.authority.authorize(adminUserId, 'WAITLIST_OFFER_MANAGE');
    await this.getEventAndTier(eventId, tierId);
    return this.deps.repositories.waitlist.listByEventTier(eventId, tierId, query);
  }

  async expire(entryId: EntityId, now = this.deps.config.clock.now()) {
    const entry = await this.deps.repositories.waitlist.getById(entryId);
    if (!entry) throw new NotFoundError('waitlist_entry', entryId);
    const expired = await this.deps.repositories.waitlist.expireOffer({ entryId, now });
    if (entry.offerReservationId) {
      const hold = await this.deps.repositories.cartReservations.getById(entry.offerReservationId);
      if (hold?.status === 'active') await this.deps.repositories.cartReservations.release(hold.id);
    }
    return expired;
  }

  async cleanupExpiredOffers(now = this.deps.config.clock.now(), limit = 100) {
    const candidates = await this.deps.repositories.waitlist.listExpiredOffers(now, limit);
    let expiredCount = 0;
    for (const entry of candidates) {
      try {
        await this.expire(entry.id, now);
        expiredCount += 1;
      } catch (error) {
        const current = await this.deps.repositories.waitlist.getById(entry.id);
        if (current?.status !== 'expired' && current?.status !== 'accepted') throw error;
      }
    }
    return expiredCount;
  }
}

function guestActor(userId: EntityId, organizationId: EntityId): ActorContext {
  return { userId, organizationId, role: 'member', capabilities: [] };
}
