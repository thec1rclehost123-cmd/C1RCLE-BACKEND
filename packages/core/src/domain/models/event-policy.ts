import type { Event } from './event.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ACTIVE_ADMISSION_STATUSES = new Set(['published', 'sales_paused', 'started']);

/** Retained dates on a postponed event are historical, never an announced replacement date. */
export function eventEffectiveEndAt(event: Pick<Event, 'startAt' | 'endAt'>): number {
  return event.endAt == null ? Date.parse(event.startAt) + 6 * HOUR_MS : Date.parse(event.endAt);
}

export function eventAdmissionClosesAt(event: Pick<Event, 'startAt' | 'endAt'>): number {
  return eventEffectiveEndAt(event) - 5 * MINUTE_MS;
}

function eventUnavailableReason(event: Event, now: Date): string | null {
  if (!ACTIVE_ADMISSION_STATUSES.has(event.status)) {
    return event.status === 'postponed'
      ? 'This event is postponed. A new date has not been announced.'
      : 'This event is unavailable for admission.';
  }
  const start = Date.parse(event.startAt);
  const end = eventEffectiveEndAt(event);
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start
  ) {
    return 'The event schedule is unavailable.';
  }
  if (now.getTime() >= eventAdmissionClosesAt(event)) return 'Admission has closed.';
  return null;
}

export function eventAdmissionUnavailableReason(event: Event, now: Date): string | null {
  const unavailable = eventUnavailableReason(event, now);
  if (unavailable) return unavailable;
  const opensAt = event.entryRules?.doorsOpenAt
    ? Date.parse(event.entryRules.doorsOpenAt)
    : Date.parse(event.startAt);
  if (!Number.isFinite(opensAt) || now.getTime() < opensAt) return 'Admission has not opened yet.';
  return null;
}

export function eventQrUnavailableReason(event: Event, now: Date): string | null {
  const unavailable = eventUnavailableReason(event, now);
  if (unavailable) return unavailable;
  return now.getTime() < Date.parse(event.startAt) - 24 * HOUR_MS
    ? 'Your QR becomes available 24 hours before the event starts.'
    : null;
}

export function eventTransferUnavailableReason(event: Event, now: Date): string | null {
  const unavailable = eventUnavailableReason(event, now);
  if (unavailable) return unavailable;
  return now.getTime() >= Date.parse(event.startAt) - 5 * MINUTE_MS
    ? 'Transfers close 5 minutes before the event starts.'
    : null;
}

/** Corrections do not create refund-remedy rights; a venue move always does. */
export function isMaterialEventChange(previous: Event, updated: Event): boolean {
  return (
    previous.venueId !== updated.venueId ||
    Math.abs(Date.parse(updated.startAt) - Date.parse(previous.startAt)) > 12 * HOUR_MS
  );
}
