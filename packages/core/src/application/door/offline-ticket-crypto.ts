import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

import type { KeyObject } from 'node:crypto';

/**
 * ─── Offline-verifiable tickets ─────────────────────────────────────────────
 *
 * A door device with no signal has to decide "is this QR genuine?" without
 * calling the server, and without holding the secret that mints every ticket.
 * Two properties make that possible:
 *
 * 1. **Per-ticket keys.** `ticketKey = HMAC(master, "ticket-key|" + id)`. The
 *    rotating QR is `id:window:HMAC(ticketKey, "id:window")`. A device that is
 *    given the keys for one event's tickets can verify those tickets and can
 *    not mint or verify anything else; losing the device never reveals the
 *    master secret.
 * 2. **A signed manifest.** The set of (ticket, key, validity) a device holds
 *    is signed with Ed25519. The device only needs the public key, so it can
 *    detect a tampered or substituted manifest without being able to forge one.
 *
 * Everything here is a pure function of its arguments so the scanner app can
 * reimplement it from the known-answer vectors in `offline-ticket-crypto.test.ts`.
 */

/** Rotating-QR window, in seconds. */
export const MAGIC_WINDOW_SEC = 30;

/** DER prefixes that wrap a raw 32-byte Ed25519 key. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function deriveTicketKey(
  masterSecret: string,
  entitlementId: string,
  credentialVersion = 1,
): string {
  const versionPart = credentialVersion <= 1 ? '' : `|${credentialVersion}`;
  return createHmac('sha256', masterSecret)
    .update(`ticket-key|${entitlementId}${versionPart}`)
    .digest('hex');
}

export function windowStartFor(atMs: number): number {
  return Math.floor(atMs / 1000 / MAGIC_WINDOW_SEC) * MAGIC_WINDOW_SEC;
}

export function rotatingQrSignature(
  ticketKey: string,
  entitlementId: string,
  windowStart: number,
  credentialVersion = 1,
): string {
  const fields =
    credentialVersion <= 1
      ? `${entitlementId}:${windowStart}`
      : `${entitlementId}:${credentialVersion}:${windowStart}`;
  return createHmac('sha256', ticketKey).update(fields).digest('hex');
}

export function buildRotatingQr(
  ticketKey: string,
  entitlementId: string,
  atMs: number,
  credentialVersion = 1,
): string {
  const windowStart = windowStartFor(atMs);
  const signature = rotatingQrSignature(ticketKey, entitlementId, windowStart, credentialVersion);
  return credentialVersion <= 1
    ? `${entitlementId}:${windowStart}:${signature}`
    : `${entitlementId}:${credentialVersion}:${windowStart}:${signature}`;
}

export interface ParsedRotatingQr {
  entitlementId: string;
  credentialVersion: number;
  /** `null` when the window field is not an integer. */
  windowStart: number | null;
  signature: string;
}

/**
 * Splits the legacy `id:window:signature` and versioned
 * `id:version:window:signature` forms.
 */
export function parseRotatingQr(payload: string): ParsedRotatingQr | null {
  const parts = payload.split(':');
  if ((parts.length !== 3 && parts.length !== 4) || !parts.every((p) => p.length > 0)) return null;
  const [entitlementId, second, third, fourth] = parts as [string, string, string, string?];
  const credentialVersion = parts.length === 4 ? Number.parseInt(second, 10) : 1;
  const windowStr = parts.length === 4 ? third : second;
  const signature = parts.length === 4 ? (fourth ?? '') : third;
  const windowStart = Number.parseInt(windowStr, 10);
  return {
    entitlementId,
    credentialVersion:
      Number.isSafeInteger(credentialVersion) && credentialVersion > 0 ? credentialVersion : 0,
    windowStart: Number.isFinite(windowStart) ? windowStart : null,
    signature,
  };
}

/** Constant-time string comparison. A plain `===` leaks how much of a guess was right. */
export function constantTimeEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Checks a parsed rotating QR against a ticket key **as of `atMs`**.
 *
 * `atMs` is "now" for an online scan and the device's scan time for an offline
 * one. That is the whole fix for offline sync: a code that was fresh when it
 * was scanned three hours ago must still verify three hours later, and a
 * screenshot replayed outside its window must still not.
 *
 * The signature may cover the claimed window or the one before it (one window
 * of grace for a code that rolled over mid-scan); the claimed window itself
 * must be within two windows of `atMs`.
 */
export function checkRotatingQr(args: {
  ticketKey: string;
  parsed: ParsedRotatingQr;
  atMs: number;
}): boolean {
  const { ticketKey, parsed, atMs } = args;
  if (parsed.windowStart === null) return false;
  const current = constantTimeEquals(
    parsed.signature,
    rotatingQrSignature(
      ticketKey,
      parsed.entitlementId,
      parsed.windowStart,
      parsed.credentialVersion,
    ),
  );
  const previous = constantTimeEquals(
    parsed.signature,
    rotatingQrSignature(
      ticketKey,
      parsed.entitlementId,
      parsed.windowStart - MAGIC_WINDOW_SEC,
      parsed.credentialVersion,
    ),
  );
  if (!current && !previous) return false;
  return Math.abs(windowStartFor(atMs) - parsed.windowStart) <= MAGIC_WINDOW_SEC * 2;
}

// ── manifest signing ────────────────────────────────────────────────────────

export interface ManifestSigningKey {
  privateKey: KeyObject;
  /** Raw 32-byte Ed25519 public key, base64. This is what ships to devices. */
  publicKey: string;
  /** Short stable identifier of the public key, for rotation. */
  keyId: string;
}

/**
 * The manifest key is derived from the same master secret as the ticket keys
 * (HKDF, distinct `info`), so there is no second secret to provision or leak:
 * rotating `MAGIC_TICKET_SECRET` rotates both. The derivation is deterministic,
 * which keeps every API instance signing with the same key.
 */
export function deriveManifestSigningKey(masterSecret: string): ManifestSigningKey {
  const seed = Buffer.from(
    hkdfSync('sha256', masterSecret, 'c1rcle', 'offline-manifest-ed25519-v1', 32),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const raw = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI_ED25519_PREFIX.length);
  return {
    privateKey,
    publicKey: raw.toString('base64'),
    keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16),
  };
}

export interface ManifestSigningInput {
  eventId: string;
  signedAt: string;
  expiresAt: string;
  entries: readonly {
    entitlementId: string;
    validFrom: string;
    validTo: string;
    seatsRemaining: number;
    ticketKey: string;
  }[];
}

/**
 * The exact bytes that are signed. Entries are sorted by id so the digest does
 * not depend on page order, and every field a device acts on is covered.
 */
export function manifestSigningBytes(input: ManifestSigningInput): Buffer {
  const lines = [...input.entries]
    .sort((a, b) =>
      a.entitlementId < b.entitlementId ? -1 : a.entitlementId > b.entitlementId ? 1 : 0,
    )
    .map(
      (e) => `${e.entitlementId}|${e.validFrom}|${e.validTo}|${e.seatsRemaining}|${e.ticketKey}\n`,
    );
  const digest = createHash('sha256').update(lines.join('')).digest('hex');
  return Buffer.from(
    `c1rcle-offline-manifest-v1\n${input.eventId}\n${input.signedAt}\n${input.expiresAt}\n${digest}`,
    'utf8',
  );
}

export function signManifest(key: ManifestSigningKey, input: ManifestSigningInput): string {
  return sign(null, manifestSigningBytes(input), key.privateKey).toString('base64');
}

export function verifyManifest(
  publicKeyBase64: string,
  input: ManifestSigningInput,
  signatureBase64: string,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyBase64, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      manifestSigningBytes(input),
      publicKey,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}
