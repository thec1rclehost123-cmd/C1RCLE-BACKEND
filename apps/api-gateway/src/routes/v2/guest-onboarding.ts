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

export async function registerGuestOnboarding(
  app: FastifyInstance,
  service: GuestProfileService,
  phoneVerifier?: VerificationProvider,
) {
  app.get(
    '/profile/onboarding',
    { preHandler: app.rateLimit('AUTH_READ') },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
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
  app.put(
    '/profile/onboarding',
    {
      preHandler: [
        app.rateLimit('STANDARD_COMMAND'),
        app.validateV2({ body: guestOnboardingPatchSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
      try {
        await service.saveOnboarding(userId, guestOnboardingPatchSchema.parse(request.body));
        return await reply.status(204).send();
      } catch (error) {
        return mapDomainError(reply, request, userId, error);
      }
    },
  );
  app.post(
    '/profile/onboarding/phone',
    { preHandler: [app.rateLimit('OTP_VERIFY'), app.validateV2({ body: guestPhoneProofSchema })] },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
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
