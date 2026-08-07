/**
 * ─── Shared domain identity + versioning ──────────────────────────────────────
 * Every mutable aggregate carries `version` + `updatedAt` for optimistic
 * locking. `version` starts at 1 and increments on each commit.
 */

/** Opaque, immutable aggregate/entity id. */
export type EntityId = string;

/** Version marker present on every mutable entity. */
export interface VersionedEntity {
  /** Optimistic-lock version; increments on every write. */
  version: number;
  updatedAt: string;
  createdAt: string;
}

/** Creates the base versioning fields for a new entity. */
export function newVersionedEntity(
  now: Date,
): Pick<VersionedEntity, 'version' | 'updatedAt' | 'createdAt'> {
  const ts = now.toISOString();
  return { version: 1, updatedAt: ts, createdAt: ts };
}

/** Bumps `version` and `updatedAt` on a versioned entity. */
export function bumpVersion<T extends VersionedEntity>(entity: T, now: Date): T {
  return { ...entity, version: entity.version + 1, updatedAt: now.toISOString() };
}
