import { z } from 'zod';

/**
 * ─── Guest profile contracts ─────────────────────────────────────────────────
 * The guest-portal signup onboarding (preferred name, date of birth, city,
 * tastes, intents) persisted per session user. One doc per user id, fully
 * replaced on every write — no optimistic-lock version, no idempotency key:
 * `PUT` with the same body converges to the same document, so retries are
 * safe by construction.
 */

const displayNameSchema = z.string().trim().min(1).max(200);
const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD');
const citySchema = z.string().trim().max(100);
const tasteSchema = z.string().trim().min(1).max(60);
const intentSchema = z.string().trim().min(1).max(60);

/** `PUT /api/v2/profile/me` — full-replace body, server owns `userId`. */
export const upsertGuestProfileSchema = z
  .object({
    displayName: displayNameSchema.min(2),
    dateOfBirth: dateOfBirthSchema,
    city: citySchema,
    tastes: z.array(tasteSchema).min(1).max(20),
    intents: z.array(intentSchema).max(10),
  })
  .strict();
export type UpsertGuestProfileRequest = z.infer<typeof upsertGuestProfileSchema>;

/** `GET /api/v2/profile/me` + PUT response. */
export const guestProfileDtoSchema = z.object({
  userId: z.string().min(1).max(128),
  displayName: displayNameSchema,
  dateOfBirth: dateOfBirthSchema,
  /** Private verified contact returned only to the session owner. */
  phoneNumber: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .nullable()
    .default(null),
  city: z.string().max(100),
  tastes: z.array(tasteSchema).min(1).max(20),
  intents: z.array(intentSchema).max(10),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GuestProfileDto = z.infer<typeof guestProfileDtoSchema>;
