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

export interface StorageConfig {
  /** Bucket that holds onboarding KYC images. */
  kycBucket: string;
}

export type FeatureFlagConfig = Record<string, boolean | undefined>;

export interface CoreConfig {
  clock: Clock;
  ids: IdGenerator;
  redis: RedisConfig;
  firestore: FirestoreConfig;
  storage: StorageConfig;
  features: FeatureFlagConfig;
  magicTicketSecret: string;
  /** Phase 6: AES key-derivation secret/salt for bank-account-number at-rest encryption. */
  bankEncryptionSecret: string;
  bankEncryptionSalt: string;
}

export interface CoreConfigInput {
  clock?: Clock;
  ids?: IdGenerator;
  redis: Partial<RedisConfig> & { url: string };
  firestore: Partial<FirestoreConfig> & { projectId: string };
  storage?: Partial<StorageConfig>;
  features?: FeatureFlagConfig;
  magicTicketSecret?: string;
  bankEncryptionSecret?: string;
  bankEncryptionSalt?: string;
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
    storage: {
      // Firebase's default bucket for a project. Override via
      // FIREBASE_STORAGE_BUCKET when the bucket is named differently.
      kycBucket: input.storage?.kycBucket ?? `${input.firestore.projectId}.firebasestorage.app`,
    },
    features: input.features ?? {},
    magicTicketSecret:
      input.magicTicketSecret ?? 'default-magic-ticket-secret-change-in-production',
    bankEncryptionSecret:
      input.bankEncryptionSecret ?? 'default-bank-encryption-secret-change-in-production',
    bankEncryptionSalt: input.bankEncryptionSalt ?? 'default-bank-encryption-salt',
  };
}

export function isFeatureEnabled(config: CoreConfig, flag: string): boolean {
  return config.features[flag] === true;
}
