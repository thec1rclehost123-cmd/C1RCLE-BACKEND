import { periodBucketsFor } from '../../domain/models/leaderboard.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { LeaderboardPeriodType, LeaderboardStat } from '../../domain/models/leaderboard.js';
import type { LeaderboardRepository } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Leaderboard Service (Phase 6) ──────────────────────────────────────────────
 *
 * Increments are called from `CheckoutService.recordSettlement` (system
 * actor, no tenancy gate — see that call site), never from a route directly.
 * Reads are split: `getTop` is a public ranking (no actor, matches v1's
 * public-facing leaderboard and `public/discovery.ts`'s `PUBLIC_READ`
 * pattern), `getMine` is a promoter viewing their own standing
 * (`requireOrgAccess`-gated, since a promoter is itself an organization —
 * see the checkout-webhook integration's Session Log entry).
 */

export interface LeaderboardServiceDeps {
  leaderboard: LeaderboardRepository;
  config: ServiceDeps['config'];
}

export interface LeaderboardService {
  /** Called once per commission-earning ticket sale. */
  recordCommission(
    promoterId: EntityId,
    amountPaise: number,
    city: string | null | undefined,
    now: Date,
  ): Promise<void>;
  getTop(
    periodType: LeaderboardPeriodType,
    periodValue: string,
    city: string,
    limit: number,
  ): Promise<LeaderboardStat[]>;
  getMine(
    organizationId: EntityId,
    periodType: LeaderboardPeriodType,
    periodValue: string,
    city: string,
    actor: ActorContext,
  ): Promise<LeaderboardStat | null>;
}

export function createLeaderboardService(deps: LeaderboardServiceDeps): LeaderboardService {
  const { leaderboard } = deps;

  async function recordCommission(
    promoterId: EntityId,
    amountPaise: number,
    city: string | null | undefined,
    now: Date,
  ): Promise<void> {
    if (amountPaise <= 0) return;
    const buckets = periodBucketsFor(now, city);
    await leaderboard.incrementMany(promoterId, buckets, amountPaise, now.toISOString());
  }

  async function getTop(
    periodType: LeaderboardPeriodType,
    periodValue: string,
    city: string,
    limit: number,
  ): Promise<LeaderboardStat[]> {
    return leaderboard.top(periodType, periodValue, city, limit);
  }

  async function getMine(
    organizationId: EntityId,
    periodType: LeaderboardPeriodType,
    periodValue: string,
    city: string,
    actor: ActorContext,
  ): Promise<LeaderboardStat | null> {
    requireOrgAccess(actor, organizationId);
    return leaderboard.getForPromoter(organizationId, { periodType, periodValue, city });
  }

  return { recordCommission, getTop, getMine };
}
