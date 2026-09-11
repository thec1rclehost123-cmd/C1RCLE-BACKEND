import { paginateQuery } from './pagination.js';

import type { PlatformUser } from '../../domain/models/platform-user.js';
import type {
  Page,
  PaginationQuery,
  UserAccountRepository,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_auth_users';

/**
 * Firestore adapter for `UserAccountRepository`. READ-ONLY — admin directory
 * views never mutate Better Auth accounts. Reads the Better Auth `user`
 * collection (configured in `apps/api-gateway/src/plugins/auth.ts`), mapping
 * its timestamp fields (Firestore Timestamps) to epoch ms for the wire.
 */
export class FirestoreUserAccountRepository implements UserAccountRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async listAll(query: PaginationQuery): Promise<Page<PlatformUser>> {
    return paginateQuery(this.collection, query, toPlatformUser);
  }
}

function toPlatformUser(data: DocumentData): PlatformUser {
  return {
    id: data.id as string,
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
