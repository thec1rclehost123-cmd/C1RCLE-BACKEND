import { getFirestoreClient, getStorageClient } from '@c1rcle/core/infrastructure';

import type { GatewayConfig } from '../config/index.js';
import type { ReadinessCheck, ReadinessChecks } from '../routes/v2/route-manifest.js';

/** Keep readiness probes bounded so an unavailable dependency cannot hang a probe worker. */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export interface ReadinessOptions {
  /** Provide this only when an active Redis client owns the connection. */
  redisCheck?: ReadinessCheck;
  /** Payment routes are disabled today; activate this when those routes go live. */
  paymentProviderActive?: boolean;
  timeoutMs?: number;
}

function withTimeout(check: ReadinessCheck, timeoutMs: number): ReadinessCheck {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(check()).then(Boolean),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function firestoreCredentials(config: GatewayConfig) {
  if (!config.FIREBASE_CLIENT_EMAIL || !config.FIREBASE_PRIVATE_KEY) {
    throw new Error('Firestore readiness requires Firebase service-account credentials');
  }
  return {
    projectId: config.FIRESTORE_PROJECT_ID,
    clientEmail: config.FIREBASE_CLIENT_EMAIL,
    privateKey: config.FIREBASE_PRIVATE_KEY,
  };
}

/**
 * Build dependency probes without performing network I/O during app creation.
 * Firestore and Storage are probed only for the Firestore driver. Redis is
 * intentionally injectable because this repository currently has configuration
 * for Redis but no Redis client or active Redis-owned runtime path.
 */
export function createReadinessChecks(
  config: GatewayConfig,
  options: ReadinessOptions = {},
): ReadinessChecks {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const checks: ReadinessChecks = {};

  if (config.STORAGE_DRIVER === 'firestore') {
    const credentials = firestoreCredentials(config);
    checks.firestore = withTimeout(async () => {
      await getFirestoreClient(credentials).listCollections();
      return true;
    }, timeoutMs);
    checks.storage = withTimeout(async () => {
      const bucket = getStorageClient(credentials).bucket(
        config.FIREBASE_STORAGE_BUCKET ?? `${config.FIRESTORE_PROJECT_ID}.firebasestorage.app`,
      );
      await bucket.getMetadata();
      return true;
    }, timeoutMs);
  }

  if (options.redisCheck && config.REDIS_URL) {
    checks.redis = withTimeout(options.redisCheck, timeoutMs);
  }

  if (options.paymentProviderActive) {
    checks.paymentProvider = withTimeout(
      () =>
        Boolean(
          config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET && config.RAZORPAY_WEBHOOK_SECRET,
        ),
      timeoutMs,
    );
  }

  return checks;
}
