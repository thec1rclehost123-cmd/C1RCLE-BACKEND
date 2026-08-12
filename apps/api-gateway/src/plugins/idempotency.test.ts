import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, signInPartner, type Partner } from '../test-utils/app-harness.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── B08 / T09: idempotency ──────────────────────────────────────────────────
 * The exit gate: "retry/concurrency tests show exactly one business result."
 * Every assertion counts durable results, not just response codes. These run
 * against the real auth stack, so the actor in each key is a real session.
 */

let app: FastifyInstance;
let partner: Partner;

beforeEach(async () => {
  app = await buildTestApp();
  partner = await signInPartner(app);
});

afterEach(async () => {
  await app.close();
});

const withKey = (key: string) => ({ ...partner.write(), 'idempotency-key': key });

/** Counts venues with a given slug — the durable business result. */
async function countVenues(slug: string): Promise<number> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v2/partner/organizations/${partner.organizationId}/venues?limit=100`,
    headers: partner.read(),
  });
  const body: { items: { slug: string }[] } = response.json();
  return body.items.filter((item) => item.slug === slug).length;
}

const createVenue = (headers: Record<string, string>, slug: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v2/partner/organizations/${partner.organizationId}/venues`,
    headers,
    payload: { name: slug, slug },
  });

describe('idempotency plugin — replay protection', () => {
  it('replays the stored response and writes only once', async () => {
    const first = await createVenue(withKey('key-replay-1'), 'replay-co');
    const second = await createVenue(withKey('key-replay-1'), 'replay-co');

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    // Byte-identical replay, including the generated id.
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(await countVenues('replay-co')).toBe(1);
  });

  it('rejects the same key with a different payload (409 conflict)', async () => {
    await createVenue(withKey('key-reuse-1'), 'first-co');
    const response = await createVenue(withKey('key-reuse-1'), 'second-co');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', status: 409 });
    expect(await countVenues('second-co')).toBe(0);
  });

  it('produces exactly one result under concurrent same-key requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => createVenue(withKey('key-race-1'), 'race-co')),
    );

    // A loser may legitimately see either "in flight" (409) or the finished
    // record (201 replay) depending on interleaving. Both are correct; what is
    // never allowed is a second write.
    const created = responses.filter((response) => response.statusCode === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(responses.every((response) => [201, 409].includes(response.statusCode))).toBe(true);
    expect(new Set(created.map((response) => response.body)).size).toBe(1);
    expect(await countVenues('race-co')).toBe(1);
  });

  it('requires the Idempotency-Key header on writes (422 + fieldErrors)', async () => {
    const response = await createVenue(partner.read(), 'no-key-co');

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('idempotency-key');
    expect(await countVenues('no-key-co')).toBe(0);
  });

  it('keeps the key retryable when the command failed', async () => {
    const failed = await createVenue(withKey('key-retry-1'), 'bad slug!');
    expect(failed.statusCode).toBe(422);

    const retried = await createVenue(withKey('key-retry-1'), 'fixed-co');
    expect(retried.statusCode).toBe(201);
    expect(await countVenues('fixed-co')).toBe(1);
  });

  it('scopes keys per command — the same key on another command is not a replay', async () => {
    const created = await createVenue(withKey('key-shared-1'), 'scoped-co');
    const venueId = created.json().id as string;

    // venues.update reusing the create key must run, not replay.
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v2/partner/venues/${venueId}`,
      headers: { ...withKey('key-shared-1'), 'if-match': '1' },
      payload: { public: { name: 'Scoped Renamed' } },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Scoped Renamed', version: 2 });
  });

  it('scopes keys per actor — another partner reusing a key is not a replay', async () => {
    await createVenue(withKey('key-actor-1'), 'actor-one');

    const other = await signInPartner(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/organizations/${other.organizationId}/venues`,
      headers: { ...other.write(), 'idempotency-key': 'key-actor-1' },
      payload: { name: 'actor-two', slug: 'actor-two' },
    });

    // Same client key, different actor → a new command, never someone else's
    // stored response.
    expect(response.statusCode).toBe(201);
    expect(response.json().name).toBe('actor-two');
  });
});
