import { describe, expect, it } from 'vitest';

import {
  GLOBAL_CITY,
  leaderboardStatId,
  normalizeCity,
  periodBucketsFor,
} from './models/leaderboard.js';

describe('normalizeCity', () => {
  it('lower-cases and trims', () => {
    expect(normalizeCity(' Mumbai ')).toBe('mumbai');
  });

  it('falls back to unknown for empty/null/undefined', () => {
    expect(normalizeCity('')).toBe('unknown');
    expect(normalizeCity(null)).toBe('unknown');
    expect(normalizeCity(undefined)).toBe('unknown');
  });
});

describe('periodBucketsFor', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');

  it('produces the 6 all_time/month/week x global/city buckets', () => {
    const buckets = periodBucketsFor(now, 'Mumbai');
    expect(buckets).toHaveLength(6);
    expect(buckets).toEqual(
      expect.arrayContaining([
        { periodType: 'all_time', periodValue: 'all', city: GLOBAL_CITY },
        { periodType: 'all_time', periodValue: 'all', city: 'mumbai' },
        { periodType: 'month', periodValue: '2026-09', city: GLOBAL_CITY },
        { periodType: 'month', periodValue: '2026-09', city: 'mumbai' },
        {
          periodType: 'week',
          periodValue: expect.stringMatching(/^2026-W\d{2}$/) as string,
          city: GLOBAL_CITY,
        },
        {
          periodType: 'week',
          periodValue: expect.stringMatching(/^2026-W\d{2}$/) as string,
          city: 'mumbai',
        },
      ]),
    );
  });

  it('falls back to unknown city buckets rather than dropping them', () => {
    const buckets = periodBucketsFor(now, null);
    const cities = buckets.map((b) => b.city);
    expect(cities).toContain('unknown');
    expect(cities).not.toContain('');
  });

  it('ISO week does not split across the year boundary at year start', () => {
    // 2027-01-01 is a Friday, ISO week 53 of 2026 — not week 1 of 2027.
    const yearStart = new Date('2027-01-01T00:00:00.000Z');
    const buckets = periodBucketsFor(yearStart, 'global');
    const week = buckets.find((b) => b.periodType === 'week' && b.city === GLOBAL_CITY);
    expect(week?.periodValue).toBe('2026-W53');
  });
});

describe('leaderboardStatId', () => {
  it('is deterministic and human-legible', () => {
    const id = leaderboardStatId('promo_1', {
      periodType: 'month',
      periodValue: '2026-09',
      city: 'mumbai',
    });
    expect(id).toBe('promo_1_month_2026-09_mumbai');
  });
});
