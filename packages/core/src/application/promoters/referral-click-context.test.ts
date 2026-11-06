import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ReferralLinkService } from './referral-link-service.js';

import type { ServiceDeps } from '../context.js';
import type { PromoterAttributionSnapshot } from './referral-link-service.js';

const SECRET = 'synthetic-context-secret';
const EVENT_A = 'EVT-context-a';
const EVENT_B = 'EVT-context-b';
const CLICKED_AT = '2026-11-01T12:00:00.000Z';

function contextToken(
  secret: string,
  eventId: string,
  code: string,
  clickedAt = CLICKED_AT,
  updatedAt = clickedAt,
): string {
  const payload = {
    eventId,
    selected: { code, clickedAt, clickId: `click-${code}`, validAtClick: true },
    updatedAt,
  };
  const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('hex');
  return `${encoded}.${signature}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function makeService(now: Date, secret = SECRET) {
  const resolve = vi.fn(
    async (
      _eventId: string,
      _code: string,
      _guestUserId?: string,
      _interactionAt?: Date,
    ): Promise<PromoterAttributionSnapshot | null> => null,
  );
  const service = new ReferralLinkService({
    config: {
      clock: { now: () => now },
      magicTicketSecret: secret,
      features: {},
    },
    repositories: { referralLinks: { findByCode: vi.fn(async () => null) } },
  } as unknown as ServiceDeps);
  vi.spyOn(service, 'resolveAttribution').mockImplementation(resolve);
  return { service, resolve };
}

function readSelected(token: string) {
  const [encoded] = token.split('.');
  return JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8')) as {
    eventId: string;
    selected: { code: string; clickedAt: string } | null;
  };
}

describe('ReferralLinkService click context verification', () => {
  it('preserves the last valid code when a later code is invalid', async () => {
    const { service, resolve } = makeService(new Date('2026-11-01T12:00:00.000Z'));
    resolve.mockImplementation(async (_eventId, code) =>
      code === 'VALIDA' ? ({} as PromoterAttributionSnapshot) : null,
    );

    const validA = await service.updateClickContext(EVENT_A, 'VALIDA', 'click-a');
    const afterInvalidB = await service.updateClickContext(EVENT_A, 'INVALIDB', 'click-b', validA);

    expect(readSelected(afterInvalidB)).toMatchObject({
      eventId: EVENT_A,
      selected: { code: 'VALIDA', clickedAt: '2026-11-01T12:00:00.000Z' },
    });
  });

  it('rejects tampered, malformed, and wrong-secret context tokens', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const token = contextToken(SECRET, EVENT_A, 'VALIDA');
    const { service, resolve } = makeService(now);

    await expect(service.resolveClickContexts(EVENT_A, [`${token}x`])).resolves.toBeNull();
    await expect(service.resolveClickContexts(EVENT_A, ['not-a-token'])).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    resolve.mockClear();
    await expect(service.resolveClickContexts(EVENT_A, [token])).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledWith(EVENT_A, 'VALIDA', undefined, new Date(CLICKED_AT));

    const wrongSecretState = makeService(now, 'different-secret');
    const wrongSecret = wrongSecretState.service;
    await expect(wrongSecret.resolveClickContexts(EVENT_A, [token])).resolves.toBeNull();
    expect(wrongSecretState.resolve).not.toHaveBeenCalled();
  });

  it('rejects another event and contexts outside the seven-day window', async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const { service, resolve } = makeService(now);
    const wrongEvent = contextToken(SECRET, EVENT_B, 'VALIDA');
    const expired = contextToken(SECRET, EVENT_A, 'VALIDA', CLICKED_AT);
    const future = contextToken(
      SECRET,
      EVENT_A,
      'VALIDA',
      '2026-11-11T12:00:00.000Z',
      '2026-11-11T12:00:00.000Z',
    );

    await expect(
      service.resolveClickContexts(EVENT_A, [wrongEvent, expired, future]),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('revalidates the selected code against current assignment eligibility', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const token = contextToken(SECRET, EVENT_A, 'VALIDA');
    const { service, resolve } = makeService(now);

    // A revoked, expired, or suspended assignment resolves to null here; a
    // valid signed browser token alone must never grant attribution.
    await expect(service.resolveClickContexts(EVENT_A, [token])).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledWith(EVENT_A, 'VALIDA', undefined, new Date(CLICKED_AT));
  });
});
