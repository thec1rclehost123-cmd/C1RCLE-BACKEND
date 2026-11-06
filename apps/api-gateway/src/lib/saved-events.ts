import { firestoreClient } from '@c1rcle/core/infrastructure';
import {
  SavedEventService,
  MemorySavedEventRepository,
  FirestoreSavedEventRepository,
} from '@c1rcle/core/saved-events';

import { getGatewayConfig } from '../config/index.js';

import { createV2Services } from './v2-services.js';

let service: SavedEventService | undefined;
export function getSavedEventService() {
  if (service) return service;
  const existing = createV2Services();
  const config = getGatewayConfig();
  service = new SavedEventService({
    repositories: existing.repos(),
    saved:
      config.STORAGE_DRIVER === 'memory'
        ? new MemorySavedEventRepository()
        : new FirestoreSavedEventRepository(firestoreClient(config)),
    readEvent: (id) => existing.public.getEvent(id),
    now: () => existing.config().clock.now(),
  });
  return service;
}
