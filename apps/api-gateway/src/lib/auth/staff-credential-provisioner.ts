import {
  generateTemporaryPassword,
  type StaffCredentialProvision,
  type StaffCredentialProvisioner,
  type StaffUserDirectory,
} from '@c1rcle/core/domain';

import type { Logger } from '@c1rcle/core';

import type { BetterAuthInstance } from '../../plugins/auth.js';

/**
 * ─── Better Auth staff credential provisioner ───────────────────────────────
 * Creates a real login (Better Auth email+password account) for invited
 * addresses that don't have one yet. Address lookup goes through the
 * injected `StaffUserDirectory` (core Firestore adapter — the repo-wide lint
 * ban keeps `.collection` access out of gateway code).
 *
 * Hard rules (see the port's doc comment):
 * - An address that already has an account is NEVER touched: no password
 *   reset, no rotation flag. The invite email then carries no credentials.
 * - The temporary password is returned once so the invite email can carry
 *   it. It is never persisted and never returned again.
 * - `signUpEmail` is called server-side without `asResponse`, so there are
 *   no session cookies to accidentally forward — the inviter's session is
 *   untouched.
 */
export class BetterAuthStaffCredentialProvisioner implements StaffCredentialProvisioner {
  readonly name = 'better-auth';

  constructor(
    private readonly auth: BetterAuthInstance,
    private readonly directory: StaffUserDirectory,
    private readonly logger: Logger,
  ) {}

  async provisionLogin(email: string, displayName: string): Promise<StaffCredentialProvision> {
    const normalized = email.trim().toLowerCase();
    const existingId = await this.findUserId(normalized);
    if (existingId) {
      return { userId: existingId, created: false, temporaryPassword: null };
    }

    const temporaryPassword = generateTemporaryPassword();
    try {
      await this.auth.api.signUpEmail({
        body: {
          email: normalized,
          password: temporaryPassword,
          name: displayName,
          role: 'partner',
        },
      });
    } catch (error) {
      // Lost a race with a concurrent signup/provision for the same address:
      // whoever won owns the credentials — never overwrite them.
      if (isDuplicateAccountError(error)) {
        const racedId = await this.findUserId(normalized);
        return { userId: racedId, created: false, temporaryPassword: null };
      }
      throw error;
    }

    const userId = await this.findUserId(normalized);
    if (!userId) {
      throw new Error('Provisioned account could not be found after signup');
    }
    return { userId, created: true, temporaryPassword };
  }

  private async findUserId(normalizedEmail: string): Promise<string | null> {
    return this.directory.findUserIdByEmail(normalizedEmail).catch((error: unknown) => {
      this.logger.warn('staff credential user lookup failed', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return null;
    });
  }
}

function isDuplicateAccountError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { status?: unknown; message?: unknown; body?: { code?: unknown } | null };
  if (record.status === 422) return true;
  const message = typeof record.message === 'string' ? record.message : '';
  const bodyCode = typeof record.body?.code === 'string' ? record.body.code : '';
  return (
    /USER_ALREADY_EXISTS/i.test(message) ||
    /already exists/i.test(message) ||
    /USER_ALREADY_EXISTS/i.test(bodyCode)
  );
}
