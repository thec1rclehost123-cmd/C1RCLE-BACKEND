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

  async save(settings: PlatformSettings): Promise<void> {
    await this.db
      .collection(COLLECTION)
      .doc(PLATFORM_SETTINGS_DOC_ID)
      .set({ ...settings });
  }
}
