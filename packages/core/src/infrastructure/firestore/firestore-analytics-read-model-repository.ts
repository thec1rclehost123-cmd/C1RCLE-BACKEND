import type { EntityId } from '../../domain/identity.js';
import type {
  AnalyticsReadModelRepository,
  EventAnalytics,
  OrganizationOverview,
} from '../../domain/ports/repositories.js';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_analytics_reads';

/**
 * Firestore adapter for `AnalyticsReadModelRepository` (B12). Read-only from
 * routes/services — rows are written by projections/workers (Phase 1+), not
 * by this adapter. Doc ids are prefixed per read-model kind so both share one
 * collection without colliding (`org_{organizationId}`, `event_{eventId}`).
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
}
