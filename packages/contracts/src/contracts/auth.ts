import { z } from 'zod';

/**
 * ─── Auth / Session Contracts ─────────────────────────────────────────────────
 * Better Auth bridge and session types
 */

export const roleSchema = z.enum(['guest', 'partner', 'admin']);
export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1),
  role: roleSchema,
  avatarUrl: z.url().nullable(),
  /**
   * True when the account is still on its staff-invitation temporary
   * password. The client must route to the password-change screen; the
   * gateway 403s every non-auth route until the rotation completes.
   */
  mustChangePassword: z.boolean(),
});
export type User = z.infer<typeof userSchema>;

export const sessionSchema = z.object({
  user: userSchema,
  expiresAt: z.number().int().positive(),
});
export type Session = z.infer<typeof sessionSchema>;

/* ─── B10 auth bridge (Better Auth session ↔ frontend contract) ─────────── */

export const signupRequestSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(128),
    displayName: z.string().min(1).max(200),
  })
  .strict();
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z
  .object({
    email: z.email(),
    password: z.string().min(1).max(128),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `POST /auth/{signup,login,refresh}` response — task.md §0 frontend bridge shape. */
export const authBridgeResponseSchema = z.object({
  user: userSchema,
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type AuthBridgeResponse = z.infer<typeof authBridgeResponseSchema>;

/* ─── First-login password rotation (staff-invitation credentials) ─────── */

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .strict()
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

/* ─── Email OTP (signup verification) ─────────────────────────────────────── */

export const otpSendRequestSchema = z
  .object({
    email: z.email(),
  })
  .strict();
export type OtpSendRequest = z.infer<typeof otpSendRequestSchema>;

export const otpVerifyRequestSchema = z
  .object({
    email: z.email(),
    code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  })
  .strict();
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequestSchema>;

/** Deliberately generic — never confirms whether the address is registered. */
export const otpAckResponseSchema = z.object({
  message: z.string(),
});
export type OtpAckResponse = z.infer<typeof otpAckResponseSchema>;

/* ─── Password reset (forgot / reset) ─────────────────────────────────────── */

export const forgotPasswordRequestSchema = z
  .object({
    email: z.email(),
  })
  .strict();
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z
  .object({
    newPassword: z.string().min(8).max(128),
    token: z.string().min(1),
  })
  .strict();
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/**
 * Better Auth's reset endpoints answer `{status: true}` (requestPasswordReset
 * also carries a constant anti-oracle message). The gateway validates that
 * exact shape on the wire.
 */
export const passwordResetAckSchema = z.object({
  status: z.literal(true),
  message: z.string().optional(),
});
export type PasswordResetAck = z.infer<typeof passwordResetAckSchema>;
