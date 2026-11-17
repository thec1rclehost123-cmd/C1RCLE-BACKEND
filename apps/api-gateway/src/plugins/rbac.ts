import { buildV2ErrorResponse } from '@c1rcle/contracts';
import fp from 'fastify-plugin';

import type { ActorContext } from '@c1rcle/core/application';
import type { OrganizationRole } from '@c1rcle/core/domain';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── RBAC + ABAC (B10 / T15) ─────────────────────────────────────────────────
 * Ported from Sagar's parallel B10 work (origin/main 80cca2c), adapted to read
 * `request.actor` as populated by `plugins/auth.ts`'s onRequest hook (that
 * hook is this repo's, unchanged from this session's own B10 — only this
 * plugin's decorator is new).
 *
 * RBAC: a role grants a fixed permission set.
 * ABAC: the actor's organization must equal the resource's organization —
 *       enforced against the `:organizationId` path param, not the header the
 *       client sent.
 *
 * Default deny. A permission that is not listed is not held, and a route with
 * no declared permission is a programming error rather than an open door.
 */

export type Permission =
  | 'organization.read'
  | 'organization.update'
  | 'partner.profile.update'
  | 'organization.create'
  | 'staff.manage'
  | 'venue.read'
  /**
   * What working the gate needs and nothing more: today's events, the guest
   * list, this event's door sales, and registering the handset. Deliberately
   * narrower than `venue.read`, which also opens the attendance report and
   * cover-wallet records (supervisor and above).
   */
  | 'door.floor'
  | 'venue.create'
  | 'venue.manage'
  /** Resolve a slot request (accept/reject) — the venue owns its calendar. */
  | 'venue.schedule'
  | 'event.read'
  | 'event.create'
  | 'event.update'
  | 'event.publish'
  | 'event.cancel'
  /** Ask a venue for a slot — the host side of the same conversation. */
  | 'slot-request.create'
  /** Read a caller's own (in/out-bound) slot requests. */
  | 'slot-request.list'

  /** Phase 5: door staff overriding a denied scan (manual admission). */
  | 'ticket.override'
  /**
   * Phase 5: minting, listing and revoking the door codes that authorize a
   * scanner device, and closing the sessions they opened. Separate from
   * `ticket.override` because it is a credential-management right, not a
   * door-staff one: whoever holds it can hand out entry to the event.
   */
  | 'door.manage'
  | 'finance.read'
  | 'finance.orders.read'
  | 'finance.refunds.request'
  | 'finance.refunds.approve'
  | 'finance.refunds.execute'
  | 'finance.payouts.read'
  | 'finance.payouts.manage'
  | 'finance.bank_accounts.manage'
  | 'finance.reconciliation.read'
  | 'finance.reconciliation.resolve'
  | 'finance.adjustments.create'
  | 'finance.audit.read';

const FINANCE_OWNER: readonly Permission[] = [
  'finance.read',
  'finance.orders.read',
  'finance.refunds.request',
  'finance.payouts.read',
  'finance.payouts.manage',
  'finance.bank_accounts.manage',
  'finance.reconciliation.read',
  'finance.audit.read',
];

const FINANCE_MANAGER: readonly Permission[] = [
  'finance.read',
  'finance.orders.read',
  'finance.refunds.request',
  'finance.payouts.read',
];

const READ_ONLY: readonly Permission[] = [
  'organization.read',
  'venue.read',
  'door.floor',
  'event.read',
  'slot-request.list',
];

/**
 * What a person standing at the door needs, and nothing else: today's events,
 * the guest list and door sales read routes. Admission, door sales and wallet
 * charges are authorized by the scanner session (door code), not by this role,
 * so one gate person can scan AND sell without holding any management right.
 * Deliberately no `organization.read`, no finance, no event authoring.
 */
const DOOR_FLOOR: readonly Permission[] = ['door.floor', 'event.read'];

/**
 * Role → permissions. Owner and admin (ops lead) run the tenant; manager
 * (venue manager) operates the venue and its door team; door_supervisor
 * oversees a night at the door; gate_staff works the gate; member can look
 * but not touch. `staff.manage` is held down to manager, but the service layer
 * only lets a holder assign or change roles strictly BELOW their own
 * (`assignableRoles` in the organization domain model).
 */
export const ROLE_PERMISSIONS: Readonly<Record<OrganizationRole, readonly Permission[]>> = {
  owner: [
    'organization.read',
    'door.floor',
    'organization.update',
    'partner.profile.update',
    'organization.create',
    'staff.manage',
    'venue.read',
    'venue.create',
    'venue.manage',
    'venue.schedule',
    'event.read',
    'event.create',
    'event.update',
    'event.publish',
    'event.cancel',
    'slot-request.create',
    'slot-request.list',
    'ticket.override',
    'door.manage',
    ...FINANCE_OWNER,
  ],
  admin: [
    'organization.read',
    'door.floor',
    'organization.update',
    'partner.profile.update',
    'staff.manage',
    'venue.read',
    'venue.create',
    'venue.manage',
    'venue.schedule',
    'event.read',
    'event.create',
    'event.update',
    'event.publish',
    'event.cancel',
    'slot-request.create',
    'slot-request.list',
    'ticket.override',
    'door.manage',
    ...FINANCE_OWNER,
  ],
  manager: [
    'organization.read',
    'door.floor',
    'partner.profile.update',
    'venue.read',
    'venue.manage',
    'venue.schedule',
    'event.read',
    'event.create',
    'event.update',
    'event.publish',
    'slot-request.create',
    'slot-request.list',
    'ticket.override',
    'door.manage',
    'staff.manage',
    ...FINANCE_MANAGER,
  ],
  // Watches the door: sees the floor, can override a denied scan, mints door
  // codes, binds and unbinds devices. Cannot manage people, events or money.
  door_supervisor: [...DOOR_FLOOR, 'venue.read', 'ticket.override', 'door.manage'],
  gate_staff: DOOR_FLOOR,
  member: READ_ONLY,
};

export function roleHasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface RbacPluginOptions {
  /**
   * Resolves the acting identity. MUST be the same resolver the routes use
   * (`services.actor`), or policy would be checked against a different actor
   * than the one the service later acts as — the two must never disagree.
   *
   * On `STORAGE_DRIVER=memory` the auth hook never populates `request.actor`
   * (there is no real session), so reading that field alone would 401 every
   * request on the test/dev driver while silently passing on firestore.
   */
  resolveActor?: (request: FastifyRequest) => ActorContext;
}

export default fp<RbacPluginOptions>(
  async (fastify: FastifyInstance, options: RbacPluginOptions) => {
    /**
     * Builds a preHandler enforcing one permission plus the tenant-scope rule.
     * Runs AFTER the auth hook, which is what populates `request.actor`.
     */
    fastify.decorate('requirePermission', (permission: Permission) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        let actor = request.actor as ActorContext | undefined;
        if (!actor && options.resolveActor) {
          try {
            actor = options.resolveActor(request);
          } catch {
            // Resolver throws Unauthorized/Forbidden on the firestore driver.
            return deny(reply, request, 401, 'unauthorized', 'Authentication required');
          }
        }
        if (!actor) {
          // Ordering bug, not a client error: fail closed and say so in the logs.
          fastify.log.error(
            { route: request.url },
            'requirePermission ran without an authenticated actor',
          );
          return deny(reply, request, 401, 'unauthorized', 'Authentication required');
        }

        if (!roleHasPermission(actor.role, permission)) {
          return deny(
            reply,
            request,
            403,
            'forbidden',
            `Role "${actor.role}" does not hold "${permission}"`,
          );
        }

        // ABAC: the path is the authority on which tenant is being addressed.
        const params = request.params as Record<string, string | undefined> | undefined;
        const pathOrganizationId = params?.organizationId;
        if (pathOrganizationId && pathOrganizationId !== actor.organizationId) {
          return deny(
            reply,
            request,
            403,
            'forbidden',
            'X-Organization-Id does not match the organization in the path',
          );
        }
      };
    });

    fastify.log.info('V2 RBAC/ABAC plugin initialized');
  },
  { name: 'rbac-v2' },
);

function deny(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: 'unauthorized' | 'forbidden',
  message: string,
): FastifyReply {
  void reply
    .status(status)
    .send(buildV2ErrorResponse({ status, code, message, requestId: request.id }));
  return reply;
}

declare module 'fastify' {
  interface FastifyInstance {
    requirePermission: (
      permission: Permission,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}
