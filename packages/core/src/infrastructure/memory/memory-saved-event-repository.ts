import type { SavedEventRepository } from '../../domain/ports/saved-event-repository.js';

export class MemorySavedEventRepository implements SavedEventRepository {
  private users = new Map<string, Map<string, string>>();
  async has(userId: string, eventId: string) {
    return this.users.get(userId)?.has(eventId) ?? false;
  }
  async save(userId: string, eventId: string, savedAt: string) {
    const rows = this.users.get(userId) ?? new Map<string, string>();
    if (!rows.has(eventId)) rows.set(eventId, savedAt);
    this.users.set(userId, rows);
  }
  async remove(userId: string, eventId: string) {
    this.users.get(userId)?.delete(eventId);
  }
  async list(userId: string, cursor?: string) {
    const rows = [...(this.users.get(userId) ?? [])]
      .filter(([id]) => !cursor || id > cursor)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 21);
    return {
      items: rows.slice(0, 20).map(([eventId, savedAt]) => ({ eventId, savedAt })),
      nextCursor: rows.length > 20 ? (rows[19]?.[0] ?? null) : null,
    };
  }
}
