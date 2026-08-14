import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import {
  activateReferralLink,
  canAttribute,
  createReferralLink,
  deactivateReferralLink,
  generateReferralCode,
  normalizeReferralCode,
  recordClick,
  recordConversion,
} from './models/referral-link.js';

/**
 * ─── Promoter referral links ─────────────────────────────────────────────────
 * The rule under test throughout: a link carries attribution, it does not own
 * it. Deactivating or renaming a link must never change what a past order
 * earned.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');
const LATER = new Date('2026-08-13T12:00:00.000Z');

const link = (overrides: Partial<Parameters<typeof createReferralLink>[0]> = {}) =>
  createReferralLink({
    id: 'ref_1',
    eventId: 'evt_1',
    promoterId: 'promoter_1',
    organizationId: 'org_1',
    code: 'SUMMER24',
    now: NOW,
    ...overrides,
  });

describe('creating a link', () => {
  it('starts active with zeroed counters', () => {
    expect(link()).toMatchObject({
      code: 'SUMMER24',
      isActive: true,
      clicks: 0,
      conversions: 0,
      version: 1,
    });
  });

  it('defaults the label to the code', () => {
    expect(link().label).toBe('SUMMER24');
  });

  it('normalizes a code the way a flyer might print it', () => {
    // Case, spaces and dashes must not fork one code into several.
    expect(link({ code: ' summer-24 ' }).code).toBe('SUMMER24');
    expect(normalizeReferralCode('ab cd-ef')).toBe('ABCDEF');
  });

  it('rejects a code too short or with unusable characters', () => {
    expect(() => link({ code: 'AB' })).toThrow(InvalidOperationError);
    expect(() => link({ code: 'SUMMER!!' })).toThrow(InvalidOperationError);
  });

  it('generates a code from an unambiguous alphabet', () => {
    // Codes get read aloud and typed by hand; O/0 and I/1/L cost conversions.
    const generated = generateReferralCode(() => 0.5);
    expect(generated).toHaveLength(8);
    expect(generated).not.toMatch(/[O0IL1]/);
  });

  it('takes its randomness by injection, so generation is reproducible', () => {
    const fromSequence = (values: number[]) => {
      let index = 0;
      return generateReferralCode(() => values[index++] ?? 0);
    };
    const sequence = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

    // Same source in, same code out — the domain never reaches for a global
    // RNG, which is what makes this testable at all.
    expect(fromSequence(sequence)).toBe(fromSequence(sequence));
    expect(fromSequence(sequence)).not.toBe(fromSequence([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]));
  });
});

describe('counters', () => {
  it('records a click without bumping the version', () => {
    const clicked = recordClick(link(), LATER);

    // Clicks are high-frequency: treating each as an optimistic-lock-worthy
    // edit would make a popular link unwritable under contention.
    expect(clicked.clicks).toBe(1);
    expect(clicked.version).toBe(1);
    expect(clicked.updatedAt).toBe(LATER.toISOString());
  });

  it('records a conversion without bumping the version', () => {
    const converted = recordConversion(link(), LATER);
    expect(converted.conversions).toBe(1);
    expect(converted.version).toBe(1);
  });

  it('accumulates', () => {
    let subject = link();
    for (let index = 0; index < 5; index++) subject = recordClick(subject, LATER);
    subject = recordConversion(subject, LATER);

    expect(subject).toMatchObject({ clicks: 5, conversions: 1 });
  });
});

describe('activation', () => {
  it('stops new attributions when deactivated', () => {
    const inactive = deactivateReferralLink(link(), LATER);

    expect(inactive.isActive).toBe(false);
    expect(canAttribute(inactive)).toBe(false);
    // A real state change DOES bump the version — unlike a click.
    expect(inactive.version).toBe(2);
  });

  it('keeps counters after deactivation — the link is a tap, not a ledger', () => {
    const used = recordConversion(recordClick(link(), LATER), LATER);
    const inactive = deactivateReferralLink(used, LATER);

    // Orders already attributed keep their attribution; nothing is rewritten.
    expect(inactive).toMatchObject({ clicks: 1, conversions: 1 });
  });

  it('is idempotent in both directions', () => {
    const inactive = deactivateReferralLink(link(), LATER);
    expect(deactivateReferralLink(inactive, LATER)).toBe(inactive);

    const active = activateReferralLink(inactive, LATER);
    expect(activateReferralLink(active, LATER)).toBe(active);
    expect(active.isActive).toBe(true);
  });
});
