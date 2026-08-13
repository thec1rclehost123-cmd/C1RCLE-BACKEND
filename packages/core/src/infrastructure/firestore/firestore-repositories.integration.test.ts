/**
 * ─── B12 Firestore adapter integration tests ───────────────────────────────
 * Network-dependent — hits the real project in `FIREBASE_PROJECT_ID`. Skipped
 * by default so `pnpm test`/CI stay hermetic (matches the memory-driver
 * default everywhere else in this repo). Run explicitly:
 *
 *   RUN_FIRESTORE_TESTS=1 FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... \
 *     FIREBASE_PRIVATE_KEY=... pnpm --filter @c1rcle/core test -- firestore-repositories
 *
 * Writes land in `v2_*`-prefixed collections (never the v1 ones — see
 * docs/architecture/decisions.md D-008). This file is a `.test.ts`, so it's exempt from
 * the `process.env` boundary walk (scripts/check-boundaries.mjs skips test
 * files) — reading credentials here directly is intentional, test-only.
 */
import { randomUUID } from 'node:crypto';

import { describe, it, expect, beforeAll } from 'vitest';

import { createEvent } from '../../domain/models/event.js';
import { createOrganization } from '../../domain/models/organization.js';
import { createVenue } from '../../domain/models/venue.js';

import { getFirestoreClient } from './client.js';
import { FirestoreEventRepository } from './firestore-event-repository.js';
import { FirestoreOrganizationRepository } from './firestore-organization-repository.js';
import { FirestoreVenueRepository } from './firestore-venue-repository.js';

const RUN = process.env.RUN_FIRESTORE_TESTS === '1';

describe.runIf(RUN)('Firestore adapters (live project)', () => {
  let db: ReturnType<typeof getFirestoreClient>;

  beforeAll(() => {
    db = getFirestoreClient({
      projectId: process.env.FIREBASE_PROJECT_ID!,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY!,
    });
  });

  // Real network round-trips to Firestore observed at 2-5s+ in this sandbox
  // (vs. vitest's 5000ms default) — generous explicit timeout, not a fix for
  // a slow adapter.
  const NETWORK_TIMEOUT = 45_000;

  it(
    'organization: save → getById round-trips, listForMember finds it via memberIds',
    async () => {
      const repo = new FirestoreOrganizationRepository(db);
      const ownerId = `test-user-${randomUUID()}`;
      const org = createOrganization({
        id: `test-org-${randomUUID()}`,
        name: 'Integration Test Org',
        slug: `integration-test-org-${randomUUID().slice(0, 8)}`,
        ownerId,
      });

      await repo.save(org);
      const fetched = await repo.getById(org.id);
      expect(fetched).toMatchObject({ id: org.id, name: org.name, ownerId });

      const page = await repo.listForMember(ownerId, { limit: 10 });
      expect(page.items.some((o) => o.id === org.id)).toBe(true);

      const member = await repo.getMember(org.id, ownerId);
      expect(member?.role).toBe('owner');
    },
    NETWORK_TIMEOUT,
  );

  it(
    'venue: save → getById → getBySlug all agree',
    async () => {
      const repo = new FirestoreVenueRepository(db);
      const organizationId = `test-org-${randomUUID()}`;
      const slug = `integration-venue-${randomUUID().slice(0, 8)}`;
      const venue = createVenue({
        id: `test-venue-${randomUUID()}`,
        organizationId,
        ownerId: `test-user-${randomUUID()}`,
        name: 'Integration Test Venue',
        slug,
      });

      await repo.save(venue);
      const byId = await repo.getById(venue.id);
      const bySlug = await repo.getBySlug(slug, organizationId);
      expect(byId?.id).toBe(venue.id);
      expect(bySlug?.id).toBe(venue.id);

      const page = await repo.listByOrganization(organizationId, { limit: 10 });
      expect(page.items.map((v) => v.id)).toContain(venue.id);
    },
    NETWORK_TIMEOUT,
  );

  it(
    'event: save → getById → listByOrganization → listPublic (only when isPublic)',
    async () => {
      const repo = new FirestoreEventRepository(db);
      const organizationId = `test-org-${randomUUID()}`;
      const event = createEvent({
        id: `test-event-${randomUUID()}`,
        organizationId,
        venueId: `test-venue-${randomUUID()}`,
        title: 'Integration Test Event',
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      await repo.save(event);
      const fetched = await repo.getById(event.id);
      expect(fetched?.title).toBe('Integration Test Event');
      expect(fetched?.isPublic).toBe(false);

      const orgPage = await repo.listByOrganization(organizationId, { limit: 10 });
      expect(orgPage.items.map((e) => e.id)).toContain(event.id);

      const publicPage = await repo.listPublic({ limit: 100 });
      expect(publicPage.items.map((e) => e.id)).not.toContain(event.id);
    },
    NETWORK_TIMEOUT,
  );
});
