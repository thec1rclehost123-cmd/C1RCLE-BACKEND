import { leaderboardStatId } from '../../domain/models/leaderboard.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  LeaderboardBucket,
  LeaderboardPeriodType,
  LeaderboardStat,
} from '../../domain/models/leaderboard.js';
import type { LeaderboardRepository } from '../../domain/ports/repositories.js';

export class MemoryLeaderboardRepository implements LeaderboardRepository {
  stats = new Map<string, LeaderboardStat>();

  async incrementMany(
    promoterId: EntityId,
    buckets: LeaderboardBucket[],
    amountPaise: number,
    now: string,
  ): Promise<void> {
    for (const bucket of buckets) {
      const id = leaderboardStatId(promoterId, bucket);
      const existing = this.stats.get(id);
      this.stats.set(id, {
        promoterId,
        periodType: bucket.periodType,
        periodValue: bucket.periodValue,
        city: bucket.city,
        totalCommissionEarnedPaise: (existing?.totalCommissionEarnedPaise ?? 0) + amountPaise,
        updatedAt: now,
      });
    }
  }

  async getForPromoter(
    promoterId: EntityId,
    bucket: LeaderboardBucket,
  ): Promise<LeaderboardStat | null> {
    return this.stats.get(leaderboardStatId(promoterId, bucket)) ?? null;
  }

  async top(
    periodType: LeaderboardPeriodType,
    periodValue: string,
    city: string,
    limit: number,
  ): Promise<LeaderboardStat[]> {
    return [...this.stats.values()]
      .filter(
        (s) => s.periodType === periodType && s.periodValue === periodValue && s.city === city,
      )
      .sort((a, b) => b.totalCommissionEarnedPaise - a.totalCommissionEarnedPaise)
      .slice(0, limit);
  }
}
