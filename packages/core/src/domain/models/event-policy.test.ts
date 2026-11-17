import { describe, expect, it } from 'vitest';

import {
  eventAdmissionClosesAt,
  eventAdmissionUnavailableReason,
  eventSalesUnavailableReason,
  eventQrUnavailableReason,
  eventTransferUnavailableReason,
  isMaterialEventChange,
} from './event-policy.js';
import { createEvent, transitionEvent } from './event.js';

const startAt = '2026-11-10T20:00:00.000Z';
const base = {
  ...createEvent({
    id: 'event',
    organizationId: 'host',
    venueId: 'venue',
    title: 'Night',
    startAt,
  }),
  status: 'published' as const,
};

describe('V1 event authority', () => {
  it('allows published and started online sales strictly before the effective end', () => {
    expect(eventSalesUnavailableReason(base, new Date('2026-11-10T19:59:00.000Z'))).toBeNull();
    const started = { ...base, status: 'started' as const };
    expect(eventSalesUnavailableReason(started, new Date('2026-11-11T01:59:59.999Z'))).toBeNull();
    expect(eventSalesUnavailableReason(started, new Date('2026-11-11T02:00:00.000Z'))).toBe(
      'Online sales have ended.',
    );
  });
  it('uses start plus six hours when endAt is missing and closes at the cutoff instant', () => {
    const noEnd = { ...base, endAt: null };
    expect(eventSalesUnavailableReason(noEnd, new Date('2026-11-11T01:59:59.999Z'))).toBeNull();
    expect(eventSalesUnavailableReason(noEnd, new Date('2026-11-11T02:00:00.000Z'))).toBe(
      'Online sales have ended.',
    );
  });
  it('rejects paused, cancelled, postponed, and invalid schedules for new sales', () => {
    for (const status of ['sales_paused', 'cancelled', 'postponed', 'draft'] as const) {
      expect(eventSalesUnavailableReason({ ...base, status }, new Date(startAt))).not.toBeNull();
    }
    expect(
      eventSalesUnavailableReason({ ...base, endAt: 'invalid' }, new Date(startAt)),
    ).not.toBeNull();
  });
  it('opens QR exactly 24h before the current announced start', () => {
    expect(eventQrUnavailableReason(base, new Date('2026-11-09T19:59:59.999Z'))).not.toBeNull();
    expect(eventQrUnavailableReason(base, new Date('2026-11-09T20:00:00.000Z'))).toBeNull();
    expect(
      eventQrUnavailableReason(
        { ...base, startAt: '2026-11-11T20:00:00.000Z' },
        new Date('2026-11-09T20:00:00.000Z'),
      ),
    ).not.toBeNull();
  });
  it('closes admission 5m before configured end or fallback start+6h', () => {
    expect(eventAdmissionClosesAt(base)).toBe(Date.parse('2026-11-11T01:55:00.000Z'));
    const event = { ...base, endAt: '2026-11-11T00:00:00.000Z' };
    expect(eventAdmissionClosesAt(event)).toBe(Date.parse('2026-11-10T23:55:00.000Z'));
    expect(
      eventAdmissionUnavailableReason(event, new Date('2026-11-10T19:59:00.000Z')),
    ).not.toBeNull();
    expect(eventAdmissionUnavailableReason(event, new Date(startAt))).toBeNull();
    expect(
      eventAdmissionUnavailableReason(event, new Date('2026-11-10T23:55:00.000Z')),
    ).not.toBeNull();
  });
  it('closes transfer exactly 5m before start', () => {
    expect(eventTransferUnavailableReason(base, new Date('2026-11-10T19:54:59.999Z'))).toBeNull();
    expect(
      eventTransferUnavailableReason(base, new Date('2026-11-10T19:55:00.000Z')),
    ).not.toBeNull();
  });
  it('postpones canonically and freezes all admission channels', () => {
    const postponed = transitionEvent(base, 'postponed');
    expect(postponed.status).toBe('postponed');
    expect(postponed.startAt).toBe(startAt);
    for (const status of ['postponed', 'cancelled', 'ended', 'archived', 'draft'] as const) {
      const unavailable = { ...base, status };
      const now = new Date(startAt);
      expect(eventQrUnavailableReason(unavailable, now)).not.toBeNull();
      expect(eventAdmissionUnavailableReason(unavailable, now)).not.toBeNull();
      expect(eventTransferUnavailableReason(unavailable, now)).not.toBeNull();
    }
  });
  it('treats venue moves and only time shifts greater than 12h as material', () => {
    expect(isMaterialEventChange(base, { ...base, venueId: 'other' })).toBe(true);
    expect(isMaterialEventChange(base, { ...base, title: 'Correction' })).toBe(false);
    expect(isMaterialEventChange(base, { ...base, startAt: '2026-11-11T08:00:00.000Z' })).toBe(
      false,
    );
    expect(isMaterialEventChange(base, { ...base, startAt: '2026-11-11T08:00:00.001Z' })).toBe(
      true,
    );
    expect(isMaterialEventChange(base, { ...base, startAt: '2026-11-10T07:59:59.999Z' })).toBe(
      true,
    );
  });
});
