/**
 * ─── Gateway environment/config — SOLE owner of process.env ──────────────────
 * Every other file — including `@c1rcle/core` — consumes the validated config
 * exported from here. Env is read once at cold start and validated; missing
 * required values fail loudly (fail closed).
 */

import { z } from 'zod';

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
  /** B10: Better Auth. */
  BETTER_AUTH_SECRET: z.string().min(1).default('dev-only-change-me'),
  BETTER_AUTH_URL: z.string().min(1).default('http://localhost:8080'),
});

/** Fail closed: STORAGE_DRIVER=firestore requires real credentials, never a silent memory fallback. */
const validatedEnvSchema = envSchema.superRefine((value, ctx) => {
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
