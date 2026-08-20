import { createLogger, type Logger } from '@c1rcle/core';
import {
  OrganizationService,
  VenueService,
  PartnershipService,
  ReferralLinkService,
  PromoterConnectionService,
  VenueCalendarService,
  VenueSlotRequestService,
  EventService,
  EventCatalogService,
  AnalyticsService,
  IdempotencyService,
  OnboardingService,
  AdminAuthorityService,
  InProcessEventBus,
  createAuditConsumer,
  createProjectionConsumer,
  CheckoutService,
  InventoryService,
  PricingService,
  createScannerService,
  createDoorService,
  createCoverWalletService,
  type ScannerService,
  type DoorService,
  type CoverWalletService,
} from '@c1rcle/core/application';
import { createCoreConfig } from '@c1rcle/core/config';
import { FormatCheckVerificationProvider } from '@c1rcle/core/domain';
import {
  MemoryOutboxStore,
  MemoryAuditRepository,
  MemoryAdminAuditRepository,
  FirestoreAdminAuditRepository,
  buildRepositories,
  firestoreClient,
  buildIdempotencyStore,
  buildActorContext,
} from '@c1rcle/core/infrastructure';

import type { ServiceDeps, ActorContext } from '@c1rcle/core/application';
import type { AdminAuditRepository } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../config/index.js';
import { RazorpayPaymentProvider } from '../payments/razorpay-adapter.js';

import type { FastifyRequest } from 'fastify';

/**
 * ─── V2 partner services wiring ──────────────────────────────────────────────
 * Builds the `ServiceDeps` bundle v2 routes consume: application services
 * depend on repository interfaces, routes stay thin. Repository implementation
 * is chosen by `STORAGE_DRIVER` (B12) — `memory` (default, used by `pnpm test`)
 * or `firestore` (used by `pnpm dev`) — routes and services never know which.
 * No `.collection()` in routes, no `process.env` in application layer.
 */
export interface PartnerV2Services {
  organizations: OrganizationService;
  venues: VenueService;
  partnerships: PartnershipService;
  referralLinks: ReferralLinkService;
  promoterConnections: PromoterConnectionService;
  venueCalendar: VenueCalendarService;
  venueSlotRequests: VenueSlotRequestService;
  events: EventService;
  catalog: EventCatalogService;
  analytics: AnalyticsService;
  /** Phase 2: partner applications, applicant + admin review sides. */
  onboarding: OnboardingService;
  /** Phase 2: platform-admin resolution, tiering and dual control. */
  adminAuthority: AdminAuthorityService;
  checkout: CheckoutService;
  /** T09 idempotency — durable on the firestore driver, in-memory on `memory`. */
  idempotency: IdempotencyService;
  /** Builds the service actor from the authenticated request state. */
  actor(request: FastifyRequest): ActorContext;
  /** Raw repository bundle for seed/test wiring only. */
  repos(): ServiceDeps['repositories'];
  /** T13 audit trail written by the event bus (B09 slice consumer). */
  audits: MemoryAuditRepository;
  /** Phase 2 admin audit trail (before/after), for seed/test wiring. */
  adminAudits(): AdminAuditRepository;
  /** Phase 5: Scanner service */
  scanner: ScannerService;
  /** Phase 5: Door service */
  door: DoorService;
  /** Phase 5: Cover wallet service */
  coverWallet: CoverWalletService;
}

// Each route module calls `createV2Services()` independently at import time
// (`const services = createV2Services()`). Memoized (no-logger calls only) so
// they all share one repository set — required for cross-route lookups (the
// auth preHandler hook's organization-membership check must see organizations
// written via the organizations routes). Logger-injecting callers (tests that
// want to assert on log calls) bypass the cache and get a fresh build.
let cachedServices: PartnerV2Services | null = null;

export function createV2Services(logger?: Logger): PartnerV2Services {
  if (!logger && cachedServices) return cachedServices;
  const built = buildV2Services(logger);
  if (!logger) cachedServices = built;
  return built;
}

function buildV2Services(logger?: Logger): PartnerV2Services {
  const gw = getGatewayConfig();
  const coreConfig = createCoreConfig({
    redis: { url: gw.REDIS_URL },
    firestore: { projectId: gw.FIRESTORE_PROJECT_ID },
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  const repositories: ServiceDeps['repositories'] = buildRepositories(gw);

  // T13 event infrastructure: memory outbox store + in-process bus + audit.
  const outboxStore = new MemoryOutboxStore();
  const audits = new MemoryAuditRepository();
  const eventBus = new InProcessEventBus(outboxStore);
  eventBus.subscribe('event.published', createAuditConsumer(audits));
  eventBus.subscribe('event.updated', createAuditConsumer(audits));
  // Future projection consumer (no-op now — wire exists for B11 projections).
  eventBus.subscribe('event.published', createProjectionConsumer);

  const adminAudits: AdminAuditRepository =
    gw.STORAGE_DRIVER === 'memory'
      ? new MemoryAdminAuditRepository()
      : // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call
        new FirestoreAdminAuditRepository(firestoreClient(gw));

  // Phase 4: Payment provider, pricing, inventory
  const gwConfig = getGatewayConfig();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  const paymentProvider = new RazorpayPaymentProvider({
    keyId: gwConfig.RAZORPAY_KEY_ID ?? 'test_key_id',
    keySecret: gwConfig.RAZORPAY_KEY_SECRET ?? 'test_key_secret',
    webhookSecret: gwConfig.RAZORPAY_WEBHOOK_SECRET ?? 'test_webhook_secret',
  });
  const pricing = new PricingService({ eventCatalog: repositories.catalog });
  const inventory = new InventoryService({
    eventCatalog: repositories.catalog,
    cartReservation: repositories.cartReservations,
    order: repositories.orders,
  });

  const deps: ServiceDeps = {
    config: coreConfig,
    logger:
      logger ??
      createLogger({
        info: (message, obj) => console.info(message, obj ?? {}),
        warn: (message, obj) => console.warn(message, obj ?? {}),
        error: (message, obj) => console.error(message, obj ?? {}),
      }),
    outbox: eventBus,
    adminAudit: adminAudits,
    // Swap here — and only here — when a real KYC provider is contracted.

    verification: new FormatCheckVerificationProvider(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    paymentProvider,
    pricing,
    inventory,
    repositories,
  };

  const adminAuthority = new AdminAuthorityService(deps);

  // Phase 5 services
  const scanner = createScannerService({
    scanLedger: repositories.scanLedger,
    eventCodes: repositories.eventCodes,
    scannerSessions: repositories.scannerSessions,
    entitlements: repositories.entitlements,
    config: coreConfig,
    logger: deps.logger,
    outbox: eventBus,
    adminAudit: adminAudits,
  });

  const door = createDoorService({
    doorSales: repositories.doorSales,
    events: repositories.events,
    catalog: repositories.catalog,
    coverWallets: repositories.coverWallets,
    coverWalletTxns: repositories.coverWalletTxns,
    config: coreConfig,
    logger: deps.logger,
    outbox: eventBus,
    adminAudit: adminAudits,
    pricing,
  });

  const coverWallet = createCoverWalletService({
    coverWallets: repositories.coverWallets,
    coverWalletTxns: repositories.coverWalletTxns,
    coverWalletReconciliations: repositories.coverWalletReconciliations,
    events: repositories.events,
    config: coreConfig,
    logger: deps.logger,
    outbox: eventBus,
    adminAudit: adminAudits,
  });

  return {
    organizations: new OrganizationService(deps),
    venues: new VenueService(deps),
    partnerships: new PartnershipService(deps),
    referralLinks: new ReferralLinkService(deps),
    promoterConnections: new PromoterConnectionService(deps),
    venueCalendar: new VenueCalendarService(deps),
    venueSlotRequests: new VenueSlotRequestService(deps),
    events: new EventService(deps),
    catalog: new EventCatalogService(deps),
    analytics: new AnalyticsService(deps),
    onboarding: new OnboardingService(deps, adminAuthority),
    adminAuthority,
    checkout: new CheckoutService(deps),
    // Replay protection must outlive the process: a restart mid-retry with an
    // in-memory store turns a client's retry into a second business result.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument
    idempotency: new IdempotencyService(buildIdempotencyStore(), logger),
    actor: buildActorContext,
    repos: () => repositories,
    /** T13 audit trail surfaced to routes/tests (B09 slice consumer). */
    audits,
    adminAudits: () => adminAudits,
    // Phase 5
    scanner,
    door,
    coverWallet,
  };
}
