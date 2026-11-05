import { randomUUID } from 'node:crypto';

import { createOrganization } from '@c1rcle/core/domain';

import type { CreateOrganizationInput } from '@c1rcle/core/domain';

import { createV2Services } from '../lib/v2-services.js';

/**
 * Seed an already-approved workspace for operational route tests. This bypasses
 * HTTP setup only, never production authorization, and does not test KYC approval.
 * Keep the legacy fixtures' owner capabilities/settings so their business tests
 * retain the same preconditions. Approval itself is covered by onboarding tests.
 */
export async function seedApprovedPartnerOrganization(
  input: Pick<CreateOrganizationInput, 'name' | 'slug'> &
    Partial<Pick<CreateOrganizationInput, 'id' | 'ownerId' | 'capabilities' | 'settings'>>,
) {
  const organization = createOrganization({
    ...input,
    id: input.id ?? randomUUID(),
    ownerId: input.ownerId ?? 'user_1',
  });
  await createV2Services().repos().organizations.save(organization);
  return organization;
}
