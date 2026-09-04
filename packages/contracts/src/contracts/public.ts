import { z } from 'zod';

import { eventDtoSchema } from './event.js';
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
