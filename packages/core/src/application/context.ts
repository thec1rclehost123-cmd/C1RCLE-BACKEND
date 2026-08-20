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
import type { InventoryService } from './inventory/inventory-service.js';
import type { OrganizationRole, Capability } from '../domain/models/organization.js';
import type { AdminAuditRepository } from '../domain/ports/audit.js';
import type { OutboxWriter } from '../domain/ports/outbox.js';
import type { PaymentProvider } from '../domain/ports/payment-provider.js';
import type {
  InvitationRepository,
  OnboardingRepository,
  PlatformAdminRepository,
  ProposedActionRepository,
  VerificationAttemptRepository,
  OrganizationRepository,
  PartnershipRepository,
  PromoterConnectionRepository,
  ReferralLinkRepository,
  VenueRepository,
  SlotRequestRepository,
  VenueSlotRepository,
  EventRepository,
  EventCatalogRepository,
  AnalyticsReadModelRepository,
  CartReservationRepository,
  OrderRepository,
  EntitlementRepository,
  PromoRedemptionRepository,
  ScanLedgerRepository,
  EventCodeRepository,
  ScannerSessionRepository,
  DoorSaleRepository,
  CoverWalletRepository,
  CoverWalletTxnRepository,
  CoverWalletReconciliationRepository,
} from '../domain/ports/repositories.js';
import type { VerificationProvider } from '../domain/ports/verification.js';
import type { Logger } from '../telemetry/logger.js';
import type { PricingService } from './pricing/pricing-service.js';

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
  /**
   * Phase 2: every privileged operator action is written here with before/after
   * state. Injected rather than reached for, so a service cannot skip it by
   * forgetting to import something.
   */
  adminAudit: AdminAuditRepository;
  /**
   * Phase 2: pluggable KYC document verification. The default is a format
   * check that says so — see `ports/verification.ts` for why v1's checksum
   * "verification" was not ported as verification.
   */
  verification: VerificationProvider;
  /** Phase 4: Payment provider (pluggable) */
  paymentProvider: PaymentProvider;
  /** Phase 4: Pricing engine */
  pricing: PricingService;
  /** Phase 4: Inventory service */
  inventory: InventoryService;
  repositories: {
    organizations: OrganizationRepository;
    invitations: InvitationRepository;
    partnerships: PartnershipRepository;
    referralLinks: ReferralLinkRepository;
    promoterConnections: PromoterConnectionRepository;
    venues: VenueRepository;
    slotRequests: SlotRequestRepository;
    venueSlots: VenueSlotRepository;
    events: EventRepository;
    catalog: EventCatalogRepository;
    analytics: AnalyticsReadModelRepository;
    onboarding: OnboardingRepository;
    platformAdmins: PlatformAdminRepository;
    proposals: ProposedActionRepository;
    verificationAttempts: VerificationAttemptRepository;
    // Phase 4
    cartReservations: CartReservationRepository;
    orders: OrderRepository;
    entitlements: EntitlementRepository;
    promoRedemptions: PromoRedemptionRepository;
    // Phase 5
    scanLedger: ScanLedgerRepository;
    eventCodes: EventCodeRepository;
    scannerSessions: ScannerSessionRepository;
    doorSales: DoorSaleRepository;
    coverWallets: CoverWalletRepository;
    coverWalletTxns: CoverWalletTxnRepository;
    coverWalletReconciliations: CoverWalletReconciliationRepository;
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
