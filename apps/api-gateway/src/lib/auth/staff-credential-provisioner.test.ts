import { describe, expect, it, vi } from 'vitest';

import type { StaffUserDirectory } from '@c1rcle/core/domain';

import { BetterAuthStaffCredentialProvisioner } from './staff-credential-provisioner.js';

import type { BetterAuthInstance } from '../../plugins/auth.js';

function fixture(ids: (string | null)[], signupError?: Error) {
  const findUserIdByEmail = vi.fn();
  for (const id of ids) findUserIdByEmail.mockResolvedValueOnce(id);
  const change = vi.fn();
  const signUpEmail = vi.fn(async () => {
    if (signupError) throw signupError;
    return {};
  });
  const auth = {
    api: { signUpEmail },
    $context: Promise.resolve({
      password: { hash: async () => 'synthetic-hash' },
      internalAdapter: {
        findAccounts: async () => [{ providerId: 'credential' }],
        updatePassword: change,
        linkAccount: change,
        deleteUserSessions: change,
        deleteUser: change,
      },
    }),
  } as unknown as BetterAuthInstance;
  const service = new BetterAuthStaffCredentialProvisioner(
    auth,
    { findUserIdByEmail } as unknown as StaffUserDirectory,
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  return { service, change, signUpEmail };
}

describe('staff credentials preserve existing accounts', () => {
  it('never resets or returns credentials for an existing identity', async () => {
    const f = fixture(['existing']);
    expect(await f.service.provisionLogin(' Existing@example.invalid ', 'Existing')).toEqual({
      userId: 'existing',
      created: false,
      temporaryPassword: null,
    });
    expect(f.change).not.toHaveBeenCalled();
    expect(f.signUpEmail).not.toHaveBeenCalled();
  });
  it('does not overwrite the winning account after concurrent signup', async () => {
    const f = fixture([null, 'winner'], new Error('User already exists'));
    expect(await f.service.provisionLogin('racing@example.invalid', 'Racing')).toEqual({
      userId: 'winner',
      created: false,
      temporaryPassword: null,
    });
    expect(f.change).not.toHaveBeenCalled();
  });
  it('still creates temporary credentials for a genuinely new identity', async () => {
    const f = fixture([null, 'new']);
    expect(await f.service.provisionLogin('new@example.invalid', 'New')).toMatchObject({
      userId: 'new',
      created: true,
      temporaryPassword: expect.any(String),
    });
    expect(f.signUpEmail).toHaveBeenCalledOnce();
    expect(f.change).not.toHaveBeenCalled();
  });
});
