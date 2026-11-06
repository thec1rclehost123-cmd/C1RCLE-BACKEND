import { randomUUID, createHash } from 'crypto';

import {
  PROMOTER_AGREEMENT_TEST_FIXTURE,
  type PromoterAgreementArtifact,
} from '../domain/models/promoter-agreement.js';

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
  deploymentEnvironment: 'production' | 'staging' | 'local';
  promoterAgreement: PromoterAgreementArtifact | null;
  magicTicketSecret: string;
  /** Phase 6: AES key-derivation secret/salt for bank-account-number at-rest encryption. */
  bankEncryptionSecret: string;
  bankEncryptionSalt: string;
  /**
   * HMAC key for hashing email-OTP codes at rest. A 6-digit code has only
   * 10^6 possibilities — a bare unsalted hash (SHA-256(code)) is brute-forced
   * offline in milliseconds if the row ever leaks, so the hash must be keyed
   * by a server secret an attacker with DB read access does not also have.
   */
  emailOtpSecret: string;
  /**
   * Public origin of the partner dashboard, used to build absolute staff-
   * invitation accept links. Optional: when absent, invitation emails omit the
   * link (the invitee asks their manager for it) rather than linking nowhere.
   */
  partnerDashboardUrl?: string | undefined;
  /** Server-configured Guest origin for invitation links; never supplied by a command. */
  guestPortalUrl: string;
}

export interface CoreConfigInput {
  clock?: Clock;
  ids?: IdGenerator;
  redis: Partial<RedisConfig> & { url: string };
  firestore: Partial<FirestoreConfig> & { projectId: string };
  storage?: Partial<StorageConfig>;
  features?: FeatureFlagConfig;
  deploymentEnvironment?: 'production' | 'staging' | 'local';
  promoterAgreement?: PromoterAgreementArtifact | null;
  magicTicketSecret?: string;
  bankEncryptionSecret?: string;
  bankEncryptionSalt?: string;
  emailOtpSecret?: string;
  partnerDashboardUrl?: string;
  guestPortalUrl?: string;
}

export class CoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreConfigError';
  }
}

/**
 * The secret and salt that bank-account numbers were encrypted with before the
 * gateway wired `ENCRYPTION_KEY` through. They are published in this repository,
 * so they protect nothing; they exist only so records written under them can
 * still be decrypted (see `getFullAccountNumber`). Never use them to encrypt.
 */
export const LEGACY_BANK_ENCRYPTION_SECRET = 'default-bank-encryption-secret-change-in-production';
export const LEGACY_BANK_ENCRYPTION_SALT = 'default-bank-encryption-salt';

export const DEFAULT_GUEST_PORTAL_URL = 'https://thec1rcle.com';

/** Invitation URLs may target one configured HTTP(S) origin, never a caller-provided path. */
export function guestPortalOrigin(value: string = DEFAULT_GUEST_PORTAL_URL): string {
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid origin');
    return url.origin;
  } catch {
    throw new CoreConfigError(
      'guestPortalUrl must be an HTTP(S) origin without credentials, paths, query or fragment',
    );
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
    guestPortalUrl: guestPortalOrigin(input.guestPortalUrl),
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
    deploymentEnvironment: input.deploymentEnvironment ?? 'production',
    promoterAgreement: validatePromoterAgreement(
      input.promoterAgreement ?? null,
      input.deploymentEnvironment ?? 'production',
    ),
    magicTicketSecret:
      input.magicTicketSecret ?? 'default-magic-ticket-secret-change-in-production',
    bankEncryptionSecret: input.bankEncryptionSecret ?? LEGACY_BANK_ENCRYPTION_SECRET,
    bankEncryptionSalt: input.bankEncryptionSalt ?? LEGACY_BANK_ENCRYPTION_SALT,
    emailOtpSecret: input.emailOtpSecret ?? 'default-email-otp-secret-change-in-production',
    ...(input.partnerDashboardUrl ? { partnerDashboardUrl: input.partnerDashboardUrl } : {}),
  };
}

export function isFeatureEnabled(config: CoreConfig, flag: string): boolean {
  return config.features[flag] === true;
}

/** Trusted deployment configuration, never accepted from a client request. */
export function validatePromoterAgreement(
  artifact: PromoterAgreementArtifact | null,
  environment: 'production' | 'staging' | 'local',
): PromoterAgreementArtifact | null {
  if (!artifact) return null;
  if (
    !artifact.version.trim() ||
    artifact.version.length > 120 ||
    !artifact.text.trim() ||
    artifact.text.length > 10_000 ||
    createHash('sha256').update(artifact.text).digest('hex') !== artifact.textSha256
  ) {
    throw new CoreConfigError('Promoter agreement requires a version, text and matching SHA-256');
  }
  if (!artifact.version.endsWith(`-${artifact.textSha256}`)) {
    throw new CoreConfigError('Promoter agreement version must end in its full content SHA-256');
  }
  if (artifact.status !== 'approved' && artifact.status !== 'staging_only') {
    throw new CoreConfigError('Configured Promoter agreement cannot be a test fixture');
  }
  if (
    artifact.status === 'staging_only' &&
    (environment !== 'staging' ||
      !artifact.version.startsWith('staging-') ||
      !artifact.text.startsWith('C1RCLE STAGING PROMOTER AGREEMENT — FOR TESTING ONLY'))
  ) {
    throw new CoreConfigError(
      'Staging-only Promoter agreement requires the staging environment and explicit staging labels',
    );
  }
  if (
    artifact.status === 'approved' &&
    (artifact.version.startsWith('staging-') ||
      artifact.text.startsWith('C1RCLE STAGING PROMOTER AGREEMENT'))
  ) {
    throw new CoreConfigError('Production agreement cannot use a staging version');
  }
  return Object.freeze({ ...artifact });
}

export function currentPromoterAgreement(config: CoreConfig): PromoterAgreementArtifact | null {
  return (
    config.promoterAgreement ??
    (config.deploymentEnvironment === 'local' && config.features.m4PromoterAgreementFixture === true
      ? PROMOTER_AGREEMENT_TEST_FIXTURE
      : null)
  );
}
