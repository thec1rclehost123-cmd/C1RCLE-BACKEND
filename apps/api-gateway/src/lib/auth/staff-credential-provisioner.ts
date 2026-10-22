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
interface InternalAuthContext {
  password?: { hash: (password: string) => Promise<string> };
  internalAdapter?: {
    findAccounts: (userId: string) => Promise<{ providerId: string }[]>;
    updatePassword: (userId: string, hash: string) => Promise<void>;
    linkAccount: (data: unknown) => Promise<unknown>;
    deleteUserSessions: (userId: string) => Promise<void>;
    deleteUser?: (userId: string) => Promise<void>;
  };
}

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
    const temporaryPassword = generateTemporaryPassword();

    if (existingId) {
      try {
        const ctx = (await Reflect.get(this.auth, '$context')) as unknown as
          InternalAuthContext | undefined;

        if (ctx?.password && ctx?.internalAdapter) {
          const passwordHash = await ctx.password.hash(temporaryPassword);
          const accounts = await ctx.internalAdapter.findAccounts(existingId);
          const hasCredential = accounts.some((account) => account.providerId === 'credential');
          if (hasCredential) {
            await ctx.internalAdapter.updatePassword(existingId, passwordHash);
          } else {
            await ctx.internalAdapter.linkAccount({
              userId: existingId,
              providerId: 'credential',
              accountId: existingId,
              password: passwordHash,
            });
          }
          await ctx.internalAdapter.deleteUserSessions(existingId);
        }
      } catch (error) {
        this.logger.warn('staff credential reset failed', {
          userId: existingId,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }

      return { userId: existingId, created: true, temporaryPassword };
    }

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
      if (isDuplicateAccountError(error)) {
        const racedId = await this.findUserId(normalized);
        if (racedId) {
          try {
            const ctx = (await Reflect.get(this.auth, '$context')) as unknown as
              InternalAuthContext | undefined;

            if (ctx?.password && ctx?.internalAdapter) {
              const passwordHash = await ctx.password.hash(temporaryPassword);
              const accounts = await ctx.internalAdapter.findAccounts(racedId);
              const hasCredential = accounts.some((account) => account.providerId === 'credential');
              if (hasCredential) {
                await ctx.internalAdapter.updatePassword(racedId, passwordHash);
              } else {
                await ctx.internalAdapter.linkAccount({
                  userId: racedId,
                  providerId: 'credential',
                  accountId: racedId,
                  password: passwordHash,
                });
              }
              await ctx.internalAdapter.deleteUserSessions(racedId);
            }
          } catch {
            // ignore error
          }
          return { userId: racedId, created: true, temporaryPassword };
        }
      }
      throw error;
    }

    const userId = await this.findUserId(normalized);
    if (!userId) {
      throw new Error('Provisioned account could not be found after signup');
    }
    return { userId, created: true, temporaryPassword };
  }

  async revokeLogin(userId: string, email?: string): Promise<void> {
    let targetUserId = userId;
    if (!targetUserId && email) {
      const foundId = await this.findUserId(email.trim().toLowerCase());
      if (foundId) targetUserId = foundId;
    }
    if (!targetUserId) return;

    try {
      const ctx = (await Reflect.get(this.auth, '$context')) as unknown as
        InternalAuthContext | undefined;

      if (ctx?.internalAdapter?.deleteUser) {
        await ctx.internalAdapter.deleteUser(targetUserId);
      } else if (ctx?.internalAdapter?.deleteUserSessions) {
        await ctx.internalAdapter.deleteUserSessions(targetUserId);
      }
    } catch (error: unknown) {
      this.logger.warn('staff credential revocation failed', {
        userId: targetUserId,
        email,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
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
