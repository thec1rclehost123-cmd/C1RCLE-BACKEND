/**
 * ─── Promoter leaderboard (Phase 6) ──────────────────────────────────────────
 *
 * Ranked by commission earned, ported from v1's `finance-service.ts`
 * `leaderboard_stats` write (the roadmap doc's "ranked by xp" language does
 * not match any v1 source found — v1 ranks by `totalCommissionEarned`; that
 * is the proven behavior ported here). A read-model, not a versioned FSM
 * aggregate: each ticket sale with a promoter commission increments a fixed
 * set of buckets, never transitions a status.
 *
 * Buckets are a period type × city cross product, written in the SAME
 * transaction as the ledger entries that produced the commission (v1's
 * "Option 3" time & location matrix) so a stat can never drift from the
 * ledger it was derived from.
 */

export type LeaderboardPeriodType = 'all_time' | 'month' | 'week';

/** The special city value meaning "not scoped to any one city". */
export const GLOBAL_CITY = 'global';

export interface LeaderboardStat {
  promoterId: string;
  periodType: LeaderboardPeriodType;
  /** 'all' for all_time, 'YYYY-MM' for month, 'YYYY-Www' (ISO week) for week. */
  periodValue: string;
  /** `GLOBAL_CITY` or a normalized (lower-cased, trimmed) city name. */
  city: string;
  totalCommissionEarnedPaise: number;
  updatedAt: string;
}

export interface LeaderboardBucket {
  periodType: LeaderboardPeriodType;
  periodValue: string;
  city: string;
}

/** Lower-cased, trimmed — so 'Mumbai' and ' mumbai ' land in the same bucket. */
export function normalizeCity(city: string | null | undefined): string {
  const trimmed = (city ?? '').trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

/**
 * ISO 8601 week number, ported verbatim from v1's date math (Thursday-anchored
 * week, so a week never splits across a year boundary the way a naive
 * `Sunday-start` calculation would).
 */
function isoWeekValue(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function monthValue(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The 6 buckets a single commission event increments: {all_time, month,
 * week} x {global, this city}. A promoter with no resolvable city still
 * gets the 3 global buckets — `normalizeCity` never returns empty, so the
 * city-scoped buckets fall back to an `'unknown'` city rather than being
 * silently dropped.
 */
export function periodBucketsFor(now: Date, city: string | null | undefined): LeaderboardBucket[] {
  const normalizedCity = normalizeCity(city);
  const month = monthValue(now);
  const week = isoWeekValue(now);
  return [
    { periodType: 'all_time', periodValue: 'all', city: GLOBAL_CITY },
    { periodType: 'all_time', periodValue: 'all', city: normalizedCity },
    { periodType: 'month', periodValue: month, city: GLOBAL_CITY },
    { periodType: 'month', periodValue: month, city: normalizedCity },
    { periodType: 'week', periodValue: week, city: GLOBAL_CITY },
    { periodType: 'week', periodValue: week, city: normalizedCity },
  ];
}

export function leaderboardStatId(promoterId: string, bucket: LeaderboardBucket): string {
  return `${promoterId}_${bucket.periodType}_${bucket.periodValue}_${bucket.city}`;
}
