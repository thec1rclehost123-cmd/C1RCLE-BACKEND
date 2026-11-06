import { z } from 'zod';

import { eventStatusSchema } from './event.js';
import { opaqueIdSchema } from './shared.js';

export const savedEventStateSchema = z.object({ saved: z.boolean() }).strict();
export const savedEventListQuerySchema = z.object({ cursor: opaqueIdSchema.optional() }).strict();
export const savedEventPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          eventId: opaqueIdSchema,
          savedAt: z.iso.datetime(),
          event: z
            .object({
              id: opaqueIdSchema,
              slug: z.string().min(1).max(300),
              title: z.string().min(1).max(300),
              startAt: z.iso.datetime(),
              status: eventStatusSchema,
              imageUrl: z.url().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    nextCursor: opaqueIdSchema.nullable(),
  })
  .strict();
export type SavedEventPage = z.infer<typeof savedEventPageSchema>;
