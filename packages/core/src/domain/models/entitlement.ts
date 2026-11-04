import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import { issueTicketAddonEntitlements } from './ticket-addon.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { Order } from './order.js';
import type { ScanDenyReason } from './scan-ledger.js';
import type { TicketAddonEntitlement } from './ticket-addon.js';

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
 *  2. **Deterministic ids: `ENT-{sha256(orderId:tierId:index)[0:32]}`.**
 *     Fulfilment runs from a payment confirmation, and confirmations arrive
 *     twice (webhook and browser redirect race — see `order.ts`). A random id
 *     would mint a second set of tickets on the second confirmation. A
 *     deterministic one collides with itself, so the retry is a no-op at the
 *     storage layer. Hashed rather than the readable
 *     `ENT-{orderId}-{tierId}-{index}` this replaced: that scheme overflowed
 *     the platform's 64-char opaque-ID cap once a real payment id (`ORD-` +
 *     provider payment id) and a UUID tier id were both concatenated in —
 *     found via `pnpm test` returning a 500 on the *third* fulfilled order in
 *     one process, not the first, because it depends on accumulated id
 *     length, not a fixed input. Opaque by construction now, not just in
 *     name; still fully deterministic (same 3 inputs, same output).
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

/** Admission source used for active purchase caps and financial reporting. */
export type EntitlementUnitKind = 'paid' | 'free_rsvp' | 'complimentary';

export function requiresEligibilityVerification(policy: {
  audienceType?: string;
  minAge?: number | null;
  maxAge?: number | null;
}): boolean {
  return (
    (policy.audienceType !== undefined &&
      policy.audienceType !== 'GENERAL' &&
      policy.audienceType !== 'GROUP') ||
    policy.minAge != null ||
    policy.maxAge != null
  );
}

export function entitlementRequiresEligibilityVerification(entitlement: Entitlement): boolean {
  return (
    entitlement.eligibility !== undefined &&
    requiresEligibilityVerification(entitlement.eligibility)
  );
}

const ENTITLEMENT_TRANSITIONS: Readonly<Record<EntitlementStatus, readonly EntitlementStatus[]>> = {
  valid: ['redeemed', 'void'],
  // A fully-scanned entitlement can still be voided (refund after entry).
  redeemed: ['void'],
  void: [],
};

export interface Entitlement extends VersionedEntity {
  /** `entitlementId(orderId, tierId, index)` — deterministic, see above. */
  id: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierId: EntityId;
  tierName: string;
  /** Null for a guest checkout with no account. */
  userId: EntityId | null;
  /** Legacy records infer RSVP from their order id; new records persist this classification. */
  unitKind?: EntitlementUnitKind;
  /**
   * Current admission holder, distinct from the original purchaser in `userId`.
   * Optional only for pre-M5 Firestore documents; use
   * `currentEntitlementHolderId` to apply the legacy purchaser fallback.
   * Explicit `null` means the unit is still under purchaser custody and has
   * not been claimed by an attendee.
   */
  currentHolderUserId?: EntityId | null;
  /** Version included in online admission credentials; increments on claim or transfer. */
  credentialVersion?: number;
  /** Set on a replacement admission created by a paid upgrade. */
  upgradeFromEntitlementId?: EntityId;
  /** Set when this admission is atomically retired by a paid upgrade. */
  upgradedToEntitlementId?: EntityId;
  /** Identifies the full settled refund that restored this upgraded source pass. */
  upgradeRefundRequestId?: EntityId;
  /** The single pending transfer, if any; changed in the same transaction as transfer state. */
  pendingTransferId?: EntityId | null;
  /** Immutable sold eligibility rule and purchaser attestation; contains no attendee demographics. */
  eligibility?: {
    audienceType: string;
    minAge: number | null;
    maxAge: number | null;
    attested: true;
    attestedAt: string;
  };
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
  /**
   * A provider refund may be in flight while the ticket still exists. The
   * lock is tied to one immutable refund request so retries are idempotent and
   * another refund cannot freeze or release the same admission right.
   */
  refundLock?: {
    refundRequestId: EntityId;
    frozenAt: string;
  } | null;
  /** Non-cover add-on claims owned by this admission entitlement. */
  ticketAddons?: TicketAddonEntitlement[];
}

/**
 * Builds the deterministic id. Exported so fulfilment can check before
 * writing. Hashed (not a readable concatenation) so the result always fits
 * the platform's 64-char opaque-ID cap regardless of how long `orderId`/
 * `tierId` are — see the module doc comment for why this replaced a plain
 * `ENT-{orderId}-{tierId}-{index}` scheme.
 */
export function entitlementId(orderId: EntityId, tierId: EntityId, index: number): EntityId {
  const digest = createHash('sha256').update(`${orderId}:${tierId}:${index}`).digest('hex');
  return `ENT-${digest.slice(0, 32)}`;
}

export interface IssueEntitlementsInput {
  order: Order;
  /**
   * How many people each tier admits per unit, keyed by tier id. Absent means
   * 1. A couple tier passes 2 here.
   */
  admitsPerUnit?: Record<EntityId, number>;
  /** Explicit non-provider origin, used only by the controlled comp issuer. */
  unitKind?: EntitlementUnitKind;
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
    const perPerson = line.admissionMode === 'per_person';
    const admits = perPerson ? 1 : (input.admitsPerUnit?.[line.tierId] ?? 1);
    if (!Number.isInteger(admits) || admits < 1) {
      throw new InvalidOperationError(`Invalid admit count for tier ${line.tierId}`);
    }
    const guestCount = line.guestCount ?? admits;
    if (!Number.isInteger(guestCount) || guestCount < 1) {
      throw new InvalidOperationError(`Invalid guest count for tier ${line.tierId}`);
    }
    const entitlementCount = line.quantity * (perPerson ? guestCount : 1);
    // Legacy bundles keep one multi-admit entitlement. New per-person group
    // products mint one independent, deterministic credential per attendee.
    for (let index = 0; index < entitlementCount; index++) {
      const purchaserAssigned = !perPerson || index % guestCount === 0;
      entitlements.push({
        id: entitlementId(order.id, line.tierId, index),
        orderId: order.id,
        eventId: order.eventId,
        organizationId: order.organizationId,
        tierId: line.tierId,
        tierName: line.tierName,
        userId: order.userId,
        unitKind: input.unitKind ?? (order.id.startsWith('RSVP-') ? 'free_rsvp' : 'paid'),
        currentHolderUserId: purchaserAssigned ? order.userId : null,
        credentialVersion: 1,
        ...(line.eligibility ? { eligibility: { ...line.eligibility } } : {}),
        holderName: purchaserAssigned ? order.contact.name : '',
        ...(line.ticketAddons?.length
          ? {
              ticketAddons: issueTicketAddonEntitlements({
                orderId: order.id,
                entitlementId: entitlementId(order.id, line.tierId, index),
                selections: line.ticketAddons,
                now,
              }),
            }
          : {}),
        status: 'valid',
        scanCountAllowed: admits,
        scanCount: 0,
        scannedAt: [],
        refundLock: null,
        ...newVersionedEntity(now),
      });
    }
  }
  return entitlements;
}

/** The current admission holder; old documents fall back to their purchaser. */
export function currentEntitlementHolderId(entitlement: Entitlement): EntityId | null {
  return entitlement.currentHolderUserId === undefined
    ? entitlement.userId
    : entitlement.currentHolderUserId;
}

/** Legacy tickets predate credential rotation and start at version one. */
export function entitlementCredentialVersion(entitlement: Entitlement): number {
  return entitlement.credentialVersion ?? 1;
}

/**
 * Assigns an unused ticket unit to a new holder and invalidates previously
 * minted credentials by advancing its version. Callers must separately
 * authorize the claim/transfer and persist its audit/outbox record.
 */
export function changeEntitlementHolder(
  entitlement: Entitlement,
  input: {
    expectedCurrentHolderUserId: EntityId | null;
    nextHolderUserId: EntityId | null;
    holderName: string;
    now?: Date;
  },
): Entitlement {
  if (entitlement.status !== 'valid' || entitlement.scanCount > 0 || entitlement.refundLock) {
    throw new InvalidOperationError('Only an unused, unlocked ticket can change holders');
  }
  if (currentEntitlementHolderId(entitlement) !== input.expectedCurrentHolderUserId) {
    throw new InvalidOperationError('Ticket holder changed before this operation completed');
  }
  if (input.nextHolderUserId === input.expectedCurrentHolderUserId) {
    throw new InvalidOperationError('The new holder must differ from the current holder');
  }
  const holderName = input.holderName.trim();
  if (input.nextHolderUserId !== null && holderName.length === 0) {
    throw new InvalidOperationError('A named holder is required for an assigned ticket');
  }
  const version = entitlementCredentialVersion(entitlement);
  if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER) {
    throw new InvalidOperationError('Ticket credential version is invalid');
  }
  return {
    ...bumpVersion(entitlement, input.now ?? new Date()),
    currentHolderUserId: input.nextHolderUserId,
    credentialVersion: version + 1,
    holderName: holderName.length > 0 ? holderName : entitlement.holderName,
  };
}

/**
 * Admits one person against this entitlement.
 *
 * Deliberately admits ONE at a time even when `scanCountAllowed` is 2: door
 * staff scan as each person walks through, and consuming both on the first
 * scan would strand the second guest outside.
 */
export function scanEntitlement(entitlement: Entitlement, now?: Date): Entitlement {
  if (entitlement.refundLock) {
    throw new InvalidOperationError('This ticket is temporarily locked for a refund');
  }
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
export function voidEntitlement(
  entitlement: Entitlement,
  now?: Date,
  refundRequestId?: EntityId,
): Entitlement {
  if (entitlement.status === 'void') return entitlement;
  if (
    entitlement.refundLock &&
    refundRequestId !== undefined &&
    entitlement.refundLock.refundRequestId !== refundRequestId
  ) {
    throw new InvalidOperationError('This ticket is locked by a different refund request');
  }
  return {
    ...bumpVersion(entitlement, now ?? new Date()),
    status: transitionStatus(entitlement.status, 'void', ENTITLEMENT_TRANSITIONS),
    ...(entitlement.ticketAddons?.length
      ? {
          ticketAddons: entitlement.ticketAddons.map((addon) => ({
            ...addon,
            ...(addon.status === 'active' ? { status: 'void' as const } : {}),
          })),
        }
      : {}),
    refundLock: null,
  };
}

/** Redeems one purchased non-cover add-on exactly once without consuming admission. */
export function redeemTicketAddonEntitlement(
  entitlement: Entitlement,
  addonEntitlementId: EntityId,
  now = new Date(),
): Entitlement {
  if (entitlement.status === 'void') {
    throw new InvalidOperationError('Ticket extras on a void ticket cannot be redeemed');
  }
  const addon = entitlement.ticketAddons?.find((item) => item.id === addonEntitlementId);
  if (!addon) throw new InvalidOperationError('Ticket extra was not found on this admission');
  if (addon.status !== 'active') {
    throw new InvalidOperationError('Ticket extra has already been used or voided');
  }
  return {
    ...bumpVersion(entitlement, now),
    ticketAddons: entitlement.ticketAddons?.map((item) =>
      item.id === addonEntitlementId
        ? { ...item, status: 'redeemed', redeemedAt: now.toISOString() }
        : item,
    ),
  };
}

/**
 * Retires an unused paid admission as part of the atomic ticket-upgrade swap.
 * The repository must persist this and the replacement entitlement together.
 */
export function supersedeEntitlementForUpgrade(
  entitlement: Entitlement,
  replacementEntitlementId: EntityId,
  now?: Date,
): Entitlement {
  if (
    entitlement.status !== 'valid' ||
    (entitlement.unitKind ?? (entitlement.orderId.startsWith('RSVP-') ? 'free_rsvp' : 'paid')) !==
      'paid' ||
    entitlement.scanCount !== 0 ||
    entitlement.refundLock ||
    entitlement.pendingTransferId ||
    entitlement.ticketAddons?.some((addon) => addon.status !== 'void')
  ) {
    throw new InvalidOperationError('Only an unused, unlocked paid ticket can be upgraded');
  }
  if (replacementEntitlementId === entitlement.id) {
    throw new InvalidOperationError('An upgrade must issue a replacement ticket');
  }
  return {
    ...bumpVersion(entitlement, now ?? new Date()),
    status: transitionStatus(entitlement.status, 'void', ENTITLEMENT_TRANSITIONS),
    ...(entitlement.ticketAddons?.length
      ? {
          ticketAddons: entitlement.ticketAddons.map((addon) => ({
            ...addon,
            ...(addon.status === 'active' ? { status: 'void' as const } : {}),
          })),
        }
      : {}),
    upgradedToEntitlementId: replacementEntitlementId,
    refundLock: null,
  };
}

/**
 * Restores the old pass only after a full refund of an untouched replacement.
 * The repository must persist both transitions atomically and make retries
 * idempotent by refund request ID.
 */
export function restoreEntitlementAfterUpgradeRefund(input: {
  source: Entitlement;
  replacement: Entitlement;
  refundRequestId: EntityId;
  now?: Date;
}): { source: Entitlement; replacement: Entitlement } {
  const { source, replacement, refundRequestId } = input;
  if (
    source.upgradeRefundRequestId === refundRequestId &&
    source.status === 'valid' &&
    replacement.status === 'void'
  ) {
    return { source, replacement };
  }
  if (
    source.status !== 'void' ||
    source.upgradedToEntitlementId !== replacement.id ||
    replacement.upgradeFromEntitlementId !== source.id ||
    replacement.status !== 'valid' ||
    replacement.scanCount !== 0 ||
    replacement.pendingTransferId ||
    replacement.refundLock?.refundRequestId !== refundRequestId ||
    currentEntitlementHolderId(source) !== currentEntitlementHolderId(replacement) ||
    !refundRequestId
  ) {
    throw new InvalidOperationError('The upgraded pass cannot be restored for this refund');
  }
  const now = input.now ?? new Date();
  return {
    source: {
      ...bumpVersion(source, now),
      status: 'valid',
      upgradeRefundRequestId: refundRequestId,
      refundLock: null,
    },
    replacement: voidEntitlement(replacement, now, refundRequestId),
  };
}

export function freezeEntitlementForRefund(
  entitlement: Entitlement,
  refundRequestId: EntityId,
  now?: Date,
): Entitlement {
  if (entitlement.status === 'void') {
    throw new InvalidOperationError('A void ticket cannot be frozen for refund');
  }
  if (entitlement.refundLock?.refundRequestId === refundRequestId) return entitlement;
  if (entitlement.refundLock) {
    throw new InvalidOperationError('This ticket is already locked by another refund request');
  }
  const at = now ?? new Date();
  return {
    ...bumpVersion(entitlement, at),
    refundLock: { refundRequestId, frozenAt: at.toISOString() },
  };
}

export function releaseEntitlementRefundLock(
  entitlement: Entitlement,
  refundRequestId: EntityId,
  now?: Date,
): Entitlement {
  if (!entitlement.refundLock) return entitlement;
  if (entitlement.refundLock.refundRequestId !== refundRequestId) {
    throw new InvalidOperationError('This ticket is locked by a different refund request');
  }
  return { ...bumpVersion(entitlement, now ?? new Date()), refundLock: null };
}

/** Whether this entitlement can still admit anyone. */
export function canAdmit(entitlement: Entitlement): boolean {
  return (
    !entitlement.refundLock &&
    entitlement.status !== 'void' &&
    entitlement.scanCount < entitlement.scanCountAllowed
  );
}

/** People still admissible on this entitlement. */
export function remainingAdmissions(entitlement: Entitlement): number {
  if (entitlement.status === 'void' || entitlement.refundLock) return 0;
  return Math.max(0, entitlement.scanCountAllowed - entitlement.scanCount);
}

/**
 * ─── Admission decision (Phase 5 door scanning) ─────────────────────────────
 *
 * The single place that answers "may this ticket admit one more person right
 * now?". Pure, so the *same* rule can run inside a Firestore transaction (the
 * adapter's `claimAdmission`) and inside a read-only preview
 * (`ScannerService.resolveTicket`) without the two ever drifting apart.
 *
 * Ordering matters and is deliberate: `wrong_event` is answered before
 * `void_ticket`, so a ticket presented at the wrong club is never told
 * anything about its own state — a scanner at venue B must not be able to
 * enumerate whether a venue-A ticket is valid, refunded, or already used.
 */
export interface AdmissionDecision {
  admitted: boolean;
  denyReason: ScanDenyReason | null;
  denyMessage: string | null;
  scansUsed: number;
  scansAllowed: number;
}

export function evaluateAdmission(
  entitlement: Entitlement | null,
  eventId: EntityId,
): AdmissionDecision {
  if (!entitlement) {
    return {
      admitted: false,
      denyReason: 'invalid_signature',
      denyMessage: 'Ticket not found',
      scansUsed: 0,
      scansAllowed: 0,
    };
  }
  const scansUsed = entitlement.scanCount;
  const scansAllowed = entitlement.scanCountAllowed;
  if (entitlement.eventId !== eventId) {
    return {
      admitted: false,
      denyReason: 'wrong_event',
      denyMessage: 'Ticket is for a different event',
      scansUsed: 0,
      scansAllowed: 0,
    };
  }
  if (entitlement.status === 'void') {
    return {
      admitted: false,
      denyReason: 'void_ticket',
      denyMessage: 'Ticket has been voided',
      scansUsed,
      scansAllowed,
    };
  }
  if (entitlement.refundLock) {
    return {
      admitted: false,
      denyReason: 'void_ticket',
      denyMessage: 'Ticket is temporarily unavailable while a refund is reviewed',
      scansUsed,
      scansAllowed,
    };
  }
  if (scansUsed >= scansAllowed) {
    return {
      admitted: false,
      denyReason: 'already_used',
      denyMessage: 'All admissions on this ticket have been used',
      scansUsed,
      scansAllowed,
    };
  }
  return { admitted: true, denyReason: null, denyMessage: null, scansUsed, scansAllowed };
}

/**
 * The outcome of an admission attempt. `admitted: true` means this call — and
 * no other concurrent call — consumed the seats; `entitlement` is the
 * post-state the adapter must persist.
 */
export interface AdmissionClaim {
  admitted: boolean;
  denyReason: ScanDenyReason | null;
  denyMessage: string | null;
  entitlement: Entitlement | null;
  scansUsed: number;
  scansAllowed: number;
}

export interface AdmitSeatsOptions {
  seats?: number;
  /** A scanner operator's explicit entry check; no attendee evidence is collected. */
  eligibilityVerified?: boolean;
  /** Current tier-policy fallback for legacy entitlements without a snapshot. */
  eligibilityRequired?: boolean;
  expectedScansUsed?: number;
  expectedCredentialVersion?: number;
  now?: Date;
}

/**
 * Decides and applies an admission of one or more seats.
 *
 * Lives here, in the domain, because BOTH storage adapters call it from
 * inside their own atomic section — Firestore inside `runTransaction`, memory
 * with no `await` between read and write. Keeping the rule in one pure
 * function is what stops the transactional path and the preview path from
 * ever disagreeing about what is admissible.
 *
 * Multi-seat is one decision, not a loop: a confirmed couple ticket consumes
 * both seats or neither. Claiming twice would let the two halves land either
 * side of a concurrent scan and admit three people on a two-person ticket.
 */
export function admitSeats(
  entitlement: Entitlement | null,
  eventId: EntityId,
  options: AdmitSeatsOptions = {},
): AdmissionClaim {
  const seats = options.seats ?? 1;
  if (
    entitlement &&
    options.expectedCredentialVersion !== undefined &&
    entitlementCredentialVersion(entitlement) !== options.expectedCredentialVersion
  ) {
    return {
      admitted: false,
      denyReason: 'invalid_signature',
      denyMessage: 'This ticket credential has been replaced',
      entitlement,
      scansUsed: entitlement.scanCount,
      scansAllowed: entitlement.scanCountAllowed,
    };
  }
  const decision = evaluateAdmission(entitlement, eventId);
  if (!decision.admitted || !entitlement) {
    return {
      admitted: false,
      denyReason: decision.denyReason,
      denyMessage: decision.denyMessage,
      entitlement,
      scansUsed: decision.scansUsed,
      scansAllowed: decision.scansAllowed,
    };
  }
  if (
    (entitlementRequiresEligibilityVerification(entitlement) ||
      options.eligibilityRequired === true) &&
    options.eligibilityVerified !== true
  ) {
    return {
      admitted: false,
      denyReason: 'eligibility_required',
      denyMessage: 'Staff must verify this attendee meets the ticket eligibility policy',
      entitlement,
      scansUsed: entitlement.scanCount,
      scansAllowed: entitlement.scanCountAllowed,
    };
  }
  // The confirmation token was minted against a state a staff member saw. If
  // anything consumed a seat since, the confirmation must fail rather than
  // admit against a target that moved underneath it.
  if (
    options.expectedScansUsed !== undefined &&
    entitlement.scanCount !== options.expectedScansUsed
  ) {
    return {
      admitted: false,
      denyReason: 'already_used',
      denyMessage: 'This ticket changed since the confirmation was requested',
      entitlement,
      scansUsed: entitlement.scanCount,
      scansAllowed: entitlement.scanCountAllowed,
    };
  }
  if (entitlement.scanCount + seats > entitlement.scanCountAllowed) {
    return {
      admitted: false,
      denyReason: 'already_used',
      denyMessage: `This ticket cannot admit ${String(seats)} more`,
      entitlement,
      scansUsed: entitlement.scanCount,
      scansAllowed: entitlement.scanCountAllowed,
    };
  }
  let admitted = entitlement;
  for (let i = 0; i < seats; i += 1) admitted = scanEntitlement(admitted, options.now);
  return {
    admitted: true,
    denyReason: null,
    denyMessage: null,
    entitlement: admitted,
    scansUsed: admitted.scanCount,
    scansAllowed: admitted.scanCountAllowed,
  };
}
