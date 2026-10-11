import { describe, expect, it } from 'vitest';

import { decryptField, encryptField, reencryptField } from './encryption.js';

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

describe('reencryptField (legacy -> current key migration)', () => {
  const legacy = { secret: 'legacy-secret', salt: 'legacy-salt' };
  const current = { secret: 'current-secret-that-is-long-enough-0123456789', salt: 'current-salt' };
  const keys = { current, legacy };
  const ctx = 'org_1';

  it('leaves a value that already opens under the current key alone', () => {
    const sealed = encryptField('00001234567890', current.secret, current.salt, ctx);
    expect(reencryptField(sealed, ctx, keys)).toEqual({ status: 'current' });
  });

  it('re-seals a legacy value under the current key, preserving the plaintext and context', () => {
    const sealed = encryptField('00001234567890', legacy.secret, legacy.salt, ctx);
    const result = reencryptField(sealed, ctx, keys);
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.envelope).not.toBe(sealed);
    expect(decryptField(result.envelope, current.secret, current.salt, ctx)).toBe('00001234567890');
    // No longer opens under the legacy key, so the published default stops protecting it.
    expect(() => decryptField(result.envelope, legacy.secret, legacy.salt, ctx)).toThrow();
    // And a second pass is a no-op.
    expect(reencryptField(result.envelope, ctx, keys)).toEqual({ status: 'current' });
  });

  it('reports a value sealed with some other key as unreadable, without throwing', () => {
    const sealed = encryptField('00001234567890', 'someone-elses-secret', 'salt', ctx);
    expect(reencryptField(sealed, ctx, keys)).toEqual({ status: 'unreadable' });
  });

  it('reports a tampered or malformed envelope as unreadable', () => {
    const sealed = encryptField('00001234567890', legacy.secret, legacy.salt, ctx);
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('00') ? '11' : '00'}`;
    expect(reencryptField(tampered, ctx, keys)).toEqual({ status: 'unreadable' });
    expect(reencryptField('not-an-envelope', ctx, keys)).toEqual({ status: 'unreadable' });
    expect(reencryptField('', ctx, keys)).toEqual({ status: 'unreadable' });
  });

  it('does not migrate a value presented under the wrong record context', () => {
    const sealed = encryptField('00001234567890', legacy.secret, legacy.salt, 'org_1');
    expect(reencryptField(sealed, 'org_2', keys)).toEqual({ status: 'unreadable' });
  });
});
