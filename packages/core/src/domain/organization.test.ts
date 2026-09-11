import { describe, expect, it } from 'vitest';

import { adjustPlatformFeePercent, createOrganization } from './models/organization.js';

import type { Organization } from './models/organization.js';

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    ...createOrganization({
      id: 'org_1',
      name: 'Skyline',
      slug: 'skyline',
      ownerId: 'user_1',
      now: new Date('2026-09-11T00:00:00.000Z'),
    }),
    ...overrides,
  };
}

describe('adjustPlatformFeePercent', () => {
  it('changes the commission and bumps the version', () => {
    const before = org({ platformFeePercent: 15 });
    const after = adjustPlatformFeePercent(before, 10, new Date());
    expect(after.platformFeePercent).toBe(10);
    expect(after.version).toBe(before.version + 1);
  });

  it('setting the same percent is a no-op', () => {
    const before = org({ platformFeePercent: 15 });
    const after = adjustPlatformFeePercent(before, 15, new Date());
    expect(after).toBe(before);
  });

  it('rejects a percent outside 0-100', () => {
    const before = org();
    expect(() => adjustPlatformFeePercent(before, -1, new Date())).toThrow(/0 and 100/);
    expect(() => adjustPlatformFeePercent(before, 101, new Date())).toThrow(/0 and 100/);
  });

  it('rejects a non-integer percent', () => {
    const before = org();
    expect(() => adjustPlatformFeePercent(before, 12.5, new Date())).toThrow(/whole number/);
  });

  it('accepts the boundaries 0 and 100', () => {
    const before = org({ platformFeePercent: 15 });
    expect(() => adjustPlatformFeePercent(before, 0, new Date())).not.toThrow();
    expect(() => adjustPlatformFeePercent(before, 100, new Date())).not.toThrow();
  });
});
