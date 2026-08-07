import { EventNotFoundError } from '../../domain/errors.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  AnalyticsReadModelRepository,
  OrganizationOverview,
  EventAnalytics,
} from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * Analytics is a pure read-model surface: values are precomputed by
 * projections/workers at write time, never scanned on request (N+1 /
 * per-request recompute kills dashboard load). This service only echoes the
 * cached read model.
 */
export class AnalyticsService {
  constructor(private deps: ServiceDeps) {}

  private get repo(): AnalyticsReadModelRepository {
    return this.deps.repositories.analytics;
  }

  async getOrganizationOverview(actor: ActorContext): Promise<OrganizationOverview> {
    requireOrgAccess(actor, actor.organizationId);
    const overview = await this.repo.getOrganizationOverview(actor.organizationId);
    if (!overview) {
      return {
        organizationId: actor.organizationId,
        totalEvents: 0,
        publishedEvents: 0,
        totalRevenuePaise: 0,
        lastEventAt: null,
      };
    }
    return overview;
  }

  async getEventAnalytics(actor: ActorContext, eventId: EntityId): Promise<EventAnalytics> {
    const events = this.deps.repositories.events;
    const event = await events.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      // IDOR guard: do not reveal existence across tenants.
      throw new EventNotFoundError(eventId);
    }
    const analytics = await this.repo.getEventAnalytics(eventId);
    if (!analytics) {
      throw new EventNotFoundError(eventId);
    }
    return analytics;
  }
}
