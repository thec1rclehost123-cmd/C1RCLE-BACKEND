import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  EventNotFoundError,
  InvalidOperationError,
  PromoterAssignmentNotFoundError,
} from '../../domain/errors.js';
import {
  createPromoterAssignment,
  type CommissionTerms,
  type PromoterAssignment,
} from '../../domain/models/event-catalog.js';
import { isPublicStatus } from '../../domain/models/event.js';
import {
  createReferralLink,
  deactivateReferralLink,
  generateReferralCode,
  normalizeReferralCode,
  recordConversion,
} from '../../domain/models/referral-link.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { ReferralLink } from '../../domain/models/referral-link.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Referral link service (Phase 1) ─────────────────────────────────────────
 *
 * Link records carry signed copies of active assignment terms. Checkout
 * verifies and freezes those terms onto the order before financial settlement.
 */

export interface CreateReferralLinkCommand {
  eventId: EntityId;
  promoterId: EntityId;
  /** Omit to have one generated. */
  code?: string;
  label?: string;
}

export interface PromoterAttributionSnapshot {
  referralLinkId: EntityId;
  eventId: EntityId;
  promoterId: EntityId;
  assignmentId: EntityId;
  assignmentVersion: number;
  termsVersion: number;
  terms: CommissionTerms;
  code: string;
}

export class ReferralLinkService {
  constructor(private deps: ServiceDeps) {}

  private get repo() {
    return this.deps.repositories.referralLinks;
  }

  async create(actor: ActorContext, command: CreateReferralLinkCommand): Promise<ReferralLink> {
    const event = await this.deps.repositories.events.getById(command.eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      // IDOR guard: never confirm another tenant's event exists.
      throw new EventNotFoundError(command.eventId);
    }

    let assignment = (await this.deps.repositories.catalog.listAssignments(command.eventId)).find(
      (candidate) => candidate.promoterId === command.promoterId && candidate.status === 'active',
    );
    if (!assignment) {
      assignment = createPromoterAssignment({
        id: `pa-${command.eventId}-${command.promoterId}`,
        eventId: command.eventId,
        promoterId: command.promoterId,
        terms: { version: 1, ratePercent: 0, flatPaise: 0 },
        now: this.deps.config.clock.now(),
      });
      await this.deps.repositories.catalog.saveAssignment(assignment);
    }
    const promoter = await this.deps.repositories.organizations.getById(command.promoterId);
    return this.createAssignedLink({
      assignment,
      event,
      promoterId: command.promoterId,
      organizationId: actor.organizationId,
      label: command.label,
      requestedCode: command.code,
      promoterName: promoter?.name ?? command.promoterId,
      vanityPrefix: promoter?.slug ?? command.promoterId,
    });
  }

  /** A promoter may create attribution links only for their own active assignment. */
  async createForAssignment(
    actor: ActorContext,
    assignmentId: EntityId,
    label?: string,
    requestedCode?: string,
    requestedVanitySlug?: string,
  ): Promise<ReferralLink> {
    const assignment = await this.deps.repositories.catalog.getAssignmentById(assignmentId);
    if (
      !assignment ||
      assignment.status !== 'active' ||
      assignment.promoterId !== actor.organizationId
    ) {
      throw new PromoterAssignmentNotFoundError(assignmentId);
    }
    const event = await this.deps.repositories.events.getById(assignment.eventId);
    if (!event) throw new PromoterAssignmentNotFoundError(assignmentId);

    const promoter = await this.deps.repositories.organizations.getById(assignment.promoterId);
    if (!promoter) throw new PromoterAssignmentNotFoundError(assignmentId);
    return this.createAssignedLink({
      assignment,
      event,
      promoterId: assignment.promoterId,
      organizationId: event.organizationId,
      label,
      promoterName: promoter.name,
      vanityPrefix: promoter.slug,
      requestedCode,
      requestedVanitySlug,
    });
  }

  private async createAssignedLink(input: {
    assignment: PromoterAssignment;
    event: Event;
    promoterId: EntityId;
    organizationId: EntityId;
    label?: string;
    promoterName?: string;
    vanityPrefix?: string;
    requestedCode?: string;
    requestedVanitySlug?: string;
  }): Promise<ReferralLink> {
    const prior = await this.repo.findAnyByPromoter(input.promoterId);
    const stableCode = prior?.code;
    const proposed = input.requestedCode ?? stableCode ?? generateReferralCode();
    let code = await this.repo.getOrCreatePromoterCode(input.promoterId, proposed);
    if (!code && !input.requestedCode) {
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        code = await this.repo.getOrCreatePromoterCode(input.promoterId, generateReferralCode());
      }
    }
    if (!code) throw new InvalidOperationError('Could not reserve a unique promoter code');
    if (input.requestedCode && normalizeReferralCode(input.requestedCode) !== code) {
      throw new InvalidOperationError(
        'The promoter tracking code is already set and cannot vary by event',
      );
    }
    const globalClash = await this.repo.findByCodeGlobal(code);
    if (globalClash && globalClash.promoterId !== input.promoterId) {
      throw new InvalidOperationError('That promoter code is already in use');
    }
    if (!globalClash && !(await this.repo.claimGlobalCode(code, input.promoterId))) {
      throw new InvalidOperationError('That promoter code is already in use');
    }
    const existing = await this.repo.findByCode(input.event.id, code);
    if (existing && existing.promoterId === input.promoterId) return existing;
    if (existing)
      throw new InvalidOperationError('That referral code is already in use for this event');

    const id = `pl-${createHash('sha256')
      .update(`${input.promoterId}:${input.event.id}`)
      .digest('hex')
      .slice(0, 32)}`;
    const canonical = {
      referralLinkId: id,
      eventId: input.event.id,
      promoterId: input.promoterId,
      assignmentId: input.assignment.id,
      assignmentVersion: input.assignment.version,
      termsVersion: input.assignment.terms.version,
      terms: input.assignment.terms,
      code,
    } satisfies PromoterAttributionSnapshot;
    const signature = signPromoterAttribution(
      canonical,
      this.deps.config.magicTicketSecret || 'dev-secret',
    );
    const vanityBase =
      (input.requestedVanitySlug ?? input.event.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 54) || 'event';
    const vanitySlug = input.requestedVanitySlug
      ? vanityBase
      : `${vanityBase}-${code.slice(-3).toLowerCase()}`;
    if (!(await this.repo.claimVanityAlias(input.vanityPrefix ?? '', vanitySlug, id))) {
      throw new InvalidOperationError('That vanity URL is already in use');
    }
    const link = createReferralLink({
      id,
      eventId: input.event.id,
      promoterId: input.promoterId,
      organizationId: input.organizationId,
      assignmentId: input.assignment.id,
      assignmentVersion: input.assignment.version,
      termsSnapshot: input.assignment.terms,
      attributionSignature: signature,
      eventTitle: input.event.title,
      vanityPrefix: input.vanityPrefix,
      vanitySlug,
      code,
      label: input.label ?? 'organic',
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(link);
    this.deps.logger.info('referral_link.created', {
      referralLinkId: link.id,
      eventId: input.event.id,
    });
    return link;
  }

  async listForEvent(actor: ActorContext, eventId: EntityId, query: PaginationQuery) {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      throw new EventNotFoundError(eventId);
    }
    return this.repo.listByEvent(eventId, query);
  }

  async listForPromoter(actor: ActorContext, promoterId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, actor.organizationId);
    return this.repo.listByPromoter(promoterId, query);
  }

  async deactivate(actor: ActorContext, linkId: EntityId): Promise<ReferralLink> {
    const link = await this.fetchOwned(actor, linkId);
    const deactivated = deactivateReferralLink(link, this.deps.config.clock.now());
    await this.repo.save(deactivated);
    return deactivated;
  }

  /**
   * Resolves a shared code and counts the click. Returns `null` for an unknown
   * or inactive code rather than throwing: a mistyped link on a flyer is an
   * ordinary event, not an error worth a 500 in the guest path.
   */
  async trackClick(eventId: EntityId, code: string): Promise<ReferralLink | null> {
    const link = await this.repo.findByCode(eventId, normalizeReferralCode(code));
    if (!link || !link.isActive) return null;
    if (!(await this.repo.recordClick(link.id))) return null;
    return this.repo.getById(link.id);
  }

  /**
   * Counts a conversion. Called by the checkout path once an order is
   * attributed — the order carries the authoritative record, this is a
   * dashboard counter.
   */
  async recordConversion(eventId: EntityId, code: string): Promise<ReferralLink | null> {
    const link = await this.repo.findByCode(eventId, normalizeReferralCode(code));
    if (!link) return null;

    const converted = recordConversion(link, this.deps.config.clock.now());
    await this.repo.save(converted);
    return converted;
  }

  async resolveAttribution(
    eventId: EntityId,
    code: string,
  ): Promise<PromoterAttributionSnapshot | null> {
    const link = await this.repo.findByCode(eventId, normalizeReferralCode(code));
    if (
      !link ||
      !link.isActive ||
      !link.assignmentId ||
      !link.assignmentVersion ||
      !link.termsSnapshot ||
      !link.attributionSignature
    )
      return null;
    const snapshot: PromoterAttributionSnapshot = {
      referralLinkId: link.id,
      eventId: link.eventId,
      promoterId: link.promoterId,
      assignmentId: link.assignmentId,
      assignmentVersion: link.assignmentVersion,
      termsVersion: link.termsSnapshot.version,
      terms: link.termsSnapshot,
      code: link.code,
    };
    return verifyPromoterAttribution(
      snapshot,
      link.attributionSignature,
      this.deps.config.magicTicketSecret || 'dev-secret',
    )
      ? snapshot
      : null;
  }

  async resolveVanity(
    prefix: string,
    slug: string,
  ): Promise<{ eventSlug: string; code: string } | null> {
    const link = await this.repo.findByVanity(prefix, slug);
    if (!link || !link.isActive || !(await this.resolveAttribution(link.eventId, link.code)))
      return null;
    const event = await this.deps.repositories.events.getById(link.eventId);
    if (!event || !isPublicStatus(event.status)) return null;
    return { eventSlug: event.slug, code: link.code };
  }

  private async fetchOwned(actor: ActorContext, linkId: EntityId): Promise<ReferralLink> {
    const link = await this.repo.getById(linkId);
    if (
      !link ||
      (link.organizationId !== actor.organizationId && link.promoterId !== actor.organizationId)
    ) {
      throw new EventNotFoundError(linkId);
    }
    return link;
  }
}

export function signPromoterAttribution(
  snapshot: PromoterAttributionSnapshot,
  secret: string,
): string {
  return createHmac('sha256', secret).update(canonicalJson(snapshot)).digest('hex');
}

export function verifyPromoterAttribution(
  snapshot: PromoterAttributionSnapshot,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signPromoterAttribution(snapshot, secret), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
