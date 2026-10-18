import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * ─── At-rest field encryption (Phase 6 bank accounts) ──────────────────────────
 *
 * AES-256-GCM (authenticated) — a scrypt-derived key (salted), envelope
 * `"<ivHex>:<authTagHex>:<cipherHex>"`. Upgraded from the initial CBC port of
 * `thec1rcle/apps/api-gateway/src/lib/encryption.ts`'s scheme: CBC has no
 * integrity check, so a tampered ciphertext decrypts silently (or throws a
 * padding error usable as an oracle) instead of failing loudly. GCM's auth
 * tag makes any tampering fail `decryptField` outright.
 *
 * `context` is bound in as GCM additional authenticated data (AAD) — callers
 * pass a stable identifier of the record the ciphertext belongs to (e.g.
 * `organizationId`). Without it, a ciphertext blob is portable: swapping one
 * record's `encryptedAccountNumber` into a different record (e.g. across
 * organizations, if something with raw datastore write access ever did that)
 * would still decrypt successfully — the auth tag alone verifies the bytes,
 * not which record they belong to. Binding the context makes `decryptField`
 * fail unless the same identifier is supplied both times.
 *
 * `packages/core` never reads `process.env` directly (D-boundary rule) — the
 * key/salt are passed in by the caller (gateway wiring), not read here.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

export function encryptField(
  plaintext: string,
  secret: string,
  salt: string,
  context: string,
): string {
  const key = deriveKey(secret, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptField(
  envelope: string,
  secret: string,
  salt: string,
  context: string,
): string {
  const [ivHex, authTagHex, cipherHex] = envelope.split(':');
  if (!ivHex || !authTagHex || !cipherHex) {
    throw new Error('Malformed encryption envelope');
  }
  const key = deriveKey(secret, salt);
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export interface FieldKey {
  secret: string;
  salt: string;
}

export type ReencryptResult =
  /** Already readable with the current key; nothing to do. */
  | { status: 'current' }
  /** Was sealed with the legacy key; `envelope` is the same value sealed with the current key. */
  | { status: 'migrated'; envelope: string }
  /** Opens under neither key: corrupt, tampered, or sealed with some other secret. */
  | { status: 'unreadable' };

/**
 * One-off key migration for a stored envelope. Tries the current key first, then
 * the legacy one; a legacy-sealed value is re-sealed under the current key with
 * the same context (so it stays bound to the same record).
 *
 * Never throws for undecryptable input and never returns or logs the plaintext —
 * callers get a status and, only when migrated, the new envelope.
 */
export function reencryptField(
  envelope: string,
  context: string,
  keys: { current: FieldKey; legacy: FieldKey },
): ReencryptResult {
  try {
    decryptField(envelope, keys.current.secret, keys.current.salt, context);
    return { status: 'current' };
  } catch {
    /* not sealed with the current key — try the legacy one */
  }
  try {
    const plaintext = decryptField(envelope, keys.legacy.secret, keys.legacy.salt, context);
    return {
      status: 'migrated',
      envelope: encryptField(plaintext, keys.current.secret, keys.current.salt, context),
    };
  } catch {
    return { status: 'unreadable' };
  }
}
