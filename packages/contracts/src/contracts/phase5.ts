import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema, idempotencyKeySchema } from './shared.js';

/**
 * ─── Phase 5: Door / Scanner / Cover Wallet Contracts ────────────────────────
 */

// ── Door codes (the credential a scanner device redeems for a session) ──────
export const eventCodeTypeSchema = z.enum(['full', 'scan_only', 'charge']);
export type EventCodeType = z.infer<typeof eventCodeTypeSchema>;

export const eventCodeCreateBodySchema = z
  .object({
    /**
     * `full` scans + sells at the door, `scan_only` scans and takes walk-ins,
     * `charge` touches cover wallets only. Chosen per device role so a
     * cloakroom tablet cannot admit guests.
     */
    type: eventCodeTypeSchema,
    gate: z.string().min(1).max(64).nullable().default(null),
    maxDevices: z.number().int().min(1).max(100).optional(),
    allowReuse: z.boolean().optional(),
    expiresAt: z.iso.datetime().nullable().default(null),
  })
  .strict();
export type EventCodeCreateBody = z.infer<typeof eventCodeCreateBodySchema>;

export const eventCodeDtoSchema = z.object({
  id: opaqueIdSchema,
  /**
   * The human code staff type into a device. It is a credential: only
   * `door.manage` holders ever receive it, and it is never written to an
   * audit record or a log line.
   */
  code: z.string(),
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  venueId: opaqueIdSchema.nullable(),
  type: eventCodeTypeSchema,
  gate: z.string().nullable(),
  status: z.enum(['active', 'revoked', 'expired']),
  maxDevices: z.number().int(),
  allowReuse: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedReason: z.string().nullable(),
  stats: z.object({
    scansCount: z.number().int().nonnegative(),
    doorEntriesCount: z.number().int().nonnegative(),
    doorRevenue: z.number().int().nonnegative(),
    lastUsedAt: z.iso.datetime().nullable(),
    activeSessions: z.number().int().nonnegative(),
  }),
  createdAt: z.iso.datetime(),
});
export type EventCodeDto = z.infer<typeof eventCodeDtoSchema>;

export const eventCodeListResponseSchema = z.object({ items: z.array(eventCodeDtoSchema) });
export type EventCodeListResponse = z.infer<typeof eventCodeListResponseSchema>;

export const revokeReasonBodySchema = z.object({ reason: z.string().min(1).max(500) }).strict();
export type RevokeReasonBody = z.infer<typeof revokeReasonBodySchema>;

// Scanner Session
export const scannerSessionCreateBodySchema = z
  .object({
    eventId: opaqueIdSchema,
    code: z.string().min(1),
    deviceId: z.string().min(1).max(128),
    deviceName: z.string().min(1).max(128),
    sessionType: z.enum(['staff', 'device']),
  })
  .strict();
export type ScannerSessionCreateBody = z.infer<typeof scannerSessionCreateBodySchema>;

/**
 * Header carrying the scanner-session token on every scanning call. It is a
 * bearer credential for one device on one shift — pino redacts it, and
 * `GET /door/sessions/:id` never returns it again after creation.
 */
export const scannerSessionTokenHeaderSchema = z.looseObject({
  'x-scanner-session-token': z.string().min(1),
});
export type ScannerSessionTokenHeader = z.infer<typeof scannerSessionTokenHeaderSchema>;

export const scannerSessionDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  codeId: opaqueIdSchema,
  /**
   * The raw token, returned by `POST /door/sessions` and never again: reads
   * always report `null`. Only its SHA-256 hash is stored, so a database read
   * cannot impersonate a scanner.
   */
  sessionToken: z.string().min(1).nullable(),
  sessionExpiresAt: z.iso.datetime(),
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  permissions: z.object({
    canScan: z.boolean(),
    canDoorEntry: z.boolean(),
    canWalkIn: z.boolean(),
    canCharge: z.boolean(),
  }),
  status: z.enum(['active', 'revoked', 'expired']),
  createdAt: z.iso.datetime(),
});
export type ScannerSessionDto = z.infer<typeof scannerSessionDtoSchema>;

// Scan Request/Response
/**
 * A scan.
 *
 * Note what is NOT here: the old contract carried `scannedBy: {uid, name,
 * role}` and a `deviceId`, all supplied by the caller and all trusted. The
 * operator is now taken from the authenticated session and the device from
 * the scanner-session token, so neither can be claimed. `operatorName` /
 * `operatorRole` survive only as display labels on the door ledger.
 */
export const scanRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    qrPayload: z.string().min(1).max(512),
    operatorName: z.string().max(120).optional(),
    operatorRole: z.string().max(60).optional(),
    gate: z.string().max(64).optional(),
  })
  .strict();
export type ScanRequest = z.infer<typeof scanRequestSchema>;

export const scanDenyReasonSchema = z.enum([
  'invalid_signature',
  'already_used',
  'expired',
  'wrong_event',
  'device_invalid',
  'void_ticket',
  'capacity_exceeded',
  'wrong_gate',
  'offline_expired',
  'override_required',
  'promoter_not_authorized',
]);
export type ScanDenyReasonCode = z.infer<typeof scanDenyReasonSchema>;

export const scanResponseSchema = z.object({
  /**
   * `confirmation_required` is not an error — it is a couple ticket waiting
   * for a human to confirm both guests are present. Nothing has been spent
   * yet, which is why `checkInId` is absent on that branch.
   */
  status: z.enum(['consumed', 'denied', 'confirmation_required']),
  checkInId: opaqueIdSchema.optional(),
  confirmation: z
    .object({
      /** Short-lived, signed, bound to this ticket, session and device. */
      token: z.string(),
      expiresAt: z.iso.datetime(),
      seats: z.number().int().positive(),
    })
    .optional(),
  denyReason: scanDenyReasonSchema.nullable().optional(),
  denyMessage: z.string().nullable().optional(),
  entitlement: z
    .object({
      id: opaqueIdSchema,
      tierId: opaqueIdSchema,
      tierName: z.string(),
      holderName: z.string(),
      scansUsed: z.number().int(),
      scansAllowed: z.number().int(),
      status: z.string(),
    })
    .optional(),
});
export type ScanResponse = z.infer<typeof scanResponseSchema>;

/**
 * A preview (`/door/check-ins/verify`, `/door/lookup`). Deliberately its own
 * schema with its own `valid | invalid` vocabulary rather than reusing the
 * scan response: the old code mapped a preview's "would be admitted" onto the
 * literal string `consumed`, which reads, to any client, as "this guest has
 * been admitted". Nothing was consumed.
 */
export const ticketLookupResponseSchema = z.object({
  status: z.enum(['valid', 'invalid']),
  denyReason: scanDenyReasonSchema.nullable(),
  denyMessage: z.string().nullable(),
  entitlement: scanResponseSchema.shape.entitlement,
});
export type TicketLookupResponse = z.infer<typeof ticketLookupResponseSchema>;

/** One row of the door ledger — every attempt, admitted or refused. */
export const checkInDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  status: z.enum([
    'pending',
    'consumed',
    'denied',
    'cancelled',
    'revoked',
    'expired',
    'overridden',
  ]),
  denyReason: z.string().nullable(),
  denyMessage: z.string().nullable(),
  entitlementId: z.string().nullable(),
  tierId: z.string().nullable(),
  tierName: z.string().nullable(),
  operatorUid: z.string().nullable(),
  operatorName: z.string().nullable(),
  operatorRole: z.string().nullable(),
  gate: z.string().nullable(),
  deviceId: z.string().nullable(),
  guestName: z.string().nullable(),
  scannedAt: z.string(),
  admittedCount: z.number().int(),
  scanCountUsed: z.number().int().nullable(),
  scanCountAllowed: z.number().int().nullable(),
  isOffline: z.boolean(),
  overriddenBy: z.string().nullable(),
  overrideReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type CheckInDto = z.infer<typeof checkInDtoSchema>;

export const checkInListResponseSchema = paginatedSchema(checkInDtoSchema);
export type CheckInListResponse = z.infer<typeof checkInListResponseSchema>;

// Override (POST /door/override)
export const overrideRequestSchema = z
  .object({ checkInId: opaqueIdSchema, reason: z.string().min(1) })
  .strict();
export type OverrideRequest = z.infer<typeof overrideRequestSchema>;

export const overrideResponseSchema = z.object({
  checkInId: opaqueIdSchema,
  status: z.literal('overridden'),
  overriddenBy: opaqueIdSchema,
  overrideReason: z.string(),
});
export type OverrideResponse = z.infer<typeof overrideResponseSchema>;

// Door Stats (GET /door/stats)
export const doorStatsQuerySchema = z.object({ eventId: opaqueIdSchema }).strict();
export type DoorStatsQuery = z.infer<typeof doorStatsQuerySchema>;

export const doorStatsDtoSchema = z.object({
  eventId: opaqueIdSchema,
  /** `capacity`/`remaining` are null when the event configures no capacity. */
  occupancy: z.object({
    inside: z.number().int().nonnegative(),
    capacity: z.number().int().nonnegative().nullable(),
    remaining: z.number().int().nonnegative().nullable(),
    prebooked: z.number().int().nonnegative(),
    doorEntries: z.number().int().nonnegative(),
  }),
  byEntryType: z.record(z.string(), z.number().int().nonnegative()),
  scans: z.object({
    total: z.number().int().nonnegative(),
    consumed: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
    overridden: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  doorSales: z.object({
    count: z.number().int().nonnegative(),
    grossPaise: z.number().int().nonnegative(),
  }),
  coverWallet: z.object({
    activeWallets: z.number().int().nonnegative(),
    totalBalancePaise: z.number().int().nonnegative(),
    totalCreditsPaise: z.number().int().nonnegative(),
    totalDebitsPaise: z.number().int().nonnegative(),
  }),
  generatedAt: z.iso.datetime(),
});
export type DoorStatsDto = z.infer<typeof doorStatsDtoSchema>;

// Magic Ticket QR
export const magicQrRequestSchema = z
  .object({
    entitlementId: opaqueIdSchema,
    tierPricePaise: z.number().int().nonnegative(),
  })
  .strict();
export type MagicQrRequest = z.infer<typeof magicQrRequestSchema>;

export const magicQrResponseSchema = z.object({
  qrPayload: z.string(), // HMAC(entitlementId:timestamp)
  expiresAt: z.iso.datetime(),
  refreshIntervalSec: z.number().int().default(30),
});
export type MagicQrResponse = z.infer<typeof magicQrResponseSchema>;

// Offline Support
export const offlineManifestRequestSchema = z.object({ eventId: opaqueIdSchema }).strict();
export type OfflineManifestRequest = z.infer<typeof offlineManifestRequestSchema>;

export const offlineManifestResponseSchema = z.object({
  manifest: z.array(
    z.object({
      entitlementId: opaqueIdSchema,
      validFrom: z.iso.datetime(),
      validTo: z.iso.datetime(),
      signature: z.string(),
    }),
  ),
  signedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type OfflineManifestResponse = z.infer<typeof offlineManifestResponseSchema>;

export const offlineSyncRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    /** Bounded: a sync is a shift's backlog, not an unbounded bulk import. */
    scans: z
      .array(
        z.object({
          payload: z.string().min(1).max(512),
          scannedAt: z.iso.datetime(),
          deviceId: z.string().min(1).max(128),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type OfflineSyncRequest = z.infer<typeof offlineSyncRequestSchema>;

export const offlineSyncResponseSchema = z.object({
  synced: z.number().int(),
  conflicts: z.array(
    z.object({
      payload: z.string(),
      reason: z.string(),
    }),
  ),
});
export type OfflineSyncResponse = z.infer<typeof offlineSyncResponseSchema>;

// Door Schemas
/**
 * A guest captured at the door.
 *
 * The old version of this schema let almost everything through as a free
 * `string | null`, and the only real validation lived in the app's own submit
 * button — which means it did not exist at all for anyone calling the API
 * directly. These are the same rules the door screen enforces, now enforced
 * where they count.
 *
 * Note there is no price field, and there never will be: the amount is
 * recalculated server-side from the event's ticket catalog. A door sale whose
 * total the client can name is a door sale the client can discount.
 */
export const doorWalkInRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    guestName: z.string().trim().min(1).max(120),
    /** Exactly ten digits — an Indian mobile number, the only kind a door takes. */
    guestPhone: z
      .string()
      .regex(/^\d{10}$/, 'Phone must be exactly 10 digits')
      .optional()
      .nullable(),
    /** Under-18s are a licensing problem, not a rounding one. */
    guestAge: z.number().int().min(18).max(120).optional().nullable(),
    gender: z.enum(['male', 'female', 'other', 'undisclosed']).optional().nullable(),
    /** Optional email for the receipt. Validated so a typo fails loudly. */
    contact: z.email().max(254).optional().nullable(),
    totalGuests: z.number().int().min(1).max(100).default(1),
    gate: z.string().max(64).optional().nullable(),
    paymentMode: z.enum(['cash', 'card', 'upi', 'other']).default('cash'),
    tierId: opaqueIdSchema,
    quantity: z.number().int().min(1).max(100).default(1),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type DoorWalkInRequest = z.infer<typeof doorWalkInRequestSchema>;

export const doorDineInRequestSchema = doorWalkInRequestSchema
  .extend({
    tableNumber: z.string().trim().min(1).max(32).optional().nullable(),
  })
  .strict();
export type DoorDineInRequest = z.infer<typeof doorDineInRequestSchema>;

export const doorSaleResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  category: z.enum(['walkin', 'dinein']),
  guestName: z.string(),
  totalGuests: z.number().int(),
  amountPaise: z.number().int().nonnegative(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']),
  status: z.enum(['active', 'voided', 'refunded']),
  createdAt: z.iso.datetime(),
});
export type DoorSaleResponse = z.infer<typeof doorSaleResponseSchema>;

export const doorSalesListResponseSchema = paginatedSchema(doorSaleResponseSchema);
export type DoorSalesListResponse = z.infer<typeof doorSalesListResponseSchema>;

// Cover Wallet Schemas
export const coverWalletIssueRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    userId: opaqueIdSchema,
    openingBalancePaise: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CoverWalletIssueRequest = z.infer<typeof coverWalletIssueRequestSchema>;

export const coverWalletDebitRequestSchema = z
  .object({
    walletId: opaqueIdSchema,
    amountPaise: z.number().int().positive(),
    referenceId: opaqueIdSchema.optional(),
    referenceType: z.string().optional(),
    description: z.string().optional(),
    idempotencyKey: idempotencyKeySchema,
    deviceId: z.string().optional(),
  })
  .strict();
export type CoverWalletDebitRequest = z.infer<typeof coverWalletDebitRequestSchema>;

export const coverWalletCreditRequestSchema = z
  .object({
    walletId: opaqueIdSchema,
    amountPaise: z.number().int().positive(),
    referenceId: opaqueIdSchema.optional(),
    referenceType: z.string().optional(),
    description: z.string().optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type CoverWalletCreditRequest = z.infer<typeof coverWalletCreditRequestSchema>;

export const coverWalletResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  userId: opaqueIdSchema,
  balancePaise: z.number().int().nonnegative(),
  status: z.enum(['active', 'frozen', 'terminated', 'closed']),
  openingBalancePaise: z.number().int().nonnegative(),
  totalCreditsPaise: z.number().int().nonnegative(),
  totalDebitsPaise: z.number().int().nonnegative(),
  terminatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type CoverWalletResponse = z.infer<typeof coverWalletResponseSchema>;

export const coverWalletReconciliationRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    reconciliationDate: z.iso.date(),
    walletId: opaqueIdSchema.optional(),
    userId: opaqueIdSchema.optional(),
  })
  .strict();
export type CoverWalletReconciliationRequest = z.infer<
  typeof coverWalletReconciliationRequestSchema
>;

export const coverWalletReconciliationResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  reconciliationDate: z.iso.date(),
  expectedBalancePaise: z.number().int(),
  actualBalancePaise: z.number().int(),
  discrepancyPaise: z.number().int(),
  status: z.enum(['pending', 'completed', 'discrepancy', 'resolved']),
  discrepancies: z.array(
    z.object({
      type: z.enum([
        'balance_mismatch',
        'missing_credit',
        'missing_debit',
        'extra_transaction',
        'duplicate_transaction',
        'offline_sync_gap',
      ]),
      walletId: opaqueIdSchema,
      expectedAmountPaise: z.number().int(),
      actualAmountPaise: z.number().int(),
      transactionId: opaqueIdSchema.nullable(),
      description: z.string(),
    }),
  ),
  createdAt: z.iso.datetime(),
});
export type CoverWalletReconciliationResponse = z.infer<
  typeof coverWalletReconciliationResponseSchema
>;

// Phase 5 Error Codes
export const phase5ErrorCodeSchema = z.enum([
  'SCANNER_SESSION_EXPIRED',
  'VELOCITY_LIMIT_EXCEEDED',
  'WALLET_TERMINATED',
  'OFFLINE_MANIFEST_EXPIRED',
  'MAGIC_TICKET_SIGNATURE_INVALID',
  'SCANNER_SESSION_REVOKED',
  'COVER_WALLET_INSUFFICIENT_BALANCE',
  'DOOR_SALE_PRICE_MISMATCH',
]);
export type Phase5ErrorCode = z.infer<typeof phase5ErrorCodeSchema>;

// ── Door operations: event picker, shift start, roster, devices ─────────────

export const doorEventListQuerySchema = z
  .object({
    /** `today` (resolved in IST — a 1am door is still working last night) or YYYY-MM-DD. */
    date: z.union([z.literal('today'), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default('today'),
  })
  .strict();
export type DoorEventListQuery = z.infer<typeof doorEventListQuerySchema>;

export const doorEventSummarySchema = z.object({
  id: opaqueIdSchema,
  title: z.string(),
  slug: z.string(),
  venueId: opaqueIdSchema.nullable(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime().nullable(),
  status: z.string(),
  /** Null when the event has no configured capacity — never a fabricated default. */
  capacity: z.number().int().nonnegative().nullable(),
});
export type DoorEventSummary = z.infer<typeof doorEventSummarySchema>;

export const doorEventListResponseSchema = z.object({ items: z.array(doorEventSummarySchema) });
export type DoorEventListResponse = z.infer<typeof doorEventListResponseSchema>;

export const doorTierSummarySchema = z.object({
  id: opaqueIdSchema,
  name: z.string(),
  entryType: z.string(),
  pricePaise: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
});
export type DoorTierSummary = z.infer<typeof doorTierSummarySchema>;

/**
 * Everything a device needs to start a shift, in one call: the session token,
 * what this session may do, the event, its sellable tiers, and an opening
 * stats snapshot. One round trip because a door phone on club wifi may not
 * get a second one.
 */
export const startShiftResponseSchema = z.object({
  sessionId: opaqueIdSchema,
  /** Returned exactly once. Every later read reports null. */
  sessionToken: z.string(),
  sessionExpiresAt: z.iso.datetime(),
  event: doorEventSummarySchema,
  permissions: z.object({
    canScan: z.boolean(),
    canDoorEntry: z.boolean(),
    canWalkIn: z.boolean(),
    canCharge: z.boolean(),
  }),
  gate: z.string().nullable(),
  tiers: z.array(doorTierSummarySchema),
  stats: z.lazy(() => doorStatsDtoSchema),
  device: z.object({ deviceId: z.string(), deviceName: z.string() }),
});
export type StartShiftResponse = z.infer<typeof startShiftResponseSchema>;

export const scannerDeviceBindBodySchema = z
  .object({
    /**
     * Opaque and client-generated — the app mints one random value on first
     * launch and keeps it. Deliberately not a hardware id: those are
     * privacy-sensitive and, since the client reports them, not a security
     * boundary anyway. Authorization comes from the binding record.
     */
    deviceId: z.string().min(16).max(128),
    deviceName: z.string().min(1).max(128),
  })
  .strict();
export type ScannerDeviceBindBody = z.infer<typeof scannerDeviceBindBodySchema>;

/**
 * Re-authorizing a handset a manager previously unbound. Its own endpoint and
 * its own permission: the open `POST /door/devices` path exists so staff can
 * self-register on launch, and it must not double as a way to undo the
 * revocation of a stolen phone.
 */
export const scannerDeviceReauthorizeBodySchema = z
  .object({ deviceName: z.string().min(1).max(128) })
  .strict();
export type ScannerDeviceReauthorizeBody = z.infer<typeof scannerDeviceReauthorizeBodySchema>;

export const scannerDeviceDtoSchema = z.object({
  id: opaqueIdSchema,
  deviceId: z.string(),
  deviceName: z.string(),
  venueId: opaqueIdSchema.nullable(),
  status: z.enum(['active', 'unbound']),
  boundAt: z.iso.datetime(),
  unboundAt: z.iso.datetime().nullable(),
  unboundReason: z.string().nullable(),
  lastSeenAt: z.iso.datetime(),
  lastEventId: opaqueIdSchema.nullable(),
  lastGate: z.string().nullable(),
  scanCount: z.number().int().nonnegative(),
  lastScanAt: z.iso.datetime().nullable(),
  lastScanResult: z.string().nullable(),
});
export type ScannerDeviceDto = z.infer<typeof scannerDeviceDtoSchema>;

export const scannerDeviceListResponseSchema = z.object({
  items: z.array(scannerDeviceDtoSchema),
});
export type ScannerDeviceListResponse = z.infer<typeof scannerDeviceListResponseSchema>;

export const scannerHeartbeatBodySchema = z
  .object({ eventId: opaqueIdSchema, gate: z.string().max(64).optional() })
  .strict();
export type ScannerHeartbeatBody = z.infer<typeof scannerHeartbeatBodySchema>;

/**
 * The second half of a couple admission. `confirmed: false` is a real answer,
 * not a cancel — "only one of them turned up" is recorded as a denial,
 * because a venue gets asked about that later.
 */
export const confirmCoupleBodySchema = z
  .object({
    eventId: opaqueIdSchema,
    confirmationToken: z.string().min(16).max(1024),
    confirmed: z.boolean(),
    operatorName: z.string().max(120).optional(),
    operatorRole: z.string().max(60).optional(),
    gate: z.string().max(64).optional(),
  })
  .strict();
export type ConfirmCoupleBody = z.infer<typeof confirmCoupleBodySchema>;

/** Staff physically refused someone whose ticket scanned fine. */
export const staffDenyBodySchema = z
  .object({
    eventId: opaqueIdSchema,
    qrPayload: z.string().max(512).optional(),
    reason: z.string().min(1).max(500),
    gate: z.string().max(64).optional(),
  })
  .strict();
export type StaffDenyBody = z.infer<typeof staffDenyBodySchema>;

export const doorGuestSchema = z.object({
  id: opaqueIdSchema,
  name: z.string(),
  ticketType: z.string(),
  entryType: z.string(),
  quantity: z.number().int().positive(),
  source: z.enum(['online', 'door']),
  status: z.enum(['entered', 'not_entered']),
  enteredAt: z.string().nullable(),
  scansUsed: z.number().int().nonnegative().nullable(),
  scansAllowed: z.number().int().nonnegative().nullable(),
});
export type DoorGuest = z.infer<typeof doorGuestSchema>;

/**
 * Filtering and search are server-side parameters, not client-side work on a
 * downloaded list: a festival roster is tens of thousands of names, which is
 * both an out-of-memory risk on the gateway and a lot of guest PII to ship to
 * a phone standing in a car park.
 */
export const doorGuestListQuerySchema = z
  .object({
    eventId: opaqueIdSchema,
    status: z.enum(['entered', 'not_entered']).optional(),
    source: z.enum(['online', 'door']).optional(),
    search: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();
export type DoorGuestListQuery = z.infer<typeof doorGuestListQuerySchema>;

export const doorGuestListResponseSchema = z.object({
  items: z.array(doorGuestSchema),
  /**
   * True when the roster was larger than the server would scan or return.
   * Door staff searching for a name need to know that "not found" might mean
   * "not looked at" — a silently cut list is how a guest gets turned away.
   */
  truncated: z.boolean(),
});
export type DoorGuestListResponse = z.infer<typeof doorGuestListResponseSchema>;

export const manualCheckInBodySchema = z
  .object({ eventId: opaqueIdSchema, entitlementId: opaqueIdSchema })
  .strict();
export type ManualCheckInBody = z.infer<typeof manualCheckInBodySchema>;

export const manualCheckInResponseSchema = z.object({
  guest: doorGuestSchema,
  checkInId: opaqueIdSchema,
});
export type ManualCheckInResponse = z.infer<typeof manualCheckInResponseSchema>;

// ── Cover wallet at the door (the Scan tab's second mode) ───────────────────

export const coverWalletPresetItemSchema = z.object({
  id: opaqueIdSchema,
  label: z.string(),
  amountPaise: z.number().int().nonnegative(),
  isAvailable: z.boolean(),
});
export type CoverWalletPresetItem = z.infer<typeof coverWalletPresetItemSchema>;

/**
 * What the scanner shows when a guest presents their tab. Deliberately not
 * the whole wallet: a bartender needs to know who this is, what can be rung
 * up, and whether the money is there — not the guest's id, metadata or
 * transaction history.
 */
export const walletChargeViewSchema = z.object({
  walletId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  /** First name only — enough to greet a guest, not to identify them. */
  guestFirstName: z.string(),
  status: z.enum(['active', 'frozen', 'terminated', 'closed']),
  /** Null when the venue has turned balance display off. */
  balancePaise: z.number().int().nonnegative().nullable(),
  presetItems: z.array(coverWalletPresetItemSchema),
  minChargePaise: z.number().int().nonnegative(),
  maxChargePaise: z.number().int().nonnegative(),
});
export type WalletChargeView = z.infer<typeof walletChargeViewSchema>;

export const walletQrResolveBodySchema = z
  .object({ eventId: opaqueIdSchema, qrPayload: z.string().min(1).max(512) })
  .strict();
export type WalletQrResolveBody = z.infer<typeof walletQrResolveBodySchema>;

/**
 * A charge names an ITEM, never an amount — the price comes from the venue's
 * own list. A scanner that could send a number could take ₹5,000 for a ₹500
 * drink, and the guest cannot check the screen before it happens.
 *
 * The tab's QR is re-sent rather than a wallet id, so a charge always follows
 * a tab physically presented at the bar.
 */
export const walletChargeBodySchema = z
  .object({
    eventId: opaqueIdSchema,
    qrPayload: z.string().min(1).max(512),
    presetItemId: opaqueIdSchema,
    quantity: z.number().int().min(1).max(20).default(1),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type WalletChargeBody = z.infer<typeof walletChargeBodySchema>;

export const walletChargeResponseSchema = z.object({
  wallet: walletChargeViewSchema,
  charged: z.object({
    itemId: opaqueIdSchema,
    label: z.string(),
    quantity: z.number().int().positive(),
    amountPaise: z.number().int().nonnegative(),
  }),
  balancePaise: z.number().int().nonnegative(),
});
export type WalletChargeResponse = z.infer<typeof walletChargeResponseSchema>;

// ── Paid walk-up ticket sale ────────────────────────────────────────────────

/**
 * Sell entry to a guest who arrived without a ticket.
 *
 * Note what is absent: any price field. The total is recalculated from the
 * chosen tier — a door sale whose amount the client names is a door sale the
 * client can discount.
 */
export const doorTicketSaleBodySchema = z
  .object({
    eventId: opaqueIdSchema,
    tierId: opaqueIdSchema,
    quantity: z.number().int().min(1).max(20).default(1),
    paymentMode: z.enum(['cash', 'card', 'upi', 'other']),
    guestName: z.string().trim().min(1).max(120),
    guestPhone: z
      .string()
      .regex(/^\d{10}$/, 'Phone must be exactly 10 digits')
      .optional()
      .nullable(),
    guestEmail: z.email().max(254).optional().nullable(),
    guestAge: z.number().int().min(18).max(120).optional().nullable(),
    gender: z.enum(['male', 'female', 'other', 'undisclosed']).optional().nullable(),
    gate: z.string().max(64).optional().nullable(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type DoorTicketSaleBody = z.infer<typeof doorTicketSaleBodySchema>;

export const doorTicketSaleResponseSchema = z.object({
  orderId: opaqueIdSchema,
  amountPaise: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']),
  /** The tickets issued — already admitted, since the guest walked in. */
  ticketIds: z.array(opaqueIdSchema),
  checkInIds: z.array(opaqueIdSchema),
  /** True when a retry replayed an existing sale instead of creating one. */
  replayed: z.boolean(),
});
export type DoorTicketSaleResponse = z.infer<typeof doorTicketSaleResponseSchema>;
