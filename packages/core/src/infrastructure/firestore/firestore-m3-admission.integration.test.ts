import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { createEvent } from '../../domain/models/event.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

import type { Entitlement } from '../../domain/models/entitlement.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('M3 admission invariants (Firestore Emulator)', () => {
  async function fixture() {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const now = new Date();
    const event = {
      ...createEvent({
        id: `evt-m3-admission-${suffix}`,
        organizationId: 'org-m3-admission',
        venueId: 'venue-m3-admission',
        title: 'Admission invariant',
        startAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      }),
      status: 'published' as const,
    };
    const ticket: Entitlement = {
      id: `ENT-m3-admission-${suffix}`,
      orderId: `ORD-m3-admission-${suffix}`,
      eventId: event.id,
      organizationId: event.organizationId,
      tierId: 'tier-m3-admission',
      tierName: 'General',
      userId: 'guest-m3',
      currentHolderUserId: 'guest-m3',
      credentialVersion: 1,
      holderName: 'Guest',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const repo = new FirestoreEntitlementRepository(db);
    await db.collection('v2_events').doc(event.id).set(event);
    await repo.save(ticket);
    const cleanup = async () => {
      const audit = await db.collection('v2_outbox').where('aggregateId', '==', ticket.id).get();
      const ledger = await db
        .collection('v2_scan_ledger')
        .where('entitlementId', '==', ticket.id)
        .get();
      await Promise.all([
        ...audit.docs.map((doc) => doc.ref.delete()),
        ...ledger.docs.map((doc) => doc.ref.delete()),
        db.collection('v2_events').doc(event.id).delete(),
        db.collection('v2_entitlements').doc(ticket.id).delete(),
      ]);
      await db.terminate();
    };
    return { db, repo, event, ticket, now, cleanup };
  }

  it('allows exactly one of two simultaneous device claims and rejects re-entry', async () => {
    const f = await fixture();
    try {
      const results = await Promise.all(
        [1, 2].map((device) =>
          f.repo.claimAdmission(f.ticket.id, f.event.id, {
            requireEventValidation: true,
            admissionAudit: {
              operatorUserId: 'staff-m3',
              deviceId: `scanner-device-${String(device)}`,
              method: 'camera',
            },
            expectedCredentialVersion: 1,
            now: f.now,
          }),
        ),
      );
      expect(results.filter((result) => result.admitted)).toHaveLength(1);
      expect(results.filter((result) => result.denyReason === 'already_used')).toHaveLength(1);
      expect((await f.repo.findById(f.ticket.id))?.scanCount).toBe(1);
      const audit = await f.db
        .collection('v2_outbox')
        .where('aggregateId', '==', f.ticket.id)
        .get();
      expect(audit.docs).toHaveLength(1);
      const ledger = await f.db
        .collection('v2_scan_ledger')
        .where('entitlementId', '==', f.ticket.id)
        .get();
      expect(ledger.docs).toHaveLength(1);
      expect(ledger.docs[0]?.data()).toMatchObject({
        status: 'consumed',
        entitlementId: f.ticket.id,
        admittedCount: 1,
        operatorUid: 'staff-m3',
      });

      expect(audit.docs[0]?.data().payload).toMatchObject({
        type: 'ticket.admitted',
        actorId: 'staff-m3',
        payload: { admittedCount: 1, method: 'camera', scansUsed: 1 },
      });
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  it.each(['cancelled', 'postponed'] as const)(
    'rechecks %s event state inside the claim transaction',
    async (status) => {
      const f = await fixture();
      try {
        await f.db.collection('v2_events').doc(f.event.id).update({ status });
        const results = await Promise.all(
          [1, 2].map(() =>
            f.repo.claimAdmission(f.ticket.id, f.event.id, {
              requireEventValidation: true,
              now: f.now,
            }),
          ),
        );
        expect(
          results.every((result) => !result.admitted && result.denyReason === 'event_closed'),
        ).toBe(true);
        expect((await f.repo.findById(f.ticket.id))?.scanCount).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
    30_000,
  );

  it('serializes cancellation against admission and denies every later claim', async () => {
    const f = await fixture();
    try {
      const [, claim] = await Promise.all([
        f.db.collection('v2_events').doc(f.event.id).update({ status: 'cancelled' }),
        f.repo.claimAdmission(f.ticket.id, f.event.id, {
          requireEventValidation: true,
          now: f.now,
        }),
      ]);
      expect((await f.repo.findById(f.ticket.id))?.scanCount).toBe(claim.admitted ? 1 : 0);
      const later = await f.repo.claimAdmission(f.ticket.id, f.event.id, {
        requireEventValidation: true,
        now: f.now,
      });
      expect(later).toMatchObject({ admitted: false, denyReason: 'event_closed' });
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  it('never spends an unassigned ticket or half a Couple admission', async () => {
    const f = await fixture();
    try {
      const ref = f.db.collection('v2_entitlements').doc(f.ticket.id);
      await ref.update({ currentHolderUserId: null });
      expect(
        await f.repo.claimAdmission(f.ticket.id, f.event.id, {
          requireEventValidation: true,
          now: f.now,
        }),
      ).toMatchObject({ admitted: false });
      await ref.update({ currentHolderUserId: 'guest-m3', scanCountAllowed: 2 });
      expect(
        await f.repo.claimAdmission(f.ticket.id, f.event.id, {
          requireEventValidation: true,
          now: f.now,
        }),
      ).toMatchObject({ admitted: false });
      expect((await f.repo.findById(f.ticket.id))?.scanCount).toBe(0);
      expect(
        await f.repo.claimAdmission(f.ticket.id, f.event.id, {
          requireEventValidation: true,
          seats: 2,
          eligibilityVerified: true,
          now: f.now,
        }),
      ).toMatchObject({ admitted: true, scansUsed: 2 });
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  it('conceals a foreign ticket before evaluating a closed requested event', async () => {
    const f = await fixture();
    const requestedEventId = `${f.event.id}-other`;
    try {
      await f.db
        .collection('v2_events')
        .doc(requestedEventId)
        .set({
          ...f.event,
          id: requestedEventId,
          organizationId: 'other-org',
          status: 'cancelled',
        });
      const claim = await f.repo.claimAdmission(f.ticket.id, requestedEventId, {
        requireEventValidation: true,
        now: f.now,
      });
      expect(claim).toMatchObject({
        admitted: false,
        denyReason: 'wrong_event',
        entitlement: null,
        scansUsed: 0,
        scansAllowed: 0,
      });
      expect((await f.repo.findById(f.ticket.id))?.scanCount).toBe(0);
    } finally {
      await f.db.collection('v2_events').doc(requestedEventId).delete();
      await f.cleanup();
    }
  }, 30_000);

  it('rejects a material venue move even when the Scanner snapshot had no venue', async () => {
    const f = await fixture();
    try {
      await f.db.collection('v2_events').doc(f.event.id).update({ venueId: null });
      await f.db.collection('v2_events').doc(f.event.id).update({ venueId: 'moved-venue' });
      const claim = await f.repo.claimAdmission(f.ticket.id, f.event.id, {
        requireEventValidation: true,
        expectedVenueId: null,
        now: f.now,
      });
      expect(claim).toMatchObject({ admitted: false, denyReason: 'event_closed' });
      expect((await f.repo.findById(f.ticket.id))?.scanCount).toBe(0);
    } finally {
      await f.cleanup();
    }
  }, 30_000);
});
