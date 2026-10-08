import { describe, expect, it } from 'vitest';

import { UnauthorizedError } from '../domain/errors.js';

import { buildActorContext } from './utils.js';

describe('buildActorContext', () => {
  it('returns the actor when the request carries one', () => {
    const actor = { userId: 'u1', organizationId: 'o1', role: 'owner', capabilities: [] } as never;
    expect(buildActorContext({ actor })).toBe(actor);
  });

  it('throws the canonical 401 error, with the same message every other unauthenticated path uses', () => {
    // Routes that resolve the actor themselves and the RBAC plugin both answer
    // "Authentication required"; a bespoke message here made the same missing
    // session read differently depending on which route it hit.
    expect(() => buildActorContext({})).toThrow(UnauthorizedError);
    expect(() => buildActorContext({})).toThrow('Authentication required');
  });
});
