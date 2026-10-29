import { createHash } from 'node:crypto';

import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import { eventMaterialChangeSubjectId, notificationId } from '../../domain/models/social.js';
import { createTicketTransfer } from '../../domain/models/ticket-transfer.js';

import type { EntityId } from '../../domain/identity.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { TicketTransfer } from '../../domain/models/ticket-transfer.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── TicketService (Phase 4 PR3) ───────────────────────────────────────────────
 * Guest ticket reads and identity-bound transfer lifecycle. Transfer writes
 * remain disabled unless the deployment explicitly enables M5's feature flag.
 *
 * A ticket read is scoped to its current holder, with a missing or explicit
 * null current-holder field falling back to purchaser custody for legacy and
 * unassigned units. A mismatch reports as 404, never 403.
 */
export class TicketService {
  constructor(private readonly deps: ServiceDeps) {}

  async getById(ticketId: EntityId, actor: ActorContext): Promise<Entitlement> {
    const entitlement = await this.deps.repositories.entitlements.getById(ticketId);
    const holderUserId = entitlement?.currentHolderUserId ?? entitlement?.userId;
    if (!entitlement || holderUserId !== actor.userId) {
      throw new NotFoundError('Ticket', ticketId);
    }
    return entitlement;
  }

  async respondToMaterialEventChange(
    ticketId: EntityId,
    eventVersion: number,
    response: 'accepted' | 'refund_requested',
    actor: ActorContext,
  ) {
    if (!actor.userId)
      throw new UnauthorizedError('A session is required to respond to event changes');
    if (!Number.isSafeInteger(eventVersion) || eventVersion < 1) {
      throw new ConflictError('A valid event-change version is required');
    }
    const entitlement = await this.deps.repositories.entitlements.getById(ticketId);
    if (!entitlement) throw new NotFoundError('Ticket', ticketId);
    const order = await this.deps.repositories.orders.getById(entitlement.orderId);
    const isCurrentHolder = currentEntitlementHolderId(entitlement) === actor.userId;
    const isPurchaser = order?.userId === actor.userId;
    if (
      !order ||
      order.eventId !== entitlement.eventId ||
      (response === 'accepted' && !isCurrentHolder) ||
      (response === 'refund_requested' && !isPurchaser)
    ) {
      throw new NotFoundError('Ticket', ticketId);
    }
    const event = await this.deps.repositories.events.getById(entitlement.eventId);
    if (
      !event ||
      !['paid', 'refund_requested'].includes(order.status) ||
      event.status === 'cancelled' ||
      Date.parse(event.startAt) <= this.deps.config.clock.now().getTime() ||
      entitlement.status !== 'valid' ||
      entitlement.scanCount !== 0 ||
      entitlement.refundLock ||
      entitlement.pendingTransferId
    ) {
      throw new ConflictError('This ticket is no longer eligible for an event-change response');
    }
    const subjectId = eventMaterialChangeSubjectId(
      entitlement.eventId,
      eventVersion,
      order.id,
      entitlement.id,
    );
    const noticeId = notificationId(actor.userId, 'event.material_change', subjectId);
    const notice = await this.deps.repositories.socialNotifications.getById(noticeId);
    if (
      !notice ||
      notice.userId !== actor.userId ||
      notice.type !== 'event.material_change' ||
      notice.eventChange?.eventVersion !== eventVersion ||
      notice.eventChange.entitlementId !== entitlement.id
    ) {
      throw new NotFoundError('Event change notice', noticeId);
    }
    const result = await this.deps.repositories.socialNotifications.respondToMaterialChange(
      actor.userId,
      noticeId,
      response,
      this.deps.config.clock.now().toISOString(),
    );
    if (response === 'refund_requested') {
      await this.deps.outbox.append(
        domainEvent({
          id: deterministicDomainEventId(
            'event.material_change.refund_requested',
            entitlement.eventId,
            entitlement.id,
            String(eventVersion),
          ),
          type: 'event.material_change.refund_requested',
          aggregateId: entitlement.id,
          organizationId: entitlement.organizationId,
          actorId: actor.userId,
          payload: {
            eventId: entitlement.eventId,
            orderId: order.id,
            entitlementId: entitlement.id,
            eventVersion,
          },
          occurredAt: this.deps.config.clock.now().getTime(),
        }),
      );
    }
    return {
      entitlementId: entitlement.id,
      eventVersion,
      response: result.notification.eventChangeResponse?.response ?? response,
      respondedAt: result.notification.eventChangeResponse?.respondedAt ?? null,
      replayed: result.replayed,
      refundCreated: false as const,
    };
  }

  async requestTransfer(
    ticketId: EntityId,
    recipientEmail: string,
    actor: ActorContext,
  ): Promise<TicketTransfer> {
    this.requireTransferFeature();
    if (!actor.userId) throw new UnauthorizedError('A session is required to transfer tickets');
    const normalizedEmail = recipientEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new ConflictError('A valid recipient email is required for ticket transfer');
    }
    const invitedAccount = await this.deps.repositories.users.getByEmail(normalizedEmail);
    const recipientUserId =
      invitedAccount?.emailVerified && invitedAccount.id !== actor.userId
        ? invitedAccount.id
        : null;
    let entitlement = await this.deps.repositories.entitlements.getById(ticketId);
    const holderUserId = entitlement ? currentEntitlementHolderId(entitlement) : null;
    const isPurchaserCustodian =
      entitlement?.userId === actor.userId && entitlement.currentHolderUserId === null;
    if (!entitlement || (holderUserId !== actor.userId && !isPurchaserCustodian)) {
      throw new NotFoundError('Ticket', ticketId);
    }
    if (isFreeRsvp(entitlement)) {
      throw new ConflictError('Free RSVPs cannot be transferred');
    }
    const cover = await this.deps.repositories.eventCoverAccounts?.getByEntitlement(entitlement.id);
    if (cover && (cover.status !== 'active' || cover.reservedPaise > 0)) {
      throw new ConflictError(
        'Ticket transfer is unavailable while event cover is reserved or frozen',
      );
    }
    const now = this.deps.config.clock.now();
    if (entitlement.pendingTransferId) {
      const previous = await this.deps.repositories.entitlements.getTicketTransfer(
        entitlement.pendingTransferId,
      );
      if (previous) await this.expireTransferIfNeeded(previous, actor.userId, now);
      entitlement = await this.deps.repositories.entitlements.getById(ticketId);
      const currentHolder = entitlement ? currentEntitlementHolderId(entitlement) : null;
      const stillPurchaserCustodian =
        entitlement?.userId === actor.userId && entitlement.currentHolderUserId === null;
      if (!entitlement || (currentHolder !== actor.userId && !stillPurchaserCustodian)) {
        throw new NotFoundError('Ticket', ticketId);
      }
    }
    const eventRecord = await this.deps.repositories.events.getById(entitlement.eventId);
    if (!eventRecord) throw new NotFoundError('Event', entitlement.eventId);
    const eventStart = Date.parse(eventRecord.startAt);
    if (
      eventRecord.status === 'cancelled' ||
      !Number.isFinite(eventStart) ||
      now.getTime() >= eventStart
    ) {
      throw new ConflictError('Ticket transfers close when the event starts');
    }
    const transfer = createTicketTransfer({
      id: this.deps.config.ids(),
      entitlementId: entitlement.id,
      eventId: entitlement.eventId,
      senderUserId: actor.userId,
      recipientEmailHash: createHash('sha256').update(normalizedEmail).digest('hex'),
      ...(recipientUserId ? { recipientUserId } : {}),
      expiresAt: new Date(Math.min(now.getTime() + 24 * 60 * 60 * 1000, eventStart)).toISOString(),
      now,
    });
    const outboxEvent = domainEvent({
      id: deterministicDomainEventId('ticket.transfer.created', transfer.id),
      type: 'ticket.transfer.created',
      aggregateId: entitlement.id,
      organizationId: entitlement.organizationId,
      actorId: actor.userId,
      payload: {
        transferId: transfer.id,
        entitlementId: entitlement.id,
        eventId: entitlement.eventId,
        recipientBinding: transfer.recipientUserId ? 'account' : 'verified_email',
        expiresAt: transfer.expiresAt,
      },
      occurredAt: now.getTime(),
    });
    const created = await this.deps.repositories.entitlements.createTicketTransfer(
      transfer,
      actor.userId,
      outboxEvent,
    );
    // The Firestore adapter writes this in the ownership transaction. The
    // idempotent append keeps the in-memory adapter wired to the same event;
    // in Firestore it is a no-op because the row already exists.
    await this.deps.outbox.append(outboxEvent);
    return created;
  }

  async resolveTransfer(
    transferId: EntityId,
    action: 'accept' | 'decline' | 'cancel',
    actor: ActorContext,
  ): Promise<{ transfer: TicketTransfer; entitlement?: Entitlement }> {
    this.requireTransferFeature();
    if (!actor.userId) throw new UnauthorizedError('A session is required to manage transfers');
    const existing = await this.deps.repositories.entitlements.getTicketTransfer(transferId);
    if (
      !existing ||
      (action === 'cancel'
        ? existing.senderUserId !== actor.userId
        : existing.recipientUserId !== actor.userId && !existing.recipientEmailHash)
    ) {
      throw new NotFoundError('Ticket transfer', transferId);
    }
    let recipientEmailHash: string | undefined;
    if (action !== 'cancel') {
      const recipient = await this.deps.repositories.users.getById(actor.userId);
      if (!recipient?.emailVerified) throw new NotFoundError('Ticket transfer', transferId);
      recipientEmailHash = createHash('sha256')
        .update(recipient.email.trim().toLowerCase())
        .digest('hex');
      if (
        existing.recipientUserId !== actor.userId &&
        existing.recipientEmailHash !== recipientEmailHash
      ) {
        throw new NotFoundError('Ticket transfer', transferId);
      }
    }
    const now = this.deps.config.clock.now();
    const entitlement = await this.deps.repositories.entitlements.getById(existing.entitlementId);
    if (!entitlement) throw new NotFoundError('Ticket', existing.entitlementId);
    if (action === 'accept') {
      if (isFreeRsvp(entitlement)) {
        throw new ConflictError('Free RSVPs cannot be transferred');
      }
    }
    if (existing.status !== 'pending') {
      await this.deps.outbox.append(
        this.transferResolvedEvent(
          existing as Omit<TicketTransfer, 'status'> & {
            status: Exclude<TicketTransfer['status'], 'pending'>;
          },
          entitlement,
          actor.userId,
        ),
      );
      if (existing.status === 'expired') {
        throw new ConflictError('This ticket transfer has expired');
      }
      return {
        transfer: existing,
        ...(action === 'accept' && existing.status === 'accepted' ? { entitlement } : {}),
      };
    }
    const profile =
      action === 'accept'
        ? await this.deps.repositories.guestProfiles.getByUserId(actor.userId)
        : null;
    const expectedStatus =
      Date.parse(existing.expiresAt) <= now.getTime()
        ? 'expired'
        : action === 'accept'
          ? 'accepted'
          : action === 'decline'
            ? 'declined'
            : 'cancelled';
    const outboxEvent = this.transferResolvedEvent(
      { ...existing, status: expectedStatus },
      entitlement,
      actor.userId,
      expectedStatus === 'accepted'
        ? (entitlement.credentialVersion ?? 1) + 1
        : (entitlement.credentialVersion ?? 1),
      now,
    );
    const resolved = await this.deps.repositories.entitlements.resolveTicketTransfer({
      transferId,
      actorUserId: actor.userId,
      action,
      ...(recipientEmailHash ? { recipientEmailHash } : {}),
      ...(action === 'accept' ? { holderName: profile?.displayName ?? 'Guest' } : {}),
      now,
      outboxEvent,
    });
    if (action === 'accept' && resolved.transfer.status === 'accepted') {
      await this.deps.repositories.eventCoverAccounts?.transferHolder?.(
        existing.entitlementId,
        currentEntitlementHolderId(entitlement),
        actor.userId,
        now,
      );
    }
    await this.deps.outbox.append(outboxEvent);
    if (resolved.transfer.status === 'expired') {
      throw new ConflictError('This ticket transfer has expired');
    }
    return {
      transfer: resolved.transfer,
      ...(action === 'accept' ? { entitlement: resolved.entitlement } : {}),
    };
  }

  async resendTransferInvitation(
    transferId: EntityId,
    idempotencyKey: string,
    actor: ActorContext,
  ): Promise<{ requested: true }> {
    this.requireTransferFeature();
    if (!actor.userId) throw new UnauthorizedError('A session is required to manage transfers');
    const transfer = await this.deps.repositories.entitlements.getTicketTransfer(transferId);
    if (!transfer || transfer.senderUserId !== actor.userId) {
      throw new NotFoundError('Ticket transfer', transferId);
    }
    const now = this.deps.config.clock.now();
    if (transfer.status !== 'pending') {
      throw new ConflictError('Only a pending ticket invitation can be resent');
    }
    if (Date.parse(transfer.expiresAt) <= now.getTime()) {
      await this.expireTransferIfNeeded(transfer, actor.userId, now);
      throw new ConflictError('This ticket transfer has expired');
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new ConflictError('A valid invitation retry key is required');
    }
    const entitlement = await this.deps.repositories.entitlements.getById(transfer.entitlementId);
    if (!entitlement || entitlement.pendingTransferId !== transfer.id) {
      throw new ConflictError('This ticket invitation is no longer active');
    }
    const deliveryRequestId = createHash('sha256').update(idempotencyKey).digest('hex');
    await this.deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId(
          'ticket.transfer.invitation_resent',
          transfer.id,
          deliveryRequestId,
        ),
        type: 'ticket.transfer.invitation_resent',
        aggregateId: entitlement.id,
        organizationId: entitlement.organizationId,
        actorId: actor.userId,
        payload: { transferId: transfer.id, deliveryRequestId },
        occurredAt: now.getTime(),
      }),
    );
    return { requested: true };
  }

  async listTransfers(ticketId: EntityId, actor: ActorContext): Promise<TicketTransfer[]> {
    const entitlement = await this.deps.repositories.entitlements.getById(ticketId);
    const holderUserId = entitlement?.currentHolderUserId ?? entitlement?.userId;
    if (!entitlement || (holderUserId !== actor.userId && entitlement.userId !== actor.userId)) {
      throw new NotFoundError('Ticket', ticketId);
    }
    const transfers =
      await this.deps.repositories.entitlements.listTicketTransfersByEntitlement(ticketId);
    const now = this.deps.config.clock.now();
    for (const transfer of transfers) {
      if (transfer.status === 'pending') {
        await this.expireTransferIfNeeded(transfer, actor.userId, now);
      }
    }
    return this.deps.repositories.entitlements.listTicketTransfersByEntitlement(ticketId);
  }

  private async expireTransferIfNeeded(
    transfer: TicketTransfer,
    actorUserId: EntityId,
    now: Date,
  ): Promise<void> {
    if (transfer.status !== 'pending' || Date.parse(transfer.expiresAt) > now.getTime()) return;
    const entitlement = await this.deps.repositories.entitlements.getById(transfer.entitlementId);
    if (!entitlement || entitlement.pendingTransferId !== transfer.id) return;
    const outboxEvent = this.transferResolvedEvent(
      { ...transfer, status: 'expired' },
      entitlement,
      actorUserId,
      entitlement.credentialVersion ?? 1,
      now,
    );
    try {
      await this.deps.repositories.entitlements.resolveTicketTransfer({
        transferId: transfer.id,
        actorUserId,
        action: 'expire',
        now,
        outboxEvent,
      });
      await this.deps.outbox.append(outboxEvent);
    } catch (error) {
      // Another reader/request may have expired this same invitation first.
      // Treat only that completed race as success; preserve other failures.
      const current = await this.deps.repositories.entitlements.getTicketTransfer(transfer.id);
      if (current?.status !== 'expired') throw error;
    }
  }

  /** Expires a bounded batch of stale invitations and releases their ticket locks. */
  async cleanupExpiredTransfers(now = this.deps.config.clock.now(), limit = 100): Promise<number> {
    const expired = await this.deps.repositories.entitlements.listExpiredTicketTransfers(
      now,
      limit,
    );
    let count = 0;
    for (const transfer of expired) {
      await this.expireTransferIfNeeded(transfer, transfer.senderUserId, now);
      if (
        (await this.deps.repositories.entitlements.getTicketTransfer(transfer.id))?.status ===
        'expired'
      ) {
        count += 1;
      }
    }
    return count;
  }

  private requireTransferFeature(): void {
    if (
      this.deps.config.features.m5TicketTransfers !== true ||
      this.deps.config.features.m5OfflineTicketManifests !== false ||
      this.deps.config.features.m5OfflineManifestDrainComplete !== true
    ) {
      throw new ServiceUnavailableError('Ticket transfers are not enabled for this deployment');
    }
  }

  private transferResolvedEvent(
    transfer: Omit<TicketTransfer, 'status'> & {
      status: Exclude<TicketTransfer['status'], 'pending'>;
    },
    entitlement: Entitlement,
    actorUserId: EntityId,
    credentialVersion = entitlement.credentialVersion ?? 1,
    now = this.deps.config.clock.now(),
  ) {
    return domainEvent({
      id: deterministicDomainEventId('ticket.transfer.resolved', transfer.id, transfer.status),
      type: 'ticket.transfer.resolved',
      aggregateId: entitlement.id,
      organizationId: entitlement.organizationId,
      actorId: actorUserId,
      payload: {
        transferId: transfer.id,
        entitlementId: entitlement.id,
        eventId: entitlement.eventId,
        status: transfer.status,
        credentialVersion,
      },
      occurredAt: now.getTime(),
    });
  }

  async listForUser(actor: ActorContext, query: PaginationQuery): Promise<Page<Entitlement>> {
    if (!actor.userId) throw new UnauthorizedError('A session is required to list tickets');
    return this.deps.repositories.entitlements.listByHolder(actor.userId, query);
  }
}

function isFreeRsvp(entitlement: Entitlement): boolean {
  return (
    entitlement.unitKind === 'free_rsvp' ||
    (entitlement.unitKind === undefined && entitlement.orderId.startsWith('RSVP-'))
  );
}
