import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import {
  adminForceCompleteEvent,
  adminPauseEvent,
  adminResumeEvent,
  createEvent,
  transitionEvent,
} from './models/event.js';

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

describe('adminForceCompleteEvent', () => {
  it('force-completes a published event, stamps adminOverride, clears isPublic', () => {
    const before = publishedEvent();
    const after = adminForceCompleteEvent(before, NOW);
    expect(after.status).toBe('ended');
    expect(after.adminOverride).toBe(true);
    expect(after.isPublic).toBe(false);
    expect(after.version).toBe(before.version + 1);
  });

  it('force-completes a sales_paused and a started event (admin-only source states)', () => {
    const paused = transitionEvent(publishedEvent(), 'sales_paused', NOW);
    expect(adminForceCompleteEvent(paused, NOW).status).toBe('ended');

    const started = transitionEvent(publishedEvent(), 'started', NOW);
    expect(adminForceCompleteEvent(started, NOW).status).toBe('ended');
  });

  it('is a no-op on an already-ended event', () => {
    const ended = transitionEvent(publishedEvent(), 'started', NOW);
    const before = adminForceCompleteEvent(ended, NOW);
    expect(adminForceCompleteEvent(before, NOW)).toBe(before);
  });

  it('refuses to force-complete a draft, review, scheduled, archived, or cancelled event', () => {
    const draft = createEvent({
      id: 'event_4',
      organizationId: 'org_1',
      venueId: 'venue_1',
      title: 'Draft Night',
      startAt: '2026-10-01T18:00:00Z',
      now: NOW,
    });
    expect(() => adminForceCompleteEvent(draft, NOW)).toThrow(InvalidOperationError);
  });

  it('leaves an ended event adminOverride untouched when completed naturally', () => {
    const naturallyEnded = transitionEvent(
      transitionEvent(publishedEvent(), 'started', NOW),
      'ended',
      NOW,
    );
    expect(naturallyEnded.adminOverride).toBe(false);
    expect(adminForceCompleteEvent(naturallyEnded, NOW)).toBe(naturallyEnded);
  });
});
