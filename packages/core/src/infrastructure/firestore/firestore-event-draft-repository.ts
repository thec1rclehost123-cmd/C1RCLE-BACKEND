import type { EntityId } from '../../domain/identity.js';
import type { EventDraft } from '../../domain/models/event-draft.js';
import type { EventDraftRepository } from '../../domain/ports/repositories.js';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_event_drafts';
function documentId(userId: string, organizationId: string) {
  return `${encodeURIComponent(organizationId)}__${encodeURIComponent(userId)}`;
}

export class FirestoreEventDraftRepository implements EventDraftRepository {
  constructor(private readonly db: Firestore) {}

  async getForUserOrganization(userId: EntityId, organizationId: EntityId) {
    const snapshot = await this.db
      .collection(COLLECTION)
      .doc(documentId(userId, organizationId))
      .get();
    return (snapshot.data() as EventDraft | undefined) ?? null;
  }

  async save(draft: EventDraft) {
    await this.db
      .collection(COLLECTION)
      .doc(documentId(draft.userId, draft.organizationId))
      .set(draft);
  }

  async deleteForUserOrganization(userId: EntityId, organizationId: EntityId) {
    await this.db.collection(COLLECTION).doc(documentId(userId, organizationId)).delete();
  }
}
