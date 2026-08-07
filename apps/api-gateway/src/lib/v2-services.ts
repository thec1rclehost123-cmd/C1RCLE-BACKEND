import { createLogger, type Logger } from '@c1rcle/core';
import {
  OrganizationService,
  VenueService,
  EventService,
  EventCatalogService,
  AnalyticsService,
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
} from '@c1rcle/core/infrastructure';

import type { ServiceDeps, ActorContext } from '@c1rcle/core/application';
import type { OrganizationRole, Capability } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../config/index.js';

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
  events: EventService;
  catalog: EventCatalogService;
  analytics: AnalyticsService;
  /** Builds the service actor from the authenticated request state. */
  actor(request: FastifyRequest): ActorContext;
  /** Raw repository bundle for seed/test wiring only. */
  repos(): ServiceDeps['repositories'];
}

export function createV2Services(logger?: Logger): PartnerV2Services {
  const gw = getGatewayConfig();
  const coreConfig = createCoreConfig({
    redis: { url: gw.REDIS_URL },
    firestore: { projectId: gw.FIRESTORE_PROJECT_ID },
  });

  const repositories: ServiceDeps['repositories'] = {
    organizations: new MemoryOrganizationRepository(),
    venues: new MemoryVenueRepository(),
    slotRequests: new MemorySlotRequestRepository(),
    venueSlots: new MemoryVenueSlotRepository(),
    events: new MemoryEventRepository(),
    catalog: new MemoryEventCatalogRepository(),
    analytics: new MemoryAnalyticsReadModelRepository(),
  };

  const deps: ServiceDeps = {
    config: coreConfig,
    logger:
      logger ??
      createLogger({
        info: (message, obj) => console.info(message, obj ?? {}),
        warn: (message, obj) => console.warn(message, obj ?? {}),
        error: (message, obj) => console.error(message, obj ?? {}),
      }),
    repositories,
  };

  return {
    organizations: new OrganizationService(deps),
    venues: new VenueService(deps),
    events: new EventService(deps),
    catalog: new EventCatalogService(deps),
    analytics: new AnalyticsService(deps),
    actor: buildActorContext,
    repos: () => repositories,
  };
}

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
