import { DatabaseSync } from 'node:sqlite';

import type { DomainEvent } from '../../domain/events/domain-events.js';
import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { Organization, OrganizationMember } from '../../domain/models/organization.js';
import type { Venue } from '../../domain/models/venue.js';
import type {
  AuditRecord,
  AuditRepository,
  OutboxReader,
  OutboxRecord,
  OutboxWriter,
  UnitOfWork,
} from '../../domain/ports/outbox.js';
import type {
  EventRepository,
  OrganizationRepository,
  Page,
  PaginationQuery,
  TxContext,
  VenueRepository,
} from '../../domain/ports/repositories.js';

/**
 * ─── SQLite adapters (B12 / T18) ─────────────────────────────────────────────
 *
 * The first DURABLE implementation of the repository ports. It uses Node's
 * built-in `node:sqlite`, so durability arrives with no new dependency and the
 * contract suite can run it in CI exactly as it runs the memory adapter.
 *
 * Why this and not Firestore first (D-002): a Firestore adapter cannot be
 * verified without project credentials or an emulator, and shipping storage
 * code no test has ever executed is worse than shipping none. The ports are
 * unchanged, so Firestore/Postgres slot in behind the same contract suite when
 * their infrastructure exists — see D-010.
 *
 * Aggregates are stored as JSON documents with their identifying and queried
 * fields lifted into real columns. That keeps the domain model authoritative
 * (no ORM mapping to drift) while letting SQLite do the filtering and paging.
 */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS organizations (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL,
    status      TEXT NOT NULL,
    version     INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    document    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS organization_members (
    organization_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    joined_at       TEXT NOT NULL,
    PRIMARY KEY (organization_id, user_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS venues (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    slug            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    document        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS venues_by_org ON venues (organization_id, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS venues_slug_per_org ON venues (organization_id, slug);

  CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    venue_id        TEXT,
    is_public       INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    document        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_org ON events (organization_id, created_at, id);
  CREATE INDEX IF NOT EXISTS events_by_venue ON events (venue_id, created_at, id);
  CREATE INDEX IF NOT EXISTS events_public ON events (is_public, created_at, id);

  CREATE TABLE IF NOT EXISTS outbox (
    id            TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    attempts      INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    processed_at  TEXT,
    last_error    TEXT,
    event         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, created_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    id              TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    recorded_at     TEXT NOT NULL,
    document        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_by_org ON audit_events (organization_id, recorded_at);
`;

export function createSqliteDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location);
  db.exec(SCHEMA);
  return db;
}

/**
 * Keyset pagination. The cursor is an opaque encoding of the last row's
 * `(created_at, id)` — never an offset, so pages stay correct and cheap as
 * rows are inserted underneath a paging client.
 */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator === -1) return null;
  return { createdAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}

interface DocumentRow {
  id: string;
  created_at: string;
  document: string;
}

/** Slices a keyset page: fetch one extra row to know whether more exist. */
function toPage<T>(rows: DocumentRow[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map((row) => JSON.parse(row.document) as T),
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export class SqliteOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: DatabaseSync) {}

  async getById(organizationId: EntityId): Promise<Organization | null> {
    const row = this.db
      .prepare('SELECT document FROM organizations WHERE id = ?')
      .get(organizationId) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as Organization) : null;
  }

  async listForMember(userId: EntityId, query: PaginationQuery): Promise<Page<Organization>> {
    const after = decodeCursor(query.cursor);
    const rows = this.db
      .prepare(
        `SELECT o.id, o.created_at, o.document
           FROM organizations o
           JOIN organization_members m ON m.organization_id = o.id
          WHERE m.user_id = ?
            AND (? IS NULL OR (o.created_at, o.id) > (?, ?))
          ORDER BY o.created_at, o.id
          LIMIT ?`,
      )
      .all(
        userId,
        after ? 1 : null,
        after?.createdAt ?? '',
        after?.id ?? '',
        query.limit + 1,
      ) as unknown as DocumentRow[];
    return toPage<Organization>(rows, query.limit);
  }

  async listMembers(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<OrganizationMember>> {
    const org = await this.getById(organizationId);
    if (!org) return { items: [], nextCursor: null };
    // Members are part of the aggregate, so they are paged in memory rather
    // than re-read from the join table (which exists only for the lookup).
    const items = org.members.slice(0, query.limit);
    return { items, nextCursor: org.members.length > query.limit ? 'more' : null };
  }

  async getMember(organizationId: EntityId, userId: EntityId): Promise<OrganizationMember | null> {
    const org = await this.getById(organizationId);
    return org?.members.find((member) => member.userId === userId) ?? null;
  }

  async save(org: Organization, _tx?: TxContext | null): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO organizations (id, slug, status, version, created_at, document)
              VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
              slug = excluded.slug,
              status = excluded.status,
              version = excluded.version,
              document = excluded.document`,
      )
      .run(org.id, org.slug, org.status, org.version, org.createdAt, JSON.stringify(org));

    // Membership index: rewritten with the aggregate so it can never drift.
    this.db.prepare('DELETE FROM organization_members WHERE organization_id = ?').run(org.id);
    const insert = this.db.prepare(
      'INSERT INTO organization_members (organization_id, user_id, joined_at) VALUES (?, ?, ?)',
    );
    for (const member of org.members) insert.run(org.id, member.userId, member.joinedAt);
  }

  async delete(organizationId: EntityId, _tx?: TxContext | null): Promise<void> {
    this.db.prepare('DELETE FROM organizations WHERE id = ?').run(organizationId);
  }
}

export class SqliteVenueRepository implements VenueRepository {
  constructor(private readonly db: DatabaseSync) {}

  async getById(venueId: EntityId): Promise<Venue | null> {
    const row = this.db.prepare('SELECT document FROM venues WHERE id = ?').get(venueId) as
      { document: string } | undefined;
    return row ? (JSON.parse(row.document) as Venue) : null;
  }

  async getBySlug(slug: string, organizationId: EntityId): Promise<Venue | null> {
    const row = this.db
      .prepare('SELECT document FROM venues WHERE slug = ? AND organization_id = ?')
      .get(slug, organizationId) as { document: string } | undefined;
    return row ? (JSON.parse(row.document) as Venue) : null;
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Venue>> {
    const after = decodeCursor(query.cursor);
    const rows = this.db
      .prepare(
        `SELECT id, created_at, document FROM venues
          WHERE organization_id = ?
            AND (? IS NULL OR (created_at, id) > (?, ?))
          ORDER BY created_at, id
          LIMIT ?`,
      )
      .all(
        organizationId,
        after ? 1 : null,
        after?.createdAt ?? '',
        after?.id ?? '',
        query.limit + 1,
      ) as unknown as DocumentRow[];
    return toPage<Venue>(rows, query.limit);
  }

  async save(venue: Venue, _tx?: TxContext | null): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO venues (id, organization_id, slug, created_at, document)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
              organization_id = excluded.organization_id,
              slug = excluded.slug,
              document = excluded.document`,
      )
      .run(
        venue.id,
        venue.organizationId,
        venue.public.slug,
        venue.createdAt,
        JSON.stringify(venue),
      );
  }
}

export class SqliteEventRepository implements EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  async getById(eventId: EntityId): Promise<Event | null> {
    const row = this.db.prepare('SELECT document FROM events WHERE id = ?').get(eventId) as
      { document: string } | undefined;
    return row ? (JSON.parse(row.document) as Event) : null;
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    return this.#list('organization_id = ?', [organizationId], query);
  }

  async listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    return this.#list('venue_id = ?', [venueId], query);
  }

  async listPublic(query: PaginationQuery): Promise<Page<Event>> {
    return this.#list('is_public = 1', [], query);
  }

  async save(event: Event, _tx?: TxContext | null): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO events (id, organization_id, venue_id, is_public, created_at, document)
              VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
              organization_id = excluded.organization_id,
              venue_id = excluded.venue_id,
              is_public = excluded.is_public,
              document = excluded.document`,
      )
      .run(
        event.id,
        event.organizationId,
        event.venueId,
        event.isPublic ? 1 : 0,
        event.createdAt,
        JSON.stringify(event),
      );
  }

  async delete(eventId: EntityId, _tx?: TxContext | null): Promise<void> {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
  }

  #list(where: string, params: string[], query: PaginationQuery): Page<Event> {
    const after = decodeCursor(query.cursor);
    const rows = this.db
      .prepare(
        `SELECT id, created_at, document FROM events
          WHERE ${where}
            AND (? IS NULL OR (created_at, id) > (?, ?))
          ORDER BY created_at, id
          LIMIT ?`,
      )
      .all(
        ...params,
        after ? 1 : null,
        after?.createdAt ?? '',
        after?.id ?? '',
        query.limit + 1,
      ) as unknown as DocumentRow[];
    return toPage<Event>(rows, query.limit);
  }
}

/**
 * Outbox + unit of work on one connection.
 *
 * `runInTransaction` wraps the callback in a real SQLite transaction, so the
 * business write and its outbox row commit or roll back together — the
 * guarantee the memory adapter can only approximate.
 */
export class SqliteOutbox implements OutboxWriter, OutboxReader, UnitOfWork {
  #depth = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runInTransaction<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    // Nested scopes join the outer transaction rather than starting a second.
    if (this.#depth > 0) return work({ kind: 'tx', id: `nested_${this.#depth}` });

    this.db.exec('BEGIN');
    this.#depth++;
    try {
      const result = await work({ kind: 'tx', id: 'sqlite' });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#depth--;
    }
  }

  async append(event: DomainEvent, _tx?: TxContext | null): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO outbox (id, status, attempts, created_at, processed_at, last_error, event)
              VALUES (?, 'pending', 0, ?, NULL, NULL, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(event.id, this.now().toISOString(), JSON.stringify(event));
  }

  async listPending(limit: number): Promise<OutboxRecord[]> {
    return this.#byStatus('pending', limit);
  }

  async markProcessed(recordId: EntityId, now: Date): Promise<void> {
    this.db
      .prepare(
        `UPDATE outbox SET status = 'processed', processed_at = ?, last_error = NULL WHERE id = ?`,
      )
      .run(now.toISOString(), recordId);
  }

  async markFailed(recordId: EntityId, error: string, now: Date): Promise<void> {
    this.db
      .prepare(
        `UPDATE outbox
            SET attempts = attempts + 1,
                last_error = ?,
                status = CASE WHEN attempts + 1 >= 10 THEN 'dead_letter' ELSE 'pending' END,
                processed_at = CASE WHEN attempts + 1 >= 10 THEN ? ELSE NULL END
          WHERE id = ?`,
      )
      .run(error, now.toISOString(), recordId);
  }

  async listDeadLettered(): Promise<OutboxRecord[]> {
    return this.#byStatus('dead_letter', Number.MAX_SAFE_INTEGER);
  }

  /** One row-mapping path for every status, so the DLQ cannot silently empty. */
  #byStatus(status: OutboxRecord['status'], limit: number): OutboxRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM outbox WHERE status = ? ORDER BY created_at, id LIMIT ?')
      .all(status, limit) as unknown as {
      id: string;
      status: OutboxRecord['status'];
      attempts: number;
      created_at: string;
      processed_at: string | null;
      last_error: string | null;
      event: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      processedAt: row.processed_at,
      lastError: row.last_error,
      event: JSON.parse(row.event) as DomainEvent,
    }));
  }
}

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly db: DatabaseSync) {}

  async append(record: AuditRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, organization_id, recorded_at, document)
              VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(record.id, record.organizationId, record.recordedAt, JSON.stringify(record));
  }

  async listForOrganization(organizationId: EntityId): Promise<AuditRecord[]> {
    const rows = this.db
      .prepare(
        'SELECT document FROM audit_events WHERE organization_id = ? ORDER BY recorded_at, id',
      )
      .all(organizationId) as unknown as { document: string }[];
    return rows.map((row) => JSON.parse(row.document) as AuditRecord);
  }
}
