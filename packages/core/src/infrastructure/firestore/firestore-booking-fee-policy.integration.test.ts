import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { NON_PRODUCTION_BOOKING_FEE_POLICY } from '../../domain/models/booking-fee-policy.js';
import { MemoryPlatformSettingsRepository } from '../memory/memory-repositories.js';

import { FirestorePlatformSettingsRepository } from './firestore-platform-settings-repository.js';

import type { PlatformSettingsRepository } from '../../domain/ports/repositories.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8089';
for (const native of [false, true]) {
  describe.runIf(!native || emulator)(
    `${native ? 'Native' : 'Memory'} booking policy identity`,
    () => {
      async function fixture() {
        const db = native ? new Firestore({ projectId: `demo-m4-fee-${randomUUID()}` }) : null;
        const repo: PlatformSettingsRepository = db
          ? new FirestorePlatformSettingsRepository(db)
          : new MemoryPlatformSettingsRepository();
        return {
          repo,
          close: async () => {
            if (db) {
              for (const collection of await db.listCollections())
                await db.recursiveDelete(collection);
              await db.terminate();
            }
          },
        };
      }
      it('allows only one competing update from the same settings revision', async () => {
        const f = await fixture();
        try {
          const current = await f.repo.get();
          const first = {
            ...NON_PRODUCTION_BOOKING_FEE_POLICY,
            version: 'race-v2',
            platformFeeBasisPoints: 500,
            paymentFeeBasisPoints: 250,
          };
          const second = { ...first, platformFeeBasisPoints: 250, paymentFeeBasisPoints: 500 };
          const result = await Promise.allSettled([
            f.repo.save({ ...current, bookingFeePolicy: first }, current.revision ?? 0),
            f.repo.save({ ...current, bookingFeePolicy: second }, current.revision ?? 0),
          ]);
          expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
          const saved = await f.repo.get();
          expect(saved.revision).toBe(1);
          expect([first, second]).toContainEqual(saved.bookingFeePolicy);
        } finally {
          await f.close();
        }
      }, 30000);
      it('rejects changed terms for a previously used version, even after another version', async () => {
        const f = await fixture();
        try {
          const a = { ...NON_PRODUCTION_BOOKING_FEE_POLICY, version: 'history-v2' };
          let current = await f.repo.get();
          await f.repo.save({ ...current, bookingFeePolicy: a }, current.revision ?? 0);
          current = await f.repo.get();
          const b = { ...a, version: 'history-v3', platformFeeBasisPoints: 600 };
          await f.repo.save({ ...current, bookingFeePolicy: b }, current.revision ?? 0);
          current = await f.repo.get();
          await expect(
            f.repo.save(
              {
                ...current,
                bookingFeePolicy: { ...a, platformFeeBasisPoints: 250, paymentFeeBasisPoints: 500 },
              },
              current.revision ?? 0,
            ),
          ).rejects.toThrow();
          expect((await f.repo.get()).bookingFeePolicy).toEqual(b);
          await f.repo.save({ ...current, bookingFeePolicy: a }, current.revision ?? 0);
          expect((await f.repo.get()).bookingFeePolicy).toEqual(a);
        } finally {
          await f.close();
        }
      }, 30000);
      it('does not let an unrelated stale settings write restore an old fee policy', async () => {
        const f = await fixture();
        try {
          const stale = await f.repo.get();
          const policy = { ...NON_PRODUCTION_BOOKING_FEE_POLICY, version: 'unrelated-v2' };
          await f.repo.save({ ...stale, bookingFeePolicy: policy }, stale.revision ?? 0);
          await expect(
            f.repo.save({ ...stale, maintenanceMode: true }, stale.revision ?? 0),
          ).rejects.toThrow();
          expect((await f.repo.get()).bookingFeePolicy).toEqual(policy);
          expect((await f.repo.get()).maintenanceMode).toBe(false);
        } finally {
          await f.close();
        }
      }, 30000);
    },
  );
}
