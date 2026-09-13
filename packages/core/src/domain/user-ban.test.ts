import { describe, expect, it } from 'vitest';

import { banUser, unbanUser } from './models/user-ban.js';

const NOW = new Date('2026-09-13T00:00:00.000Z');

describe('banUser', () => {
  it('creates a new ban record when none exists', () => {
    const ban = banUser(null, 'user_1', { bannedBy: 'admin_a', reason: 'Abuse report', now: NOW });
    expect(ban).toMatchObject({
      id: 'user_1',
      userId: 'user_1',
      isBanned: true,
      bannedBy: 'admin_a',
      banReason: 'Abuse report',
    });
    expect(ban.bannedAt).toBe(NOW.toISOString());
  });

  it('re-banning an already-banned user is a no-op', () => {
    const first = banUser(null, 'user_1', { bannedBy: 'admin_a', now: NOW });
    const second = banUser(first, 'user_1', { bannedBy: 'admin_b', now: NOW });
    expect(second).toBe(first);
  });

  it('re-bans a previously-unbanned user, bumping the version', () => {
    const banned = banUser(null, 'user_1', { bannedBy: 'admin_a', now: NOW });
    const unbanned = unbanUser(banned, NOW);
    const rebanned = banUser(unbanned, 'user_1', {
      bannedBy: 'admin_b',
      reason: 'Repeat offense',
      now: NOW,
    });
    expect(rebanned.isBanned).toBe(true);
    expect(rebanned.bannedBy).toBe('admin_b');
    expect(rebanned.banReason).toBe('Repeat offense');
    expect(rebanned.version).toBe(unbanned.version + 1);
  });

  it('an empty reason is stored as null, not an empty string', () => {
    const ban = banUser(null, 'user_1', { bannedBy: 'admin_a', reason: '   ', now: NOW });
    expect(ban.banReason).toBeNull();
  });
});

describe('unbanUser', () => {
  it('nulls bannedAt/bannedBy/banReason on unban', () => {
    const banned = banUser(null, 'user_1', {
      bannedBy: 'admin_a',
      reason: 'Abuse report',
      now: NOW,
    });
    const unbanned = unbanUser(banned, NOW);
    expect(unbanned.isBanned).toBe(false);
    expect(unbanned.bannedAt).toBeNull();
    expect(unbanned.bannedBy).toBeNull();
    expect(unbanned.banReason).toBeNull();
    expect(unbanned.version).toBe(banned.version + 1);
  });

  it('unbanning an already-not-banned record is a no-op', () => {
    const banned = banUser(null, 'user_1', { bannedBy: 'admin_a', now: NOW });
    const unbanned = unbanUser(banned, NOW);
    const again = unbanUser(unbanned, NOW);
    expect(again).toBe(unbanned);
  });
});
