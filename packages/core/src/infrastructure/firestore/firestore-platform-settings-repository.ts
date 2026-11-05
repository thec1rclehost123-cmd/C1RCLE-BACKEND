import { createHash } from 'node:crypto';

import { ConflictError, VersionConflictError } from '../../domain/errors.js';
import {
  snapshotBookingFeePolicy,
  type BookingFeePolicy,
} from '../../domain/models/booking-fee-policy.js';
import {
  DEFAULT_PLATFORM_SETTINGS,
  PLATFORM_SETTINGS_DOC_ID,
} from '../../domain/models/platform-settings.js';

import type { PlatformSettings } from '../../domain/models/platform-settings.js';
import type { PlatformSettingsRepository } from '../../domain/ports/repositories.js';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_platform_settings';

/**
 * Firestore adapter for `PlatformSettingsRepository` — singleton doc
 * (`v2_platform_settings/singleton`).
 */
export class FirestorePlatformSettingsRepository implements PlatformSettingsRepository {
  constructor(private readonly db: Firestore) {}

  async get(): Promise<PlatformSettings> {
    const snap = await this.db.collection(COLLECTION).doc(PLATFORM_SETTINGS_DOC_ID).get();
    if (!snap.exists) return structuredClone(DEFAULT_PLATFORM_SETTINGS);
    const stored = snap.data() as Partial<PlatformSettings>;
    return {
      ...structuredClone(DEFAULT_PLATFORM_SETTINGS),
      ...stored,
      featureFlags: stored.featureFlags ?? {},
      accountingPolicy: {
        ...DEFAULT_PLATFORM_SETTINGS.accountingPolicy,
        ...(stored.accountingPolicy ?? {}),
      },
    };
  }

  async save(settings: PlatformSettings, expectedRevision: number): Promise<void> {
    const singleton = this.db.collection(COLLECTION).doc(PLATFORM_SETTINGS_DOC_ID);
    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(singleton);
      const current = snapshot.data() as Partial<PlatformSettings> | undefined;
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) throw new VersionConflictError(expectedRevision, revision);
      const policies = [
        current?.bookingFeePolicy ?? DEFAULT_PLATFORM_SETTINGS.bookingFeePolicy,
        settings.bookingFeePolicy ?? DEFAULT_PLATFORM_SETTINGS.bookingFeePolicy,
      ]
        .filter((policy): policy is BookingFeePolicy => policy !== undefined)
        .map(snapshotBookingFeePolicy);
      const unique = new Map<string, BookingFeePolicy>();
      for (const policy of policies) {
        const previous = unique.get(policy.version);
        if (previous && JSON.stringify(previous) !== JSON.stringify(policy))
          throw new ConflictError(
            'A booking fee policy version cannot be reused with different terms',
          );
        unique.set(policy.version, policy);
      }
      const versions = await Promise.all(
        [...unique.values()].map(async (policy) => {
          const ref = this.db
            .collection(COLLECTION)
            .doc(`booking-fee-policy-${createHash('sha256').update(policy.version).digest('hex')}`);
          const stored = await tx.get(ref);
          if (
            stored.exists &&
            JSON.stringify(snapshotBookingFeePolicy(stored.data()?.policy as BookingFeePolicy)) !==
              JSON.stringify(policy)
          )
            throw new ConflictError(
              'A booking fee policy version cannot be reused with different terms',
            );
          return { ref, policy, exists: stored.exists };
        }),
      );
      for (const entry of versions)
        if (!entry.exists)
          tx.create(entry.ref, { policy: { ...entry.policy }, registeredAt: settings.updatedAt });
      tx.set(singleton, { ...settings, revision: expectedRevision + 1 });
    });
  }
}
