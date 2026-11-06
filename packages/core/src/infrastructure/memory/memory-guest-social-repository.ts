import type { GuestSocialPrivacy } from '../../domain/models/guest-social.js';
import type { GuestSocialRepository } from '../../domain/ports/guest-social-repository.js';

export class MemoryGuestSocialRepository implements GuestSocialRepository {
  private privacy = new Map<string, GuestSocialPrivacy>();
  private enabled = new Set<string>();
  private hidden = new Map<string, Set<string>>();
  private blocks = new Map<string, Map<string, string>>();
  async getPrivacy(id: string) {
    const value = this.privacy.get(id);
    return value ? { ...value } : null;
  }
  async savePrivacy(id: string, value: GuestSocialPrivacy) {
    this.privacy.set(id, { ...value });
  }
  async eventEnabled(id: string) {
    return this.enabled.has(id);
  }
  async setEventEnabled(id: string, value: boolean) {
    if (value) this.enabled.add(id);
    else this.enabled.delete(id);
  }
  async eventHidden(id: string, eventId: string) {
    return this.hidden.get(id)?.has(eventId) ?? false;
  }
  async setEventHidden(id: string, eventId: string, value: boolean) {
    this.set(this.hidden, id, eventId, value);
  }
  async hiddenEvents(id: string) {
    return [...(this.hidden.get(id) ?? [])];
  }
  async blockedEitherWay(a: string, b: string) {
    return (this.blocks.get(a)?.has(b) ?? false) || (this.blocks.get(b)?.has(a) ?? false);
  }
  async setBlocked(a: string, b: string, value: boolean, displayName = 'Guest') {
    const entries = this.blocks.get(a) ?? new Map<string, string>();
    if (value) entries.set(b, displayName);
    else entries.delete(b);
    this.blocks.set(a, entries);
  }
  async blockedBy(id: string) {
    return [...(this.blocks.get(id) ?? new Map<string, string>())].map(
      ([targetId, displayName]) => ({ id: targetId, displayName }),
    );
  }
  private set(map: Map<string, Set<string>>, id: string, target: string, value: boolean) {
    const entries = map.get(id) ?? new Set<string>();
    if (value) entries.add(target);
    else entries.delete(target);
    map.set(id, entries);
  }
}
