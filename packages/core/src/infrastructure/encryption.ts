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
 * `packages/core` never reads `process.env` directly (D-boundary rule) — the
 * key/salt are passed in by the caller (gateway wiring), not read here.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

export function encryptField(plaintext: string, secret: string, salt: string): string {
  const key = deriveKey(secret, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptField(envelope: string, secret: string, salt: string): string {
  const [ivHex, authTagHex, cipherHex] = envelope.split(':');
  if (!ivHex || !authTagHex || !cipherHex) {
    throw new Error('Malformed encryption envelope');
  }
  const key = deriveKey(secret, salt);
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
