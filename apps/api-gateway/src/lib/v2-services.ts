import { createLogger, type Logger } from '@c1rcle/core';
import {
  OrganizationService,
  VenueService,
  VenueSlotRequestService,
  EventService,
  EventCatalogService,
  AnalyticsService,
  EventBus,
  OutboxRelay,
  registerAuditConsumer,
} from '@c1rcle/core/application';
import { createCoreConfig } from '@c1rcle/core/config';
import {
  MemoryOrganizationRepository,
  MemoryVenueRepository,
  MemorySlotRequestRepository,
  MemoryVenueSlotRepository,
  MemoryEventRepository,
  MemoryEventCatalogRepository,
  MemoryAnalyticsReadModelRepository,
  MemoryAuditRepository,
  MemoryOutbox,
  SqliteAuditRepository,
  SqliteEventRepository,
  SqliteOrganizationRepository,
  SqliteOutbox,
  SqliteVenueRepository,
  createSqliteDatabase,
} from '@c1rcle/core/infrastructure';

import type { ServiceDeps, ActorContext } from '@c1rcle/core/application';

import { getGatewayConfig, type GatewayConfig } from '../config/index.js';

import type { FastifyRequest } from 'fastify';

/**
 * ─── V2 partner services wiring ──────────────────────────────────────────────
 * Builds the `ServiceDeps` bundle v2 routes consume: application services
 * depend on repository interfaces, routes stay thin. Repository implementations
 * are injected here — memory-backed for now while the Firestore adapters land.
 * No `.collection()` in routes, no `process.env` in application layer.
 */
export interface PartnerV2Services {
  organizations: OrganizationService;
  venues: VenueService;
  slotRequests: VenueSlotRequestService;
  events: EventService;
  catalog: EventCatalogService;
  analytics: AnalyticsService;
  /** Builds the service actor from the authenticated request state. */
  actor(request: FastifyRequest): ActorContext;
  /**
   * Actor for the one command that legitimately has no tenant yet:
   * `organizations.create`. Carries identity but no organization scope, so it
   * can never be used to reach an existing tenant's data.
   */
  actorWithoutTenant(request: FastifyRequest): ActorContext;
  /** Raw repository bundle for seed/test wiring only. */
  repos(): ServiceDeps['repositories'];
  /**
   * Drains the outbox into the event bus. Driven explicitly for now — a
   * separate worker process owns this from the next slice (the API must never
   * run the relay inline in production).
   */
  relay: OutboxRelay;
  outbox: MemoryOutbox | SqliteOutbox;
}

let shared: PartnerV2Services | null = null;

/**
 * The process-wide service bundle.
 *
 * Route modules MUST use this rather than calling `createV2Services()` at
 * import time: separate instances mean separate in-memory repositories, so an
 * organization created through one route would be invisible to another — and
 * the auth plugin would check membership against a different store than the
 * services write to.
 */
export function getV2Services(logger?: Logger, config?: GatewayConfig): PartnerV2Services {
  shared ??= createV2Services(logger, config);
  return shared;
}

/** Test-only: drops the shared bundle so each suite starts from empty stores. */
export function resetV2Services(): void {
  shared = null;
}

export function createV2Services(logger?: Logger, config?: GatewayConfig): PartnerV2Services {
  // Injected config wins: the app factory owns configuration, and reading env
  // here would make the storage engine untestable and the builder impure.
  const gw = config ?? getGatewayConfig();
  const coreConfig = createCoreConfig({
    redis: { url: gw.REDIS_URL },
    firestore: { projectId: gw.FIRESTORE_PROJECT_ID },
  });

  const durable = gw.STORAGE_DRIVER === 'sqlite';
  const db = durable ? createSqliteDatabase(gw.SQLITE_PATH) : null;

  /**
   * Same ports, swapped implementations — the whole point of B12. Slot
   * requests, catalog and analytics still run on memory: their SQLite adapters
   * land with the slices that need them, and the contract suite is what will
   * prove those too.
   */
  const repositories: ServiceDeps['repositories'] = {
    organizations: db ? new SqliteOrganizationRepository(db) : new MemoryOrganizationRepository(),
    venues: db ? new SqliteVenueRepository(db) : new MemoryVenueRepository(),
    slotRequests: new MemorySlotRequestRepository(),
    venueSlots: new MemoryVenueSlotRepository(),
    events: db ? new SqliteEventRepository(db) : new MemoryEventRepository(),
    catalog: new MemoryEventCatalogRepository(),
    analytics: new MemoryAnalyticsReadModelRepository(),
    audit: db ? new SqliteAuditRepository(db) : new MemoryAuditRepository(),
  };

  const resolvedLogger =
    logger ??
    createLogger({
      info: (message, obj) => console.info(message, obj ?? {}),
      warn: (message, obj) => console.warn(message, obj ?? {}),
      error: (message, obj) => console.error(message, obj ?? {}),
    });

  // One instance plays both roles: writer inside the unit of work, and the
  // reader the relay drains. On SQLite the unit of work is a real transaction.
  const outbox = db
    ? new SqliteOutbox(db, () => coreConfig.clock.now())
    : new MemoryOutbox(() => coreConfig.clock.now());

  const bus = new EventBus(resolvedLogger);
  registerAuditConsumer(bus, repositories.audit);
  const relay = new OutboxRelay(outbox, bus, resolvedLogger, () => coreConfig.clock.now());

  const deps: ServiceDeps = {
    config: coreConfig,
    logger: resolvedLogger,
    repositories,
    outbox,
    unitOfWork: outbox,
  };

  return {
    organizations: new OrganizationService(deps),
    venues: new VenueService(deps),
    slotRequests: new VenueSlotRequestService(deps),
    events: new EventService(deps),
    catalog: new EventCatalogService(deps),
    analytics: new AnalyticsService(deps),
    actor: buildActorContext,
    actorWithoutTenant: buildTenantlessActor,
    repos: () => repositories,
    relay,
    outbox,
  };
}

/**
 * Resolves the acting user id from the verified session (B10).
 *
 * Every actor-scoped mechanism — idempotency keys included — reads identity
 * through this one function, so there is a single place where "who is calling"
 * is decided.
 */
export function resolveActorId(request: FastifyRequest): string {
  return request.actor?.userId ?? request.authUser?.id ?? 'anonymous';
}

/**
 * The service actor, built from the membership the auth plugin verified.
 *
 * It never reads `X-Organization-Id` directly: the header is a request to act
 * in a tenant, and `authenticate()` has already proven membership before this
 * runs. Reaching here without an actor is an unauthenticated route — fail
 * closed rather than invent a tenant.
 */
function buildActorContext(request: FastifyRequest): ActorContext {
  const actor = request.actor;
  if (!actor) {
    throw new UnauthenticatedRequestError(
      'No authenticated actor on the request — the route is missing its authenticate() preHandler',
    );
  }
  return {
    userId: actor.userId,
    organizationId: actor.organizationId,
    role: actor.role,
    capabilities: actor.capabilities,
  };
}

/**
 * Identity without a tenant. `organizationId` is deliberately empty: every
 * tenant-scoped read compares it with the resource's organization, so an empty
 * scope matches nothing.
 */
function buildTenantlessActor(request: FastifyRequest): ActorContext {
  const user = request.authUser;
  if (!user) {
    throw new UnauthenticatedRequestError(
      'No authenticated user on the request — the route is missing its authenticate() preHandler',
    );
  }
  return { userId: user.id, organizationId: '', role: 'owner', capabilities: [] };
}

export class UnauthenticatedRequestError extends Error {
  readonly code = 'unauthenticated_request';
  constructor(message: string) {
    super(message);
    this.name = 'UnauthenticatedRequestError';
  }
}
