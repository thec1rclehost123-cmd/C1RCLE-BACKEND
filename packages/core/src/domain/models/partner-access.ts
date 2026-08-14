/**
 * ─── Partner access matrix (Phase 1) ─────────────────────────────────────────
 *
 * Ported from v1 `apps/api-gateway/src/lib/rbac-permissions.ts`, whose opening
 * comment is the rule this file exists to keep:
 *
 *   "The frontend must NEVER define or evaluate these."
 *
 * The dashboard asks the backend what a member may see and do; it never
 * derives that locally. Hiding a tab is a convenience — the API authorizes
 * every request regardless (`plugins/rbac.ts`).
 *
 * Two vocabularies meet here and must not be confused:
 *  - `OrganizationRole` (owner/admin/manager/member) — V2's tenancy role, used
 *    for API authorization.
 *  - `PartnerRole` (OWNER/MANAGER/STAFF/…) — v1's per-capability operational
 *    role, which is what these tables are keyed on. A venue's DOOR staff and a
 *    host's COHOST are both "member" in V2 terms but see very different
 *    dashboards.
 */

/** Which business capability the member is acting under. */
export type PartnerType = 'venue' | 'host' | 'promoter';

/** v1 operational roles, kept verbatim — renaming them would break parity. */
export type PartnerRole =
  | 'OWNER'
  | 'MANAGER'
  | 'FINANCE_ADMIN'
  | 'STAFF'
  | 'SECURITY'
  | 'DOOR'
  | 'COHOST'
  | 'PROMOTER'
  | 'TEAM_LEAD';

export type PartnerPermission =
  | 'VIEW_FINANCIALS'
  | 'MANAGE_STAFF'
  | 'MANAGE_EVENTS'
  | 'EDIT_EVENT_RULES'
  | 'MANAGE_TABLES'
  | 'VIEW_GUESTLIST'
  | 'SCAN_ENTRY'
  | 'LOG_INCIDENTS'
  | 'VIEW_ANALYTICS'
  | 'MANAGE_SETTINGS'
  | 'MANAGE_PROMOTERS'
  | 'MANAGE_PAYOUTS'
  | 'MANAGE_PARTNERSHIPS'
  | 'MANAGE_PAGE_CONTENT'
  | 'VIEW_REAL_TIME_SCANS'
  | 'MANAGE_GUEST_OPS'
  | 'CHARGE_COVER_WALLETS'
  | 'EXPORT_GUESTS';

const VENUE_PERMISSIONS: Readonly<Partial<Record<PartnerRole, readonly PartnerPermission[]>>> = {
  OWNER: [
    'VIEW_FINANCIALS',
    'MANAGE_STAFF',
    'MANAGE_EVENTS',
    'EDIT_EVENT_RULES',
    'MANAGE_TABLES',
    'VIEW_GUESTLIST',
    'SCAN_ENTRY',
    'LOG_INCIDENTS',
    'VIEW_ANALYTICS',
    'MANAGE_SETTINGS',
    'MANAGE_PARTNERSHIPS',
    'MANAGE_PAGE_CONTENT',
    'MANAGE_PAYOUTS',
    'MANAGE_GUEST_OPS',
    'CHARGE_COVER_WALLETS',
    'EXPORT_GUESTS',
  ],
  MANAGER: [
    'VIEW_FINANCIALS',
    'MANAGE_EVENTS',
    'EDIT_EVENT_RULES',
    'MANAGE_TABLES',
    'VIEW_GUESTLIST',
    'SCAN_ENTRY',
    'LOG_INCIDENTS',
    'VIEW_ANALYTICS',
    'MANAGE_PAGE_CONTENT',
    'MANAGE_GUEST_OPS',
    'CHARGE_COVER_WALLETS',
  ],
  FINANCE_ADMIN: ['VIEW_FINANCIALS', 'MANAGE_PAYOUTS', 'VIEW_ANALYTICS'],
  STAFF: ['VIEW_GUESTLIST', 'MANAGE_TABLES', 'LOG_INCIDENTS'],
  SECURITY: ['VIEW_GUESTLIST', 'SCAN_ENTRY', 'LOG_INCIDENTS'],
  DOOR: ['VIEW_GUESTLIST', 'SCAN_ENTRY', 'LOG_INCIDENTS', 'CHARGE_COVER_WALLETS'],
};

const HOST_PERMISSIONS: Readonly<Partial<Record<PartnerRole, readonly PartnerPermission[]>>> = {
  OWNER: [
    'VIEW_FINANCIALS',
    'MANAGE_STAFF',
    'MANAGE_EVENTS',
    'MANAGE_PROMOTERS',
    'MANAGE_PAGE_CONTENT',
    'VIEW_ANALYTICS',
    'MANAGE_PAYOUTS',
    'MANAGE_PARTNERSHIPS',
    'VIEW_REAL_TIME_SCANS',
  ],
  COHOST: [
    'MANAGE_EVENTS',
    'MANAGE_PROMOTERS',
    'VIEW_ANALYTICS',
    'VIEW_REAL_TIME_SCANS',
    'VIEW_GUESTLIST',
  ],
  MANAGER: ['MANAGE_EVENTS', 'VIEW_ANALYTICS', 'VIEW_GUESTLIST', 'VIEW_REAL_TIME_SCANS'],
  STAFF: ['VIEW_GUESTLIST', 'VIEW_REAL_TIME_SCANS'],
};

const PROMOTER_PERMISSIONS: Readonly<Partial<Record<PartnerRole, readonly PartnerPermission[]>>> = {
  PROMOTER: [
    'VIEW_ANALYTICS',
    'MANAGE_PAGE_CONTENT',
    'VIEW_GUESTLIST',
    'VIEW_FINANCIALS',
    'MANAGE_PAYOUTS',
  ],
  TEAM_LEAD: ['VIEW_ANALYTICS', 'MANAGE_STAFF', 'VIEW_GUESTLIST', 'VIEW_FINANCIALS'],
};

/**
 * v1 accepted role strings in several shapes (`door-staff`, `Venue Owner`,
 * `FINANCE`). Normalizing keeps those callers working instead of silently
 * granting the empty permission set.
 */
const ROLE_ALIASES: Readonly<Record<string, PartnerRole>> = {
  DOOR_STAFF: 'DOOR',
  DOOR_OPERATOR: 'DOOR',
  VENUE_STAFF: 'STAFF',
  FINANCE: 'FINANCE_ADMIN',
  FINANCE_STAFF: 'FINANCE_ADMIN',
  HOST_OWNER: 'OWNER',
  VENUE_OWNER: 'OWNER',
  PROMOTER_OWNER: 'PROMOTER',
};

const PARTNER_ROLES: readonly PartnerRole[] = [
  'OWNER',
  'MANAGER',
  'FINANCE_ADMIN',
  'STAFF',
  'SECURITY',
  'DOOR',
  'COHOST',
  'PROMOTER',
  'TEAM_LEAD',
];

export function normalizePartnerRole(role: string): PartnerRole {
  const normalized = (role || 'STAFF')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
  const aliased = ROLE_ALIASES[normalized] ?? normalized;
  // An unrecognized role falls back to the least-privileged one rather than
  // to an empty set, so the caller gets a coherent (if minimal) dashboard.
  return PARTNER_ROLES.includes(aliased as PartnerRole) ? (aliased as PartnerRole) : 'STAFF';
}

/** v1 treated `club` as a venue; keep that alias so migrated data still maps. */
export function normalizePartnerType(partnerType: string): PartnerType {
  const type = (partnerType || 'venue').trim().toLowerCase();
  if (type === 'host') return 'host';
  if (type === 'promoter') return 'promoter';
  return 'venue';
}

export function permissionsFor(partnerType: string, role: string): readonly PartnerPermission[] {
  const type = normalizePartnerType(partnerType);
  const normalized = normalizePartnerRole(role);
  const table =
    type === 'host'
      ? HOST_PERMISSIONS
      : type === 'promoter'
        ? PROMOTER_PERMISSIONS
        : VENUE_PERMISSIONS;
  return table[normalized] ?? [];
}

export function hasPartnerPermission(
  partnerType: string,
  role: string,
  permission: PartnerPermission,
): boolean {
  return permissionsFor(partnerType, role).includes(permission);
}

/**
 * Which dashboard tabs a role sees.
 *
 * v1 returned `null` for the top role of each type, meaning "no restriction —
 * show everything". That is preserved rather than expanded into an all-true
 * map, because the tab list is the frontend's to own; the backend says only
 * what is *withheld*.
 */
export type TabVisibility = Readonly<Record<string, boolean>>;

export function tabVisibilityFor(partnerType: string, role: string): TabVisibility | null {
  const type = normalizePartnerType(partnerType);
  const normalized = normalizePartnerRole(role);

  if (type === 'host') {
    if (normalized === 'OWNER') return null;
    if (normalized === 'COHOST') {
      return {
        overview: true,
        events: true,
        calendar: true,
        network: true,
        audience: true,
        analytics: true,
        finance: false,
        settings: false,
        team: true,
      };
    }
    if (normalized === 'MANAGER') {
      return {
        overview: true,
        events: true,
        calendar: true,
        network: false,
        audience: true,
        analytics: true,
        finance: false,
        settings: false,
        team: true,
      };
    }
    return {
      overview: false,
      events: true,
      calendar: true,
      network: false,
      audience: true,
      analytics: false,
      finance: false,
      settings: false,
      team: true,
    };
  }

  if (type === 'promoter') {
    if (normalized === 'TEAM_LEAD') return null;
    return {
      overview: true,
      links: true,
      events: true,
      calendar: true,
      partners: true,
      analytics: true,
      finance: true,
      guests: true,
      settings: false,
    };
  }

  if (normalized === 'OWNER') return null;
  if (normalized === 'MANAGER') {
    return {
      overview: true,
      analytics: true,
      events: true,
      calendar: true,
      walk_ins: true,
      partnerships: true,
      staff: true,
      registers: true,
      guest_ops: true,
      page_management: true,
      door: true,
      partners: true,
      presence: true,
      crm: true,
      settings: false,
      finance: false,
    };
  }
  if (normalized === 'STAFF') {
    return {
      walk_ins: true,
      guest_ops: true,
      registers: true,
      door: true,
      overview: false,
      events: false,
      analytics: false,
      finance: false,
      calendar: false,
      staff: false,
      partners: false,
      presence: false,
      crm: false,
      settings: false,
    };
  }
  if (normalized === 'SECURITY') {
    return {
      guest_ops: true,
      walk_ins: true,
      door: true,
      overview: false,
      analytics: false,
      events: false,
      finance: false,
      calendar: false,
      staff: false,
      partners: false,
      presence: false,
      crm: false,
      settings: false,
    };
  }
  if (normalized === 'FINANCE_ADMIN') {
    return {
      finance: true,
      analytics: true,
      overview: true,
      events: false,
      calendar: false,
      walk_ins: false,
      staff: false,
      guest_ops: false,
      door: false,
      partners: false,
      presence: false,
      crm: false,
      settings: false,
    };
  }

  // Anything else at a venue: door duty only.
  return {
    overview: false,
    events: false,
    door: true,
    calendar: false,
    partners: false,
    analytics: false,
    finance: false,
    presence: false,
    crm: false,
    staff: false,
    settings: false,
  };
}

/** Everything the dashboard needs to render itself, computed server-side. */
export interface PartnerAccessContext {
  partnerType: PartnerType;
  role: PartnerRole;
  permissions: readonly PartnerPermission[];
  /** `null` = no restriction; the caller sees every tab. */
  tabVisibility: TabVisibility | null;
}

export function partnerAccessContext(partnerType: string, role: string): PartnerAccessContext {
  return {
    partnerType: normalizePartnerType(partnerType),
    role: normalizePartnerRole(role),
    permissions: permissionsFor(partnerType, role),
    tabVisibility: tabVisibilityFor(partnerType, role),
  };
}
