import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  TicketTier,
  PromoCode,
  TablePackage,
  PromoterAssignment,
} from '../../domain/models/event-catalog.js';
import type {
  EventCatalogRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';

const TIERS = 'v2_event_catalog_tiers';
const PROMOS = 'v2_event_catalog_promos';
const TABLES = 'v2_event_catalog_tables';
const ASSIGNMENTS = 'v2_event_catalog_promoter_assignments';

/** Firestore adapter for `EventCatalogRepository` (B12) — tiers/promos/tables/promoter-assignments. */
export class FirestoreEventCatalogRepository implements EventCatalogRepository {
  constructor(private readonly db: Firestore) {}

  // ── Ticket tiers ──────────────────────────────────────────────────────────
  async getTierById(tierId: EntityId): Promise<TicketTier | null> {
    const snap = await this.db.collection(TIERS).doc(tierId).get();
    return snap.exists ? (snap.data() as unknown as TicketTier) : null;
  }
  async listTiers(eventId: EntityId): Promise<TicketTier[]> {
    const snap = await this.db.collection(TIERS).where('eventId', '==', eventId).get();
    return snap.docs.map((doc) => doc.data() as unknown as TicketTier);
  }
  async saveTier(tier: TicketTier, _tx?: TxContext | null): Promise<void> {
    await this.db
      .collection(TIERS)
      .doc(tier.id)
      .set({ ...tier });
  }

  // ── Promo codes ───────────────────────────────────────────────────────────
  async getPromoById(promoId: EntityId): Promise<PromoCode | null> {
    const snap = await this.db.collection(PROMOS).doc(promoId).get();
    return snap.exists ? (snap.data() as unknown as PromoCode) : null;
  }
  async getPromoByCode(code: string, eventId: EntityId | null): Promise<PromoCode | null> {
    const normalized = code.toUpperCase().trim();
    let ref: Query = this.db.collection(PROMOS).where('code', '==', normalized);
    if (eventId !== null) ref = ref.where('eventId', '==', eventId);
    const snap = await ref.limit(1).get();
    const doc = snap.docs[0];
    return doc ? (doc.data() as unknown as PromoCode) : null;
  }
  async listPromos(eventId: EntityId, query: PaginationQuery): Promise<Page<PromoCode>> {
    const base = this.db.collection(PROMOS).where('eventId', '==', eventId);
    return paginateQuery(base, query, (data: DocumentData) => data as unknown as PromoCode);
  }
  async savePromo(promo: PromoCode, _tx?: TxContext | null): Promise<void> {
    await this.db
      .collection(PROMOS)
      .doc(promo.id)
      .set({ ...promo });
  }

  // ── Table packages ────────────────────────────────────────────────────────
  async getTableById(tableId: EntityId): Promise<TablePackage | null> {
    const snap = await this.db.collection(TABLES).doc(tableId).get();
    return snap.exists ? (snap.data() as unknown as TablePackage) : null;
  }
  async listTables(eventId: EntityId): Promise<TablePackage[]> {
    const snap = await this.db.collection(TABLES).where('eventId', '==', eventId).get();
    return snap.docs.map((doc) => doc.data() as unknown as TablePackage);
  }
  async saveTable(table: TablePackage, _tx?: TxContext | null): Promise<void> {
    await this.db
      .collection(TABLES)
      .doc(table.id)
      .set({ ...table });
  }

  // ── Promoter assignments ──────────────────────────────────────────────────
  async getAssignmentById(assignmentId: EntityId): Promise<PromoterAssignment | null> {
    const snap = await this.db.collection(ASSIGNMENTS).doc(assignmentId).get();
    return snap.exists ? (snap.data() as unknown as PromoterAssignment) : null;
  }
  async listAssignments(eventId: EntityId): Promise<PromoterAssignment[]> {
    const snap = await this.db.collection(ASSIGNMENTS).where('eventId', '==', eventId).get();
    return snap.docs.map((doc) => doc.data() as unknown as PromoterAssignment);
  }
  async saveAssignment(assignment: PromoterAssignment, _tx?: TxContext | null): Promise<void> {
    await this.db
      .collection(ASSIGNMENTS)
      .doc(assignment.id)
      .set({ ...assignment });
  }
}
