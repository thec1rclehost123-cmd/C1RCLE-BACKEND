import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { Order } from './order.js';

/**
 * ─── Entitlements (Phase 4) ──────────────────────────────────────────────────
 *
 * The thing a guest actually presents at the door. Ported from v1
 * `entitlement-engine.issueEntitlements()`.
 *
 * Two rules from v1 are load-bearing and kept exactly:
 *
 *  1. **One entitlement per ticket *unit*, not per admitted person.** A couple
 *     ticket is ONE entitlement with `scanCountAllowed: 2` — not two
 *     entitlements. This is not cosmetic: two entitlements would let the pair
 *     split and enter separately at different doors, which is precisely what
 *     a couple ticket is priced not to allow.
 *  2. **Deterministic ids: `ENT-{orderId}-{tierId}-{index}`.** Fulfilment runs
 *     from a payment confirmation, and confirmations arrive twice (webhook and
 *     browser redirect race — see `order.ts`). A random id would mint a second
 *     set of tickets on the second confirmation. A deterministic one collides
 *     with itself, so the retry is a no-op at the storage layer.
 *
 * The QR payload is deliberately NOT stored here. What the guest scans must be
 * short-lived and authorized at read time (Phase 4 handoff doc rule); a
 * long-lived code sitting in a database is a code that leaks.
 */

export type EntitlementStatus =
  /** Issued and unused. */
  | 'valid'
  /** Fully scanned in — `scanCount === scanCountAllowed`. */
  | 'redeemed'
  /** Voided by a refund or an admin. */
  | 'void';

const ENTITLEMENT_TRANSITIONS: Readonly<Record<EntitlementStatus, readonly EntitlementStatus[]>> = {
  valid: ['redeemed', 'void'],
  // A fully-scanned entitlement can still be voided (refund after entry).
  redeemed: ['void'],
  void: [],
};

export interface Entitlement extends VersionedEntity {
  /** `ENT-{orderId}-{tierId}-{index}` — deterministic, see above. */
  id: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierId: EntityId;
  tierName: string;
  /** Null for a guest checkout with no account. */
  userId: EntityId | null;
  /** Name on the ticket, for door staff. */
  holderName: string;
  status: EntitlementStatus;
  /**
   * How many people this one entitlement admits. 1 for a normal ticket, 2 for
   * a couple ticket. See rule 1 above.
   */
  scanCountAllowed: number;
  scanCount: number;
  /** Timestamps of each scan, newest last. Door audit trail. */
  scannedAt: string[];
}

/** Builds the deterministic id. Exported so fulfilment can check before writing. */
export function entitlementId(orderId: EntityId, tierId: EntityId, index: number): EntityId {
  return `ENT-${orderId}-${tierId}-${index}`;
}

export interface IssueEntitlementsInput {
  order: Order;
  /**
   * How many people each tier admits per unit, keyed by tier id. Absent means
   * 1. A couple tier passes 2 here.
   */
  admitsPerUnit?: Record<EntityId, number>;
  now?: Date;
}

/**
 * Issues the full set for a paid order.
 *
 * Refuses on an unpaid order rather than issuing optimistically: a ticket that
 * exists before the money does is a ticket someone can present.
 *
 * Pure and total — same order in, same entitlements out, same ids. Calling it
 * twice produces two identical sets, which is exactly what makes the
 * write-side retry safe.
 */
export function issueEntitlements(input: IssueEntitlementsInput): Entitlement[] {
  const { order } = input;
  if (order.status !== 'paid') {
    throw new InvalidOperationError('Entitlements are issued only for a paid order');
  }
  const now = input.now ?? new Date();

  const entitlements: Entitlement[] = [];
  for (const line of order.lines) {
    const admits = input.admitsPerUnit?.[line.tierId] ?? 1;
    if (!Number.isInteger(admits) || admits < 1) {
      throw new InvalidOperationError(`Invalid admit count for tier ${line.tierId}`);
    }
    // One entitlement per unit sold — NOT per admitted person.
    for (let index = 0; index < line.quantity; index++) {
      entitlements.push({
        id: entitlementId(order.id, line.tierId, index),
        orderId: order.id,
        eventId: order.eventId,
        organizationId: order.organizationId,
        tierId: line.tierId,
        tierName: line.tierName,
        userId: order.userId,
        holderName: order.contact.name,
        status: 'valid',
        scanCountAllowed: admits,
        scanCount: 0,
        scannedAt: [],
        ...newVersionedEntity(now),
      });
    }
  }
  return entitlements;
}

/**
 * Admits one person against this entitlement.
 *
 * Deliberately admits ONE at a time even when `scanCountAllowed` is 2: door
 * staff scan as each person walks through, and consuming both on the first
 * scan would strand the second guest outside.
 */
export function scanEntitlement(entitlement: Entitlement, now?: Date): Entitlement {
  if (entitlement.status === 'void') {
    throw new InvalidOperationError('This ticket has been voided');
  }
  if (entitlement.scanCount >= entitlement.scanCountAllowed) {
    throw new InvalidOperationError('This ticket has already been fully used');
  }
  const at = now ?? new Date();
  const scanCount = entitlement.scanCount + 1;
  const next = {
    ...bumpVersion(entitlement, at),
    scanCount,
    scannedAt: [...entitlement.scannedAt, at.toISOString()],
  };
  return scanCount >= entitlement.scanCountAllowed
    ? { ...next, status: transitionStatus(entitlement.status, 'redeemed', ENTITLEMENT_TRANSITIONS) }
    : next;
}

/** Voids a ticket — a refund, or an admin pulling it. */
export function voidEntitlement(entitlement: Entitlement, now?: Date): Entitlement {
  if (entitlement.status === 'void') return entitlement;
  return {
    ...bumpVersion(entitlement, now ?? new Date()),
    status: transitionStatus(entitlement.status, 'void', ENTITLEMENT_TRANSITIONS),
  };
}

/** Whether this entitlement can still admit anyone. */
export function canAdmit(entitlement: Entitlement): boolean {
  return entitlement.status !== 'void' && entitlement.scanCount < entitlement.scanCountAllowed;
}

/** People still admissible on this entitlement. */
export function remainingAdmissions(entitlement: Entitlement): number {
  if (entitlement.status === 'void') return 0;
  return Math.max(0, entitlement.scanCountAllowed - entitlement.scanCount);
}
