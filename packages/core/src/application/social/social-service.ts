import { NotFoundError } from '../../domain/errors.js';
import { createFollow, followId } from '../../domain/models/social.js';
import { emit } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Follow, FollowTargetType, Notification } from '../../domain/models/social.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Phase 8 social service ─────────────────────────────────────────────────
 * Session-scoped like `GuestProfileService`: a guest belongs to no org, so
 * ownership is the session user id and there is no `requireOrgAccess` gate.
 *
 * Pub/sub posture: this service is a PUBLISHER only. A follow/unfollow that
 * actually changes the graph appends `follow.created` / `follow.removed` to
 * the outbox; it never writes a notification. Notifications are produced by
 * bus subscribers (`notification-consumers.ts`) reacting to domain events,
 * so the publishing request does not grow with the fan-out and new
 * reactions (push, email, counters) plug in as subscribers, not edits here.
 */
export interface FollowStatus {
  following: boolean;
  followerCount: number;
}

export class SocialService {
  constructor(private readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repositories;
  }

  /** Idempotent: re-following returns the existing edge with `created: false`. */
  async follow(
    actor: ActorContext,
    targetType: FollowTargetType,
    targetId: EntityId,
  ): Promise<{ follow: Follow; created: boolean }> {
    await this.assertTargetExists(targetType, targetId);
    const existing = await this.repos.follows.get(followId(actor.userId, targetType, targetId));
    if (existing) return { follow: existing, created: false };

    const follow = createFollow({
      followerId: actor.userId,
      targetType,
      targetId,
      now: this.deps.config.clock.now(),
    });
    await this.repos.follows.save(follow);
    await emit(this.deps, actor, follow.id, 'follow.created', {
      followerId: follow.followerId,
      targetType,
      targetId,
    });
    return { follow, created: true };
  }

  /** Idempotent: unfollowing a non-edge is a no-op and emits nothing. */
  async unfollow(
    actor: ActorContext,
    targetType: FollowTargetType,
    targetId: EntityId,
  ): Promise<void> {
    const id = followId(actor.userId, targetType, targetId);
    const removed = await this.repos.follows.delete(id);
    if (!removed) return;
    await emit(this.deps, actor, id, 'follow.removed', {
      followerId: actor.userId,
      targetType,
      targetId,
    });
  }

  listMyFollows(
    userId: EntityId,
    query: PaginationQuery & { targetType?: FollowTargetType },
  ): Promise<Page<Follow>> {
    return this.repos.follows.listByFollower(userId, query);
  }

  async followStatus(
    userId: EntityId,
    targetType: FollowTargetType,
    targetId: EntityId,
  ): Promise<FollowStatus> {
    const [edge, followerCount] = await Promise.all([
      this.repos.follows.get(followId(userId, targetType, targetId)),
      this.repos.follows.countFollowers(targetType, targetId),
    ]);
    return { following: edge !== null, followerCount };
  }

  listNotifications(
    userId: EntityId,
    query: PaginationQuery & { unreadOnly?: boolean },
  ): Promise<Page<Notification>> {
    return this.repos.socialNotifications.listForUser(userId, query);
  }

  unreadCount(userId: EntityId): Promise<number> {
    return this.repos.socialNotifications.countUnread(userId);
  }

  markRead(userId: EntityId, ids: EntityId[]): Promise<number> {
    return this.repos.socialNotifications.markRead(userId, ids, this.nowIso());
  }

  markAllRead(userId: EntityId): Promise<number> {
    return this.repos.socialNotifications.markAllRead(userId, this.nowIso());
  }

  private nowIso(): string {
    return this.deps.config.clock.now().toISOString();
  }

  private async assertTargetExists(targetType: FollowTargetType, targetId: EntityId) {
    const found =
      targetType === 'venue'
        ? await this.repos.venues.getById(targetId)
        : await this.repos.organizations.getById(targetId);
    if (!found) throw new NotFoundError(targetType === 'venue' ? 'Venue' : 'Host', targetId);
  }
}
