/**
 * ─── T08 shared application-layer primitives ─────────────────────────────────
 * Actor context + service dependency bundle. Everything the services need is
 * injected — no `process.env`, no Fastify, no database anywhere in
 * `application/`.
 */

import { ForbiddenError } from '../domain/errors.js';
import { domainEvent, type DomainEventType, type EventPayloads } from '../domain/events.js';

import type { CoreConfig } from '../config/index.js';
import type { EntityId } from '../domain/identity.js';
import type { OrganizationRole, Capability } from '../domain/models/organization.js';
import type { OutboxWriter } from '../domain/ports/outbox.js';
import type {
  InvitationRepository,
  OrganizationRepository,
  PartnershipRepository,
  ReferralLinkRepository,
  VenueRepository,
  SlotRequestRepository,
  VenueSlotRepository,
  EventRepository,
  EventCatalogRepository,
  AnalyticsReadModelRepository,
} from '../domain/ports/repositories.js';
import type { Logger } from '../telemetry/logger.js';

/** Who is making this call and in which tenant/role. Set by gateway auth. */
export interface ActorContext {
  userId: EntityId;
  /** Tenant/org the actor is acting on behalf of. */
  organizationId: EntityId;
  role: OrganizationRole;
  capabilities: readonly Capability[];
}

/** Everything an application service may need — all injected. */
export interface ServiceDeps {
  config: CoreConfig;
  logger: Logger;
  /** T12 outbox: domain events appended in the same unit of work as writes. */
  outbox: OutboxWriter;
  repositories: {
    organizations: OrganizationRepository;
    invitations: InvitationRepository;
    partnerships: PartnershipRepository;
    referralLinks: ReferralLinkRepository;
    venues: VenueRepository;
    slotRequests: SlotRequestRepository;
    venueSlots: VenueSlotRepository;
    events: EventRepository;
    catalog: EventCatalogRepository;
    analytics: AnalyticsReadModelRepository;
  };
}

/**
 * Guards that the actor's org matches the org being mutated. Throws
 * `ForbiddenError` rather than leaking existence of the resource.
 */
export function requireOrgAccess(actor: ActorContext, organizationId: EntityId): void {
  if (actor.organizationId !== organizationId) {
    throw new ForbiddenError('Cross-tenant access denied');
  }
}

/**
 * Appends a domain event to the outbox in the same unit of work as the
 * service write (T12). Id + clock come from the injected config. Awaited so
 * the row is durably stored before the bus can drain it.
 */
export async function emit<TType extends DomainEventType>(
  deps: ServiceDeps,
  actor: ActorContext,
  aggregateId: EntityId,
  type: TType,
  payload: EventPayloads[TType],
): Promise<void> {
  const occurredAt = deps.config.clock.now().getTime();
  await deps.outbox.append(
    domainEvent({
      id: deps.config.ids(),
      type,
      aggregateId,
      organizationId: actor.organizationId,
      actorId: actor.userId,
      payload,
      occurredAt,
    }),
  );
}
