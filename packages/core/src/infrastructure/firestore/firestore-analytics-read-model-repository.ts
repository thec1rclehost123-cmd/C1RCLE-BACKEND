import type { EntityId } from '../../domain/identity.js';
import type {
  AnalyticsReadModelRepository,
  EventAnalytics,
  OrganizationOverview,
} from '../../domain/ports/repositories.js';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_analytics_reads';

/**
 * Firestore adapter for `AnalyticsReadModelRepository` (B12). Routes only
 * read; the writes below are called by `AnalyticsService.project*` — reached
 * from the `event.*` projection consumer and the periodic refresh — never by a
 * request handler. Doc ids are prefixed per read-model kind so both share one
 * collection without colliding (`org_{organizationId}`, `event_{eventId}`).
 *
 * Writes are `set(..., { merge: true })`: the projection is a full recompute,
 * but an at-least-once redelivery must overwrite rather than fail, and merge
 * keeps a concurrently-added field from being clobbered.
 */
export class FirestoreAnalyticsReadModelRepository implements AnalyticsReadModelRepository {
  constructor(private readonly db: Firestore) {}

  async getOrganizationOverview(organizationId: EntityId): Promise<OrganizationOverview | null> {
    const snap = await this.db.collection(COLLECTION).doc(`org_${organizationId}`).get();
    return snap.exists ? (snap.data() as unknown as OrganizationOverview) : null;
  }

  async getEventAnalytics(eventId: EntityId): Promise<EventAnalytics | null> {
    const snap = await this.db.collection(COLLECTION).doc(`event_${eventId}`).get();
    return snap.exists ? (snap.data() as unknown as EventAnalytics) : null;
  }

  async saveOrganizationOverview(overview: OrganizationOverview): Promise<void> {
    await this.db
      .collection(COLLECTION)
      .doc(`org_${overview.organizationId}`)
      .set(overview, { merge: true });
  }

  async saveEventAnalytics(analytics: EventAnalytics): Promise<void> {
    await this.db
      .collection(COLLECTION)
      .doc(`event_${analytics.eventId}`)
      .set(analytics, { merge: true });
  }
}
