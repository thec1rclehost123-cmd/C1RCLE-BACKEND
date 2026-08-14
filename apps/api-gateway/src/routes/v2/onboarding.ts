import {
  addOnboardingDocumentSchema,
  idempotencyKeySchema,
  onboardingRequestDtoSchema,
  opaqueIdSchema,
  paginationQuerySchema,
  paginatedSchema,
  saveOnboardingProgressSchema,
  startOnboardingSchema,
  verificationResultDtoSchema,
  verifyDocumentSchema,
} from '@c1rcle/contracts/client';
import { missingDocuments } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { OnboardingRequest } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../lib/v2-idempotency.js';
import { validateV2Response } from '../../lib/v2-response-validation.js';
import { createV2Services } from '../../lib/v2-services.js';

import { mapDomainError } from './partner/events.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Applicant onboarding routes (Phase 2) ───────────────────────────────────
 *
 * The one part of the API that is **not** organization-scoped: an applicant
 * has no organization yet — creating one is what approval does. So no
 * `X-Organization-Id`, no `requirePermission` (which checks an org role the
 * caller does not have), and ownership checked against the session user id
 * inside the service.
 *
 * These replace the 14 mocked `apps/partner-dashboard/src/app/api/kyc/*` routes
 * listed in `docs/reference/frontend-api-map.md` §1.1.
 */

const services = createV2Services();

const requestIdParam = z.object({ requestId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const requestListSchema = paginatedSchema(onboardingRequestDtoSchema);

export default async function onboardingRoutes(fastify: FastifyInstance) {
  /** The applicant's live application, or `null` before they have started. */
  fastify.get(
    '/onboarding/me',
    { preHandler: [fastify.rateLimit('AUTH_READ')] },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const found = await services.onboarding
        .getMine(userId)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (found === undefined) return reply;
      if (found === null) return reply.status(200).send({ request: null });

      const validated = validateV2Response(
        reply,
        request,
        onboardingRequestDtoSchema,
        toDto(found),
      );
      if (validated === undefined) return reply;
      return reply.send({ request: validated });
    },
  );

  fastify.get(
    '/onboarding/applications',
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

      const page = await services.onboarding
        .listMine(userId, { limit: query.limit, cursor: query.cursor ?? null })
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

  fastify.post(
    '/onboarding/applications',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: startOnboardingSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof startOnboardingSchema>;

      return command(fastify, request, reply, userId, 'onboarding.start', { body }, 201, () =>
        services.onboarding.start(userId, {
          requestedType: body.requestedType,
          plan: body.plan,
          profile: body.profile,
        }),
      );
    },
  );

  /**
   * Autosave. Not idempotency-keyed: an autosave is a last-write-wins draft
   * edit, and demanding a key per keystroke would be noise for no safety.
   */
  fastify.patch(
    '/onboarding/applications/:requestId',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: requestIdParam, body: saveOnboardingProgressSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { requestId } = request.params as z.infer<typeof requestIdParam>;
      const body = request.body as Record<string, unknown>;

      const updated = await services.onboarding
        .saveProgress(userId, requestId, body)
        .catch((error: unknown) => mapDomainError(reply, request, requestId, error));
      if (updated === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        onboardingRequestDtoSchema,
        toDto(updated),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/onboarding/applications/:requestId/documents',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: requestIdParam,
          headers: commandHeaders,
          body: addOnboardingDocumentSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { requestId } = request.params as z.infer<typeof requestIdParam>;
      const body = request.body as z.infer<typeof addOnboardingDocumentSchema>;

      return command(
        fastify,
        request,
        reply,
        userId,
        'onboarding.add_document',
        { path: { requestId }, body },
        200,
        () => services.onboarding.addDocument(userId, { requestId, ...body }),
      );
    },
  );

  fastify.post(
    '/onboarding/applications/:requestId/submit',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: requestIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { requestId } = request.params as z.infer<typeof requestIdParam>;

      return command(
        fastify,
        request,
        reply,
        userId,
        'onboarding.submit',
        { path: { requestId } },
        200,
        () => services.onboarding.submit(userId, requestId),
      );
    },
  );

  /**
   * Document verification. `SENSITIVE_COMMAND` on top of the service's own
   * per-applicant attempt budget: the rate limiter bounds one caller's request
   * rate, the attempt budget bounds one *applicant's* total tries, and only
   * the second survives a caller rotating IPs.
   */
  fastify.post(
    '/onboarding/verify-document',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: verifyDocumentSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof verifyDocumentSchema>;

      const result = await services.onboarding
        .verifyDocument(userId, body)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (result === undefined) return reply;

      const validated = validateV2Response(reply, request, verificationResultDtoSchema, {
        passed: result.passed,
        provider: result.provider,
        reason: result.reason ?? null,
        referenceId: result.referenceId ?? null,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

/**
 * The session user id, or a 401 already written to the reply.
 *
 * `services.actor` throws `UnauthorizedError` on the real driver when there is
 * no session; on the memory driver it fabricates a dev user, which is the same
 * documented exception every other v2 route lives with.
 */
export function requireUserId(request: FastifyRequest, reply: FastifyReply): string | undefined {
  try {
    return services.actor(request).userId;
  } catch (error: unknown) {
    return mapDomainError(reply, request, 'session', error);
  }
}

/** Idempotent command wrapper — the shape every mutating v2 route uses. */
async function command(
  _fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  commandName: string,
  context: { path?: Record<string, unknown>; body?: unknown },
  statusCode: number,
  run: () => Promise<OnboardingRequest>,
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
      const updated = await run();
      const validated = validateV2Response(
        reply,
        request,
        onboardingRequestDtoSchema,
        toDto(updated),
      );
      if (validated === undefined) throw new Error('v2 response validation failed');
      return { statusCode, body: validated };
    },
  }).catch((error: unknown) =>
    isIdempotencyConflict(error)
      ? mapDomainError(reply, request, userId, error, {
          conflictId: v2Headers['idempotency-key'],
        })
      : mapDomainError(reply, request, userId, error),
  );
  if (result === undefined) return reply;
  return reply.status(result.statusCode).send(result.body);
}

/**
 * `missingDocuments` is computed rather than stored: it is a function of the
 * documents already present, and a stored copy would go stale the moment one
 * is re-uploaded.
 */
export function toDto(request: OnboardingRequest) {
  return {
    id: request.id,
    userId: request.userId,
    status: request.status,
    requestedType: request.requestedType,
    plan: request.plan,
    profile: request.profile,
    documents: request.documents,
    missingDocuments: missingDocuments(request),
    submittedAt: request.submittedAt,
    reviewedBy: request.reviewedBy,
    reviewedAt: request.reviewedAt,
    reviewNote: request.reviewNote,
    provisionedOrganizationId: request.provisionedOrganizationId,
    version: request.version,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}
