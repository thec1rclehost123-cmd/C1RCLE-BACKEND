import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Platform user ban (Phase 7 trust & safety) ──────────────────────────────
 *
 * A separate aggregate rather than a field on `PlatformUser`, because
 * `UserAccountRepository` is deliberately READ-ONLY — admin routes never
 * mutate the Better Auth `v2_auth_users` collection directly (see
 * `platform-user.ts`'s doc comment). Ban state lives in its own collection
 * and is joined onto the directory read at query time.
 *
 * One record per user, upserted in place (not an append-only log): v1 wrote
 * `isBanned`/`bannedAt`/`banReason` straight onto the user doc and nulled
 * the timestamp/reason on unban (`adminStore.js:527-551`) — same shape here,
 * just in our own collection.
 */
export interface UserBan extends VersionedEntity {
  /** Keyed by the user id — one ban record per user. */
  id: EntityId;
  userId: EntityId;
  isBanned: boolean;
  bannedAt: string | null;
  bannedBy: EntityId | null;
  banReason: string | null;
}

export interface BanUserInput {
  bannedBy: EntityId;
  reason?: string;
  now?: Date;
}

/**
 * Bans a user. `existing` is `null` the first time anyone is banned — a ban
 * record is created lazily rather than provisioned for every user up front.
 * No-op if already banned (idempotent on repeat).
 */
export function banUser(existing: UserBan | null, userId: EntityId, input: BanUserInput): UserBan {
  if (existing?.isBanned) return existing;
  const now = input.now ?? new Date();
  const reason = input.reason?.trim() ?? null;
  if (!existing) {
    return {
      id: userId,
      userId,
      isBanned: true,
      bannedAt: now.toISOString(),
      bannedBy: input.bannedBy,
      banReason: reason && reason.length > 0 ? reason : null,
      ...newVersionedEntity(now),
    };
  }
  return {
    ...bumpVersion(existing, now),
    isBanned: true,
    bannedAt: now.toISOString(),
    bannedBy: input.bannedBy,
    banReason: reason && reason.length > 0 ? reason : null,
  };
}

/** Unbans a user. No-op if not currently banned. */
export function unbanUser(existing: UserBan, now?: Date): UserBan {
  if (!existing.isBanned) return existing;
  return {
    ...bumpVersion(existing, now ?? new Date()),
    isBanned: false,
    bannedAt: null,
    bannedBy: null,
    banReason: null,
  };
}
