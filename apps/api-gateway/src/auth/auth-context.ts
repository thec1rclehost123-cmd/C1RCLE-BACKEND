import { buildV2ErrorResponse } from '@c1rcle/contracts';
import fp from 'fastify-plugin';

import type { OrganizationRole, Capability, OrganizationRepository } from '@c1rcle/core/domain';

import {
  createAuth,
  createAuthDatabase,
  type AuthDatabase,
  type AuthInstance,
} from './auth-instance.js';

import type { GatewayConfig } from '../config/index.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Authentication + tenant resolution (B10) ────────────────────────────────
 *
 * Order matters, and it is the whole security model:
 *
 *   1. verify the credential            → who is calling (never client-claimed)
 *   2. resolve the requested tenant     → `X-Organization-Id`
 *   3. verify MEMBERSHIP of that tenant → the client's claim is only a request
 *   4. derive role + capabilities from the membership, not from the request
 *
 * Step 3 is the one that matters. Before this plugin the gateway trusted
 * `X-Organization-Id` outright, so any caller could act in any tenant.
 */

export interface AuthenticatedActor {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  capabilities: readonly Capability[];
  /** The platform role from the identity provider (guest | partner | admin). */
  platformRole: string;
}

export interface AuthPluginOptions {
  config: GatewayConfig;
  organizations: OrganizationRepository;
  /** Injectable so tests can seed users directly. */
  database?: AuthDatabase;
  auth?: AuthInstance;
}

export default fp<AuthPluginOptions>(
  async (fastify: FastifyInstance, options: AuthPluginOptions) => {
    const database = options.database ?? createAuthDatabase();
    const auth = options.auth ?? createAuth(options.config, database);

    fastify.decorate('auth', auth);
    fastify.decorate('authDatabase', database);
    fastify.decorate('gatewayConfig', options.config);

    /**
     * Requires a valid session. Populates `request.actor` when the caller also
     * proves membership of the organization they asked to act in.
     */
    fastify.decorate('authenticate', (opts: { requireOrganization?: boolean } = {}) => {
      const requireOrganization = opts.requireOrganization ?? true;

      return async (request: FastifyRequest, reply: FastifyReply) => {
        const session = await auth.api
          .getSession({ headers: toHeaders(request) })
          .catch(() => null);
        if (!session) {
          return deny(reply, request, 401, 'unauthorized', 'Authentication required');
        }

        const user = session.user as { id: string; role?: string | null };
        request.authUser = { id: user.id, platformRole: user.role ?? 'guest' };

        if (!requireOrganization) return;

        const requested = request.headers['x-organization-id'];
        const organizationId = typeof requested === 'string' ? requested : undefined;
        if (!organizationId) {
          return deny(
            reply,
            request,
            403,
            'forbidden',
            'X-Organization-Id is required for organization-scoped routes',
          );
        }

        // The header is a REQUEST to act in a tenant, never proof of it.
        const membership = await options.organizations.getMember(organizationId, user.id);
        if (!membership) {
          // Same answer whether the org does not exist or the caller is not a
          // member — never an existence oracle.
          return deny(reply, request, 403, 'forbidden', 'Not a member of this organization');
        }

        request.actor = {
          userId: user.id,
          organizationId,
          role: membership.role,
          capabilities: membership.capabilities,
          platformRole: user.role ?? 'guest',
        };
      };
    });

    fastify.log.info('V2 auth plugin initialized');
  },
  { name: 'auth-v2' },
);

function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

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

/** Reads the auth instance off the server, failing loudly if unregistered. */
export function getAuth(fastify: FastifyInstance): AuthInstance {
  const auth = (fastify as unknown as { auth?: AuthInstance }).auth;
  if (!auth) throw new Error('Auth plugin is not registered');
  return auth;
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthInstance;
    authDatabase: AuthDatabase;
    gatewayConfig: GatewayConfig;
    authenticate: (options?: {
      requireOrganization?: boolean;
    }) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }

  interface FastifyRequest {
    authUser?: { id: string; platformRole: string };
    actor?: AuthenticatedActor;
  }
}
