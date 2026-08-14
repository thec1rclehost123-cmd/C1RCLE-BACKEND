import {
  adminAuditRecordDtoSchema,
  approveOnboardingResultSchema,
  idempotencyKeySchema,
  onboardingRequestDtoSchema,
  onboardingStatusSchema,
  opaqueIdSchema,
  paginationQuerySchema,
  paginatedSchema,
  platformAdminDtoSchema,
  proposalStatusSchema,
  proposedActionDtoSchema,
  proposeActionSchema,
  resolveProposalSchema,
  reviewOnboardingSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { AdminAuditRecord, PlatformAdmin, ProposedAction } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId, toDto } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Admin console routes (Phase 2) ──────────────────────────────────────────
 *
 * The operator side: the onboarding review queue, the TIER3 dual-control
 * proposal desk, and the admin roster.
 *
 * Authority here is **platform** authority, resolved from `v2_admins` by
 * `AdminAuthorityService` — never from an organization role. That is why these
 * routes carry no `requirePermission`: an org `owner` is not an admin, and
 * checking an org permission would be checking the wrong thing entirely. Every
 * handler below reaches a service call that begins with `requireAdmin`.
 */

const services = createV2Services();

const requestIdParam = z.object({ requestId: opaqueIdSchema });
const proposalIdParam = z.object({ proposalId: opaqueIdSchema });
const adminIdParam = z.object({ adminId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

const queueQuerySchema = paginationQuerySchema.extend({
  status: onboardingStatusSchema.optional(),
});
const proposalQuerySchema = paginationQuerySchema.extend({
  status: proposalStatusSchema.optional(),
});
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  targetId: opaqueIdSchema.optional(),
});

const requestListSchema = paginatedSchema(onboardingRequestDtoSchema);
const proposalListSchema = paginatedSchema(proposedActionDtoSchema);
const adminListSchema = paginatedSchema(platformAdminDtoSchema);
const auditListSchema = z.object({ items: z.array(adminAuditRecordDtoSchema) });

export default async function adminRoutes(fastify: FastifyInstance) {
  /* ─── Onboarding review queue ──────────────────────────────────────────── */

  fastify.get(
    '/admin/onboarding/applications',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: queueQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof queueQuerySchema>;

      const page = await services.onboarding
        .listQueue(userId, query.status ?? null, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(reply, request, requestListSchema, {
        items: page.items.map(toDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/onboarding/applications/:requestId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: requestIdParam })],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { requestId } = request.params as z.infer<typeof requestIdParam>;

      const found = await services.onboarding
        .getForReview(userId, requestId)
        .catch((error: unknown) => mapDomainError(reply, request, requestId, error));
      if (found === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        onboardingRequestDtoSchema,
        toDto(found),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  /**
   * Approval. The only route in the app that creates an organization on
   * someone else's behalf, so it is idempotency-keyed: a retried approval must
   * not provision a second organization for the same partner.
   */
  fastify.post(
    '/admin/onboarding/applications/:requestId/approve',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: requestIdParam,
          headers: commandHeaders,
          body: reviewOnboardingSchema.optional(),
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { requestId } = request.params as z.infer<typeof requestIdParam>;
      const body = (request.body ?? {}) as z.infer<typeof reviewOnboardingSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.onboarding.approve',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { requestId }, body },
        run: async () => {
          const outcome = await services.onboarding.approve(userId, {
            requestId,
            note: body.note,
          });
          const validated = validateV2Response(reply, request, approveOnboardingResultSchema, {
            request: toDto(outcome.request),
            organization: {
              id: outcome.organization.id,
              name: outcome.organization.name,
              slug: outcome.organization.slug,
              ownerId: outcome.organization.ownerId,
              platformFeePercent: outcome.organization.platformFeePercent,
              status: outcome.organization.status,
              version: outcome.organization.version,
              createdAt: outcome.organization.createdAt,
              updatedAt: outcome.organization.updatedAt,
            },
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, requestId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, requestId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  registerReview(fastify, 'reject', (userId, requestId, note) =>
    services.onboarding.reject(userId, { requestId, note }),
  );
  registerReview(fastify, 'request-changes', (userId, requestId, note) =>
    services.onboarding.requestChanges(userId, { requestId, note }),
  );

  /* ─── Dual-control proposal desk ───────────────────────────────────────── */

  fastify.get(
    '/admin/proposals',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: proposalQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof proposalQuerySchema>;

      const page = await services.adminAuthority
        .listProposals(userId, query.status ?? null, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(reply, request, proposalListSchema, {
        items: page.items.map(proposalToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/admin/proposals',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: proposeActionSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof proposeActionSchema>;

      return proposalCommand(request, reply, userId, 'admin.proposals.raise', { body }, 201, () =>
        services.adminAuthority.propose(userId, body),
      );
    },
  );

  registerProposalAction(fastify, 'approve', (userId, proposalId, reason) =>
    services.adminAuthority.approve(userId, proposalId, reason),
  );
  registerProposalAction(fastify, 'reject', (userId, proposalId, reason) =>
    services.adminAuthority.reject(userId, proposalId, reason),
  );
  registerProposalAction(fastify, 'cancel', (userId, proposalId) =>
    services.adminAuthority.cancel(userId, proposalId),
  );

  /* ─── Admin roster ─────────────────────────────────────────────────────── */

  fastify.get(
    '/admin/admins',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof paginationQuerySchema>;

      const page = await services.adminAuthority
        .listAdmins(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(reply, request, adminListSchema, {
        items: page.items.map(adminToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  /**
   * Provisioning takes only the proposal id: the new admin's details were
   * frozen when the proposal was raised and signed off by a second admin, so
   * accepting them again here would let the executing admin substitute
   * different ones.
   */
  fastify.post(
    '/admin/proposals/:proposalId/provision-admin',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: proposalIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { proposalId } = request.params as z.infer<typeof proposalIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.provision',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { proposalId }, body: undefined },
        run: async () => {
          const admin = await services.adminAuthority.provisionAdminFromProposal(
            userId,
            proposalId,
          );
          const validated = validateV2Response(
            reply,
            request,
            platformAdminDtoSchema,
            adminToDto(admin),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, proposalId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, proposalId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/admins/:adminId/revoke',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: adminIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { adminId } = request.params as z.infer<typeof adminIdParam>;

      const revoked = await services.adminAuthority
        .revokeAdmin(userId, adminId)
        .catch((error: unknown) => mapDomainError(reply, request, adminId, error));
      if (revoked === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        platformAdminDtoSchema,
        adminToDto(revoked),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  /* ─── Audit trail ──────────────────────────────────────────────────────── */

  fastify.get(
    '/admin/audit',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: auditQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof auditQuerySchema>;

      const records = await (
        query.targetId
          ? services.adminAuthority.listAuditForTarget(userId, query.targetId, query.limit)
          : services.adminAuthority.listAudit(userId, query.limit)
      ).catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (records === undefined) return reply;

      const validated = validateV2Response(reply, request, auditListSchema, {
        items: records.map(auditToDto),
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

function registerReview(
  fastify: FastifyInstance,
  action: 'reject' | 'request-changes',
  run: (userId: string, requestId: string, note?: string) => Promise<Parameters<typeof toDto>[0]>,
): void {
  fastify.post(
    `/admin/onboarding/applications/:requestId/${action}`,
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: requestIdParam,
          headers: commandHeaders,
          body: reviewOnboardingSchema.optional(),
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { requestId } = request.params as z.infer<typeof requestIdParam>;
      const body = (request.body ?? {}) as z.infer<typeof reviewOnboardingSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: `admin.onboarding.${action}`,
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { requestId }, body },
        run: async () => {
          const updated = await run(userId, requestId, body.note);
          const validated = validateV2Response(
            reply,
            request,
            onboardingRequestDtoSchema,
            toDto(updated),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, requestId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, requestId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

function registerProposalAction(
  fastify: FastifyInstance,
  action: 'approve' | 'reject' | 'cancel',
  run: (userId: string, proposalId: string, reason?: string) => Promise<ProposedAction>,
): void {
  fastify.post(
    `/admin/proposals/:proposalId/${action}`,
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: proposalIdParam,
          headers: commandHeaders,
          body: resolveProposalSchema.optional(),
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { proposalId } = request.params as z.infer<typeof proposalIdParam>;
      const body = (request.body ?? {}) as z.infer<typeof resolveProposalSchema>;

      return proposalCommand(
        request,
        reply,
        userId,
        `admin.proposals.${action}`,
        { path: { proposalId }, body },
        200,
        () => run(userId, proposalId, body.reason),
      );
    },
  );
}

async function proposalCommand(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  commandName: string,
  context: { path?: Record<string, unknown>; body?: unknown },
  statusCode: number,
  run: () => Promise<ProposedAction>,
): Promise<FastifyReply> {
  const v2Headers = request.v2Headers ?? {};
  const result = await runIdempotent({
    idempotency: services.idempotency,
    request,
    actorId: userId,
    commandName,
    idempotencyKey: v2Headers['idempotency-key'],
    context: { path: context.path ?? {}, body: context.body },
    run: async () => {
      const proposal = await run();
      const validated = validateV2Response(
        reply,
        request,
        proposedActionDtoSchema,
        proposalToDto(proposal),
      );
      if (validated === undefined) throw new Error('v2 response validation failed');
      return { statusCode, body: validated };
    },
  }).catch((error: unknown) =>
    isIdempotencyConflict(error)
      ? mapDomainError(reply, request, userId, error, { conflictId: v2Headers['idempotency-key'] })
      : mapDomainError(reply, request, userId, error),
  );
  if (result === undefined) return reply;
  return reply.status(result.statusCode).send(result.body);
}

function proposalToDto(proposal: ProposedAction) {
  return {
    id: proposal.id,
    action: proposal.action,
    proposedBy: proposal.proposedBy,
    reason: proposal.reason,
    payload: proposal.payload,
    status: proposal.status,
    resolvedBy: proposal.resolvedBy,
    resolvedAt: proposal.resolvedAt,
    resolutionReason: proposal.resolutionReason,
    version: proposal.version,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

function adminToDto(admin: PlatformAdmin) {
  return {
    id: admin.id,
    email: admin.email,
    role: admin.role,
    isActive: admin.isActive,
    version: admin.version,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
  };
}

function auditToDto(record: AdminAuditRecord) {
  return {
    id: record.id,
    adminId: record.adminId,
    adminRole: record.adminRole,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    before: record.before,
    after: record.after,
    reason: record.reason,
    occurredAt: record.occurredAt,
  };
}
