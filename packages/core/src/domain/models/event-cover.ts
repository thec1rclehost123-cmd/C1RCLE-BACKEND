import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * M5 cover is a single-event credit attached to one admission entitlement.
 * These domain transitions do not enable sales or redemption; runtime policy
 * and merchant approval are separate server-side gates.
 */
export type EventCoverStatus = 'pending_activation' | 'active' | 'frozen' | 'closed' | 'refunded';

export type EventCoverEntryType =
  'issuance' | 'reserve' | 'capture' | 'void' | 'refund' | 'reversal';

export type EventCoverAlcoholRule = 'exclude_alcohol' | 'age_restricted' | 'no_alcohol';
export type EventCoverRefundPolicy = 'unused_full_before_redemption' | 'saved_policy_review';
export type EventCoverRedemptionChallengeStatus = 'pending' | 'confirmed' | 'consumed' | 'expired';

export interface EventCoverRedemptionChallenge extends VersionedEntity {
  id: EntityId;
  accountId: EntityId;
  entitlementId: EntityId;
  eventId: EntityId;
  venueOrganizationId: EntityId;
  guestUserId: EntityId;
  initiatedByUserId: EntityId;
  terminalId: EntityId;
  amountPaise: number;
  grossSpendPaise: number;
  categories: readonly string[];
  containsAlcohol: boolean;
  receiptReference: string;
  status: EventCoverRedemptionChallengeStatus;
  expiresAt: string;
  confirmedAt: string | null;
  consumedAt: string | null;
}

export function confirmEventCoverRedemptionChallenge(
  challenge: EventCoverRedemptionChallenge,
  guestUserId: EntityId,
  now: Date,
): EventCoverRedemptionChallenge {
  if (
    challenge.status !== 'pending' ||
    challenge.guestUserId !== guestUserId ||
    Date.parse(challenge.expiresAt) <= now.getTime()
  ) {
    throw new InvalidOperationError('Cover redemption confirmation is invalid or expired');
  }
  return bumpVersion({ ...challenge, status: 'confirmed', confirmedAt: now.toISOString() }, now);
}

export function consumeEventCoverRedemptionChallenge(
  challenge: EventCoverRedemptionChallenge,
  now: Date,
): EventCoverRedemptionChallenge {
  if (challenge.status !== 'confirmed' || Date.parse(challenge.expiresAt) <= now.getTime()) {
    throw new InvalidOperationError('Only a live Guest-confirmed cover challenge can be consumed');
  }
  return bumpVersion({ ...challenge, status: 'consumed', consumedAt: now.toISOString() }, now);
}

export function expireEventCoverRedemptionChallenge(
  challenge: EventCoverRedemptionChallenge,
  now: Date,
): EventCoverRedemptionChallenge {
  if (challenge.status === 'expired') return challenge;
  if (
    (challenge.status !== 'pending' && challenge.status !== 'confirmed') ||
    Date.parse(challenge.expiresAt) > now.getTime()
  ) {
    throw new InvalidOperationError('Only an elapsed pending cover request can expire');
  }
  return bumpVersion({ ...challenge, status: 'expired' }, now);
}

/** Versioned commercial terms. This schema records choices; it grants no legal approval. */
export interface EventCoverPolicyTerms {
  eventId: EntityId;
  venueOrganizationId: EntityId;
  merchantOrganizationId: EntityId;
  coverAmountPaise: number;
  minimumSpendPaise: number;
  redemptionOpensAt: string;
  redemptionClosesAt: string;
  eligibleCategories: readonly string[];
  excludedCategories: readonly string[];
  alcoholRule: EventCoverAlcoholRule;
  partialRedemption: boolean;
  splitTender: boolean;
  refundPolicy: EventCoverRefundPolicy;
  transferUnusedOnly: true;
  commissionBasis: 'net_admission_after_allocated_discount';
  unusedBalancePolicy: 'approved_minimum_spend_expiry';
}

export interface EventCoverPolicyProposal extends VersionedEntity {
  id: EntityId;
  hostOrganizationId: EntityId;
  venueOrganizationId: EntityId;
  proposedByUserId: EntityId;
  policyVersion: string;
  terms: EventCoverPolicyTerms;
  termsDigest: string;
}

export interface EventCoverPolicyAcceptance extends VersionedEntity {
  id: EntityId;
  proposalId: EntityId;
  eventId: EntityId;
  hostOrganizationId: EntityId;
  venueOrganizationId: EntityId;
  acceptedByUserId: EntityId;
  proposalVersion: string;
  termsDigest: string;
}

function coverTermsDigest(terms: EventCoverPolicyTerms): string {
  const canonical = {
    eventId: terms.eventId,
    venueOrganizationId: terms.venueOrganizationId,
    merchantOrganizationId: terms.merchantOrganizationId,
    coverAmountPaise: terms.coverAmountPaise,
    minimumSpendPaise: terms.minimumSpendPaise,
    redemptionOpensAt: new Date(terms.redemptionOpensAt).toISOString(),
    redemptionClosesAt: new Date(terms.redemptionClosesAt).toISOString(),
    eligibleCategories: [...terms.eligibleCategories].sort(),
    excludedCategories: [...terms.excludedCategories].sort(),
    alcoholRule: terms.alcoholRule,
    partialRedemption: terms.partialRedemption,
    splitTender: terms.splitTender,
    refundPolicy: terms.refundPolicy,
    transferUnusedOnly: terms.transferUnusedOnly,
    commissionBasis: terms.commissionBasis,
    unusedBalancePolicy: terms.unusedBalancePolicy,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function proposeEventCoverPolicy(input: {
  id: EntityId;
  hostOrganizationId: EntityId;
  venueOrganizationId: EntityId;
  proposedByUserId: EntityId;
  policyVersion: string;
  terms: EventCoverPolicyTerms;
  now?: Date;
}): EventCoverPolicyProposal {
  assertPositivePaise(input.terms.coverAmountPaise);
  assertPositivePaise(input.terms.minimumSpendPaise);
  const opens = Date.parse(input.terms.redemptionOpensAt);
  const closes = Date.parse(input.terms.redemptionClosesAt);
  if (
    !Number.isFinite(opens) ||
    !Number.isFinite(closes) ||
    closes <= opens ||
    !input.policyVersion.trim() ||
    input.terms.venueOrganizationId !== input.venueOrganizationId ||
    !input.hostOrganizationId ||
    !input.proposedByUserId
  ) {
    throw new InvalidOperationError('Cover policy proposal is incomplete or inconsistent');
  }
  const now = input.now ?? new Date();
  return {
    ...newVersionedEntity(now),
    id: input.id,
    hostOrganizationId: input.hostOrganizationId,
    venueOrganizationId: input.venueOrganizationId,
    proposedByUserId: input.proposedByUserId,
    policyVersion: input.policyVersion,
    terms: { ...input.terms },
    termsDigest: coverTermsDigest(input.terms),
  };
}

/** Venue acceptance is bound to the exact proposal id, version and terms digest. */
export function acceptEventCoverPolicy(input: {
  id: EntityId;
  proposal: EventCoverPolicyProposal;
  acceptingVenueOrganizationId: EntityId;
  acceptedByUserId: EntityId;
  now?: Date;
}): EventCoverPolicyAcceptance {
  if (
    input.acceptingVenueOrganizationId !== input.proposal.venueOrganizationId ||
    input.acceptingVenueOrganizationId !== input.proposal.terms.venueOrganizationId ||
    !input.acceptedByUserId
  ) {
    throw new InvalidOperationError('Only the participating Venue can accept this cover policy');
  }
  const now = input.now ?? new Date();
  return {
    ...newVersionedEntity(now),
    id: input.id,
    proposalId: input.proposal.id,
    eventId: input.proposal.terms.eventId,
    hostOrganizationId: input.proposal.hostOrganizationId,
    venueOrganizationId: input.acceptingVenueOrganizationId,
    acceptedByUserId: input.acceptedByUserId,
    proposalVersion: input.proposal.policyVersion,
    termsDigest: input.proposal.termsDigest,
  };
}

export function isEventCoverPolicyAccepted(
  proposal: EventCoverPolicyProposal,
  acceptance: EventCoverPolicyAcceptance | null,
): boolean {
  return Boolean(
    acceptance &&
    acceptance.proposalId === proposal.id &&
    acceptance.eventId === proposal.terms.eventId &&
    acceptance.hostOrganizationId === proposal.hostOrganizationId &&
    acceptance.venueOrganizationId === proposal.venueOrganizationId &&
    acceptance.proposalVersion === proposal.policyVersion &&
    acceptance.termsDigest === proposal.termsDigest,
  );
}

export interface EventCoverAccount extends VersionedEntity {
  id: EntityId;
  entitlementId: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  guestUserId: EntityId | null;
  hostOrganizationId: EntityId;
  venueOrganizationId: EntityId;
  currency: 'INR';
  issuedPaise: number;
  remainingPaise: number;
  reservedPaise: number;
  redeemedPaise: number;
  refundedPaise: number;
  status: EventCoverStatus;
  /** Refund request holding redemption while an approved provider refund settles. */
  refundRequestId?: EntityId | null;
  /** Immutable refund rule copied from the Venue policy accepted at checkout. */
  refundPolicy: EventCoverRefundPolicy;
  policyVersion: string;
}

/** Moves unused per-ticket cover with its ticket after an ownership transfer. */
export function transferEventCoverHolder(
  account: EventCoverAccount,
  expectedCurrentHolderId: EntityId | null,
  nextHolderId: EntityId,
  now: Date = new Date(),
): EventCoverAccount {
  if (account.guestUserId === nextHolderId) return account;
  if (
    account.guestUserId !== expectedCurrentHolderId ||
    (account.status !== 'active' && account.status !== 'pending_activation') ||
    account.reservedPaise > 0 ||
    account.redeemedPaise > 0
  ) {
    throw new InvalidOperationError(
      'Unused cover cannot transfer while ownership or redemption is locked',
    );
  }
  return {
    ...bumpVersion(account, now),
    guestUserId: nextHolderId,
  };
}

export interface EventCoverEntry extends VersionedEntity {
  id: EntityId;
  accountId: EntityId;
  entitlementId: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  venueOrganizationId: EntityId;
  type: EventCoverEntryType;
  amountPaise: number;
  operationId: EntityId;
  actorUserId: EntityId | null;
  terminalId: EntityId | null;
  receiptReference: string | null;
  policyVersion: string;
  reversesEntryId: EntityId | null;
  /** Required reason for an authorized accounting correction, immutable with the reversal. */
  reason?: string;
}

export interface EventCoverReconciliation {
  readonly accountId: EntityId;
  readonly issuedPaise: number;
  readonly expectedRemainingPaise: number;
  readonly expectedReservedPaise: number;
  readonly expectedRedeemedPaise: number;
  readonly expectedRefundedPaise: number;
  readonly actualRemainingPaise: number;
  readonly actualReservedPaise: number;
  readonly actualRedeemedPaise: number;
  readonly actualRefundedPaise: number;
  readonly entryCount: number;
  readonly balanced: boolean;
  readonly discrepancies: readonly string[];
}

/**
 * Rebuilds the current account totals from immutable cover facts. This is a
 * read-only check, not a balance repair or an accounting journal.
 */
export function reconcileEventCoverAccount(
  account: EventCoverAccount,
  entries: readonly EventCoverEntry[],
): EventCoverReconciliation {
  const discrepancies: string[] = [];
  const byId = new Map<EntityId, EventCoverEntry>();
  const byOperation = new Map<EntityId, EventCoverEntry[]>();
  for (const entry of entries) {
    if (byId.has(entry.id)) discrepancies.push(`duplicate entry id ${entry.id}`);
    byId.set(entry.id, entry);
    if (
      entry.accountId !== account.id ||
      entry.entitlementId !== account.entitlementId ||
      entry.orderId !== account.orderId ||
      entry.eventId !== account.eventId ||
      entry.venueOrganizationId !== account.venueOrganizationId ||
      entry.policyVersion !== account.policyVersion
    ) {
      discrepancies.push(`entry ${entry.id} does not match account provenance`);
    }
    if (!Number.isSafeInteger(entry.amountPaise) || entry.amountPaise <= 0) {
      discrepancies.push(`entry ${entry.id} has an invalid amount`);
    }
    const operationEntries = byOperation.get(entry.operationId) ?? [];
    operationEntries.push(entry);
    byOperation.set(entry.operationId, operationEntries);
  }

  const issuanceEntries = entries.filter((entry) => entry.type === 'issuance');
  if (
    issuanceEntries.length !== 1 ||
    issuanceEntries[0]?.amountPaise !== account.issuedPaise ||
    issuanceEntries[0]?.operationId !== account.entitlementId
  ) {
    discrepancies.push('issuance fact is missing, duplicated, or differs from the account');
  }

  let expectedReservedPaise = 0;
  let expectedRedeemedPaise = 0;
  let expectedRefundedPaise = 0;
  const reservations = new Map<EntityId, EventCoverEntry>();
  const resolutions = new Set<EntityId>();
  const captures = new Map<EntityId, EventCoverEntry>();
  const reversedCaptures = new Set<EntityId>();
  for (const entry of entries) {
    if (entry.type === 'reserve') {
      if (reservations.has(entry.id)) discrepancies.push(`duplicate reservation ${entry.id}`);
      reservations.set(entry.id, entry);
      expectedReservedPaise += entry.amountPaise;
    }
  }
  for (const entry of entries) {
    if (entry.type !== 'capture' && entry.type !== 'void') continue;
    const reservation = entry.reversesEntryId ? reservations.get(entry.reversesEntryId) : undefined;
    if (
      !reservation ||
      reservation.operationId !== entry.operationId ||
      reservation.amountPaise !== entry.amountPaise ||
      resolutions.has(reservation.id)
    ) {
      discrepancies.push(`entry ${entry.id} does not resolve one matching reservation`);
      continue;
    }
    resolutions.add(reservation.id);
    expectedReservedPaise -= reservation.amountPaise;
    if (entry.type === 'capture') {
      expectedRedeemedPaise += entry.amountPaise;
      captures.set(entry.id, entry);
    }
  }

  for (const entry of entries) {
    if (entry.type === 'refund') {
      const reversesIssuance = entry.reversesEntryId
        ? issuanceEntries.find((issuance) => issuance.id === entry.reversesEntryId)
        : undefined;
      if (!reversesIssuance || reversesIssuance.operationId !== account.entitlementId) {
        discrepancies.push(`refund ${entry.id} does not reference this account's issuance`);
        continue;
      }
      expectedRefundedPaise += entry.amountPaise;
    }
    if (entry.type === 'reversal') {
      const capture = entry.reversesEntryId ? captures.get(entry.reversesEntryId) : undefined;
      if (
        !capture ||
        capture.amountPaise !== entry.amountPaise ||
        reversedCaptures.has(capture.id)
      ) {
        discrepancies.push(`reversal ${entry.id} does not match one unreversed capture`);
        continue;
      }
      reversedCaptures.add(capture.id);
      expectedRedeemedPaise -= capture.amountPaise;
    }
  }

  for (const [operationId, operationEntries] of byOperation) {
    if (operationEntries.filter((entry) => entry.type === 'reserve').length > 1) {
      discrepancies.push(`operation ${operationId} has multiple reservations`);
    }
    if (
      operationEntries.some((entry) => entry.type === 'issuance') &&
      operationId !== account.entitlementId
    ) {
      discrepancies.push('issuance operation id does not match entitlement');
    }
  }

  if (
    expectedReservedPaise < 0 ||
    expectedRedeemedPaise < 0 ||
    expectedRedeemedPaise + expectedRefundedPaise > account.issuedPaise ||
    expectedReservedPaise > account.issuedPaise - expectedRedeemedPaise - expectedRefundedPaise
  ) {
    discrepancies.push('ledger totals exceed the issued cover');
  }
  const expectedRemainingPaise =
    account.issuedPaise - expectedRedeemedPaise - expectedRefundedPaise;
  if (expectedReservedPaise !== account.reservedPaise) {
    discrepancies.push('reserved balance differs from ledger facts');
  }
  if (expectedRedeemedPaise !== account.redeemedPaise) {
    discrepancies.push('redeemed balance differs from ledger facts');
  }
  if (expectedRefundedPaise !== account.refundedPaise) {
    discrepancies.push('refunded balance differs from ledger facts');
  }
  if (expectedRemainingPaise !== account.remainingPaise) {
    discrepancies.push('remaining balance differs from ledger facts');
  }
  return {
    accountId: account.id,
    issuedPaise: account.issuedPaise,
    expectedRemainingPaise,
    expectedReservedPaise,
    expectedRedeemedPaise,
    expectedRefundedPaise,
    actualRemainingPaise: account.remainingPaise,
    actualReservedPaise: account.reservedPaise,
    actualRedeemedPaise: account.redeemedPaise,
    actualRefundedPaise: account.refundedPaise,
    entryCount: byId.size,
    balanced: discrepancies.length === 0,
    discrepancies,
  };
}

export interface CreateEventCoverAccountInput {
  entitlementId: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  guestUserId: EntityId | null;
  hostOrganizationId: EntityId;
  venueOrganizationId: EntityId;
  amountPaise: number;
  providerCaptureConfirmed: boolean;
  merchantApproved: boolean;
  policyVersion: string;
  refundPolicy: EventCoverRefundPolicy;
  activationApproved: boolean;
  now?: Date;
}

export function eventCoverEntryId(
  accountId: EntityId,
  operationId: EntityId,
  type: 'issuance' | 'reserve' | 'capture' | 'void' | 'refund' | 'reversal',
): EntityId {
  const digest = createHash('sha256')
    .update(`${accountId}:${operationId}:${type}`)
    .digest('hex')
    .slice(0, 32);
  return `ECE-${digest}`;
}

function assertPositivePaise(amountPaise: number): void {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new InvalidOperationError('Cover amounts must be positive whole paise');
  }
}

export function eventCoverAccountId(entitlementId: EntityId): EntityId {
  const digest = createHash('sha256').update(`m5:event-cover:${entitlementId}`).digest('hex');
  return `ECA-${digest.slice(0, 32)}`;
}

/** Storage adapters must not accept a mutated/partially spent account as issuance. */
export function assertEventCoverAccountForIssuance(account: EventCoverAccount): void {
  if (
    account.id !== eventCoverAccountId(account.entitlementId) ||
    !account.entitlementId ||
    !account.orderId ||
    !account.eventId ||
    !account.hostOrganizationId ||
    !account.venueOrganizationId ||
    !account.policyVersion.trim() ||
    account.currency !== 'INR' ||
    !Number.isSafeInteger(account.issuedPaise) ||
    account.issuedPaise <= 0 ||
    (account.refundPolicy !== 'unused_full_before_redemption' &&
      account.refundPolicy !== 'saved_policy_review') ||
    account.remainingPaise !== account.issuedPaise ||
    account.reservedPaise !== 0 ||
    account.redeemedPaise !== 0 ||
    account.refundedPaise !== 0 ||
    account.refundRequestId != null ||
    (account.status !== 'active' && account.status !== 'pending_activation') ||
    account.version !== 1 ||
    !Number.isFinite(Date.parse(account.createdAt)) ||
    !Number.isFinite(Date.parse(account.updatedAt))
  ) {
    throw new InvalidOperationError('Event cover account is not a valid initial issuance');
  }
}

/** Creates exactly one account for a captured, approved cover sale per ticket. */
export function createEventCoverAccount(input: CreateEventCoverAccountInput): EventCoverAccount {
  assertPositivePaise(input.amountPaise);
  if (!input.entitlementId || !input.orderId || !input.eventId) {
    throw new InvalidOperationError('Cover must be linked to an admission entitlement and order');
  }
  if (!input.providerCaptureConfirmed) {
    throw new InvalidOperationError('Cover can only be issued after confirmed payment capture');
  }
  if (!input.merchantApproved) {
    throw new InvalidOperationError('Cover requires an approved participating merchant');
  }
  if (!input.policyVersion.trim()) {
    throw new InvalidOperationError('Cover requires a versioned accepted policy');
  }
  const now = input.now ?? new Date();
  return {
    ...newVersionedEntity(now),
    id: eventCoverAccountId(input.entitlementId),
    entitlementId: input.entitlementId,
    orderId: input.orderId,
    eventId: input.eventId,
    guestUserId: input.guestUserId,
    hostOrganizationId: input.hostOrganizationId,
    venueOrganizationId: input.venueOrganizationId,
    currency: 'INR',
    issuedPaise: input.amountPaise,
    remainingPaise: input.amountPaise,
    reservedPaise: 0,
    redeemedPaise: 0,
    refundedPaise: 0,
    status: input.activationApproved ? 'active' : 'pending_activation',
    refundRequestId: null,
    refundPolicy: input.refundPolicy,
    policyVersion: input.policyVersion,
  };
}

/** Full refund is allowed only by the accepted policy, before any redemption. */
export function refundUnusedEventCover(
  account: EventCoverAccount,
  input: {
    operationId: EntityId;
    actorUserId: EntityId | null;
    refundRequestId: EntityId;
    now?: Date;
  },
): { account: EventCoverAccount; entry: EventCoverEntry } {
  if (!input.operationId || !input.actorUserId || input.operationId !== input.refundRequestId) {
    throw new InvalidOperationError('Cover refund requires an authorized actor and operation id');
  }
  if (account.refundPolicy !== 'unused_full_before_redemption') {
    throw new InvalidOperationError('This cover policy requires a manual refund review');
  }
  if (
    account.status !== 'frozen' ||
    account.refundRequestId !== input.refundRequestId ||
    account.reservedPaise !== 0 ||
    account.redeemedPaise !== 0 ||
    account.refundedPaise !== 0 ||
    account.remainingPaise !== account.issuedPaise
  ) {
    throw new InvalidOperationError('Only fully unused cover can be refunded under this policy');
  }
  const now = input.now ?? new Date();
  const entry: EventCoverEntry = {
    ...newVersionedEntity(now),
    id: eventCoverEntryId(account.id, input.operationId, 'refund'),
    accountId: account.id,
    entitlementId: account.entitlementId,
    orderId: account.orderId,
    eventId: account.eventId,
    venueOrganizationId: account.venueOrganizationId,
    type: 'refund',
    amountPaise: account.issuedPaise,
    operationId: input.operationId,
    actorUserId: input.actorUserId,
    terminalId: null,
    receiptReference: null,
    policyVersion: account.policyVersion,
    reversesEntryId: eventCoverEntryId(account.id, account.entitlementId, 'issuance'),
  };
  return {
    account: {
      ...bumpVersion(account, now),
      remainingPaise: 0,
      refundedPaise: account.issuedPaise,
      status: 'refunded',
      refundRequestId: null,
    },
    entry,
  };
}

/** Locks redemption for one exact Admin refund request before provider execution. */
export function freezeUnusedEventCoverForRefund(
  account: EventCoverAccount,
  refundRequestId: EntityId,
  now: Date = new Date(),
): EventCoverAccount {
  if (!refundRequestId) throw new InvalidOperationError('A cover refund request id is required');
  if (account.status === 'frozen' && account.refundRequestId === refundRequestId) return account;
  if (account.refundPolicy !== 'unused_full_before_redemption') {
    throw new InvalidOperationError('This cover policy requires a manual refund review');
  }
  if (
    account.status !== 'active' ||
    account.reservedPaise !== 0 ||
    account.redeemedPaise !== 0 ||
    account.refundedPaise !== 0 ||
    account.remainingPaise !== account.issuedPaise
  ) {
    throw new InvalidOperationError('Only fully unused cover can be frozen for refund');
  }
  return {
    ...bumpVersion(account, now),
    status: 'frozen',
    refundRequestId,
  };
}

export function releaseUnusedEventCoverRefundFreeze(
  account: EventCoverAccount,
  refundRequestId: EntityId,
  now: Date = new Date(),
): EventCoverAccount {
  if (account.status !== 'frozen' || account.refundRequestId !== refundRequestId) {
    throw new InvalidOperationError('Cover refund lock does not match this refund request');
  }
  return {
    ...bumpVersion(account, now),
    status: 'active',
    refundRequestId: null,
  };
}

export function reserveEventCover(
  account: EventCoverAccount,
  input: {
    amountPaise: number;
    operationId: EntityId;
    guestConfirmed: boolean;
    /** Internal preauthorization used only while awaiting Guest confirmation. */
    authorizationOnly?: boolean;
    online: boolean;
    actorUserId: EntityId;
    terminalId: EntityId;
    receiptReference: string;
    now?: Date;
  },
): { account: EventCoverAccount; entry: EventCoverEntry } {
  assertPositivePaise(input.amountPaise);
  if (account.status !== 'active') {
    throw new InvalidOperationError('Cover is not active for redemption');
  }
  if (!input.online) throw new InvalidOperationError('Cover redemption requires connectivity');
  if (!input.guestConfirmed && !input.authorizationOnly) {
    throw new InvalidOperationError('Guest confirmation is required before cover redemption');
  }
  if (
    !input.operationId ||
    !input.actorUserId ||
    !input.terminalId ||
    !input.receiptReference.trim()
  ) {
    throw new InvalidOperationError(
      'Cover redemption requires actor, terminal and receipt evidence',
    );
  }
  const available = account.remainingPaise - account.reservedPaise;
  if (input.amountPaise > available) {
    throw new InvalidOperationError('Cover amount exceeds the available event balance');
  }
  const now = input.now ?? new Date();
  const entryId = eventCoverEntryId(account.id, input.operationId, 'reserve');
  const entry: EventCoverEntry = {
    ...newVersionedEntity(now),
    id: entryId,
    accountId: account.id,
    entitlementId: account.entitlementId,
    orderId: account.orderId,
    eventId: account.eventId,
    venueOrganizationId: account.venueOrganizationId,
    type: 'reserve',
    amountPaise: input.amountPaise,
    operationId: input.operationId,
    actorUserId: input.actorUserId,
    terminalId: input.terminalId,
    receiptReference: input.receiptReference.trim(),
    policyVersion: account.policyVersion,
    reversesEntryId: null,
  };
  return {
    account: {
      ...bumpVersion(account, now),
      reservedPaise: account.reservedPaise + input.amountPaise,
    },
    entry,
  };
}

/** Captures an existing reservation once; capture never trusts a client amount. */
export function captureEventCoverReservation(
  account: EventCoverAccount,
  reservation: EventCoverEntry,
  priorEntries: readonly EventCoverEntry[],
  now: Date = new Date(),
): { account: EventCoverAccount; entry: EventCoverEntry } {
  if (
    reservation.type !== 'reserve' ||
    reservation.accountId !== account.id ||
    reservation.eventId !== account.eventId ||
    reservation.entitlementId !== account.entitlementId
  ) {
    throw new InvalidOperationError('Cover reservation does not match this account');
  }
  const operationEntries = priorEntries.filter(
    (entry) => entry.accountId === account.id && entry.operationId === reservation.operationId,
  );
  if (
    !operationEntries.some((entry) => entry.id === reservation.id && entry.type === 'reserve') ||
    operationEntries.some((entry) => entry.type === 'capture' || entry.type === 'void')
  ) {
    throw new InvalidOperationError('Cover reservation is not pending or was already resolved');
  }
  if (account.status !== 'active' || reservation.amountPaise > account.reservedPaise) {
    throw new InvalidOperationError('Cover reservation is no longer available to capture');
  }
  const id = eventCoverEntryId(account.id, reservation.operationId, 'capture');
  const entry: EventCoverEntry = {
    ...newVersionedEntity(now),
    id,
    accountId: account.id,
    entitlementId: account.entitlementId,
    orderId: account.orderId,
    eventId: account.eventId,
    venueOrganizationId: account.venueOrganizationId,
    type: 'capture',
    amountPaise: reservation.amountPaise,
    operationId: reservation.operationId,
    actorUserId: reservation.actorUserId,
    terminalId: reservation.terminalId,
    receiptReference: reservation.receiptReference,
    policyVersion: reservation.policyVersion,
    reversesEntryId: reservation.id,
  };
  return {
    account: {
      ...bumpVersion(account, now),
      remainingPaise: account.remainingPaise - reservation.amountPaise,
      reservedPaise: account.reservedPaise - reservation.amountPaise,
      redeemedPaise: account.redeemedPaise + reservation.amountPaise,
    },
    entry,
  };
}

/** Reverses one captured redemption after an authorized, reasoned review. */
export function reverseEventCoverCapture(
  account: EventCoverAccount,
  capture: EventCoverEntry,
  actorUserId: EntityId,
  reason: string,
  now: Date = new Date(),
): { account: EventCoverAccount; entry: EventCoverEntry } {
  const normalizedReason = reason.trim();
  if (
    account.status !== 'active' ||
    capture.type !== 'capture' ||
    capture.accountId !== account.id ||
    capture.entitlementId !== account.entitlementId ||
    capture.eventId !== account.eventId ||
    capture.orderId !== account.orderId ||
    capture.venueOrganizationId !== account.venueOrganizationId ||
    capture.policyVersion !== account.policyVersion ||
    !actorUserId ||
    !Number.isSafeInteger(capture.amountPaise) ||
    capture.amountPaise <= 0 ||
    capture.amountPaise > account.redeemedPaise ||
    account.remainingPaise + capture.amountPaise > account.issuedPaise ||
    normalizedReason.length < 8 ||
    normalizedReason.length > 500
  ) {
    throw new InvalidOperationError('Cover capture cannot be reversed from the current account');
  }
  const nowDate = now;
  const entry: EventCoverEntry = {
    ...newVersionedEntity(nowDate),
    id: eventCoverEntryId(account.id, capture.operationId, 'reversal'),
    accountId: account.id,
    entitlementId: account.entitlementId,
    orderId: account.orderId,
    eventId: account.eventId,
    venueOrganizationId: account.venueOrganizationId,
    type: 'reversal',
    amountPaise: capture.amountPaise,
    operationId: capture.operationId,
    actorUserId,
    terminalId: capture.terminalId,
    receiptReference: capture.receiptReference,
    policyVersion: account.policyVersion,
    reversesEntryId: capture.id,
    reason: normalizedReason,
  };
  return {
    account: {
      ...bumpVersion(account, nowDate),
      remainingPaise: account.remainingPaise + capture.amountPaise,
      redeemedPaise: account.redeemedPaise - capture.amountPaise,
    },
    entry,
  };
}

export function voidEventCoverReservation(
  account: EventCoverAccount,
  reservation: EventCoverEntry,
  priorEntries: readonly EventCoverEntry[],
  now: Date = new Date(),
): { account: EventCoverAccount; entry: EventCoverEntry } {
  if (reservation.type !== 'reserve' || reservation.accountId !== account.id) {
    throw new InvalidOperationError('Cover reservation cannot be voided from this account');
  }
  const operationEntries = priorEntries.filter(
    (entry) => entry.accountId === account.id && entry.operationId === reservation.operationId,
  );
  if (
    !operationEntries.some((entry) => entry.id === reservation.id && entry.type === 'reserve') ||
    operationEntries.some((entry) => entry.type === 'capture' || entry.type === 'void')
  ) {
    throw new InvalidOperationError('Cover reservation is not pending or was already resolved');
  }
  if (reservation.amountPaise > account.reservedPaise) {
    throw new InvalidOperationError('Cover reservation cannot be voided from this account');
  }
  const entry: EventCoverEntry = {
    ...newVersionedEntity(now),
    id: eventCoverEntryId(account.id, reservation.operationId, 'void'),
    accountId: account.id,
    entitlementId: account.entitlementId,
    orderId: account.orderId,
    eventId: account.eventId,
    venueOrganizationId: account.venueOrganizationId,
    type: 'void',
    amountPaise: reservation.amountPaise,
    operationId: reservation.operationId,
    actorUserId: reservation.actorUserId,
    terminalId: reservation.terminalId,
    receiptReference: reservation.receiptReference,
    policyVersion: reservation.policyVersion,
    reversesEntryId: reservation.id,
  };
  return {
    account: {
      ...bumpVersion(account, now),
      reservedPaise: account.reservedPaise - reservation.amountPaise,
    },
    entry,
  };
}
