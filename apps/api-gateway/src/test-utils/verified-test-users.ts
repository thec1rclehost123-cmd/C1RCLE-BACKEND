import { createGuestProfile } from '@c1rcle/core/domain';

import { createV2Services } from '../lib/v2-services.js';

/** Synthetic verified identities for checkout-domain route fixtures, never a runtime bypass. */
export function seedVerifiedCheckoutUsers(
  ids: readonly string[] = ['user_1', 'user_2', 'user_other'],
) {
  const services = createV2Services();
  const users = services.repos().users;
  const profiles = services.repos().guestProfiles;
  if (!('save' in users) || typeof users.save !== 'function')
    throw new Error('Verified test identities require the memory driver');
  for (const id of ids)
    users.save({
      id,
      email: `${id}@example.test`,
      name: id,
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: 0,
      updatedAt: 0,
    });
  for (const id of ids)
    void profiles.save({
      ...createGuestProfile(id, {
        displayName: id,
        dateOfBirth: '2000-01-01',
        city: '',
        tastes: [],
        intents: [],
      }),
      phoneNumber: `+9198765432${String(ids.indexOf(id)).padStart(2, '0')}`,
      phoneVerifiedAt: new Date(0).toISOString(),
    });
}
