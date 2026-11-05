import { createHash } from 'node:crypto';

import type { GuestSocialPrivacy } from '../../domain/models/guest-social.js';
import type { GuestSocialRepository } from '../../domain/ports/guest-social-repository.js';
import type { Firestore } from 'firebase-admin/firestore';

const key = (a: string, b: string) =>
  createHash('sha256')
    .update(JSON.stringify([a, b]))
    .digest('hex');
export class FirestoreGuestSocialRepository implements GuestSocialRepository {
  constructor(private db: Firestore) {}
  async getPrivacy(id: string): Promise<GuestSocialPrivacy | null> {
    const data = (await this.db.collection('v2_guest_social_privacy').doc(id).get()).data();
    return data
      ? {
          profileVisible: data.profileVisible === true,
          showOnGuestlists: data.showOnGuestlists === true,
          showUpcomingEvents: data.showUpcomingEvents === true,
        }
      : null;
  }
  async savePrivacy(id: string, value: GuestSocialPrivacy) {
    await this.db.collection('v2_guest_social_privacy').doc(id).set({
      profileVisible: value.profileVisible,
      showOnGuestlists: value.showOnGuestlists,
      showUpcomingEvents: value.showUpcomingEvents,
    });
  }
  async eventEnabled(id: string) {
    return (
      (await this.db.collection('v2_event_social_policy').doc(id).get()).data()?.enabled === true
    );
  }
  async setEventEnabled(id: string, enabled: boolean) {
    await this.db.collection('v2_event_social_policy').doc(id).set({ enabled });
  }
  async eventHidden(id: string, eventId: string) {
    return (await this.db.collection('v2_guest_social_hidden_events').doc(key(id, eventId)).get())
      .exists;
  }
  async setEventHidden(id: string, eventId: string, value: boolean) {
    const ref = this.db.collection('v2_guest_social_hidden_events').doc(key(id, eventId));
    if (value) await ref.set({ userId: id, eventId });
    else await ref.delete();
  }
  async hiddenEvents(id: string) {
    return (
      await this.db.collection('v2_guest_social_hidden_events').where('userId', '==', id).get()
    ).docs.map((doc) => String(doc.data().eventId));
  }
  async blockedEitherWay(a: string, b: string) {
    const records = await this.db.getAll(
      this.db.collection('v2_guest_social_blocks').doc(key(a, b)),
      this.db.collection('v2_guest_social_blocks').doc(key(b, a)),
    );
    return records.some((record) => record.exists);
  }
  async setBlocked(id: string, targetId: string, value: boolean, displayName = 'Guest') {
    const ref = this.db.collection('v2_guest_social_blocks').doc(key(id, targetId));
    if (value) await ref.set({ userId: id, targetId, displayName });
    else await ref.delete();
  }
  async blockedBy(id: string) {
    return (
      await this.db.collection('v2_guest_social_blocks').where('userId', '==', id).get()
    ).docs.map((doc) => ({
      id: String(doc.data().targetId),
      displayName:
        typeof doc.data().displayName === 'string' ? String(doc.data().displayName) : 'Guest',
    }));
  }
}
