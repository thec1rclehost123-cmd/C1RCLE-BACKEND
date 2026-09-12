import type { PlatformUser } from '../../domain/models/platform-user.js';
import type {
  Page,
  PaginationQuery,
  UserAccountRepository,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';

const COLLECTION = 'v2_auth_users';

/**
 * Firestore adapter for `UserAccountRepository`. READ-ONLY — admin directory
 * views never mutate Better Auth accounts. Reads the Better Auth `user`
 * collection (configured in `apps/api-gateway/src/plugins/auth.ts`), mapping
 * its timestamp fields (Firestore Timestamps) to epoch ms for the wire.
 *
 * Does NOT use the shared `paginateQuery` helper: that helper maps from
 * `doc.data()` alone, but Better Auth's own Firestore adapter never writes
 * an `id` field into the document body — only the collection structure's
 * own doc id carries it. Every other repository in this codebase stores its
 * own `id` field at write time (`toDoc()` always includes it), so that gap
 * never showed up until this, the first read-only adapter over data this
 * codebase doesn't write itself.
 */
export class FirestoreUserAccountRepository implements UserAccountRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async listAll(query: PaginationQuery): Promise<Page<PlatformUser>> {
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const base = this.collection;
    const [countSnap, pageSnap] = await Promise.all([
      base.count().get(),
      base.offset(start).limit(limit).get(),
    ]);
    const total = countSnap.data().count;
    const items = pageSnap.docs.map((doc: QueryDocumentSnapshot) => toPlatformUser(doc));
    const nextCursor = start + items.length < total ? String(start + items.length) : null;
    return { items, total, nextCursor };
  }
}

function toPlatformUser(doc: QueryDocumentSnapshot): PlatformUser {
  const data: DocumentData = doc.data();
  return {
    id: doc.id,
    email: data.email as string,
    name: (data.name as string | null) ?? '',
    image: (data.image as string | null) ?? null,
    emailVerified: (data.emailVerified as boolean | null) ?? false,
    role: (data.role as string | null) ?? null,
    createdAt: toEpochMs(data.createdAt),
    updatedAt: toEpochMs(data.updatedAt),
  };
}

/** Better Auth stores Date objects → Firestore Timestamps on read. Normalizes. */
function toEpochMs(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  const parsed = new Date(value as string).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}
