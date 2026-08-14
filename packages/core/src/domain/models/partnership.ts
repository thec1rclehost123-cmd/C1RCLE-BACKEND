import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Partnership graph (Phase 1) ──────────────────────────────────────────────
 *
 * The venue↔host relationship, ported from v1 `routes/v1/partnerships.ts`.
 * V1 kept status as an untyped string mutated through a `statusMap` lookup;
 * here it is an explicit transition table, matching how every other V2
 * aggregate works.
 *
 * V1's proven rules, kept:
 *  - a request starts `pending`
 *  - either party may approve, reject or block it
 *  - only one live (pending/active) partnership may exist per pair
 *
 * V1's rules made explicit rather than implied:
 *  - `blocked` is terminal — unblocking is a new request, so the block is
 *    never silently undone by a stray approve
 *  - the *counterparty* approves, not the requester (v1 checked only that the
 *    caller was "a party", which let a requester approve their own request)
 */

export type PartnershipStatus = 'pending' | 'active' | 'rejected' | 'blocked' | 'ended';

const PARTNERSHIP_TRANSITIONS: Readonly<Record<PartnershipStatus, readonly PartnershipStatus[]>> = {
  pending: ['active', 'rejected', 'blocked'],
  // An active partnership can be wound down or blocked, never re-requested.
  active: ['ended', 'blocked'],
  rejected: [],
  blocked: [],
  ended: [],
};

/** Which side asked. Determines who is allowed to answer. */
export type PartnershipInitiator = 'host' | 'venue';

export interface Partnership extends VersionedEntity {
  id: EntityId;
  /** The host organization. */
  hostOrganizationId: EntityId;
  /** The venue organization (the venue's owning tenant, not the venue id). */
  venueOrganizationId: EntityId;
  venueId: EntityId;
  initiatedBy: PartnershipInitiator;
  status: PartnershipStatus;
  message: string | null;
  /** Set when rejected or blocked, so the other party learns why. */
  resolutionReason: string | null;
  resolvedAt: string | null;
}

export interface CreatePartnershipInput {
  id: EntityId;
  hostOrganizationId: EntityId;
  venueOrganizationId: EntityId;
  venueId: EntityId;
  initiatedBy: PartnershipInitiator;
  message?: string;
  now?: Date;
}

export function createPartnership(input: CreatePartnershipInput): Partnership {
  if (input.hostOrganizationId === input.venueOrganizationId) {
    // A tenant partnering with itself has no counterparty to approve it.
    throw new InvalidOperationError('An organization cannot partner with itself');
  }
  return {
    id: input.id,
    hostOrganizationId: input.hostOrganizationId,
    venueOrganizationId: input.venueOrganizationId,
    venueId: input.venueId,
    initiatedBy: input.initiatedBy,
    status: 'pending',
    message: input.message ?? null,
    resolutionReason: null,
    resolvedAt: null,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/** True when this organization is one of the two parties. */
export function isPartyTo(partnership: Partnership, organizationId: EntityId): boolean {
  return (
    partnership.hostOrganizationId === organizationId ||
    partnership.venueOrganizationId === organizationId
  );
}

/**
 * The side that did NOT open the request. Only they may approve or reject it —
 * otherwise a requester could approve their own request, which v1's
 * "are you a party?" check allowed.
 */
export function counterpartyOf(partnership: Partnership): EntityId {
  return partnership.initiatedBy === 'host'
    ? partnership.venueOrganizationId
    : partnership.hostOrganizationId;
}

function transition(
  partnership: Partnership,
  to: PartnershipStatus,
  now: Date,
  reason?: string,
): Partnership {
  if (partnership.status === to) return partnership;
  const next = transitionStatus(partnership.status, to, PARTNERSHIP_TRANSITIONS);
  const stamped = bumpVersion(partnership, now);
  return {
    ...stamped,
    status: next,
    resolutionReason: reason ?? partnership.resolutionReason,
    resolvedAt: now.toISOString(),
  };
}

export function approvePartnership(
  partnership: Partnership,
  approvingOrganizationId: EntityId,
  now?: Date,
): Partnership {
  if (approvingOrganizationId !== counterpartyOf(partnership)) {
    throw new InvalidOperationError('Only the invited party can approve this partnership');
  }
  return transition(partnership, 'active', now ?? new Date());
}

export function rejectPartnership(
  partnership: Partnership,
  rejectingOrganizationId: EntityId,
  reason?: string,
  now?: Date,
): Partnership {
  if (rejectingOrganizationId !== counterpartyOf(partnership)) {
    throw new InvalidOperationError('Only the invited party can reject this partnership');
  }
  return transition(partnership, 'rejected', now ?? new Date(), reason);
}

/** Blocking is available to EITHER party, at any live stage, and is terminal. */
export function blockPartnership(
  partnership: Partnership,
  blockingOrganizationId: EntityId,
  reason?: string,
  now?: Date,
): Partnership {
  if (!isPartyTo(partnership, blockingOrganizationId)) {
    throw new InvalidOperationError('Only a party to this partnership can block it');
  }
  return transition(partnership, 'blocked', now ?? new Date(), reason);
}

/** Winding down an active partnership by mutual course — not a punishment. */
export function endPartnership(
  partnership: Partnership,
  endingOrganizationId: EntityId,
  now?: Date,
): Partnership {
  if (!isPartyTo(partnership, endingOrganizationId)) {
    throw new InvalidOperationError('Only a party to this partnership can end it');
  }
  return transition(partnership, 'ended', now ?? new Date());
}

/** A partnership still occupying the pair — v1's "already requested or active". */
export function isLive(partnership: Partnership): boolean {
  return partnership.status === 'pending' || partnership.status === 'active';
}

/* ─── Promoter commission tiers ────────────────────────────────────────────── */

/**
 * Performance-based commission, ported verbatim from v1
 * `apps/api-gateway/src/lib/rbac-permissions.ts` (`PROMOTER_COMMISSION_TIERS`).
 * Global, not per-organization: the same volume earns the same rate everywhere.
 *
 * `rate` is a whole-number percentage, exactly as v1 stored it. It is NOT
 * money, so it is not in paise — the paise conversion happens when a rate is
 * applied to an order total.
 */
export interface CommissionTier {
  /** Minimum tickets sold to reach this tier. */
  threshold: number;
  /** Whole-number percentage. */
  rate: number;
  label: string;
}

export const PROMOTER_COMMISSION_TIERS: readonly CommissionTier[] = [
  { threshold: 0, rate: 10, label: 'Base' },
  { threshold: 10, rate: 12, label: 'Silver' },
  { threshold: 25, rate: 15, label: 'Gold' },
  { threshold: 50, rate: 18, label: 'Platinum' },
  { threshold: 100, rate: 20, label: 'Diamond' },
];

/** The base tier, named so the lookup never has to assert a non-empty table. */
const BASE_TIER: CommissionTier = { threshold: 0, rate: 10, label: 'Base' };

/** The tier earned by a given volume. Highest threshold at or below it wins. */
export function commissionTierFor(ticketsSold: number): CommissionTier {
  const sold = Number.isFinite(ticketsSold) ? Math.max(0, Math.floor(ticketsSold)) : 0;
  let earned = BASE_TIER;
  for (const tier of PROMOTER_COMMISSION_TIERS) {
    if (sold >= tier.threshold) earned = tier;
  }
  return earned;
}

/**
 * Commission on a gross amount, in paise.
 *
 * Rounded DOWN: a half-paisa rounded up, repeated across every order, pays out
 * money the platform never collected. The promoter loses at most one paisa per
 * order; the ledger stays exact.
 */
export function commissionPaise(grossPaise: number, ticketsSold: number): number {
  if (!Number.isFinite(grossPaise) || grossPaise <= 0) return 0;
  const tier = commissionTierFor(ticketsSold);
  return Math.floor((Math.floor(grossPaise) * tier.rate) / 100);
}
