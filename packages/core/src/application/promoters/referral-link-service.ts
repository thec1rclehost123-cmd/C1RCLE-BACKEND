import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { currentPromoterAgreement } from '../../config/index.js';
import {
  EventNotFoundError,
  InvalidOperationError,
  PromoterAssignmentNotFoundError,
} from '../../domain/errors.js';
import {
  COMMERCIAL_ALLOCATION_POLICY_VERSION,
  PROMOTER_COMMISSION_POLICY_VERSION,
  isPromoterAssignmentAttributable,
  type CommissionTerms,
  type PromoterAssignment,
} from '../../domain/models/event-catalog.js';
import { isPublicStatus } from '../../domain/models/event.js';
import { hasCurrentPromoterAgreementAcceptance } from '../../domain/models/promoter-agreement.js';
import {
  createReferralLink,
  deactivateReferralLink,
  generateReferralCode,
  isWithinReferralAttributionWindow,
  normalizeReferralCode,
  recordConversion,
} from '../../domain/models/referral-link.js';
import { emit, requireOrgAccess } from '../context.js';

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
  eligibleTierIds?: EntityId[] | null;
  commissionPolicyVersion?: string;
  commercialPolicyVersion?: string;
}

interface ReferralClickSelection {
  readonly code: string;
  readonly clickedAt: string;
  readonly clickId: string;
  readonly validAtClick: true;
}

interface ReferralClickContext {
  readonly eventId: EntityId;
  readonly selected: ReferralClickSelection | null;
  readonly updatedAt: string;
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

    const assignment = (await this.deps.repositories.catalog.listAssignments(command.eventId)).find(
      (candidate) =>
        candidate.promoterId === command.promoterId &&
        (candidate.status === 'accepted' || candidate.status === 'active'),
    );
    if (!assignment) {
      throw new PromoterAssignmentNotFoundError(
        `No accepted assignment for event ${command.eventId}`,
      );
    }
    const promoter = await this.deps.repositories.organizations.getById(command.promoterId);
    return this.createAssignedLink({
      assignment,
      event,
      promoterId: command.promoterId,
      organizationId: actor.organizationId,
      actor,
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
      (assignment.status !== 'accepted' && assignment.status !== 'active') ||
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
      actor,
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
    actor: ActorContext;
    label?: string;
    promoterName?: string;
    vanityPrefix?: string;
    requestedCode?: string;
    requestedVanitySlug?: string;
  }): Promise<ReferralLink> {
    const promoterOrganization = await this.deps.repositories.organizations.getById(
      input.promoterId,
    );
    if (
      promoterOrganization?.status !== 'active' ||
      !promoterOrganization.members.some((member) => member.capabilities.includes('promoter'))
    ) {
      throw new InvalidOperationError(
        'An active Promoter organization is required for campaign links',
      );
    }
    const onboarding = await this.deps.repositories.onboarding.findByProvisionedOrganizationId(
      input.promoterId,
    );
    if (
      !hasCurrentPromoterAgreementAcceptance(
        onboarding,
        currentPromoterAgreement(this.deps.config),
        this.testAgreementFixtureAllowed(),
      )
    ) {
      throw new InvalidOperationError(
        'Current Promoter agreement acceptance is required before creating campaign links',
      );
    }
    const id = `pl-${createHash('sha256').update(input.assignment.id).digest('hex').slice(0, 32)}`;
    const byAssignment = await this.repo.getById(id);
    if (byAssignment) {
      if (input.requestedCode && normalizeReferralCode(input.requestedCode) !== byAssignment.code) {
        throw new InvalidOperationError('The referral code is already set for this assignment');
      }
      return byAssignment;
    }

    const prior = await this.repo.findAnyByPromoter(input.promoterId);
    let proposed = input.requestedCode ?? prior?.code ?? generateReferralCode();
    let code: string | null = null;
    for (let attempt = 0; attempt < 6 && !code; attempt += 1) {
      const existing = await this.repo.findByCode(input.event.id, proposed);
      if (existing) {
        if (
          existing.promoterId === input.promoterId &&
          existing.assignmentId === input.assignment.id
        ) {
          return existing;
        }
        if (input.requestedCode) {
          throw new InvalidOperationError('That referral code is already in use for this event');
        }
        proposed = generateReferralCode();
        continue;
      }
      code = await this.repo.getOrCreateAssignmentCode(
        input.assignment.id,
        input.event.id,
        input.promoterId,
        proposed,
      );
      if (!code && !input.requestedCode) proposed = generateReferralCode();
    }
    if (!code) throw new InvalidOperationError('Could not reserve a unique referral code');
    if (input.requestedCode && normalizeReferralCode(input.requestedCode) !== code) {
      throw new InvalidOperationError('The referral code is already set for this assignment');
    }
    const globalClash = await this.repo.findByCodeGlobal(code);
    if (globalClash && globalClash.promoterId !== input.promoterId) {
      throw new InvalidOperationError('That promoter code is already in use');
    }
    if (!globalClash && !(await this.repo.claimGlobalCode(code, input.promoterId))) {
      throw new InvalidOperationError('That promoter code is already in use');
    }
    const canonical = {
      referralLinkId: id,
      eventId: input.event.id,
      promoterId: input.promoterId,
      assignmentId: input.assignment.id,
      assignmentVersion: input.assignment.version,
      termsVersion: input.assignment.terms.version,
      terms: input.assignment.terms,
      code,
      eligibleTierIds: input.assignment.eligibleTierIds ?? [],
      commissionPolicyVersion: PROMOTER_COMMISSION_POLICY_VERSION,
      commercialPolicyVersion: COMMERCIAL_ALLOCATION_POLICY_VERSION,
    } satisfies PromoterAttributionSnapshot;
    const signature = signPromoterAttribution(canonical, this.deps.config.magicTicketSecret);
    const vanityBase =
      (input.requestedVanitySlug ?? input.event.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, input.requestedVanitySlug ? 60 : 35) || 'event';
    const vanitySlug = input.requestedVanitySlug
      ? vanityBase
      : `${vanityBase}-${randomBytes(12).toString('hex')}`;
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
      eligibleTierIds: input.assignment.eligibleTierIds ?? [],
      commissionPolicyVersion: PROMOTER_COMMISSION_POLICY_VERSION,
      commercialPolicyVersion: COMMERCIAL_ALLOCATION_POLICY_VERSION,
      attributionSignature: signature,
      eventTitle: input.event.title,
      vanityPrefix: input.vanityPrefix,
      vanitySlug,
      code,
      label: input.label ?? 'organic',
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(link);
    await emit(this.deps, input.actor, link.id, 'promoter.campaign.activated', {
      referralLinkId: link.id,
      eventId: input.event.id,
      promoterId: input.promoterId,
      eventTitle: input.event.title,
    });
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
    requireOrgAccess(actor, promoterId);
    return this.repo.listByPromoter(promoterId, query);
  }

  /** Privacy-safe attributed-order projection; ownership comes from the signed order snapshot. */
  async listAttributedOrders(actor: ActorContext, promoterId: EntityId, query: PaginationQuery) {
    requireOrgAccess(actor, promoterId);
    return this.deps.repositories.orders.listByPromoter(promoterId, query);
  }

  /** Organizer view: authorize the event first, then read only its immutable attributed orders. */
  async listAttributedOrdersForEvent(
    actor: ActorContext,
    eventId: EntityId,
    promoterId: EntityId,
    query: PaginationQuery,
  ) {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      throw new EventNotFoundError(eventId);
    }
    return this.deps.repositories.orders.listByPromoterForEvent(promoterId, eventId, query);
  }

  async getCampaignSummary(actor: ActorContext, promoterId: EntityId) {
    requireOrgAccess(actor, promoterId);
    const [links, orders, transition] = await Promise.all([
      this.repo.listByPromoter(promoterId, { limit: 1000, cursor: null }),
      this.deps.repositories.orders.listByPromoter(promoterId, { limit: 1000, cursor: null }),
      this.deps.repositories.journalTransition.get(),
    ]);
    const historicallyAttributedOrders = orders.items.filter(
      (order) =>
        order.attribution?.promoterId === promoterId &&
        (order.status === 'paid' ||
          order.status === 'refund_requested' ||
          order.status === 'refunded' ||
          order.id.startsWith('RSVP-')),
    );
    const attributedSales = historicallyAttributedOrders.filter(
      (order) => !order.id.startsWith('RSVP-'),
    );
    let refundValueComplete = true;
    let refundedAttributedTicketRevenuePaise = 0;
    let reversedCommissionPaise = 0;
    for (const order of attributedSales) {
      if (order.refundedPaise <= 0) continue;
      const refundJournals = (
        await this.deps.repositories.financialJournals.findByOrderId(order.id)
      ).filter((journal) => journal.source.type === 'refund');
      const recognitions = refundJournals.filter((journal) =>
        journal.idempotencyKey.endsWith(':recognition'),
      );
      if (recognitions.length === 0) {
        refundValueComplete = false;
        continue;
      }
      refundedAttributedTicketRevenuePaise += recognitions.reduce(
        (sum, journal) =>
          sum +
          (journal.components?.refundedAdmissionPaise ??
            journal.lines
              .filter(
                (line) => line.side === 'debit' && line.account === 'ticket_collection_control',
              )
              .reduce((total, line) => total + line.amountPaise, 0)),
        0,
      );
      if (transition.readModel === 'financial_journal_v2') {
        reversedCommissionPaise += refundJournals
          .filter((journal) => journal.idempotencyKey.endsWith(':payable-reversal'))
          .flatMap((journal) => journal.lines)
          .filter(
            (line) =>
              line.side === 'debit' &&
              line.account === 'promoter_payable' &&
              line.organizationId === promoterId,
          )
          .reduce((sum, line) => sum + line.amountPaise, 0);
      }
    }
    const grossAttributedTicketRevenuePaise = attributedSales.reduce(
      (sum, order) => sum + order.discountedSubtotalPaise,
      0,
    );
    const summary = {
      linkCount: links.items.length,
      clicks: links.items.reduce((sum, link) => sum + link.clicks, 0),
      conversions: historicallyAttributedOrders.length,
      historicalRsvpConversions: historicallyAttributedOrders.filter((order) =>
        order.id.startsWith('RSVP-'),
      ).length,
      activeRsvpCount: historicallyAttributedOrders.filter(
        (order) => order.id.startsWith('RSVP-') && order.status === 'paid',
      ).length,
      grossAttributedTicketRevenuePaise,
      grossAttributedTicketSalesPaise: grossAttributedTicketRevenuePaise,
      refundedAttributedTicketSalesPaise: refundedAttributedTicketRevenuePaise,
      netAttributedTicketSalesPaise: Math.max(
        0,
        grossAttributedTicketRevenuePaise - refundedAttributedTicketRevenuePaise,
      ),
      refundValueComplete,
      recordedCommissionPaise: attributedSales.reduce(
        (sum, order) => sum + (order.attribution?.promoterCommissionPaise ?? 0),
        0,
      ),
      reversedCommissionPaise:
        transition.readModel === 'financial_journal_v2' ? reversedCommissionPaise : null,
      complete: links.nextCursor === null && orders.nextCursor === null && refundValueComplete,
      hasMoreLinks: links.nextCursor !== null,
      hasMoreOrders: orders.nextCursor !== null,
    };
    return summary;
  }

  async deactivate(actor: ActorContext, linkId: EntityId): Promise<ReferralLink> {
    const link = await this.fetchOwned(actor, linkId);
    const deactivated = deactivateReferralLink(link, this.deps.config.clock.now());
    await this.repo.save(deactivated);
    if (link.isActive && !deactivated.isActive) {
      await emit(this.deps, actor, link.id, 'promoter.campaign.revoked', {
        referralLinkId: link.id,
        eventId: link.eventId,
        promoterId: link.promoterId,
        eventTitle: link.eventTitle,
      });
    }
    return deactivated;
  }

  /**
   * Resolves a shared code and counts the click. Returns `null` for an unknown
   * or inactive code rather than throwing: a mistyped link on a flyer is an
   * ordinary event, not an error worth a 500 in the guest path.
   */
  async trackClick(eventId: EntityId, code: string, clickId: string): Promise<ReferralLink | null> {
    const link = await this.repo.findByCode(eventId, normalizeReferralCode(code));
    if (!link || !link.isActive) return null;
    const now = this.deps.config.clock.now();
    if (!(await this.resolveAttribution(eventId, code, undefined, now))) return null;
    if (!(await this.repo.recordClick(link.id, clickId, now))) return null;
    return this.repo.getById(link.id);
  }

  /**
   * Issues a signed, event-bound click context for every request. The token
   * shape does not reveal whether the referral code was valid; all current
   * eligibility is rechecked when checkout or RSVP consumes it.
   */
  async updateClickContext(
    eventId: EntityId,
    code: string,
    clickId: string,
    previousToken?: string,
  ): Promise<string> {
    const now = this.deps.config.clock.now();
    // Always pass the untrusted value through signature verification. Missing
    // context is represented by an empty invalid token, never a skipped check.
    const previous = this.verifyClickContext(previousToken ?? '');
    let selected =
      previous?.eventId === eventId &&
      previous.selected &&
      now.getTime() - Date.parse(previous.selected.clickedAt) <= 7 * 24 * 60 * 60 * 1000 &&
      now.getTime() >= Date.parse(previous.selected.clickedAt)
        ? previous.selected
        : null;
    if (await this.resolveAttribution(eventId, code, undefined, now)) {
      selected = {
        code: normalizeReferralCode(code),
        clickedAt: now.toISOString(),
        clickId,
        validAtClick: true,
      };
    }
    const payload: ReferralClickContext = { eventId, selected, updatedAt: now.toISOString() };
    const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
    const signature = createHmac('sha256', this.deps.config.magicTicketSecret)
      .update(encoded)
      .digest('hex');
    return `${encoded}.${signature}`;
  }

  /** Latest valid event-specific click wins; invalid/revoked candidates fall through. */
  async resolveClickContexts(
    eventId: EntityId,
    tokens: readonly string[],
    guestUserId?: EntityId,
  ): Promise<PromoterAttributionSnapshot | null> {
    const contexts = tokens
      .slice(0, 20)
      .map((token) => this.verifyClickContext(token))
      .filter((context): context is ReferralClickContext => context !== null)
      .filter((context) => context.eventId === eventId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    for (const context of contexts) {
      if (!context.selected) continue;
      const clickedAt = new Date(context.selected.clickedAt);
      if (!Number.isFinite(clickedAt.getTime())) continue;
      const now = this.deps.config.clock.now();
      const age = now.getTime() - clickedAt.getTime();
      if (age < 0 || age > 7 * 24 * 60 * 60 * 1000) continue;
      const attribution = await this.resolveAttribution(
        eventId,
        context.selected.code,
        guestUserId,
        clickedAt,
      );
      if (attribution) return attribution;
    }
    return null;
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
    guestUserId?: EntityId,
    interactionAt?: Date,
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
    const now = this.deps.config.clock.now();
    if (interactionAt) {
      const age = now.getTime() - interactionAt.getTime();
      if (age < 0 || age > 7 * 24 * 60 * 60 * 1000) return null;
    } else if (!isWithinReferralAttributionWindow(link, now)) return null;
    const assignment = await this.deps.repositories.catalog.getAssignmentById(link.assignmentId);
    if (
      !assignment ||
      assignment.eventId !== eventId ||
      assignment.promoterId !== link.promoterId ||
      assignment.version !== link.assignmentVersion ||
      assignment.terms.version !== link.termsSnapshot.version ||
      !isPromoterAssignmentAttributable(assignment, now)
    ) {
      return null;
    }
    const promoterOrganization = await this.deps.repositories.organizations.getById(
      link.promoterId,
    );
    if (
      promoterOrganization?.status !== 'active' ||
      !promoterOrganization.members.some((member) => member.capabilities.includes('promoter'))
    ) {
      return null;
    }
    const onboarding = await this.deps.repositories.onboarding.findByProvisionedOrganizationId(
      link.promoterId,
    );
    if (
      !hasCurrentPromoterAgreementAcceptance(
        onboarding,
        currentPromoterAgreement(this.deps.config),
        this.testAgreementFixtureAllowed(),
      )
    )
      return null;
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event || (event.status !== 'published' && event.status !== 'started')) return null;
    if (guestUserId) {
      const memberships = await this.deps.repositories.organizations.listForMember(guestUserId, {
        limit: 100,
        cursor: null,
      });
      if (memberships.items.some((organization) => organization.id === link.promoterId))
        return null;
    }
    const tiers = await this.deps.repositories.catalog.listTiers(eventId);
    const eligibleTiers = tiers.filter(
      (tier) => !link.eligibleTierIds?.length || link.eligibleTierIds.includes(tier.id),
    );
    if (
      eligibleTiers.length > 0 &&
      eligibleTiers.every((tier) => tier.salesEndAt && Date.parse(tier.salesEndAt) <= now.getTime())
    ) {
      return null;
    }
    const snapshot: PromoterAttributionSnapshot = {
      referralLinkId: link.id,
      eventId: link.eventId,
      promoterId: link.promoterId,
      assignmentId: link.assignmentId,
      assignmentVersion: link.assignmentVersion,
      termsVersion: link.termsSnapshot.version,
      terms: link.termsSnapshot,
      code: link.code,
      ...(link.commissionPolicyVersion
        ? {
            eligibleTierIds: link.eligibleTierIds ?? [],
            commissionPolicyVersion: link.commissionPolicyVersion,
            commercialPolicyVersion:
              link.commercialPolicyVersion ?? COMMERCIAL_ALLOCATION_POLICY_VERSION,
          }
        : {}),
    };
    return verifyPromoterAttribution(
      snapshot,
      link.attributionSignature,
      this.deps.config.magicTicketSecret,
    )
      ? snapshot
      : null;
  }

  async resolveVanity(
    prefix: string,
    slug: string,
  ): Promise<{ eventSlug: string; code: string } | null> {
    const link = await this.repo.findByVanity(prefix, slug);
    if (
      !link ||
      !link.isActive ||
      !(await this.resolveAttribution(
        link.eventId,
        link.code,
        undefined,
        this.deps.config.clock.now(),
      ))
    )
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

  private testAgreementFixtureAllowed(): boolean {
    return this.deps.config.features.m4PromoterAgreementFixture === true;
  }

  private verifyClickContext(token: string): ReferralClickContext | null {
    const [encoded, suppliedSignature, extra] = token.split('.');
    if (
      !encoded ||
      !suppliedSignature ||
      extra !== undefined ||
      !/^[a-f0-9]{64}$/iu.test(suppliedSignature)
    )
      return null;
    const expected = createHmac('sha256', this.deps.config.magicTicketSecret)
      .update(encoded)
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(suppliedSignature, 'hex');
    } catch {
      return null;
    }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('eventId' in parsed) ||
        typeof parsed.eventId !== 'string' ||
        !('updatedAt' in parsed) ||
        typeof parsed.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(parsed.updatedAt)) ||
        !('selected' in parsed) ||
        !(parsed.selected === null || isReferralClickSelection(parsed.selected))
      ) {
        return null;
      }
      return {
        eventId: parsed.eventId,
        selected:
          parsed.selected === null
            ? null
            : {
                code: parsed.selected.code,
                clickedAt: parsed.selected.clickedAt,
                clickId: parsed.selected.clickId,
                validAtClick: true,
              },
        updatedAt: parsed.updatedAt,
      };
    } catch {
      return null;
    }
  }
}

function isReferralClickSelection(value: unknown): value is ReferralClickSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'clickedAt' in value &&
    typeof value.clickedAt === 'string' &&
    Number.isFinite(Date.parse(value.clickedAt)) &&
    'clickId' in value &&
    typeof value.clickId === 'string' &&
    'validAtClick' in value &&
    value.validAtClick === true
  );
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
