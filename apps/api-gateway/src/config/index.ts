/**
 * ─── Gateway environment/config — SOLE owner of process.env ──────────────────
 * Every other file — including `@c1rcle/core` — consumes the validated config
 * exported from here. Env is read once at cold start and validated; missing
 * required values fail loudly (fail closed).
 */

import { z } from 'zod';

/** Placeholder secret for local development. Rejected in production below. */
const DEV_AUTH_SECRET = 'dev-only-change-me';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  FIRESTORE_PROJECT_ID: z.string().min(1).default('c1rcle-staging'),
  /** B12: which repository adapter set `lib/v2-services.ts` wires up. */
  STORAGE_DRIVER: z.enum(['memory', 'firestore']).default('memory'),
  /** Firestore service-account credentials (only read/used when STORAGE_DRIVER=firestore). */
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  /** Bucket for onboarding KYC images. Defaults to `<project>.firebasestorage.app`. */
  FIREBASE_STORAGE_BUCKET: z.string().min(1).optional(),
  /** B10: Better Auth. */
  BETTER_AUTH_SECRET: z.string().min(1).default(DEV_AUTH_SECRET),
  BETTER_AUTH_URL: z.string().min(1).default('http://localhost:8080'),
  /**
   * Commit SHA of the running build. Render injects `RENDER_GIT_COMMIT`
   * automatically; CI reads it back from `/api/v2/internal/version` to tell a
   * finished deploy apart from the previous one still serving traffic.
   */
  RENDER_GIT_COMMIT: z.string().min(1).optional(),
  /** Phase 4: Razorpay credentials. */
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Email OTP delivery (signup verification). Unset -> dev-mode logging only. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** HMAC key for hashing email-OTP codes at rest (see CoreConfig's doc comment). */
  EMAIL_OTP_SECRET: z.string().min(1).optional(),
});

/** Fail closed: STORAGE_DRIVER=firestore requires real credentials, never a silent memory fallback. */
const validatedEnvSchema = envSchema.superRefine((value, ctx) => {
  // A development default that survives into production is not a default, it is
  // a published secret. Better Auth signs sessions with this value, so shipping
  // `dev-only-change-me` means anyone who has read this repository can mint a
  // session. Fail the boot instead.
  if (value.NODE_ENV === 'production') {
    if (value.BETTER_AUTH_SECRET === DEV_AUTH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message:
          'Must be set to a real secret in production — the development default is public. ' +
          'Generate one with `openssl rand -hex 32`.',
      });
    } else if (value.BETTER_AUTH_SECRET.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message: 'Must be at least 32 characters in production.',
      });
    }
    if (value.BETTER_AUTH_URL.startsWith('http://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_URL'],
        message:
          'Must be an https:// URL in production — session cookies issued against ' +
          'an http:// origin are not marked Secure.',
      });
    }
    if (!value.EMAIL_OTP_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_OTP_SECRET'],
        message:
          'Required in production — without it, email-OTP codes are hashed with the ' +
          "published default secret, letting anyone who reads this repo's source brute-force " +
          'a leaked OTP hash offline in milliseconds (10^6 possible 6-digit codes).',
      });
    }
  }

  if (value.STORAGE_DRIVER !== 'firestore') return;
  if (!value.FIREBASE_CLIENT_EMAIL) {
    ctx.addIssue({
      code: 'custom',
      path: ['FIREBASE_CLIENT_EMAIL'],
      message: 'Required when STORAGE_DRIVER=firestore',
    });
  }
  if (!value.FIREBASE_PRIVATE_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['FIREBASE_PRIVATE_KEY'],
      message: 'Required when STORAGE_DRIVER=firestore',
    });
  }
});

export type GatewayConfig = z.infer<typeof envSchema>;

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

let cached: GatewayConfig | null = null;

/** Reads + validates env exactly once. Throws on invalid/missing required. */
export function getGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (cached) return cached;
  const parsed = validatedEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new GatewayConfigError(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
