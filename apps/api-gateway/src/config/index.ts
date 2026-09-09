/**
 * ─── Gateway environment/config — SOLE owner of process.env ──────────────────
 * Every other file — including `@c1rcle/core` — consumes the validated config
 * exported from here. Env is read once at cold start and validated; missing
 * required values fail loudly (fail closed).
 */

import { BlockList, isIP } from 'node:net';

import { z } from 'zod';

const LOCAL_ORIGINS = 'http://localhost:3000,http://localhost:3001,http://localhost:3002';
const LOCAL_TRUSTED_PROXY_CIDRS = '127.0.0.1,::1';
const DEVELOPMENT_BETTER_AUTH_URL = 'http://localhost:8080';

/** Parse a comma-separated environment setting without silently accepting blanks. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeAddress(address: string): string {
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mappedIpv4?.[1] ?? address;
}

function validateProxyEntry(entry: string): void {
  const separator = entry.lastIndexOf('/');
  const address = separator === -1 ? entry : entry.slice(0, separator);
  const version = isIP(address);
  if (version === 0) throw new Error(`Invalid trusted proxy address: ${entry}`);

  if (separator === -1) return;
  const prefix = Number(entry.slice(separator + 1));
  const maximum = version === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > maximum) {
    throw new Error(`Invalid trusted proxy CIDR: ${entry}`);
  }
}

/**
 * Build the same restricted address matcher used by Fastify and request-ID
 * handling. A zero-length prefix is rejected so configuration cannot become
 * an unrestricted trust-all proxy policy.
 */
export function createTrustedProxyMatcher(entries: readonly string[]) {
  const blockList = new BlockList();
  for (const entry of entries) {
    validateProxyEntry(entry);
    const separator = entry.lastIndexOf('/');
    const address = normalizeAddress(separator === -1 ? entry : entry.slice(0, separator));
    const version = isIP(address);
    const type = version === 6 ? 'ipv6' : 'ipv4';
    if (separator === -1) blockList.addAddress(address, type);
    else blockList.addSubnet(address, Number(entry.slice(separator + 1)), type);
  }

  return (address: string | undefined): boolean => {
    if (!address) return false;
    const normalized = normalizeAddress(address);
    const version = isIP(normalized);
    return version > 0 && blockList.check(normalized, version === 6 ? 'ipv6' : 'ipv4');
  };
}

function validateOrigins(value: string, field: string): string[] {
  const origins = parseList(value);
  if (origins.length === 0) throw new Error(`${field} must contain at least one origin`);
  for (const origin of origins) {
    if (origin === '*' || origin.includes('*'))
      throw new Error(`${field} cannot contain a wildcard origin`);
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/') {
      throw new Error(`${field} must contain origin URLs without paths: ${origin}`);
    }
  }
  return origins;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  /** Public edge URL used by callbacks and deployment-facing metadata. */
  PUBLIC_API_URL: z.url().default(DEVELOPMENT_BETTER_AUTH_URL),
  /** Comma-separated browser origins. Wildcards are rejected below. */
  ALLOWED_ORIGINS: z.string().default(LOCAL_ORIGINS),
  /** Optional explicit Better Auth origins; defaults to ALLOWED_ORIGINS. */
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  /** Comma-separated Nginx/LB/ingress addresses or CIDRs. */
  TRUSTED_PROXY_CIDRS: z.string().default(LOCAL_TRUSTED_PROXY_CIDRS),
  /** Build metadata returned by the internal version endpoint. */
  APP_VERSION: z.string().min(1).default('0.1.0'),
  BUILD_SHA: z.string().min(1).default('unknown'),
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
  BETTER_AUTH_SECRET: z.string().min(1).default('dev-only-change-me'),
  BETTER_AUTH_URL: z.url().default(DEVELOPMENT_BETTER_AUTH_URL),
  /** Render's immutable commit metadata, consumed as BUILD_SHA when no override is supplied. */
  RENDER_GIT_COMMIT: z.string().min(1).optional(),
  /** Phase 4: Razorpay credentials. */
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Email OTP delivery and at-rest OTP HMAC key. */
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_OTP_SECRET: z.string().min(1).optional(),
  /**
   * Escape hatch for CI's Docker smoke-boot only — it exercises the
   * production config guards (NODE_ENV=production) without real Firestore
   * credentials, by design (see ci.yml's "Smoke-boot the container" step).
   * `render.yaml` never sets this, so the real deploy still fails closed on
   * STORAGE_DRIVER=memory in production.
   */
  ALLOW_MEMORY_STORAGE_IN_PRODUCTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** Fail closed: STORAGE_DRIVER=firestore requires real credentials, never a silent memory fallback. */
const validatedEnvSchema = envSchema.superRefine((value, ctx) => {
  const allowedOrigins = (() => {
    try {
      return validateOrigins(value.ALLOWED_ORIGINS, 'ALLOWED_ORIGINS');
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: error instanceof Error ? error.message : 'Invalid allowed origins',
      });
      return [];
    }
  })();

  const trustedOrigins = value.BETTER_AUTH_TRUSTED_ORIGINS ?? value.ALLOWED_ORIGINS;
  try {
    validateOrigins(trustedOrigins, 'BETTER_AUTH_TRUSTED_ORIGINS');
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_TRUSTED_ORIGINS'],
      message: error instanceof Error ? error.message : 'Invalid Better Auth origins',
    });
  }

  try {
    const proxyEntries = parseList(value.TRUSTED_PROXY_CIDRS);
    if (proxyEntries.length === 0) throw new Error('TRUSTED_PROXY_CIDRS must not be empty');
    createTrustedProxyMatcher(proxyEntries);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUSTED_PROXY_CIDRS'],
      message: error instanceof Error ? error.message : 'Invalid trusted proxy configuration',
    });
  }

  if (value.STORAGE_DRIVER === 'firestore') {
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
  }

  if (value.NODE_ENV !== 'production') return;

  if (value.STORAGE_DRIVER !== 'firestore' && !value.ALLOW_MEMORY_STORAGE_IN_PRODUCTION) {
    ctx.addIssue({
      code: 'custom',
      path: ['STORAGE_DRIVER'],
      message: 'Production requires STORAGE_DRIVER=firestore',
    });
  }
  if (value.BETTER_AUTH_SECRET === 'dev-only-change-me' || value.BETTER_AUTH_SECRET.length < 32) {
    ctx.addIssue({
      code: 'custom',
      path: ['BETTER_AUTH_SECRET'],
      message: 'Production requires a non-development secret of at least 32 characters',
    });
  }
  if (!value.EMAIL_OTP_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['EMAIL_OTP_SECRET'],
      message: 'Production requires EMAIL_OTP_SECRET',
    });
  }
  for (const [field, rawOrigins] of [
    ['ALLOWED_ORIGINS', allowedOrigins],
    ['BETTER_AUTH_TRUSTED_ORIGINS', parseList(trustedOrigins)],
  ] as const) {
    for (const origin of rawOrigins) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        continue;
      }
      if (parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `Production origins must use HTTPS: ${origin}`,
        });
      }
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `Production origins cannot be local development hosts: ${origin}`,
        });
      }
    }
  }
  if (
    new URL(value.PUBLIC_API_URL).protocol !== 'https:' ||
    new URL(value.BETTER_AUTH_URL).protocol !== 'https:'
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_API_URL', 'BETTER_AUTH_URL'],
      message: 'Production public and Better Auth URLs must use HTTPS',
    });
  }
});

export type GatewayConfig = z.infer<typeof envSchema>;

export function getAllowedOrigins(config: GatewayConfig): string[] {
  return validateOrigins(config.ALLOWED_ORIGINS, 'ALLOWED_ORIGINS');
}

export function getBetterAuthTrustedOrigins(config: GatewayConfig): string[] {
  return validateOrigins(
    config.BETTER_AUTH_TRUSTED_ORIGINS ?? config.ALLOWED_ORIGINS,
    'BETTER_AUTH_TRUSTED_ORIGINS',
  );
}

export function getTrustedProxyCidrs(config: GatewayConfig): string[] {
  return parseList(config.TRUSTED_PROXY_CIDRS);
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

let cached: GatewayConfig | null = null;

/** Reads + validates env exactly once. Throws on invalid/missing required. */
export function getGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  // Keep the production process fast while allowing tests and tooling to
  // validate independent environment objects without mutating process.env.
  if (env === process.env && cached) return cached;
  // Render exposes the immutable deploy SHA as RENDER_GIT_COMMIT. Keep
  // BUILD_SHA provider-neutral, but consume the documented Render value when
  // an explicit BUILD_SHA override is not supplied.
  const input =
    env.BUILD_SHA || !env.RENDER_GIT_COMMIT ? env : { ...env, BUILD_SHA: env.RENDER_GIT_COMMIT };
  const parsed = validatedEnvSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new GatewayConfigError(`Invalid environment configuration: ${issues}`);
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}
