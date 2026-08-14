/**
 * ─── Typed domain errors ─────────────────────────────────────────────────────
 * Domain layer throws these; the gateway maps them to HTTP statuses.
 * No HTTP concepts, no Firestore, no `process.env` in this file.
 */

/** Base class for all domain errors. */
export class DomainError extends Error {
  /** Stable machine-readable code (v2 contract code shape, lowercase). */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class OrganizationNotFoundError extends DomainError {
  constructor(organizationId: string) {
    super(`Organization ${organizationId} not found`, 'organization_not_found');
  }
}

export class VenueNotFoundError extends DomainError {
  constructor(venueId: string) {
    super(`Venue ${venueId} not found`, 'venue_not_found');
  }
}

export class SlotRequestNotFoundError extends DomainError {
  constructor(slotRequestId: string) {
    super(`Slot request ${slotRequestId} not found`, 'slot_request_not_found');
  }
}

export class EventNotFoundError extends DomainError {
  constructor(eventId: string) {
    super(`Event ${eventId} not found`, 'event_not_found');
  }
}

export class TicketTierNotFoundError extends DomainError {
  constructor(tierId: string) {
    super(`Ticket tier ${tierId} not found`, 'ticket_tier_not_found');
  }
}

export class PromoterAssignmentNotFoundError extends DomainError {
  constructor(assignmentId: string) {
    super(`Promoter assignment ${assignmentId} not found`, 'promoter_assignment_not_found');
  }
}

export class PartnershipNotFoundError extends DomainError {
  constructor(partnershipId: string) {
    super(`Partnership ${partnershipId} not found`, 'partnership_not_found');
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Insufficient permissions') {
    super(message, 'forbidden');
  }
}

/** No valid session (B10) — distinct from `ForbiddenError` (valid session, wrong scope). */
export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentication required') {
    super(message, 'unauthorized');
  }
}

export class VersionConflictError extends DomainError {
  constructor(expectedVersion: number, currentVersion: number) {
    super(
      `Version conflict: expected ${expectedVersion}, current ${currentVersion}`,
      'version_conflict',
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
  readonly expectedVersion: number;
  readonly currentVersion: number;
}

export class StateTransitionError extends DomainError {
  constructor(from: string, to: string, reason?: string) {
    super(
      `Illegal state transition ${from} -> ${to}${reason ? `: ${reason}` : ''}`,
      'state_transition',
    );
    this.from = from;
    this.to = to;
  }
  readonly from: string;
  readonly to: string;
}

export class InvalidOperationError extends DomainError {
  constructor(message: string) {
    super(message, 'invalid_operation');
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency-Key ${idempotencyKey} was already used with a different request`,
      'idempotency_conflict',
    );
  }
}

export class IdempotencyInFlightError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Request with Idempotency-Key ${idempotencyKey} is already in flight`,
      'idempotency_in_flight',
    );
  }
}
