import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Promoter referral links (Phase 1) ───────────────────────────────────────
 *
 * A promoter's shareable link for one event. Its only job is to carry
 * attribution from a click to an order.
 *
 * The rule that shapes everything here: **attribution is captured onto the
 * order at purchase time, never recalculated later from the link.** A link can
 * be deactivated, renamed, or its owner's commission tier can change, and none
 * of that may rewrite what a past order earned. This model therefore holds no
 * money and no commission rate — only identity and counters.
 */

export interface ReferralLink extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  promoterId: EntityId;
  organizationId: EntityId;
  /** Short, case-insensitive, URL-safe. Unique per event. */
  code: string;
  label: string;
  isActive: boolean;
  /** Click counter — cheap vanity metric, never an attribution source. */
  clicks: number;
  /**
   * Orders attributed to this link. Incremented by the checkout path, which
   * is also what writes the immutable attribution onto the order itself.
   */
  conversions: number;
}

/**
 * Ambiguity-free alphabet: no `O`/`0`, no `I`/`1`/`L`. These codes get read
 * aloud, printed on flyers and typed by hand, so characters that look alike
 * cost real conversions.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_PATTERN = /^[A-Z0-9]{4,16}$/;

export interface CreateReferralLinkInput {
  id: EntityId;
  eventId: EntityId;
  promoterId: EntityId;
  organizationId: EntityId;
  /** Omit to generate one. */
  code?: string;
  label?: string;
  /** Injected randomness — the domain never reaches for a global RNG. */
  random?: () => number;
  now?: Date;
}

export function createReferralLink(input: CreateReferralLinkInput): ReferralLink {
  const code = input.code ? normalizeReferralCode(input.code) : generateReferralCode(input.random);
  if (!CODE_PATTERN.test(code)) {
    throw new InvalidOperationError(
      'A referral code must be 4–16 characters, letters and digits only',
    );
  }
  return {
    id: input.id,
    eventId: input.eventId,
    promoterId: input.promoterId,
    organizationId: input.organizationId,
    code,
    label: input.label ?? code,
    isActive: true,
    clicks: 0,
    conversions: 0,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/** Codes are case- and space-insensitive: a flyer may print them any way. */
export function normalizeReferralCode(code: string): string {
  return code.trim().replace(/[\s-]/g, '').toUpperCase();
}

export function generateReferralCode(random: () => number = Math.random): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index++) {
    const position = Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length;
    // `?? ''` is unreachable given the modulo, but keeps the type honest
    // rather than asserting non-null.
    code += CODE_ALPHABET[position] ?? '';
  }
  return code;
}

/**
 * Records a click. Deliberately does NOT bump `version`: clicks are a
 * high-frequency counter, and treating each one as an optimistic-lock-worthy
 * edit would make a popular link unwritable under contention while adding
 * nothing — a lost click is not a lost order.
 */
export function recordClick(link: ReferralLink, now?: Date): ReferralLink {
  return { ...link, clicks: link.clicks + 1, updatedAt: (now ?? new Date()).toISOString() };
}

/**
 * Records a conversion. Same reasoning as `recordClick` for the version: the
 * authoritative record of the sale is the attribution written onto the order,
 * not this counter.
 */
export function recordConversion(link: ReferralLink, now?: Date): ReferralLink {
  return {
    ...link,
    conversions: link.conversions + 1,
    updatedAt: (now ?? new Date()).toISOString(),
  };
}

/**
 * Deactivating stops NEW attributions. Orders already attributed keep their
 * attribution — the link is a tap, not a ledger.
 */
export function deactivateReferralLink(link: ReferralLink, now?: Date): ReferralLink {
  if (!link.isActive) return link;
  return { ...bumpVersion(link, now ?? new Date()), isActive: false };
}

export function activateReferralLink(link: ReferralLink, now?: Date): ReferralLink {
  if (link.isActive) return link;
  return { ...bumpVersion(link, now ?? new Date()), isActive: true };
}

/** Whether this link may still attribute a new order. */
export function canAttribute(link: ReferralLink): boolean {
  return link.isActive;
}
