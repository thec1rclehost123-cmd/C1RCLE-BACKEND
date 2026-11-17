import { randomInt } from 'node:crypto';

import type { UserDirectoryPort } from './user-directory.js';

/**
 * ─── Staff credential ports ─────────────────────────────────────────────────
 * Invited staff sign in with real login credentials (email + temporary
 * password), not a magic link: the invite email carries credentials for the
 * invited role, and the account must rotate them on first login.
 *
 * Three narrow ports (mirroring the `EmailSender` pattern — interfaces here
 * with in-memory defaults, real implementations where network access lives):
 *
 * - `StaffCredentialProvisioner`: creates the Better Auth account. Lives in
 *   the gateway (`BetterAuthStaffCredentialProvisioner`) since only it may
 *   call Better Auth; in-memory here for tests and the memory driver.
 * - `StaffUserDirectory`: finds a login's user id by email. Firestore-backed
 *   in `infrastructure/firestore` (the repo-wide lint ban keeps `.collection`
 *   access there), in-memory here.
 * - `StaffRotationStore`: first-login rotation flags by user id. Same split.
 *
 * Security rules enforced by every implementation:
 * - An address that already has an account is NEVER re-provisioned: the
 *   existing credentials are left untouched and no rotation is required.
 *   (`created: false`, no password returned.)
 * - The temporary password is returned once, at creation, so the caller can
 *   put it in the invite email. It is never stored in recoverable form and
 *   never returned again.
 */

export interface StaffCredentialProvision {
  /** Login user id behind the address (new or pre-existing). */
  userId: string | null;
  /** True when a brand-new account was created for this address. */
  created: boolean;
  /** The temporary password — set only when `created` is true. */
  temporaryPassword: string | null;
}

export interface StaffCredentialProvisioner {
  readonly name: string;
  /**
   * Ensures a login exists for the address. Creates an account with a fresh
   * temporary password when none exists; otherwise returns the existing user
   * without touching anything.
   */
  provisionLogin(email: string, displayName: string): Promise<StaffCredentialProvision>;
  /**
   * Issues a fresh temporary password for an account that has NEVER taken
   * ownership of its credentials (rotation still owed). The caller must have
   * checked that: this never runs for an account whose owner chose a password.
   */
  reissueTemporaryPassword(userId: string): Promise<string>;
}

export interface StaffUserDirectory {
  /** Better Auth user id for the address, or null when no login exists. */
  findUserIdByEmail(email: string): Promise<string | null>;
  /** Email address for a user id, or null when not found. */
  getEmailById(userId: string): Promise<string | null>;
}

export interface StaffRotationStore {
  /**
   * Marks the account as required to rotate its password on next login.
   * `expiresAt` is when the temporary credential stops working; clearing the
   * flag (`required: false`) also clears the expiry.
   */
  setRequired(userId: string, required: boolean, options?: { expiresAt?: Date }): Promise<void>;
  /** True when the account still owes its first-login rotation. */
  isRequired(userId: string): Promise<boolean>;
  /**
   * True when a temporary credential was issued with an expiry that has passed
   * and was never rotated. An account with no expiry recorded is never expired
   * (flags written before expiry existed keep working).
   */
  isExpired(userId: string, now: Date): Promise<boolean>;
}

/** How long a temporary password works: two days from issue. */
export const TEMPORARY_PASSWORD_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** Temporary passwords are 8 characters (also Better Auth's minimum). */
export const TEMPORARY_PASSWORD_LENGTH = 8;

/**
 * 8 chars from an unambiguous 56-symbol alphabet (~46 bits). Deliberately
 * short so it can be read off a phone at a venue door; that is safe only
 * because it is single-use, valid for {@link TEMPORARY_PASSWORD_TTL_MS},
 * behind the login rate limit, and must be rotated on first sign-in.
 */
const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateTemporaryPassword(): string {
  let password = '';
  for (let index = 0; index < TEMPORARY_PASSWORD_LENGTH; index += 1) {
    const charIndex = randomInt(TEMPORARY_PASSWORD_ALPHABET.length);
    password += TEMPORARY_PASSWORD_ALPHABET.charAt(charIndex);
  }
  return password;
}

/** `teammate.x@example.com` → `Teammate X`; falls back to `Team Member`. */
export function displayNameForInviteEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return parts.length > 0 ? parts.join(' ') : 'Team Member';
}

/**
 * Test/memory defaults: track provisioned addresses and rotation flags in
 * memory. Never used in production.
 */
export class MemoryStaffUserDirectory implements StaffUserDirectory, UserDirectoryPort {
  readonly name = 'memory-staff';
  private readonly ids = new Map<string, string>();

  seed(normalizedEmail: string, userId: string): void {
    this.ids.set(normalizedEmail, userId);
  }

  remove(normalizedEmail: string): void {
    this.ids.delete(normalizedEmail.trim().toLowerCase());
  }

  removeById(userId: string): void {
    for (const [email, id] of this.ids.entries()) {
      if (id === userId) this.ids.delete(email);
    }
  }

  async getEmailById(userId: string): Promise<string | null> {
    for (const [email, id] of this.ids.entries()) {
      if (id === userId) return email;
    }
    return null;
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    return this.ids.get(email.trim().toLowerCase()) ?? null;
  }
}

export class MemoryStaffCredentialProvisioner implements StaffCredentialProvisioner {
  readonly name = 'memory';
  readonly directory = new MemoryStaffUserDirectory();

  private readonly passwords = new Map<string, string>();
  private idSeq = 0;

  async provisionLogin(email: string): Promise<StaffCredentialProvision> {
    const normalized = email.trim().toLowerCase();
    const existingId = await this.directory.findUserIdByEmail(normalized);
    const temporaryPassword = generateTemporaryPassword();
    if (existingId) {
      return { userId: existingId, created: false, temporaryPassword: null };
    }
    this.idSeq += 1;
    const userId = `memory-user-${this.idSeq}`;
    this.directory.seed(normalized, userId);
    this.passwords.set(userId, temporaryPassword);
    return { userId, created: true, temporaryPassword };
  }

  async reissueTemporaryPassword(userId: string): Promise<string> {
    const temporaryPassword = generateTemporaryPassword();
    this.passwords.set(userId, temporaryPassword);
    return temporaryPassword;
  }

  getPassword(userId: string): string | null {
    return this.passwords.get(userId) ?? null;
  }
}

export class MemoryStaffRotationStore implements StaffRotationStore {
  private readonly required = new Set<string>();
  private readonly expiries = new Map<string, number>();

  async setRequired(
    userId: string,
    required: boolean,
    options?: { expiresAt?: Date },
  ): Promise<void> {
    if (required) {
      this.required.add(userId);
      if (options?.expiresAt) this.expiries.set(userId, options.expiresAt.getTime());
      else this.expiries.delete(userId);
    } else {
      this.required.delete(userId);
      this.expiries.delete(userId);
    }
  }

  async isExpired(userId: string, now: Date): Promise<boolean> {
    if (!this.required.has(userId)) return false;
    const expiresAt = this.expiries.get(userId);
    return expiresAt !== undefined && now.getTime() >= expiresAt;
  }

  async isRequired(userId: string): Promise<boolean> {
    return this.required.has(userId);
  }
}
