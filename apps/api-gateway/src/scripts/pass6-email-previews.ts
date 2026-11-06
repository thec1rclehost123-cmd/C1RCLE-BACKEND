import { mkdir, writeFile } from 'node:fs/promises';

import { createTransactionalEmailConsumer } from '@c1rcle/core/application';
import { PermanentEmailDeliveryError } from '@c1rcle/core/domain';

import type { ServiceDeps } from '@c1rcle/core/application';
import type { TransactionalEmail } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../config/index.js';
import { escapeMarkdownLabel, extractPrimaryLabel } from '../lib/email-preview-label.js';
import { ResendEmailSender } from '../lib/notifications/resend-email-sender.js';

const ROOT = new URL('../../../../docs/pass6/previews/', import.meta.url);
const INDEX_PATH = new URL('../EMAIL_DESIGN_VISUAL_ACCEPTANCE.md', ROOT);
const ACCEPTANCE_RECIPIENT = 'aayushdivase2020333@gmail.com';
const PREVIEW_RECIPIENT = 'preview.guest@synthetic.test';
const SENDER = 'THE C1RCLE <hello@thec1rcle.com>';
const FIXED_NOW = new Date('2026-06-01T10:00:00.000Z');
const EVENT_START = '2026-07-18T15:30:00.000Z';
const nowMs = FIXED_NOW.getTime();
const dryRun = process.argv.includes('--dry-run');
const v2DryRun = process.argv.includes('--dry-run-v2');
const sendV2Acceptance = process.argv.includes('--send-v2-acceptance');
const retryV2First = process.argv.includes('--retry-v2-first');
const sendV2Remaining = process.argv.includes('--send-v2-remaining');
const sendAcceptance = process.argv.includes('--send-acceptance');
const requestedRecipient =
  dryRun || v2DryRun || sendV2Acceptance || retryV2First || sendV2Remaining || sendAcceptance
    ? ACCEPTANCE_RECIPIENT
    : PREVIEW_RECIPIENT;
const v2Files = new Set([
  'purchase-confirmation',
  'ticket-assignment-invitation',
  'kyc-host-changes-requested',
  'kyc-host-approved',
  'refund-completed',
  'event-cancelled',
]);

interface Fixture {
  variant: string;
  file: string;
  type: string;
  payload: Record<string, unknown>;
  eventTitle?: string;
  kycRole?: 'host' | 'venue' | 'promoter';
  kycStatus?: 'submitted' | 'changes_requested' | 'approved' | 'rejected';
  eventCancelled?: boolean;
  omitPoster?: boolean;
  captureVariants?: string[];
  captureFiles?: string[];
}

const fixtures: Fixture[] = [
  {
    variant: 'Purchase confirmation / receipt',
    file: 'purchase-confirmation',
    type: 'order.fulfilled',
    payload: { orderId: 'ORD-SYNTHETIC-RECEIPT', eventId: 'EVT-SYNTHETIC-NEON' },
  },
  {
    variant: 'Ticket invitation',
    file: 'ticket-assignment-invitation',
    type: 'ticket.transfer.created',
    payload: { transferId: 'TRANSFER-SYNTHETIC-INVITE' },
  },
  {
    variant: 'Transfer accepted — new holder',
    file: 'transfer-accepted-new-holder',
    type: 'ticket.transfer.resolved',
    payload: {
      transferId: 'TRANSFER-SYNTHETIC-ACCEPTED',
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      eventId: 'EVT-SYNTHETIC-NEON',
      status: 'accepted',
      credentialVersion: 3,
    },
    captureVariants: ['Transfer accepted — new holder', 'Transfer accepted — former holder'],
    captureFiles: ['transfer-accepted-new-holder', 'transfer-accepted-former-holder'],
  },
  {
    variant: 'Transfer invitation expired',
    file: 'transfer-expired',
    type: 'ticket.transfer.resolved',
    payload: {
      transferId: 'TRANSFER-SYNTHETIC-EXPIRED',
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      eventId: 'EVT-SYNTHETIC-NEON',
      status: 'expired',
      credentialVersion: 3,
    },
  },
  {
    variant: 'RSVP confirmation',
    file: 'rsvp-confirmation',
    type: 'order.fulfilled',
    payload: { orderId: 'ORD-SYNTHETIC-RSVP', eventId: 'EVT-SYNTHETIC-NEON' },
  },
  {
    variant: 'Ticket issued to current holder',
    file: 'ticket-issued-to-holder',
    type: 'ticket.issued',
    payload: {
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      orderId: 'ORD-SYNTHETIC-TICKET',
      eventId: 'EVT-SYNTHETIC-NEON',
      purchaserUserId: 'USR-SYNTHETIC-PURCHASER',
      holderUserId: 'USR-SYNTHETIC-HOLDER',
    },
  },
  {
    variant: 'Ticket upgrade confirmed',
    file: 'ticket-upgrade-confirmed',
    type: 'ticket.issued',
    payload: {
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      orderId: 'ORD-SYNTHETIC-TICKET',
      eventId: 'EVT-SYNTHETIC-NEON',
      purchaserUserId: 'USR-SYNTHETIC-PURCHASER',
      holderUserId: 'USR-SYNTHETIC-HOLDER',
      upgradeFromEntitlementId: 'ENT-SYNTHETIC-ORIGINAL',
    },
  },
  {
    variant: 'Promoter assignment invited',
    file: 'promoter-assignment-invited',
    type: 'promoter.assignment.invited',
    payload: {
      assignmentId: 'ASSIGNMENT-SYNTHETIC',
      eventId: 'EVT-SYNTHETIC-NEON',
      promoterId: 'ORG-SYNTHETIC-PROMOTER',
      eventTitle: 'Neon Nights: Afrobeats Edition',
    },
  },
  {
    variant: 'Promoter assignment accepted',
    file: 'promoter-assignment-accepted',
    type: 'promoter.assignment.accepted',
    payload: {
      assignmentId: 'ASSIGNMENT-SYNTHETIC',
      eventId: 'EVT-SYNTHETIC-NEON',
      promoterId: 'ORG-SYNTHETIC-PROMOTER',
      eventOwnerId: 'ORG-SYNTHETIC-HOST',
      eventOwnerType: 'host',
      eventTitle: 'Neon Nights: Afrobeats Edition',
    },
  },
  {
    variant: 'Promoter assignment declined',
    file: 'promoter-assignment-declined',
    type: 'promoter.assignment.rejected',
    payload: {
      assignmentId: 'ASSIGNMENT-SYNTHETIC',
      eventId: 'EVT-SYNTHETIC-NEON',
      promoterId: 'ORG-SYNTHETIC-PROMOTER',
      eventOwnerId: 'ORG-SYNTHETIC-HOST',
      eventOwnerType: 'host',
      eventTitle: 'Neon Nights: Afrobeats Edition',
    },
  },
  {
    variant: 'Promoter assignment revoked',
    file: 'promoter-assignment-revoked',
    type: 'promoter.assignment.revoked',
    payload: {
      assignmentId: 'ASSIGNMENT-SYNTHETIC',
      eventId: 'EVT-SYNTHETIC-NEON',
      promoterId: 'ORG-SYNTHETIC-PROMOTER',
      eventTitle: 'Neon Nights: Afrobeats Edition',
    },
  },
  {
    variant: 'Promoter assignment expired',
    file: 'promoter-assignment-expired',
    type: 'promoter.assignment.expired',
    payload: {
      assignmentId: 'ASSIGNMENT-SYNTHETIC',
      eventId: 'EVT-SYNTHETIC-NEON',
      promoterId: 'ORG-SYNTHETIC-PROMOTER',
      eventTitle: 'Neon Nights: Afrobeats Edition',
      expiresAt: '2026-06-01T09:00:00.000Z',
    },
  },
  {
    variant: 'Promoter assignments suspended',
    file: 'promoter-assignments-suspended',
    type: 'promoter.assignments.status_changed',
    payload: { promoterId: 'ORG-SYNTHETIC-PROMOTER', status: 'suspended', affectedAssignments: 3 },
  },
  {
    variant: 'Event cover redeemed',
    file: 'event-cover-redeemed',
    type: 'event-cover.redeemed',
    payload: {
      accountId: 'COVER-SYNTHETIC',
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      eventId: 'EVT-SYNTHETIC-NEON',
      operationId: 'COVER-OP-SYNTHETIC',
      venueOrganizationId: 'ORG-SYNTHETIC-VENUE',
      amountPaise: 50000,
    },
  },
  {
    variant: 'Event cover reversed',
    file: 'event-cover-reversed',
    type: 'event-cover.reversed',
    payload: {
      accountId: 'COVER-SYNTHETIC',
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      eventId: 'EVT-SYNTHETIC-NEON',
      operationId: 'COVER-OP-SYNTHETIC',
      venueOrganizationId: 'ORG-SYNTHETIC-VENUE',
      amountPaise: 50000,
    },
  },
  {
    variant: 'Event cover refunded',
    file: 'event-cover-refunded',
    type: 'event-cover.refunded',
    payload: {
      accountId: 'COVER-SYNTHETIC',
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      orderId: 'ORD-SYNTHETIC-TICKET',
      eventId: 'EVT-SYNTHETIC-NEON',
      operationId: 'COVER-OP-SYNTHETIC',
      venueOrganizationId: 'ORG-SYNTHETIC-VENUE',
      amountPaise: 50000,
      policyVersion: 'synthetic-v1',
    },
  },
  {
    variant: 'Ticket add-on redeemed',
    file: 'ticket-addon-redeemed',
    type: 'ticket.addon.redeemed',
    payload: {
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      addonEntitlementId: 'ADDON-ENTITLEMENT-SYNTHETIC',
      addonId: 'ADDON-SYNTHETIC',
      eventId: 'EVT-SYNTHETIC-NEON',
    },
  },
  {
    variant: 'Refund completed',
    file: 'refund-completed',
    type: 'finance.refund.settled',
    payload: {
      orderId: 'ORD-SYNTHETIC-REFUND',
      refundRequestId: 'REFUND-SYNTHETIC',
      amountPaise: 125000,
    },
  },
  {
    variant: 'Refund declined / rejected',
    file: 'refund-declined',
    type: 'finance.refund.finalized',
    payload: {
      orderId: 'ORD-SYNTHETIC-REFUND',
      refundRequestId: 'REFUND-SYNTHETIC',
      status: 'rejected',
    },
  },
  {
    variant: 'Event cancelled',
    file: 'event-cancelled',
    type: 'event.cancellation.email_requested',
    payload: {
      eventId: 'EVT-SYNTHETIC-NEON',
      orderId: 'ORD-SYNTHETIC-CANCEL',
      entitlementId: null,
      eventVersion: 4,
      reason: 'Synthetic cancellation fixture.',
    },
    eventCancelled: true,
  },
  {
    variant: 'Event postponed — date TBA',
    file: 'event-postponed',
    type: 'event.material_change.order_affected',
    payload: {
      eventId: 'EVT-SYNTHETIC-NEON',
      orderId: 'ORD-SYNTHETIC-CHANGE',
      eventVersion: 5,
      changeType: 'postponed',
      previousTitle: 'Neon Nights: Afrobeats Edition',
      title: 'Neon Nights: Afrobeats Edition',
      previousStartAt: EVENT_START,
      startAt: EVENT_START,
      previousVenueId: 'VENUE-SYNTHETIC-OLD',
      venueId: 'VENUE-SYNTHETIC-NEW',
    },
  },
  {
    variant: 'Material event change',
    file: 'event-material-change',
    type: 'event.material_change.order_affected',
    payload: {
      eventId: 'EVT-SYNTHETIC-NEON',
      orderId: 'ORD-SYNTHETIC-CHANGE',
      eventVersion: 6,
      previousTitle: 'Neon Nights: Afrobeats Edition',
      title: 'Neon Nights: Afrobeats Edition · Late Set',
      previousStartAt: EVENT_START,
      startAt: EVENT_START,
    },
    eventTitle: 'Neon Nights & Late Sets: <After Dark> — Synthetic Acceptance Edition',
    omitPoster: true,
  },
  {
    variant: 'Event rescheduled',
    file: 'event-rescheduled',
    type: 'event.material_change.order_affected',
    payload: {
      eventId: 'EVT-SYNTHETIC-NEON',
      orderId: 'ORD-SYNTHETIC-CHANGE',
      eventVersion: 7,
      changeType: 'rescheduled',
      previousTitle: 'Neon Nights: Afrobeats Edition',
      title: 'Neon Nights: Afrobeats Edition',
      previousStartAt: '2026-07-18T15:30:00.000Z',
      startAt: '2026-07-19T15:30:00.000Z',
    },
  },
  {
    variant: 'Venue change',
    file: 'event-venue-change',
    type: 'event.material_change.order_affected',
    payload: {
      eventId: 'EVT-SYNTHETIC-NEON',
      orderId: 'ORD-SYNTHETIC-CHANGE',
      eventVersion: 8,
      previousTitle: 'Neon Nights: Afrobeats Edition',
      title: 'Neon Nights: Afrobeats Edition',
      previousStartAt: EVENT_START,
      startAt: EVENT_START,
      previousVenueId: 'VENUE-SYNTHETIC-OLD',
      venueId: 'VENUE-SYNTHETIC-NEW',
    },
  },
  {
    variant: 'Refund review requested',
    file: 'refund-review-requested',
    type: 'event.material_change.refund_requested',
    payload: {
      eventId: 'EVT-SYNTHETIC-NEON',
      orderId: 'ORD-SYNTHETIC-REFUND',
      entitlementId: 'ENT-SYNTHETIC-TICKET',
      eventVersion: 9,
    },
  },
  {
    variant: 'Payment support required',
    file: 'payment-support-required',
    type: 'payment.support_required',
    payload: {
      paymentId: 'PAYMENT-SYNTHETIC-INTERNAL',
      holdId: 'HOLD-SYNTHETIC',
      organizationId: 'ORG-SYNTHETIC-HOST',
      stateVersion: 2,
    },
  },
  ...(['requested', 'processing', 'paid', 'failed'] as const).map((status) => ({
    variant: `Payout ${status === 'paid' ? 'completed' : status}`,
    file: status === 'paid' ? 'payout-paid' : `payout-${status}`,
    type: 'finance.payout.status_changed',
    payload: {
      payoutId: 'PAYOUT-SYNTHETIC',
      organizationId: 'ORG-SYNTHETIC-HOST',
      status,
      version: { requested: 1, processing: 2, paid: 3, failed: 4 }[status],
      amountPaise: 250000,
      refundRequestId: null,
      reason: 'Synthetic acceptance fixture.',
    },
  })),
  ...(['submitted', 'changes_requested', 'approved', 'rejected'] as const).flatMap((status) =>
    (['host', 'venue', 'promoter'] as const).map((role) => ({
      variant: `${role.charAt(0).toUpperCase()}${role.slice(1)} application ${status.replace('_', ' ')}`,
      file: `kyc-${role}-${status.replace('_', '-')}`,
      type: 'partner.onboarding.email_requested',
      payload: { requestId: `ONBOARDING-SYNTHETIC-${role}`, status },
      kycRole: role,
      kycStatus: status,
    })),
  ),
];

const eventVariants = new Set([
  'booking_receipt',
  'rsvp_confirmation',
  'ticket_transfer_invitation',
  'ticket_transfer_former_holder',
  'ticket_transfer_expired',
  'ticket_transfer_accepted',
  'ticket_issued_to_holder',
  'ticket_upgrade_confirmed',
  'event_cancelled',
  'event_material_change',
]);

function createMemoryDeliveryRepository() {
  interface MemoryDelivery {
    id: string;
    status: string;
    retryCount: number;
    updatedAt: number;
    [key: string]: unknown;
  }
  const records = new Map<string, MemoryDelivery>();
  return {
    async createIfAbsent(row: MemoryDelivery) {
      const current = records.get(row.id);
      if (current) return current;
      records.set(row.id, row);
      return row;
    },
    async claim(id: string, _now: number, leaseExpiresAt: number) {
      const current = records.get(id);
      if (!current) return false;
      records.set(id, {
        ...current,
        status: 'sending',
        retryCount: (current.retryCount ?? 0) + 1,
        leaseExpiresAt,
      });
      return true;
    },
    async get(id: string) {
      return records.get(id) ?? null;
    },
    async markCaptured(id: string, now: number) {
      const current = records.get(id);
      if (current) records.set(id, { ...current, status: 'captured', updatedAt: now });
    },
    records,
  };
}

function syntheticRows(fixture: Fixture, recipient: string) {
  const event = {
    id: 'EVT-SYNTHETIC-NEON',
    organizationId: 'ORG-SYNTHETIC-HOST',
    venueId: 'VENUE-SYNTHETIC-NEW',
    slug: 'neon-nights-afrobeats-edition',
    title: fixture.eventTitle ?? 'Neon Nights: Afrobeats Edition',
    summary: 'Synthetic event fixture.',
    description: 'Synthetic event fixture.',
    imageUrl: fixture.omitPoster
      ? null
      : 'https://c1-rcle-frontend-partner-dashboard.vercel.app/partner-v3/venue/neon-nights-poster.jpg',
    startAt: EVENT_START,
    endAt: '2026-07-18T19:00:00.000Z',
    status: fixture.eventCancelled ? 'cancelled' : 'published',
    isPublic: true,
    tags: [],
    startingPricePaise: 180000,
    isFree: false,
    cancellationReason: null,
    capacity: null,
    adminOverride: false,
  };
  const venue = (id: string) => ({
    id,
    public: {
      name: id === 'VENUE-SYNTHETIC-OLD' ? 'The Old Warehouse' : 'Skyline Rooftop',
      address: {
        street: 'Bandra West',
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        lat: 19.0607,
        lng: 72.8362,
      },
    },
  });
  const order = {
    id: 'ORD-SYNTHETIC-2048',
    bookingReference: 'C1-TEST-2048',
    eventId: event.id,
    organizationId: 'ORG-SYNTHETIC-HOST',
    userId: 'USR-SYNTHETIC-PURCHASER',
    contact: { name: 'Synthetic Guest', email: recipient, phone: '+910000000000' },
    status: fixture.eventCancelled ? 'paid' : 'paid',
    fulfillmentState: 'complete',
    lines: [
      {
        tierId: 'TIER-SYNTHETIC-GA',
        tierName: 'General Admission',
        quantity: 2,
        unitPricePaise: 180000,
        subtotalPaise: 360000,
      },
    ],
    currency: 'INR',
    subtotalPaise: 360000,
    admissionSubtotalPaise: 360000,
    coverSubtotalPaise: 0,
    addOnSubtotalPaise: 0,
    discountPaise: 0,
    discountedSubtotalPaise: 360000,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    gstPaise: 0,
    grandTotalPaise: fixture.file === 'rsvp-confirmation' ? 0 : 360000,
    discountFundingOwner: null,
    appliedPromoCode: null,
    attribution: null,
    paymentIntentId: null,
    paymentId: 'PAYMENT-SYNTHETIC-INTERNAL',
    paidAt: FIXED_NOW.toISOString(),
    reservationExpiresAt: FIXED_NOW.toISOString(),
    failureReason: null,
    refundedPaise: 0,
    eventCancellation: null,
  };
  const holder = { id: 'USR-SYNTHETIC-HOLDER', email: recipient, emailVerified: true };
  const entitlement = {
    id: 'ENT-SYNTHETIC-TICKET',
    orderId: order.id,
    eventId: event.id,
    userId: 'USR-SYNTHETIC-PURCHASER',
    currentHolderUserId: 'USR-SYNTHETIC-HOLDER',
    status: 'valid',
    fulfillmentRequired: false,
    upgradeFromEntitlementId: 'ENT-SYNTHETIC-ORIGINAL',
    credentialVersion: 3,
    pendingTransferId: 'TRANSFER-SYNTHETIC-INVITE',
    refundLock: null,
  };
  const status =
    fixture.file === 'transfer-expired'
      ? 'expired'
      : fixture.file === 'transfer-accepted-new-holder'
        ? 'accepted'
        : 'pending';
  const transfer = {
    id: 'TRANSFER-SYNTHETIC-INVITE',
    status,
    senderUserId: 'USR-SYNTHETIC-HOLDER',
    recipientUserId: 'USR-SYNTHETIC-RECIPIENT',
    recipientEmail: null,
    recipientEmailHash: null,
    entitlementId: entitlement.id,
    eventId: event.id,
    expiresAt: '2026-06-02T10:00:00.000Z',
    resolvedAt: FIXED_NOW.toISOString(),
    version: 2,
  };
  const statusForKyc = fixture.kycStatus ?? 'submitted';
  const recipientOrg = {
    id: 'ORG-SYNTHETIC',
    ownerId: 'USR-SYNTHETIC-OWNER',
    members: [{ capabilities: ['promoter'] }],
  };
  const application = {
    id: `ONBOARDING-SYNTHETIC-${fixture.kycRole ?? 'host'}`,
    userId: 'USR-SYNTHETIC-APPLICANT',
    requestedType: fixture.kycRole ?? 'host',
    status: statusForKyc,
    reviewNote: 'Synthetic review note: please add the missing public venue detail.',
  };
  const refund = {
    id: 'REFUND-SYNTHETIC',
    status: fixture.file === 'refund-declined' ? 'rejected' : 'settled',
    amountPaise: 125000,
    targetEntitlementIds: [entitlement.id],
  };
  const coverAccount = {
    id: 'COVER-SYNTHETIC',
    guestUserId: 'USR-SYNTHETIC-COVER-GUEST',
    entitlementId: entitlement.id,
    eventId: event.id,
    orderId: order.id,
  };
  const hold = { id: 'HOLD-SYNTHETIC', userId: null, attendee: { email: recipient } };
  return {
    event,
    venue,
    order,
    holder,
    entitlement,
    transfer,
    recipientOrg,
    application,
    refund,
    coverAccount,
    hold,
  };
}

async function renderAll() {
  const rendered: { fixture: Fixture; message: TransactionalEmail }[] = [];
  const activeFixtures = retryV2First
    ? fixtures.filter((fixture) => fixture.file === 'purchase-confirmation')
    : sendV2Remaining
      ? fixtures.filter(
          (fixture) => v2Files.has(fixture.file) && fixture.file !== 'purchase-confirmation',
        )
      : v2DryRun || sendV2Acceptance
        ? fixtures.filter((fixture) => v2Files.has(fixture.file))
        : fixtures;
  for (const fixture of activeFixtures) {
    const rows = syntheticRows(fixture, requestedRecipient);
    const captures: TransactionalEmail[] = [];
    const deliveryRepository = createMemoryDeliveryRepository();
    const deps = {
      config: {
        guestPortalUrl: 'https://guest.example.test',
        partnerDashboardUrl: 'https://partner.example.test',
        clock: { now: () => FIXED_NOW },
      },
      emailDeliveries: deliveryRepository,
      emailSender: {
        name: 'local-capture',
        sendTransactionalEmail: async (message: TransactionalEmail) => {
          captures.push(message);
          return { outcome: 'captured_locally', providerMessageId: null };
        },
      },
      userDirectory: { getEmailById: async () => requestedRecipient },
      repositories: {
        orders: {
          getById: async () => rows.order,
          listByEvent: async () => ({ items: [], nextCursor: null }),
        },
        events: { getById: async () => rows.event },
        venues: { getById: async (id: string) => rows.venue(id) },
        users: {
          getById: async (id: string) => ({
            ...rows.holder,
            id,
            email: requestedRecipient,
            emailVerified: true,
          }),
        },
        entitlements: {
          getById: async () => rows.entitlement,
          getByOrderId: async () => [rows.entitlement],
          getTicketTransfer: async () => rows.transfer,
        },
        organizations: { getById: async () => rows.recipientOrg },
        eventCoverAccounts: { getByEntitlement: async () => rows.coverAccount },
        catalog: {
          getTicketAddonById: async () => ({ id: 'ADDON-SYNTHETIC', name: 'Late entry add-on' }),
        },
        refundRequests: { getById: async () => rows.refund },
        cartReservations: { getById: async () => rows.hold },
        onboarding: { getById: async () => rows.application },
      },
    } as unknown as ServiceDeps;
    await createTransactionalEmailConsumer(deps)({
      id: `EVENT-SYNTHETIC-${fixture.file}`,
      type: fixture.type,
      schemaVersion: 1,
      aggregateId: `AGG-SYNTHETIC-${fixture.file}`,
      organizationId: 'ORG-SYNTHETIC-HOST',
      actorId: 'system:synthetic-acceptance',
      occurredAt: nowMs,
      payload: fixture.payload,
    });
    const expectedCount = fixture.captureVariants?.length ?? 1;
    if (captures.length !== expectedCount) {
      throw new Error(
        `Fixture ${fixture.file} produced ${captures.length} captures; expected ${expectedCount}.`,
      );
    }
    for (let i = 0; i < captures.length; i += 1) {
      const message = captures[i];
      if (!message || !message.html || !message.text || message.to !== requestedRecipient) {
        throw new Error(
          `Fixture ${fixture.file} did not produce a complete message for the restricted recipient.`,
        );
      }
      const ctaCount = (
        message.html.match(/<td\b[^>]*bgcolor=["']#ff5a00["'][^>]*>\s*<a\b/gi) ?? []
      ).length;
      if (ctaCount !== 1 || !message.html.includes('max-width:520px')) {
        throw new Error(
          `Fixture ${fixture.file} must render one primary CTA in the 520px responsive shell.`,
        );
      }
      if (fixture.file === 'event-material-change') {
        if (!message.html.includes('&lt;After Dark&gt;') || message.html.includes('<After Dark>')) {
          throw new Error('Long event title was not escaped in the HTML output.');
        }
        if (/<img\b/i.test(message.html))
          throw new Error('Missing poster fixture left an image hole.');
      }
      if (fixture.file === 'purchase-confirmation') {
        if (/ORD-SYNTHETIC|PAYMENT-SYNTHETIC|Fees|Taxes|₹0(?:\.00)?/.test(message.html)) {
          throw new Error(
            'Purchase receipt exposed an internal ID or invented a zero-value financial row.',
          );
        }
        if (!message.html.includes('View event') || !message.html.includes('Directions')) {
          throw new Error('Purchase receipt is missing its supported secondary event actions.');
        }
      }
      if (
        fixture.file === 'payment-support-required' &&
        message.html.includes('PAYMENT-SYNTHETIC-INTERNAL')
      ) {
        throw new Error('Payment support email exposed the synthetic provider reference.');
      }
      rendered.push({
        fixture: {
          ...fixture,
          file: fixture.captureFiles?.[i] ?? fixture.file,
          variant: fixture.captureVariants?.[i] ?? fixture.variant,
        },
        message,
      });
    }
  }
  const expectedCount =
    v2DryRun || sendV2Acceptance ? 6 : retryV2First ? 1 : sendV2Remaining ? 5 : 43;
  if (rendered.length !== expectedCount)
    throw new Error(
      `Preview inventory rendered ${rendered.length} messages; expected ${expectedCount}.`,
    );
  return rendered;
}

function layoutFamily(kind: string): string {
  if (eventVariants.has(kind)) return 'Event / ticket';
  if (kind.includes('onboarding') || kind.includes('promoter')) return 'Partner / KYC';
  return 'Financial / operational';
}

function safeFileName(fixture: Fixture): string {
  return fixture.file;
}

function previewMarkup(entry: { fixture: Fixture; message: TransactionalEmail }): string {
  const file = safeFileName(entry.fixture);
  const templateType = entry.message.templateType ?? 'unknown';
  return `- [${entry.fixture.variant}](./previews/${file}.html) | ${templateType} | ${entry.message.subject} | ${entry.message.preheader ?? ''} | ${layoutFamily(templateType)} | [text](./previews/${file}.txt)\n`;
}

async function writePreviews(entries: { fixture: Fixture; message: TransactionalEmail }[]) {
  const directory = new URL('../', ROOT);
  await mkdir(directory, { recursive: true });
  const indexRows = entries.map(previewMarkup).join('');
  const content = `# Pass 6 transactional email design system and preview inventory\n\n**Status:** Founder visual approval remains pending. A previously authorized V2 batch produced ambiguous Resend outcomes for the purchase receipt and ticket invitation, with no provider request IDs returned; four other variants were not attempted. Do not retry those messages without checking Resend.\n\n**Rendering:** All 43 in-scope V1 message variants below were generated through the actual Pass 6 transactional email consumer using synthetic fixtures and an in-memory capture sender. Waitlist email is excluded from V1. No staging or production data was used.\n\n**Visual direction:** Near-black canvas, high-contrast white typography, restrained C1RCLE orange, open event artwork, editorial family labels, stronger spacing, unboxed ticket details, a full-width primary action, and receipt-like financial rows. The Posh PDF informed information order only; its branding, QR, and attachments were not copied.\n\n## Preview inventory\n\n${indexRows}\n## Review notes\n\n- Assignment, transfer invitation and resend triggers share the same canonical invitation template; one invitation design is listed.
- Transfer acceptance renders the separate current-holder and former-holder messages.
- KYC has 12 role/state combinations: Host, Venue and Promoter, each for submitted, changes requested, approved and rejected.
- Event artwork is referenced only from synthetic fixtures. Missing artwork leaves no broken-image placeholder.
- No QR code or attachment is included. Ticket state remains in the C1RCLE Wallet.\n`;
  const { writeFile: write } = await import('node:fs/promises');
  await write(INDEX_PATH, content, 'utf8');
  for (const entry of entries) {
    const metadata =
      [
        `Variant: ${entry.fixture.variant}`,
        `Template: ${entry.message.templateType}`,
        `Subject: ${entry.message.subject}`,
        `Preheader: ${entry.message.preheader ?? ''}`,
        `Primary action: ${escapeMarkdownLabel(extractPrimaryLabel(entry.message.html))}`,
        `Layout family: ${layoutFamily(entry.message.templateType ?? 'unknown')}`,
        `Recipient fixture: ${PREVIEW_RECIPIENT} (synthetic; local capture only)`,
        'Event, account, booking and financial data: synthetic fixtures only',
        'Capture path: actual createTransactionalEmailConsumer; local in-memory capture sender',
        'Resend: not invoked in preview generation',
      ].join('\n') + '\n';
    await writeFile(
      new URL(`${safeFileName(entry.fixture)}.html`, ROOT),
      entry.message.html,
      'utf8',
    );
    await writeFile(
      new URL(`${safeFileName(entry.fixture)}.txt`, ROOT),
      entry.message.text ?? '',
      'utf8',
    );
    await writeFile(new URL(`${safeFileName(entry.fixture)}.meta.txt`, ROOT), metadata, 'utf8');
  }
}

async function runNetworkIsolatedDryRun(
  entries: { fixture: Fixture; message: TransactionalEmail }[],
  v2 = false,
) {
  const config = getGatewayConfig();
  if (config.NODE_ENV !== 'development') throw new Error('Dry run requires NODE_ENV=development.');
  const apiKey = config.RESEND_API_KEY;
  const fromEmail = config.RESEND_FROM_EMAIL;
  const allowlist = config.RESEND_NON_PROD_TEST_RECIPIENT;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');
  if (fromEmail !== SENDER)
    throw new Error('RESEND_FROM_EMAIL does not match the approved sender identity.');
  if (allowlist !== ACCEPTANCE_RECIPIENT)
    throw new Error(
      'RESEND_NON_PROD_TEST_RECIPIENT does not exactly match the approved recipient.',
    );
  if (entries.length !== (v2 ? 6 : 43)) {
    throw new Error(`Dry-run inventory count mismatch: ${entries.length}.`);
  }
  if (entries.some(({ message }) => message.to !== ACCEPTANCE_RECIPIENT)) {
    throw new Error('A fixture resolved to a recipient outside the exact founder recipient.');
  }
  if (new Set(entries.map(({ message }) => message.idempotencyKey)).size !== entries.length) {
    throw new Error('Dry-run idempotency keys are not unique.');
  }

  const requests: {
    to: string;
    from: string;
    subject: string;
    hasText: boolean;
    hasHtml: boolean;
    hasIdempotencyKey: boolean;
    authorizationHeaderPresent: boolean;
  }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== 'https://api.resend.com/emails')
      throw new Error('Unexpected network call blocked by dry-run interceptor.');
    if (typeof init?.body !== 'string') throw new Error('Adapter payload was not serialized.');
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    if (
      payload.to !== ACCEPTANCE_RECIPIENT ||
      payload.from !== SENDER ||
      typeof payload.to !== 'string' ||
      typeof payload.from !== 'string'
    ) {
      throw new Error('Resend adapter attempted a non-allowlisted recipient or wrong sender.');
    }
    const subjectPrefix = v2 ? '[C1RCLE TEST V2] ' : '[C1RCLE TEST] ';
    if (typeof payload.subject !== 'string' || !payload.subject.startsWith(subjectPrefix)) {
      throw new Error('Acceptance subject prefix is missing.');
    }
    requests.push({
      to: payload.to,
      from: payload.from,
      subject: payload.subject,
      hasText: typeof payload.text === 'string' && payload.text.length > 0,
      hasHtml: typeof payload.html === 'string' && payload.html.length > 0,
      hasIdempotencyKey: headers.has('Idempotency-Key'),
      authorizationHeaderPresent: headers.has('Authorization'),
    });
    // This synthetic response exists only inside the intercepted fetch. No network socket opens.
    return new Response(JSON.stringify({ id: `local-dry-run-${requests.length}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const quietLogger = { info() {}, warn() {}, error() {} };
  const sender = new ResendEmailSender(apiKey, 'development', quietLogger, fromEmail, allowlist);
  try {
    for (const { message } of entries) {
      await sender.sendTransactionalEmail({
        ...message,
        to: ACCEPTANCE_RECIPIENT,
        subject: `${v2 ? '[C1RCLE TEST V2] ' : '[C1RCLE TEST] '}${message.subject}`,
      });
    }
    const rejected = await sender.sendTransactionalEmail({
      to: 'not-allowlisted@synthetic.test',
      subject: '[C1RCLE TEST] allowlist rejection check',
      html: '<p>synthetic</p>',
      text: 'synthetic',
      templateType: 'allowlist-check',
      idempotencyKey: 'local-allowlist-check',
    });
    if (
      rejected.outcome !== 'captured_locally' ||
      requests.length !== (v2 ? 6 : 43) ||
      sender.localCaptures.length !== 1
    ) {
      throw new Error(
        'Dry-run request count or recipient allowlist behavior did not match expectations.',
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const messages = entries.map(({ fixture, message }, index) => ({
    index: index + 1,
    variant: fixture.variant,
    template: message.templateType,
    subject: requests[index]?.subject,
    recipient: requests[index]?.to,
    sender: requests[index]?.from,
    textAlternative: requests[index]?.hasText,
    html: requests[index]?.hasHtml,
    idempotencyKeyPresent: requests[index]?.hasIdempotencyKey,
  }));
  process.stdout.write(
    JSON.stringify(
      {
        NODE_ENV: 'development',
        batch: v2 ? 'V2 founder acceptance dry run' : 'founder acceptance dry run',
        RESEND_API_KEY: 'FOUND (value withheld)',
        sender: fromEmail,
        allowlist: ACCEPTANCE_RECIPIENT,
        realAdapter: 'ResendEmailSender',
        capturedRequestCount: requests.length,
        networkEgress: false,
        providerAcceptance: 0,
        delivered: 0,
        nonAllowlistedRecipientRejected: true,
        applicationDataMutation: false,
        fixtureData: 'synthetic only',
        messages,
      },
      null,
      2,
    ) + '\n',
  );
}

async function sendFounderAcceptanceBatch(
  entries: { fixture: Fixture; message: TransactionalEmail }[],
  v2 = false,
  expectedCount = v2 ? 6 : 43,
) {
  const config = getGatewayConfig();
  if (config.NODE_ENV !== 'development')
    throw new Error('Acceptance send requires NODE_ENV=development.');
  if (!config.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
  if (config.RESEND_FROM_EMAIL !== SENDER) throw new Error('Approved sender identity mismatch.');
  if (config.RESEND_NON_PROD_TEST_RECIPIENT !== ACCEPTANCE_RECIPIENT)
    throw new Error('Exact founder recipient allowlist is not active.');

  // This assertion runs before constructing the live sender or making a provider call.
  const recipientsMatch = entries.every(({ message }) => message.to === ACCEPTANCE_RECIPIENT);
  const idempotencyKeysPresent = entries.every(({ message }) => Boolean(message.idempotencyKey));
  const byIdempotencyKey = new Map<string, string[]>();
  for (const { fixture, message } of entries) {
    const variants = byIdempotencyKey.get(message.idempotencyKey) ?? [];
    variants.push(fixture.variant);
    byIdempotencyKey.set(message.idempotencyKey, variants);
  }
  const duplicateVariants = [...byIdempotencyKey.values()].filter(
    (variants) => variants.length > 1,
  );
  if (
    entries.length !== expectedCount ||
    !recipientsMatch ||
    !idempotencyKeysPresent ||
    duplicateVariants.length > 0 ||
    new Set(entries.map(({ message }) => message.idempotencyKey)).size !== expectedCount
  ) {
    throw new Error(
      `Pre-send assertion failed: count=${entries.length}, recipientsMatch=${recipientsMatch}, idempotencyKeysPresent=${idempotencyKeysPresent}, duplicateVariants=${JSON.stringify(duplicateVariants)}.`,
    );
  }
  process.stdout.write(
    JSON.stringify({
      phase: 'pre-send assertion passed',
      count: entries.length,
      batch: v2 ? 'V2 founder acceptance send' : 'founder acceptance send',
      allRecipientsEqualFounder: true,
      uniqueIdempotencyKeys: true,
      sender: config.RESEND_FROM_EMAIL,
      allowlist: config.RESEND_NON_PROD_TEST_RECIPIENT,
      NODE_ENV: config.NODE_ENV,
      fixtureData: 'synthetic only',
    }) + '\n',
  );

  const sender = new ResendEmailSender(
    config.RESEND_API_KEY,
    config.NODE_ENV,
    { info() {}, warn() {}, error() {} },
    config.RESEND_FROM_EMAIL,
    config.RESEND_NON_PROD_TEST_RECIPIENT,
  );
  const results: {
    index: number;
    template: string;
    variant: string;
    subject: string;
    recipient: string;
    attemptedAt: string;
    result: 'RESEND ACCEPTED' | 'REJECTED' | 'FAILED / OUTCOME UNKNOWN';
    providerRequestId: string | null;
    safeFailureClass?: string;
  }[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) throw new Error('Validated acceptance inventory changed before send.');
    const { fixture, message } = entry;
    const subject = `${v2 ? '[C1RCLE TEST V2] ' : '[C1RCLE TEST] '}${message.subject}`;
    const attemptedAt = new Date().toISOString();
    try {
      const response = await sender.sendTransactionalEmail({
        ...message,
        to: ACCEPTANCE_RECIPIENT,
        subject,
      });
      if (response.outcome !== 'accepted_by_provider' || !response.providerMessageId) {
        results.push({
          index: index + 1,
          template: message.templateType ?? 'unknown',
          variant: fixture.variant,
          subject,
          recipient: ACCEPTANCE_RECIPIENT,
          attemptedAt,
          result: 'FAILED / OUTCOME UNKNOWN',
          providerRequestId: null,
          safeFailureClass: 'unexpected adapter outcome',
        });
        process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
        break;
      }
      results.push({
        index: index + 1,
        template: message.templateType ?? 'unknown',
        variant: fixture.variant,
        subject,
        recipient: ACCEPTANCE_RECIPIENT,
        attemptedAt,
        result: 'RESEND ACCEPTED',
        providerRequestId: response.providerMessageId,
      });
      process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
    } catch (error) {
      const permanent = error instanceof PermanentEmailDeliveryError;
      results.push({
        index: index + 1,
        template: message.templateType ?? 'unknown',
        variant: fixture.variant,
        subject,
        recipient: ACCEPTANCE_RECIPIENT,
        attemptedAt,
        result: permanent ? 'REJECTED' : 'FAILED / OUTCOME UNKNOWN',
        providerRequestId: null,
        safeFailureClass: permanent
          ? 'permanent provider rejection'
          : 'provider/network error; no retry issued',
      });
      process.stdout.write(JSON.stringify(results.at(-1)) + '\n');
      // A known permanent rejection is isolated to this payload. For any other error,
      // outcome may be ambiguous; stop here so no uncertain message is retried or duplicated.
      if (!permanent) break;
    }
  }

  const accepted = results.filter((result) => result.result === 'RESEND ACCEPTED').length;
  const rejected = results.filter((result) => result.result === 'REJECTED').length;
  const failed = results.filter((result) => result.result === 'FAILED / OUTCOME UNKNOWN').length;
  process.stdout.write(
    JSON.stringify(
      {
        phase: 'batch summary',
        attempted: results.length,
        accepted,
        rejected,
        failed,
        delivered: 'not checked; provider acceptance is not delivery',
        results,
        gmailChecklist: results.map(({ index, variant, subject, result }) => ({
          index,
          variant,
          subject,
          result,
        })),
      },
      null,
      2,
    ) + '\n',
  );
}

async function main() {
  const entries = await renderAll();
  if (sendV2Acceptance) {
    await sendFounderAcceptanceBatch(entries, true);
    return;
  }
  if (retryV2First) {
    await sendFounderAcceptanceBatch(entries, true, 1);
    return;
  }
  if (sendV2Remaining) {
    await sendFounderAcceptanceBatch(entries, true, 5);
    return;
  }
  if (v2DryRun) {
    await runNetworkIsolatedDryRun(entries, true);
    return;
  }
  if (sendAcceptance) {
    await sendFounderAcceptanceBatch(entries);
    return;
  }
  if (dryRun) {
    await runNetworkIsolatedDryRun(entries);
    return;
  }
  await writePreviews(entries);
  process.stdout.write(
    `Generated ${entries.length} synthetic email previews through the Pass 6 consumer; local capture only.\n`,
  );
}

await main();
