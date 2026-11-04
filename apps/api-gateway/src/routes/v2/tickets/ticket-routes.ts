import {
  entitlementDtoSchema,
  eventChangeResponseDtoSchema,
  eventChangeResponseRequestSchema,
  opaqueIdSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Guest ticket reads (Phase 4 PR3) ──────────────────────────────────────
 * `GET /tickets/:id` — the entitlement DTO for a ticket the caller owns.
 *
 * Email-bound transfer routes reuse the entitlement and scanner credential
 * path. Transfer writes are disabled by default behind the M5 feature flag;
 * recipients prove a persisted verified email when they accept an invitation.
 */

const services = createV2Services();
const ticketIdParam = z.object({ id: z.string().min(3).max(64) });
const transferIdParam = z.object({ transferId: opaqueIdSchema });
const transferResendResponseSchema = z.object({ requested: z.literal(true) });
const eventChangeResponseParams = z.object({
  id: z.string().min(3).max(64),
  eventVersion: z.coerce.number().int().positive(),
});
const createTransferBody = z
  .object({
    recipientEmail: z
      .email()
      .trim()
      .max(254)
      .transform((email) => email.toLowerCase()),
  })
  .strict();
const transferDtoSchema = z.object({
  id: opaqueIdSchema,
  entitlementId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  status: z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired', 'frozen']),
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export default async function ticketRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/tickets/:id/event-changes/:eventVersion/respond',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventChangeResponseParams,
          body: eventChangeResponseRequestSchema,
        }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { id, eventVersion } = request.params as z.infer<typeof eventChangeResponseParams>;
      const { response } = request.body as z.infer<typeof eventChangeResponseRequestSchema>;
      const result = await services.tickets
        .respondToMaterialEventChange(id, eventVersion, response, services.actor(request))
        .catch((error: unknown) =>
          mapDomainError(reply, request, id, error, { hideForbidden: true }),
        );
      if (!result) return reply;
      const validated = validateV2Response(reply, request, eventChangeResponseDtoSchema, result);
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/tickets/:id',
    { preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: ticketIdParam })] },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { id } = request.params as z.infer<typeof ticketIdParam>;
      const actor = services.actor(request);
      const entitlement = await services.tickets
        .getById(id, actor)
        .catch((error: unknown) => mapDomainError(reply, request, id, error));
      if (entitlement === undefined) return reply;
      const validated = validateV2Response(reply, request, entitlementDtoSchema, entitlement);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/tickets/:id/transfers',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: ticketIdParam, body: createTransferBody }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { id } = request.params as z.infer<typeof ticketIdParam>;
      const { recipientEmail } = request.body as z.infer<typeof createTransferBody>;
      const transfer = await services.tickets
        .requestTransfer(id, recipientEmail, services.actor(request))
        .catch((error: unknown) =>
          mapDomainError(reply, request, id, error, { hideForbidden: true }),
        );
      if (!transfer) return reply;
      const validated = validateV2Response(reply, request, transferDtoSchema, transfer);
      if (!validated) return reply;
      return reply.code(201).send(validated);
    },
  );

  fastify.get(
    '/tickets/:id/transfers',
    { preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: ticketIdParam })] },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { id } = request.params as z.infer<typeof ticketIdParam>;
      const transfers = await services.tickets
        .listTransfers(id, services.actor(request))
        .catch((error: unknown) =>
          mapDomainError(reply, request, id, error, { hideForbidden: true }),
        );
      if (!transfers) return reply;
      const validated = validateV2Response(reply, request, z.array(transferDtoSchema), transfers);
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/ticket-transfers/:transferId/resend',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: transferIdParam }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { transferId } = request.params as z.infer<typeof transferIdParam>;
      const idempotencyKey = request.headers['idempotency-key'];
      const result = await services.tickets
        .resendTransferInvitation(
          transferId,
          typeof idempotencyKey === 'string' ? idempotencyKey : '',
          services.actor(request),
        )
        .catch((error: unknown) =>
          mapDomainError(reply, request, transferId, error, { hideForbidden: true }),
        );
      if (!result) return reply;
      const validated = validateV2Response(reply, request, transferResendResponseSchema, result);
      if (!validated) return reply;
      return reply.code(202).send(validated);
    },
  );

  for (const action of ['accept', 'decline', 'cancel'] as const) {
    fastify.post(
      `/ticket-transfers/:transferId/${action}`,
      {
        preHandler: [
          fastify.rateLimit('STANDARD_COMMAND'),
          fastify.validateV2({ params: transferIdParam }),
        ],
      },
      async (request, reply) => {
        reply.header('cache-control', 'private, no-store');
        const { transferId } = request.params as z.infer<typeof transferIdParam>;
        const result = await services.tickets
          .resolveTransfer(transferId, action, services.actor(request))
          .catch((error: unknown) =>
            mapDomainError(reply, request, transferId, error, { hideForbidden: true }),
          );
        if (!result) return reply;
        const transfer = validateV2Response(reply, request, transferDtoSchema, result.transfer);
        if (!transfer) return reply;
        const entitlement = result.entitlement
          ? validateV2Response(reply, request, entitlementDtoSchema, result.entitlement)
          : undefined;
        if (result.entitlement && !entitlement) return reply;
        return reply.send({ transfer, ...(entitlement ? { entitlement } : {}) });
      },
    );
  }
}
