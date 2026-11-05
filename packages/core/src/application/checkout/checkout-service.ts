import { createHash } from 'node:crypto';

import {
  EventNotFoundError,
  ForbiddenError,
  InvalidOperationError,
  NotFoundError,
  TicketTierNotFoundError,
  UnauthorizedError,
  VersionConflictError,
} from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { newVersionedEntity } from '../../domain/identity.js';
import { snapshotBookingFeePolicy } from '../../domain/models/booking-fee-policy.js';
import {
  currentEntitlementHolderId,
  issueEntitlements,
  requiresEligibilityVerification,
} from '../../domain/models/entitlement.js';
import {
  effectiveTierPricePaise,
  COMMERCIAL_ALLOCATION_POLICY_VERSION,
  PROMOTER_COMMISSION_POLICY_VERSION,
} from '../../domain/models/event-catalog.js';
import {
  createEventCoverAccount,
  isEventCoverPolicyAccepted,
} from '../../domain/models/event-cover.js';
import { M4_ACCOUNTING_POLICY } from '../../domain/models/financial-journal.js';
import {
  orderReceiptFacts,
  saleAccountingComplete,
  originalSaleJournalsComplete,
} from '../../domain/models/fulfilment.js';
import {
  computeSettlementSplit,
  promoterCommissionFitsDistributableValue,
} from '../../domain/models/ledger.js';
import { platformFeePercentFor } from '../../domain/models/onboarding.js';
import { commissionTierFor } from '../../domain/models/partnership.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import { snapshotOriginalPurchase } from '../../domain/models/purchase-refund-snapshot.js';
import {
  createReconciliationRun,
  completeReconciliationRun,
} from '../../domain/models/reconciliation.js';
import {
  allocationFromLedger,
  validateSaleAllocation,
} from '../../domain/models/sale-allocation.js';
import { isSystemActor, SYSTEM_ACTOR } from '../context.js';
import { requestCaptureCompensation } from '../finance/capture-compensation.js';
import { createFinanceService } from '../finance/finance-service.js';
import { FinancialPostingService } from '../finance/financial-posting-service.js';
import { createLeaderboardService } from '../finance/leaderboard-service.js';
import { ProviderPaymentService } from '../finance/provider-payment-service.js';
import {
  ReferralLinkService,
  signPromoterAttribution,
} from '../promoters/referral-link-service.js';
import { TicketAccessService } from '../tickets/ticket-access-service.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  CartReservation,
  TicketUpgradeSnapshot,
} from '../../domain/models/cart-reservation.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { CommissionTerms } from '../../domain/models/event-catalog.js';
import type { EventCoverPolicyProposal } from '../../domain/models/event-cover.js';
import type { Order, OrderContact } from '../../domain/models/order.js';
import type { PricingBreakdown } from '../../domain/models/pricing.js';
import type { SaleAllocationSnapshot } from '../../domain/models/sale-allocation.js';
import type { PaymentVerificationResponse } from '../../domain/ports/payment-provider.js';
import type { ActorContext, ServiceDeps } from '../context.js';
import type { FinanceService } from '../finance/finance-service.js';
import type { LeaderboardService } from '../finance/leaderboard-service.js';

/** Referral attribution captured at quote time, carried through to the hold. */
export interface CheckoutAttribution {
  referralLinkId: EntityId;
  promoterId: EntityId;
  code: string;
  assignmentId: EntityId;
  assignmentVersion: number;
  termsSnapshot: CommissionTerms;
  eligibleTierIds: EntityId[] | null;
  commissionPolicyVersion: string;
  commercialPolicyVersion: string;
  attributedAt: string;
  attributionSignature: string;
  promoterCommissionPaise: number;
}

/**
 * Deterministic RSVP order id for one user+event. Hashed (not concatenated)
 * so the result always fits the 64-char opaque-id cap regardless of id
 * lengths — same reason `entitlementId` hashes rather than concatenates.
 */
export function rsvpOrderId(eventId: EntityId, userId: EntityId): EntityId {
  const digest = createHash('sha256').update(`rsvp:${eventId}:${userId}`).digest('hex');
  return `RSVP-${digest.slice(0, 32)}`;
}

/**
 * ─── CheckoutService (Phase 4) ─────────────────────────────────────────────────
 * Orchestrates the full checkout flow:
 *   quote → holds → intent → confirm (dual path: webhook + redirect)
 * All mutations are idempotent and use the transactional outbox for fulfillment events.
 */
/** A fulfilment step a paid order may be missing. */
export type FulfilmentGap =
  | 'hold'
  | 'hold_conversion'
  | 'tickets'
  | 'cover_accounts'
  | 'ledger'
  | 'issuance_intents'
  | 'order_outbox'
  | 'completion'
  | 'order';

export interface FulfilmentGaps {
  /** False when no hold is bound to the order's provider order (nothing can be repaired). */
  holdFound: boolean;
  missing: FulfilmentGap[];
}

export interface PaymentRecoveryStatus {
  holdId: EntityId;
  eventId: EntityId;
  status:
    | 'pending'
    | 'processing'
    | 'fulfilled'
    | 'failed'
    | 'cancelled'
    | 'expired'
    | 'refunded'
    | 'requires_support';
  orderId: EntityId | null;
  expiresAt: string;
  updatedAt: string;
}

/** How long a hold keeps its seats (10 minutes). */
export const DEFAULT_HOLD_TTL_MS = 10 * 60 * 1000;
export const MAX_ACTIVE_PAID_UNITS_PER_EVENT_PER_PURCHASER = 10;

/** The smallest amount the payment provider will take (₹1). */
export const MIN_ONLINE_PAYMENT_PAISE = 100;

const EVENT_COVER_SALES_FLAG = 'm5EventCoverSales';
const EVENT_COVER_MERCHANT_APPROVAL_FLAG = 'm5CoverMerchantApproved';

function requiresEligibilityAttestation(tier: {
  audienceType?: string;
  minAge?: number | null;
  maxAge?: number | null;
}): boolean {
  return requiresEligibilityVerification(tier);
}

function assertEligibilityAttested(
  tier: { audienceType?: string; minAge?: number | null; maxAge?: number | null },
  attested?: boolean,
  eligibilityRulesEnabled?: boolean,
): void {
  const v1DoorRequirement = ['MALE', 'FEMALE', 'COUPLE'].includes(tier.audienceType ?? '');
  if (
    requiresEligibilityAttestation(tier) &&
    !v1DoorRequirement &&
    eligibilityRulesEnabled !== true
  ) {
    throw new ForbiddenError(
      'This eligibility-restricted ticket is unavailable until the required policy and entry controls are approved',
    );
  }
  if (requiresEligibilityAttestation(tier) && attested !== true) {
    throw new InvalidOperationError(
      'Confirm that all attendees meet this ticket eligibility policy',
    );
  }
}

export class CheckoutService {
  private readonly financeService: FinanceService;
  private readonly financialPostingService: FinancialPostingService;
  private readonly leaderboardService: LeaderboardService;
  private readonly providerPayments: ProviderPaymentService;

  constructor(
    private readonly deps: ServiceDeps,
    providerPayments = new ProviderPaymentService(deps),
  ) {
    this.providerPayments = providerPayments;
    this.financeService = createFinanceService({
      ledger: deps.repositories.ledger,
      financialJournals: deps.repositories.financialJournals,
      journalTransition: deps.repositories.journalTransition,
      payouts: deps.repositories.payouts,
      events: deps.repositories.events,
      reconciliations: deps.repositories.reconciliations,
      financialExposure: deps.repositories,
      config: deps.config,
    });
    this.financialPostingService = new FinancialPostingService(deps.repositories.financialJournals);
    this.leaderboardService = createLeaderboardService({
      leaderboard: deps.repositories.leaderboard,
      config: deps.config,
    });
  }

  private async requireAcceptedCoverPolicy(
    event: NonNullable<Awaited<ReturnType<ServiceDeps['repositories']['events']['getById']>>>,
    amountPaise: number,
    expected?: { proposalId: EntityId; policyVersion: string; termsDigest: string },
    requireSalesApproval = true,
  ): Promise<EventCoverPolicyProposal> {
    if (
      requireSalesApproval &&
      (this.deps.config.features[EVENT_COVER_SALES_FLAG] !== true ||
        this.deps.config.features[EVENT_COVER_MERCHANT_APPROVAL_FLAG] !== true ||
        this.deps.config.features.m5CoverAccountingApproved !== true)
    ) {
      throw new InvalidOperationError('Event cover sales are not approved or enabled');
    }
    const proposals = await this.deps.repositories.eventCoverPolicies.listProposalsByEvent(
      event.id,
    );
    const candidates = expected
      ? proposals.filter((proposal) => proposal.id === expected.proposalId)
      : proposals.filter((proposal) => proposal.terms.coverAmountPaise === amountPaise);
    for (const proposal of candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (
        proposal.hostOrganizationId !== event.organizationId ||
        proposal.terms.eventId !== event.id ||
        proposal.terms.coverAmountPaise !== amountPaise ||
        (expected &&
          (proposal.policyVersion !== expected.policyVersion ||
            proposal.termsDigest !== expected.termsDigest))
      ) {
        continue;
      }
      const venue = event.venueId
        ? await this.deps.repositories.venues.getById(event.venueId)
        : null;
      if (
        !venue ||
        venue.status !== 'active' ||
        venue.organizationId !== proposal.venueOrganizationId
      ) {
        continue;
      }
      if (event.organizationId !== venue.organizationId) {
        const partnership = await this.deps.repositories.partnerships.findByPair(
          event.organizationId,
          venue.id,
        );
        if (!partnership || partnership.status !== 'active') continue;
      }
      const acceptance = await this.deps.repositories.eventCoverPolicies.getAcceptance(proposal.id);
      if (isEventCoverPolicyAccepted(proposal, acceptance)) return proposal;
    }
    throw new InvalidOperationError('This ticket requires an accepted current Venue cover policy');
  }

  /**
   * Step 1: Quote — calculates pricing for a set of lines + promo.
   * Pure calculation, no side effects.
   */
  async quote(input: {
    actor: ActorContext;
    eventId: EntityId;
    lines: {
      tierId: EntityId;
      quantity: number;
      ticketAddons?: { addonId: EntityId; quantityPerEntitlement: number }[];
      accessGrantId?: EntityId;
      eligibilityAttested?: boolean;
    }[];
    promoCode?: string | null;
    referralCode?: string | null;
    upgradeFromEntitlementId?: EntityId;
  }): Promise<{
    pricing: PricingBreakdown;
    attribution: CheckoutAttribution | null;
    upgrade: TicketUpgradeSnapshot | null;
  }> {
    const { eventId, lines, promoCode, referralCode, upgradeFromEntitlementId } = input;
    if (
      lines.some((line) => line.ticketAddons?.length) &&
      this.deps.config.features.m5TicketAddonsEnabled !== true
    ) {
      throw new ForbiddenError('Ticket add-on sales are not enabled');
    }

    let sourceUpgrade: Omit<
      TicketUpgradeSnapshot,
      'targetTierId' | 'replacementAdmissionPaise' | 'incrementalAdmissionPaise'
    > | null = null;
    if (upgradeFromEntitlementId) {
      if (
        !input.actor.userId ||
        lines.length !== 1 ||
        lines[0]?.quantity !== 1 ||
        Boolean(lines[0]?.ticketAddons?.length) ||
        promoCode ||
        referralCode
      ) {
        throw new InvalidOperationError(
          'A ticket upgrade requires one authenticated, undiscounted ticket',
        );
      }
      const source = await this.deps.repositories.entitlements.getById(upgradeFromEntitlementId);
      if (
        !source ||
        source.eventId !== eventId ||
        currentEntitlementHolderId(source) !== input.actor.userId ||
        source.status !== 'valid' ||
        source.scanCount !== 0 ||
        source.refundLock ||
        source.pendingTransferId ||
        (source.unitKind ?? (source.orderId.startsWith('RSVP-') ? 'free_rsvp' : 'paid')) !== 'paid'
      ) {
        throw new InvalidOperationError('This ticket is not eligible for an upgrade');
      }
      const sourceOrder = await this.deps.repositories.orders.getById(source.orderId);
      const sourceLine = sourceOrder?.lines.find((line) => line.tierId === source.tierId);
      const sourceHold = sourceOrder?.paymentIntentId
        ? await this.deps.repositories.cartReservations.getByProviderOrderId(
            sourceOrder.paymentIntentId,
          )
        : null;
      const sourcePrice = sourceHold?.pricing.lines.find((line) => line.tierId === source.tierId);
      const sourceEntitlements = sourceOrder
        ? await this.deps.repositories.entitlements.getByOrderId(sourceOrder.id)
        : [];
      const sourceLineEntitlements = sourceEntitlements.filter(
        (item) => item.tierId === source.tierId,
      );
      if (
        !sourceOrder ||
        sourceOrder.status !== 'paid' ||
        sourceOrder.eventId !== eventId ||
        sourceHold?.convertedOrderId !== sourceOrder.id ||
        !sourceLine ||
        !sourcePrice ||
        sourceLine.quantity !== 1 ||
        sourceLineEntitlements.length !== 1 ||
        source.scanCountAllowed !== 1 ||
        (sourceLine.coverUnitPricePaise ?? 0) !== 0 ||
        (sourcePrice.coverUnitPricePaise ?? 0) !== 0
      ) {
        throw new InvalidOperationError(
          'Only a single-admission ticket without cover can be upgraded',
        );
      }
      const priorAdmissionPaidPaise =
        sourcePrice.discountedAdmissionSubtotalPaise ??
        sourcePrice.admissionSubtotalPaise ??
        sourcePrice.subtotalPaise;
      sourceUpgrade = {
        sourceEntitlementId: source.id,
        sourceEntitlementVersion: source.version,
        sourceOrderId: sourceOrder.id,
        sourceTierId: source.tierId,
        priorAdmissionPaidPaise,
      };
    }

    await this.assertOnSale(eventId);
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new EventNotFoundError(eventId);

    const coverPolicies = new Map<EntityId, EventCoverPolicyProposal>();
    for (const line of lines) {
      const tier = await this.deps.repositories.catalog.getTierById(line.tierId);
      if (!tier || tier.eventId !== eventId) {
        throw new TicketTierNotFoundError(line.tierId);
      }
      if (tier.accessType === 'RSVP' && line.ticketAddons?.length) {
        throw new InvalidOperationError('Ticket add-ons cannot be purchased with a free RSVP');
      }
      assertEligibilityAttested(
        tier,
        line.eligibilityAttested,
        this.deps.config.features.m5EligibilityRulesEnabled,
      );
      if ((tier.coverAmountPaise ?? 0) > 0) {
        coverPolicies.set(
          tier.id,
          await this.requireAcceptedCoverPolicy(event, tier.coverAmountPaise ?? 0),
        );
      }
      if (
        (tier.accessMode ?? 'public') !== 'public' &&
        (!line.accessGrantId ||
          !input.actor.userId ||
          !(await new TicketAccessService(this.deps).hasGrantForTier(
            line.accessGrantId,
            input.actor.userId,
            eventId,
            line.tierId,
          )))
      ) {
        throw new TicketTierNotFoundError(line.tierId);
      }
      if (
        (event.visibilityMode === 'code' || event.visibilityMode === 'invited') &&
        (!line.accessGrantId ||
          !input.actor.userId ||
          !(await new TicketAccessService(this.deps).hasGrantForEvent(
            line.accessGrantId,
            input.actor.userId,
            eventId,
            event.visibilityMode === 'invited' ? 'invitation' : 'code',
          )))
      ) {
        throw new TicketTierNotFoundError(line.tierId);
      }
    }

    const pricingLines = lines.map((l) => ({
      tierId: l.tierId,
      quantity: l.quantity,
      ...(l.ticketAddons === undefined ? {} : { ticketAddons: l.ticketAddons }),
    }));

    const targetPricing = await this.deps.pricing.calculate({
      eventId,
      lines: pricingLines,
      promoCode,
    });
    let upgrade: TicketUpgradeSnapshot | null = null;
    let basePricing = targetPricing;
    if (sourceUpgrade) {
      const requestedTarget = lines[0];
      if (!requestedTarget) throw new InvalidOperationError('A ticket upgrade requires one target');
      const targetLine = targetPricing.lines[0];
      const targetTier = await this.deps.repositories.catalog.getTierById(requestedTarget.tierId);
      const replacementAdmissionPaise = targetLine?.admissionUnitPricePaise ?? 0;
      const incrementalAdmissionPaise =
        replacementAdmissionPaise - sourceUpgrade.priorAdmissionPaidPaise;
      if (
        !targetLine ||
        !targetTier ||
        targetTier.id === sourceUpgrade.sourceTierId ||
        targetTier.coverAmountPaise ||
        (targetTier.admissionMode === 'per_person' && (targetTier.guestCount ?? 1) !== 1) ||
        incrementalAdmissionPaise <= 0
      ) {
        throw new InvalidOperationError(
          'The selected ticket does not have a positive upgrade price',
        );
      }
      basePricing = calculatePricing({
        lines: [
          {
            tier: { ...targetTier, priceInPaise: incrementalAdmissionPaise, coverAmountPaise: 0 },
            quantity: 1,
          },
        ],
        currency: 'INR',
      });
      upgrade = {
        ...sourceUpgrade,
        targetTierId: targetTier.id,
        replacementAdmissionPaise,
        incrementalAdmissionPaise,
      };
    }
    const pricing: PricingBreakdown = {
      ...basePricing,
      lines: basePricing.lines.map((line) => {
        const policy = coverPolicies.get(line.tierId);
        return policy
          ? {
              ...line,
              coverPolicy: {
                proposalId: policy.id,
                policyVersion: policy.policyVersion,
                termsDigest: policy.termsDigest,
              },
            }
          : line;
      }),
    };

    if (pricing.discountPaise > 0 && pricing.discountFundingOwner == null) {
      throw new InvalidOperationError(
        'This discount has no funding owner and cannot be used for a financial order',
      );
    }

    if (promoCode) await this.assertPromoWithinLimits(eventId, promoCode, input.actor.userId);

    // Razorpay refuses an order below 100 paise with an opaque error, after a seat
    // has already been held. Say so up front. (A total of exactly zero is a free
    // order and does not go through a payment provider.)
    if (pricing.grandTotalPaise > 0 && pricing.grandTotalPaise < MIN_ONLINE_PAYMENT_PAISE) {
      throw new InvalidOperationError('Online payments must be at least ₹1');
    }

    let attribution: CheckoutAttribution | null = null;
    if (referralCode) {
      const signed = await new ReferralLinkService(this.deps).resolveAttribution(
        eventId,
        referralCode,
        input.actor.userId,
      );
      if (signed) {
        const promoterCommissionPaise = commissionForLines(
          pricing.lines,
          signed.terms,
          signed.eligibleTierIds ?? null,
        );
        const event = await this.deps.repositories.events.getById(eventId);
        if (!event) throw new EventNotFoundError(eventId);
        const onboarding = await this.deps.repositories.onboarding.findByProvisionedOrganizationId(
          event.organizationId,
        );
        const platformFeeRate = platformFeePercentFor(onboarding?.plan ?? 'basic') / 100;
        let venueShareRate = 0;
        if (event.venueId) {
          const partnership = await this.deps.repositories.partnerships.findByPair(
            event.organizationId,
            event.venueId,
          );
          venueShareRate = (partnership?.venueShareRate ?? 0) / 100;
        }
        if (
          !promoterCommissionFitsDistributableValue(
            pricing.discountedAdmissionSubtotalPaise ?? pricing.discountedSubtotalPaise,
            promoterCommissionPaise,
            platformFeeRate,
            venueShareRate,
          )
        ) {
          throw new InvalidOperationError(
            'The assigned promoter commission exceeds this order’s distributable ticket revenue',
          );
        }
        attribution = {
          referralLinkId: signed.referralLinkId,
          promoterId: signed.promoterId,
          code: signed.code,
          assignmentId: signed.assignmentId,
          assignmentVersion: signed.assignmentVersion,
          termsSnapshot: signed.terms,
          eligibleTierIds: signed.eligibleTierIds ?? null,
          commissionPolicyVersion:
            signed.commissionPolicyVersion ?? PROMOTER_COMMISSION_POLICY_VERSION,
          commercialPolicyVersion:
            signed.commercialPolicyVersion ?? COMMERCIAL_ALLOCATION_POLICY_VERSION,
          attributedAt: this.deps.config.clock.now().toISOString(),
          attributionSignature: signPromoterAttribution(signed, this.deps.config.magicTicketSecret),
          promoterCommissionPaise,
        };
      }
    }

    return { pricing, attribution, upgrade };
  }

  /**
   * Online sales take money only for a published event. A draft, paused,
   * cancelled or finished event is not on sale, whatever its tiers say.
   */
  private async assertOnSale(eventId: EntityId): Promise<void> {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new EventNotFoundError(eventId);
    if (event.status !== 'published') {
      throw new InvalidOperationError('This event is not on sale');
    }
  }

  /**
   * The redemption limits of a promo (`maxRedemptions`, `maxPerUser`). Whether
   * the code is switched on and inside its dates is checked with the pricing.
   * Redemptions are recorded under the promo's id; older ones were recorded
   * under its code, so both are counted.
   */
  private async assertPromoWithinLimits(
    eventId: EntityId,
    promoCode: string,
    userId: EntityId | null,
  ): Promise<void> {
    const promo = await this.deps.repositories.catalog.getPromoByCode(promoCode, eventId);
    if (!promo) return;
    const redemptions = this.deps.repositories.promoRedemptions;
    if (promo.maxRedemptions !== null) {
      const counted =
        (await redemptions.countByPromo(promo.id)) + (await redemptions.countByPromo(promo.code));
      if (Math.max(counted, promo.redemptionCount) >= promo.maxRedemptions) {
        throw new InvalidOperationError(
          `Promo code ${promo.code} has reached its redemption limit`,
        );
      }
    }
    if (promo.maxPerUser !== null && userId) {
      const byUser =
        (await redemptions.countByPromoAndUser(promo.id, userId)) +
        (await redemptions.countByPromoAndUser(promo.code, userId));
      if (byUser >= promo.maxPerUser) {
        throw new InvalidOperationError(`You have already used promo code ${promo.code}`);
      }
    }
  }

  /**
   * Step 2: Create Hold — reserves inventory for ~10 minutes.
   * Idempotent via Idempotency-Key.
   */
  async createHold(input: {
    actor: ActorContext;
    eventId: EntityId;
    organizationId: EntityId;
    lines: {
      tierId: EntityId;
      pricingPhaseId?: string | null;
      tierName: string;
      quantity: number;
      unitPricePaise: number;
      admissionUnitPricePaise?: number;
      coverUnitPricePaise?: number;
      coverPolicy?: { proposalId: EntityId; policyVersion: string; termsDigest: string };
      ticketAddons?: PricingBreakdown['lines'][number]['ticketAddons'];
      accessGrantId?: EntityId;
      eligibilityAttested?: boolean;
    }[];
    pricing: PricingBreakdown;
    appliedPromoCode: string | null;
    attribution: CheckoutAttribution | null;
    userId?: EntityId | null;
    /** Who the tickets are for; becomes the order contact. */
    attendee?: OrderContact | null;
    upgrade?: TicketUpgradeSnapshot | null;
    idempotencyKey: string;
    reservationTtlMs?: number;
  }): Promise<CartReservation> {
    const {
      eventId,
      organizationId,
      lines,
      pricing,
      appliedPromoCode,
      attribution,
      userId,
      attendee,
      upgrade,
      idempotencyKey,
      reservationTtlMs,
    } = input;

    const now = new Date();
    const buyerId = userId ?? input.actor.userId;
    if (!buyerId || (!isSystemActor(input.actor) && buyerId !== input.actor.userId))
      throw new UnauthorizedError('A verified account is required to book tickets');
    const buyer = await this.deps.repositories.users?.getById(buyerId);
    if (!buyer?.emailVerified)
      throw new ForbiddenError('A verified account is required to book tickets');
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new EventNotFoundError(eventId);

    if (upgrade) {
      const source = await this.deps.repositories.entitlements.getById(upgrade.sourceEntitlementId);
      if (
        !buyerId ||
        lines.length !== 1 ||
        lines[0]?.quantity !== 1 ||
        lines[0]?.tierId !== upgrade.targetTierId ||
        upgrade.sourceOrderId !== source?.orderId ||
        upgrade.sourceTierId !== source?.tierId ||
        upgrade.sourceEntitlementVersion !== source?.version ||
        source?.eventId !== eventId ||
        currentEntitlementHolderId(source) !== buyerId ||
        source.status !== 'valid' ||
        source.scanCount !== 0 ||
        source.refundLock ||
        source.pendingTransferId
      ) {
        throw new InvalidOperationError('The source ticket changed after the upgrade quote');
      }
    }

    // An idempotency key identifies a request by ONE buyer. Looking it up on its
    // own would hand a buyer someone else's hold (and its holdId and pricing)
    // whenever two people sent the same key, so the buyer is part of the key.
    const scopedKey = buyerId
      ? createHash('sha256').update(`${buyerId}\n${idempotencyKey}`).digest('hex').slice(0, 40)
      : idempotencyKey;
    const existing = await this.deps.repositories.cartReservations.getByIdempotencyKey(scopedKey);
    if (existing) return existing;

    if (
      lines.some((line) => line.ticketAddons?.length) &&
      this.deps.config.features.m5TicketAddonsEnabled !== true
    ) {
      throw new ForbiddenError('Ticket add-on sales are not enabled');
    }

    // The server owns group semantics. Snapshot the tier's attendee count and
    // issuance mode into the hold so edits after quote cannot change fulfillment.
    const holdLines = await Promise.all(
      lines.map(async (line) => {
        const tier = await this.deps.repositories.catalog.getTierById(line.tierId);
        if (!tier || tier.eventId !== eventId) {
          throw new TicketTierNotFoundError(line.tierId);
        }
        if (tier.accessType === 'RSVP' && line.ticketAddons?.length) {
          throw new InvalidOperationError('Ticket add-ons cannot be purchased with a free RSVP');
        }
        assertEligibilityAttested(
          tier,
          line.eligibilityAttested,
          this.deps.config.features.m5EligibilityRulesEnabled,
        );
        const coverAmountPaise = tier.coverAmountPaise ?? 0;
        const ticketAddons = await Promise.all(
          (line.ticketAddons ?? []).map(async (selection) => {
            const addon = await this.deps.repositories.catalog.getTicketAddonById(
              selection.addonId,
            );
            const nowMs = now.getTime();
            if (
              !addon ||
              addon.eventId !== eventId ||
              addon.organizationId !== organizationId ||
              addon.status !== 'active' ||
              addon.name !== selection.name ||
              addon.kind !== selection.kind ||
              addon.priceInPaise !== selection.unitPricePaise ||
              selection.quantityPerEntitlement < 1 ||
              selection.quantityPerEntitlement > addon.maxPerEntitlement ||
              (addon.salesStartAt !== null && Date.parse(addon.salesStartAt) > nowMs) ||
              (addon.salesEndAt !== null && Date.parse(addon.salesEndAt) <= nowMs)
            ) {
              throw new InvalidOperationError('A selected ticket add-on changed after the quote');
            }
            return { ...selection };
          }),
        );
        const entitlementCountPerPurchaseUnit =
          (tier.admissionMode ?? 'bundle') === 'per_person' ? (tier.guestCount ?? 1) : 1;
        const addOnUnitPricePaise = ticketAddons.reduce(
          (sum, addon) => sum + addon.unitPricePaise * addon.quantityPerEntitlement,
          0,
        );
        if (
          (line.coverUnitPricePaise ?? 0) !== coverAmountPaise ||
          line.unitPricePaise !==
            (line.admissionUnitPricePaise ?? line.unitPricePaise) +
              (line.coverUnitPricePaise ?? 0) *
                ((tier.admissionMode ?? 'bundle') === 'per_person' ? (tier.guestCount ?? 1) : 1) +
              addOnUnitPricePaise * entitlementCountPerPurchaseUnit
        ) {
          throw new InvalidOperationError('Ticket price components changed after the quote');
        }
        let coverPolicy: EventCoverPolicyProposal | null = null;
        if (coverAmountPaise > 0 && line.coverPolicy) {
          coverPolicy = await this.requireAcceptedCoverPolicy(
            event,
            coverAmountPaise,
            line.coverPolicy,
          );
        } else if (coverAmountPaise > 0 || line.coverPolicy) {
          throw new InvalidOperationError('This ticket no longer has its accepted cover policy');
        }
        if (
          (tier.accessMode ?? 'public') !== 'public' &&
          (!line.accessGrantId ||
            !buyerId ||
            !(await new TicketAccessService(this.deps).hasGrantForTier(
              line.accessGrantId,
              buyerId,
              eventId,
              line.tierId,
            )))
        ) {
          throw new TicketTierNotFoundError(line.tierId);
        }
        if (
          (event.visibilityMode === 'code' || event.visibilityMode === 'invited') &&
          (!line.accessGrantId ||
            !buyerId ||
            !(await new TicketAccessService(this.deps).hasGrantForEvent(
              line.accessGrantId,
              buyerId,
              eventId,
              event.visibilityMode === 'invited' ? 'invitation' : 'code',
            )))
        ) {
          throw new TicketTierNotFoundError(line.tierId);
        }
        return {
          ...line,
          ...(line.admissionUnitPricePaise === undefined
            ? {}
            : { admissionUnitPricePaise: line.admissionUnitPricePaise }),
          ...(line.coverUnitPricePaise === undefined
            ? {}
            : { coverUnitPricePaise: line.coverUnitPricePaise }),
          ...(coverPolicy
            ? {
                coverPolicy: {
                  proposalId: coverPolicy.id,
                  policyVersion: coverPolicy.policyVersion,
                  termsDigest: coverPolicy.termsDigest,
                },
              }
            : {}),
          ...(ticketAddons.length > 0 ? { ticketAddons } : {}),
          guestCount: tier.guestCount ?? 1,
          admissionMode: tier.admissionMode ?? 'bundle',
          ...(requiresEligibilityAttestation(tier)
            ? {
                eligibility: {
                  audienceType: tier.audienceType ?? 'GENERAL',
                  minAge: tier.minAge ?? null,
                  maxAge: tier.maxAge ?? null,
                  attested: true as const,
                  attestedAt: now.toISOString(),
                },
              }
            : {}),
        };
      }),
    );

    // Check inventory availability
    for (const line of holdLines) {
      const available = await this.deps.inventory.getAvailableQuantity(eventId, line.tierId);
      const requestedUnits =
        line.quantity * (line.admissionMode === 'per_person' ? line.guestCount : 1);
      if (available < requestedUnits) {
        throw new InvalidOperationError(`Insufficient inventory for tier ${line.tierName}`);
      }
    }

    const requestedAddons = new Map<EntityId, number>();
    for (const line of holdLines) {
      const entitlementCount =
        line.quantity * (line.admissionMode === 'per_person' ? (line.guestCount ?? 1) : 1);
      for (const addon of line.ticketAddons ?? []) {
        requestedAddons.set(
          addon.addonId,
          (requestedAddons.get(addon.addonId) ?? 0) +
            entitlementCount * addon.quantityPerEntitlement,
        );
      }
    }
    for (const [addonId, requested] of requestedAddons) {
      if ((await this.deps.inventory.getAvailableTicketAddonQuantity(addonId)) < requested) {
        throw new InvalidOperationError('Insufficient inventory for a selected ticket add-on');
      }
    }

    // Per-user ticket caps (`tier.maxPerUser`): count what this user already
    // holds (live carts) and owns (paid orders) for each capped tier, so the
    // knob binds across orders, not just within one basket. Guests without
    // any identity (`buyerId` null) fall through — there is no stable key to
    // count against, and v1 never enforced a per-user tier cap either.
    if (buyerId) {
      for (const line of holdLines) {
        const tier = await this.deps.repositories.catalog.getTierById(line.tierId);
        if (!tier?.maxPerUser) continue;
        const alreadyHeld = await this.deps.repositories.cartReservations.countActiveQuantity(
          buyerId,
          eventId,
          line.tierId,
          now,
        );
        const alreadyBought = await this.deps.repositories.orders.countPaidQuantityByUserAndEvent(
          buyerId,
          eventId,
          line.tierId,
        );
        const requestedUnits =
          line.quantity * (line.admissionMode === 'per_person' ? line.guestCount : 1);
        if (alreadyHeld + alreadyBought + requestedUnits > tier.maxPerUser) {
          throw new InvalidOperationError(
            `${tier.name} has a maximum of ${tier.maxPerUser} per user`,
          );
        }
      }
    }

    const holdId = `HOLD-${scopedKey}`;
    const ttl = reservationTtlMs ?? DEFAULT_HOLD_TTL_MS;

    const hold: CartReservation = {
      id: holdId,
      eventId,
      organizationId,
      userId: buyerId,
      lines: holdLines.map((line) => ({ ...line })),
      pricing,
      saleAllocation: await this.snapshotSaleAllocation(
        eventId,
        organizationId,
        pricing.discountedAdmissionSubtotalPaise ?? pricing.discountedSubtotalPaise,
        attribution,
      ),
      appliedPromoCode,
      attribution: attribution ?? null,
      status: 'active',
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      convertedOrderId: null,
      attendee: attendee ?? null,
      ...(upgrade ? { upgrade: { ...upgrade } } : {}),
      idempotencyKey: scopedKey,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const stored = await this.deps.repositories.cartReservations.create(hold);

    // The availability check above and this write are separate steps, so two
    // buyers can both have passed it for the last seat. The stored hold carries
    // its position in the event's strict order of holds; judging capacity against
    // the holds ordered at or before it means exactly one of them keeps the seat.
    // The loser gives its hold back at once rather than leaving it to expire.
    const overbooked = await this.deps.inventory.firstOverbookedTier(stored);
    if (overbooked !== null) {
      await this.deps.repositories.cartReservations.release(stored.id);
      const tierName = stored.lines.find((line) => line.tierId === overbooked)?.tierName ?? 'tier';
      throw new InvalidOperationError(`Insufficient inventory for tier ${tierName}`);
    }
    const overbookedAddon = await this.deps.inventory.firstOverbookedTicketAddon(stored);
    if (overbookedAddon !== null) {
      await this.deps.repositories.cartReservations.release(stored.id);
      const addon = await this.deps.repositories.catalog.getTicketAddonById(overbookedAddon);
      throw new InvalidOperationError(
        `Insufficient inventory for ${addon?.name ?? 'a selected ticket add-on'}`,
      );
    }

    // The per-user cap has the same check-then-write shape: one buyer firing
    // several requests at once passes the early check on every one of them. Judge
    // it the same way, against this buyer's other holds ordered at or before this.
    const overCap = await this.firstTierOverUserCap(stored);
    if (overCap !== null) {
      await this.deps.repositories.cartReservations.release(stored.id);
      throw new InvalidOperationError(`${overCap.name} has a maximum of ${overCap.max} per user`);
    }
    if (await this.isOverActivePaidUnitCap(stored)) {
      await this.deps.repositories.cartReservations.release(stored.id);
      throw new InvalidOperationError(
        `A maximum of ${MAX_ACTIVE_PAID_UNITS_PER_EVENT_PER_PURCHASER} paid admission units is allowed per event`,
      );
    }
    return stored;
  }

  /**
   * RSVP — direct free-ticket fulfillment with no payment provider involved.
   * One call: eligibility (free event + zero-price tier) → 1-per-event check
   * → inventory check → paid zero-total order + entitlements.
   *
   * Rules:
   * - Auth required: the 1-per-account guarantee needs a real user id.
   * - Quantity is fixed at 1 (no quantity input) — one RSVP per user per event.
   * - Settlement is deliberately skipped: a ₹0 order contributes nothing to
   *   the partner ledger or the promoter leaderboard.
   * - A concurrent double-tap converges on the winner (same pattern as
   *   `confirmPayment`'s webhook/redirect race); a sequential second RSVP is
   *   a 409 `ConflictError`.
   */
  async createRsvp(input: {
    actor: ActorContext;
    eventId: EntityId;
    tierId: EntityId;
    accessGrantId?: EntityId;
    eligibilityAttested?: boolean;
    referralCode?: string | null;
  }): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const { actor, eventId, tierId, referralCode, accessGrantId, eligibilityAttested } = input;

    if (!actor.userId || isSystemActor(actor)) {
      throw new UnauthorizedError('Authentication is required to book tickets');
    }

    // M5 RSVP uniqueness is enforced per account backed by the platform's
    // existing verified identity signal. Missing directory records fail
    // closed; account IDs do not prove one-human-per-account identity.
    const account = await this.deps.repositories.users.getById(actor.userId);
    if (!account?.emailVerified) {
      throw new ForbiddenError('A verified account is required to RSVP');
    }

    const event =
      (await this.deps.repositories.events.getById(eventId)) ??
      (await this.deps.repositories.events.getBySlug(eventId));
    if (!event) throw new EventNotFoundError(eventId);
    if (event.status !== 'published') {
      throw new InvalidOperationError(`Event is ${event.status}, RSVP is unavailable`);
    }
    if (
      (event.visibilityMode === 'code' || event.visibilityMode === 'invited') &&
      !(await new TicketAccessService(this.deps).hasGrantForEvent(
        accessGrantId ?? '',
        actor.userId,
        event.id,
        event.visibilityMode === 'invited' ? 'invitation' : 'code',
      ))
    ) {
      throw new TicketTierNotFoundError(tierId);
    }
    // A mixed catalog may offer free RSVP alongside paid entry. The selected
    // tier's authoritative effective price below determines RSVP eligibility;
    // the event-level discovery classification does not price this booking.

    const tier = await this.deps.repositories.catalog.getTierById(tierId);
    if (!tier || tier.eventId !== event.id || (tier.accessMode ?? 'public') !== 'public') {
      throw new TicketTierNotFoundError(tierId);
    }
    assertEligibilityAttested(
      tier,
      eligibilityAttested,
      this.deps.config.features.m5EligibilityRulesEnabled,
    );
    if (tier.audienceType === 'STUDENT' || tier.audienceType === 'MEMBER')
      throw new InvalidOperationError('This ticket category is unavailable');
    if (tier.status !== 'active') {
      throw new InvalidOperationError(`Tier ${tier.name} is ${tier.status}`);
    }
    // Legacy tolerance: tiers written before `priceInPaise` existed price via
    // `doorPriceInPaise` (or nothing) — see `effectiveTierPricePaise`.
    const unitPricePaise = effectiveTierPricePaise(tier);
    if (unitPricePaise !== 0) {
      throw new InvalidOperationError('RSVP is available only for zero-price tiers');
    }
    if ((tier.guestCount ?? 1) > 1 || tier.admissionMode === 'per_person') {
      throw new InvalidOperationError(
        'Group RSVPs require an individually verified attendee claim for every admission',
      );
    }

    // Deterministic id from the RESOLVED event id (callers may pass id or
    // slug — both must converge on one RSVP): one RSVP per user per event.
    // Same rationale as entitlement ids — a retried RSVP collides with itself
    // at the storage layer instead of minting a second ticket.
    const orderId = rsvpOrderId(event.id, actor.userId);

    // The authenticated Guest profile is the authoritative attendee identity.
    // Keep contact email/phone blank for RSVP; they are not needed to issue the
    // pass, and the profile name is sufficient for the partner attendee roster.
    const guestProfile = await this.deps.repositories.guestProfiles.getByUserId(actor.userId);

    let attribution: CheckoutAttribution | null = null;
    if (referralCode) {
      const signed = await new ReferralLinkService(this.deps).resolveAttribution(
        event.id,
        referralCode,
        actor.userId,
      );
      if (signed) {
        attribution = {
          referralLinkId: signed.referralLinkId,
          promoterId: signed.promoterId,
          code: signed.code,
          assignmentId: signed.assignmentId,
          assignmentVersion: signed.assignmentVersion,
          termsSnapshot: signed.terms,
          eligibleTierIds: signed.eligibleTierIds ?? null,
          commissionPolicyVersion:
            signed.commissionPolicyVersion ?? PROMOTER_COMMISSION_POLICY_VERSION,
          commercialPolicyVersion:
            signed.commercialPolicyVersion ?? COMMERCIAL_ALLOCATION_POLICY_VERSION,
          attributedAt: this.deps.config.clock.now().toISOString(),
          attributionSignature: signPromoterAttribution(signed, this.deps.config.magicTicketSecret),
          // Free RSVPs count as conversions, but have no monetary commission.
          promoterCommissionPaise: 0,
        };
      }
    }

    const now = this.deps.config.clock.now();
    let order: Order = {
      id: orderId,
      eventId: event.id,
      organizationId: event.organizationId,
      userId: actor.userId,
      contact: { name: guestProfile?.displayName ?? 'RSVP Guest', email: '', phone: '' },
      status: 'paid',
      lines: [
        {
          tierId: tier.id,
          tierName: tier.name,
          quantity: 1,
          unitPricePaise: 0,
          subtotalPaise: 0,
          ...(requiresEligibilityAttestation(tier)
            ? {
                eligibility: {
                  audienceType: tier.audienceType ?? 'GENERAL',
                  minAge: tier.minAge ?? null,
                  maxAge: tier.maxAge ?? null,
                  attested: true as const,
                  attestedAt: now.toISOString(),
                },
              }
            : {}),
        },
      ],
      currency: tier.currency,
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
      attribution,
      paymentIntentId: null,
      paymentId: orderId,
      paidAt: now.toISOString(),
      reservationExpiresAt: now.toISOString(),
      failureReason: null,
      refundedPaise: 0,
      appliedRefundRequestIds: [],
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const acquired = await this.deps.repositories.orders.acquireRsvp({
      order,
      entitlements: issueEntitlements({
        order,
        now,
        admitsPerUnit: { [tier.id]: admitsForTier(tier) },
      }),
      expectedEventVersion: event.version,
      expectedTierVersion: tier.version,
      now,
    });
    order = acquired.order;
    const entitlements = acquired.entitlements;
    await this.recordAttributionSale(order);
    await this.financialPostingService.postZeroValueEvidence({
      organizationId: order.organizationId,
      orderId: order.id,
      eventId: order.eventId,
      currency: order.currency,
      sourceType: 'free_ticket',
      postedAt: now,
    });
    await this.ensureOrderFulfilledEvent(order);
    return { order, entitlements };
  }

  async cancelRsvp(orderId: EntityId, actor: ActorContext): Promise<Order> {
    if (!actor.userId) throw new UnauthorizedError('Sign in to cancel your RSVP');
    const order = await this.deps.repositories.orders.cancelRsvp(
      orderId,
      actor.userId,
      this.deps.config.clock.now(),
    );
    await this.deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId('rsvp.cancelled', order.id),
        type: 'rsvp.cancelled',
        aggregateId: order.id,
        organizationId: order.organizationId,
        actorId: actor.userId,
        payload: { orderId: order.id, eventId: order.eventId },
        occurredAt: Date.parse(order.updatedAt),
      }),
    );
    return order;
  }

  private async recordAttributionSale(order: Order): Promise<void> {
    if (!order.attribution) return;
    await this.deps.repositories.referralLinks.recordSale(
      order.attribution.referralLinkId,
      order.id,
      order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise,
      order.attribution.promoterCommissionPaise,
    );
  }

  /**
   * The first capped tier on which a just-stored hold takes its buyer over
   * `tier.maxPerUser`, counting what they have bought plus their live holds
   * ordered at or before this one (so of several simultaneous requests exactly
   * the allowed number survive).
   */
  private async firstTierOverUserCap(
    hold: CartReservation,
  ): Promise<{ name: string; max: number } | null> {
    if (!hold.userId) return null;
    const repos = this.deps.repositories;
    const myPosition = hold.sequence ?? Number.MAX_SAFE_INTEGER;
    const mine = (await repos.cartReservations.listActiveByEvent(hold.eventId, new Date())).filter(
      (other) =>
        other.userId === hold.userId &&
        (other.id === hold.id || (other.sequence ?? 0) <= myPosition),
    );
    for (const line of hold.lines) {
      const tier = await repos.catalog.getTierById(line.tierId);
      if (!tier?.maxPerUser) continue;
      const bought = await repos.orders.countPaidQuantityByUserAndEvent(
        hold.userId,
        hold.eventId,
        line.tierId,
      );
      const held = mine.reduce(
        (sum, other) =>
          sum +
          other.lines
            .filter((l) => l.tierId === line.tierId)
            .reduce(
              (n, l) =>
                n + l.quantity * (l.admissionMode === 'per_person' ? (l.guestCount ?? 1) : 1),
              0,
            ),
        0,
      );
      if (bought + held > tier.maxPerUser) return { name: tier.name, max: tier.maxPerUser };
    }
    return null;
  }

  /**
   * Enforces the event-wide paid-unit cap after the hold receives its ordered
   * repository position. Existing purchaser entitlements and active holds at
   * or before this hold converge concurrent tabs on the first ten units.
   */
  private async isOverActivePaidUnitCap(hold: CartReservation): Promise<boolean> {
    if (!hold.userId) return false;
    const repos = this.deps.repositories;
    const purchased = await repos.entitlements.countActivePaidUnitsByUserAndEvent(
      hold.userId,
      hold.eventId,
    );
    const myPosition = hold.sequence ?? Number.MAX_SAFE_INTEGER;
    const mine = (await repos.cartReservations.listActiveByEvent(hold.eventId, new Date())).filter(
      (other) =>
        other.userId === hold.userId &&
        (other.id === hold.id || (other.sequence ?? 0) <= myPosition),
    );
    let heldUnits = 0;
    for (const other of mine) {
      for (const line of other.lines) {
        const tier = await repos.catalog.getTierById(line.tierId);
        heldUnits += line.quantity * (line.guestCount ?? tier?.guestCount ?? 1);
      }
    }
    // The source ticket remains valid while the replacement is being paid for,
    // but the two admissions must not consume two purchaser-cap units.
    const upgradeCredit = hold.upgrade ? 1 : 0;
    return purchased - upgradeCredit + heldUnits > MAX_ACTIVE_PAID_UNITS_PER_EVENT_PER_PURCHASER;
  }

  /**
   * Whether `actor` may act on `hold`. The webhook runs as the system actor
   * (it authenticates by HMAC, not by session); everyone else must be the
   * hold's owner. A hold with no recorded owner is never claimable by a user.
   */
  private actsForHold(actor: ActorContext, hold: CartReservation): boolean {
    if (isSystemActor(actor)) return true;
    return hold.userId !== null && hold.userId === actor.userId;
  }

  /**
   * Step 3: Create Payment Intent — calls PaymentProvider to create order with Razorpay.
   *
   * One hold is bound to exactly one provider order. A second attempt (a
   * retry with a fresh Idempotency-Key, a double click, a second tab) gets the
   * same order back instead of minting another, because fulfilment only
   * accepts a payment made against the order bound here — an orphaned second
   * order that later captured would be money with nothing to fulfil.
   */
  async createPaymentIntent(input: {
    actor: ActorContext;
    holdId: EntityId;
    idempotencyKey: string;
  }): Promise<{ paymentIntentId: string; amountPaise: number }> {
    const { holdId } = input;

    let hold = await this.deps.repositories.cartReservations.getById(holdId);
    // Same answer for "missing" and "not yours", so a caller cannot probe which
    // hold ids exist.
    if (!hold || !this.actsForHold(input.actor, hold)) {
      throw new InvalidOperationError('Hold not found');
    }
    // Recover provider identity even after expiration or event closure. This
    // never reopens payment: all current payability checks still run below.
    if (hold.providerOrderCreation && !hold.providerOrderId) {
      const snapshot = hold.providerOrderCreation;
      try {
        const candidate = await this.lookupClaimedProviderOrder(snapshot);
        const bound = await this.deps.repositories.cartReservations.bindProviderOrder(
          hold.id,
          candidate.id,
        );
        if (bound !== candidate.id)
          throw new InvalidOperationError('Provider order binding conflict');
        hold = { ...hold, providerOrderId: bound };
      } catch {
        await this.deps.repositories.cartReservations.markProviderOrderRequiresSupport(
          hold.id,
          snapshot.receipt,
        );
        throw new InvalidOperationError(
          'Payment creation requires_support; provider identity is unresolved',
        );
      }
    }
    if (hold.status !== 'active')
      throw new InvalidOperationError(`Hold is ${hold.status}, cannot proceed to payment`);
    if (new Date().getTime() > Date.parse(hold.expiresAt)) {
      await this.deps.repositories.cartReservations.release(holdId);
      throw new InvalidOperationError('Hold has expired');
    }

    // A hold made while the event was on sale does not oblige us to take money
    // after the host has cancelled or paused it. (A payment already in flight is
    // a different case: confirmPayment still honours or refunds it.)
    await this.assertOnSale(hold.eventId);

    const event = await this.deps.repositories.events.getById(hold.eventId);
    if (!event) throw new EventNotFoundError(hold.eventId);
    if (hold.upgrade) {
      const source = await this.deps.repositories.entitlements.getById(
        hold.upgrade.sourceEntitlementId,
      );
      if (
        !source ||
        source.version !== hold.upgrade.sourceEntitlementVersion ||
        source.orderId !== hold.upgrade.sourceOrderId ||
        source.tierId !== hold.upgrade.sourceTierId ||
        source.eventId !== hold.eventId ||
        currentEntitlementHolderId(source) !== hold.userId ||
        source.status !== 'valid' ||
        source.scanCount !== 0 ||
        source.refundLock ||
        source.pendingTransferId
      ) {
        throw new InvalidOperationError('The source ticket changed before upgrade payment began');
      }
    }
    for (const line of hold.lines) {
      const tier = await this.deps.repositories.catalog.getTierById(line.tierId);
      if (!tier || tier.eventId !== event.id) throw new TicketTierNotFoundError(line.tierId);
      if (
        (tier.accessMode ?? 'public') !== 'public' &&
        (!line.accessGrantId ||
          !hold.userId ||
          !(await new TicketAccessService(this.deps).hasGrantForTier(
            line.accessGrantId,
            hold.userId,
            event.id,
            tier.id,
          )))
      ) {
        throw new TicketTierNotFoundError(line.tierId);
      }
      if (
        (event.visibilityMode === 'code' || event.visibilityMode === 'invited') &&
        (!line.accessGrantId ||
          !hold.userId ||
          !(await new TicketAccessService(this.deps).hasGrantForEvent(
            line.accessGrantId,
            hold.userId,
            event.id,
            event.visibilityMode === 'invited' ? 'invitation' : 'code',
          )))
      ) {
        throw new TicketTierNotFoundError(line.tierId);
      }
    }

    if (hold.providerOrderId) {
      return this.payableBoundIntent(hold.id, hold.providerOrderId);
    }

    // The durable claim precedes all network I/O. A lost response/restart may
    // only reconcile this receipt, never blindly create a second provider order.
    const receipt = `c1_${createHash('sha256').update(hold.id).digest('hex').slice(0, 36)}`;
    const claim = await this.deps.repositories.cartReservations.claimProviderOrderCreation(
      holdId,
      receipt,
      new Date(),
    );
    if (!claim) throw new InvalidOperationError('Hold not found');
    if (claim.hold.providerOrderId)
      return this.payableBoundIntent(holdId, claim.hold.providerOrderId);
    const snapshot = claim.hold.providerOrderCreation;
    if (!snapshot) throw new InvalidOperationError('Payment creation requires_support');
    const paymentProvider = this.deps.paymentProvider;
    const metadata = {
      holdId: snapshot.holdId,
      eventId: snapshot.eventId,
      organizationId: snapshot.organizationId,
    };
    try {
      let paymentIntent;
      if (claim.claimed) {
        paymentIntent = await paymentProvider.createOrder({
          amountPaise: snapshot.amountPaise,
          currency: snapshot.currency,
          idempotencyKey: snapshot.receipt,
          metadata,
        });
      } else {
        paymentIntent = await this.lookupClaimedProviderOrder(snapshot);
      }
      if (
        !paymentIntent.id ||
        paymentIntent.amountPaise !== snapshot.amountPaise ||
        paymentIntent.currency !== snapshot.currency
      ) {
        throw new InvalidOperationError('Provider order amount or currency mismatch');
      }
      const bound = await this.deps.repositories.cartReservations.bindProviderOrder(
        holdId,
        paymentIntent.id,
      );
      if (!bound || bound !== paymentIntent.id)
        throw new InvalidOperationError('Provider order binding conflict');
      return await this.payableBoundIntent(holdId, bound);
    } catch {
      await this.deps.repositories.cartReservations.markProviderOrderRequiresSupport(
        holdId,
        snapshot.receipt,
      );
      throw new InvalidOperationError(
        'Payment creation requires_support; retry recovery without creating another order',
      );
    }
  }

  private async lookupClaimedProviderOrder(
    snapshot: NonNullable<CartReservation['providerOrderCreation']>,
  ) {
    const provider = this.deps.paymentProvider;
    if (!provider.findOrdersByReceipt)
      throw new InvalidOperationError('Provider order lookup unavailable');
    const matches = await provider.findOrdersByReceipt(snapshot.receipt);
    const candidate = matches[0];
    if (
      matches.length !== 1 ||
      !candidate ||
      candidate.receipt !== snapshot.receipt ||
      candidate.amountPaise !== snapshot.amountPaise ||
      candidate.currency !== snapshot.currency ||
      candidate.metadata.holdId !== snapshot.holdId ||
      candidate.metadata.eventId !== snapshot.eventId ||
      candidate.metadata.organizationId !== snapshot.organizationId
    )
      throw new InvalidOperationError(
        'Provider order identity is missing, ambiguous or mismatched',
      );
    return candidate;
  }

  /** Re-check after provider I/O: binding identity is durable, payability is current. */
  private async payableBoundIntent(holdId: string, providerOrderId: string) {
    const current = await this.deps.repositories.cartReservations.getById(holdId);
    if (
      !current ||
      current.providerOrderId !== providerOrderId ||
      current.status !== 'active' ||
      !(Date.parse(current.expiresAt) > Date.now())
    )
      throw new InvalidOperationError(
        'The payment hold expired or changed before checkout could open',
      );
    await this.assertOnSale(current.eventId);
    return {
      paymentIntentId: providerOrderId,
      amountPaise: current.providerOrderCreation?.amountPaise ?? current.pricing.grandTotalPaise,
    };
  }

  /**
   * The client-redirect confirmation: checks Razorpay's checkout-callback
   * signature, then confirms the payment.
   *
   * The signature is verified against the provider order ID **stored on the
   * hold when the attempt was created** — never against an order ID supplied by
   * the browser. Razorpay's own guidance is explicit that the order ID must come
   * from your server: the three callback values arrive in a browser you do not
   * control, so a client-chosen order ID would let a caller pick the very value
   * the signature is checked against. A `clientOrderId` the browser sends anyway
   * is only compared with the stored one, and a difference is rejected.
   */
  async verifyCheckoutCallback(input: {
    actor: ActorContext;
    holdId: EntityId;
    paymentId: string;
    signature: string;
    clientOrderId?: string | undefined;
    idempotencyKey?: string | undefined;
  }): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const { actor, holdId, paymentId, signature, clientOrderId } = input;

    const hold = await this.deps.repositories.cartReservations.getById(holdId);
    if (!hold || !this.actsForHold(actor, hold)) throw new InvalidOperationError('Hold not found');
    const serverOrderId = hold.providerOrderId;
    if (!serverOrderId) {
      throw new InvalidOperationError('No payment attempt has been started for this hold');
    }
    if (clientOrderId !== undefined && clientOrderId !== serverOrderId) {
      throw new InvalidOperationError('Payment does not belong to this hold');
    }

    const verification = await this.deps.paymentProvider.verifyPayment({
      paymentId,
      orderId: serverOrderId,
      signature,
    });
    if (!verification.captured) {
      throw new InvalidOperationError(`Payment ${paymentId} has not been captured`);
    }

    return this.confirmPayment({
      actor,
      paymentId,
      paymentIntentId: serverOrderId,
      holdId,
      _idempotencyKey: input.idempotencyKey ?? paymentId,
      _verifiedPayment: verification,
    });
  }

  /**
   * Step 4: Confirm Payment — dual-path idempotent, resumable fulfillment.
   * Called by both webhook and redirect; the second call converges on the same
   * order, and finishes any fulfilment step the first call did not reach.
   */
  async confirmPayment(input: {
    actor: ActorContext;
    paymentId: string;
    paymentIntentId: string;
    holdId: EntityId;
    _idempotencyKey: string;
    _verifiedPayment?: PaymentVerificationResponse;
  }): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const { actor, paymentId, paymentIntentId, holdId, _verifiedPayment } = input;

    let hold = await this.deps.repositories.cartReservations.getById(holdId);
    if (!hold || !this.actsForHold(actor, hold)) throw new InvalidOperationError('Hold not found');

    // Check for existing order with this payment id (idempotency) — both the
    // webhook and the client-redirect path call this method for the same
    // payment, and whichever arrives second must not duplicate anything.
    //
    // It must also not just return: fulfilment is several writes with no
    // enclosing transaction, so a crash between them leaves an order that is
    // missing its hold conversion, promo record, tickets or ledger entry. A
    // redelivered webhook is the natural repair, so run the remaining steps.
    const existingOrder = await this.deps.repositories.orders.getByPaymentId(paymentId);
    if (existingOrder) {
      const belongsToHold =
        existingOrder.paymentId === paymentId &&
        existingOrder.paymentIntentId !== null &&
        existingOrder.paymentIntentId === hold.providerOrderId &&
        paymentIntentId === hold.providerOrderId &&
        existingOrder.organizationId === hold.organizationId &&
        existingOrder.userId === hold.userId &&
        existingOrder.eventId === hold.eventId &&
        (hold.convertedOrderId === null || hold.convertedOrderId === existingOrder.id);
      if (!belongsToHold) throw new InvalidOperationError('Payment belongs to a different hold');
      if (_verifiedPayment) {
        this.assertProviderCaptureMatchesHold(_verifiedPayment, hold, paymentIntentId, paymentId);
        await this.recordProviderCapture(_verifiedPayment, hold, null);
      }
      const result = await this.completeFulfilment(existingOrder, hold);
      if (_verifiedPayment)
        await this.recordProviderCapture(
          _verifiedPayment,
          hold,
          result.order.fulfillmentState === 'pending' ? null : result.order.id,
        );
      return result;
    }

    // The hold already lost this exact race — some other caller converted it
    // (or is converting it) to an order. Rather than throwing, converge on
    // whatever that caller produces/produced. This is the idempotent claim:
    // the hold's `active -> converted` transition is the single point of
    // contention, and losing it is not an error for a dual confirmation path.
    if (hold.status === 'converted' && hold.convertedOrderId) {
      const convertedOrder = await this.deps.repositories.orders.getById(hold.convertedOrderId);
      if (convertedOrder) {
        if (
          convertedOrder.paymentId !== paymentId ||
          convertedOrder.paymentIntentId !== paymentIntentId ||
          convertedOrder.paymentIntentId !== hold.providerOrderId ||
          convertedOrder.userId !== hold.userId ||
          convertedOrder.eventId !== hold.eventId ||
          convertedOrder.organizationId !== hold.organizationId
        ) {
          if (_verifiedPayment) {
            this.assertProviderCaptureMatchesHold(
              _verifiedPayment,
              hold,
              paymentIntentId,
              paymentId,
            );
            await this.recordContradictoryCapture(_verifiedPayment, hold);
          }
          throw new InvalidOperationError('Converted hold belongs to a different payment');
        }
        if (_verifiedPayment) {
          this.assertProviderCaptureMatchesHold(_verifiedPayment, hold, paymentIntentId, paymentId);
          await this.recordProviderCapture(_verifiedPayment, hold, null);
        }
        const result = await this.completeFulfilment(convertedOrder, hold);
        if (_verifiedPayment)
          await this.recordProviderCapture(
            _verifiedPayment,
            hold,
            result.order.fulfillmentState === 'pending' ? null : result.order.id,
          );
        return result;
      }
    }
    // A hold can be past its TTL (or already released by the sweep) by the time
    // a payment lands — the guest was inside the provider's checkout when it
    // lapsed. That is not a reason to refuse the money: whether the payment was
    // real is decided below, and then whether the seats are still free.
    const lateCapture =
      hold.status === 'released' ||
      (hold.status === 'active' && new Date().getTime() > Date.parse(hold.expiresAt));
    if (hold.status !== 'active' && !lateCapture)
      throw new InvalidOperationError(`Hold is ${hold.status}, cannot confirm`);

    // The payment must have been made against the provider order bound to THIS
    // hold. Without this, one genuine payment (signature, capture and amount
    // all valid) could be presented against any other hold with the same
    // total — the checks below prove the payment is real, not that it is for
    // this purchase. The client-supplied `paymentIntentId` is only trusted
    // after it matches the server-side binding, and the provider's own record
    // of the payment must agree.
    if (!hold.providerOrderId) {
      throw new InvalidOperationError('No payment attempt has been started for this hold');
    }
    if (paymentIntentId !== hold.providerOrderId) {
      throw new InvalidOperationError('Payment does not belong to this hold');
    }

    // Verify with the payment provider before fulfilling — never trust a
    // caller-supplied paymentId/paymentIntentId. This was previously entirely
    // unchecked: any actor could call this method (via the redirect-confirm
    // route) with an arbitrary paymentId and be issued a paid order and
    // entitlements without ever paying. HMAC verification at the webhook
    // route and signature verification at the redirect route authenticate
    // *who* is calling; this authenticates *what actually happened* with the
    // money, which is a separate and equally required check (D-022).
    const verified = _verifiedPayment ?? (await this.deps.paymentProvider.getPayment(paymentId));
    if (!verified) {
      throw new InvalidOperationError(`Payment ${paymentId} was not found with the provider`);
    }
    if (verified.paymentId !== paymentId)
      throw new InvalidOperationError(
        'Provider payment identity does not match the requested payment',
      );
    if (!verified.captured) {
      throw new InvalidOperationError(`Payment ${paymentId} has not been captured`);
    }
    // Fail closed: a payment that does not name its order cannot be tied to
    // this hold, so it cannot fulfil it.
    if (verified.orderId !== hold.providerOrderId) {
      throw new InvalidOperationError('Payment was not made against this hold');
    }
    if (verified.amountPaise !== hold.pricing.grandTotalPaise) {
      throw new InvalidOperationError(
        `Payment amount ${verified.amountPaise} does not match hold total ${hold.pricing.grandTotalPaise}`,
      );
    }
    if (verified.currency !== undefined && verified.currency !== hold.pricing.currency) {
      throw new InvalidOperationError(
        `Payment currency ${verified.currency} does not match hold currency ${hold.pricing.currency}`,
      );
    }

    await this.recordProviderCapture(verified, hold, null);

    // Captured after the hold lapsed: honour the payment if the seats are still
    // free (the order is built from the frozen hold, so the guest gets exactly
    // what they were quoted), otherwise give the money back rather than keep it
    // for nothing. Captured money always ends in an order or a refund.
    let compensationReason: NonNullable<Order['compensationRequired']>['reason'] | null = null;
    const capturedEvent = await this.deps.repositories.events.getById(hold.eventId);
    if (!capturedEvent || capturedEvent.status === 'cancelled')
      compensationReason = 'event_unavailable';
    if (lateCapture && !compensationReason) {
      const revival = await this.reviveHoldForLatePayment(hold);
      hold = revival.hold;
      if (!revival.available) compensationReason = 'capacity_unavailable';
    }

    // Create order
    const orderId = `ORD-${paymentId}`;
    const now = new Date();
    let order: Order = {
      id: orderId,
      eventId: hold.eventId,
      organizationId: hold.organizationId,
      userId: hold.userId,
      // The attendee captured at hold time. Holds made before attendee capture
      // existed (or by a client that does not send one) keep the old placeholder.
      contact: hold.attendee ?? { name: 'Guest', email: 'guest@example.com', phone: '' },
      status: 'paid',
      lines: hold.lines.map((l) => ({
        ...hold.pricing.lines.find((priced) => priced.tierId === l.tierId),
        tierId: l.tierId,
        tierName: l.tierName,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        subtotalPaise: l.unitPricePaise * l.quantity,
        ...(l.pricingPhaseId === undefined ? {} : { pricingPhaseId: l.pricingPhaseId }),
        ...(l.admissionUnitPricePaise === undefined
          ? {}
          : { admissionUnitPricePaise: l.admissionUnitPricePaise }),
        ...(l.coverUnitPricePaise === undefined
          ? {}
          : { coverUnitPricePaise: l.coverUnitPricePaise }),
        ...(l.coverPolicy === undefined ? {} : { coverPolicy: l.coverPolicy }),
        ...(l.ticketAddons === undefined ? {} : { ticketAddons: l.ticketAddons }),
        ...(l.guestCount === undefined ? {} : { guestCount: l.guestCount }),
        ...(l.admissionMode === undefined ? {} : { admissionMode: l.admissionMode }),
        ...(l.eligibility === undefined ? {} : { eligibility: l.eligibility }),
      })),
      currency: hold.pricing.currency,
      ...(hold.pricing.feePolicy
        ? { feePolicy: snapshotBookingFeePolicy(hold.pricing.feePolicy) }
        : {}),
      accountingPolicy: { ...M4_ACCOUNTING_POLICY, capturedAt: hold.createdAt },
      bookedAt: hold.createdAt,
      ...(hold.saleAllocation ? { saleAllocation: hold.saleAllocation } : {}),
      fulfillmentState: 'pending',
      subtotalPaise: hold.pricing.subtotalPaise,
      discountPaise: hold.pricing.discountPaise,
      discountFundingOwner: hold.pricing.discountFundingOwner ?? null,
      discountedSubtotalPaise: hold.pricing.discountedSubtotalPaise,
      platformFeePaise: hold.pricing.platformFeePaise,
      paymentFeePaise: hold.pricing.paymentFeePaise,
      gstPaise: hold.pricing.gstPaise,
      grandTotalPaise: hold.pricing.grandTotalPaise,
      admissionSubtotalPaise: hold.pricing.admissionSubtotalPaise ?? hold.pricing.subtotalPaise,
      coverSubtotalPaise: hold.pricing.coverSubtotalPaise ?? 0,
      addOnSubtotalPaise: hold.pricing.addOnSubtotalPaise ?? 0,
      discountedAdmissionSubtotalPaise:
        hold.pricing.discountedAdmissionSubtotalPaise ?? hold.pricing.discountedSubtotalPaise,
      appliedPromoCode: hold.appliedPromoCode,
      attribution: hold.attribution,
      paymentIntentId,
      paymentId,
      paidAt: now.toISOString(),
      reservationExpiresAt: hold.expiresAt,
      failureReason: null,
      refundedPaise: 0,
      appliedRefundRequestIds: [],
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (order.feePolicy) order = { ...order, refundSnapshot: snapshotOriginalPurchase(order) };

    // A promo discount becomes financially effective at capture, not quote.
    // Claim it under a datastore transaction before the paid order is exposed;
    // quote-time counts are only an early UX check and cannot protect against
    // two buyers paying concurrently for the last redemption.
    const promoClaim = compensationReason
      ? 'already_claimed'
      : await this.claimPromoRedemption(order, hold, true);
    if (promoClaim === 'global_limit' || promoClaim === 'user_limit')
      compensationReason = 'promotion_unavailable';
    if (compensationReason) {
      await this.deps.repositories.cartReservations.release(hold.id);
      order = {
        ...order,
        compensationRequired: { reason: compensationReason, requestedAt: now.toISOString() },
      };
    }

    try {
      await this.deps.repositories.orders.save(order);
    } catch (error) {
      // Lost a concurrent race to claim this payment (webhook + redirect
      // both reached here before either had written) — the optimistic-lock
      // write of the loser fails with a version conflict. That is not a
      // caller-facing error: converge on whichever write actually landed.
      if (error instanceof VersionConflictError) {
        const winner = await this.deps.repositories.orders.getByPaymentId(paymentId);
        if (!winner) throw error;
        order = winner;
      } else {
        throw error;
      }
    }

    const result = await this.completeFulfilment(order, hold);
    await this.recordProviderCapture(
      verified,
      hold,
      result.order.fulfillmentState === 'pending' ? null : result.order.id,
    );
    return result;
  }

  private assertProviderCaptureMatchesHold(
    verified: PaymentVerificationResponse,
    hold: CartReservation,
    providerOrderId: string,
    paymentId: string,
  ): void {
    if (verified.paymentId !== paymentId)
      throw new InvalidOperationError(
        'Provider payment identity does not match the requested payment',
      );
    if (!verified.captured)
      throw new InvalidOperationError(`Payment ${verified.paymentId} has not been captured`);
    if (verified.orderId !== providerOrderId || providerOrderId !== hold.providerOrderId) {
      throw new InvalidOperationError('Payment was not made against this hold');
    }
    if (verified.amountPaise !== hold.pricing.grandTotalPaise) {
      throw new InvalidOperationError('Payment amount does not match hold total');
    }
    if (verified.currency !== undefined && verified.currency !== hold.pricing.currency) {
      throw new InvalidOperationError('Payment currency does not match hold currency');
    }
  }

  /** Retain verified contradictory money for support; never correlate it to another payment's sale. */
  private async recordContradictoryCapture(
    verified: PaymentVerificationResponse,
    hold: CartReservation,
  ) {
    await this.recordProviderCapture(verified, hold, null);
    const repo = this.deps.repositories.providerPayments;
    const current = await repo.findByPaymentId(verified.paymentId);
    if (current && current.processingState !== 'requires_support') {
      await repo.save({
        ...current,
        processingState: 'requires_support',
        version: current.version + 1,
        updatedAt: this.deps.config.clock.now().toISOString(),
      });
    }
  }

  private async recordProviderCapture(
    verified: PaymentVerificationResponse,
    hold: CartReservation,
    orderId: EntityId | null,
  ): Promise<void> {
    const existing = await this.deps.repositories.providerPayments.findByPaymentId(
      verified.paymentId,
    );
    if (existing) {
      if (
        existing.providerOrderId !== hold.providerOrderId ||
        existing.capturedPaise !== verified.amountPaise ||
        existing.currency !== (verified.currency ?? hold.pricing.currency) ||
        (orderId !== null && existing.orderId !== null && existing.orderId !== orderId)
      ) {
        throw new InvalidOperationError('Provider payment record conflicts with verified capture');
      }
      if (orderId === null || existing.orderId === orderId) return;
    }

    const receivedAt = this.deps.config.clock.now();
    await this.providerPayments.recordEvent(
      {
        type: 'captured',
        paymentId: verified.paymentId,
        providerOrderId: hold.providerOrderId ?? null,
        orderId,
        correlated: true,
        amountPaise: verified.amountPaise,
        currency: verified.currency ?? hold.pricing.currency,
        feePaise: existing?.feePaise ?? verified.feePaise ?? 0,
        taxOnFeePaise: existing?.taxOnFeePaise ?? verified.taxOnFeePaise ?? 0,
        occurredAt: existing?.capturedAt ?? receivedAt.toISOString(),
      },
      { trustedIngestion: 'internal_provider_response', receivedAt },
    );
  }

  /** Read-only, owner-scoped source of truth for reload/lost-callback recovery. */
  async getPaymentRecoveryStatus(
    actor: ActorContext,
    holdId: EntityId,
  ): Promise<PaymentRecoveryStatus> {
    const hold = await this.deps.repositories.cartReservations.getById(holdId);
    if (!hold || !this.actsForHold(actor, hold)) throw new NotFoundError('hold', holdId);

    const base = {
      holdId: hold.id,
      eventId: hold.eventId,
      expiresAt: hold.expiresAt,
      updatedAt: hold.updatedAt,
    };
    const order = hold.convertedOrderId
      ? await this.deps.repositories.orders.getById(hold.convertedOrderId)
      : null;
    if (order) {
      if (order.status === 'refunded') return { ...base, status: 'refunded', orderId: order.id };
      if (order.status === 'failed') return { ...base, status: 'failed', orderId: order.id };
      if (order.status === 'cancelled') return { ...base, status: 'cancelled', orderId: order.id };
      if (order.status === 'paid') {
        const gaps = await this.assessFulfilment(order);
        return {
          ...base,
          status: gaps.missing.length === 0 ? 'fulfilled' : 'processing',
          orderId: order.id,
        };
      }
      return { ...base, status: 'processing', orderId: order.id };
    }

    if (!hold.providerOrderId && hold.providerOrderCreation) {
      return {
        ...base,
        status:
          hold.providerOrderCreation.state === 'requires_support'
            ? 'requires_support'
            : 'processing',
        orderId: null,
      };
    }

    const providerPayment = hold.providerOrderId
      ? await this.deps.repositories.providerPayments.findByProviderOrderId(hold.providerOrderId)
      : null;
    if (providerPayment?.processingState === 'refunded') {
      return { ...base, status: 'refunded', orderId: null };
    }
    if (providerPayment?.processingState === 'requires_support') {
      await this.deps.outbox.append(
        domainEvent({
          id: deterministicDomainEventId(
            'payment.support_required',
            providerPayment.id,
            String(providerPayment.version),
          ),
          type: 'payment.support_required',
          aggregateId: providerPayment.id,
          organizationId: hold.organizationId,
          actorId: SYSTEM_ACTOR.userId,
          payload: {
            paymentId: providerPayment.id,
            holdId: hold.id,
            organizationId: hold.organizationId,
            stateVersion: providerPayment.version,
          },
          occurredAt: this.deps.config.clock.now().getTime(),
        }),
      );
      return { ...base, status: 'requires_support', orderId: null };
    }
    if (providerPayment?.capturedPaise) {
      return { ...base, status: 'processing', orderId: null };
    }
    if (hold.status === 'released' || Date.parse(hold.expiresAt) <= Date.now()) {
      return { ...base, status: 'expired', orderId: null };
    }
    return { ...base, status: 'pending', orderId: null };
  }

  /**
   * Reconcile a captured provider payment when the browser redirect callback
   * was lost. The caller must own the hold; provider capture is re-read from
   * Razorpay before the normal idempotent fulfillment path is invoked.
   */
  async reconcilePaymentRecovery(
    actor: ActorContext,
    holdId: EntityId,
  ): Promise<PaymentRecoveryStatus> {
    const hold = await this.deps.repositories.cartReservations.getById(holdId);
    if (!hold || !this.actsForHold(actor, hold)) throw new NotFoundError('hold', holdId);

    const current = await this.getPaymentRecoveryStatus(actor, holdId);
    if (current.status === 'fulfilled' || current.status === 'refunded') return current;
    if (!hold.providerOrderId) return current;

    const recorded = await this.deps.repositories.providerPayments.findByProviderOrderId(
      hold.providerOrderId,
    );
    if (!recorded || recorded.capturedPaise <= 0) return current;

    // A persisted webhook fact is a reconciliation hint, not authority to
    // issue tickets. Confirm capture and its order/amount/currency with the
    // provider before entering the same idempotent fulfillment path as the
    // signed webhook and redirect callback.
    const verified = await this.deps.paymentProvider.getPayment(recorded.id);
    if (!verified?.captured) return current;

    await this.confirmPayment({
      actor,
      paymentId: verified.paymentId,
      paymentIntentId: hold.providerOrderId,
      holdId,
      _idempotencyKey: `recovery:${verified.paymentId}`,
      _verifiedPayment: verified,
    });
    return this.getPaymentRecoveryStatus(actor, holdId);
  }

  /**
   * For a payment that arrived after its hold lapsed: bring the hold back to life
   * and confirm its seats still fit. Unavailable admission becomes a durable,
   * approval-gated full-paid compensation request; no direct provider refund.
   *
   * Re-activating the hold gives it a NEW position in the event's strict order of
   * holds, taken in a transaction, and capacity is then judged exactly as it is
   * for a fresh hold. That is what stops a late payer and a brand-new buyer, each
   * told "there is room" a moment apart, from both getting the last seat: the
   * revived hold is visible to every later buyer, and every earlier one is visible
   * to it. The refund uses a key derived from the payment id, so a redelivered
   * webhook (which sees the same outcome) cannot refund twice.
   */
  private async reviveHoldForLatePayment(
    hold: CartReservation,
  ): Promise<{ hold: CartReservation; available: boolean }> {
    const repo = this.deps.repositories.cartReservations;
    const lapsesAt = new Date(Date.now() + DEFAULT_HOLD_TTL_MS).toISOString();
    const revived = await repo.reactivate(hold.id, lapsesAt);
    if (!revived) throw new InvalidOperationError('Hold not found');

    let overbooked: EntityId | null;
    try {
      overbooked = await this.deps.inventory.firstOverbookedTier(revived);
    } catch (error) {
      // A tier that no longer exists means the seats cannot be honoured; anything
      // else is an unexpected failure and must not be turned into a refund.
      if (!(error instanceof InvalidOperationError)) throw error;
      overbooked = revived.lines[0]?.tierId ?? '';
    }
    const overTierUserCap = await this.firstTierOverUserCap(revived);
    const overEventUserCap = await this.isOverActivePaidUnitCap(revived);
    if (overbooked === null && overTierUserCap === null && !overEventUserCap)
      return { hold: revived, available: true };

    await repo.release(revived.id);
    return { hold: { ...revived, status: 'released' }, available: false };
  }

  /**
   * What a paid order is still missing. Fulfilment is several writes with no
   * enclosing transaction, so a crash can leave an order that was charged but
   * never got its hold converted, its tickets or its ledger entry. A redelivered
   * webhook usually repairs that; this reports it for the case where none comes.
   */
  async assessFulfilment(order: Order): Promise<FulfilmentGaps> {
    const repos = this.deps.repositories;
    order = (await repos.orders.getById(order.id)) ?? order;
    const hold = order.paymentIntentId
      ? await repos.cartReservations.getByProviderOrderId(order.paymentIntentId)
      : null;
    const missing: FulfilmentGap[] = [];
    if (!hold) return { holdFound: false, missing: ['hold'] };

    if (hold.status !== 'converted' || hold.convertedOrderId !== order.id) {
      missing.push('hold_conversion');
    }
    const have = new Set((await repos.entitlements.getByOrderId(order.id)).map((e) => e.id));
    const wanted = issueEntitlements({
      order,
      admitsPerUnit: await this.buildAdmitsPerUnit(hold.lines),
      now: new Date(),
    });
    if (wanted.some((entitlement) => !have.has(entitlement.id))) missing.push('tickets');
    if (order.fulfillmentState !== undefined) {
      if (order.fulfillmentState !== 'complete' || !order.receiptFacts) missing.push('completion');
      if (
        !this.deps.outbox.hasEvent ||
        !(await this.deps.outbox.hasEvent(deterministicDomainEventId('order.fulfilled', order.id)))
      )
        missing.push('order_outbox');
      const issuance = await Promise.all(
        wanted.map(
          (ticket) =>
            this.deps.outbox.hasEvent?.(deterministicDomainEventId('ticket.issued', ticket.id)) ??
            Promise.resolve(false),
        ),
      );
      if (issuance.some((present) => !present)) missing.push('issuance_intents');
    }

    for (const entitlement of wanted) {
      const line = hold.lines.find((item) => item.tierId === entitlement.tierId);
      if (
        (line?.coverUnitPricePaise ?? 0) > 0 &&
        !(await repos.eventCoverAccounts.getByEntitlement(entitlement.id))
      ) {
        missing.push('cover_accounts');
        break;
      }
    }
    // A zero-value order has no money to split, so no ledger entry is expected.
    if (order.grandTotalPaise > 0) {
      const sourceType = order.paymentId?.startsWith('door_cash_')
        ? 'door_cash_sale'
        : order.paymentId?.startsWith('door_')
          ? 'door_electronic_sale'
          : 'online_payment_capture';
      const [legacyEntries, journals] = await Promise.all([
        repos.ledger.findByOrder(order.id),
        repos.financialJournals.findBySource(sourceType, order.id),
      ]);
      const complete =
        order.fulfillmentState === undefined
          ? legacyEntries.length > 0 && journals.length > 0
          : saleAccountingComplete(order, legacyEntries, journals) &&
            (
              await Promise.all(
                journals.map(
                  (journal) =>
                    repos.financialJournals.hasAllLines?.(journal.id) ?? Promise.resolve(false),
                ),
              )
            ).every(Boolean);
      if (!complete) missing.push('ledger');
    }
    return { holdFound: true, missing };
  }

  /**
   * Finishes a paid order that stalled part-way, using the same idempotent steps
   * as fulfilment itself, then reports what (if anything) is still missing.
   * Refuses orders that were never paid: this repairs fulfilment, it does not
   * decide whether a payment happened.
   */
  async repairFulfilment(orderId: EntityId): Promise<FulfilmentGaps> {
    const order = await this.deps.repositories.orders.getById(orderId);
    if (!order) throw new NotFoundError('order', orderId);
    if (order.status !== 'paid' || !order.paymentId) {
      throw new InvalidOperationError(`Order ${orderId} is not a paid order`);
    }
    const before = await this.assessFulfilment(order);
    if (!before.holdFound || before.missing.length === 0) return before;

    const hold = await this.deps.repositories.cartReservations.getByProviderOrderId(
      order.paymentIntentId ?? '',
    );
    if (!hold) return before;
    await this.completeFulfilment(order, hold);
    return this.assessFulfilment(order);
  }

  /**
   * Runs every post-order fulfilment step, each of which is safe to repeat:
   * hold conversion, promo redemption, ticket issuance and the ledger entry.
   *
   * These are separate writes, not one transaction, so any of them can be the
   * last one that landed before a crash. Doing them as "ensure" steps — rather
   * than as a one-shot sequence guarded by "does the order exist?" — is what
   * lets a redelivered webhook or a repeated redirect finish the job.
   */
  private async completeFulfilment(
    order: Order,
    hold: CartReservation,
  ): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const repos = this.deps.repositories;
    const currentOrder = await repos.orders.getById(order.id);
    if (!currentOrder) throw new NotFoundError('order', order.id);
    order = currentOrder;

    // A payment callback can be redelivered after an Admin refund request has
    // locked the order. Resume only still-paid orders; otherwise this path
    // could issue fresh tickets or cover balances while money is under review.
    if (order.status !== 'paid') {
      if (
        order.paymentId &&
        order.fulfillmentState === 'pending' &&
        ['refund_requested', 'refunded'].includes(order.status)
      )
        await this.repairSaleAccounting(order.id);
      return { order, entitlements: await repos.entitlements.getByOrderId(order.id) };
    }

    if (order.compensationRequired) {
      await this.recordSettlement(order);
      const compensation = await requestCaptureCompensation(this.deps, order.id);
      return { order: compensation.order, entitlements: [] };
    }
    if (order.fulfillmentState === 'complete') {
      const gaps = await this.assessFulfilment(order);
      if (gaps.holdFound && gaps.missing.length === 0)
        return { order, entitlements: await repos.entitlements.getByOrderId(order.id) };
    }
    const event = await repos.events.getById(order.eventId);
    if (!event || event.status === 'cancelled') {
      const existingTickets = await repos.entitlements.getByOrderId(order.id);
      if (order.fulfillmentState === 'pending' && existingTickets.length === 0) {
        const blocked = {
          ...order,
          compensationRequired: {
            reason: 'event_unavailable' as const,
            requestedAt: this.deps.config.clock.now().toISOString(),
          },
          version: order.version + 1,
        };
        await repos.orders.save(blocked);
        await this.recordSettlement(blocked);
        const compensation = await requestCaptureCompensation(this.deps, order.id);
        return { order: compensation.order, entitlements: [] };
      }
      await this.repairSaleAccounting(order.id);
      // Existing admissions use the established exact-ticket cancellation flow.
      await this.ensureOrderFulfilledEvent(order);
      return {
        order: (await repos.orders.getById(order.id)) ?? order,
        entitlements: existingTickets,
      };
    }

    if (hold.status !== 'converted') {
      await repos.cartReservations.convertToOrder(hold.id, order.id);
    }

    // Only a promo that was actually applied is a redemption. (This used to
    // write a redemption row with an empty promo id for every order.)
    // Existing paid orders may pre-date the atomic claimant or may have crashed
    // after their order write. Their discount is already financially effective,
    // so repair records the missing audit row without retroactively rejecting it.
    await this.claimPromoRedemption(order, hold, false);

    // Original sale accounting must be durable before any admission can be created.
    await this.recordSettlement(order);

    // Initial issuance saves atomically repair missing intents while preserving
    // any later custody, scan or refund state already stored for that unit.
    const wanted = issueEntitlements({
      order,
      admitsPerUnit: await this.buildAdmitsPerUnit(hold.lines),
      now: new Date(),
    });
    if (hold.upgrade) {
      const issued = wanted[0];
      if (wanted.length !== 1 || !issued) {
        throw new InvalidOperationError('A ticket upgrade must issue exactly one replacement pass');
      }
      const replacement = {
        ...issued,
        upgradeFromEntitlementId: hold.upgrade.sourceEntitlementId,
      };
      await repos.entitlements.replaceForUpgrade({
        sourceEntitlementId: hold.upgrade.sourceEntitlementId,
        expectedSourceVersion: hold.upgrade.sourceEntitlementVersion,
        replacement,
        now: this.deps.config.clock.now(),
      });
      await repos.entitlements.save(
        replacement,
        undefined,
        this.ticketIssuedEvent(order, replacement),
      );
    } else {
      for (const entitlement of wanted) {
        await repos.entitlements.save(
          entitlement,
          undefined,
          this.ticketIssuedEvent(order, entitlement),
        );
      }
    }

    for (const entitlement of wanted) {
      const line = hold.lines.find((item) => item.tierId === entitlement.tierId);
      const amountPaise = line?.coverUnitPricePaise ?? 0;
      if (amountPaise <= 0) continue;
      if (!event || !line?.coverPolicy) {
        throw new InvalidOperationError('Paid cover entitlement has no accepted policy snapshot');
      }
      const proposal = await this.requireAcceptedCoverPolicy(
        event,
        amountPaise,
        line.coverPolicy,
        false,
      );
      const account = createEventCoverAccount({
        entitlementId: entitlement.id,
        orderId: order.id,
        eventId: order.eventId,
        guestUserId: currentEntitlementHolderId(entitlement),
        hostOrganizationId: order.organizationId,
        venueOrganizationId: proposal.venueOrganizationId,
        amountPaise,
        providerCaptureConfirmed: order.status === 'paid' && Boolean(order.paymentId),
        // The immutable accepted policy in the paid hold is the approval
        // evidence; later disabling sales must not strand captured orders.
        merchantApproved: true,
        policyVersion: proposal.policyVersion,
        refundPolicy: proposal.terms.refundPolicy,
        activationApproved: this.deps.config.features.m5CoverActivationApproved === true,
        now: this.deps.config.clock.now(),
      });
      await repos.eventCoverAccounts.createIssuedAccount(account);
    }

    if (order.fulfillmentState !== undefined) {
      order = await repos.orders.completeFulfilment({
        orderId: order.id,
        holdId: hold.id,
        now: this.deps.config.clock.now(),
        event: this.orderFulfilledEvent(order),
      });
    }
    const entitlements = await repos.entitlements.getByOrderId(order.id);
    await this.ensureOrderFulfilledEvent(order);
    return { order, entitlements };
  }

  private async ensureOrderFulfilledEvent(order: Order): Promise<void> {
    const entitlements = await this.deps.repositories.entitlements.getByOrderId(order.id);
    for (const entitlement of entitlements) {
      await this.deps.outbox.append(this.ticketIssuedEvent(order, entitlement));
    }
    await this.deps.outbox.append(this.orderFulfilledEvent(order));
  }

  private orderFulfilledEvent(order: Order) {
    return domainEvent({
      id: deterministicDomainEventId('order.fulfilled', order.id),
      type: 'order.fulfilled',
      aggregateId: order.id,
      organizationId: order.organizationId,
      actorId: order.userId ?? SYSTEM_ACTOR.userId,
      payload: {
        orderId: order.id,
        eventId: order.eventId,
        ...(order.fulfillmentState !== undefined ? { receiptFacts: orderReceiptFacts(order) } : {}),
      },
      occurredAt: this.deps.config.clock.now().getTime(),
    });
  }

  private ticketIssuedEvent(order: Order, entitlement: Entitlement) {
    return domainEvent({
      id: deterministicDomainEventId('ticket.issued', entitlement.id),
      type: 'ticket.issued',
      aggregateId: entitlement.id,
      organizationId: entitlement.organizationId,
      actorId: order.userId ?? SYSTEM_ACTOR.userId,
      payload: {
        entitlementId: entitlement.id,
        orderId: order.id,
        eventId: entitlement.eventId,
        purchaserUserId: entitlement.userId,
        holderUserId: currentEntitlementHolderId(entitlement),
        ...(entitlement.upgradeFromEntitlementId
          ? { upgradeFromEntitlementId: entitlement.upgradeFromEntitlementId }
          : {}),
      },
      occurredAt: this.deps.config.clock.now().getTime(),
    });
  }

  private async claimPromoRedemption(
    order: Order,
    hold: CartReservation,
    enforceLimits: boolean,
  ): Promise<'claimed' | 'already_claimed' | 'global_limit' | 'user_limit'> {
    if (!hold.appliedPromoCode) return 'already_claimed';
    const promo = await this.deps.repositories.catalog.getPromoByCode(
      hold.appliedPromoCode,
      hold.eventId,
    );
    const promoId = promo?.id ?? hold.appliedPromoCode;
    return this.deps.repositories.promoRedemptions.claim({
      redemption: {
        id: `RED-${order.id}-${hold.appliedPromoCode}`,
        promoId,
        orderId: order.id,
        userId: order.userId,
        redeemedAt: new Date().toISOString(),
      },
      promoIds: promo ? [promo.id, promo.code] : [hold.appliedPromoCode],
      historicalRedemptionCount: enforceLimits ? (promo?.redemptionCount ?? 0) : 0,
      maxRedemptions: enforceLimits ? (promo?.maxRedemptions ?? null) : null,
      maxPerUser: enforceLimits ? (promo?.maxPerUser ?? null) : null,
    });
  }

  /**
   * Resolves the three settlement organizations + rates for an order and
   * writes the ledger split. Uses `SYSTEM_ACTOR`, not the caller's actor —
   * the buyer confirming their own payment is not a member of the host,
   * venue, or promoter organizations being credited, so their session actor
   * is never the right actor for this write; `requireOrgAccess` treats a
   * system actor as pre-authorized (see `context.ts`).
   */
  /**
   * Public because a door ticket sale is also "a paid order became money",
   * and it must land in the same ledger through the same writer rather than
   * growing a second settlement path that can drift from this one.
   */
  async settleOrder(order: Order): Promise<void> {
    return this.recordSettlement(order);
  }

  /** Repairs only original money facts. Never converts holds, issues tickets, or changes order status. */
  async repairSaleAccounting(orderId: EntityId): Promise<void> {
    const order = await this.deps.repositories.orders.getById(orderId);
    if (!order?.paymentId)
      throw new InvalidOperationError('Original sale payment evidence is unavailable');
    const repo = this.deps.repositories.financialJournals;
    let journals = await repo.findByOrderId(order.id);
    if (originalSaleJournalsComplete(order, journals)) {
      // Replays immutable aggregates to restore missing companion line documents.
      await repo.postBatch(
        journals.filter((journal) =>
          journal.idempotencyKey.startsWith(`m2:ticket-sale:${order.id}:`),
        ),
      );
    } else {
      const provider = await this.deps.repositories.providerPayments.findByPaymentId(
        order.paymentId,
      );
      if (
        !provider ||
        provider.capturedPaise !== order.grandTotalPaise ||
        provider.currency !== order.currency ||
        provider.providerOrderId !== order.paymentIntentId ||
        (provider.orderId && provider.orderId !== order.id) ||
        !provider.capturedAt
      ) {
        throw new InvalidOperationError('Original sale captured payment evidence is invalid');
      }
      try {
        await this.recordSettlement(order);
      } catch (error) {
        if (error instanceof InvalidOperationError && error.message.includes('Original sale'))
          await this.recordSaleAccountingReview(order, error.message);
        throw error;
      }
      journals = await repo.findByOrderId(order.id);
    }
    const hasAllLines = repo.hasAllLines?.bind(repo);
    if (
      !originalSaleJournalsComplete(order, journals) ||
      !hasAllLines ||
      !(
        await Promise.all(
          journals
            .filter((journal) => journal.idempotencyKey.startsWith(`m2:ticket-sale:${order.id}:`))
            .map((journal) => hasAllLines(journal.id)),
        )
      ).every(Boolean)
    ) {
      throw new InvalidOperationError('Original sale accounting is incomplete');
    }
  }

  private async recordSaleAccountingReview(order: Order, reason: string): Promise<void> {
    const store = this.deps.repositories.reconciliations;
    const identity = createHash('sha256')
      .update(`original-sale:${order.id}`)
      .digest('hex')
      .slice(0, 40);
    const runId = `SALE-RUN-${identity}`;
    const id = `SALE-REVIEW-${identity}`;
    const now = this.deps.config.clock.now();
    let run = await store.getRun(runId);
    if (!run) {
      run = createReconciliationRun({ id: runId, requestedBy: 'system_original_sale_repair', now });
      try {
        await store.createRun(run);
      } catch (error) {
        const winner = await store.getRun(runId);
        if (!winner) throw error;
        run = winner;
      }
    }
    if (!(await store.getDiscrepancy(id))) {
      try {
        await store.createDiscrepancies([
          {
            id,
            runId,
            kind: 'missing_journal',
            state: 'finance_review',
            organizationId: order.organizationId,
            orderId: order.id,
            paymentId: order.paymentId,
            payoutId: null,
            amountPaise: order.grandTotalPaise,
            currency: order.currency,
            evidence: { reason: 'original_sale_allocation_missing', detail: reason },
            repair: 'recheck_evidence',
            resolutionReason: null,
            resolvedBy: null,
            resolvedAt: null,
            ...newVersionedEntity(now),
          },
        ]);
      } catch (error) {
        if (!(await store.getDiscrepancy(id))) throw error;
      }
    }
    if (run.status === 'running') {
      try {
        await store.saveRun(completeReconciliationRun(run, { orders: 1 }, 1, now));
      } catch (error) {
        if ((await store.getRun(runId))?.status !== 'completed') throw error;
      }
    }
  }

  private async snapshotSaleAllocation(
    eventId: EntityId,
    organizationId: EntityId,
    grossPaise: number,
    attribution: CheckoutAttribution | null,
  ): Promise<SaleAllocationSnapshot> {
    const hostOrganizationId = organizationId;
    let partnershipIdentity: { id: string; version: number } | null = null;

    // Venue org + share: resolved via the host<->venue Partnership for the
    // event's venue. A host-run event with no venue partnership settles
    // entirely to the host — there is no separate venue party to pay.
    let venueOrganizationId = hostOrganizationId;
    let venueShareRate = 0;
    const event = await this.deps.repositories.events.getById(eventId);
    if (event?.venueId) {
      const partnership = await this.deps.repositories.partnerships.findByPair(
        hostOrganizationId,
        event.venueId,
      );
      if (partnership) {
        partnershipIdentity = partnership;
        venueOrganizationId = partnership.venueOrganizationId;
        // The negotiated venue share (whole-number % on the Partnership, v1's
        // venueCommissionRate convention) → settlement ratio. `null` (never
        // negotiated) settles 0 to the venue — the long-documented fail-safe,
        // see phase-06-*.md. A live partnership wins; otherwise the most recent
        // resolved one is returned by findByPair, so a blocked pair still pays
        // its last-agreed rate (the venue did host the event).
        venueShareRate = (partnership.venueShareRate ?? 0) / 100;
      }
    }

    // Platform fee rate: the host's onboarding plan tier (Phase 2), the only
    // place a plan is recorded. Falls back to the `basic` (highest) rate if
    // no approved onboarding request is on file — a missing record must
    // never under-charge the platform fee.
    const onboarding =
      await this.deps.repositories.onboarding.findByProvisionedOrganizationId(hostOrganizationId);
    const platformFeeRate = platformFeePercentFor(onboarding?.plan ?? 'basic') / 100;

    // Promoter commission rate: the v1-proven performance tier, keyed by the
    // promoter's total attributed conversions across all their links.
    const promoterOrganizationId = attribution?.promoterId ?? null;
    let promoterCommissionRate: number | null = null;
    if (promoterOrganizationId) {
      const links = await this.deps.repositories.referralLinks.listByPromoter(
        promoterOrganizationId,
        { limit: 1000, cursor: null },
      );
      const ticketsSold = links.items.reduce((sum, link) => sum + link.conversions, 0);
      promoterCommissionRate = commissionTierFor(ticketsSold).rate / 100;
    }

    const split = computeSettlementSplit(
      grossPaise,
      platformFeeRate,
      venueShareRate,
      promoterCommissionRate,
    );
    const promoterPaise = attribution?.promoterCommissionPaise ?? split.promoterCommission;
    return validateSaleAllocation(
      {
        version: 'sale-allocation-v1',
        grossPaise,
        platformPaise: split.platformFee,
        venuePaise: split.venueShare,
        promoterPaise,
        hostPaise: grossPaise - split.platformFee - split.venueShare - promoterPaise,
        hostOrganizationId,
        venueOrganizationId,
        promoterOrganizationId,
        partnershipId: partnershipIdentity?.id ?? null,
        partnershipVersion: partnershipIdentity?.version ?? null,
        onboardingId: onboarding?.id ?? null,
        onboardingVersion: onboarding?.version ?? null,
        capturedAt: this.deps.config.clock.now().toISOString(),
      },
      grossPaise,
      organizationId,
    );
  }

  private async recordSettlement(order: Order): Promise<void> {
    const hostOrganizationId = order.organizationId;
    const event = await this.deps.repositories.events.getById(order.eventId);
    const historical = await this.deps.repositories.ledger.findByOrder(order.id);
    const allocation = order.saleAllocation
      ? validateSaleAllocation(
          order.saleAllocation,
          order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise,
          order.organizationId,
        )
      : historical.length > 0
        ? allocationFromLedger(order, historical)
        : order.paymentId?.startsWith('door_')
          ? await this.snapshotSaleAllocation(
              order.eventId,
              order.organizationId,
              order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise,
              order.attribution,
            )
          : (() => {
              throw new InvalidOperationError(
                'Original sale allocation evidence is unavailable; finance review required',
              );
            })();
    const venueOrganizationId = allocation.venueOrganizationId;
    const promoterOrganizationId = allocation.promoterOrganizationId;
    const entries = await this.financeService.recordTicketSale(
      {
        organizationId: hostOrganizationId,
        orderId: order.id,
        eventId: order.eventId,
        // Compatibility ledger now follows the same basis as the canonical
        // journal: only discounted ticket face value is distributable. Guest
        // fees and GST remain separate liabilities/revenue components.
        grossAmount: order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise,
        hostOrganizationId,
        venueOrganizationId,
        promoterOrganizationId,
        allocation,
        platformFeeRate: 0,
        venueShareRate: 0,
        promoterCommissionRate: null,
        promoterCommissionPaise: order.attribution?.promoterCommissionPaise ?? null,
      },
      SYSTEM_ACTOR,
    );

    const providerPayment = order.paymentId
      ? await this.deps.repositories.providerPayments.findByPaymentId(order.paymentId)
      : null;
    const sourceType = order.paymentId?.startsWith('door_cash_')
      ? 'door_cash_sale'
      : order.paymentId?.startsWith('door_')
        ? 'door_electronic_sale'
        : 'online_payment_capture';
    const amountFor = (entryType: (typeof entries)[number]['entryType']): number =>
      entries.find((entry) => entry.entryType === entryType)?.amount ?? 0;
    await this.financialPostingService.postTicketSale({
      organizationId: hostOrganizationId,
      orderId: order.id,
      eventId: order.eventId,
      paymentId: order.paymentId,
      sourceType,
      // Cash has no provider; online orders reach this method only after the
      // provider capture was verified. Electronic door modes are rejected at
      // command entry until a terminal confirmation integration exists.
      providerConfirmed: sourceType !== 'door_electronic_sale',
      currency: order.currency,
      ticketFaceValuePaise: order.admissionSubtotalPaise ?? order.subtotalPaise,
      eventCoverLiabilityPaise: order.coverSubtotalPaise ?? 0,
      discountPaise: order.discountPaise,
      discountFundingOwner: order.discountFundingOwner,
      netTicketRevenuePaise:
        order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise,
      gstPaise: order.gstPaise,
      platformFeePaise: order.platformFeePaise,
      paymentFeePaise: order.paymentFeePaise,
      providerFeePaise: providerPayment
        ? providerPayment.feePaise + providerPayment.taxOnFeePaise
        : 0,
      policy: {
        ...(order.accountingPolicy ?? M4_ACCOUNTING_POLICY),
        // The policy snapshot is part of the journal's idempotent facts. Reuse
        // the immutable payment/order capture time so duplicate callbacks,
        // concurrent confirmation and fulfilment repair rebuild byte-for-byte
        // equivalent journals instead of conflicting on the retry time.
        capturedAt: providerPayment?.capturedAt ?? order.paidAt ?? order.createdAt,
      },
      allocation: {
        platformPaise: amountFor('platform_fee'),
        hostOrganizationId,
        hostPaise: amountFor('host_payout'),
        venueOrganizationId,
        venuePaise: amountFor('venue_share'),
        promoterOrganizationId,
        promoterPaise: amountFor('promoter_commission'),
      },
      promoterAssignmentId: order.attribution?.assignmentId ?? null,
      commissionPolicyVersion: order.attribution?.commissionPolicyVersion ?? null,
      commercialPolicyVersion: order.attribution?.commercialPolicyVersion ?? null,
      postedAt: this.deps.config.clock.now(),
    });

    if (order.attribution) {
      await this.deps.repositories.referralLinks.recordSale(
        order.attribution.referralLinkId,
        order.id,
        order.grandTotalPaise,
        order.attribution.promoterCommissionPaise,
      );
    }

    // Leaderboard: increments in the same call as the ledger write it is
    // derived from (v1's "Option 3" time & location matrix), keyed by the
    // ACTUAL commission amount the ledger recorded — never recomputed here,
    // so the two can never drift from each other.
    if (promoterOrganizationId) {
      const commissionEntry = entries.find((e) => e.entryType === 'promoter_commission');
      if (commissionEntry && commissionEntry.amount > 0) {
        const city = event?.venueId
          ? (await this.deps.repositories.venues.getById(event.venueId))?.public.address.city
          : null;
        await this.leaderboardService.recordCommission(
          promoterOrganizationId,
          commissionEntry.amount,
          city,
          new Date(),
        );
      }
    }
  }

  /**
   * Builds admitsPerUnit map from hold lines from TIER METADATA, not a guess:
   * a tier's `guestCount` (couple tier = 2) wins, else a `couple` entryType
   * admits 2, else 1 (see `admitsForTier`). The entitlement engine
   * (`domain/models/entitlement.ts`) applies the same couple=2 rule, so
   * checkouts and the door always agree on headcount. An unknown/missing tier
   * falls back to 1 rather than failing a paid order.
   */
  private async buildAdmitsPerUnit(
    lines: CartReservation['lines'],
  ): Promise<Record<EntityId, number>> {
    const map: Record<EntityId, number> = {};
    for (const line of lines) {
      const tier = await this.deps.repositories.catalog.getTierById(line.tierId);
      map[line.tierId] = admitsForTier(tier);
    }
    return map;
  }
}

/**
 * Heads admitted per ticket unit, derived from tier metadata (D4): a tier's
 * `guestCount` wins (a couple ticket carries 2), else a `couple` entryType
 * admits 2, else 1. Mirrors the entitlement engine's couple=2 rule.
 */
export function admitsForTier(
  tier: { guestCount?: number; entryType?: string } | null | undefined,
): number {
  return tier?.guestCount ?? (tier?.entryType === 'couple' ? 2 : 1);
}

function commissionForLines(
  lines: PricingBreakdown['lines'],
  terms: CommissionTerms,
  eligibleTierIds: EntityId[] | null,
): number {
  return lines
    .filter((line) => eligibleTierIds === null || eligibleTierIds.includes(line.tierId))
    .reduce((sum, line) => {
      const rate = terms.tierRates?.[line.tierId] ?? terms;
      return (
        sum +
        Math.floor(((line.admissionSubtotalPaise ?? line.subtotalPaise) * rate.ratePercent) / 100) +
        rate.flatPaise * line.quantity
      );
    }, 0);
}
