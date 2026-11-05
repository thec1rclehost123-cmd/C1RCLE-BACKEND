import { ForbiddenError, EventNotFoundError } from '../../domain/errors.js';
import { isGuestOnboardingComplete } from '../../domain/models/guest-profile.js';

import type { Event } from '../../domain/models/event.js';
import type { SavedEventRepository } from '../../domain/ports/saved-event-repository.js';
import type { ServiceDeps } from '../context.js';

interface Dependencies {
  repositories: Pick<ServiceDeps['repositories'], 'users' | 'guestProfiles' | 'userBans'>;
  saved: SavedEventRepository;
  readEvent: (eventId: string) => Promise<{ event: Event }>;
  now: () => Date;
}
/** Private bookmarks only. Never writes an event, admission, order or social record. */
export class SavedEventService {
  constructor(private deps: Dependencies) {}
  private async requireGuest(id: string) {
    const [user, profile, ban] = await Promise.all([
      this.deps.repositories.users.getById(id),
      this.deps.repositories.guestProfiles.getByUserId(id),
      this.deps.repositories.userBans.getByUserId(id),
    ]);
    if (
      !user ||
      user.role !== 'guest' ||
      !user.emailVerified ||
      profile?.userId !== id ||
      !isGuestOnboardingComplete(profile) ||
      ban?.isBanned
    )
      throw new ForbiddenError('Verify your Guest account and complete onboarding to save events.');
  }
  async state(userId: string, eventId: string) {
    await this.requireGuest(userId);
    return { saved: await this.deps.saved.has(userId, eventId) };
  }
  async set(userId: string, eventId: string, saved: boolean) {
    await this.requireGuest(userId);
    if (saved) {
      const { event } = await this.deps.readEvent(eventId);
      if (event.id !== eventId) throw new EventNotFoundError(eventId);
      await this.deps.saved.save(userId, event.id, this.deps.now().toISOString());
    } else await this.deps.saved.remove(userId, eventId);
    return this.state(userId, eventId);
  }
  async list(userId: string, cursor?: string) {
    await this.requireGuest(userId);
    const page = await this.deps.saved.list(userId, cursor);
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (item) => {
          try {
            const { event } = await this.deps.readEvent(item.eventId);
            return {
              ...item,
              event: {
                id: event.id,
                slug: event.slug,
                title: event.title,
                startAt: event.startAt,
                status: event.status,
                imageUrl: event.imageUrl,
              },
            };
          } catch (error) {
            if (!(error instanceof EventNotFoundError)) throw error;
            return { ...item, event: null };
          }
        }),
      ),
    };
  }
}
