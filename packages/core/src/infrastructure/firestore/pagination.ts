/**
 * ─── Shared Firestore pagination helpers ───────────────────────────────────
 * `Cursor` stays an opaque string at the port boundary (T07), but its actual
 * encoding here is a stringified offset — mirrors the memory adapter's
 * scheme exactly (`infrastructure/memory/memory-repositories.ts`) so
 * behavior is identical across both adapters (parity-friendly, B13).
 * A true keyset (`startAfter`) scheme is a possible future optimization at
 * larger data volumes; not needed for this slice.
 */
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { DocumentData, Query } from 'firebase-admin/firestore';

/** In-memory slice for embedded-array fields (e.g. organization members). */
export function sliceArray<TItem>(all: TItem[], query: PaginationQuery): Page<TItem> {
  const limit = Math.min(Math.max(query.limit, 1), 100);
  const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + limit);
  const nextCursor = start + limit < all.length ? String(start + limit) : null;
  return { items, total: all.length, nextCursor };
}

/** Offset-based pagination over a Firestore query, plus a server-side count. */
export async function paginateQuery<TItem>(
  base: Query,
  query: PaginationQuery,
  map: (data: DocumentData) => TItem,
): Promise<Page<TItem>> {
  const limit = Math.min(Math.max(query.limit, 1), 100);
  const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const [countSnap, pageSnap] = await Promise.all([
    base.count().get(),
    base.offset(start).limit(limit).get(),
  ]);
  const total = countSnap.data().count;
  const items = pageSnap.docs.map((doc) => map(doc.data()));
  const nextCursor = start + items.length < total ? String(start + items.length) : null;
  return { items, total, nextCursor };
}
