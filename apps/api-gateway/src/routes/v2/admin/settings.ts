import {
  idempotencyKeySchema,
  platformSettingsDtoSchema,
  platformSettingsUpdateRequestSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin platform settings (Phase 7 admin) ─────────────────────────────────
 * Singleton platform-wide settings doc (`v2_platform_settings`), editable by
 * admin: `GET /admin/settings/platform` (read) and
 * `PUT /admin/settings/platform` (merge-update).
 *
 * Threshold changes take effect immediately on the next refund request;
 * no migration or restart required.
 */

const services = createV2Services();

const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function settingsToDto(settings: {
  platformFeeRate: number;
  refundSingleApproverThresholdPaise: number;
  refundDualApproverThresholdPaise: number;
  maintenanceMode: boolean;
  featureFlags: Record<string, boolean>;
  updatedAt: string;
}) {
  return {
    platformFeeRate: settings.platformFeeRate,
    refundSingleApproverThresholdPaise: settings.refundSingleApproverThresholdPaise,
    refundDualApproverThresholdPaise: settings.refundDualApproverThresholdPaise,
    maintenanceMode: settings.maintenanceMode,
    featureFlags: settings.featureFlags,
    updatedAt: settings.updatedAt,
  };
}

export default async function adminSettingsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/settings/platform',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const settings = await services.adminOps
        .getPlatformSettings(userId)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (settings === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        platformSettingsDtoSchema,
        settingsToDto(settings),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.put(
    '/admin/settings/platform',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: platformSettingsUpdateRequestSchema, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof platformSettingsUpdateRequestSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.platform-settings.update',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const updated = await services.adminOps.updatePlatformSettings(
            userId,
            body,
            requestMeta(request),
          );
          const validated = validateV2Response(
            reply,
            request,
            platformSettingsDtoSchema,
            settingsToDto(updated),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
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
    },
  );
}
