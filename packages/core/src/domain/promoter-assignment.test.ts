import { describe, expect, it } from 'vitest';

import {
  acceptPromoterAssignment,
  createPromoterAssignment,
  expirePromoterAssignment,
  isPromoterAssignmentAttributable,
  promoterAssignmentStatusAt,
  rejectPromoterAssignment,
  revokePromoterAssignment,
} from './models/event-catalog.js';

const createdAt = new Date('2026-10-28T12:00:00.000Z');
const assignment = (overrides: Partial<Parameters<typeof createPromoterAssignment>[0]> = {}) =>
  createPromoterAssignment({
    id: 'assignment_1',
    eventId: 'event_1',
    promoterId: 'promoter_1',
    terms: { version: 1, ratePercent: 10, flatPaise: 0 },
    status: 'invited',
    invitedBy: 'host_user',
    startsAt: '2026-10-29T00:00:00.000Z',
    expiresAt: '2026-11-02T00:00:00.000Z',
    now: createdAt,
    ...overrides,
  });

describe('Promoter assignment invitation lifecycle', () => {
  it('projects an expired time-bounded assignment as expired without rewriting storage', () => {
    const subject = assignment({ status: 'accepted' });
    expect(promoterAssignmentStatusAt(subject, new Date('2026-11-02T00:00:00.000Z'))).toBe(
      'expired',
    );
    expect(subject.status).toBe('accepted');
  });

  it('persists the expiry transition once the campaign deadline passes', () => {
    const subject = assignment({ status: 'accepted' });
    const now = new Date('2026-11-02T00:00:00.000Z');
    const expired = expirePromoterAssignment(subject, now);

    expect(expired).toMatchObject({ status: 'expired', version: subject.version + 1 });
    expect(expirePromoterAssignment(expired, now)).toBe(expired);
    expect(isPromoterAssignmentAttributable(expired, now)).toBe(false);
  });

  it('records immutable invitation terms and campaign bounds', () => {
    expect(assignment()).toMatchObject({
      status: 'invited',
      invitedAt: createdAt.toISOString(),
      invitedBy: 'host_user',
      acceptedAt: null,
      startsAt: '2026-10-29T00:00:00.000Z',
      expiresAt: '2026-11-02T00:00:00.000Z',
      eligibleTierIds: null,
      terms: { version: 1, ratePercent: 10, flatPaise: 0 },
      version: 1,
    });
  });

  it('accepts a live invitation and records responder evidence', () => {
    const accepted = acceptPromoterAssignment(
      assignment(),
      'promoter_user',
      new Date('2026-10-29T01:00:00.000Z'),
    );
    expect(accepted).toMatchObject({
      status: 'accepted',
      acceptedAt: '2026-10-29T01:00:00.000Z',
      respondedAt: '2026-10-29T01:00:00.000Z',
      respondedBy: 'promoter_user',
      version: 2,
      terms: { version: 1, ratePercent: 10, flatPaise: 0 },
    });
    expect(isPromoterAssignmentAttributable(accepted, new Date('2026-10-29T01:00:00.000Z'))).toBe(
      true,
    );
  });

  it('does not accept after the invitation deadline', () => {
    expect(() =>
      acceptPromoterAssignment(assignment(), 'promoter_user', new Date('2026-11-02T00:00:00.000Z')),
    ).toThrow(/expired/i);
  });

  it('records rejection and revocation as terminal states', () => {
    const rejected = rejectPromoterAssignment(
      assignment(),
      'promoter_user',
      new Date('2026-10-29T01:00:00.000Z'),
    );
    expect(rejected).toMatchObject({ status: 'rejected', respondedBy: 'promoter_user' });
    expect(isPromoterAssignmentAttributable(rejected)).toBe(false);

    const revoked = revokePromoterAssignment(
      acceptPromoterAssignment(assignment(), 'promoter_user', new Date('2026-10-29T01:00:00Z')),
      'host_user',
      'Campaign ended by the Host',
      new Date('2026-10-30T01:00:00Z'),
    );
    expect(revoked).toMatchObject({ status: 'revoked', revokedAt: '2026-10-30T01:00:00.000Z' });
    expect(isPromoterAssignmentAttributable(revoked)).toBe(false);
  });

  it('rejects invalid campaign windows', () => {
    expect(() =>
      assignment({
        startsAt: '2026-11-03T00:00:00.000Z',
        expiresAt: '2026-11-02T00:00:00.000Z',
      }),
    ).toThrow(/after its start/i);
  });
});
