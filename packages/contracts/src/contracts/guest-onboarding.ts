import { z } from 'zod';

export const guestOnboardingPatchSchema = z
  .object({
    displayName: z.string().trim().min(2).max(200).optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    tastes: z.array(z.string().min(1).max(60)).min(1).max(9).optional(),
  })
  .strict();
export const guestPhoneProofSchema = z
  .object({
    phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/),
    proofToken: z.string().min(1).max(10000),
  })
  .strict();
export const guestOnboardingStateSchema = z.object({
  displayName: z.string(),
  dateOfBirth: z.string(),
  tastes: z.array(z.string()),
  phoneNumber: z.string().nullable(),
  phoneVerified: z.boolean(),
  complete: z.boolean(),
  interestOptions: z.array(z.string()),
});
export type GuestOnboardingState = z.infer<typeof guestOnboardingStateSchema>;
