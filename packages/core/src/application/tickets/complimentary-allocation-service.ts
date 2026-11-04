import { createHash } from 'node:crypto';

import { ConflictError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { createCartReservation } from '../../domain/models/cart-reservation.js';
import { createComplimentaryAllocation } from '../../domain/models/complimentary-allocation.js';
import { issueEntitlements, voidEntitlement } from '../../domain/models/entitlement.js';
import {
  createOrder,
  markZeroValueOrderIssued,
  markZeroValueOrderVoided,
} from '../../domain/models/order.js';
import { FinancialPostingService } from '../finance/financial-posting-service.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ComplimentaryAllocation,
  ComplimentaryCategory,
} from '../../domain/models/complimentary-allocation.js';
import type { PricingBreakdown } from '../../domain/models/pricing.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

export class ComplimentaryAllocationService {
  private readonly posting: FinancialPostingService;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly authority: AdminAuthorityService,
  ) {
    this.posting = new FinancialPostingService(deps.repositories.financialJournals);
  }

  async createAllocation(
    adminUserId: EntityId,
    input: {
      eventId: EntityId;
      tierId: EntityId;
      category: ComplimentaryCategory;
      reason: string;
      quota: number;
      expiresAt?: string | null;
    },
  ) {
    const admin = await this.authority.authorize(adminUserId, 'COMPLIMENTARY_ALLOCATION_MANAGE');
    const event = await this.deps.repositories.events.getById(input.eventId);
    if (!event) throw new NotFoundError('event', input.eventId);
    const tier = await this.deps.repositories.catalog.getTierById(input.tierId);
    if (!tier || tier.eventId !== event.id) throw new NotFoundError('ticket_tier', input.tierId);
    this.assertCompTierEligible(tier);
    if (input.quota > (tier.quantity ?? 0)) {
      throw new InvalidOperationError('Allocation quota cannot exceed the ticket tier capacity');
    }
    const allocation = createComplimentaryAllocation({
      id: this.deps.config.ids(),
      eventId: event.id,
      organizationId: event.organizationId,
      tierId: tier.id,
      category: input.category,
      reason: input.reason,
      quota: input.quota,
      createdBy: admin.id,
      expiresAt: input.expiresAt,
      now: this.deps.config.clock.now(),
    });
    await this.deps.repositories.complimentaryAllocations.createAllocation(allocation);
    await this.authority.record(admin, {
      action: 'COMPLIMENTARY_ALLOCATION.create',
      targetType: 'complimentary_allocation',
      targetId: allocation.id,
      before: null,
      after: {
        eventId: event.id,
        tierId: tier.id,
        category: allocation.category,
        quota: allocation.quota,
        expiresAt: allocation.expiresAt,
      },
      reason: allocation.reason,
    });
    return allocation;
  }

  async listAllocations(
    adminUserId: EntityId,
    eventId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<ComplimentaryAllocation>> {
    await this.authority.authorize(adminUserId, 'COMPLIMENTARY_ALLOCATION_MANAGE');
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new NotFoundError('event', eventId);
    return this.deps.repositories.complimentaryAllocations.listAllocationsByEvent(eventId, query);
  }

  async issueClaim(
    adminUserId: EntityId,
    allocationId: EntityId,
    input: {
      recipientUserId: EntityId;
      holderName: string;
      idempotencyKey: string;
    },
  ) {
    const admin = await this.authority.authorize(adminUserId, 'COMPLIMENTARY_ALLOCATION_MANAGE');
    if (!input.idempotencyKey.trim()) {
      throw new InvalidOperationError('A comp claim idempotency key is required');
    }
    const allocation =
      await this.deps.repositories.complimentaryAllocations.getAllocation(allocationId);
    if (!allocation) throw new NotFoundError('complimentary_allocation', allocationId);
    const event = await this.deps.repositories.events.getById(allocation.eventId);
    const tier = await this.deps.repositories.catalog.getTierById(allocation.tierId);
    if (!event || !tier || tier.eventId !== event.id) {
      throw new InvalidOperationError('Comp allocation no longer matches its event tier');
    }
    this.assertCompTierEligible(tier);
    const recipient = await this.deps.repositories.users.getById(input.recipientUserId);
    if (!recipient?.emailVerified) {
      throw new InvalidOperationError('Complimentary tickets require a verified recipient account');
    }

    const digest = createHash('sha256')
      .update(`${allocation.id}\n${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 32);
    const claimId = `COMP-CLAIM-${digest}`;
    const orderId = `COMP-ORDER-${digest}`;
    const holdId = `COMP-HOLD-${digest}`;
    const now = this.deps.config.clock.now();
    const claimBefore = await this.deps.repositories.complimentaryAllocations.getClaim(claimId);
    if (claimBefore?.status === 'revoked') {
      throw new ConflictError('This complimentary claim was revoked and cannot be reissued');
    }
    let order = await this.deps.repositories.orders.getById(orderId);

    const pricing: PricingBreakdown = {
      lines: [
        {
          tierId: tier.id,
          tierName: tier.name,
          quantity: 1,
          unitPricePaise: 0,
          subtotalPaise: 0,
        },
      ],
      subtotalPaise: 0,
      admissionSubtotalPaise: 0,
      coverSubtotalPaise: 0,
      discountedAdmissionSubtotalPaise: 0,
      discountPaise: 0,
      discountFundingOwner: null,
      discountedSubtotalPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      gstPaise: 0,
      grandTotalPaise: 0,
      appliedPromoCode: null,
      currency: tier.currency,
    };
    const reservation = createCartReservation({
      id: holdId,
      eventId: event.id,
      organizationId: event.organizationId,
      userId: input.recipientUserId,
      lines: [
        {
          tierId: tier.id,
          tierName: tier.name,
          quantity: 1,
          unitPricePaise: 0,
        },
      ],
      pricing,
      appliedPromoCode: null,
      attribution: null,
      idempotencyKey: `complimentary:${claimId}`,
      reservationTtlMs: 10 * 60 * 1000,
      now,
    });
    let storedHold = await this.deps.repositories.cartReservations.create(reservation);
    if (storedHold.status === 'active' && order === null) {
      const overbookedTier = await this.deps.inventory.firstOverbookedTier(storedHold);
      if (overbookedTier !== null) {
        await this.deps.repositories.cartReservations.release(storedHold.id);
        throw new ConflictError('No ticket inventory remains for this comp claim');
      }
    }
    if (order === null && storedHold.status !== 'active') {
      throw new ConflictError('Comp inventory reservation expired; start a new claim request');
    }

    let issued;
    try {
      issued = await this.deps.repositories.complimentaryAllocations.issueClaim({
        allocationId: allocation.id,
        claimId,
        orderId,
        recipientUserId: input.recipientUserId,
        holderName: input.holderName,
        issuedBy: admin.id,
        now,
      });
    } catch (error) {
      if (storedHold.status === 'active') {
        await this.deps.repositories.cartReservations.release(storedHold.id);
      }
      throw error;
    }

    if (order === null) {
      const pending = createOrder({
        id: orderId,
        eventId: event.id,
        organizationId: event.organizationId,
        userId: input.recipientUserId,
        contact: { name: input.holderName.trim(), email: '', phone: '' },
        pricing,
        now,
      });
      try {
        await this.deps.repositories.orders.save(pending);
        order = pending;
      } catch (error) {
        const winner = await this.deps.repositories.orders.getById(orderId);
        if (!winner) throw error;
        order = winner;
      }
    }
    if (order.status === 'pending') {
      order = markZeroValueOrderIssued(order, now);
      await this.deps.repositories.orders.save(order);
    }
    if (
      order.status !== 'paid' ||
      order.grandTotalPaise !== 0 ||
      order.paymentId !== null ||
      order.paymentIntentId !== null
    ) {
      throw new InvalidOperationError(
        'Comp order is not a zero-value order without provider payment',
      );
    }

    if (storedHold.status === 'active') {
      await this.deps.repositories.cartReservations.convertToOrder(storedHold.id, order.id);
      storedHold =
        (await this.deps.repositories.cartReservations.getById(storedHold.id)) ?? storedHold;
    }
    if (storedHold.status !== 'converted' || storedHold.convertedOrderId !== order.id) {
      throw new ConflictError('Comp inventory reservation could not be bound to its order');
    }

    const existingEntitlements = await this.deps.repositories.entitlements.getByOrderId(order.id);
    const wanted = issueEntitlements({ order, unitKind: 'complimentary', now });
    const have = new Set(existingEntitlements.map((entitlement) => entitlement.id));
    for (const entitlement of wanted) {
      if (!have.has(entitlement.id)) await this.deps.repositories.entitlements.save(entitlement);
    }
    const entitlements = await this.deps.repositories.entitlements.getByOrderId(order.id);
    await this.posting.postZeroValueEvidence({
      organizationId: order.organizationId,
      orderId: order.id,
      eventId: order.eventId,
      currency: order.currency,
      sourceType: 'complimentary_ticket',
      postedAt: now,
    });
    for (const entitlement of entitlements) {
      await this.deps.outbox.append(
        domainEvent({
          id: deterministicDomainEventId('ticket.issued', entitlement.id),
          type: 'ticket.issued',
          aggregateId: entitlement.id,
          organizationId: entitlement.organizationId,
          actorId: admin.id,
          payload: {
            entitlementId: entitlement.id,
            orderId: order.id,
            eventId: event.id,
            purchaserUserId: entitlement.userId,
            holderUserId: entitlement.currentHolderUserId ?? entitlement.userId,
          },
          occurredAt: now.getTime(),
        }),
      );
    }
    if (!claimBefore) {
      await this.authority.record(admin, {
        action: 'COMPLIMENTARY_ALLOCATION.issue',
        targetType: 'complimentary_claim',
        targetId: issued.claim.id,
        before: { claimedCount: allocation.claimedCount },
        after: {
          claimedCount: issued.allocation.claimedCount,
          recipientUserId: issued.claim.recipientUserId,
          orderId: order.id,
        },
        reason: allocation.reason,
      });
    }
    return { allocation: issued.allocation, claim: issued.claim, order, entitlements };
  }

  async revokeClaim(adminUserId: EntityId, claimId: EntityId, reason: string) {
    const admin = await this.authority.authorize(adminUserId, 'COMPLIMENTARY_ALLOCATION_MANAGE');
    const claim = await this.deps.repositories.complimentaryAllocations.getClaim(claimId);
    if (!claim) throw new NotFoundError('complimentary_claim', claimId);
    let order = await this.deps.repositories.orders.getById(claim.orderId);
    if (
      !order ||
      order.grandTotalPaise !== 0 ||
      order.paymentId !== null ||
      order.paymentIntentId !== null
    ) {
      throw new InvalidOperationError('Only a zero-value complimentary order can be revoked here');
    }
    const entitlements = await this.deps.repositories.entitlements.getByOrderId(order.id);
    const entitlement = entitlements[0];
    if (entitlements.length !== 1 || !entitlement)
      throw new InvalidOperationError('Comp order entitlement state is incomplete');
    if (
      claim.status === 'revoked' &&
      entitlement.status === 'void' &&
      order.status === 'refunded'
    ) {
      return { claim, entitlement };
    }
    if (claim.status === 'issued') {
      if (
        entitlement.status === 'redeemed' ||
        entitlement.scanCount !== 0 ||
        entitlement.pendingTransferId ||
        entitlement.refundLock
      ) {
        throw new InvalidOperationError(
          'Only an unused, unlocked complimentary ticket can be revoked',
        );
      }
      if (entitlement.status === 'valid') {
        await this.deps.repositories.entitlements.save(
          voidEntitlement(entitlement, this.deps.config.clock.now()),
        );
      }
    }
    if (order.status === 'paid') {
      order = markZeroValueOrderVoided(order, this.deps.config.clock.now());
      await this.deps.repositories.orders.save(order);
    }
    const revoked = await this.deps.repositories.complimentaryAllocations.revokeClaim({
      claimId,
      revokedBy: admin.id,
      reason,
      now: this.deps.config.clock.now(),
    });
    if (claim.status !== 'revoked') {
      await this.authority.record(admin, {
        action: 'COMPLIMENTARY_ALLOCATION.revoke',
        targetType: 'complimentary_claim',
        targetId: claimId,
        before: { status: claim.status, entitlementId: entitlement.id },
        after: { status: revoked.status, entitlementStatus: 'void', orderStatus: order.status },
        reason,
      });
    }
    return {
      claim: revoked,
      entitlement: await this.deps.repositories.entitlements.getById(entitlement.id),
    };
  }

  private assertCompTierEligible(tier: {
    status: string;
    accessType?: string;
    coverAmountPaise?: number;
    minAge?: number | null;
    maxAge?: number | null;
    audienceType?: string | null;
  }) {
    if (tier.status !== 'active' || tier.accessType === 'RSVP') {
      throw new InvalidOperationError('Comps require an active non-RSVP admission tier');
    }
    if ((tier.coverAmountPaise ?? 0) > 0) {
      throw new InvalidOperationError('Complimentary issuance cannot bypass event cover payment');
    }
    if (
      tier.minAge != null ||
      tier.maxAge != null ||
      (tier.audienceType != null && tier.audienceType !== 'GENERAL')
    ) {
      throw new InvalidOperationError(
        'This eligibility-restricted tier requires a recipient attestation flow before comp issuance',
      );
    }
  }
}
