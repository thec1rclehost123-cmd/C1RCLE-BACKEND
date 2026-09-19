import { PLATFORM_SETTINGS_DOC_ID } from '../../domain/models/platform-settings.js';

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
    return snap.exists
      ? (snap.data() as unknown as PlatformSettings)
      : {
          platformFeeRate: 0.15,
          refundSingleApproverThresholdPaise: 50_000,
          refundDualApproverThresholdPaise: 500_000,
          maintenanceMode: false,
          featureFlags: {},
          updatedAt: new Date(0).toISOString(),
        };
  }

  async save(settings: PlatformSettings): Promise<void> {
    await this.db
      .collection(COLLECTION)
      .doc(PLATFORM_SETTINGS_DOC_ID)
      .set({ ...settings });
  }
}
