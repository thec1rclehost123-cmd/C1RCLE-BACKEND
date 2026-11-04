import { describe, expect, it } from 'vitest';

import { ConflictError, InvalidOperationError } from '../errors.js';

import {
  createTicketAccessCode,
  redeemTicketAccessCode,
  revokeTicketAccessCode,
} from './ticket-access.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');

function code(overrides: Partial<Parameters<typeof createTicketAccessCode>[0]> = {}) {
  return createTicketAccessCode({
    id: 'verifier-hash',
    eventId: 'event_1',
    organizationId: 'org_1',
    tierIds: ['tier_1'],
    createdBy: 'host_1',
    startsAt: '2026-10-28T12:00:00.000Z',
    expiresAt: '2026-10-29T12:00:00.000Z',
    maxRedemptions: 2,
    now: NOW,
    ...overrides,
  });
}

describe('ticket access code policy', () => {
  it('creates a unique scoped code record with no plaintext secret field', () => {
    const record = code({ tierIds: ['tier_1', 'tier_2'] });

    expect(record).toMatchObject({
      id: 'verifier-hash',
      eventId: 'event_1',
      organizationId: 'org_1',
      tierIds: ['tier_1', 'tier_2'],
      maxRedemptions: 2,
      redemptionCount: 0,
      status: 'active',
    });
    expect(record).not.toHaveProperty('plaintext');
  });

  it('rejects duplicate/empty tier scopes, invalid limits and unbounded date windows', () => {
    expect(() => code({ tierIds: [] })).toThrow(InvalidOperationError);
    expect(() => code({ tierIds: ['tier_1', 'tier_1'] })).toThrow(InvalidOperationError);
    expect(() => code({ maxRedemptions: 0 })).toThrow(InvalidOperationError);
    expect(() => code({ maxRedemptions: 10_001 })).toThrow(InvalidOperationError);
    expect(() =>
      code({ startsAt: '2026-10-28T12:00:00.000Z', expiresAt: '2028-10-28T12:00:00.000Z' }),
    ).toThrow(InvalidOperationError);
  });

  it('creates an identity-scoped grant and increments the bounded redemption counter', () => {
    const original = code();
    const redeemed = redeemTicketAccessCode(original, {
      grantId: 'grant_1',
      userId: 'guest_1',
      now: NOW,
    });

    expect(redeemed.code.redemptionCount).toBe(1);
    expect(redeemed.grant).toMatchObject({
      id: 'grant_1',
      codeId: original.id,
      eventId: original.eventId,
      organizationId: original.organizationId,
      userId: 'guest_1',
      tierIds: ['tier_1'],
      expiresAt: original.expiresAt,
    });
  });

  it('redeems an event scope without adding hidden tier permissions', () => {
    const original = code({ scope: 'event', tierIds: [] });
    const redeemed = redeemTicketAccessCode(original, {
      grantId: 'event_grant',
      userId: 'guest_1',
      now: NOW,
    });
    expect(redeemed.grant).toMatchObject({ scope: 'event', tierIds: [] });
  });

  it('binds a named invitation to the verifier for the normalized recipient email', () => {
    const invitation = code({
      kind: 'invitation',
      recipientEmailHash: 'a'.repeat(64),
      maxRedemptions: 1,
    });
    expect(() =>
      redeemTicketAccessCode(invitation, {
        grantId: 'wrong_recipient_grant',
        userId: 'wrong_recipient',
        recipientEmailHash: 'b'.repeat(64),
        now: NOW,
      }),
    ).toThrow(ConflictError);
    expect(
      redeemTicketAccessCode(invitation, {
        grantId: 'right_recipient_grant',
        userId: 'right_recipient',
        recipientEmailHash: 'a'.repeat(64),
        now: NOW,
      }).grant.userId,
    ).toBe('right_recipient');
  });

  it('rejects not-yet-started, expired, revoked, and exhausted codes', () => {
    const early = code({ startsAt: '2026-10-28T13:00:00.000Z' });
    const expired = code({
      startsAt: '2026-10-28T10:00:00.000Z',
      expiresAt: '2026-10-28T11:59:00.000Z',
    });
    const revoked = revokeTicketAccessCode(
      code(),
      'host_1',
      'Test access is no longer needed',
      NOW,
    );
    const exhausted = { ...code(), redemptionCount: 2 };

    for (const record of [early, expired, revoked, exhausted]) {
      expect(() =>
        redeemTicketAccessCode(record, { grantId: 'grant', userId: 'guest', now: NOW }),
      ).toThrow(ConflictError);
    }
  });
});
