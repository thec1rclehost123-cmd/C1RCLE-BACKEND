import { ForbiddenError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import { GUEST_INTERESTS } from '../../domain/models/guest-profile.js';
import { PRIVATE_GUEST_SOCIAL } from '../../domain/models/guest-social.js';
import { createSupportTicket } from '../../domain/models/support-ticket.js';

import { isEligibleSocialGuest } from './access-policy.js';

import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Event } from '../../domain/models/event.js';
import type {
  GuestSocialPrivacy,
  SocialGuestIdentity,
  SocialEventSummary,
} from '../../domain/models/guest-social.js';
import type { GuestSocialRepository } from '../../domain/ports/guest-social-repository.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

interface Dependencies {
  repositories: Pick<
    ServiceDeps['repositories'],
    | 'users'
    | 'userBans'
    | 'guestProfiles'
    | 'events'
    | 'entitlements'
    | 'organizations'
    | 'supportTickets'
  >;
  social: GuestSocialRepository;
  config: Pick<ServiceDeps['config'], 'clock' | 'ids'>;
}
const safeAvatar = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
const eventSummary = (event: Event): SocialEventSummary => ({
  id: event.id,
  slug: event.slug,
  title: event.title,
  startAt: event.startAt,
  imageUrl: event.imageUrl,
});

/** Live, read-only operational inputs; only consent/blocks/reports are written. */
export class GuestSocialService {
  constructor(private deps: Dependencies) {}
  private get repos() {
    return this.deps.repositories;
  }
  private async eligible(id: string) {
    const [user, profile, ban] = await Promise.all([
      this.repos.users.getById(id),
      this.repos.guestProfiles.getByUserId(id),
      this.repos.userBans.getByUserId(id),
    ]);
    return user && profile && !ban?.isBanned && isEligibleSocialGuest(user, profile)
      ? { user, profile }
      : null;
  }
  private async viewer(id: string) {
    const guest = await this.eligible(id);
    if (!guest)
      throw new ForbiddenError(
        'Verify your Guest account and complete onboarding to use social features.',
      );
    return guest;
  }
  private async privacy(id: string) {
    return (await this.deps.social.getPrivacy(id)) ?? { ...PRIVATE_GUEST_SOCIAL };
  }
  private publicEvent(event: Event) {
    return (
      event.isPublic &&
      (event.visibilityMode === undefined || event.visibilityMode === 'public') &&
      ['published', 'sales_paused', 'started'].includes(event.status)
    );
  }
  private guestlistEvent(event: Event) {
    const now = this.deps.config.clock.now().getTime();
    return (
      this.publicEvent(event) &&
      (event.status === 'started' || Date.parse(event.startAt) > now) &&
      (event.endAt === null || Date.parse(event.endAt) > now)
    );
  }
  private async event(id: string) {
    const event = (await this.repos.events.getById(id)) ?? (await this.repos.events.getBySlug(id));
    if (!event || !this.guestlistEvent(event)) throw new NotFoundError('Social event', id);
    return event;
  }
  private async collect<T>(read: (query: PaginationQuery) => Promise<Page<T>>): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (++pages > 20)
        throw new InvalidOperationError('This social list is temporarily unavailable.');
      const page = await read({ limit: 100, cursor });
      rows.push(...page.items);
      if (rows.length > 2000)
        throw new InvalidOperationError('This social list is temporarily unavailable.');
      if (page.nextCursor && page.nextCursor === cursor)
        throw new InvalidOperationError('This social list is temporarily unavailable.');
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }
  private async activeHolder(ticket: Entitlement) {
    if (ticket.status === 'void' || ticket.refundLock) return null;
    if (ticket.pendingTransferId) {
      const transfer = await this.repos.entitlements.getTicketTransfer(ticket.pendingTransferId);
      if (!transfer || transfer.status === 'frozen') return null;
    }
    return currentEntitlementHolderId(ticket);
  }
  private async identity(viewerId: string, targetId: string): Promise<SocialGuestIdentity | null> {
    if (await this.deps.social.blockedEitherWay(viewerId, targetId)) return null;
    const [target, privacy] = await Promise.all([this.eligible(targetId), this.privacy(targetId)]);
    if (!target || !privacy.profileVisible) return null;
    return {
      id: targetId,
      displayName: target.profile.displayName,
      avatarUrl: safeAvatar(target.user.image),
      interests: GUEST_INTERESTS.filter((value) => target.profile.tastes.includes(value)),
    };
  }
  async requireAccess(userId: string) {
    await this.viewer(userId);
  }
  async publicEventPolicy(eventId: string) {
    const event = await this.event(eventId);
    return { enabled: await this.deps.social.eventEnabled(event.id) };
  }
  async getPrivacy(userId: string) {
    await this.viewer(userId);
    const [privacy, blockedUsers, hiddenIds] = await Promise.all([
      this.privacy(userId),
      this.deps.social.blockedBy(userId),
      this.deps.social.hiddenEvents(userId),
    ]);
    const hiddenEvents = await Promise.all(
      hiddenIds.map(async (id) => {
        const event = await this.repos.events.getById(id);
        return { id, title: event && this.publicEvent(event) ? event.title : 'Hidden event' };
      }),
    );
    return { ...privacy, blockedUsers, hiddenEvents };
  }
  async savePrivacy(userId: string, privacy: GuestSocialPrivacy) {
    await this.viewer(userId);
    await this.deps.social.savePrivacy(userId, {
      profileVisible: privacy.profileVisible,
      showOnGuestlists: privacy.showOnGuestlists,
      showUpcomingEvents: privacy.showUpcomingEvents,
    });
    return this.getPrivacy(userId);
  }
  async getProfile(viewerId: string, targetId: string) {
    await this.viewer(viewerId);
    const identity = await this.identity(viewerId, targetId);
    if (!identity) throw new NotFoundError('Guest profile', targetId);
    const privacy = await this.privacy(targetId);
    const upcomingEvents: SocialEventSummary[] = [];
    if (privacy.showUpcomingEvents) {
      const tickets = await this.collect((query) =>
        this.repos.entitlements.listByHolder(targetId, query),
      );
      const ids = new Set<string>();
      for (const ticket of tickets)
        if ((await this.activeHolder(ticket)) === targetId) ids.add(ticket.eventId);
      for (const id of ids) {
        const event = await this.repos.events.getById(id);
        if (
          !event ||
          !this.publicEvent(event) ||
          Date.parse(event.startAt) <= this.deps.config.clock.now().getTime()
        )
          continue;
        if (
          !(await this.deps.social.eventEnabled(id)) ||
          (await this.deps.social.eventHidden(targetId, id))
        )
          continue;
        upcomingEvents.push(eventSummary(event));
      }
      upcomingEvents.sort((a, b) => a.startAt.localeCompare(b.startAt));
    }
    return { identity, upcomingEvents };
  }
  async guestlist(viewerId: string, id: string, offset = 0, limit = 20) {
    await this.viewer(viewerId);
    const event = await this.event(id);
    if (!(await this.deps.social.eventEnabled(event.id)))
      throw new NotFoundError('Social guestlist', id);
    const tickets = await this.collect((query) =>
      this.repos.entitlements.listByEvent(event.id, query),
    );
    const holders = await Promise.all(tickets.map((ticket) => this.activeHolder(ticket)));
    const holderIds = [
      ...new Set(holders.filter((value): value is string => value !== null)),
    ].sort();
    const visible: SocialGuestIdentity[] = [];
    for (const holder of holderIds) {
      const privacy = await this.privacy(holder);
      if (!privacy.showOnGuestlists || (await this.deps.social.eventHidden(holder, event.id)))
        continue;
      const identity = await this.identity(viewerId, holder);
      if (identity) visible.push(identity);
    }
    return {
      event: eventSummary(event),
      items: visible.slice(offset, offset + limit),
      visibleCount: visible.length,
      nextCursor: offset + limit < visible.length ? String(offset + limit) : null,
      hiddenForMe: await this.deps.social.eventHidden(viewerId, event.id),
    };
  }
  async hideEvent(userId: string, eventId: string, hidden: boolean) {
    await this.viewer(userId);
    // Permit removing a previously saved hide even after an event becomes unavailable.
    if (hidden) await this.event(eventId);
    await this.deps.social.setEventHidden(userId, eventId, hidden);
  }
  async block(userId: string, targetId: string, blocked: boolean) {
    await this.viewer(userId);
    if (userId === targetId) throw new InvalidOperationError('Choose another Guest.');
    if (blocked) {
      const target = await this.repos.users.getById(targetId);
      if (!target || target.role !== 'guest') throw new NotFoundError('Guest', targetId);
    }
    if (
      blocked &&
      (await this.deps.social.blockedBy(userId)).some((entry) => entry.id === targetId)
    )
      return;
    const visible = blocked ? await this.identity(userId, targetId) : null;
    await this.deps.social.setBlocked(userId, targetId, blocked, visible?.displayName ?? 'Guest');
  }
  async report(userId: string, targetId: string, category: string, reason: string) {
    await this.viewer(userId);
    if (userId === targetId) throw new InvalidOperationError('Choose another Guest.');
    const target = await this.repos.users.getById(targetId);
    if (!target || target.role !== 'guest') throw new NotFoundError('Guest', targetId);
    if (
      !['harassment', 'impersonation', 'safety', 'other'].includes(category) ||
      reason.trim().length < 10 ||
      reason.length > 2000
    )
      throw new InvalidOperationError(
        'Choose a report category and enter a reason between 10 and 2000 characters.',
      );
    const report = createSupportTicket({
      id: this.deps.config.ids(),
      subject: `Guest report: ${category}`,
      description: `Reported Guest: ${targetId}\nCategory: ${category}\n\n${reason}`,
      category: 'account',
      priority: 'medium',
      requester: { userId, email: null, organizationId: null },
      now: this.deps.config.clock.now(),
    });
    await this.repos.supportTickets.save({
      ...report,
      links: { ...report.links, userId: targetId },
    });
    return { reference: report.id };
  }
  private async managedOrganization(actor: ActorContext) {
    const org = await this.repos.organizations.getById(actor.organizationId);
    const membership = org?.members.find((member) => member.userId === actor.userId);
    if (
      !org ||
      org.status !== 'active' ||
      !membership ||
      !['owner', 'admin', 'manager'].includes(membership.role)
    )
      throw new ForbiddenError('Your organization cannot manage this social guestlist.');
    return org;
  }
  async managedEvents(actor: ActorContext) {
    const org = await this.managedOrganization(actor);
    const events = await this.collect((query) =>
      this.repos.events.listByOrganization(org.id, query),
    );
    return {
      items: await Promise.all(
        events.map(async (event) => ({
          id: event.id,
          title: event.title,
          enabled: await this.deps.social.eventEnabled(event.id),
        })),
      ),
    };
  }
  async setEventPolicy(actor: ActorContext, eventId: string, enabled: boolean) {
    const org = await this.managedOrganization(actor);
    const event = await this.repos.events.getById(eventId);
    if (!event || event.organizationId !== org.id) throw new NotFoundError('Event', eventId);
    await this.deps.social.setEventEnabled(eventId, enabled);
    return { enabled };
  }
}
