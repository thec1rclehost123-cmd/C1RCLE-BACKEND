import { describe, expect, it } from 'vitest';

import { decryptField, encryptField } from './encryption.js';

/**
 * ─── AES-256-GCM field encryption (Phase 6) ────────────────────────────────
 * The round-trip is obvious; the valuable assertions are: tamper detection
 * (auth-tag), malformed envelope, and different salt → different ciphertext.
 */

const SECRET = 'test-secret';
const SALT = 'test-salt';

describe('encryptField / decryptField (AES-256-GCM)', () => {
  it('round-trips the original plaintext', () => {
    const ciphertext = encryptField('00001234567890', SECRET, SALT);
    expect(decryptField(ciphertext, SECRET, SALT)).toBe('00001234567890');
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const a = encryptField('hello', SECRET, SALT);
    const b = encryptField('hello', SECRET, SALT);
    expect(a).not.toBe(b);
  });

  it('envelope format is iv:authTag:cipher (three hex segments)', () => {
    const envelope = encryptField('data', SECRET, SALT);
    const parts = envelope.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]+$/);
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it('decrypts with a different salt returns the wrong plaintext (tamper detection)', () => {
    const ciphertext = encryptField('data', SECRET, SALT);
    expect(() => decryptField(ciphertext, SECRET, 'wrong-salt')).toThrow();
  });

  it('decrypts with a different secret returns the wrong plaintext (tamper detection)', () => {
    const ciphertext = encryptField('data', SECRET, SALT);
    expect(() => decryptField(ciphertext, 'wrong-secret', SALT)).toThrow();
  });

  it('detects tampered ciphertext (modified auth tag)', () => {
    const envelope = encryptField('data', SECRET, SALT);
    const parts = envelope.split(':');
    // Flip a nibble in the auth tag to break authentication.
    const tag = parts[1] ?? '';
    const tamperedTag = tag.slice(0, -1) + (tag.endsWith('a') ? 'b' : 'a');
    const tampered = [parts[0], tamperedTag, parts[2]].join(':');
    expect(() => decryptField(tampered, SECRET, SALT)).toThrow();
  });

  it('rejects a malformed envelope with fewer than 3 colon segments', () => {
    expect(() => decryptField('onlytwo', SECRET, SALT)).toThrow('Malformed encryption envelope');
  });

  it('rejects an empty envelope', () => {
    expect(() => decryptField('', SECRET, SALT)).toThrow('Malformed encryption envelope');
  });

  it('round-trips a longer value', () => {
    const long = '0123456789'.repeat(20);
    const envelope = encryptField(long, SECRET, SALT);
    expect(decryptField(envelope, SECRET, SALT)).toBe(long);
  });
});
