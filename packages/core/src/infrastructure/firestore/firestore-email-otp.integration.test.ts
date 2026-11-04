import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createEmailOtpService } from '../../application/auth/email-otp-service.js';
import * as otpModel from '../../domain/models/email-otp.js';

import { FirestoreEmailOtpRepository } from './firestore-email-otp-repository.js';
import { FirestoreUserAccountRepository } from './firestore-user-account-repository.js';

import type { ServiceDeps } from '../../application/context.js';
import type { EmailSender } from '../../domain/ports/email-sender.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('email OTP atomicity (local Firestore emulator)', () => {
  let db: Firestore;
  const recipients: string[] = [];

  beforeAll(() => {
    if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR)) {
      throw new Error('OTP integration tests require a loopback Firestore emulator');
    }
    db = new Firestore({ projectId: 'c1rcle-v2', host: EMULATOR, ssl: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      recipients.splice(0).map((email) => db.collection('v2_email_otps').doc(email).delete()),
    );
    await Promise.all(
      accountIds.splice(0).map((id) => db.collection('v2_auth_users').doc(id).delete()),
    );
  });

  afterAll(async () => {
    await db.terminate();
  });

  const accountIds: string[] = [];

  async function fixture() {
    const recipient = `packet-1-2-${randomUUID()}@example.invalid`;
    recipients.push(recipient);
    const userId = `otp-account-${randomUUID()}`;
    accountIds.push(userId);
    await db.collection('v2_auth_users').doc(userId).set({
      email: recipient,
      name: 'Emulator OTP account',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    let now = new Date('2026-11-03T12:00:00.000Z');
    const sent: string[] = [];
    const emailSender = {
      sendOtpEmail: (_recipient: string, code: string) => {
        sent.push(code);
        return Promise.resolve();
      },
    } as unknown as EmailSender;
    const config = {
      clock: { now: () => now },
      emailOtpSecret: 'emulator-only-otp-secret',
    } as ServiceDeps['config'];
    const repo = new FirestoreEmailOtpRepository(db);
    const makeService = () =>
      createEmailOtpService({
        emailOtp: new FirestoreEmailOtpRepository(db),
        users: new FirestoreUserAccountRepository(db),
        emailSender,
        config,
      });
    return {
      recipient,
      repo,
      services: [makeService(), makeService()],
      code: (index = 0) => {
        const value = sent[index];
        if (!value) throw new Error('Expected a captured OTP');
        return value;
      },
      sent,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  it('serializes initial sends and resends across repository instances', async () => {
    const { recipient, services, sent, advance } = await fixture();
    for (const _round of [0, 1]) {
      const results = await Promise.allSettled(services.map((service) => service.send(recipient)));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      advance(60_000);
    }
    expect(sent).toHaveLength(2);
  }, 45_000);

  it('commits all failed attempts and preserves lockout', async () => {
    const { recipient, services, code, repo } = await fixture();
    const service = services[0];
    if (!service) throw new Error('Expected service');
    await service.send(recipient);
    const wrong = code() === '000000' ? '111111' : '000000';
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => {
        const verifier = services[i % services.length];
        if (!verifier) throw new Error('Expected verifier');
        return verifier.verify(recipient, wrong);
      }),
    );
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ message: 'Invalid authorization code.' });
    }
    expect((await repo.get(recipient))?.attempts).toBe(5);
    await expect(service.verify(recipient, code())).rejects.toThrow(/Too many attempts/);
  }, 45_000);

  it('consumes once across repository instances', async () => {
    const { recipient, services, code, repo } = await fixture();
    const sender = services[0];
    if (!sender) throw new Error('Expected sender');
    await sender.send(recipient);
    const results = await Promise.allSettled(
      services.map((service) => service.verify(recipient, code())),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await repo.get(recipient)).toBeNull();
  }, 45_000);

  it('does not consume a replacement code during resend versus verify', async () => {
    vi.spyOn(otpModel, 'generateEmailOtpCode')
      .mockReturnValueOnce('123456')
      .mockReturnValueOnce('654321');
    const { recipient, services, code, repo, advance } = await fixture();
    const [sender, verifier] = services;
    if (!sender || !verifier) throw new Error('Expected two services');
    await sender.send(recipient);
    advance(60_000);
    const [resend] = await Promise.allSettled([
      sender.send(recipient),
      verifier.verify(recipient, code()),
    ]);
    expect(resend?.status).toBe('fulfilled');
    expect(await repo.get(recipient)).not.toBeNull();
    await expect(verifier.verify(recipient, code(1))).resolves.toBeUndefined();
  }, 45_000);

  it('rejects at expiry without consuming or incrementing attempts', async () => {
    const { recipient, services, code, repo, advance } = await fixture();
    const service = services[0];
    if (!service) throw new Error('Expected service');
    await service.send(recipient);
    advance(10 * 60_000);
    await expect(service.verify(recipient, code())).rejects.toThrow(/expired/);
    expect((await repo.get(recipient))?.attempts).toBe(0);
  }, 45_000);
});
