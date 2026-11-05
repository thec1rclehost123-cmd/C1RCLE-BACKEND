import {
  GuestSocialService,
  MemoryGuestSocialRepository,
  FirestoreGuestSocialRepository,
} from '@c1rcle/core/guest-social';
import { firestoreClient } from '@c1rcle/core/infrastructure';

import { getGatewayConfig } from '../config/index.js';

import { createV2Services } from './v2-services.js';

let service: GuestSocialService | undefined;
export function getGuestSocialService(): GuestSocialService {
  if (service) return service;
  const existing = createV2Services();
  const config = getGatewayConfig();
  service = new GuestSocialService({
    repositories: existing.repos(),
    config: existing.config(),
    social:
      config.STORAGE_DRIVER === 'memory'
        ? new MemoryGuestSocialRepository()
        : new FirestoreGuestSocialRepository(firestoreClient(config)),
  });
  return service;
}
