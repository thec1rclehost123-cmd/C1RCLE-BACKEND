import { createHash } from 'node:crypto';

import {
  ConflictError,
  EventNotFoundError,
  InvalidOperationError,
  TicketTierNotFoundError,
  UnauthorizedError,
  VersionConflictError,
} from '../../domain/errors.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { effectiveTierPricePaise } from '../../domain/models/event-catalog.js';
import { platformFeePercentFor } from '../../domain/models/onboarding.js';
import { commissionTierFor } from '../../domain/models/partnership.js';
import { isSystemActor, SYSTEM_ACTOR } from '../context.js';
import { createFinanceService } from '../finance/finance-service.js';
import { createLeaderboardService } from '../finance/leaderboard-service.js';
import {
  ReferralLinkService,
  signPromoterAttribution,
} from '../promoters/referral-link-service.js';

import type { EntityId } from '../../domain/identity.js';
import type { CartReservation } from '../../domain/models/cart-reservation.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { CommissionTerms } from '../../domain/models/event-catalog.js';
import type { Order } from '../../domain/models/order.js';
import type { PricingBreakdown } from '../../domain/models/pricing.js';
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
export class CheckoutService {
  private readonly financeService: FinanceService;
  private readonly leaderboardService: LeaderboardService;

  constructor(private readonly deps: ServiceDeps) {
    this.financeService = createFinanceService({
      ledger: deps.repositories.ledger,
      config: deps.config,
    });
    this.leaderboardService = createLeaderboardService({
      leaderboard: deps.repositories.leaderboard,
      config: deps.config,
    });
  }

  /**
   * Step 1: Quote — calculates pricing for a set of lines + promo.
   * Pure calculation, no side effects.
   */
  async quote(input: {
    actor: ActorContext;
    eventId: EntityId;
    lines: { tierId: EntityId; quantity: number }[];
    promoCode?: string | null;
    referralCode?: string | null;
  }): Promise<{ pricing: PricingBreakdown; attribution: CheckoutAttribution | null }> {
    const { eventId, lines, promoCode, referralCode } = input;

    const pricingLines = lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity }));

    const pricing = await this.deps.pricing.calculate({
      eventId,
      lines: pricingLines,
      promoCode,
    });

    let attribution: CheckoutAttribution | null = null;
    if (referralCode) {
      const signed = await new ReferralLinkService(this.deps).resolveAttribution(
        eventId,
        referralCode,
      );
      if (signed) {
        const promoterCommissionPaise = commissionForLines(pricing.lines, signed.terms);
        if (promoterCommissionPaise > pricing.grandTotalPaise - pricing.platformFeePaise) {
          throw new InvalidOperationError(
            'The assigned promoter commission exceeds this order’s distributable total',
          );
        }
        attribution = {
          referralLinkId: signed.referralLinkId,
          promoterId: signed.promoterId,
          code: signed.code,
          assignmentId: signed.assignmentId,
          assignmentVersion: signed.assignmentVersion,
          termsSnapshot: signed.terms,
          attributionSignature: signPromoterAttribution(signed, this.deps.config.magicTicketSecret),
          promoterCommissionPaise,
        };
      }
    }

    return { pricing, attribution };
  }

  /**
   * Step 2: Create Hold — reserves inventory for ~10 minutes.
   * Idempotent via Idempotency-Key.
   */
  async createHold(input: {
    actor: ActorContext;
    eventId: EntityId;
    organizationId: EntityId;
    lines: { tierId: EntityId; tierName: string; quantity: number; unitPricePaise: number }[];
    pricing: PricingBreakdown;
    appliedPromoCode: string | null;
    attribution: CheckoutAttribution | null;
    userId?: EntityId | null;
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
      idempotencyKey,
      reservationTtlMs,
    } = input;

    // Check for existing hold with same idempotency key
    const existing =
      await this.deps.repositories.cartReservations.getByIdempotencyKey(idempotencyKey);
    if (existing) return existing;

    const now = new Date();
    const buyerId = userId ?? input.actor.userId;

    // Check inventory availability
    for (const line of lines) {
      const available = await this.deps.inventory.getAvailableQuantity(eventId, line.tierId);
      if (available < line.quantity) {
        throw new InvalidOperationError(`Insufficient inventory for tier ${line.tierName}`);
      }
    }

    // Per-user ticket caps (`tier.maxPerUser`): count what this user already
    // holds (live carts) and owns (paid orders) for each capped tier, so the
    // knob binds across orders, not just within one basket. Guests without
    // any identity (`buyerId` null) fall through — there is no stable key to
    // count against, and v1 never enforced a per-user tier cap either.
    if (buyerId) {
      for (const line of lines) {
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
        if (alreadyHeld + alreadyBought + line.quantity > tier.maxPerUser) {
          throw new InvalidOperationError(
            `${tier.name} has a maximum of ${tier.maxPerUser} per user`,
          );
        }
      }
    }

    const holdId = `HOLD-${idempotencyKey}`;
    const ttl = reservationTtlMs ?? 10 * 60 * 1000;

    const hold: CartReservation = {
      id: holdId,
      eventId,
      organizationId,
      userId: buyerId,
      lines: lines.map((l) => ({ ...l })),
      pricing,
      appliedPromoCode,
      attribution: attribution ?? null,
      status: 'active',
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      convertedOrderId: null,
      idempotencyKey,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.deps.repositories.cartReservations.create(hold);
    return hold;
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
  }): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const { actor, eventId, tierId } = input;

    if (!actor.userId || isSystemActor(actor)) {
      throw new UnauthorizedError('Authentication is required to book tickets');
    }

    const event =
      (await this.deps.repositories.events.getById(eventId)) ??
      (await this.deps.repositories.events.getBySlug(eventId));
    if (!event) throw new EventNotFoundError(eventId);
    if (event.status !== 'published') {
      throw new InvalidOperationError(`Event is ${event.status}, RSVP is unavailable`);
    }
    if (!event.isFree) {
      throw new InvalidOperationError('RSVP is available only for free events');
    }

    const tier = await this.deps.repositories.catalog.getTierById(tierId);
    if (!tier || tier.eventId !== event.id) {
      throw new TicketTierNotFoundError(tierId);
    }
    if (tier.status !== 'active') {
      throw new InvalidOperationError(`Tier ${tier.name} is ${tier.status}`);
    }
    // Legacy tolerance: tiers written before `priceInPaise` existed price via
    // `doorPriceInPaise` (or nothing) — see `effectiveTierPricePaise`.
    const unitPricePaise = effectiveTierPricePaise(tier);
    if (unitPricePaise !== 0) {
      throw new InvalidOperationError('RSVP is available only for zero-price tiers');
    }

    // Deterministic id from the RESOLVED event id (callers may pass id or
    // slug — both must converge on one RSVP): one RSVP per user per event.
    // Same rationale as entitlement ids — a retried RSVP collides with itself
    // at the storage layer instead of minting a second ticket.
    const orderId = rsvpOrderId(event.id, actor.userId);
    const existing = await this.deps.repositories.orders.getById(orderId);
    if (existing && existing.status === 'paid') {
      throw new ConflictError('An RSVP already exists for this event');
    }

    await this.deps.inventory.assertAvailable(event.id, tierId, 1);

    const now = new Date();
    const order: Order = {
      id: orderId,
      eventId: event.id,
      organizationId: event.organizationId,
      userId: actor.userId,
      contact: { name: 'RSVP Guest', email: '', phone: '' },
      status: 'paid',
      lines: [
        {
          tierId: tier.id,
          tierName: tier.name,
          quantity: 1,
          unitPricePaise: 0,
          subtotalPaise: 0,
        },
      ],
      currency: tier.currency,
      subtotalPaise: 0,
      discountPaise: 0,
      discountedSubtotalPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      gstPaise: 0,
      grandTotalPaise: 0,
      appliedPromoCode: null,
      attribution: null,
      paymentIntentId: null,
      paymentId: orderId,
      paidAt: now.toISOString(),
      reservationExpiresAt: now.toISOString(),
      failureReason: null,
      refundedPaise: 0,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      await this.deps.repositories.orders.save(order);
    } catch (error) {
      // Lost a concurrent race with a double-tap on the same RSVP — converge
      // on the winner rather than failing the guest.
      if (error instanceof VersionConflictError) {
        const winner = await this.deps.repositories.orders.getById(orderId);
        if (winner) {
          const winnerEntitlements = await this.deps.repositories.entitlements.getByOrderId(
            winner.id,
          );
          return { order: winner, entitlements: winnerEntitlements };
        }
      }
      throw error;
    }

    const issuedEntitlements = issueEntitlements({ order, now });
    for (const e of issuedEntitlements) {
      await this.deps.repositories.entitlements.save(e);
    }

    const entitlements = await this.deps.repositories.entitlements.getByOrderId(orderId);
    return { order, entitlements };
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
    const { holdId, idempotencyKey } = input;

    const hold = await this.deps.repositories.cartReservations.getById(holdId);
    // Same answer for "missing" and "not yours", so a caller cannot probe which
    // hold ids exist.
    if (!hold || !this.actsForHold(input.actor, hold)) {
      throw new InvalidOperationError('Hold not found');
    }
    if (hold.status !== 'active')
      throw new InvalidOperationError(`Hold is ${hold.status}, cannot proceed to payment`);
    if (new Date().getTime() > Date.parse(hold.expiresAt)) {
      await this.deps.repositories.cartReservations.release(holdId);
      throw new InvalidOperationError('Hold has expired');
    }

    if (hold.providerOrderId) {
      return {
        paymentIntentId: hold.providerOrderId,
        amountPaise: hold.pricing.grandTotalPaise,
      };
    }

    const paymentProvider = this.deps.paymentProvider;
    const paymentIntent = await paymentProvider.createOrder({
      amountPaise: hold.pricing.grandTotalPaise,
      currency: hold.pricing.currency,
      idempotencyKey,
      metadata: {
        holdId,
        eventId: hold.eventId,
        organizationId: hold.organizationId,
      },
    });

    // First writer wins. If a concurrent attempt bound a different order while
    // we were calling the provider, that one is authoritative and ours is
    // simply never paid.
    const bound = await this.deps.repositories.cartReservations.bindProviderOrder(
      holdId,
      paymentIntent.id,
    );

    return {
      paymentIntentId: bound ?? paymentIntent.id,
      amountPaise: hold.pricing.grandTotalPaise,
    };
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
  }): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const { actor, paymentId, paymentIntentId, holdId } = input;

    const hold = await this.deps.repositories.cartReservations.getById(holdId);
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
        existingOrder.userId === hold.userId &&
        existingOrder.eventId === hold.eventId &&
        (hold.convertedOrderId === null || hold.convertedOrderId === existingOrder.id);
      if (!belongsToHold) throw new InvalidOperationError('Payment belongs to a different hold');
      return this.completeFulfilment(existingOrder, hold);
    }

    // The hold already lost this exact race — some other caller converted it
    // (or is converting it) to an order. Rather than throwing, converge on
    // whatever that caller produces/produced. This is the idempotent claim:
    // the hold's `active -> converted` transition is the single point of
    // contention, and losing it is not an error for a dual confirmation path.
    if (hold.status === 'converted' && hold.convertedOrderId) {
      const convertedOrder = await this.deps.repositories.orders.getById(hold.convertedOrderId);
      if (convertedOrder) return this.completeFulfilment(convertedOrder, hold);
    }
    if (hold.status !== 'active')
      throw new InvalidOperationError(`Hold is ${hold.status}, cannot confirm`);
    if (new Date().getTime() > Date.parse(hold.expiresAt)) {
      await this.deps.repositories.cartReservations.release(holdId);
      throw new InvalidOperationError('Hold has expired');
    }

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
    const verified = await this.deps.paymentProvider.getPayment(paymentId);
    if (!verified) {
      throw new InvalidOperationError(`Payment ${paymentId} was not found with the provider`);
    }
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

    // Create order
    const orderId = `ORD-${paymentId}`;
    const now = new Date();
    const order: Order = {
      id: orderId,
      eventId: hold.eventId,
      organizationId: hold.organizationId,
      userId: hold.userId,
      contact: { name: 'Guest', email: 'guest@example.com', phone: '' },
      status: 'paid',
      lines: hold.lines.map((l) => ({
        tierId: l.tierId,
        tierName: l.tierName,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        subtotalPaise: l.unitPricePaise * l.quantity,
      })),
      currency: hold.pricing.currency,
      subtotalPaise: hold.pricing.subtotalPaise,
      discountPaise: hold.pricing.discountPaise,
      discountedSubtotalPaise: hold.pricing.discountedSubtotalPaise,
      platformFeePaise: hold.pricing.platformFeePaise,
      paymentFeePaise: hold.pricing.paymentFeePaise,
      gstPaise: hold.pricing.gstPaise,
      grandTotalPaise: hold.pricing.grandTotalPaise,
      appliedPromoCode: hold.appliedPromoCode,
      attribution: hold.attribution,
      paymentIntentId,
      paymentId,
      paidAt: now.toISOString(),
      reservationExpiresAt: hold.expiresAt,
      failureReason: null,
      refundedPaise: 0,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    try {
      await this.deps.repositories.orders.save(order);
    } catch (error) {
      // Lost a concurrent race to claim this payment (webhook + redirect
      // both reached here before either had written) — the optimistic-lock
      // write of the loser fails with a version conflict. That is not a
      // caller-facing error: converge on whichever write actually landed.
      if (error instanceof VersionConflictError) {
        const winner = await this.deps.repositories.orders.getByPaymentId(paymentId);
        if (winner) return this.completeFulfilment(winner, hold);
      }
      throw error;
    }

    return this.completeFulfilment(order, hold);
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

    if (hold.status === 'active') {
      await repos.cartReservations.convertToOrder(hold.id, order.id);
    }

    // Only a promo that was actually applied is a redemption. (This used to
    // write a redemption row with an empty promo id for every order.)
    if (hold.appliedPromoCode && !(await repos.promoRedemptions.getByOrderId(order.id))) {
      await repos.promoRedemptions.create({
        id: `RED-${order.id}-${hold.appliedPromoCode}`,
        promoId: hold.appliedPromoCode,
        orderId: order.id,
        userId: order.userId,
        redeemedAt: new Date().toISOString(),
      });
    }

    // Entitlement ids are deterministic per (order, tier, unit) and saves are
    // compare-and-set, so re-saving an existing one would conflict. Issue only
    // the units that are missing.
    const existing = await repos.entitlements.getByOrderId(order.id);
    const have = new Set(existing.map((e) => e.id));
    const wanted = issueEntitlements({
      order,
      admitsPerUnit: this.buildAdmitsPerUnit(hold.lines),
      now: new Date(),
    });
    for (const entitlement of wanted) {
      if (!have.has(entitlement.id)) await repos.entitlements.save(entitlement);
    }

    // Settlement: the only writer into the partner ledger for a ticket sale.
    // `recordTicketSale` is idempotent per orderId, so repeating it is a no-op.
    await this.recordSettlement(order);

    return { order, entitlements: await repos.entitlements.getByOrderId(order.id) };
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

  private async recordSettlement(order: Order): Promise<void> {
    const hostOrganizationId = order.organizationId;

    // Venue org + share: resolved via the host<->venue Partnership for the
    // event's venue. A host-run event with no venue partnership settles
    // entirely to the host — there is no separate venue party to pay.
    let venueOrganizationId = hostOrganizationId;
    let venueShareRate = 0;
    const event = await this.deps.repositories.events.getById(order.eventId);
    if (event?.venueId) {
      const partnership = await this.deps.repositories.partnerships.findByPair(
        hostOrganizationId,
        event.venueId,
      );
      if (partnership) {
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
    const promoterOrganizationId = order.attribution?.promoterId ?? null;
    let promoterCommissionRate: number | null = null;
    if (promoterOrganizationId) {
      const links = await this.deps.repositories.referralLinks.listByPromoter(
        promoterOrganizationId,
        { limit: 1000, cursor: null },
      );
      const ticketsSold = links.items.reduce((sum, link) => sum + link.conversions, 0);
      promoterCommissionRate = commissionTierFor(ticketsSold).rate / 100;
    }

    const entries = await this.financeService.recordTicketSale(
      {
        organizationId: hostOrganizationId,
        orderId: order.id,
        eventId: order.eventId,
        grossAmount: order.grandTotalPaise,
        hostOrganizationId,
        venueOrganizationId,
        promoterOrganizationId,
        platformFeeRate,
        venueShareRate,
        promoterCommissionRate,
        promoterCommissionPaise: order.attribution?.promoterCommissionPaise ?? null,
      },
      SYSTEM_ACTOR,
    );

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
   * Builds admitsPerUnit map from hold lines (couple tickets = 2, etc.)
   */
  private buildAdmitsPerUnit(lines: CartReservation['lines']): Record<EntityId, number> {
    const map: Record<EntityId, number> = {};
    for (const line of lines) {
      // Tier metadata would tell us if it's a couple ticket
      // For now default to 1; actual logic would read from tier metadata
      map[line.tierId] = 1;
    }
    return map;
  }
}

function commissionForLines(lines: PricingBreakdown['lines'], terms: CommissionTerms): number {
  return lines.reduce((sum, line) => {
    const rate = terms.tierRates?.[line.tierId] ?? terms;
    return (
      sum +
      Math.floor((line.subtotalPaise * rate.ratePercent) / 100) +
      rate.flatPaise * line.quantity
    );
  }, 0);
}
