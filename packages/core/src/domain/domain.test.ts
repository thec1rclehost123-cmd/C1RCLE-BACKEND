import { describe, expect, it } from 'vitest';

import { InvalidOperationError, StateTransitionError } from './errors.js';
import { transitionStatus } from './fsm.js';
import { bumpVersion, newVersionedEntity } from './identity.js';
import {
  EVENT_STATUSES,
  EVENT_TRANSITIONS,
  cancelEvent,
  createEvent,
  isPublicStatus,
  transitionEvent,
  updateEvent,
} from './models/event.js';
import {
  addMember,
  createOrganization,
  removeMember,
  suspendOrganization,
  updateMemberRole,
  updateOrganization,
} from './models/organization.js';
import { createSlotRequest, transitionSlotRequest } from './models/venue.js';

import type { EventStatus } from './models/event.js';

/**
 * ─── B04 domain layer (T05 design) ───────────────────────────────────────────
 * Gate: "FSM + model tests green". Written fresh — the referenced T05 suite is
 * not present in the local frozen checkout, so these assert the behaviour the
 * ported models actually implement, transition table included.
 */

const NOW = new Date('2026-08-11T10:00:00.000Z');
const LATER = new Date('2026-08-11T11:00:00.000Z');

describe('identity — versioning', () => {
  it('starts every entity at version 1 with equal timestamps', () => {
    const base = newVersionedEntity(NOW);
    expect(base).toEqual({
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it('bumps version and updatedAt but never createdAt', () => {
    const base = { ...newVersionedEntity(NOW), id: 'x' };
    const bumped = bumpVersion(base, LATER);
    expect(bumped.version).toBe(2);
    expect(bumped.updatedAt).toBe(LATER.toISOString());
    expect(bumped.createdAt).toBe(NOW.toISOString());
  });
});

describe('fsm — generic transition helper', () => {
  const table = { a: ['b'], b: ['c'], c: [] } as const;

  it('allows a listed transition', () => {
    expect(transitionStatus('a', 'b', table)).toBe('b');
  });

  it('treats same-state as an idempotent no-op', () => {
    expect(transitionStatus('c', 'c', table)).toBe('c');
  });

  it('throws StateTransitionError for an unlisted transition', () => {
    expect(() => transitionStatus('a', 'c', table)).toThrow(StateTransitionError);
  });

  it('throws out of a terminal state', () => {
    expect(() => transitionStatus('c', 'a', table)).toThrow(StateTransitionError);
  });
});

describe('event — status machine', () => {
  const event = createEvent({
    id: 'evt_1',
    organizationId: 'org_1',
    venueId: 'ven_1',
    title: 'Sky Night',
    startAt: '2026-09-01T18:00:00.000Z',
    now: NOW,
  });

  it('is created as a private draft at version 1', () => {
    expect(event.status).toBe('draft');
    expect(event.isPublic).toBe(false);
    expect(event.version).toBe(1);
  });

  it('walks the full happy lifecycle', () => {
    const path: EventStatus[] = [
      'review',
      'scheduled',
      'published',
      'sales_paused',
      'published',
      'started',
      'ended',
      'archived',
    ];
    let current = event;
    for (const next of path) {
      current = transitionEvent(current, next, LATER);
      expect(current.status).toBe(next);
    }
    expect(current.version).toBe(1 + path.length);
  });

  it('derives isPublic from status rather than free text', () => {
    for (const status of EVENT_STATUSES) {
      expect(isPublicStatus(status)).toBe(
        status === 'published' || status === 'sales_paused' || status === 'started',
      );
    }
  });

  it('rejects every transition absent from the table', () => {
    for (const from of EVENT_STATUSES) {
      for (const to of EVENT_STATUSES) {
        if (from === to) continue;
        const legal = EVENT_TRANSITIONS[from].includes(to);
        const subject = { ...event, status: from };
        if (legal) {
          expect(() => transitionEvent(subject, to, LATER)).not.toThrow();
        } else {
          expect(() => transitionEvent(subject, to, LATER)).toThrow();
        }
      }
    }
  });

  it('is idempotent for a same-state transition (retry-safe, no version bump)', () => {
    const published = transitionEvent(
      transitionEvent(transitionEvent(event, 'review', LATER), 'scheduled', LATER),
      'published',
      LATER,
    );
    const again = transitionEvent(published, 'published', LATER);
    expect(again).toBe(published);
    expect(again.version).toBe(published.version);
  });

  it('treats cancelled as terminal', () => {
    const cancelled = cancelEvent(event, 'venue flooded', LATER);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.isPublic).toBe(false);
    expect(cancelled.cancellationReason).toBe('venue flooded');
    expect(() => transitionEvent(cancelled, 'published', LATER)).toThrow(InvalidOperationError);
  });

  it('cancels idempotently', () => {
    const cancelled = cancelEvent(event, 'reason', LATER);
    expect(cancelEvent(cancelled, 'other reason', LATER)).toBe(cancelled);
  });

  it('bumps version on attribute updates without touching status', () => {
    const updated = updateEvent(event, { title: 'Renamed' }, LATER);
    expect(updated.title).toBe('Renamed');
    expect(updated.status).toBe('draft');
    expect(updated.version).toBe(2);
  });
});

describe('organization — membership rules', () => {
  const org = createOrganization({
    id: 'org_1',
    name: 'Skyline',
    slug: 'skyline',
    ownerId: 'user_owner',
    now: NOW,
  });

  it('seeds the creator as owner with every capability', () => {
    expect(org.members).toHaveLength(1);
    expect(org.members[0]).toMatchObject({ userId: 'user_owner', role: 'owner' });
    expect(org.members[0]?.capabilities).toEqual(['host', 'venue', 'promoter']);
  });

  it('adds a member and bumps the version', () => {
    const withMember = addMember(org, {
      userId: 'user_2',
      role: 'manager',
      invitedBy: 'user_owner',
      now: LATER,
    });
    expect(withMember.members).toHaveLength(2);
    expect(withMember.version).toBe(org.version + 1);
  });

  it('rejects a duplicate member', () => {
    expect(() =>
      addMember(org, { userId: 'user_owner', role: 'admin', invitedBy: 'user_owner', now: LATER }),
    ).toThrow(InvalidOperationError);
  });

  it('rejects members on a suspended organization', () => {
    const suspended = suspendOrganization(org, LATER);
    expect(() =>
      addMember(suspended, { userId: 'user_3', role: 'member', invitedBy: 'user_owner' }),
    ).toThrow(InvalidOperationError);
  });

  it('refuses to demote the owner', () => {
    expect(() => updateMemberRole(org, 'user_owner', 'admin', LATER)).toThrow(
      InvalidOperationError,
    );
  });

  it('refuses to remove the owner', () => {
    expect(() => removeMember(org, 'user_owner', LATER)).toThrow(InvalidOperationError);
  });

  it('suspends idempotently', () => {
    const suspended = suspendOrganization(org, LATER);
    expect(suspendOrganization(suspended, LATER)).toBe(suspended);
  });

  it('returns the same object when an update changes nothing', () => {
    expect(updateOrganization(org, { name: org.name }, LATER)).toBe(org);
  });
});

describe('slot request — status machine', () => {
  const request = createSlotRequest({
    id: 'slr_1',
    venueId: 'ven_1',
    eventId: null,
    hostId: 'user_1',
    now: NOW,
  });

  it('starts pending', () => {
    expect(request.status).toBe('pending');
  });

  it('accepts and then allows cancellation', () => {
    const accepted = transitionSlotRequest(request, 'accepted', LATER);
    expect(accepted.status).toBe('accepted');
    expect(transitionSlotRequest(accepted, 'cancelled', LATER).status).toBe('cancelled');
  });

  it('refuses to revive a rejected request', () => {
    const rejected = transitionSlotRequest(request, 'rejected', LATER);
    expect(() => transitionSlotRequest(rejected, 'accepted', LATER)).toThrow(StateTransitionError);
  });
});
