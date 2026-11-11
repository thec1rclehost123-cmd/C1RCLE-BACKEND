import { afterEach, describe, expect, it, vi } from 'vitest';

import * as otpModel from '../../domain/models/email-otp.js';
import { MemoryEmailOtpRepository } from '../../infrastructure/memory/memory-email-otp-repository.js';
import { MemoryUserAccountRepository } from '../../infrastructure/memory/memory-user-account-repository.js';

import { createEmailOtpService } from './email-otp-service.js';

import type { EmailSender } from '../../domain/ports/email-sender.js';

class FakeClock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class CapturingEmailSender implements EmailSender {
  readonly name = 'capturing';
  sent: { recipient: string; code: string }[] = [];
  resetLinks: { recipient: string; resetUrl: string }[] = [];
  async sendOtpEmail(recipient: string, code: string): Promise<void> {
    this.sent.push({ recipient, code });
  }
  async sendStaffInvitationEmail(): Promise<void> {
    // unused by these tests
  }
  async sendOnboardingChangesRequestedEmail(): Promise<void> {
    // unused by these tests
  }
  async sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void> {
    this.resetLinks.push({ recipient, resetUrl });
  }
}

function firstSent(sender: CapturingEmailSender, index = 0): { recipient: string; code: string } {
  const first = sender.sent[index];
  if (!first) throw new Error('expected sendOtpEmail to have been called');
  return first;
}

function build() {
  const clock = new FakeClock(new Date('2026-09-08T00:00:00.000Z'));
  const users = new MemoryUserAccountRepository();
  users.save({
    id: 'account-foo',
    email: 'foo@example.com',
    name: 'Test account',
    image: null,
    role: 'guest',
    emailVerified: false,
    createdAt: clock.now().getTime(),
    updatedAt: clock.now().getTime(),
  });
  const emailOtp = new MemoryEmailOtpRepository(users);
  const emailSender = new CapturingEmailSender();
  const service = createEmailOtpService({
    emailOtp,
    users,
    emailSender,
    config: { clock, emailOtpSecret: 'test-email-otp-secret' } as never,
  });
  return { service, clock, emailOtp, emailSender, users };
}

describe('EmailOtpService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('persists verification only for the account bound to the sent code', async () => {
    const { service, emailSender, users, emailOtp } = build();
    const account = await users.getById('account-foo');
    if (!account) throw new Error('Expected account');
    users.save({ ...account, id: 'account-other', email: 'other@example.com' });
    await service.send(' FOO@example.com ');
    await service.verify('foo@example.com', firstSent(emailSender).code);
    expect(await users.getById('account-foo')).toMatchObject({ emailVerified: true });
    expect(await users.getById('account-other')).toMatchObject({ emailVerified: false });
    expect(await emailOtp.get('foo@example.com')).toBeNull();
  });

  it('leaves the OTP usable when the account write fails', async () => {
    const { service, emailSender, users, emailOtp } = build();
    await service.send('foo@example.com');
    const code = firstSent(emailSender).code;
    vi.spyOn(users, 'save').mockImplementationOnce(() => {
      throw new Error('account write unavailable');
    });
    await expect(service.verify('foo@example.com', code)).rejects.toThrow(
      /account write unavailable/,
    );
    expect(await emailOtp.get('foo@example.com')).not.toBeNull();
    expect(await users.getById('account-foo')).toMatchObject({ emailVerified: false });
    await service.verify('foo@example.com', code);
    expect(await users.getById('account-foo')).toMatchObject({ emailVerified: true });
  });

  it('rejects a code if its account email changed and was reassigned', async () => {
    const { service, emailSender, users, emailOtp } = build();
    await service.send('foo@example.com');
    const account = await users.getById('account-foo');
    if (!account) throw new Error('Expected account');
    users.save({ ...account, email: 'changed@example.com' });
    users.save({ ...account, id: 'replacement-account' });
    await expect(service.verify('foo@example.com', firstSent(emailSender).code)).rejects.toThrow();
    expect(await users.getById('replacement-account')).toMatchObject({ emailVerified: false });
    expect(await users.getById('account-foo')).toMatchObject({ emailVerified: false });
    expect(await emailOtp.get('foo@example.com')).not.toBeNull();
  });

  it('does not send codes for a missing account', async () => {
    const { service, emailSender } = build();
    await expect(service.send('missing@example.com')).rejects.toThrow();
    expect(emailSender.sent).toHaveLength(0);
  });

  it('removes only the undelivered code when the sender fails', async () => {
    const { service, emailOtp, emailSender } = build();
    vi.spyOn(emailSender, 'sendOtpEmail').mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(service.send('foo@example.com')).rejects.toThrow('provider unavailable');
    expect(await emailOtp.get('foo@example.com')).toBeNull();
  });

  it('allows only one concurrent send for a normalized recipient', async () => {
    const { service, emailSender } = build();
    const results = await Promise.allSettled([
      service.send(' Foo@Example.com '),
      service.send('foo@example.com'),
      service.send('FOO@example.com'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(emailSender.sent).toHaveLength(1);
  });

  it('counts concurrent wrong codes exactly and locks out at five attempts', async () => {
    const { service, emailSender, emailOtp } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    const wrong = code === '000000' ? '111111' : '000000';
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.verify('foo@example.com', wrong)),
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect((await emailOtp.get('foo@example.com'))?.attempts).toBe(5);
    await expect(service.verify('foo@example.com', code)).rejects.toThrow(/Too many attempts/);
  });

  it('allows only one concurrent consumption of a valid code', async () => {
    const { service, emailSender, emailOtp } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    const results = await Promise.allSettled([
      service.verify('foo@example.com', code),
      service.verify('FOO@example.com', code),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await emailOtp.get('foo@example.com')).toBeNull();
  });

  it('does not let an old verification delete a concurrently resent code', async () => {
    vi.spyOn(otpModel, 'generateEmailOtpCode')
      .mockReturnValueOnce('123456')
      .mockReturnValueOnce('654321');
    const { service, clock, emailSender, emailOtp } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    clock.advance(60_000);
    await Promise.allSettled([
      service.send('foo@example.com'),
      service.verify('foo@example.com', code),
    ]);
    expect(emailSender.sent).toHaveLength(2);
    expect(await emailOtp.get('foo@example.com')).not.toBeNull();
    await expect(
      service.verify('foo@example.com', firstSent(emailSender, 1).code),
    ).resolves.toBeUndefined();
  });

  it('rechecks expiry if the repository retries a verification transition', async () => {
    const { service, clock, emailSender, emailOtp } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    const current = await emailOtp.get('foo@example.com');
    const update = emailOtp.updateAtomically.bind(emailOtp);
    vi.spyOn(emailOtp, 'updateAtomically').mockImplementationOnce((recipient, transition) => {
      transition(current); // Simulate a valid first attempt that loses a write conflict.
      clock.advance(10 * 60_000);
      return update(recipient, transition);
    });
    await expect(service.verify('foo@example.com', code)).rejects.toThrow(/expired/);
    expect(await emailOtp.get('foo@example.com')).toEqual(current);
  });

  it('rejects a code at its exact expiry without incrementing attempts', async () => {
    const { service, clock, emailSender, emailOtp } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    clock.advance(10 * 60_000);
    await expect(service.verify('foo@example.com', code)).rejects.toThrow(/expired/);
    expect((await emailOtp.get('foo@example.com'))?.attempts).toBe(0);
  });

  it('sends a code and verifies it successfully', async () => {
    const { service, emailSender } = build();
    await service.send('Foo@Example.com');
    expect(emailSender.sent).toHaveLength(1);
    const { recipient, code } = firstSent(emailSender);
    expect(recipient).toBe('foo@example.com');
    await expect(service.verify('foo@example.com', code)).resolves.toBeUndefined();
  });

  it('rejects verify with no send in progress', async () => {
    const { service } = build();
    await expect(service.verify('nobody@example.com', '123456')).rejects.toThrow(
      /No verification in progress/,
    );
  });

  it('rejects the wrong code and rejects a replay of the correct code after success', async () => {
    const { service, emailSender } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(service.verify('foo@example.com', wrong)).rejects.toThrow(
      /Invalid authorization code/,
    );
    await service.verify('foo@example.com', code);
    // Single-use: the record is deleted on success, so re-verifying (even the
    // correct code) now looks like "no verification in progress".
    await expect(service.verify('foo@example.com', code)).rejects.toThrow(
      /No verification in progress/,
    );
  });

  it('requires an unbound legacy code to be resent before verifying an account', async () => {
    const { service, emailOtp, clock, users } = build();
    await emailOtp.save(
      otpModel.createEmailOtp('foo@example.com', '123456', 'test-email-otp-secret', clock.now()),
    );
    await expect(service.verify('foo@example.com', '123456')).rejects.toThrow(/Request a new code/);
    expect(await users.getById('account-foo')).toMatchObject({ emailVerified: false });
    expect(await emailOtp.get('foo@example.com')).not.toBeNull();
  });

  it('enforces the 60s resend cooldown', async () => {
    const { service, clock } = build();
    await service.send('foo@example.com');
    await expect(service.send('foo@example.com')).rejects.toThrow(/wait/);
    clock.advance(60_001);
    await expect(service.send('foo@example.com')).resolves.toBeUndefined();
  });

  it('locks out after 5 failed attempts, even with the eventual right code', async () => {
    const { service, emailSender } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(service.verify('foo@example.com', wrong)).rejects.toThrow();
    }
    await expect(service.verify('foo@example.com', code)).rejects.toThrow(/Too many attempts/);
  });

  it('rejects an expired code', async () => {
    const { service, clock, emailSender } = build();
    await service.send('foo@example.com');
    const { code } = firstSent(emailSender);
    clock.advance(10 * 60_000 + 1);
    await expect(service.verify('foo@example.com', code)).rejects.toThrow(/expired/);
  });
});
