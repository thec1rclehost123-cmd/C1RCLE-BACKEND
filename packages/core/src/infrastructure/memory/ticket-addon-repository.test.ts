import { describe, expect, it } from 'vitest';

import { createTicketAddon } from '../../domain/models/ticket-addon.js';

import { MemoryEventCatalogRepository } from './memory-repositories.js';

describe('memory ticket add-on catalog repository', () => {
  it('reads an add-on by ID and lists only products for the requested event', async () => {
    const repository = new MemoryEventCatalogRepository();
    const parking = createTicketAddon({
      id: 'ADDON-parking',
      eventId: 'EVT-1',
      organizationId: 'ORG-1',
      name: 'Parking pass',
      kind: 'parking',
      priceInPaise: 50000,
      quantity: 120,
    });
    const cloakroom = createTicketAddon({
      id: 'ADDON-cloakroom',
      eventId: 'EVT-2',
      organizationId: 'ORG-2',
      name: 'Cloakroom',
      kind: 'cloakroom',
      priceInPaise: 10000,
      quantity: 80,
    });
    await repository.saveTicketAddon(parking);
    await repository.saveTicketAddon(cloakroom);

    expect(await repository.getTicketAddonById(parking.id)).toEqual(parking);
    expect(await repository.listTicketAddons('EVT-1')).toEqual([parking]);
  });
});
