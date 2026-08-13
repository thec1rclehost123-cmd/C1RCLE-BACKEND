/**
 * ─── Application-layer barrel ─────────────────────────────────────────────────
 * Single entrypoint for the V2 partners-slice application services. The
 * Fastify v2 routes depend on this barrel (plus `ServiceDeps`) — never on
 * individual files or on infra. Zero Fastify/Firestore imports in this subtree.
 */

export * from './context.js';
export { OrganizationService } from './organizations/organization-service.js';
export type {
  CreateOrganizationCommand,
  InviteMemberCommand,
  UpdateOrganizationCommand,
} from './organizations/organization-service.js';
export {
  VenueService,
  VenueCalendarService,
  VenueSlotRequestService,
} from './venues/venue-service.js';
export type { CreateVenueCommand, UpdateVenueCommand } from './venues/venue-service.js';
export { EventService } from './events/event-service.js';
export type { CreateEventCommand, UpdateEventCommand } from './events/event-service.js';
export { EventCatalogService } from './event-catalog/event-catalog-service.js';
export type {
  CreateTierCommand,
  CreatePromotionCommand,
  CreateTableCommand,
  AssignPromoterCommand,
  CommissionTerms,
} from './event-catalog/event-catalog-service.js';
export { AnalyticsService } from './analytics/analytics-service.js';
export { IdempotencyService } from './idempotency/idempotency-service.js';
export type { IdempotentCommand, IdempotentResult } from './idempotency/idempotency-service.js';
export { InProcessEventBus } from './events/event-bus.js';
export type { EventHandler } from './events/event-bus.js';
export { createAuditConsumer, createProjectionConsumer } from './events/audit-consumers.js';
