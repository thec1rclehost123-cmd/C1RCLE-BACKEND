import {
  guestOnboardingPatchSchema,
  guestOnboardingStateSchema,
  guestPhoneProofSchema,
} from '@c1rcle/contracts/guest-onboarding';
import { authClient } from '@c1rcle/core/infrastructure';

import type { GuestProfileService } from '@c1rcle/core/application';
import type { VerificationProvider } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../../config/index.js';
import { validateV2Response } from '../../lib/v2-response-validation.js';
import { FirebasePhoneVerificationProvider } from '../../lib/verification/firebase-phone-verifier.js';

import { mapDomainError } from './partner/events.js';

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

function requireUserId(request: FastifyRequest, reply: FastifyReply) {
  const userId = request.actor?.userId;
  if (!userId) {
    reply.status(401).send({ message: 'Authentication required.' });
    return undefined;
  }
  return userId;
}

async function requireAuthenticatedGuest(request: FastifyRequest, reply: FastifyReply) {
  requireUserId(request, reply);
}

function authenticatedUserId(request: FastifyRequest) {
  return (request.actor as { userId: string }).userId;
}

export async function registerGuestOnboarding(
  fastify: FastifyInstance,
  service: GuestProfileService,
  phoneVerifier?: VerificationProvider,
) {
  fastify.get(
    '/profile/onboarding',
    { preHandler: [fastify.rateLimit('AUTH_READ'), requireAuthenticatedGuest] },
    async (request, reply) => {
      const userId = authenticatedUserId(request);
      const state = await service.getOnboarding(userId);
      const body = {
        displayName: state.profile?.displayName ?? '',
        dateOfBirth: state.profile?.dateOfBirth ?? '',
        tastes: state.profile?.tastes ?? [],
        phoneNumber: state.profile?.phoneNumber ?? null,
        phoneVerified: Boolean(state.profile?.phoneVerifiedAt),
        complete: state.complete,
        interestOptions: [...state.interestOptions],
      };
      const valid = validateV2Response(reply, request, guestOnboardingStateSchema, body);
      reply.header('cache-control', 'private, no-store');
      return valid === undefined ? reply : reply.send(valid);
    },
  );
  fastify.put(
    '/profile/onboarding',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: guestOnboardingPatchSchema }),
        requireAuthenticatedGuest,
      ],
    },
    async (request, reply) => {
      const userId = authenticatedUserId(request);
      try {
        await service.saveOnboarding(userId, guestOnboardingPatchSchema.parse(request.body));
        return await reply.status(204).send();
      } catch (error) {
        return mapDomainError(reply, request, userId, error);
      }
    },
  );
  fastify.post(
    '/profile/onboarding/phone',
    {
      preHandler: [
        fastify.rateLimit('OTP_VERIFY'),
        fastify.validateV2({ body: guestPhoneProofSchema }),
        requireAuthenticatedGuest,
      ],
    },
    async (request, reply) => {
      const userId = authenticatedUserId(request);
      const body = guestPhoneProofSchema.parse(request.body);
      try {
        const verifier =
          phoneVerifier ?? new FirebasePhoneVerificationProvider(authClient(getGatewayConfig()));
        await service.verifyPhone(userId, body.phoneNumber, body.proofToken, verifier);
        return await reply.status(204).send();
      } catch (error) {
        return mapDomainError(reply, request, userId, error);
      }
    },
  );
}
