import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTicketAddon } from '../../domain/models/ticket-addon.js';

import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('ticket add-on catalog (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('persists an add-on and lists it only under its event', async () => {
    const suffix = randomUUID();
    const addon = createTicketAddon({
      id: `ADDON-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      name: 'Merchandise voucher',
      kind: 'merchandise',
      priceInPaise: 12500,
      quantity: 25,
    });
    const repository = new FirestoreEventCatalogRepository(db);
    try {
      await repository.saveTicketAddon(addon);
      expect(await repository.getTicketAddonById(addon.id)).toEqual(addon);
      expect(await repository.listTicketAddons(addon.eventId)).toEqual([addon]);
      expect(await repository.listTicketAddons(`EVT-other-${suffix}`)).toEqual([]);
    } finally {
      await db.collection('v2_event_ticket_addons').doc(addon.id).delete();
    }
  }, 45_000);
});
