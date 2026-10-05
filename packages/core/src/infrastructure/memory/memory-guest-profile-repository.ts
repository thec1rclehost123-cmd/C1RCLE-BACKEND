import type { EntityId } from '../../domain/identity.js';
import type { GuestProfile } from '../../domain/models/guest-profile.js';
import type { GuestProfileRepository } from '../../domain/ports/repositories.js';

export class MemoryGuestProfileRepository implements GuestProfileRepository {
  entries = new Map<string, GuestProfile>();

  async getByUserId(userId: EntityId): Promise<GuestProfile | null> {
    return this.entries.get(userId) ?? null;
  }

  async save(profile: GuestProfile): Promise<void> {
    this.entries.set(profile.userId, profile);
  }
}
