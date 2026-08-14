import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import {
  acceptInvitation,
  createInvitation,
  createOrganization,
  effectiveInvitationStatus,
  isInvitationExpired,
  normalizeEmail,
  revokeInvitation,
} from './models/organization.js';

/**
 * ─── Organization invitations ────────────────────────────────────────────────
 * The state between "invited" and "joined" — the concept Phase 0 lacked, which
 * is why `GET /invitations` could not be built without faking an empty list.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');
const org = () =>
  createOrganization({
    id: 'org_1',
    name: 'Skyline',
    slug: 'skyline',
    ownerId: 'user_owner',
    now: NOW,
  });

const invite = (overrides: Partial<Parameters<typeof createInvitation>[0]> = {}) =>
  createInvitation({
    id: 'inv_1',
    organizationId: 'org_1',
    email: 'new@example.com',
    role: 'manager',
    invitedBy: 'user_owner',
    now: NOW,
    ...overrides,
  });

describe('creating an invitation', () => {
  it('starts pending with an expiry ahead of now', () => {
    const invitation = invite();
    expect(invitation.status).toBe('pending');
    expect(invitation.version).toBe(1);
    expect(Date.parse(invitation.expiresAt)).toBeGreaterThan(NOW.getTime());
    expect(invitation.acceptedAt).toBeNull();
  });

  it('normalizes the email so casing cannot create a duplicate identity', () => {
    expect(invite({ email: '  New@Example.COM ' }).email).toBe('new@example.com');
    expect(normalizeEmail(' A@B.com ')).toBe('a@b.com');
  });

  it('refuses to invite an owner — ownership is transferred, never offered', () => {
    expect(() => invite({ role: 'owner' })).toThrow(InvalidOperationError);
  });

  it('refuses a malformed address', () => {
    expect(() => invite({ email: 'not-an-email' })).toThrow(InvalidOperationError);
  });
});

describe('expiry', () => {
  it('reads as expired once the window passes, without any sweeper running', () => {
    const invitation = invite({ ttlDays: 1 });
    const later = new Date(NOW.getTime() + 2 * 86_400_000);

    // The stored status is still `pending` — time alone decides.
    expect(invitation.status).toBe('pending');
    expect(isInvitationExpired(invitation, later)).toBe(true);
    expect(effectiveInvitationStatus(invitation, later)).toBe('expired');
  });

  it('refuses acceptance after expiry', () => {
    const invitation = invite({ ttlDays: 1 });
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(() => acceptInvitation(org(), invitation, 'user_2', later)).toThrow(
      InvalidOperationError,
    );
  });
});

describe('accepting', () => {
  it('adds the member and closes the invitation together', () => {
    const result = acceptInvitation(org(), invite(), 'user_2', NOW);

    expect(result.invitation.status).toBe('accepted');
    expect(result.invitation.acceptedBy).toBe('user_2');
    expect(result.organization.members).toHaveLength(2);
    expect(result.organization.members[1]).toMatchObject({
      userId: 'user_2',
      role: 'manager',
      invitedBy: 'user_owner',
    });
  });

  it('cannot be accepted twice — the second grant would be a duplicate member', () => {
    const first = acceptInvitation(org(), invite(), 'user_2', NOW);
    expect(() => acceptInvitation(first.organization, first.invitation, 'user_3', NOW)).toThrow(
      InvalidOperationError,
    );
  });

  it('refuses an invitation belonging to another organization', () => {
    const foreign = invite({ organizationId: 'org_other' });
    expect(() => acceptInvitation(org(), foreign, 'user_2', NOW)).toThrow(InvalidOperationError);
  });
});

describe('revoking', () => {
  it('withdraws a pending invitation and bumps the version', () => {
    const revoked = revokeInvitation(invite(), NOW);
    expect(revoked.status).toBe('revoked');
    expect(revoked.version).toBe(2);
  });

  it('is idempotent', () => {
    const revoked = revokeInvitation(invite(), NOW);
    expect(revokeInvitation(revoked, NOW)).toBe(revoked);
  });

  it('cannot revoke what was already accepted', () => {
    const accepted = acceptInvitation(org(), invite(), 'user_2', NOW).invitation;
    expect(() => revokeInvitation(accepted, NOW)).toThrow(InvalidOperationError);
  });
});
