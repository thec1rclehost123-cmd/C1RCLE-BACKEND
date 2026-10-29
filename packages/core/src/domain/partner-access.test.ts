import { describe, expect, it } from 'vitest';

import {
  hasPartnerPermission,
  normalizePartnerRole,
  normalizePartnerType,
  partnerAccessContext,
  permissionsFor,
  tabVisibilityFor,
  tenancyRoleToPartnerRole,
} from './models/partner-access.js';

/**
 * ─── Partner access matrix ───────────────────────────────────────────────────
 * Ported from v1 `lib/rbac-permissions.ts`. These lock the v1 tables so a
 * later edit cannot quietly widen what a role can see — the whole point of the
 * matrix living server-side.
 */

describe('normalization', () => {
  it('accepts the shapes v1 accepted', () => {
    expect(normalizePartnerRole('door-staff')).toBe('DOOR');
    expect(normalizePartnerRole('Venue Owner')).toBe('OWNER');
    expect(normalizePartnerRole('finance')).toBe('FINANCE_ADMIN');
    expect(normalizePartnerRole('  manager  ')).toBe('MANAGER');
  });

  it('falls back to the least-privileged role, never to an empty set', () => {
    // An unrecognized role should produce a coherent minimal dashboard rather
    // than a blank one that looks broken.
    expect(normalizePartnerRole('wizard')).toBe('STAFF');
    expect(permissionsFor('venue', 'wizard')).toEqual([
      'VIEW_GUESTLIST',
      'MANAGE_TABLES',
      'LOG_INCIDENTS',
    ]);
  });

  it('keeps v1’s club→venue alias so migrated data still maps', () => {
    expect(normalizePartnerType('club')).toBe('venue');
    expect(permissionsFor('club', 'OWNER')).toEqual(permissionsFor('venue', 'OWNER'));
  });
});

describe('A6: tenancy role → partner matrix (no admin≡manager or member≡manager collapse)', () => {
  it('maps every tenancy role to a defined matrix role — none falls back to STAFF by accident', () => {
    expect(tenancyRoleToPartnerRole('owner')).toBe('OWNER');
    expect(tenancyRoleToPartnerRole('admin')).toBe('OWNER');
    expect(tenancyRoleToPartnerRole('manager')).toBe('MANAGER');
    expect(tenancyRoleToPartnerRole('member')).toBe('STAFF');
    expect(tenancyRoleToPartnerRole(undefined)).toBe('STAFF');
  });

  it('treats admin as owner-equivalent, not a manager — RBAC already gives admin the owner authority minus organization.create', () => {
    // The old mapping collapsed admin ≡ manager, under-reporting an org admin
    // who the API lets run staff, doors, payouts-reads and organization.update.
    const admin = partnerAccessContext('venue', tenancyRoleToPartnerRole('admin'));
    expect(admin.role).toBe('OWNER');
    expect(admin.tabVisibility).toBeNull(); // full dashboard, like owner
    expect(hasPartnerPermission('venue', admin.role, 'MANAGE_PAYOUTS')).toBe(true);
    expect(hasPartnerPermission('venue', admin.role, 'MANAGE_STAFF')).toBe(true);
  });

  it('covers owner/admin/manager/member distinctly through the matrix', () => {
    const admin = tenancyRoleToPartnerRole('admin');
    const manager = tenancyRoleToPartnerRole('manager');
    const member = tenancyRoleToPartnerRole('member');

    // Distinctness: admin ≠ manager, member ≠ manager, manager ≠ staff.
    expect(admin).not.toBe(manager);
    expect(member).not.toBe(manager);
    expect(manager).not.toBe(member);

    // Sanity: the whole-org gate passes through rather than collapsing.
    for (const tenancy of ['owner', 'admin', 'manager', 'member'] as const) {
      expect(partnerAccessContext('venue', tenancyRoleToPartnerRole(tenancy)).role).toBeTypeOf(
        'string',
      );
    }
  });
});

describe('venue permissions', () => {
  it('gives the owner financial and staff authority', () => {
    expect(hasPartnerPermission('venue', 'OWNER', 'VIEW_FINANCIALS')).toBe(true);
    expect(hasPartnerPermission('venue', 'OWNER', 'MANAGE_STAFF')).toBe(true);
    expect(hasPartnerPermission('venue', 'OWNER', 'EXPORT_GUESTS')).toBe(true);
  });

  it('withholds staff management and payouts from a manager', () => {
    expect(hasPartnerPermission('venue', 'MANAGER', 'MANAGE_STAFF')).toBe(false);
    expect(hasPartnerPermission('venue', 'MANAGER', 'MANAGE_PAYOUTS')).toBe(false);
    expect(hasPartnerPermission('venue', 'MANAGER', 'MANAGE_EVENTS')).toBe(true);
  });

  it('keeps finance data away from door and security roles', () => {
    for (const role of ['DOOR', 'SECURITY', 'STAFF']) {
      expect(hasPartnerPermission('venue', role, 'VIEW_FINANCIALS')).toBe(false);
      expect(hasPartnerPermission('venue', role, 'MANAGE_PAYOUTS')).toBe(false);
    }
  });

  it('lets only door staff charge cover wallets, among the floor roles', () => {
    expect(hasPartnerPermission('venue', 'DOOR', 'CHARGE_COVER_WALLETS')).toBe(true);
    expect(hasPartnerPermission('venue', 'SECURITY', 'CHARGE_COVER_WALLETS')).toBe(false);
    expect(hasPartnerPermission('venue', 'STAFF', 'CHARGE_COVER_WALLETS')).toBe(false);
  });

  it('gives finance-admin money access but no event control', () => {
    expect(permissionsFor('venue', 'FINANCE_ADMIN')).toEqual([
      'VIEW_FINANCIALS',
      'MANAGE_PAYOUTS',
      'VIEW_ANALYTICS',
    ]);
    expect(hasPartnerPermission('venue', 'FINANCE_ADMIN', 'MANAGE_EVENTS')).toBe(false);
  });
});

describe('host and promoter permissions', () => {
  it('gives a cohost event authority without finances', () => {
    expect(hasPartnerPermission('host', 'COHOST', 'MANAGE_EVENTS')).toBe(true);
    expect(hasPartnerPermission('host', 'COHOST', 'VIEW_FINANCIALS')).toBe(false);
  });

  it('gives host staff read-only visibility', () => {
    expect(permissionsFor('host', 'STAFF')).toEqual(['VIEW_GUESTLIST', 'VIEW_REAL_TIME_SCANS']);
  });

  it('lets a promoter see their own financials but not manage events', () => {
    expect(hasPartnerPermission('promoter', 'PROMOTER', 'VIEW_FINANCIALS')).toBe(true);
    expect(hasPartnerPermission('promoter', 'PROMOTER', 'MANAGE_EVENTS')).toBe(false);
  });

  it('does not give a team lead payout authority', () => {
    // A lead manages people, not money movement.
    expect(hasPartnerPermission('promoter', 'TEAM_LEAD', 'MANAGE_STAFF')).toBe(true);
    expect(hasPartnerPermission('promoter', 'TEAM_LEAD', 'MANAGE_PAYOUTS')).toBe(false);
  });
});

describe('tab visibility', () => {
  it('returns null for the top role of each type — no restriction', () => {
    expect(tabVisibilityFor('venue', 'OWNER')).toBeNull();
    expect(tabVisibilityFor('host', 'OWNER')).toBeNull();
    expect(tabVisibilityFor('promoter', 'TEAM_LEAD')).toBeNull();
  });

  it('keeps settings hidden from a venue manager but shows finance (API allows the reads)', () => {
    const tabs = tabVisibilityFor('venue', 'MANAGER');
    expect(tabs).toMatchObject({ finance: true, settings: false, events: true, door: true });
  });

  it('leaves floor roles with door-side tabs only', () => {
    const security = tabVisibilityFor('venue', 'SECURITY');
    expect(security).toMatchObject({
      door: true,
      guest_ops: true,
      walk_ins: true,
      finance: false,
      analytics: false,
      events: false,
    });
  });

  it('gives finance-admin the money tabs and nothing operational', () => {
    expect(tabVisibilityFor('venue', 'FINANCE_ADMIN')).toMatchObject({
      finance: true,
      analytics: true,
      overview: true,
      events: false,
      door: false,
    });
  });

  it('never shows finance to a host below owner', () => {
    for (const role of ['COHOST', 'MANAGER', 'STAFF']) {
      expect(tabVisibilityFor('host', role)?.finance).toBe(false);
    }
  });

  it('A5: a role granted VIEW_FINANCIALS never has the finance tab withheld', () => {
    // Invariant: permissions ⊆ visible tabs for finance. A role must not be
    // granted the money reads while the dashboard hides the finance tab.
    const roles = [
      'OWNER',
      'MANAGER',
      'FINANCE_ADMIN',
      'STAFF',
      'SECURITY',
      'DOOR',
      'COHOST',
      'PROMOTER',
      'TEAM_LEAD',
    ] as const;
    for (const type of ['venue', 'host', 'promoter'] as const) {
      for (const role of roles) {
        const visibility = tabVisibilityFor(type, role);
        if (visibility === null) continue; // top role: no restriction, tab is shown
        if (hasPartnerPermission(type, role, 'VIEW_FINANCIALS')) {
          expect(
            visibility.finance,
            `${type} ${role} is granted VIEW_FINANCIALS but the finance tab is withheld`,
          ).toBe(true);
        }
      }
    }
  });

  it('falls back to door-only for an unknown venue role', () => {
    expect(tabVisibilityFor('venue', 'wizard')).toMatchObject({
      door: true,
      finance: false,
      settings: false,
    });
  });
});

describe('partnerAccessContext', () => {
  it('bundles everything the dashboard needs in one computed answer', () => {
    const context = partnerAccessContext('club', 'venue owner');

    expect(context).toMatchObject({
      // `club` normalizes to venue, `venue owner` to OWNER.
      partnerType: 'venue',
      role: 'OWNER',
      tabVisibility: null,
    });
    expect(context.permissions).toContain('MANAGE_SETTINGS');
  });
});
