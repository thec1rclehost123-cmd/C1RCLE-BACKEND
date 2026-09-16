import { createHash } from 'node:crypto';

import { ForbiddenError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { canSessionDoorEntry } from '../../domain/models/event-code.js';
import { attachPaymentIntent, createOrder, markPaid } from '../../domain/models/order.js';
import { assertReconciles } from '../../domain/models/pricing.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { TicketTier } from '../../domain/models/event-catalog.js';
import type { Order } from '../../domain/models/order.js';
import type { PricingBreakdown } from '../../domain/models/pricing.js';
import type { ServiceDeps, ActorContext } from '../context.js';
import type { ScannerService } from '../scanner/scanner-service.js';

/**
 * ─── Paid walk-up ticket sale (Phase 5) ─────────────────────────────────────
 *
 * A guest arrives with no ticket, picks a tier, pays cash/UPI/card at the
 * door, and walks in. Unlike the simpler walk-in headcount record, this
 * produces the real thing: a paid order, issued tickets that are already
 * marked as entered, a scan-ledger row per admission, and a settlement entry
 * — so door revenue lands in the same finance ledger as online revenue and a
 * venue's numbers add up at the end of the night.
 *
 * Three rules are load-bearing:
 *
 *  1. **The price is recalculated server-side from the tier.** There is no
 *     amount field on the wire, and there never will be. A door sale whose
 *     total the client names is a door sale the client can discount.
 *  2. **No online fees are charged.** The guest is handing over cash at a
 *     door; a payment-gateway fee and GST-on-fees would be inventing a charge
 *     nobody is paying. Face value is the whole total.
 *  3. **One idempotency key means one sale.** The order id is derived from
 *     the key, so a retry after a dropped response finds the existing order
 *     instead of charging the guest twice and issuing a second set of
 *     tickets.
 */

export interface DoorTicketSaleServiceDeps {
  scanner: ScannerService;
  events: ServiceDeps['repositories']['events'];
  catalog: ServiceDeps['repositories']['catalog'];
  orders: ServiceDeps['repositories']['orders'];
  entitlements: ServiceDeps['repositories']['entitlements'];
  scanLedger: ServiceDeps['repositories']['scanLedger'];
  inventory: ServiceDeps['inventory'];
  adminAudit: ServiceDeps['adminAudit'];
  logger: ServiceDeps['logger'];
  /**
   * The single writer that turns a paid order into ledger entries. Injected
   * as a function rather than the whole checkout service so this stays a
   * door concern that borrows settlement, not a second checkout.
   */
  settleOrder: (order: Order) => Promise<void>;
}

export type DoorPaymentMode = 'cash' | 'card' | 'upi' | 'other';

export interface DoorTicketSaleCommand {
  sessionToken: string;
  eventId: EntityId;
  tierId: EntityId;
  quantity: number;
  paymentMode: DoorPaymentMode;
  guestName: string;
  guestPhone?: string | null;
  guestEmail?: string | null;
  guestAge?: number | null;
  gender?: string | null;
  gate?: string | null;
  idempotencyKey: string;
}

export interface DoorTicketSaleResult {
  order: Order;
  tickets: Entitlement[];
  /** Scan-ledger ids, one per admitted person. */
  checkInIds: EntityId[];
  amountPaise: number;
  /** True when this call replayed an existing sale rather than creating one. */
  replayed: boolean;
}

export interface DoorTicketSaleService {
  sellAtDoor(command: DoorTicketSaleCommand, actor: ActorContext): Promise<DoorTicketSaleResult>;
}

/**
 * Deterministic and derived from the idempotency key, so the retry of a
 * dropped response collides with the original order at the storage layer
 * rather than minting a second one. Hashed to stay inside the platform's
 * 64-character opaque-id cap regardless of how long the key is.
 */
function doorOrderId(idempotencyKey: string): EntityId {
  return `DOOR-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

/** Face value only — see rule 2 in this file's header. */
function doorPricing(tier: TicketTier, quantity: number): PricingBreakdown {
  const subtotalPaise = tier.priceInPaise * quantity;
  const breakdown: PricingBreakdown = {
    lines: [
      {
        tierId: tier.id,
        tierName: tier.name,
        unitPricePaise: tier.priceInPaise,
        quantity,
        subtotalPaise,
      },
    ],
    subtotalPaise,
    discountPaise: 0,
    discountedSubtotalPaise: subtotalPaise,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    gstPaise: 0,
    grandTotalPaise: subtotalPaise,
    appliedPromoCode: null,
    currency: tier.currency,
  };
  // Runs on every sale, not just in tests: a breakdown whose parts do not sum
  // to its total is a number a guest is handed at a door.
  assertReconciles(breakdown);
  return breakdown;
}

export function createDoorTicketSaleService(
  deps: DoorTicketSaleServiceDeps,
): DoorTicketSaleService {
  async function sellAtDoor(
    command: DoorTicketSaleCommand,
    actor: ActorContext,
  ): Promise<DoorTicketSaleResult> {
    const event = await deps.events.findById(command.eventId);
    if (!event) throw new NotFoundError('Event', command.eventId);
    requireOrgAccess(actor, event.organizationId);

    // Selling entry is a stronger right than scanning it: a `scan_only`
    // handset at the entrance must not be able to take money.
    const session = await deps.scanner.authenticateSession(command.sessionToken, command.eventId);
    requireOrgAccess(actor, session.organizationId);
    if (!canSessionDoorEntry(session)) {
      throw new ForbiddenError('This scanner session may not sell entry at the door');
    }

    const orderId = doorOrderId(command.idempotencyKey);
    const existing = await deps.orders.getById(orderId);
    if (existing) {
      // Replay. Returns the original sale rather than charging again — the
      // guest already paid and already walked in.
      const tickets = await deps.entitlements.getByOrderId(orderId);
      return {
        order: existing,
        tickets,
        checkInIds: [],
        amountPaise: existing.grandTotalPaise,
        replayed: true,
      };
    }

    const tier = await deps.catalog.getTierById(command.tierId);
    if (!tier || tier.eventId !== command.eventId) {
      throw new NotFoundError('Ticket tier', command.tierId);
    }
    if (tier.status !== 'active') {
      throw new InvalidOperationError('That ticket type is not on sale');
    }

    // The door is the last place that should oversell a room.
    const available = await deps.inventory.getAvailableQuantity(command.eventId, tier.id);
    if (available < command.quantity) {
      throw new InvalidOperationError(
        available <= 0
          ? 'That ticket type is sold out'
          : `Only ${String(available)} left of that ticket type`,
      );
    }

    const pricing = doorPricing(tier, command.quantity);
    const pending = createOrder({
      id: orderId,
      eventId: command.eventId,
      organizationId: event.organizationId,
      // A walk-up guest usually has no account. The ticket still carries
      // their name so door staff can read it off the roster.
      userId: null,
      contact: {
        name: command.guestName,
        // `OrderContact` requires strings. A walk-up guest often gives
        // neither, and empty is the honest representation of "not collected"
        // — inventing a placeholder address would put fake data in the same
        // field an online order fills with a real one.
        email: command.guestEmail ?? '',
        phone: command.guestPhone ?? '',
      },
      pricing,
    });
    // Money changed hands before this call, but the order still walks its own
    // state machine — `pending -> awaiting_payment -> paid` — one validated
    // edge at a time, rather than widening the transition table for the door
    // (the same reasoning as D-010's `publish()`). The payment id records how
    // it was taken, so a cash drawer can be reconciled against it.
    const reference = `door_${command.paymentMode}_${orderId}`;
    // Each state is persisted as it happens, not just the final one. The
    // optimistic-lock rule is that a write of version N must find N-1, and —
    // more importantly — a process that dies mid-sale leaves a real order
    // behind to reconcile against the cash drawer rather than nothing.
    await deps.orders.save(pending);
    const awaiting = attachPaymentIntent(pending, reference);
    await deps.orders.save(awaiting);
    const order = markPaid(awaiting, reference);
    await deps.orders.save(order);

    const tickets = issueEntitlements({ order });
    await deps.entitlements.saveMany(tickets);

    // The guest is standing at the door: admit them now, through the same
    // atomic claim a camera scan uses, so the counts and the ledger agree
    // with every other admission tonight.
    const checkInIds: EntityId[] = [];
    for (const ticket of tickets) {
      const claim = await deps.entitlements.claimAdmission(ticket.id, command.eventId);
      if (!claim.admitted) continue;
      const scan = await deps.scanLedger.create({
        eventId: command.eventId,
        organizationId: event.organizationId,
        venueId: event.venueId,
        entitlementId: ticket.id,
        doorSaleId: null,
        entryType: tier.entryType,
        tierName: tier.name,
        tierId: tier.id,
        operatorUid: actor.userId,
        operatorName: null,
        operatorRole: null,
        gate: command.gate ?? null,
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        deviceBound: true,
        guestName: command.guestName,
        guestEmail: command.guestEmail ?? null,
        guestPhone: command.guestPhone ?? null,
        scannedAt: new Date().toISOString(),
        admittedCount: 1,
        scanCountUsed: claim.scansUsed,
        scanCountAllowed: claim.scansAllowed,
        isOffline: false,
        offlineDeviceId: null,
        status: 'consumed',
      });
      checkInIds.push(scan.id);
    }

    // Door revenue settles through the same writer as online revenue, so a
    // venue's finance screen is one set of numbers rather than two.
    await deps.settleOrder(order);

    await deps.adminAudit.write({
      id: `audit-doorsale-${orderId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: event.organizationId,
      action: 'door.ticket_sale',
      targetType: 'order',
      targetId: orderId,
      after: {
        tierId: tier.id,
        quantity: command.quantity,
        amountPaise: pricing.grandTotalPaise,
        paymentMode: command.paymentMode,
      },
    });

    return {
      order,
      tickets,
      checkInIds,
      amountPaise: pricing.grandTotalPaise,
      replayed: false,
    };
  }

  return { sellAtDoor };
}
