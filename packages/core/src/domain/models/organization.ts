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
  now?: Date;
}

export function createOrganization(input: CreateOrganizationInput): Organization {
  const now = input.now ?? new Date();
  const member: OrganizationMember = {
    userId: input.ownerId,
    role: 'owner',
    capabilities: ['host', 'venue', 'promoter'],
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
