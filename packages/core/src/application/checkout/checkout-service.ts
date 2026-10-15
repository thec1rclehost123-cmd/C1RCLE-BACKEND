import { createHash } from 'node:crypto';

import {
  ConflictError,
  EventNotFoundError,
  InvalidOperationError,
  NotFoundError,
  PaymentRefundedError,
  TicketTierNotFoundError,
  UnauthorizedError,
  VersionConflictError,
} from '../../domain/errors.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { effectiveTierPricePaise } from '../../domain/models/event-catalog.js';
import { commissionTierFor } from '../../domain/models/partnership.js';
import { computeSettlementLegs } from '../../domain/models/settlement.js';
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
import type { Order, OrderContact } from '../../domain/models/order.js';
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
/** A fulfilment step a paid order may be missing. */
export type FulfilmentGap = 'hold' | 'hold_conversion' | 'tickets' | 'ledger';

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

/** The smallest amount the payment provider will take (₹1). */
export const MIN_ONLINE_PAYMENT_PAISE = 100;

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

    await this.assertOnSale(eventId);

    const pricingLines = lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity }));

    const pricing = await this.deps.pricing.calculate({
      eventId,
      lines: pricingLines,
      promoCode,
    });

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
    lines: { tierId: EntityId; tierName: string; quantity: number; unitPricePaise: number }[];
    pricing: PricingBreakdown;
    appliedPromoCode: string | null;
    attribution: CheckoutAttribution | null;
    userId?: EntityId | null;
    /** Who the tickets are for; becomes the order contact. */
    attendee?: OrderContact | null;
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
      idempotencyKey,
      reservationTtlMs,
    } = input;

    const now = new Date();
    const buyerId = userId ?? input.actor.userId;

    // An idempotency key identifies a request by ONE buyer. Looking it up on its
    // own would hand a buyer someone else's hold (and its holdId and pricing)
    // whenever two people sent the same key, so the buyer is part of the key.
    const scopedKey = buyerId
      ? createHash('sha256').update(`${buyerId}\n${idempotencyKey}`).digest('hex').slice(0, 40)
      : idempotencyKey;
    const existing = await this.deps.repositories.cartReservations.getByIdempotencyKey(scopedKey);
    if (existing) return existing;

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

    const holdId = `HOLD-${scopedKey}`;
    const ttl = reservationTtlMs ?? DEFAULT_HOLD_TTL_MS;

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
      attendee: attendee ?? null,
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

    // The per-user cap has the same check-then-write shape: one buyer firing
    // several requests at once passes the early check on every one of them. Judge
    // it the same way, against this buyer's other holds ordered at or before this.
    const overCap = await this.firstTierOverUserCap(stored);
    if (overCap !== null) {
      await this.deps.repositories.cartReservations.release(stored.id);
      throw new InvalidOperationError(`${overCap.name} has a maximum of ${overCap.max} per user`);
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
          other.lines.filter((l) => l.tierId === line.tierId).reduce((n, l) => n + l.quantity, 0),
        0,
      );
      if (bought + held > tier.maxPerUser) return { name: tier.name, max: tier.maxPerUser };
    }
    return null;
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

    // A hold made while the event was on sale does not oblige us to take money
    // after the host has cancelled or paused it. (A payment already in flight is
    // a different case: confirmPayment still honours or refunds it.)
    await this.assertOnSale(hold.eventId);

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
  }): Promise<{ order: Order; entitlements: Entitlement[] }> {
    const { actor, paymentId, paymentIntentId, holdId } = input;

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

    // Captured after the hold lapsed: honour the payment if the seats are still
    // free (the order is built from the frozen hold, so the guest gets exactly
    // what they were quoted), otherwise give the money back rather than keep it
    // for nothing. Captured money always ends in an order or a refund.
    if (lateCapture) hold = await this.reviveHoldForLatePayment(hold, paymentId);

    // Create order
    const orderId = `ORD-${paymentId}`;
    const now = new Date();
    const order: Order = {
      id: orderId,
      eventId: hold.eventId,
      organizationId: hold.organizationId,
      userId: hold.userId,
      // The attendee captured at hold time. Holds made before attendee capture
      // existed (or by a client that does not send one) keep the old placeholder.
      contact: hold.attendee ?? { name: 'Guest', email: 'guest@example.com', phone: '' },
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

    // A promo discount becomes financially effective at capture, not quote.
    // Claim it under a datastore transaction before the paid order is exposed;
    // quote-time counts are only an early UX check and cannot protect against
    // two buyers paying concurrently for the last redemption.
    const promoClaim = await this.claimPromoRedemption(order, hold, true);
    if (promoClaim === 'global_limit' || promoClaim === 'user_limit') {
      await this.deps.repositories.cartReservations.release(hold.id);
      await this.deps.paymentProvider.refundPayment({
        paymentId,
        amountPaise: hold.pricing.grandTotalPaise,
        idempotencyKey: `promo-limit-refund:${paymentId}`,
      });
      throw new PaymentRefundedError(
        'The promotional offer reached its limit while your payment was completing. Your payment has been refunded in full.',
      );
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
        if (winner) return this.completeFulfilment(winner, hold);
      }
      throw error;
    }

    return this.completeFulfilment(order, hold);
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

    const providerPayment = hold.providerOrderId
      ? await this.deps.repositories.providerPayments.findByProviderOrderId(hold.providerOrderId)
      : null;
    if (providerPayment?.processingState === 'refunded') {
      return { ...base, status: 'refunded', orderId: null };
    }
    if (providerPayment?.processingState === 'requires_support') {
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
   * For a payment that arrived after its hold lapsed: bring the hold back to life
   * and confirm its seats still fit, or refund the payment in full and say so.
   * Captured money always ends in an order or a refund.
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
    paymentId: string,
  ): Promise<CartReservation> {
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
    if (overbooked === null) return revived;

    await repo.release(revived.id);
    await this.deps.paymentProvider.refundPayment({
      paymentId,
      amountPaise: hold.pricing.grandTotalPaise,
      idempotencyKey: `autorefund:${paymentId}`,
    });
    throw new PaymentRefundedError(
      'Your payment arrived after the reservation expired and the tickets are no longer available. It has been refunded in full.',
    );
  }

  /**
   * What a paid order is still missing. Fulfilment is several writes with no
   * enclosing transaction, so a crash can leave an order that was charged but
   * never got its hold converted, its tickets or its ledger entry. A redelivered
   * webhook usually repairs that; this reports it for the case where none comes.
   */
  async assessFulfilment(order: Order): Promise<FulfilmentGaps> {
    const repos = this.deps.repositories;
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
      admitsPerUnit: this.buildAdmitsPerUnit(hold.lines),
      now: new Date(),
    });
    if (wanted.some((entitlement) => !have.has(entitlement.id))) missing.push('tickets');
    // A zero-value order has no money to split, so no ledger entry is expected.
    if (order.grandTotalPaise > 0 && (await repos.ledger.findByOrder(order.id)).length === 0) {
      missing.push('ledger');
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

    if (hold.status !== 'converted') {
      await repos.cartReservations.convertToOrder(hold.id, order.id);
    }

    // Only a promo that was actually applied is a redemption. (This used to
    // write a redemption row with an empty promo id for every order.)
    // Existing paid orders may pre-date the atomic claimant or may have crashed
    // after their order write. Their discount is already financially effective,
    // so repair records the missing audit row without retroactively rejecting it.
    await this.claimPromoRedemption(order, hold, false);

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

  private async recordSettlement(order: Order): Promise<void> {
    const hostOrganizationId = order.organizationId;

    // Venue org + share: resolved via the host<->venue Partnership for the
    // event's venue. A host-run event with no venue partnership settles
    // entirely to the host — there is no separate venue party to pay.
    let venueOrganizationId = hostOrganizationId;
    let venueBps = 0;
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
        venueBps = (partnership.venueShareRate ?? 0) * 100;
      }
    }

    // Platform commission on ticket revenue: the host's onboarding plan tier
    // (Phase 2) maps to a commission in basis points, which defaults to 0 for
    // every plan. (This used to be a 15/12/10% rate applied to the grand total
    // including the guest's fees and GST — see `computeSettlementLegs`.) A missing
    // onboarding record falls back to `basic`, the plan with the highest rate,
    // so a gap can never under-charge once plans carry a commission.
    const onboarding =
      await this.deps.repositories.onboarding.findByProvisionedOrganizationId(hostOrganizationId);
    const commissionBps = this.deps.config.planCommissionBps[onboarding?.plan ?? 'basic'];

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

    // Money the guest paid on top of the (discounted) ticket subtotal is the
    // platform's customer fee + GST. Derived as the difference, not summed from
    // the fee fields, so the legs add up to exactly what was charged.
    const customerFeesPaise = order.grandTotalPaise - order.discountedSubtotalPaise;
    if (customerFeesPaise < 0) {
      throw new InvalidOperationError('Order total is below its ticket subtotal');
    }
    // A frozen promoter amount (V2 assignment terms) wins; otherwise the
    // performance-tier rate applies to the ticket revenue, not the grand total.
    const promoterAmountPaise =
      order.attribution?.promoterCommissionPaise ??
      (promoterCommissionRate !== null
        ? Math.round(order.discountedSubtotalPaise * promoterCommissionRate)
        : null);

    const entries = await this.financeService.recordTicketSale(
      {
        organizationId: hostOrganizationId,
        orderId: order.id,
        eventId: order.eventId,
        grossAmount: order.grandTotalPaise,
        hostOrganizationId,
        venueOrganizationId,
        promoterOrganizationId,
        platformFeeRate: 0,
        venueShareRate: venueBps / 10_000,
        promoterCommissionRate,
        promoterCommissionPaise: order.attribution?.promoterCommissionPaise ?? null,
        legs: computeSettlementLegs({
          subtotalPaise: order.discountedSubtotalPaise,
          customerFeesPaise,
          // The GST the guest was charged, never more than their fees in total.
          gstPaise: Math.min(order.gstPaise, customerFeesPaise),
          commissionBps,
          venueBps,
          promoterAmountPaise,
        }),
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
