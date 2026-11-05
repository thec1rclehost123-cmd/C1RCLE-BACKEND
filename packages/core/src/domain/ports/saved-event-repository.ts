export interface SavedEventRepository {
  has(userId: string, eventId: string): Promise<boolean>;
  save(userId: string, eventId: string, savedAt: string): Promise<void>;
  remove(userId: string, eventId: string): Promise<void>;
  list(
    userId: string,
    cursor?: string,
  ): Promise<{ items: { eventId: string; savedAt: string }[]; nextCursor: string | null }>;
}
