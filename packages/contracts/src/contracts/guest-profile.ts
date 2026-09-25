import { z } from 'zod';

/**
 * ─── Guest profile contracts ─────────────────────────────────────────────────
 * The guest-portal signup onboarding (preferred name, date of birth, city,
 * tastes, intents) persisted per session user. One doc per user id, fully
 * replaced on every write — no optimistic-lock version, no idempotency key:
 * `PUT` with the same body converges to the same document, so retries are
 * safe by construction.
 */

const displayNameSchema = z.string().min(1).max(200);
const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD');
const citySchema = z.string().min(1).max(100);
const tasteSchema = z.string().min(1).max(60);
const intentSchema = z.string().min(1).max(60);

/** `PUT /api/v2/profile/me` — full-replace body, server owns `userId`. */
export const upsertGuestProfileSchema = z
  .object({
    displayName: displayNameSchema,
    dateOfBirth: dateOfBirthSchema,
    city: citySchema,
    tastes: z.array(tasteSchema).min(3).max(20),
    intents: z.array(intentSchema).min(1).max(10),
  })
  .strict();
export type UpsertGuestProfileRequest = z.infer<typeof upsertGuestProfileSchema>;

/** `GET /api/v2/profile/me` + PUT response. */
export const guestProfileDtoSchema = z.object({
  userId: z.string().min(1).max(128),
  displayName: displayNameSchema,
  dateOfBirth: dateOfBirthSchema,
  city: citySchema,
  tastes: z.array(tasteSchema).min(3).max(20),
  intents: z.array(intentSchema).min(1).max(10),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type GuestProfileDto = z.infer<typeof guestProfileDtoSchema>;
