import { describe, expect, it } from 'vitest';

import {
  MAGIC_WINDOW_SEC,
  buildRotatingQr,
  checkRotatingQr,
  deriveManifestSigningKey,
  deriveTicketKey,
  parseRotatingQr,
  rotatingQrSignature,
  signManifest,
  verifyManifest,
  windowStartFor,
} from './offline-ticket-crypto.js';

/**
 * Known-answer vectors. They were produced by a separate, plain `node:crypto`
 * script (not by the module under test), and they are the contract the scanner
 * app must reproduce on a device: if any of these change, every deployed
 * scanner stops verifying tickets.
 */
const SECRET = 'kat-master-secret-0123456789abcdef0123456789';
const ID = 'ENT-kat-1';
const WINDOW = 1_700_000_010;
const KAT = {
  ticketKey: '09442d07af416089ff006c63380f5b19cca1d27782509dbcf53dfd4e7d9f0b62',
  signature: 'd83a16a83871f0d0aaafb8fb4049a70d4afefbbadf934cbcb31aebd021a938c5',
  publicKey: 'MtUqNKj9Q6R8rL8SRtgQ6swSb3iEl9M540w2gvh2NUw=',
  keyId: '695b5c6cdba3a96d',
  manifestSignature:
    'WjIEdcujbhVC+foySz5O9rgMcyCr5Ovb5dZebx3KqWhauQVryRgZrm71Mfn4HMjwkbzMvEkLJVaHvzGVOcASAg==',
};
const MANIFEST = {
  eventId: 'evt_kat',
  signedAt: '2026-10-18T10:00:00.000Z',
  expiresAt: '2026-10-18T22:00:00.000Z',
  entries: [
    {
      entitlementId: ID,
      validFrom: '2026-10-18T10:00:00.000Z',
      validTo: '2026-10-18T22:00:00.000Z',
      seatsRemaining: 2,
      ticketKey: KAT.ticketKey,
    },
  ],
};

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

const FIRST_ENTRY = must(MANIFEST.entries[0]);

describe('known-answer vectors', () => {
  it('derives the per-ticket key and rotating signature', () => {
    expect(deriveTicketKey(SECRET, ID)).toBe(KAT.ticketKey);
    expect(rotatingQrSignature(KAT.ticketKey, ID, WINDOW)).toBe(KAT.signature);
  });

  it('derives the manifest signing key and signs the manifest', () => {
    const key = deriveManifestSigningKey(SECRET);
    expect(key.publicKey).toBe(KAT.publicKey);
    expect(key.keyId).toBe(KAT.keyId);
    // Ed25519 is deterministic, so the signature itself is a stable vector.
    expect(signManifest(key, MANIFEST)).toBe(KAT.manifestSignature);
  });
});

describe('per-ticket keys', () => {
  it('are unique per ticket and per secret, and never equal the master secret', () => {
    const a = deriveTicketKey(SECRET, 'ENT-a');
    expect(a).not.toBe(deriveTicketKey(SECRET, 'ENT-b'));
    expect(a).not.toBe(deriveTicketKey('another-master-secret-0123456789abcdef', 'ENT-a'));
    expect(a).not.toContain(SECRET);
  });

  it("do not let one ticket's key verify another ticket's code", () => {
    const keyA = deriveTicketKey(SECRET, 'ENT-a');
    const qrForB = buildRotatingQr(deriveTicketKey(SECRET, 'ENT-b'), 'ENT-b', 1_700_000_000_000);
    const parsed = must(parseRotatingQr(qrForB));
    expect(checkRotatingQr({ ticketKey: keyA, parsed, atMs: 1_700_000_000_000 })).toBe(false);
  });
});

describe('rotating QR verified as of a scan time', () => {
  const key = deriveTicketKey(SECRET, ID);
  const issuedAtMs = 1_700_000_015_000;
  const qr = buildRotatingQr(key, ID, issuedAtMs);
  const parsed = must(parseRotatingQr(qr));

  it('round-trips the format `id:window:signature`', () => {
    expect(qr).toBe(`${ID}:${windowStartFor(issuedAtMs)}:${rotatingQrSignature(key, ID, WINDOW)}`);
    expect(parsed).toEqual({
      entitlementId: ID,
      credentialVersion: 1,
      windowStart: WINDOW,
      signature: KAT.signature,
    });
  });

  it('accepts the code at the time it was scanned, however long ago that was', () => {
    // The server-now check used to reject this once an offline backlog synced.
    expect(checkRotatingQr({ ticketKey: key, parsed, atMs: issuedAtMs })).toBe(true);
    expect(checkRotatingQr({ ticketKey: key, parsed, atMs: issuedAtMs + 40_000 })).toBe(true);
  });

  it('rejects a replay outside the window (a screenshot, not clock drift)', () => {
    const late = issuedAtMs + (MAGIC_WINDOW_SEC * 3 + 1) * 1000;
    expect(checkRotatingQr({ ticketKey: key, parsed, atMs: late })).toBe(false);
    const early = issuedAtMs - (MAGIC_WINDOW_SEC * 3 + 1) * 1000;
    expect(checkRotatingQr({ ticketKey: key, parsed, atMs: early })).toBe(false);
  });

  it('rejects a forged or truncated signature', () => {
    // Flip the last hex digit to a different one, so this always differs.
    const last = parsed.signature.slice(-1);
    const flipped = last === '0' ? '1' : '0';
    const forged = { ...parsed, signature: parsed.signature.slice(0, -1) + flipped };
    expect(checkRotatingQr({ ticketKey: key, parsed: forged, atMs: issuedAtMs })).toBe(false);
    expect(
      checkRotatingQr({
        ticketKey: key,
        parsed: { ...parsed, signature: 'deadbeef' },
        atMs: issuedAtMs,
      }),
    ).toBe(false);
  });

  it('treats a non-integer window as invalid and a bare id as not a rotating code', () => {
    expect(parseRotatingQr('ENT-1:notanumber:abc')?.windowStart).toBeNull();
    expect(
      checkRotatingQr({
        ticketKey: key,
        parsed: must(parseRotatingQr('ENT-1:notanumber:abc')),
        atMs: issuedAtMs,
      }),
    ).toBe(false);
    expect(parseRotatingQr('ENT-1')).toBeNull();
    expect(parseRotatingQr('a:b')).toBeNull();
    expect(parseRotatingQr('a::c')).toBeNull();
  });
});

describe('versioned rotating credentials', () => {
  it('binds a credential to its ownership version and rejects a prior version key', () => {
    const oldKey = deriveTicketKey(SECRET, ID, 1);
    const currentKey = deriveTicketKey(SECRET, ID, 2);
    const issuedAtMs = 1_700_000_015_000;
    const qr = buildRotatingQr(currentKey, ID, issuedAtMs, 2);
    const parsed = must(parseRotatingQr(qr));

    expect(parsed.credentialVersion).toBe(2);
    expect(checkRotatingQr({ ticketKey: currentKey, parsed, atMs: issuedAtMs })).toBe(true);
    expect(checkRotatingQr({ ticketKey: oldKey, parsed, atMs: issuedAtMs })).toBe(false);
  });
});

describe('signed manifest', () => {
  const key = deriveManifestSigningKey(SECRET);
  const signature = signManifest(key, MANIFEST);

  it('verifies with only the public key', () => {
    expect(verifyManifest(key.publicKey, MANIFEST, signature)).toBe(true);
  });

  it('does not depend on entry order', () => {
    const second = { ...FIRST_ENTRY, entitlementId: 'ENT-kat-2' };
    const a = signManifest(key, { ...MANIFEST, entries: [FIRST_ENTRY, second] });
    const b = signManifest(key, { ...MANIFEST, entries: [second, FIRST_ENTRY] });
    expect(a).toBe(b);
  });

  it.each([
    [
      'a swapped ticket key',
      { ...MANIFEST, entries: [{ ...FIRST_ENTRY, ticketKey: 'f'.repeat(64) }] },
    ],
    [
      'an extra ticket',
      {
        ...MANIFEST,
        entries: [...MANIFEST.entries, { ...FIRST_ENTRY, entitlementId: 'ENT-extra' }],
      },
    ],
    ['a different event', { ...MANIFEST, eventId: 'evt_other' }],
    ['an extended expiry', { ...MANIFEST, expiresAt: '2030-01-01T00:00:00.000Z' }],
    [
      'a widened validity',
      { ...MANIFEST, entries: [{ ...FIRST_ENTRY, validTo: '2030-01-01T00:00:00.000Z' }] },
    ],
  ])('rejects %s', (_label, tampered) => {
    expect(verifyManifest(key.publicKey, tampered, signature)).toBe(false);
  });

  it("rejects another server's key and malformed input without throwing", () => {
    const other = deriveManifestSigningKey('a-completely-different-master-secret-value');
    expect(verifyManifest(other.publicKey, MANIFEST, signature)).toBe(false);
    expect(verifyManifest('not base64 !!', MANIFEST, signature)).toBe(false);
    expect(verifyManifest(key.publicKey, MANIFEST, 'AAAA')).toBe(false);
  });
});
