import { createHash, randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { createTicketAccessCode } from '../../domain/models/ticket-access.js';

import { FirestoreTicketAccessRepository } from './firestore-ticket-access-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Firestore ticket access redemption', () => {
  it('atomically caps claims, converges same-user retries, and revokes grants immediately', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const codeId = createHash('sha256').update(`m5-access-${suffix}`).digest('hex');
    const invitationId = createHash('sha256').update(`m5-invitation-${suffix}`).digest('hex');
    const eventCodeId = createHash('sha256').update(`m5-event-access-${suffix}`).digest('hex');
    const now = new Date();
    const repo = new FirestoreTicketAccessRepository(db);
    const code = createTicketAccessCode({
      id: codeId,
      eventId: `m5-access-event-${suffix}`,
      organizationId: `m5-access-org-${suffix}`,
      tierIds: [`m5-access-tier-${suffix}`],
      createdBy: `m5-access-host-${suffix}`,
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      maxRedemptions: 1,
      now,
    });
    const grantA = createHash('sha256').update(`${codeId}:guest-a-${suffix}`).digest('hex');
    const grantB = createHash('sha256').update(`${codeId}:guest-b-${suffix}`).digest('hex');
    const invitationEmailHash = createHash('sha256')
      .update(`invite-${suffix}@example.test`)
      .digest('hex');
    const accessGrantedEvent = (grantId: string, userId: string) =>
      domainEvent({
        id: deterministicDomainEventId('ticket.access.granted', grantId),
        type: 'ticket.access.granted',
        aggregateId: grantId,
        organizationId: code.organizationId,
        actorId: userId,
        occurredAt: now.getTime(),
        payload: {
          grantId,
          eventId: code.eventId,
          scope: 'tiers' as const,
          tierIds: [...code.tierIds],
        },
      });

    try {
      await repo.createCode(code);
      const attempts = await Promise.all([
        repo.redeem({
          codeId,
          grantId: grantA,
          userId: `guest-a-${suffix}`,
          now,
          outboxEvent: accessGrantedEvent(grantA, `guest-a-${suffix}`),
        }),
        repo.redeem({
          codeId,
          grantId: grantB,
          userId: `guest-b-${suffix}`,
          now,
          outboxEvent: accessGrantedEvent(grantB, `guest-b-${suffix}`),
        }),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      const grantEvents = await db
        .collection('v2_outbox')
        .where('aggregateId', 'in', [grantA, grantB])
        .get();
      expect(grantEvents.docs).toHaveLength(1);
      expect(grantEvents.docs[0]?.get('type')).toBe('ticket.access.granted');
      expect(JSON.stringify(grantEvents.docs[0]?.get('payload'))).not.toContain(codeId);
      expect(JSON.stringify(grantEvents.docs[0]?.get('payload'))).not.toContain(
        invitationEmailHash,
      );
      expect(await repo.getCodeById(codeId)).toMatchObject({ redemptionCount: 1 });

      const winner = attempts[0] ?? attempts[1];
      expect(winner).not.toBeNull();
      if (!winner) return;
      const retry = await repo.redeem({
        codeId,
        grantId: winner.grant.id,
        userId: winner.grant.userId,
        now,
      });
      expect(retry).toEqual(winner);

      await repo.revokeCode(codeId, `m5-access-host-${suffix}`, 'Disposable test revocation', now);
      expect(await repo.getCodeById(codeId)).toMatchObject({ status: 'revoked' });
      expect(
        await repo.redeem({
          codeId,
          grantId: createHash('sha256').update(`${codeId}:guest-c-${suffix}`).digest('hex'),
          userId: `guest-c-${suffix}`,
          now,
        }),
      ).toBeNull();

      await repo.createCode(
        createTicketAccessCode({
          id: invitationId,
          kind: 'invitation',
          recipientEmailHash: invitationEmailHash,
          eventId: `m5-access-event-${suffix}`,
          organizationId: `m5-access-org-${suffix}`,
          tierIds: [`m5-invited-tier-${suffix}`],
          createdBy: `m5-access-host-${suffix}`,
          startsAt: new Date(now.getTime() - 60_000).toISOString(),
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
          maxRedemptions: 1,
          now,
        }),
      );
      expect(
        await repo.redeem({
          codeId: invitationId,
          grantId: createHash('sha256').update(`${invitationId}:wrong-${suffix}`).digest('hex'),
          userId: `wrong-${suffix}`,
          recipientEmailHash: 'f'.repeat(64),
          now,
        }),
      ).toBeNull();
      const invitationGrantId = createHash('sha256')
        .update(`${invitationId}:invitee-${suffix}`)
        .digest('hex');
      const invited = await repo.redeem({
        codeId: invitationId,
        grantId: invitationGrantId,
        userId: `invitee-${suffix}`,
        recipientEmailHash: invitationEmailHash,
        now,
      });
      expect(invited?.grant.userId).toBe(`invitee-${suffix}`);
      expect((await repo.getCodeById(invitationId))?.recipientEmailHash).toBe(invitationEmailHash);

      await repo.createCode(
        createTicketAccessCode({
          id: eventCodeId,
          scope: 'event',
          eventId: `m5-access-event-${suffix}`,
          organizationId: `m5-access-org-${suffix}`,
          tierIds: [],
          createdBy: `m5-access-host-${suffix}`,
          startsAt: new Date(now.getTime() - 60_000).toISOString(),
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
          maxRedemptions: 5,
          now,
        }),
      );
      const eventGrantId = createHash('sha256').update(`${eventCodeId}:event-guest`).digest('hex');
      const eventGrant = await repo.redeem({
        codeId: eventCodeId,
        grantId: eventGrantId,
        userId: 'event-guest',
        now,
      });
      expect(eventGrant?.grant).toMatchObject({ scope: 'event', tierIds: [] });
      expect(await repo.getCodeById(eventCodeId)).toMatchObject({ scope: 'event', tierIds: [] });
    } finally {
      const grants = await db
        .collection('v2_ticket_access_grants')
        .where('eventId', '==', `m5-access-event-${suffix}`)
        .get();
      await Promise.all(grants.docs.map((doc) => doc.ref.delete()));
      const outbox = await db
        .collection('v2_outbox')
        .where('aggregateId', 'in', [grantA, grantB])
        .get();
      await Promise.all(outbox.docs.map((doc) => doc.ref.delete()));
      await db.collection('v2_ticket_access_codes').doc(codeId).delete();
      await db.collection('v2_ticket_access_codes').doc(invitationId).delete();
      await db.collection('v2_ticket_access_codes').doc(eventCodeId).delete();
      await db.terminate();
    }
  }, 30_000);
});
