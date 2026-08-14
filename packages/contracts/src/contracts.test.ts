import { describe, expect, it } from 'vitest';

import {
  eventDtoSchema,
  idempotencyKeySchema,
  noContentSchema,
  opaqueIdSchema,
  organizationDtoSchema,
  pageInfoSchema,
  paginatedSchema,
  paginationQuerySchema,
  roleSchema,
  sessionSchema,
  userSchema,
  venueDtoSchema,
  versionHeaderSchema,
} from './client.js';

import {
  STATUS_CODE_TO_ERROR_CODE,
  buildV2ErrorResponse,
  errorCodeForStatus,
  zodToFieldErrors,
} from './index.js';

/**
 * ─── B02 + B03: the wire contract ────────────────────────────────────────────
 * Gate: "canonical fixtures parse; corrupt fixtures reject" and the locked
 * status→code table. Cross-repo agreement with the frontend's own copy is
 * proven separately by `scripts/contract-parity.mjs`.
 */

const VALID_USER = {
  id: 'usr_1',
  email: 'partner@example.com',
  displayName: 'Sky Partner',
  role: 'partner',
  avatarUrl: null,
};

describe('client schemas — canonical fixtures', () => {
  it('parses a user and a session', () => {
    expect(userSchema.parse(VALID_USER)).toMatchObject({ role: 'partner' });
    expect(sessionSchema.parse({ user: VALID_USER, expiresAt: 1_800_000_000_000 })).toMatchObject({
      expiresAt: 1_800_000_000_000,
    });
  });

  it('rejects corrupt fixtures', () => {
    expect(userSchema.safeParse({ ...VALID_USER, email: 'nope' }).success).toBe(false);
    expect(userSchema.safeParse({ ...VALID_USER, avatarUrl: 'nope' }).success).toBe(false);
    expect(userSchema.safeParse({ ...VALID_USER, role: 'owner' }).success).toBe(false);
    expect(roleSchema.safeParse('superadmin').success).toBe(false);
  });

  it('encodes page-based pagination, not cursors, on the wire', () => {
    const schema = paginatedSchema(organizationDtoSchema);
    const parsed = schema.parse({
      items: [],
      pageInfo: { page: 1, pageSize: 20, total: 0, hasNextPage: false },
    });
    expect(parsed.pageInfo).toMatchObject({ page: 1, hasNextPage: false });
    expect(pageInfoSchema.safeParse({ page: 1, pageSize: 20, total: 0 }).success).toBe(false);
  });

  it('encodes 204 semantics as undefined', () => {
    expect(noContentSchema.safeParse(undefined).success).toBe(true);
    expect(noContentSchema.safeParse({}).success).toBe(false);
  });

  it('bounds the pagination query and defaults the limit', () => {
    expect(paginationQuerySchema.parse({})).toMatchObject({ limit: 20 });
    expect(paginationQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('constrains opaque ids, idempotency keys and version headers', () => {
    expect(opaqueIdSchema.safeParse('org_1').success).toBe(true);
    expect(opaqueIdSchema.safeParse('bad id!').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('key-1_A').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('key 1').success).toBe(false);
    expect(versionHeaderSchema.safeParse('1').success).toBe(true);
    expect(versionHeaderSchema.safeParse('0').success).toBe(false);
    expect(versionHeaderSchema.safeParse('-1').success).toBe(false);
  });

  it('parses the partner DTOs the routes serialize', () => {
    const base = {
      version: 1,
      createdAt: '2026-08-11T10:00:00.000Z',
      updatedAt: '2026-08-11T10:00:00.000Z',
    };
    expect(
      organizationDtoSchema.safeParse({
        id: 'org_1',
        name: 'Skyline',
        slug: 'skyline',
        role: 'owner',
        status: 'active',
        ...base,
      }).success,
    ).toBe(true);
    expect(
      venueDtoSchema.safeParse({
        id: 'ven_1',
        organizationId: 'org_1',
        name: 'Sky Bar',
        slug: 'sky-bar',
        status: 'active',
        description: '',
        capacity: null,
        city: null,
        ...base,
      }).success,
    ).toBe(true);
    expect(
      eventDtoSchema.safeParse({
        id: 'evt_1',
        organizationId: 'org_1',
        venueId: 'ven_1',
        // `slug` became a required part of the event DTO after this suite was
        // first written — the schema is the newer truth, so the fixture moves.
        slug: 'sky-night',
        title: 'Sky Night',
        summary: '',
        description: '',
        imageUrl: null,
        startAt: '2026-09-01T18:00:00.000Z',
        endAt: null,
        status: 'draft',
        isPublic: false,
        tags: [],
        startingPricePaise: 0,
        isFree: true,
        cancellationReason: null,
        ...base,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown event status', () => {
    expect(eventDtoSchema.safeParse({ status: 'live' }).success).toBe(false);
  });
});

describe('error envelope', () => {
  it('locks the status → code table the frontend implements', () => {
    expect(errorCodeForStatus(400)).toBe('validation');
    expect(errorCodeForStatus(422)).toBe('validation');
    expect(errorCodeForStatus(401)).toBe('unauthorized');
    expect(errorCodeForStatus(403)).toBe('forbidden');
    expect(errorCodeForStatus(404)).toBe('not_found');
    expect(errorCodeForStatus(409)).toBe('conflict');
    expect(errorCodeForStatus(429)).toBe('rate_limited');
    expect(errorCodeForStatus(500)).toBe('server');
    expect(errorCodeForStatus(503)).toBe('server');
    // Unmapped 4xx must not silently become a mapped meaning.
    expect(errorCodeForStatus(418)).toBe('unknown');
    expect(Object.keys(STATUS_CODE_TO_ERROR_CODE)).toHaveLength(7);
  });

  it('builds the flat envelope the frontend ApiClientError parses', () => {
    const body = buildV2ErrorResponse({
      status: 422,
      message: 'Validation failed',
      requestId: 'req_1',
      fieldErrors: { title: ['Required'] },
    });
    expect(body).toEqual({
      status: 422,
      code: 'validation',
      message: 'Validation failed',
      requestId: 'req_1',
      fieldErrors: { title: ['Required'] },
    });
  });

  it('omits empty optional members rather than emitting nulls', () => {
    const body = buildV2ErrorResponse({ status: 404, message: 'Not found' });
    expect(body).toEqual({ status: 404, code: 'not_found', message: 'Not found' });
    expect('fieldErrors' in body).toBe(false);
    expect('requestId' in body).toBe(false);
  });

  it('flattens zod issues into the fieldErrors shape', () => {
    const issues = {
      issues: [
        { path: ['title'], message: 'Required' },
        { path: ['title'], message: 'Too short' },
        { path: [], message: 'Unrecognized key' },
      ],
    };
    expect(zodToFieldErrors(issues)).toEqual({
      title: ['Required', 'Too short'],
      _root: ['Unrecognized key'],
    });
  });
});
