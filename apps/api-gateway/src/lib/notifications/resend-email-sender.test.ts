import { noopLogger } from '@c1rcle/core';
import { PermanentEmailDeliveryError } from '@c1rcle/core/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@c1rcle/core';

import { ResendEmailSender } from './resend-email-sender.js';

describe('ResendEmailSender transactional delivery', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes stable provider idempotency and returns only the provider message id', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sender = new ResendEmailSender('test-key', 'test', noopLogger);
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      }),
    ).resolves.toEqual({ providerMessageId: 'email_1' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      'Idempotency-Key': 'booking-receipt:ord_1:fulfilled',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('classifies non-retryable provider client errors without exposing response content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('sensitive provider response', { status: 422 })),
    );
    const sender = new ResendEmailSender('test-key', 'test', noopLogger);
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      }),
    ).rejects.toBeInstanceOf(PermanentEmailDeliveryError);
  });

  it('does not log credentials or recipient data when development email delivery is suppressed', async () => {
    const info = vi.fn((_message: string, _fields?: Record<string, unknown>) => {});
    const logger: Logger = { info, warn: () => {}, error: () => {} };
    const sender = new ResendEmailSender(undefined, 'test', logger);
    const secretValues = {
      otp: '123456',
      temporaryPassword: 'temporary-password-secret',
      resetUrl: 'https://example.test/reset?token=reset-secret',
      recipient: 'private@example.test',
    };

    await sender.sendOtpEmail(secretValues.recipient, secretValues.otp);
    await sender.sendStaffInvitationEmail({
      to: secretValues.recipient,
      orgName: 'Test Organization',
      role: 'member',
      capabilities: [],
      expiresAt: '2026-11-01T00:00:00.000Z',
      temporaryPassword: secretValues.temporaryPassword,
    });
    await sender.sendPasswordResetEmail(secretValues.recipient, secretValues.resetUrl);

    expect(info).toHaveBeenNthCalledWith(1, 'dev_email_otp', { delivery: 'suppressed' });
    expect(info).toHaveBeenNthCalledWith(2, 'dev_email_staff_invitation', {
      delivery: 'suppressed',
    });
    expect(info).toHaveBeenNthCalledWith(3, 'dev_email_password_reset', {
      delivery: 'suppressed',
    });
    const logged = JSON.stringify(info.mock.calls);
    for (const secret of Object.values(secretValues)) expect(logged).not.toContain(secret);
  });
});
