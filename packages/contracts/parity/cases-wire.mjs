/**
 * ─── Contract parity cases: money, tickets, door, sign-in and social ─────────
 * Additional fixtures for `scripts/contract-parity.mjs`, kept apart from
 * `cases.mjs` so the original file stays readable. Same rule as there: every
 * case parses one value with the frontend schema and the backend schema and
 * asserts that both reach the same verdict, and that the verdict is the one
 * the case expects.
 *
 * Why these schemas: they carry money, admission and identity, and several of
 * them were the subject of frontend mirror PRs (checkout attendee, admin
 * finance, offline manifest) — the places where the two copies drift first.
 * Plain ESM, no build step, like `cases.mjs`.
 *
 * @param {object} context
 * @param {(schemaName: string, label: string, value: unknown, expected: boolean) => void} context.agree
 */
export function runWireParityCases({ agree }) {
  const ISO = '2026-10-25T10:00:00.000Z';
  const ID = 'evt_1';
  const SHA = 'a'.repeat(64);

  /** Accept the fixture, then reject each mutation (a field removed or replaced). */
  const matrix = (schema, valid, rejects) => {
    agree(schema, 'accepts the canonical value', valid, true);
    for (const [label, mutate] of rejects) {
      agree(schema, label, mutate({ ...valid }), false);
    }
  };
  const without = (key) => (value) =>
    Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  const withField = (key, replacement) => (value) => ({ ...value, [key]: replacement });
  const extra = withField('unexpected', true);

  /* ── checkout: request bodies ─────────────────────────────────────────────── */
  const line = { tierId: 'tier_1', quantity: 2 };
  matrix('checkoutQuoteRequestSchema', { eventId: ID, lines: [line] }, [
    ['rejects a missing event id', without('eventId')],
    ['rejects an empty line list', withField('lines', [])],
    ['rejects a zero quantity', withField('lines', [{ ...line, quantity: 0 }])],
    ['rejects a quantity above 100', withField('lines', [{ ...line, quantity: 101 }])],
    ['rejects a fractional quantity', withField('lines', [{ ...line, quantity: 1.5 }])],
    ['rejects a malformed tier id', withField('lines', [{ ...line, tierId: '-bad' }])],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'checkoutQuoteRequestSchema',
    'accepts a null promo and referral code',
    { eventId: ID, lines: [line], promoCode: null, referralCode: null },
    true,
  );

  const attendee = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' };
  matrix('checkoutAttendeeSchema', attendee, [
    ['rejects an empty name', withField('name', '   ')],
    ['rejects a name over 120 characters', withField('name', 'x'.repeat(121))],
    ['rejects a malformed email', withField('email', 'not-an-email')],
    ['rejects a phone over 24 characters', withField('phone', '1'.repeat(25))],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'checkoutAttendeeSchema',
    'accepts an attendee without a phone',
    { name: 'Asha Rao', email: 'asha@example.com' },
    true,
  );

  const hold = { eventId: ID, lines: [line], attendee };
  matrix('checkoutHoldRequestSchema', hold, [
    ['rejects an invalid attendee', withField('attendee', { name: '', email: 'x' })],
    ['rejects an empty line list', withField('lines', [])],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'checkoutHoldRequestSchema',
    'accepts a hold without an attendee',
    { eventId: ID, lines: [line] },
    true,
  );

  /* ── checkout: pricing and responses ──────────────────────────────────────── */
  const pricing = {
    lines: [
      {
        tierId: 'tier_1',
        tierName: 'General',
        quantity: 1,
        unitPricePaise: 150000,
        subtotalPaise: 150000,
      },
    ],
    subtotalPaise: 150000,
    discountPaise: 0,
    discountedSubtotalPaise: 150000,
    platformFeePaise: 7500,
    paymentFeePaise: 3750,
    gstPaise: 2025,
    grandTotalPaise: 163275,
    appliedPromoCode: null,
    currency: 'INR',
  };
  matrix('pricingBreakdownDtoSchema', pricing, [
    ['rejects a fractional paise amount', withField('subtotalPaise', 1500.5)],
    ['rejects a negative total', withField('grandTotalPaise', -1)],
    ['rejects a currency that is not 3 letters', withField('currency', 'RUPEE')],
    ['rejects a missing promo field', without('appliedPromoCode')],
  ]);
  agree('checkoutQuoteResponseSchema', 'accepts a pricing breakdown', pricing, true);
  agree(
    'checkoutQuoteResponseSchema',
    'rejects a breakdown without GST',
    (() => {
      const copy = { ...pricing };
      delete copy.gstPaise;
      return copy;
    })(),
    false,
  );

  const holdResponse = {
    holdId: 'HOLD-abc',
    expiresAt: ISO,
    status: 'active',
    pricing,
    convertedOrderId: null,
  };
  matrix('checkoutHoldResponseSchema', holdResponse, [
    ['rejects an unknown status', withField('status', 'paid')],
    ['rejects a non-ISO expiry', withField('expiresAt', 'tomorrow')],
    ['rejects a missing converted order field', without('convertedOrderId')],
  ]);
  for (const status of ['active', 'converted', 'released']) {
    agree('cartReservationStatusSchema', `accepts ${status}`, status, true);
  }
  agree('cartReservationStatusSchema', 'rejects expired', 'expired', false);

  /* ── payments ─────────────────────────────────────────────────────────────── */
  matrix('paymentAttemptRequestSchema', { holdId: 'HOLD-abc' }, [
    ['rejects a missing hold id', without('holdId')],
    ['rejects an unknown key (strict)', extra],
  ]);
  matrix(
    'paymentAttemptResponseSchema',
    { paymentIntentId: 'order_1', amountPaise: 163275, keyId: 'key_public' },
    [
      ['rejects an empty intent id', withField('paymentIntentId', '')],
      ['rejects a negative amount', withField('amountPaise', -5)],
    ],
  );
  agree(
    'paymentAttemptResponseSchema',
    'accepts a response without a key id',
    { paymentIntentId: 'order_1', amountPaise: 163275 },
    true,
  );
  matrix(
    'paymentConfirmRequestSchema',
    { holdId: 'HOLD-abc', paymentIntentId: 'order_1', signature: 'sig' },
    [
      ['rejects a missing signature', without('signature')],
      ['rejects an empty signature', withField('signature', '')],
      ['rejects an unknown key (strict)', extra],
    ],
  );
  const recovery = {
    holdId: 'HOLD-abc',
    eventId: ID,
    status: 'fulfilled',
    orderId: 'order_1',
    expiresAt: ISO,
    updatedAt: ISO,
  };
  matrix('paymentRecoveryResponseSchema', recovery, [
    ['rejects an unknown status', withField('status', 'paid')],
    ['rejects a missing order field', without('orderId')],
    ['rejects a non-ISO update time', withField('updatedAt', 'yesterday')],
  ]);
  for (const status of [
    'pending',
    'processing',
    'fulfilled',
    'failed',
    'cancelled',
    'expired',
    'refunded',
    'requires_support',
  ]) {
    agree(
      'paymentRecoveryResponseSchema',
      `accepts the ${status} status`,
      { ...recovery, status },
      true,
    );
  }

  /* ── orders, tickets and RSVP ─────────────────────────────────────────────── */
  const order = {
    id: 'order_1',
    eventId: ID,
    organizationId: 'org_1',
    userId: 'user_1',
    status: 'paid',
    lines: [
      {
        tierId: 'tier_1',
        tierName: 'General',
        quantity: 1,
        unitPricePaise: 150000,
        subtotalPaise: 150000,
      },
    ],
    currency: 'INR',
    subtotalPaise: 150000,
    discountPaise: 0,
    discountedSubtotalPaise: 150000,
    platformFeePaise: 7500,
    paymentFeePaise: 3750,
    gstPaise: 2025,
    grandTotalPaise: 163275,
    appliedPromoCode: null,
    paymentIntentId: 'order_rzp_1',
    paymentId: 'pay_1',
    paidAt: ISO,
    reservationExpiresAt: ISO,
    failureReason: null,
    refundedPaise: 0,
    version: 2,
    createdAt: ISO,
    updatedAt: ISO,
  };
  matrix('checkoutOrderDtoSchema', order, [
    ['rejects an unknown status', withField('status', 'complete')],
    ['rejects a zero version', withField('version', 0)],
    ['rejects a fractional refund amount', withField('refundedPaise', 0.5)],
    ['rejects a missing payment id field', without('paymentId')],
  ]);
  agree('orderDtoSchema', 'accepts the canonical order', order, true);
  for (const status of [
    'pending',
    'awaiting_payment',
    'paid',
    'expired',
    'cancelled',
    'failed',
    'refund_requested',
    'refunded',
  ]) {
    // `orderStatusSchema` itself is not exported by the client entry on either
    // side, so the status set is pinned through the order DTO that uses it.
    agree('orderDtoSchema', `accepts the ${status} order status`, { ...order, status }, true);
  }
  agree(
    'orderStatusResponseSchema',
    'accepts the slim status projection',
    { id: 'order_1', status: 'paid', version: 2, updatedAt: ISO },
    true,
  );
  agree(
    'orderStatusResponseSchema',
    'rejects a zero version',
    { id: 'order_1', status: 'paid', version: 0, updatedAt: ISO },
    false,
  );

  const entitlement = {
    id: 'ent_1',
    orderId: 'order_1',
    eventId: ID,
    organizationId: 'org_1',
    tierId: 'tier_1',
    tierName: 'General',
    userId: 'user_1',
    holderName: 'Asha Rao',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
  };
  matrix('entitlementDtoSchema', entitlement, [
    ['rejects an unknown status', withField('status', 'used')],
    ['rejects a zero scan allowance', withField('scanCountAllowed', 0)],
    ['rejects a negative scan count', withField('scanCount', -1)],
    ['rejects a non-ISO scan time', withField('scannedAt', ['today'])],
  ]);
  agree(
    'paymentConfirmResponseSchema',
    'accepts an order with its tickets',
    { order, entitlements: [entitlement] },
    true,
  );
  agree('paymentConfirmResponseSchema', 'rejects a response without tickets', { order }, false);
  agree(
    'rsvpResponseSchema',
    'accepts an RSVP order with its tickets',
    { order, entitlements: [entitlement] },
    true,
  );
  matrix('rsvpRequestSchema', { eventId: ID, tierId: 'tier_1' }, [
    ['rejects a missing tier', without('tierId')],
    ['rejects a quantity field (not allowed on RSVP)', withField('quantity', 2)],
  ]);

  /* ── sign-in helpers: OTP and guest profile ───────────────────────────────── */
  matrix('otpSendRequestSchema', { email: 'asha@example.com' }, [
    ['rejects a malformed email', withField('email', 'asha')],
    ['rejects an unknown key (strict)', extra],
  ]);
  matrix('otpVerifyRequestSchema', { email: 'asha@example.com', code: '123456' }, [
    ['rejects a five digit code', withField('code', '12345')],
    ['rejects a seven digit code', withField('code', '1234567')],
    ['rejects a code with letters', withField('code', '12345a')],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree('otpAckResponseSchema', 'accepts an acknowledgement', { message: 'Verified.' }, true);
  agree('otpAckResponseSchema', 'rejects a missing message', {}, false);

  const profile = {
    displayName: 'Asha',
    dateOfBirth: '1998-04-02',
    city: 'Mumbai',
    tastes: ['techno', 'house', 'jazz'],
    intents: ['dance'],
  };
  matrix('upsertGuestProfileSchema', profile, [
    ['rejects fewer than 3 tastes', withField('tastes', ['techno', 'house'])],
    [
      'rejects more than 20 tastes',
      withField(
        'tastes',
        Array.from({ length: 21 }, (_, i) => `t${i}`),
      ),
    ],
    ['rejects no intents', withField('intents', [])],
    ['rejects a date that is not YYYY-MM-DD', withField('dateOfBirth', '02/04/1998')],
    ['rejects an empty city', withField('city', '')],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'guestProfileDtoSchema',
    'accepts a stored profile',
    { userId: 'user_1', ...profile, createdAt: ISO, updatedAt: ISO },
    true,
  );
  agree(
    'guestProfileDtoSchema',
    'rejects a profile with fewer than 3 tastes',
    { userId: 'user_1', ...profile, tastes: ['a'], createdAt: ISO, updatedAt: ISO },
    false,
  );

  /* ── follows and notifications ────────────────────────────────────────────── */
  matrix('createFollowSchema', { targetType: 'venue', targetId: 'ven_1' }, [
    ['rejects an unknown target type', withField('targetType', 'promoter')],
    ['rejects a malformed target id', withField('targetId', '/x')],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree('followTargetTypeSchema', 'accepts host', 'host', true);
  agree('followTargetTypeSchema', 'rejects user', 'user', false);
  agree(
    'followStatusDtoSchema',
    'accepts a follow status',
    { following: true, followerCount: 3 },
    true,
  );
  agree(
    'followStatusDtoSchema',
    'rejects a negative follower count',
    { following: true, followerCount: -1 },
    false,
  );
  const notification = {
    id: 'user_1__event.new_from_followed__evt_1',
    type: 'event.new_from_followed',
    title: 'New event: Neon Nights',
    body: 'A venue you follow just published a new event.',
    link: '/event/neon-nights',
    subjectId: ID,
    createdAt: ISO,
    readAt: null,
  };
  matrix(
    // Exported under this alias: the plain `notificationDtoSchema` name belongs to
    // the partner organisation inbox (see the aliasing note in `client.ts`).
    'socialNotificationDtoSchema',
    notification,
    [
      ['rejects an unknown type', withField('type', 'event.cancelled')],
      ['rejects an empty title', withField('title', '')],
      ['rejects a body over 1000 characters', withField('body', 'x'.repeat(1001))],
      ['rejects a missing read time field', without('readAt')],
    ],
  );
  matrix('markNotificationsReadSchema', { ids: ['n1'] }, [
    ['rejects an empty id list', withField('ids', [])],
    [
      'rejects more than 100 ids',
      withField(
        'ids',
        Array.from({ length: 101 }, (_, i) => `n${i}`),
      ),
    ],
    ['rejects an unknown key (strict)', extra],
  ]);

  /* ── finance: partner side ────────────────────────────────────────────────── */
  matrix('payoutRequestSchema', { amountPaise: 50000, idempotencyKey: 'key-123456' }, [
    ['rejects a zero amount', withField('amountPaise', 0)],
    ['rejects a fractional amount', withField('amountPaise', 100.5)],
    ['rejects a missing idempotency key', without('idempotencyKey')],
    ['rejects an idempotency key with a space', withField('idempotencyKey', 'bad key')],
    ['rejects an unknown key (strict)', extra],
  ]);
  matrix(
    'bankAccountRequestSchema',
    {
      bankName: 'HDFC Bank',
      accountHolder: 'Asha Rao',
      accountNumber: '123456789012',
      ifscCode: 'HDFC0001234',
    },
    [
      ['rejects a lowercase IFSC', withField('ifscCode', 'hdfc0001234')],
      ['rejects an IFSC without the zero', withField('ifscCode', 'HDFC1001234')],
      ['rejects an account number under 4 characters', withField('accountNumber', '123')],
      ['rejects an account number over 34 characters', withField('accountNumber', '1'.repeat(35))],
      ['rejects an unknown key (strict)', extra],
    ],
  );
  const balance = {
    availablePaise: 0,
    pendingPaise: 100,
    reservedPaise: 0,
    heldPaise: 0,
    paidPaise: 0,
    lifetimePaise: 100,
    holds: { reservePaise: 0, cancellationPaise: 0, chargebackPaise: 0, reconciliationPaise: 0 },
    readModel: 'legacy_ledger_v1',
  };
  matrix('balanceSummaryResponseSchema', balance, [
    ['rejects an unknown read model', withField('readModel', 'v3')],
    ['rejects a negative pending amount', withField('pendingPaise', -1)],
    ['rejects a missing holds block', without('holds')],
  ]);
  agree(
    'balanceSummaryResponseSchema',
    'accepts a negative available balance',
    { ...balance, availablePaise: -500 },
    true,
  );
  const payout = {
    id: 'pay_out_1',
    organizationId: 'org_1',
    bankAccountId: 'bank_1',
    amountPaise: 50000,
    status: 'requested',
    failureReason: null,
    processedAt: null,
    transferReference: null,
    transferredAt: null,
    transferMethod: null,
    transferProof: null,
    approvedBy: null,
    createdAt: ISO,
  };
  matrix('payoutResponseSchema', payout, [
    ['rejects an unknown status', withField('status', 'approved')],
    ['rejects a zero amount', withField('amountPaise', 0)],
    [
      'rejects an uppercase proof hash',
      withField('transferProof', {
        sha256: 'A'.repeat(64),
        contentType: 'image/png',
        sizeBytes: 1,
      }),
    ],
  ]);
  for (const status of ['requested', 'processing', 'paid', 'failed', 'frozen']) {
    agree('payoutResponseSchema', `accepts the ${status} status`, { ...payout, status }, true);
  }

  /* ── finance: admin side ──────────────────────────────────────────────────── */
  const complete = {
    transferReference: 'UTR123',
    transferredAt: ISO,
    transferMethod: 'neft',
    proof: { sha256: SHA, contentType: 'application/pdf', sizeBytes: 2048 },
  };
  matrix('completeManualPayoutSchema', complete, [
    ['rejects a blank transfer reference', withField('transferReference', '   ')],
    ['rejects an unknown transfer method', withField('transferMethod', 'cheque')],
    ['rejects a short proof hash', withField('proof', { ...complete.proof, sha256: 'abc' })],
    ['rejects a zero proof size', withField('proof', { ...complete.proof, sizeBytes: 0 })],
    ['rejects a non-ISO transfer time', withField('transferredAt', '25/10/2026')],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'completeManualPayoutSchema',
    'accepts an uppercase proof hash',
    { ...complete, proof: { ...complete.proof, sha256: SHA.toUpperCase() } },
    true,
  );
  matrix(
    'raiseDisputeRequestSchema',
    { orderId: 'order_1', reason: 'Chargeback notice', amountPaise: 150000 },
    [
      ['rejects an empty reason', withField('reason', '')],
      ['rejects a zero amount', withField('amountPaise', 0)],
      ['rejects a missing order', without('orderId')],
      ['rejects an unknown key (strict)', extra],
    ],
  );
  matrix('adminResolveDisputeSchema', { outcome: 'upheld', resolutionNote: 'Evidence confirmed' }, [
    ['rejects an unknown outcome', withField('outcome', 'partial')],
    ['rejects an empty note', withField('resolutionNote', '')],
    ['rejects an unknown key (strict)', extra],
  ]);
  matrix(
    'proposeActionSchema',
    {
      action: 'FINANCIAL_ADJUSTMENT',
      reason: 'Correct a duplicate payout',
      payload: { amountPaise: 100 },
    },
    [
      ['rejects an unknown action', withField('action', 'DELETE_EVERYTHING')],
      ['rejects an empty reason', withField('reason', '')],
      ['rejects a reason over 2000 characters', withField('reason', 'x'.repeat(2001))],
      ['rejects an unknown key (strict)', extra],
    ],
  );
  agree(
    'proposeActionSchema',
    'accepts a proposal without a payload',
    { action: 'USER_BAN', reason: 'Abuse reports' },
    true,
  );

  /* ── door: walk-in, ticket sale, check-in, override ───────────────────────── */
  const walkIn = {
    eventId: ID,
    guestName: 'Ravi',
    guestPhone: '9876543210',
    guestAge: 25,
    gender: 'male',
    guestEmail: 'ravi@example.com',
    totalGuests: 2,
    gate: 'A',
    paymentMode: 'cash',
    idempotencyKey: 'walkin-123456',
  };
  matrix('doorWalkInRequestSchema', walkIn, [
    ['rejects a phone with 9 digits', withField('guestPhone', '987654321')],
    ['rejects a phone with a plus sign', withField('guestPhone', '+919876543210')],
    ['rejects an under-18 guest', withField('guestAge', 17)],
    ['rejects an over-120 age', withField('guestAge', 121)],
    ['rejects an unknown gender value', withField('gender', 'x')],
    ['rejects zero guests', withField('totalGuests', 0)],
    ['rejects more than 100 guests', withField('totalGuests', 101)],
    ['rejects an unknown payment mode', withField('paymentMode', 'crypto')],
    ['rejects a blank name', withField('guestName', '   ')],
    ['rejects a missing idempotency key', without('idempotencyKey')],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'doorWalkInRequestSchema',
    'accepts null optional guest details',
    { ...walkIn, guestPhone: null, guestAge: null, gender: null, guestEmail: null, gate: null },
    true,
  );
  matrix('doorDineInRequestSchema', { ...walkIn, tableNumber: 'T12' }, [
    ['rejects a table number over 32 characters', withField('tableNumber', 'x'.repeat(33))],
    ['rejects an unknown key (strict)', extra],
  ]);
  const sale = {
    eventId: ID,
    tierId: 'tier_1',
    quantity: 2,
    paymentMode: 'upi',
    guestName: 'Ravi',
    idempotencyKey: 'sale-123456',
  };
  matrix('doorTicketSaleBodySchema', sale, [
    ['rejects zero quantity', withField('quantity', 0)],
    ['rejects more than 20 tickets', withField('quantity', 21)],
    ['rejects a missing payment mode', without('paymentMode')],
    ['rejects a client-supplied price (no price field exists)', withField('pricePaise', 1)],
    ['rejects a missing idempotency key', without('idempotencyKey')],
  ]);
  matrix('manualCheckInBodySchema', { eventId: ID, entitlementId: 'ent_1' }, [
    ['rejects a missing entitlement', without('entitlementId')],
    ['rejects an unknown key (strict)', extra],
  ]);
  matrix('overrideRequestSchema', { checkInId: 'ci_1', reason: 'Manager approved' }, [
    ['rejects an empty reason', withField('reason', '')],
    ['rejects a missing check-in', without('checkInId')],
    ['rejects an unknown key (strict)', extra],
  ]);
  matrix('magicQrRequestSchema', { entitlementId: 'ent_1', tierPricePaise: 0 }, [
    ['rejects a negative price', withField('tierPricePaise', -1)],
    ['rejects a missing entitlement', without('entitlementId')],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'magicQrResponseSchema',
    'accepts a QR response',
    { qrPayload: 'ent_1:123:abc', expiresAt: ISO, refreshIntervalSec: 30 },
    true,
  );
  agree(
    'magicQrResponseSchema',
    'rejects a non-ISO expiry',
    { qrPayload: 'ent_1:123:abc', expiresAt: 'soon', refreshIntervalSec: 30 },
    false,
  );
  matrix(
    'eventCodeCreateBodySchema',
    { type: 'full', gate: 'A', maxDevices: 5, allowReuse: true, expiresAt: ISO },
    [
      ['rejects an unknown code type', withField('type', 'admin')],
      ['rejects zero devices', withField('maxDevices', 0)],
      ['rejects more than 100 devices', withField('maxDevices', 101)],
      ['rejects an empty gate string', withField('gate', '')],
      ['rejects an unknown key (strict)', extra],
    ],
  );

  /* ── offline scanning ─────────────────────────────────────────────────────── */
  matrix('offlineManifestRequestSchema', { eventId: ID }, [
    ['rejects a missing event id', without('eventId')],
    ['rejects an unknown key (strict)', extra],
  ]);
  const scan = { payload: 'ent_1:123:abc', scannedAt: ISO, deviceId: 'scanner_1' };
  matrix('offlineSyncRequestSchema', { eventId: ID, scans: [scan] }, [
    ['rejects an empty scan list', withField('scans', [])],
    [
      'rejects more than 500 scans',
      withField(
        'scans',
        Array.from({ length: 501 }, () => scan),
      ),
    ],
    ['rejects a scan without a device id', withField('scans', [{ payload: 'x', scannedAt: ISO }])],
    ['rejects a scan with a non-ISO time', withField('scans', [{ ...scan, scannedAt: 'now' }])],
    [
      'rejects a payload over 512 characters',
      withField('scans', [{ ...scan, payload: 'x'.repeat(513) }]),
    ],
    ['rejects an unknown key (strict)', extra],
  ]);
  agree(
    'offlineSyncResponseSchema',
    'accepts a sync result with a conflict',
    { synced: 3, conflicts: [{ payload: 'ent_1:1:a', reason: 'already_scanned' }] },
    true,
  );
  agree(
    'offlineSyncResponseSchema',
    'rejects a conflict without a reason',
    { synced: 1, conflicts: [{ payload: 'x' }] },
    false,
  );
  const manifest = {
    version: 1,
    eventId: ID,
    manifest: [
      {
        entitlementId: 'ent_1',
        validFrom: ISO,
        validTo: ISO,
        seatsRemaining: 2,
        ticketKey: 'f'.repeat(64),
      },
    ],
    signedAt: ISO,
    expiresAt: ISO,
    keyId: 'key-1',
    publicKey: 'cHVibGlj',
    manifestSignature: 'c2lnbmF0dXJl',
  };
  matrix('offlineManifestResponseSchema', manifest, [
    ['rejects a format version other than 1', withField('version', 2)],
    [
      'rejects a ticket key that is not 64 hex characters',
      withField('manifest', [{ ...manifest.manifest[0], ticketKey: 'abc' }]),
    ],
    [
      'rejects an uppercase ticket key',
      withField('manifest', [{ ...manifest.manifest[0], ticketKey: 'F'.repeat(64) }]),
    ],
    [
      'rejects zero seats remaining',
      withField('manifest', [{ ...manifest.manifest[0], seatsRemaining: 0 }]),
    ],
    ['rejects a missing signature', without('manifestSignature')],
    ['rejects an empty key id', withField('keyId', '')],
  ]);
}
