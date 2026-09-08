import { FieldValue } from 'firebase-admin/firestore';

import { leaderboardStatId } from '../../domain/models/leaderboard.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  LeaderboardBucket,
  LeaderboardPeriodType,
  LeaderboardStat,
} from '../../domain/models/leaderboard.js';
import type { LeaderboardRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const LEADERBOARD_COLLECTION = 'v2_leaderboard_stats';

export class FirestoreLeaderboardRepository implements LeaderboardRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(LEADERBOARD_COLLECTION);
  }

  /**
   * All 6 buckets increment in one Firestore transaction — v1's "Option 3"
   * time & location matrix, so a stat can never partially apply relative to
   * the ledger entries it was derived from.
   */
  async incrementMany(
    promoterId: EntityId,
    buckets: LeaderboardBucket[],
    amountPaise: number,
    now: string,
  ): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      for (const bucket of buckets) {
        const ref = this.collection.doc(leaderboardStatId(promoterId, bucket));
        tx.set(
          ref,
          {
            promoterId,
            periodType: bucket.periodType,
            periodValue: bucket.periodValue,
            city: bucket.city,
            totalCommissionEarnedPaise: FieldValue.increment(amountPaise),
            updatedAt: now,
          },
          { merge: true },
        );
      }
    });
  }

  async getForPromoter(
    promoterId: EntityId,
    bucket: LeaderboardBucket,
  ): Promise<LeaderboardStat | null> {
    const data = (await this.collection.doc(leaderboardStatId(promoterId, bucket)).get()).data();
    return data ? toStat(data) : null;
  }

  async top(
    periodType: LeaderboardPeriodType,
    periodValue: string,
    city: string,
    limit: number,
  ): Promise<LeaderboardStat[]> {
    const snap = await this.collection
      .where('periodType', '==', periodType)
      .where('periodValue', '==', periodValue)
      .where('city', '==', city)
      .orderBy('totalCommissionEarnedPaise', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => toStat(doc.data()));
  }
}

function toStat(data: DocumentData): LeaderboardStat {
  return {
    promoterId: data.promoterId as string,
    periodType: data.periodType as LeaderboardPeriodType,
    periodValue: data.periodValue as string,
    city: data.city as string,
    totalCommissionEarnedPaise: data.totalCommissionEarnedPaise as number,
    updatedAt: data.updatedAt as string,
  };
}
