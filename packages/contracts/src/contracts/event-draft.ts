import { z } from 'zod';

const jsonValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).max(500),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const allowedKeys = new Set([
  'media',
  'externalVenue',
  'name',
  'description',
  'venueId',
  'visibilityMode',
  'addressDisclosure',
  'date',
  'dateLabel',
  'time',
  'endTime',
  'genres',
  'artists',
  'artwork',
  'ticketTiers',
  'selectedPromoterIds',
  'tableType',
  'promoCodes',
  'promoCodeSettings',
  'pricingRule',
  'compensation',
  'commissionRate',
  'salaryNotes',
  'tierCommissions',
  'salaryAmount',
  'salaryPeriod',
  'promoterOverrides',
  'earlyBirdDiscountPercent',
  'lateArrivalChargePercent',
  'selectedSlotId',
  'step',
  'externalWorkflowKey',
]);
const safeEditorDataSchema = z.record(z.string(), jsonValueSchema).superRefine((data, ctx) => {
  const inspect = (value: unknown, path: (string | number)[] = []) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, [...path, index]));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (
          /password|token|credential|authorization|signed.?url|upload.?url|secret|private.?key/i.test(
            key,
          )
        )
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: 'Sensitive draft data is not allowed.',
          });
        inspect(child, [...path, key]);
      }
    } else if (typeof value === 'string') {
      if (/^(blob:|data:)/i.test(value))
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'Temporary media URLs are not allowed in drafts.',
        });
      if (/[?&](?:X-Goog-Signature|X-Amz-Signature|token)=/i.test(value))
        ctx.addIssue({ code: 'custom', path, message: 'Signed URLs are not allowed in drafts.' });
    }
  };
  inspect(data);
  const workflowKey = (data as { externalWorkflowKey?: unknown }).externalWorkflowKey;
  if (workflowKey !== undefined && (typeof workflowKey !== 'string' || workflowKey.length > 128))
    ctx.addIssue({
      code: 'custom',
      path: ['externalWorkflowKey'],
      message: 'Invalid workflow key.',
    });
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key))
      ctx.addIssue({ code: 'custom', path: [key], message: 'Unsupported draft field.' });
  }
  if (JSON.stringify(data).length > 100_000)
    ctx.addIssue({ code: 'custom', message: 'Event draft is too large.' });
});

export const eventDraftRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    data: safeEditorDataSchema,
  })
  .strict();
export type EventDraftRequest = z.infer<typeof eventDraftRequestSchema>;

export const eventDraftDtoSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    data: z.record(z.string(), jsonValueSchema),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type EventDraftDto = z.infer<typeof eventDraftDtoSchema>;
export const eventDraftResponseSchema = z
  .object({ draft: eventDraftDtoSchema.nullable() })
  .strict();
