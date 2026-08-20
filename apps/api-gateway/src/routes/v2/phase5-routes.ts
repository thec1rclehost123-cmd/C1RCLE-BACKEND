import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

const ScannerSessionCreateBody = z.object({
  eventId: z.string().min(1),
  code: z.string().min(1),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  sessionType: z.enum(['staff', 'device']),
}).strict();

const ScanBody = z.object({
  eventId: z.string().min(1),
  qrPayload: z.union([z.string(), z.object({}).passthrough()]),
  scannedBy: z.object({
    uid: z.string(),
    name: z.string(),
    role: z.string(),
  }),
  gate: z.string().optional(),
  deviceId: z.string().optional(),
  isOffline: z.boolean().optional(),
}).strict();

const ScanVerifyBody = z.object({
  eventId: z.string().min(1),
  qrPayload: z.union([z.string(), z.object({}).passthrough()]),
  scannedBy: z.object({
    uid: z.string(),
    name: z.string(),
    role: z.string(),
  }),
  gate: z.string().optional(),
  deviceId: z.string().optional(),
  isOffline: z.boolean().optional(),
}).strict();

const DoorWalkInBody = z.object({
  eventId: z.string().min(1),
  organizationId: z.string().min(1),
  guestName: z.string().min(1),
  guestPhone: z.string().optional().nullable(),
  guestAge: z.number().int().min(0).max(120).optional().nullable(),
  gender: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  totalGuests: z.number().int().min(1).max(100).default(1),
  gate: z.string().optional().nullable(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']).default('cash'),
  tierId: z.string().min(1),
  tierName: z.string().min(1),
  quantity: z.number().int().min(1).max(100).default(1),
  entryType: z.string().min(1),
  idempotencyKey: z.string().uuid().optional(),
}).strict();

const DoorDineInBody = z.object({
  eventId: z.string().min(1),
  organizationId: z.string().min(1),
  guestName: z.string().min(1),
  guestPhone: z.string().optional().nullable(),
  guestAge: z.number().int().min(0).max(120).optional().nullable(),
  gender: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  totalGuests: z.number().int().min(1).max(100).default(1),
  tableNumber: z.string().optional().nullable(),
  gate: z.string().optional().nullable(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']).default('cash'),
  tierId: z.string().min(1),
  tierName: z.string().min(1),
  quantity: z.number().int().min(1).max(100).default(1),
  entryType: z.string().min(1),
  idempotencyKey: z.string().uuid().optional(),
}).strict();

const CoverWalletIssueBody = z.object({
  orderId: z.string().min(1),
  eventId: z.string().min(1),
  organizationId: z.string().min(1),
  venueId: z.string().optional().nullable(),
  userId: z.string().optional().nullable(),
  guestFirstName: z.string().optional().nullable(),
  openingBalancePaise: z.number().int().nonnegative(),
  rules: z.object({
    allowedPresetItems: z.array(z.string()).default([]),
    showBalanceToGuest: z.boolean().default(true),
    maxChargeAmountPaise: z.number().int().nonnegative().default(0),
    minChargeAmountPaise: z.number().int().nonnegative().default(0),
    terminationTime: z.string().optional().nullable(),
    maxChargePerMinutePaise: z.number().int().nonnegative().default(0).nullable(),
    velocityLimitPerMinute: z.number().int().positive().default(3),
  }).strict(),
}).strict();

const CoverWalletDebitBody = z.object({
  walletId: z.string().min(1),
  presetItemId: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  idempotencyKey: z.string().uuid(),
  operatorId: z.string().min(1),
  operatorName: z.string().optional().nullable(),
  operatorRole: z.string().optional().nullable(),
  deviceId: z.string().min(1),
  eventCodeId: z.string().min(1),
  isOnline: z.boolean(),
}).strict();

const CoverWalletCreditBody = z.object({
  walletId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  reason: z.string().min(1),
  idempotencyKey: z.string().uuid(),
  operatorId: z.string().min(1),
  operatorName: z.string().optional().nullable(),
  operatorRole: z.string().optional().nullable(),
}).strict();

const CoverWalletFreezeBody = z.object({
  walletId: z.string().min(1),
  reason: z.string().min(1),
  frozenBy: z.string().min(1),
}).strict();

const CoverWalletUnfreezeBody = z.object({
  walletId: z.string().min(1),
  unfrozenBy: z.string().min(1),
}).strict();

const CoverWalletTerminateBody = z.object({
  walletId: z.string().min(1),
  reason: z.string().min(1),
  terminatedBy: z.string().min(1),
}).strict();

const MagicQrBody = z.object({
  entitlementId: z.string().min(1),
  tierPricePaise: z.number().int().nonnegative(),
}).strict();

const OfflineManifestBody = z.object({
  eventId: z.string().min(1),
  scannerSessionId: z.string().min(1),
  expiresAt: z.string().min(1),
}).strict();

const OfflineSyncBody = z.object({
  scannerSessionId: z.string().min(1),
  scans: z.array(z.object({
    payload: z.union([z.string(), z.object({}).passthrough()]),
    scannedAt: z.string(),
    deviceId: z.string(),
  })),
}).strict();

export default async function phase5Routes(fastify) {
  // =============================================================================
  // SCANNER ROUTES
  // =============================================================================

  /**
   * POST /api/v2/door/sessions
   * Create a scanner session from an event code
   */
  fastify.post(
    '/door/sessions',
    {
      preHandler: [
        fastify.validateV2({ body: ScannerSessionCreateBody }),
        fastify.rateLimit('SCANNER_COMMAND'),
      ],
    },
    async (request, reply) => {
      const { eventId, code, deviceId, deviceName, sessionType } = request.body;
      // Implementation would call scannerService.createSession
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * GET /api/v2/door/sessions/:sessionId
   * Get scanner session details
   */
  fastify.get(
    '/door/sessions/:sessionId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/door/check-ins
   * Process an entry scan (entitlement verification)
   */
  fastify.post(
    '/door/check-ins',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({ body: ScanBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/door/check-ins/verify
   * Verify a scan payload without consuming (for preview)
   */
  fastify.post(
    '/door/check-ins/verify',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({ body: ScanVerifyBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * GET /api/v2/door/check-ins/:checkInId
   * Get check-in details
   */
  fastify.get(
    '/door/check-ins/:checkInId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/door/lookup
   * Ticket lookup without check-in (for preview)
   */
  fastify.post(
    '/door/lookup',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({ body: ScanBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/door/override
   * Override a denied scan (requires ticket.override permission)
   */
  fastify.post(
    '/door/override',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: z.object({ checkInId: z.string().min(1), reason: z.string().min(1) }).strict() }),
        fastify.requirePermission('ticket.override'),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * GET /api/v2/door/offline-manifest
   * Download signed offline manifest
   */
  fastify.get(
    '/door/offline-manifest',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({ querystring: z.object({ eventId: z.string().min(1), scannerSessionId: z.string().min(1), expiresAt: z.string().min(1) }).strict() }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/door/offline-sync
   * Sync offline scans from device
   */
  fastify.post(
    '/door/offline-sync',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({ body: OfflineSyncBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  // =============================================================================
  // DOOR ROUTES
  // =============================================================================

  /**
   * POST /api/v2/door/walk-in
   * Walk-in sale (server-side price recalculation)
   */
  fastify.post(
    '/door/walk-in',
    {
      preHandler: [
        fastify.rateLimit('DOOR_COMMAND'),
        fastify.validateV2({ body: DoorWalkInBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/door/dine-in
   * Dine-in sale
   */
  fastify.post(
    '/door/dine-in',
    {
      preHandler: [
        fastify.rateLimit('DOOR_COMMAND'),
        fastify.validateV2({ body: DoorDineInBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * GET /api/v2/door/sales
   * List door sales
   */
  fastify.get(
    '/door/sales',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: z.object({ eventId: z.string().min(1), limit: z.string().optional() }).strict() }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * GET /api/v2/door/stats
   * Live door stats (WebSocket upgrade or polling fallback)
   */
  fastify.get(
    '/door/stats',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  // =============================================================================
  // COVER WALLET ROUTES
  // =============================================================================

  /**
   * POST /api/v2/cover-wallets
   * Issue wallet (on cover-charge ticket purchase)
   */
  fastify.post(
    '/cover-wallets',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: CoverWalletIssueBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/debit
   * Debit wallet (velocity limit, terminated check)
   */
  fastify.post(
    '/cover-wallets/:walletId/debit',
    {
      preHandler: [
        fastify.rateLimit('COVER_WALLET_COMMAND'),
        fastify.validateV2({ params: z.object({ walletId: z.string().min(1) }), body: CoverWalletDebitBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/credit
   * Credit wallet (refund)
   */
  fastify.post(
    '/cover-wallets/:walletId/credit',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: z.object({ walletId: z.string().min(1) }), body: CoverWalletCreditBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * GET /api/v2/cover-wallets/:walletId
   * Get wallet state
   */
  fastify.get(
    '/cover-wallets/:walletId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/credit
   * Credit wallet (refund)
   */
  fastify.post(
    '/cover-wallets/:walletId/credit',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: z.object({ walletId: z.string().min(1) }), body: CoverWalletCreditBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/freeze
   * Freeze wallet
   */
  fastify.post(
    '/cover-wallets/:walletId/freeze',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: z.object({ walletId: z.string().min(1) }), body: CoverWalletFreezeBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/unfreeze
   * Unfreeze wallet
   */
  fastify.post(
    '/cover-wallets/:walletId/unfreeze',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: z.object({ walletId: z.string().min(1) }), body: CoverWalletUnfreezeBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/terminate
   * Terminate wallet
   */
  fastify.post(
    '/cover-wallets/:walletId/terminate',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: z.object({ walletId: z.string().min(1) }), body: CoverWalletTerminateBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/reconcile
   * Reconcile wallet
   */
  fastify.post(
    '/cover-wallets/:walletId/reconcile',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: z.object({ walletId: z.string().min(1) }) }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  // =============================================================================
  // MAGIC TICKET QR
  // =============================================================================

  /**
   * GET /api/v2/tickets/:ticketId/qr
   * Get rotating QR payload for high-value tickets
   */
  fastify.get(
    '/tickets/:ticketId/qr',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  // =============================================================================
  // OFFLINE SUPPORT
  // =============================================================================

  /**
   * GET /api/v2/door/offline-manifest
   * Download signed offline manifest
   */
  fastify.get(
    '/door/offline-manifest',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({ querystring: z.object({ eventId: z.string().min(1), scannerSessionId: z.string().min(1), expiresAt: z.string().min(1) }).strict() }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  /**
   * POST /api/v2/door/offline-sync
   * Sync offline scans from device
   */
  fastify.post(
    '/door/offline-sync',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({ body: OfflineSyncBody }),
      ],
    },
    async (request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  // =============================================================================
  // WEBSOCKET
  // =============================================================================

  /**
   * GET /api/v2/door/stats/ws
   * Live scanner stats via WebSocket
   */
  fastify.get(
    '/door/stats/ws',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
      websocket: true,
    },
    async (connection, request) => {
      // WebSocket handler would be implemented here
      connection.socket.close(1001, 'Not yet implemented');
    },
  );
}