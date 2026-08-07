import { randomUUID } from 'crypto';

/**
 * ─── Core configuration ───────────────────────────────────────────────────────
 * Typed, validated application config for `@c1rcle/core` domain layers.
 *
 * Rules:
 * - This module NEVER reads `process.env`. Config is injected by the gateway.
 * - Missing required values fail loudly (fail closed).
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export type IdGenerator = () => string;

export const defaultIdGenerator: IdGenerator = () => randomUUID();

export interface RedisConfig {
  url: string;
  keyPrefix: string;
  commandTimeoutMs: number;
}

export interface FirestoreConfig {
  projectId: string;
  databaseId: string;
}

export type FeatureFlagConfig = Record<string, boolean | undefined>;

export interface CoreConfig {
  clock: Clock;
  ids: IdGenerator;
  redis: RedisConfig;
  firestore: FirestoreConfig;
  features: FeatureFlagConfig;
}

export interface CoreConfigInput {
  clock?: Clock;
  ids?: IdGenerator;
  redis: Partial<RedisConfig> & { url: string };
  firestore: Partial<FirestoreConfig> & { projectId: string };
  features?: FeatureFlagConfig;
}

export class CoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreConfigError';
  }
}

export function createCoreConfig(input: CoreConfigInput): CoreConfig {
  if (!input.redis || typeof input.redis.url !== 'string' || input.redis.url.length === 0) {
    throw new CoreConfigError('CoreConfig requires redis.url');
  }

  if (
    !input.firestore ||
    typeof input.firestore.projectId !== 'string' ||
    !input.firestore.projectId
  ) {
    throw new CoreConfigError('CoreConfig requires firestore.projectId');
  }

  return {
    clock: input.clock ?? systemClock,
    ids: input.ids ?? defaultIdGenerator,
    redis: {
      url: input.redis.url,
      keyPrefix: input.redis.keyPrefix ?? 'c1rcle:',
      commandTimeoutMs: input.redis.commandTimeoutMs ?? 2000,
    },
    firestore: {
      projectId: input.firestore.projectId,
      databaseId: input.firestore.databaseId ?? '(default)',
    },
    features: input.features ?? {},
  };
}

export function isFeatureEnabled(config: CoreConfig, flag: string): boolean {
  return config.features[flag] === true;
}
