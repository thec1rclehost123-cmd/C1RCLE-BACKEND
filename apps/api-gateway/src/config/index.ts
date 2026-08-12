/**
 * ─── Gateway environment/config — SOLE owner of process.env ──────────────────
 * Every other file — including `@c1rcle/core` — consumes the validated config
 * exported from here. Env is read once at cold start and validated; missing
 * required values fail loudly (fail closed).
 */

import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    FIRESTORE_PROJECT_ID: z.string().min(1).default('c1rcle-staging'),

    /**
     * Storage engine behind the repository ports. `memory` is dev/test only;
     * `sqlite` is durable. Production must not run on memory — see the refine
     * below, which fails startup rather than quietly losing every write.
     */
    STORAGE_DRIVER: z.enum(['memory', 'sqlite']).default('memory'),
    /** SQLite location; `:memory:` keeps it ephemeral for tests. */
    SQLITE_PATH: z.string().min(1).default('.data/c1rcle.sqlite'),

    /** Signs sessions. A dev-only default exists; production must set its own. */
    AUTH_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-32+'),
    /** Absolute origin the auth cookies are issued for. */
    AUTH_BASE_URL: z.url().default('http://localhost:8080'),
    /** Browser origins allowed to hold a session cookie (the frontend apps). */
    AUTH_TRUSTED_ORIGINS: z
      .string()
      .default('http://localhost:3000,http://localhost:3001,http://localhost:3002'),
    /** Session lifetime in seconds (the refresh-cookie window). Default 7 days. */
    AUTH_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 7),
  })
  .superRefine((config, ctx) => {
    // Fail closed: a production process must not hold business data in RAM.
    if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'STORAGE_DRIVER=memory is not permitted in production',
      });
    }
    // Fail closed: the dev secret must never reach production.
    if (config.NODE_ENV === 'production' && config.AUTH_SECRET.startsWith('dev-only-')) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message: 'AUTH_SECRET must be set to a real secret in production',
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
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new GatewayConfigError(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
