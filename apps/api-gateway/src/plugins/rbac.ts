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
  | 'organization.create'
  | 'staff.manage'
  | 'venue.read'
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
  | 'slot-request.create';

const READ_ONLY: readonly Permission[] = ['organization.read', 'venue.read', 'event.read'];

/**
 * Role → permissions. Owner and admin run the tenant; manager operates it;
 * member can look but not touch.
 */
export const ROLE_PERMISSIONS: Readonly<Record<OrganizationRole, readonly Permission[]>> = {
  owner: [
    'organization.read',
    'organization.update',
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
  ],
  admin: [
    'organization.read',
    'organization.update',
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
  ],
  manager: [
    'organization.read',
    'venue.read',
    'venue.manage',
    'venue.schedule',
    'event.read',
    'event.create',
    'event.update',
    'event.publish',
    'slot-request.create',
  ],
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
