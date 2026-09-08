import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  otpSendRequestSchema,
  otpVerifyRequestSchema,
  otpAckResponseSchema,
} from '@c1rcle/contracts/client';
import { type z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Email OTP routes (signup verification) ──────────────────────────────────
 * Pre-session, like `/auth/signup` — no `X-Organization-Id`/actor context to
 * check, so these are thin wrappers over `EmailOtpService` with no tenancy
 * gate. `OTP_SEND`/`OTP_VERIFY` rate-limit classes are the HTTP-layer defense
 * (v1-proven 5/min, 10/min); the domain model's own cooldown/lockout is the
 * second layer (see `email-otp-service.ts`'s doc comment).
 *
 * The response is deliberately the same generic acknowledgement whether or
 * not the address is registered/valid — v1's `sendGuestOtp` returned the
 * identical "If valid, a secret has been dispatched" regardless, to avoid
 * turning this into an email-enumeration oracle.
 */
const services = createV2Services();

const GENERIC_ACK = { message: 'If valid, a code has been sent.' };

export default async function otpRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/otp/send',
    {
      preHandler: [
        fastify.rateLimit('OTP_SEND'),
        fastify.validateV2({ body: otpSendRequestSchema }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof otpSendRequestSchema>;
      const outcome = await services.emailOtp
        .send(body.email)
        .then(() => 'sent' as const)
        .catch((error: unknown) => {
          // The only domain error here is the 60s resend cooldown. Swallow
          // it into the same generic ack rather than a distinct status —
          // surfacing "you already requested one" as a different response
          // would let an attacker probe whether a code was recently sent to
          // an address they don't own. A genuinely unexpected error still
          // 500s below.
          const known = error as { code?: string };
          if (known?.code === 'invalid_operation') return 'sent' as const;
          request.log.error({ err: error }, 'unmapped_domain_error');
          reply.status(500).send(
            buildV2ErrorResponse({
              status: 500,
              message: 'Internal server error',
              code: 'server',
              requestId: request.id,
            }),
          );
          return undefined;
        });
      if (outcome === undefined) return reply;
      const validated = validateV2Response(reply, request, otpAckResponseSchema, GENERIC_ACK);
      if (validated === undefined) return reply;
      return reply.status(200).send(validated);
    },
  );

  fastify.post(
    '/otp/verify',
    {
      preHandler: [
        fastify.rateLimit('OTP_VERIFY'),
        fastify.validateV2({ body: otpVerifyRequestSchema }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof otpVerifyRequestSchema>;
      const result = await services.emailOtp
        .verify(body.email, body.code)
        .then(() => true as const)
        .catch((error: unknown) => {
          mapDomainError(reply, request, error);
          return undefined;
        });
      if (result === undefined) return reply;
      const validated = validateV2Response(reply, request, otpAckResponseSchema, {
        message: 'Verified.',
      });
      if (validated === undefined) return reply;
      return reply.status(200).send(validated);
    },
  );
}

function mapDomainError(reply: FastifyReply, request: FastifyRequest, error: unknown): undefined {
  const known = error as { code?: string; message?: string };
  if (known?.code === 'invalid_operation') {
    reply.status(400).send(
      buildV2ErrorResponse({
        status: 400,
        message: known.message ?? 'Invalid request',
        code: 'validation',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  request.log.error({ err: error }, 'unmapped_domain_error');
  reply.status(500).send(
    buildV2ErrorResponse({
      status: 500,
      message: 'Internal server error',
      code: 'server',
      requestId: request.id,
    }),
  );
  return undefined;
}
