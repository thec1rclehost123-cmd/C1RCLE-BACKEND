import {
  createEventCoverAccount,
  createPlatformAdmin,
  createSocialNotification,
  createTicketTransfer,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, Entitlement } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminTicketRoutes from './tickets.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin tickets desk over HTTP (Phase 7 admin) ────────────────────────────
 * Platform-wide, read-only entitlement ledger. Asserts admin gating and that
 * the DTO carries the latest scan timestamp, not the full `scannedAt` array.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId };
}

function ticket(overrides: Partial<Entitlement>): Entitlement {
  const now = new Date().toISOString();
  return {
    id: `ENT-${++keySeq}`,
    orderId: 'order_1',
    eventId: 'event_1',
    organizationId: 'org_1',
    tierId: 'tier_1',
    tierName: 'General',
    userId: null,
    holderName: 'Guest Person',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let server: FastifyInstance;

beforeEach(async () => {
  services.config().features.m5CoverAccountingApproved = false;
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();
  (repos.entitlements as unknown as { transfers: Map<string, unknown> }).transfers.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records.length = 0;

  server = await buildPartnerTestServer({ routes: [adminTicketRoutes] });
});

describe('GET /admin/tickets', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/tickets',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists tickets platform-wide with the latest scan timestamp', async () => {
    await seedAdmin('admin_a', 'ops');
    const scannedAt = ['2026-09-01T10:00:00.000Z', '2026-09-01T10:05:00.000Z'];
    await services.repos().entitlements.save(
      ticket({
        status: 'redeemed',
        scanCount: 2,
        scanCountAllowed: 2,
        scannedAt,
      }),
    );
    await services.repos().entitlements.save(ticket({ status: 'valid' }));

    const response = await server.inject({
      method: 'GET',
      url: '/admin/tickets',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const body = response.json();
    expect(body.items).toHaveLength(2);
    const redeemed = body.items.find((item: { status: string }) => item.status === 'redeemed');
    expect(redeemed.lastScannedAt).toBe('2026-09-01T10:05:00.000Z');
    const valid = body.items.find((item: { status: string }) => item.status === 'valid');
    expect(valid.lastScannedAt).toBeNull();
  });
});

describe('GET /admin/tickets/export.csv', () => {
  it('marks the personal-data export private and non-cacheable', async () => {
    await seedAdmin('ticket_export_admin', 'support');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/tickets/export.csv',
      headers: asUser('ticket_export_admin'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-type']).toContain('text/csv');
  });
});

describe('GET /admin/tickets/:ticketId/transfers', () => {
  it('returns bounded redacted transfer history to an Admin only', async () => {
    await seedAdmin('support_admin', 'support');
    const now = new Date();
    const entitlementId = 'ENT-admin-transfer-history';
    const transfer = createTicketTransfer({
      id: 'TRF-admin-transfer-history',
      entitlementId,
      eventId: 'event_1',
      senderUserId: 'guest_owner',
      recipientEmailHash: 'a'.repeat(64),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    await services
      .repos()
      .entitlements.save(
        ticket({ id: entitlementId, userId: 'guest_owner', currentHolderUserId: 'guest_owner' }),
      );
    await services.repos().entitlements.createTicketTransfer(transfer, 'guest_owner');

    const denied = await server.inject({
      method: 'GET',
      url: `/admin/tickets/${entitlementId}/transfers`,
      headers: asUser('not_an_admin'),
    });
    expect(denied.statusCode).toBe(401);

    const response = await server.inject({
      method: 'GET',
      url: `/admin/tickets/${entitlementId}/transfers`,
      headers: asUser('support_admin'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: transfer.id,
        entitlementId,
        eventId: 'event_1',
        recipientBinding: 'verified_email',
        status: 'pending',
      },
    ]);
    expect(response.body).not.toContain('a'.repeat(64));
    expect(response.body).not.toContain('guest_owner');
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('GET /admin/tickets/:ticketId/cover-reconciliation', () => {
  it('returns read-only account facts to Admin without guest identifiers', async () => {
    await seedAdmin('cover_support_admin', 'support');
    const entitlementId = 'ENT-admin-cover-reconciliation';
    await services.repos().entitlements.save(
      ticket({
        id: entitlementId,
        orderId: 'ORD-admin-cover-reconciliation',
        eventId: 'EVT-admin-cover-reconciliation',
      }),
    );
    const account = createEventCoverAccount({
      entitlementId,
      orderId: 'ORD-admin-cover-reconciliation',
      eventId: 'EVT-admin-cover-reconciliation',
      guestUserId: 'private_guest_id',
      hostOrganizationId: 'ORG-admin-cover-host',
      venueOrganizationId: 'ORG-admin-cover-venue',
      amountPaise: 150_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-policy-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    await services.repos().eventCoverAccounts.createIssuedAccount(account);

    const denied = await server.inject({
      method: 'GET',
      url: `/admin/tickets/${entitlementId}/cover-reconciliation`,
      headers: asUser('not_an_admin'),
    });
    expect(denied.statusCode).toBe(401);

    const response = await server.inject({
      method: 'GET',
      url: `/admin/tickets/${entitlementId}/cover-reconciliation`,
      headers: asUser('cover_support_admin'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      currency: 'INR',
      status: 'active',
      issuedPaise: 150_000,
      remainingPaise: 150_000,
      reservedPaise: 0,
      redeemedPaise: 0,
      refundedPaise: 0,
      settlementStatus: 'held',
      settlementEligible: false,
      heldRedemptionPaise: 0,
      reversalEnabled: false,
      reversibleCaptureEntryIds: [],
      entryCount: 1,
      balanced: true,
    });
    expect(response.body).not.toContain('private_guest_id');
    expect(response.body).not.toContain('ORG-admin-cover-host');
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('GET /admin/events/:eventId/cover-reconciliation', () => {
  it('returns bounded event totals without exposing account identities or settlement eligibility', async () => {
    await seedAdmin('event_cover_finance_admin', 'finance');
    const eventId = 'EVT-admin-cover-event-summary';
    const first = createEventCoverAccount({
      entitlementId: 'ENT-admin-cover-event-1',
      orderId: 'ORD-admin-cover-event-1',
      eventId,
      guestUserId: 'private_event_cover_guest_1',
      hostOrganizationId: 'ORG-admin-cover-host',
      venueOrganizationId: 'ORG-admin-cover-venue',
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-policy-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const second = createEventCoverAccount({
      entitlementId: 'ENT-admin-cover-event-2',
      orderId: 'ORD-admin-cover-event-2',
      eventId,
      guestUserId: 'private_event_cover_guest_2',
      hostOrganizationId: 'ORG-admin-cover-host',
      venueOrganizationId: 'ORG-admin-cover-venue',
      amountPaise: 25_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-policy-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    await services.repos().eventCoverAccounts.createIssuedAccount(first);
    await services.repos().eventCoverAccounts.createIssuedAccount(second);

    const response = await server.inject({
      method: 'GET',
      url: `/admin/events/${eventId}/cover-reconciliation`,
      headers: asUser('event_cover_finance_admin'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eventId,
      accountCount: 2,
      scannedAccountCount: 2,
      truncated: false,
      balancedAccountCount: 2,
      unbalancedAccountCount: 0,
      issuedPaise: 75_000,
      remainingPaise: 75_000,
      redeemedPaise: 0,
      heldRedemptionPaise: 0,
      settlementStatus: 'held',
      settlementEligible: false,
      balanced: true,
    });
    expect(response.body).not.toContain('private_event_cover_guest');
    expect(response.body).not.toContain('ORG-admin-cover-host');
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('GET /admin/tickets/:ticketId/event-change-refund-reviews', () => {
  it('returns redacted refund-review requests to Admin only', async () => {
    await seedAdmin('change_support_admin', 'support');
    const entitlementId = 'ENT-admin-event-change-review';
    await services.repos().entitlements.save(ticket({ id: entitlementId }));
    const notice = createSocialNotification({
      userId: 'private_guest_id',
      type: 'event.material_change',
      title: 'Event updated',
      body: 'Material event details changed.',
      link: null,
      subjectId: 'event-1:version-4:order-1:ticket-1',
      eventChange: {
        eventVersion: 4,
        entitlementId,
        canAccept: true,
        canRequestRefund: true,
      },
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    await services.repos().socialNotifications.create({
      ...notice,
      eventChangeResponse: {
        response: 'refund_requested',
        respondedAt: '2026-10-28T12:30:00.000Z',
        respondedBy: 'private_guest_id',
      },
    });

    const denied = await server.inject({
      method: 'GET',
      url: `/admin/tickets/${entitlementId}/event-change-refund-reviews`,
      headers: asUser('not_an_admin'),
    });
    expect(denied.statusCode).toBe(401);

    const response = await server.inject({
      method: 'GET',
      url: `/admin/tickets/${entitlementId}/event-change-refund-reviews`,
      headers: asUser('change_support_admin'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        eventVersion: 4,
        response: 'refund_requested',
        respondedAt: '2026-10-28T12:30:00.000Z',
      },
    ]);
    expect(response.body).not.toContain('private_guest_id');
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('POST /admin/tickets/:ticketId/cover-redemptions/:operationId/reverse', () => {
  it('requires approval and Tier 2 authority, then performs an audited idempotent reversal', async () => {
    await seedAdmin('cover_support_admin', 'support');
    await seedAdmin('cover_finance_admin', 'finance');
    const entitlementId = 'ENT-admin-cover-redemption-reversal';
    const operationId = 'POS-admin-cover-redemption-reversal';
    await services.repos().entitlements.save(
      ticket({
        id: entitlementId,
        orderId: 'ORD-admin-cover-redemption-reversal',
        eventId: 'EVT-admin-cover-redemption-reversal',
      }),
    );
    const account = createEventCoverAccount({
      entitlementId,
      orderId: 'ORD-admin-cover-redemption-reversal',
      eventId: 'EVT-admin-cover-redemption-reversal',
      guestUserId: 'private_guest_id',
      hostOrganizationId: 'ORG-cover-host',
      venueOrganizationId: 'ORG-cover-venue',
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-policy-v1',
      refundPolicy: 'saved_policy_review',
      activationApproved: true,
    });
    await services.repos().eventCoverAccounts.createIssuedAccount(account);
    await services.repos().eventCoverAccounts.reserve(account.id, {
      amountPaise: 12_000,
      operationId,
      guestConfirmed: true,
      online: true,
      actorUserId: 'venue_operator',
      terminalId: 'venue_terminal',
      receiptReference: 'POS-RECEIPT-1',
    });
    const capture = await services.repos().eventCoverAccounts.capture(account.id, operationId);
    const path = `/admin/tickets/${entitlementId}/cover-redemptions/${capture.entry.id}/reverse`;
    const payload = { reason: 'Correct duplicate terminal capture' };
    services.config().features.m5CoverAccountingApproved = false;
    const held = await server.inject({
      method: 'POST',
      url: path,
      headers: asUser('cover_finance_admin'),
      payload,
    });
    expect(held.statusCode).toBe(409);

    const roleDenied = await server.inject({
      method: 'POST',
      url: path,
      headers: asUser('cover_support_admin'),
      payload,
    });
    expect(roleDenied.statusCode).toBe(403);

    services.config().features.m5CoverAccountingApproved = true;
    const response = await server.inject({
      method: 'POST',
      url: path,
      headers: asUser('cover_finance_admin'),
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountId: account.id,
      entitlementId,
      amountPaise: 12_000,
      remainingPaise: 50_000,
      redeemedPaise: 0,
      settlementStatus: 'held',
      settlementEligible: false,
      replayed: false,
    });
    const retry = await server.inject({
      method: 'POST',
      url: path,
      headers: asUser('cover_finance_admin'),
      payload,
    });
    expect(retry.json()).toMatchObject({ replayed: true });
    expect(
      (await services.adminAudits().listForTarget(account.id, 10)).filter(
        (record) => record.action === 'EVENT_COVER_REDEMPTION_REVERSE',
      ),
    ).toHaveLength(1);
    expect(response.body).not.toContain('private_guest_id');
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('POST /admin/ticket-transfers/:transferId/freeze', () => {
  it('requires Admin authority and an audit reason', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/ticket-transfers/TRF-missing/freeze',
      headers: asUser('not_an_admin'),
      payload: { reason: 'Suspicious invite' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('freezes a pending transfer, preserves the current holder, and records the reason', async () => {
    await seedAdmin('support_admin', 'support');
    const entitlementId = 'ENT-support-freeze';
    const transferId = 'TRF-support-freeze';
    const now = new Date();
    const entitlement = ticket({
      id: entitlementId,
      userId: 'guest_owner',
      currentHolderUserId: 'guest_owner',
      credentialVersion: 3,
      pendingTransferId: null,
    });
    await services.repos().entitlements.save(entitlement);
    const pending = createTicketTransfer({
      id: transferId,
      entitlementId,
      eventId: entitlement.eventId,
      senderUserId: 'guest_owner',
      recipientUserId: 'guest_recipient',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    await services.repos().entitlements.createTicketTransfer(pending, 'guest_owner');

    const response = await server.inject({
      method: 'POST',
      url: `/admin/ticket-transfers/${transferId}/freeze`,
      headers: asUser('support_admin'),
      payload: { reason: 'Recipient account reported compromised' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: transferId, status: 'frozen' });
    expect(await services.repos().entitlements.getById(entitlementId)).toMatchObject({
      currentHolderUserId: 'guest_owner',
      credentialVersion: 3,
      pendingTransferId: transferId,
    });
    const audit = await services.adminAudits().listForTarget(transferId, 10);
    expect(audit).toMatchObject([
      {
        action: 'TICKET_TRANSFER_FREEZE',
        adminId: 'support_admin',
        targetType: 'ticket_transfer',
        reason: 'Recipient account reported compromised',
        before: { status: 'pending' },
        after: { status: 'frozen', currentHolderUserId: 'guest_owner' },
      },
    ]);
  });
});

describe('POST /admin/ticket-transfers/:transferId/release', () => {
  it('requires elevated Admin authority and an audit reason', async () => {
    await seedAdmin('support_release_admin', 'support');
    const response = await server.inject({
      method: 'POST',
      url: '/admin/ticket-transfers/TRF-missing/release',
      headers: asUser('support_release_admin'),
      payload: { reason: 'Reviewed support case' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('releases only the matching frozen lock and preserves holder and transfer history', async () => {
    await seedAdmin('ops_release_admin', 'ops');
    const entitlementId = 'ENT-support-release';
    const transferId = 'TRF-support-release';
    const now = new Date();
    const entitlement = ticket({
      id: entitlementId,
      userId: 'guest_owner',
      currentHolderUserId: 'guest_owner',
      credentialVersion: 4,
      pendingTransferId: null,
    });
    await services.repos().entitlements.save(entitlement);
    const pending = createTicketTransfer({
      id: transferId,
      entitlementId,
      eventId: entitlement.eventId,
      senderUserId: 'guest_owner',
      recipientUserId: 'guest_recipient',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    await services.repos().entitlements.createTicketTransfer(pending, 'guest_owner');
    await services.adminOps.freezeTicketTransfer(
      'ops_release_admin',
      transferId,
      'Initial support review',
    );

    const response = await server.inject({
      method: 'POST',
      url: `/admin/ticket-transfers/${transferId}/release`,
      headers: asUser('ops_release_admin'),
      payload: { reason: 'Recipient identity issue resolved' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: transferId,
      status: 'frozen',
      lockReleased: true,
    });
    expect(await services.repos().entitlements.getById(entitlementId)).toMatchObject({
      currentHolderUserId: 'guest_owner',
      credentialVersion: 4,
      pendingTransferId: null,
    });
    expect(await services.repos().entitlements.getTicketTransfer(transferId)).toMatchObject({
      status: 'frozen',
    });
    const audit = await services.adminAudits().listForTarget(transferId, 10);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'TICKET_TRANSFER_RELEASE',
          adminId: 'ops_release_admin',
          reason: 'Recipient identity issue resolved',
          after: expect.objectContaining({ pendingTransferId: null }),
        }),
      ]),
    );
    const released = await services.repos().entitlements.createTicketTransfer(
      createTicketTransfer({
        id: 'TRF-support-release-retry',
        entitlementId,
        eventId: entitlement.eventId,
        senderUserId: 'guest_owner',
        recipientUserId: 'guest_next_recipient',
        expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        now,
      }),
      'guest_owner',
    );
    expect(released.status).toBe('pending');
  });
});
