import { createV2Services } from '../lib/v2-services.js';

/** Synthetic verified identities for checkout-domain route fixtures, never a runtime bypass. */
export function seedVerifiedCheckoutUsers(
  ids: readonly string[] = ['user_1', 'user_2', 'user_other'],
) {
  const users = createV2Services().repos().users;
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
}
