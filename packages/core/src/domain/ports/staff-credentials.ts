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
}

export interface StaffUserDirectory {
  /** Better Auth user id for the address, or null when no login exists. */
  findUserIdByEmail(email: string): Promise<string | null>;
  /** Email address for a user id, or null when not found. */
  getEmailById(userId: string): Promise<string | null>;
}

export interface StaffRotationStore {
  /** Marks the account as required to rotate its password on next login. */
  setRequired(userId: string, required: boolean): Promise<void>;
  /** True when the account still owes its first-login rotation. */
  isRequired(userId: string): Promise<boolean>;
}

/** 16 chars from an unambiguous alphabet (~95 bits) — emailed once, rotated on first login. */
const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateTemporaryPassword(): string {
  let password = '';
  for (let index = 0; index < 16; index += 1) {
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
    if (existingId) {
      return { userId: existingId, created: false, temporaryPassword: null };
    }
    this.idSeq += 1;
    const userId = `memory-user-${this.idSeq}`;
    const temporaryPassword = generateTemporaryPassword();
    this.directory.seed(normalized, userId);
    this.passwords.set(userId, temporaryPassword);
    return { userId, created: true, temporaryPassword };
  }
}

export class MemoryStaffRotationStore implements StaffRotationStore {
  private readonly required = new Set<string>();

  async setRequired(userId: string, required: boolean): Promise<void> {
    if (required) this.required.add(userId);
    else this.required.delete(userId);
  }

  async isRequired(userId: string): Promise<boolean> {
    return this.required.has(userId);
  }
}
