import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * ─── At-rest field encryption (Phase 6 bank accounts) ──────────────────────────
 *
 * AES-256-CBC, mirroring the proven envelope from
 * `thec1rcle/apps/api-gateway/src/lib/encryption.ts`: a scrypt-derived key
 * (salted), IV-prefixed ciphertext output as `"<ivHex>:<cipherHex>"`.
 * `packages/core` never reads `process.env` directly (D-boundary rule) — the
 * key/salt are passed in by the caller (gateway wiring), not read here.
 */

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

export function encryptField(plaintext: string, secret: string, salt: string): string {
  const key = deriveKey(secret, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptField(envelope: string, secret: string, salt: string): string {
  const [ivHex, cipherHex] = envelope.split(':');
  if (!ivHex || !cipherHex) {
    throw new Error('Malformed encryption envelope');
  }
  const key = deriveKey(secret, salt);
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
