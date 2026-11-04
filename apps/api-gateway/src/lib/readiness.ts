import { getFirestoreClient, getStorageClient } from '@c1rcle/core/infrastructure';

import type { GatewayConfig } from '../config/index.js';
import type { ReadinessCheck, ReadinessChecks } from '../routes/v2/route-manifest.js';

/** Keep readiness probes bounded so an unavailable dependency cannot hang a probe worker. */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export interface ReadinessOptions {
  /** Provide this only when an active Redis client owns the connection. */
  redisCheck?: ReadinessCheck;
  /** Check Razorpay configuration presence only; this does not contact the provider. */
  paymentProviderActive?: boolean;
  timeoutMs?: number;
}

function withTimeout(check: ReadinessCheck, timeoutMs: number): ReadinessCheck {
  let inFlight: Promise<boolean> | undefined;
  return async () => {
    // Timing out the waiter does not cancel an SDK request. Keep sharing it
    // until it settles so repeated/concurrent health probes cannot accumulate
    // background RPCs during an outage. Never cache the result after settlement.
    if (!inFlight) {
      const operation = Promise.resolve().then(check).then(Boolean);
      inFlight = operation;
      const clear = () => {
        if (inFlight === operation) inFlight = undefined;
      };
      void operation.then(clear, clear);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        inFlight,
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
 * injected by the app only when its rate limiter owns an active Redis client.
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
