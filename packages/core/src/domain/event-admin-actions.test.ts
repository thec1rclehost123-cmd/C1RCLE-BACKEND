import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import { adminPauseEvent, adminResumeEvent, createEvent, transitionEvent } from './models/event.js';

import type { Event } from './models/event.js';

const NOW = new Date('2026-09-13T00:00:00.000Z');

function publishedEvent(overrides: Partial<Event> = {}): Event {
  const draft = createEvent({
    id: 'event_1',
    organizationId: 'org_1',
    venueId: 'venue_1',
    title: 'Sky Night',
    startAt: '2026-10-01T18:00:00Z',
    now: NOW,
  });
  const scheduled = transitionEvent(transitionEvent(draft, 'review', NOW), 'scheduled', NOW);
  return { ...transitionEvent(scheduled, 'published', NOW), ...overrides };
}

describe('adminPauseEvent / adminResumeEvent', () => {
  it('pauses a published event and sets adminOverride', () => {
    const before = publishedEvent();
    const after = adminPauseEvent(before, NOW);
    expect(after.status).toBe('sales_paused');
    expect(after.adminOverride).toBe(true);
    expect(after.version).toBe(before.version + 1);
  });

  it('escalates an already self-paused event to admin override', () => {
    const selfPaused = transitionEvent(publishedEvent(), 'sales_paused', NOW);
    expect(selfPaused.adminOverride).toBe(false);
    const after = adminPauseEvent(selfPaused, NOW);
    expect(after.status).toBe('sales_paused');
    expect(after.adminOverride).toBe(true);
  });

  it('repeat pause is a no-op once already admin-overridden', () => {
    const before = adminPauseEvent(publishedEvent(), NOW);
    const after = adminPauseEvent(before, NOW);
    expect(after).toBe(before);
  });

  it('refuses to pause a draft/started/ended/cancelled event', () => {
    const draft = createEvent({
      id: 'event_2',
      organizationId: 'org_1',
      venueId: 'venue_1',
      title: 'Draft Night',
      startAt: '2026-10-01T18:00:00Z',
      now: NOW,
    });
    expect(() => adminPauseEvent(draft, NOW)).toThrow(InvalidOperationError);
  });

  it('resumes a paused event and clears adminOverride', () => {
    const paused = adminPauseEvent(publishedEvent(), NOW);
    const resumed = adminResumeEvent(paused, NOW);
    expect(resumed.status).toBe('published');
    expect(resumed.adminOverride).toBe(false);
  });

  it('refuses to resume an event that was never paused', () => {
    const draft = createEvent({
      id: 'event_3',
      organizationId: 'org_1',
      venueId: 'venue_1',
      title: 'Draft Night',
      startAt: '2026-10-01T18:00:00Z',
      now: NOW,
    });
    expect(() => adminResumeEvent(draft, NOW)).toThrow(InvalidOperationError);
  });
});
