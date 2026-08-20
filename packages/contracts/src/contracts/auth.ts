import { z } from 'zod';
import { opaqueIdSchema } from './shared.js';

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