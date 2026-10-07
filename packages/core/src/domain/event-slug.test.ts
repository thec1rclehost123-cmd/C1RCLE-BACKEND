import { describe, expect, it } from 'vitest';

import { slugifyEventTitle } from './models/event.js';

/** The pre-fix implementation, kept here as the equivalence oracle. */
function legacySlugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

describe('slugifyEventTitle', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyEventTitle('Rooftop Party')).toBe('rooftop-party');
  });

  it('collapses runs of non-alphanumerics into a single dash', () => {
    expect(slugifyEventTitle('A    B')).toBe('a-b');
    expect(slugifyEventTitle('a__b')).toBe('a-b');
    expect(slugifyEventTitle('a!!!???b')).toBe('a-b');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyEventTitle('  !!Party!!  ')).toBe('party');
    expect(slugifyEventTitle('---party---')).toBe('party');
  });

  it('keeps interior dashes', () => {
    expect(slugifyEventTitle('a-b-c')).toBe('a-b-c');
  });

  it('returns an empty string when nothing survives', () => {
    expect(slugifyEventTitle('---')).toBe('');
    expect(slugifyEventTitle('!!!')).toBe('');
    expect(slugifyEventTitle('')).toBe('');
    expect(slugifyEventTitle('   ')).toBe('');
  });

  it('caps the slug at 80 characters', () => {
    const slug = slugifyEventTitle('word '.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it('handles dash-heavy input without pathological cost', () => {
    // The preceding collapse means no consecutive dashes ever reach the trim,
    // so this is a behavioural guard, not a timing assertion.
    const dashes = '-'.repeat(5000);
    expect(slugifyEventTitle(dashes + 'party')).toBe('party');
    expect(slugifyEventTitle('party' + dashes)).toBe('party');
  });

  it('matches the previous implementation on every case below', () => {
    const manyDashes = '-'.repeat(200);
    const fixed = [
      '',
      ' ',
      '-',
      '--',
      '---',
      'a',
      'a-',
      '-a',
      '-a-',
      '--a--',
      'a--b',
      'Rooftop Party',
      'A    B',
      'a__b',
      'MiXeD CaSe 123',
      '!!!leading and trailing!!!',
      '---',
      'a'.repeat(200),
      manyDashes,
      manyDashes + 'a',
      'a' + manyDashes,
      manyDashes + 'a' + manyDashes,
      'word '.repeat(40),
      'ünïcodé títlé',
      'tabs\tand\nnewlines',
      'emoji 🎉 party',
    ];

    // Deterministic pseudo-random strings, so a failure is always reproducible.
    const alphabet = 'abz09 -_.!@#/';
    let seed = 987654321;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const generated = Array.from({ length: 300 }, () => {
      const len = Math.floor(next() * 24);
      return Array.from({ length: len }, () => alphabet[Math.floor(next() * alphabet.length)]).join(
        '',
      );
    });

    for (const input of [...fixed, ...generated]) {
      expect(slugifyEventTitle(input), `input: ${JSON.stringify(input)}`).toBe(
        legacySlugify(input),
      );
    }
  });
});
