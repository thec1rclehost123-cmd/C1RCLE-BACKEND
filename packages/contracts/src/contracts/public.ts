import { z } from 'zod';

import { eventDtoSchema } from './event.js';
import { venueAddressSchema, venueDtoSchema } from './organization.js';
import { opaqueIdSchema } from './shared.js';

/**
 * ─── Public / discovery contracts (Phase 4 PR1) ──────────────────────────────
 * Unauthenticated guest-facing surface. Events reuse `eventDtoSchema` and
 * venues reuse `venueDtoSchema` directly (both already public-safe — no
 * contact/business fields leak through either). Hosts need their own DTO:
 * `organizationDtoSchema` carries `role`, which is the *caller's* membership
 * role and has no meaning for an unauthenticated guest.
 */

export const hostPublicDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
});
export type HostPublicDto = z.infer<typeof hostPublicDtoSchema>;

/** Public venue detail. Extends the established flat venue DTO so existing
 * consumers keep their fields while the explicitly public profile fields are
 * available without exposing owner/contact/internal-note data. */
export const venuePublicDetailDtoSchema = venueDtoSchema.extend({
  photoUrl: z.url().nullable(),
  address: venueAddressSchema,
  facilities: z.array(z.string().min(1).max(60)),
});
export type VenuePublicDetailDto = z.infer<typeof venuePublicDetailDtoSchema>;

/** Small event-location projection: enough to identify and describe the
 * authoritative venue without copying its tenant or private profile. */
export const eventVenuePublicDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
  photoUrl: z.url().nullable(),
  address: venueAddressSchema,
});
export type EventVenuePublicDto = z.infer<typeof eventVenuePublicDtoSchema>;

/** The event owner is an Organization aggregate. This projection deliberately
 * omits classification: the domain does not distinguish an individual host
 * from an organization-shaped host yet. */
export const eventOrganizerPublicDtoSchema = hostPublicDtoSchema;
export type EventOrganizerPublicDto = z.infer<typeof eventOrganizerPublicDtoSchema>;

/** `GET /public/events/:idOrSlug` — backward-compatible event fields plus
 * nullable, public-safe relationship projections resolved by PublicService. */
export const eventPublicDetailDtoSchema = eventDtoSchema.extend({
  venue: eventVenuePublicDtoSchema.nullable(),
  organizer: eventOrganizerPublicDtoSchema.nullable(),
});
export type EventPublicDetailDto = z.infer<typeof eventPublicDetailDtoSchema>;

/**
 * `GET /public/discovery` — a curated/featured feed. No distinct "featured"
 * domain concept exists yet, so this is a reasonable aggregate (soonest
 * upcoming published events); a flat `items` list, not paginated, matching
 * "curated feed" rather than "browse everything" semantics.
 */
export const discoveryFeedDtoSchema = z.object({
  items: z.array(eventDtoSchema),
});
export type DiscoveryFeedDto = z.infer<typeof discoveryFeedDtoSchema>;
