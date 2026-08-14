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
  InProcessEventBus,
  createAuditConsumer,
  createProjectionConsumer,
} from '@c1rcle/core/application';
import { createCoreConfig } from '@c1rcle/core/config';
import { UnauthorizedError } from '@c1rcle/core/domain';
import {
  MemoryOrganizationRepository,
  MemoryInvitationRepository,
  MemoryPartnershipRepository,
  MemoryReferralLinkRepository,
  MemoryPromoterConnectionRepository,
  MemoryVenueRepository,
  MemorySlotRequestRepository,
  MemoryVenueSlotRepository,
  MemoryEventRepository,
  MemoryEventCatalogRepository,
  MemoryAnalyticsReadModelRepository,
  MemoryIdempotencyStore,
  MemoryOutboxStore,
  MemoryAuditRepository,
  getFirestoreClient,
  FirestoreIdempotencyStore,
  FirestoreOrganizationRepository,
  FirestoreInvitationRepository,
  FirestorePartnershipRepository,
  FirestoreReferralLinkRepository,
  FirestorePromoterConnectionRepository,
  FirestoreVenueRepository,
  FirestoreSlotRequestRepository,
  FirestoreVenueSlotRepository,
  FirestoreEventRepository,
  FirestoreEventCatalogRepository,
  FirestoreAnalyticsReadModelRepository,
} from '@c1rcle/core/infrastructure';

import type { ServiceDeps, ActorContext } from '@c1rcle/core/application';
import type { IdempotencyStore, OrganizationRole, Capability } from '@c1rcle/core/domain';

import { getGatewayConfig, GatewayConfigError } from '../config/index.js';

import type { GatewayConfig } from '../config/index.js';
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
  /** T09 idempotency — durable on the firestore driver, in-memory on `memory`. */
  idempotency: IdempotencyService;
  /** Builds the service actor from the authenticated request state. */
  actor(request: FastifyRequest): ActorContext;
  /** Raw repository bundle for seed/test wiring only. */
  repos(): ServiceDeps['repositories'];
  /** T13 audit trail written by the event bus (B09 slice consumer). */
  audits: MemoryAuditRepository;
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

  const repositories: ServiceDeps['repositories'] = buildRepositories(gw);

  // T13 event infrastructure: memory outbox store + in-process bus + audit.
  const outboxStore = new MemoryOutboxStore();
  const audits = new MemoryAuditRepository();
  const eventBus = new InProcessEventBus(outboxStore);
  eventBus.subscribe('event.published', createAuditConsumer(audits));
  eventBus.subscribe('event.updated', createAuditConsumer(audits));
  // Future projection consumer (no-op now — wire exists for B11 projections).
  eventBus.subscribe('event.published', createProjectionConsumer);

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
    repositories,
  };

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
    // Replay protection must outlive the process: a restart mid-retry with an
    // in-memory store turns a client's retry into a second business result.
    idempotency: new IdempotencyService(buildIdempotencyStore(), logger),
    actor: buildActorContext,
    repos: () => repositories,
    /** T13 audit trail surfaced to routes/tests (B09 slice consumer). */
    audits,
  };
}

/**
 * Chooses the repository adapter set for `STORAGE_DRIVER`. Both branches
 * satisfy the exact same `ServiceDeps['repositories']` shape — this is the
 * only place in the gateway that knows Firestore exists (routes/services
 * never do, per the T07 repository-port boundary).
 */
/**
 * Idempotency storage per driver. The memory store is fine for tests and local
 * dev; anything real needs the durable one, or a restart silently drops every
 * in-flight claim and stored response.
 */
function buildIdempotencyStore(): IdempotencyStore {
  const gw = getGatewayConfig();
  if (gw.STORAGE_DRIVER === 'memory') return new MemoryIdempotencyStore();
  if (!gw.FIREBASE_CLIENT_EMAIL || !gw.FIREBASE_PRIVATE_KEY) {
    throw new GatewayConfigError(
      'STORAGE_DRIVER=firestore requires FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY',
    );
  }
  return new FirestoreIdempotencyStore(
    getFirestoreClient({
      projectId: gw.FIRESTORE_PROJECT_ID,
      clientEmail: gw.FIREBASE_CLIENT_EMAIL,
      privateKey: gw.FIREBASE_PRIVATE_KEY,
    }),
  );
}

function buildRepositories(gw: GatewayConfig): ServiceDeps['repositories'] {
  if (gw.STORAGE_DRIVER === 'memory') {
    return {
      organizations: new MemoryOrganizationRepository(),
      invitations: new MemoryInvitationRepository(),
      partnerships: new MemoryPartnershipRepository(),
      referralLinks: new MemoryReferralLinkRepository(),
      promoterConnections: new MemoryPromoterConnectionRepository(),
      venues: new MemoryVenueRepository(),
      slotRequests: new MemorySlotRequestRepository(),
      venueSlots: new MemoryVenueSlotRepository(),
      events: new MemoryEventRepository(),
      catalog: new MemoryEventCatalogRepository(),
      analytics: new MemoryAnalyticsReadModelRepository(),
    };
  }
  // STORAGE_DRIVER === 'firestore' — config validation guarantees these two
  // are present (see `config/index.ts` superRefine: fail closed, no silent
  // memory fallback). Narrowed explicitly rather than `!` so a config bug
  // fails with a clear message instead of an assertion.
  if (!gw.FIREBASE_CLIENT_EMAIL || !gw.FIREBASE_PRIVATE_KEY) {
    throw new GatewayConfigError(
      'STORAGE_DRIVER=firestore requires FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY',
    );
  }
  const db = getFirestoreClient({
    projectId: gw.FIRESTORE_PROJECT_ID,
    clientEmail: gw.FIREBASE_CLIENT_EMAIL,
    privateKey: gw.FIREBASE_PRIVATE_KEY,
  });
  return {
    organizations: new FirestoreOrganizationRepository(db),
    invitations: new FirestoreInvitationRepository(db),
    partnerships: new FirestorePartnershipRepository(db),
    referralLinks: new FirestoreReferralLinkRepository(db),
    promoterConnections: new FirestorePromoterConnectionRepository(db),
    venues: new FirestoreVenueRepository(db),
    slotRequests: new FirestoreSlotRequestRepository(db),
    venueSlots: new FirestoreVenueSlotRepository(db),
    events: new FirestoreEventRepository(db),
    catalog: new FirestoreEventCatalogRepository(db),
    analytics: new FirestoreAnalyticsReadModelRepository(db),
  };
}

/**
 * Builds the service actor from request state the B10 auth `preHandler` hook
 * (`plugins/auth.ts`) populates *before* this runs — `request.user.uid` (from
 * the validated Better Auth session) and `request.authContext.activeMembership`
 * (from the real `OrganizationRepository.getMember()` lookup, keyed off the
 * `X-Organization-Id` header). Stays synchronous on purpose: the async session
 * + membership resolution already happened in the hook, so no route file needs
 * to `await services.actor(...)`.
 *
 * `STORAGE_DRIVER=memory` (the `pnpm test` / CI default) is a documented
 * exception: no real auth is wired against the in-memory adapters (see
 * `docs/roadmap/phase-00-foundation.md`), so it keeps the pre-B10 fabricated
 * dev actor. `STORAGE_DRIVER=firestore` (real dev/prod) enforces a real
 * session and real membership — no fallback, ever.
 */
function buildActorContext(request: FastifyRequest): ActorContext {
  const anyReq = request as unknown as {
    user?: { uid: string } | null;
    authContext?: {
      activeMembership?: {
        organizationId: string;
        role: OrganizationRole;
        capabilities: Capability[];
      };
    } | null;
  };

  if (getGatewayConfig().STORAGE_DRIVER === 'memory') {
    const userId = anyReq.user?.uid ?? 'dev-user';
    const organizationId =
      anyReq.authContext?.activeMembership?.organizationId ??
      (request.headers['x-organization-id'] as string | undefined) ??
      'org_dev';
    const role: OrganizationRole = anyReq.authContext?.activeMembership?.role ?? 'owner';
    const capabilities: readonly Capability[] = anyReq.authContext?.activeMembership
      ?.capabilities ?? ['host', 'venue', 'promoter'];
    return { userId, organizationId, role, capabilities };
  }

  if (!anyReq.user?.uid) {
    throw new UnauthorizedError();
  }
  if (!anyReq.authContext?.activeMembership) {
    // Valid session, no *resolved* membership for the requested org — this is
    // the normal shape of "create my first organization" (there's nothing to
    // be a member of yet). `organizationId: ''` never matches a real id, so
    // every route that actually needs org-scoping (`requireOrgAccess`,
    // `fetchOwned`) still fails closed with `ForbiddenError` — this only
    // unblocks the userId-only flows (`organizations.create`, `.list`).
    return { userId: anyReq.user.uid, organizationId: '', role: 'member', capabilities: [] };
  }
  const { organizationId, role, capabilities } = anyReq.authContext.activeMembership;
  return { userId: anyReq.user.uid, organizationId, role, capabilities };
}
