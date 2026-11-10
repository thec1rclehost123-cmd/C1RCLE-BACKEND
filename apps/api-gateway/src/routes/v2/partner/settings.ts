import {
  idempotencyKeySchema,
  opaqueIdSchema,
  partnerSettingsDtoSchema,
  updatePartnerSettingsSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const organizationParams = z.object({ organizationId: opaqueIdSchema });
const headers = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const writeHeaders = headers.extend({
  'idempotency-key': idempotencyKeySchema,
  'if-match': z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .optional(),
});
const uploadRequest = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  fileName: z.string().min(1).max(160),
});
const uploadResponse = z.object({
  uploadUrl: z.url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  publicUrl: z.url(),
  expiresAt: z.number().int(),
});
const PREFERENCES_DEFAULTS = {
  eventUpdates: true,
  orderUpdates: true,
  requests: true,
  partnerships: true,
  payouts: true,
} as const;

async function promoterStats(repos: ReturnType<typeof services.repos>, promoterId: string) {
  const assignments = await repos.catalog.listAssignmentsByPromoter(promoterId);
  const activeEvents = new Set(
    assignments
      .filter((assignment) => assignment.status === 'accepted' || assignment.status === 'active')
      .map((assignment) => assignment.eventId),
  );
  let cursor: string | null = null;
  let scanned = 0;
  let tickets = 0;
  const pageLimit = 1000;
  do {
    const page = await repos.orders.listByPromoter(promoterId, { limit: pageLimit, cursor });
    for (const order of page.items) {
      if (
        order.status !== 'paid' &&
        order.status !== 'refund_requested' &&
        order.status !== 'refunded'
      )
        continue;
      tickets += order.lines.reduce((sum, line) => sum + line.quantity, 0);
    }
    scanned += page.items.length;
    cursor = page.nextCursor;
    if (scanned >= 10_000 && cursor !== null)
      return { events: activeEvents.size, ticketsSold: null, checkIns: null };
  } while (cursor !== null);
  return { events: activeEvents.size, ticketsSold: tickets, checkIns: null };
}

async function settingsStats(
  repos: ReturnType<typeof services.repos>,
  organizationId: string,
  promoter: boolean,
) {
  const [overview, promoterSummary, partnerships, connections] = await Promise.all([
    repos.analytics.getOrganizationOverview(organizationId).catch(() => null),
    promoter ? promoterStats(repos, organizationId) : Promise.resolve(null),
    repos.partnerships
      .listForOrganization(organizationId, { limit: 100, cursor: null })
      .catch(() => ({ items: [], total: 0, nextCursor: null })),
    repos.promoterConnections
      .listForOrganization(organizationId, { limit: 100, cursor: null })
      .catch(() => ({ items: [], total: 0, nextCursor: null })),
  ]);
  return {
    events: promoterSummary?.events ?? overview?.totalEvents ?? null,
    ticketsSold:
      promoterSummary?.ticketsSold ?? (promoter ? null : (overview?.totalTicketsSold ?? null)),
    checkIns: promoter ? null : (overview?.totalCheckIns ?? null),
    connections:
      partnerships.items.filter((item) => item.status === 'active').length +
      connections.items.filter((item) => item.status === 'active').length,
  };
}

export default async function partnerSettingsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/organizations/:organizationId/partner-settings',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationParams, headers }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationParams>;
      const actor = services.actor(request);
      const organization = await services.organizations
        .get(actor, organizationId)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (!organization) return reply;
      const repos = services.repos();
      const membership = organization.members.find((member) => member.userId === actor.userId);
      const isPromoter = membership?.capabilities.includes('promoter') ?? false;
      const profile = organization.settings.partnerProfile ?? {};
      const payload = {
        organizationId,
        displayName: profile.displayName ?? organization.name,
        handle: organization.slug,
        profile,
        privacy: {
          profileVisible: organization.settings.partnerPrivacy?.profileVisible ?? true,
          showGuestList: organization.settings.partnerPrivacy?.showGuestList ?? false,
        },
        inAppNotifications: {
          ...PREFERENCES_DEFAULTS,
          ...organization.settings.partnerNotifications,
        },
        memberSince: organization.createdAt,
        stats: await settingsStats(repos, organizationId, isPromoter),
      };
      const validated = validateV2Response(reply, request, partnerSettingsDtoSchema, payload);
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.patch(
    '/organizations/:organizationId/partner-settings',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: organizationParams,
          headers: writeHeaders,
          body: updatePartnerSettingsSchema,
        }),
        fastify.requirePermission('partner.profile.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationParams>;
      const body = request.body as z.infer<typeof updatePartnerSettingsSchema>;
      const actor = services.actor(request);
      const current = await services.organizations
        .get(actor, organizationId)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (!current) return reply;

      const membership = current.members.find((member) => member.userId === actor.userId);
      if (body.handle !== undefined) {
        if (!membership?.capabilities.includes('promoter')) {
          return reply
            .status(403)
            .send({ code: 'forbidden', message: 'Only Promoters can change a public handle.' });
        }
        if (membership.role !== 'owner' && membership.role !== 'admin') {
          return reply.status(403).send({
            code: 'forbidden',
            message: 'Only Promoter owners and admins can change the public handle.',
          });
        }
        const existing = await services.repos().organizations.getBySlug(body.handle);
        if (existing && existing.id !== current.id) {
          return reply
            .status(409)
            .send({ code: 'conflict', message: 'That handle is already in use.' });
        }
      }

      const storageBucket = services.config().storage.kycBucket;
      for (const url of [body.profile?.photoUrl, body.profile?.coverUrl]) {
        if (url === undefined || url === null) continue;
        const prefix = `https://storage.googleapis.com/${storageBucket}/partner-profiles/${organizationId}/`;
        if (!url.startsWith(prefix)) {
          return reply.status(400).send({
            code: 'validation',
            message: 'Profile images must use an upload issued for this organization.',
          });
        }
      }

      const v2Headers = request.v2Headers ?? {};
      const expectedVersion = v2Headers['if-match']
        ? Number.parseInt(v2Headers['if-match'], 10)
        : null;
      const settings = {
        ...current.settings,
        ...(body.profile || body.displayName !== undefined
          ? {
              partnerProfile: {
                ...current.settings.partnerProfile,
                ...body.profile,
                ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
              },
            }
          : {}),
        ...(body.privacy
          ? { partnerPrivacy: { ...current.settings.partnerPrivacy, ...body.privacy } }
          : {}),
        ...(body.inAppNotifications
          ? {
              partnerNotifications: {
                ...current.settings.partnerNotifications,
                ...body.inAppNotifications,
              },
            }
          : {}),
      };
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'organization.partner-settings.update',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { organizationId }, body },
        run: async () => {
          const updated = await services.organizations.update(actor, {
            actor,
            organizationId,
            expectedVersion,
            props: {
              ...(body.handle ? { slug: body.handle } : {}),
              settings,
            },
          });
          const repos = services.repos();
          const membership = updated.members.find((member) => member.userId === actor.userId);
          const profile = updated.settings.partnerProfile ?? {};
          const payload = {
            organizationId,
            displayName: profile.displayName ?? updated.name,
            handle: updated.slug,
            profile,
            privacy: {
              profileVisible: updated.settings.partnerPrivacy?.profileVisible ?? true,
              showGuestList: updated.settings.partnerPrivacy?.showGuestList ?? false,
            },
            inAppNotifications: {
              ...PREFERENCES_DEFAULTS,
              ...updated.settings.partnerNotifications,
            },
            memberSince: updated.createdAt,
            stats: await settingsStats(
              repos,
              organizationId,
              membership?.capabilities.includes('promoter') ?? false,
            ),
          };
          const validated = validateV2Response(reply, request, partnerSettingsDtoSchema, payload);
          if (!validated) throw new Error('Partner settings response failed contract validation.');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error))
          return mapDomainError(reply, request, organizationId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        return mapDomainError(reply, request, organizationId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/organizations/:organizationId/partner-profile-media/upload-url',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: organizationParams,
          headers: writeHeaders,
          body: uploadRequest,
        }),
        fastify.requirePermission('partner.profile.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationParams>;
      const body = request.body as z.infer<typeof uploadRequest>;
      const actor = services.actor(request);
      const organization = await services.organizations
        .get(actor, organizationId)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (!organization) return reply;
      const extension = body.contentType === 'image/jpeg' ? 'jpg' : body.contentType.split('/')[1];
      const path = `partner-profiles/${organizationId}/${services.config().ids()}.${extension}`;
      const expiresAt = services.config().clock.now().getTime() + 15 * 60 * 1000;
      const grant = await services.objectStorage.issueUploadUrl({
        key: path,
        contentType: body.contentType,
        maxBytes: 5 * 1024 * 1024,
        expiresAt,
        visibility: 'public',
      });
      const validated = validateV2Response(reply, request, uploadResponse, {
        uploadUrl: grant.uploadUrl,
        method: grant.method,
        headers: grant.headers,
        publicUrl: services.objectStorage.toPublicUrl(grant.storagePath),
        expiresAt: grant.expiresAt,
      });
      if (!validated) return reply;
      return reply.send(validated);
    },
  );
}
