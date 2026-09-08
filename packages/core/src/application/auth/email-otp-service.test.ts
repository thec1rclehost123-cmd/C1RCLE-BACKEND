import { describe, expect, it } from 'vitest';

import { MemoryEmailOtpRepository } from '../../infrastructure/memory/memory-email-otp-repository.js';

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
  async sendOtpEmail(recipient: string, code: string): Promise<void> {
    this.sent.push({ recipient, code });
  }
}

function firstSent(sender: CapturingEmailSender): { recipient: string; code: string } {
  const [first] = sender.sent;
  if (!first) throw new Error('expected sendOtpEmail to have been called');
  return first;
}

function build() {
  const clock = new FakeClock(new Date('2026-09-08T00:00:00.000Z'));
  const emailOtp = new MemoryEmailOtpRepository();
  const emailSender = new CapturingEmailSender();
  const service = createEmailOtpService({
    emailOtp,
    emailSender,
    config: { clock } as never,
  });
  return { service, clock, emailOtp, emailSender };
}

describe('EmailOtpService', () => {
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
