import { InvalidOperationError } from '../errors.js';
import { newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Organization aggregate ───────────────────────────────────────────────────
 * An organization is the tenant for partners. Members carry roles with
 * capabilities computed from explicit grants — never derived from a string
 * soup. No `process.env`, no Firestore, no HTTP in this file.
 */

/** Business capability a member may hold within an org. */
export type Capability = 'host' | 'venue' | 'promoter';

/** Master role within an org. RBAC permission sets map from these. */
export type OrganizationRole = 'owner' | 'admin' | 'manager' | 'member';

export const ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  'owner',
  'admin',
  'manager',
  'member',
];

export interface OrganizationMember {
  userId: EntityId;
  role: OrganizationRole;
  capabilities: Capability[];
  joinedAt: string;
  invitedBy?: EntityId;
}

/**
 * ─── Invitation ───────────────────────────────────────────────────────────────
 * A *pending* offer of membership — the thing that exists between "someone was
 * invited" and "someone joined". Phase 0 shipped `inviteMember`, which adds a
 * member immediately, so there was nothing to list as pending and the
 * `GET /invitations` route could not be built without faking it.
 *
 * Invitations are addressed by **email**, not by user id: the whole point is to
 * invite someone who may not have an account yet.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

const INVITATION_TRANSITIONS: Readonly<Record<InvitationStatus, readonly InvitationStatus[]>> = {
  pending: ['accepted', 'revoked', 'expired'],
  // Terminal: an accepted invitation has become a membership; re-accepting it
  // must not grant a second one.
  accepted: [],
  revoked: [],
  expired: [],
};

export interface OrganizationInvitation extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  /** Lower-cased on creation so `A@x.com` and `a@x.com` cannot both be pending. */
  email: string;
  role: OrganizationRole;
  capabilities: Capability[];
  status: InvitationStatus;
  invitedBy: EntityId;
  /** ISO-8601. Past this, the invitation is expired even if still `pending`. */
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: EntityId | null;
}

export interface Organization extends VersionedEntity {
  id: EntityId;
  name: string;
  slug: string;
  /** Owner of the organization — the top-lead account. */
  ownerId: EntityId;
  /** Memberships keyed by userId (bounded within MemoryRepository at T08). */
  members: OrganizationMember[];
  /** Internal / non-public settings. */
  settings: OrganizationSettings;
  status: OrganizationStatus;
  /**
   * Commission the platform takes, whole-number percent. Set once at
   * onboarding approval from the applicant's plan (Phase 2) and deliberately
   * absent from `OrganizationProps` — a partner editing their own
   * organization must not be able to edit their own fee. Changing it is a
   * TIER3 `COMMISSION_ADJUST`.
   */
  platformFeePercent: number;
}

export type OrganizationStatus = 'active' | 'suspended' | 'archived';

export interface OrganizationSettings {
  /** Owned/branding info shared with partner surfaces. */
  name?: string;
  /** IANA timezone; V1 proven default 'Asia/Kolkata'. */
  timezone?: string;
  /** ISO 4217 default currency for pricing; V1 proven default 'INR'. */
  defaultCurrency?: string;
}

export interface CreateOrganizationInput {
  id: EntityId;
  name: string;
  slug: string;
  ownerId: EntityId;
  settings?: OrganizationSettings;
  /** Owner's capabilities. Defaults to all three for a self-serve org. */
  capabilities?: Capability[];
  /** Defaults to the `basic` plan's 15% until an approval says otherwise. */
  platformFeePercent?: number;
  now?: Date;
}

export function createOrganization(input: CreateOrganizationInput): Organization {
  const now = input.now ?? new Date();
  const member: OrganizationMember = {
    userId: input.ownerId,
    role: 'owner',
    capabilities: input.capabilities ?? ['host', 'venue', 'promoter'],
    joinedAt: now.toISOString(),
  };
  return {
    id: input.id,
    name: input.name,
    slug: input.slug,
    ownerId: input.ownerId,
    members: [member],
    settings: input.settings ?? {},
    status: 'active',
    platformFeePercent: input.platformFeePercent ?? 15,
    ...newVersionedEntity(now),
  };
}

export interface OrganizationProps {
  name?: string;
  slug?: string;
  settings?: OrganizationSettings;
}

/** Applies a controlled update to an org (version bump on any change). */
export function updateOrganization(
  org: Organization,
  props: OrganizationProps,
  now?: Date,
): Organization {
  const next: Organization = { ...org };
  let changed = false;
  if (props.name !== undefined && props.name !== org.name) {
    next.name = props.name;
    changed = true;
  }
  if (props.slug !== undefined && props.slug !== org.slug) {
    next.slug = props.slug;
    changed = true;
  }
  if (props.settings !== undefined) {
    next.settings = { ...org.settings, ...props.settings };
    changed = true;
  }
  if (!changed) return org;
  const ts = (now ?? new Date()).toISOString();
  return { ...next, version: org.version + 1, updatedAt: ts };
}

export interface InviteMemberInput {
  userId: EntityId;
  role: OrganizationRole;
  capabilities?: Capability[];
  invitedBy: EntityId;
  now?: Date;
}

/** Adds a member; rejects duplicate user ids and unknown roles. */
export function addMember(org: Organization, input: InviteMemberInput): Organization {
  if (!ORGANIZATION_ROLES.includes(input.role)) {
    throw new InvalidOperationError(`Unknown organization role: ${input.role}`);
  }
  if (org.members.some((m) => m.userId === input.userId)) {
    throw new InvalidOperationError(`User is already a member of this organization`);
  }
  if (org.status !== 'active') {
    throw new InvalidOperationError('Cannot add members to a non-active organization');
  }
  const member: OrganizationMember = {
    userId: input.userId,
    role: input.role,
    capabilities: input.capabilities ?? [],
    joinedAt: (input.now ?? new Date()).toISOString(),
    invitedBy: input.invitedBy,
  };
  const ts = (input.now ?? new Date()).toISOString();
  return { ...org, members: [...org.members, member], version: org.version + 1, updatedAt: ts };
}

/** Updates a member's role (owner cannot be demoted — guards tenant integrity). */
export function updateMemberRole(
  org: Organization,
  userId: EntityId,
  role: OrganizationRole,
  now?: Date,
): Organization {
  if (!ORGANIZATION_ROLES.includes(role)) {
    throw new InvalidOperationError(`Unknown organization role: ${role}`);
  }
  const member = org.members.find((m) => m.userId === userId);
  if (!member) throw new InvalidOperationError(`User is not a member of this organization`);
  if (member.role === 'owner' && role !== 'owner') {
    throw new InvalidOperationError('The owner role cannot be changed');
  }
  const ts = (now ?? new Date()).toISOString();
  return {
    ...org,
    members: org.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
    version: org.version + 1,
    updatedAt: ts,
  };
}

export function removeMember(org: Organization, userId: EntityId, now?: Date): Organization {
  const member = org.members.find((m) => m.userId === userId);
  if (!member) throw new InvalidOperationError(`User is not a member of this organization`);
  if (member.role === 'owner') {
    throw new InvalidOperationError('The owner cannot be removed from the organization');
  }
  const ts = (now ?? new Date()).toISOString();
  return {
    ...org,
    members: org.members.filter((m) => m.userId !== userId),
    version: org.version + 1,
    updatedAt: ts,
  };
}

/** Suspends a whole org; all memberships remain but the tenant is closed. */
export function suspendOrganization(org: Organization, now?: Date): Organization {
  if (org.status === 'suspended') return org;
  const ts = (now ?? new Date()).toISOString();
  return { ...org, status: 'suspended', version: org.version + 1, updatedAt: ts };
}

/* ─── Invitation behaviour ─────────────────────────────────────────────────── */

/** Default validity window. Long enough to be useful, short enough to expire. */
export const INVITATION_TTL_DAYS = 14;

export interface CreateInvitationInput {
  id: EntityId;
  organizationId: EntityId;
  email: string;
  role: OrganizationRole;
  capabilities?: Capability[];
  invitedBy: EntityId;
  ttlDays?: number;
  now?: Date;
}

export function createInvitation(input: CreateInvitationInput): OrganizationInvitation {
  if (!ORGANIZATION_ROLES.includes(input.role)) {
    throw new InvalidOperationError(`Unknown organization role: ${input.role}`);
  }
  // Inviting someone as owner would create a second owner on acceptance; the
  // owner is set at creation and transferred deliberately, never by invitation.
  if (input.role === 'owner') {
    throw new InvalidOperationError('An organization owner cannot be invited');
  }
  const email = normalizeEmail(input.email);
  if (!email.includes('@')) {
    throw new InvalidOperationError('An invitation needs a valid email address');
  }

  const now = input.now ?? new Date();
  const expires = new Date(now.getTime() + (input.ttlDays ?? INVITATION_TTL_DAYS) * 86_400_000);
  return {
    id: input.id,
    organizationId: input.organizationId,
    email,
    role: input.role,
    capabilities: input.capabilities ?? [],
    status: 'pending',
    invitedBy: input.invitedBy,
    expiresAt: expires.toISOString(),
    acceptedAt: null,
    acceptedBy: null,
    ...newVersionedEntity(now),
  };
}

/** Emails are identity here, so casing and padding must not create duplicates. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True once the validity window has passed. Checked on read rather than by a
 * sweeper job, so an expired invitation is never usable even if no cleanup ran.
 */
export function isInvitationExpired(
  invitation: OrganizationInvitation,
  now: Date = new Date(),
): boolean {
  return Date.parse(invitation.expiresAt) <= now.getTime();
}

/** The status a caller should see, accounting for lapsed time. */
export function effectiveInvitationStatus(
  invitation: OrganizationInvitation,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.status === 'pending' && isInvitationExpired(invitation, now)) return 'expired';
  return invitation.status;
}

function transitionInvitation(
  invitation: OrganizationInvitation,
  to: InvitationStatus,
  now: Date,
): OrganizationInvitation {
  const from = effectiveInvitationStatus(invitation, now);
  if (from === to) return invitation;
  if (!INVITATION_TRANSITIONS[from].includes(to)) {
    throw new InvalidOperationError(`Cannot move an invitation from ${from} to ${to}`);
  }
  return {
    ...invitation,
    status: to,
    version: invitation.version + 1,
    updatedAt: now.toISOString(),
  };
}

/** Withdraw an outstanding invitation. Idempotent for an already-revoked one. */
export function revokeInvitation(
  invitation: OrganizationInvitation,
  now?: Date,
): OrganizationInvitation {
  return transitionInvitation(invitation, 'revoked', now ?? new Date());
}

/**
 * Accepts an invitation for a user, returning the updated invitation and the
 * organization that now includes them. Both change together — an accepted
 * invitation without the membership would be a lie.
 */
export function acceptInvitation(
  org: Organization,
  invitation: OrganizationInvitation,
  userId: EntityId,
  now?: Date,
): { organization: Organization; invitation: OrganizationInvitation } {
  const at = now ?? new Date();
  if (invitation.organizationId !== org.id) {
    throw new InvalidOperationError('Invitation does not belong to this organization');
  }
  if (isInvitationExpired(invitation, at)) {
    throw new InvalidOperationError('This invitation has expired');
  }
  // Explicit, because `transitionInvitation` treats same-state as a no-op:
  // without this, re-accepting an already-accepted invitation would return
  // quietly and `addMember` would grant a SECOND membership — possibly to a
  // different user than the one who originally accepted.
  const current = effectiveInvitationStatus(invitation, at);
  if (current !== 'pending') {
    throw new InvalidOperationError(`This invitation is ${current} and cannot be accepted`);
  }

  const accepted = transitionInvitation(invitation, 'accepted', at);
  const organization = addMember(org, {
    userId,
    role: invitation.role,
    capabilities: invitation.capabilities,
    invitedBy: invitation.invitedBy,
    now: at,
  });
  return {
    organization,
    invitation: { ...accepted, acceptedAt: at.toISOString(), acceptedBy: userId },
  };
}
