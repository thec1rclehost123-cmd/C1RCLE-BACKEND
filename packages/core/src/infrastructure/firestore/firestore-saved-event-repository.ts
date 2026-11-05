import type { SavedEventRepository } from '../../domain/ports/saved-event-repository.js';
import type { Firestore } from 'firebase-admin/firestore';

export class FirestoreSavedEventRepository implements SavedEventRepository {
  constructor(private db: Firestore) {}
  private events(userId: string) {
    return this.db.collection('v2_guest_saved_events').doc(userId).collection('events');
  }
  async has(userId: string, eventId: string) {
    return (await this.events(userId).doc(eventId).get()).exists;
  }
  async save(userId: string, eventId: string, savedAt: string) {
    const ref = this.events(userId).doc(eventId);
    await this.db.runTransaction(async (tx) => {
      if (!(await tx.get(ref)).exists) tx.create(ref, { savedAt });
    });
  }
  async remove(userId: string, eventId: string) {
    await this.events(userId).doc(eventId).delete();
  }
  async list(userId: string, cursor?: string) {
    let query = this.events(userId).orderBy('__name__').limit(21);
    if (cursor) query = query.startAfter(cursor);
    const docs = (await query.get()).docs;
    return {
      items: docs
        .slice(0, 20)
        .map((doc) => ({ eventId: doc.id, savedAt: String(doc.data().savedAt) })),
      nextCursor: docs.length > 20 ? (docs[19]?.id ?? null) : null,
    };
  }
}
