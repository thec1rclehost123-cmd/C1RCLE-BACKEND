import { describe, expect, it } from 'vitest';

import { decryptField, encryptField } from './encryption.js';

/**
 * ─── AES-256-GCM field encryption (Phase 6) ────────────────────────────────
 * The round-trip is obvious; the valuable assertions are: tamper detection
 * (auth-tag), context (AAD) binding, malformed envelope, and different
 * salt/secret → decryption failure.
 */

const SECRET = 'test-secret';
const SALT = 'test-salt';
const CONTEXT = 'org-1';

describe('encryptField / decryptField (AES-256-GCM)', () => {
  it('round-trips the original plaintext', () => {
    const ciphertext = encryptField('00001234567890', SECRET, SALT, CONTEXT);
    expect(decryptField(ciphertext, SECRET, SALT, CONTEXT)).toBe('00001234567890');
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const a = encryptField('hello', SECRET, SALT, CONTEXT);
    const b = encryptField('hello', SECRET, SALT, CONTEXT);
    expect(a).not.toBe(b);
  });

  it('envelope format is iv:authTag:cipher (three hex segments)', () => {
    const envelope = encryptField('data', SECRET, SALT, CONTEXT);
    const parts = envelope.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]+$/);
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it('decrypting with a different salt throws (tamper detection)', () => {
    const ciphertext = encryptField('data', SECRET, SALT, CONTEXT);
    expect(() => decryptField(ciphertext, SECRET, 'wrong-salt', CONTEXT)).toThrow();
  });

  it('decrypting with a different secret throws (tamper detection)', () => {
    const ciphertext = encryptField('data', SECRET, SALT, CONTEXT);
    expect(() => decryptField(ciphertext, 'wrong-secret', SALT, CONTEXT)).toThrow();
  });

  it('decrypting with a different context throws (AAD binding — envelope not portable across records)', () => {
    const ciphertext = encryptField('data', SECRET, SALT, 'org-1');
    expect(() => decryptField(ciphertext, SECRET, SALT, 'org-2')).toThrow();
  });

  it('detects tampered ciphertext (modified auth tag)', () => {
    const envelope = encryptField('data', SECRET, SALT, CONTEXT);
    const parts = envelope.split(':');
    // Flip a nibble in the auth tag to break authentication.
    const tag = parts[1] ?? '';
    const tamperedTag = tag.slice(0, -1) + (tag.endsWith('a') ? 'b' : 'a');
    const tampered = [parts[0], tamperedTag, parts[2]].join(':');
    expect(() => decryptField(tampered, SECRET, SALT, CONTEXT)).toThrow();
  });

  it('rejects a malformed envelope with fewer than 3 colon segments', () => {
    expect(() => decryptField('onlytwo', SECRET, SALT, CONTEXT)).toThrow(
      'Malformed encryption envelope',
    );
  });

  it('rejects an empty envelope', () => {
    expect(() => decryptField('', SECRET, SALT, CONTEXT)).toThrow('Malformed encryption envelope');
  });

  it('round-trips a longer value', () => {
    const long = '0123456789'.repeat(20);
    const envelope = encryptField(long, SECRET, SALT, CONTEXT);
    expect(decryptField(envelope, SECRET, SALT, CONTEXT)).toBe(long);
  });
});
