import { eventEffectiveEndAt } from '../../domain/models/event-policy.js';

import type { Event } from '../../domain/models/event.js';

/** Current eligibility policy applies without rewriting immutable historical journals. */
export function stagedSettlement(
  event: Event | null,
  proceedsPaise: number,
  now: Date,
): {
  eligiblePaise: number;
  pendingPaise: number;
  reservePaise: number;
  cancellationPaise: number;
} {
  const held = {
    eligiblePaise: 0,
    pendingPaise: proceedsPaise,
    reservePaise: 0,
    cancellationPaise: 0,
  };
  if (!event || !Number.isSafeInteger(proceedsPaise) || proceedsPaise < 0) return held;
  if (event.status === 'cancelled')
    return { ...held, pendingPaise: 0, cancellationPaise: proceedsPaise };
  if (!['published', 'sales_paused', 'started', 'ended', 'archived'].includes(event.status))
    return held;
  const startAt = Date.parse(event.startAt);
  const endAt = eventEffectiveEndAt(event);
  if (
    !Number.isFinite(startAt) ||
    !Number.isFinite(endAt) ||
    endAt <= startAt ||
    !Number.isFinite(now.getTime())
  )
    return held;
  const elapsed = now.getTime() - endAt;
  if (elapsed < 24 * 3600000) return held;
  if (elapsed >= 72 * 3600000) return { ...held, eligiblePaise: proceedsPaise, pendingPaise: 0 };
  // Division before multiplication avoids integer overflow for large paise amounts.
  const eligiblePaise =
    Math.floor(proceedsPaise / 4) * 3 + Math.floor(((proceedsPaise % 4) * 3) / 4);
  return {
    eligiblePaise,
    pendingPaise: 0,
    reservePaise: proceedsPaise - eligiblePaise,
    cancellationPaise: 0,
  };
}
