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
    const sender = new ResendEmailSender(
      'test-key',
      'test',
      noopLogger,
      'THE C1RCLE <test@example.test>',
      'guest@example.test',
    );
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        preheader: 'Your ticket is ready.',
        html: '<p>Safe</p>',
        text: 'Safe text',
        idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      }),
    ).resolves.toEqual({ outcome: 'accepted_by_provider', providerMessageId: 'email_1' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      'Idempotency-Key': 'booking-receipt:ord_1:fulfilled',
    });
    const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    expect(requestBody).toMatchObject({
      from: 'THE C1RCLE <test@example.test>',
      to: 'guest@example.test',
      subject: 'Receipt',
      html: '<p>Safe</p>',
      text: 'Safe text',
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
    const sender = new ResendEmailSender(
      'test-key',
      'test',
      noopLogger,
      'THE C1RCLE <test@example.test>',
      'guest@example.test',
    );
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      }),
    ).rejects.toBeInstanceOf(PermanentEmailDeliveryError);
  });

  it('keeps provider throttling retryable without exposing the provider response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private provider detail', { status: 429 })),
    );
    const sender = new ResendEmailSender(
      'test-key',
      'test',
      noopLogger,
      'THE C1RCLE <test@example.test>',
      'guest@example.test',
    );
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'booking-receipt:ord_429:fulfilled',
      }),
    ).rejects.toThrow('Email provider temporary rejection');
  });

  it('fails closed when provider credentials exist without a configured sender identity', async () => {
    const sender = new ResendEmailSender(
      'test-key',
      'test',
      noopLogger,
      undefined,
      'guest@example.test',
    );
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      }),
    ).rejects.toThrow('Resend sender identity not configured');
  });

  it('never falls back to local capture for production transactional mail', async () => {
    const sender = new ResendEmailSender(
      undefined,
      'production',
      noopLogger,
      'THE C1RCLE <test@example.test>',
    );
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      }),
    ).rejects.toThrow('Email provider not configured');
    expect(sender.localCaptures).toHaveLength(0);
  });

  it('captures instead of sending to non-allowlisted recipients outside production', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sender = new ResendEmailSender(
      'test-key',
      'development',
      noopLogger,
      'THE C1RCLE <test@example.test>',
      'founder@example.test',
    );
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        html: '<p>Captured safely</p>',
        idempotencyKey: 'receipt:order-1',
      }),
    ).resolves.toEqual({ outcome: 'captured_locally', providerMessageId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sender.localCaptures[0]?.recipient).toBe('guest@example.test');
  });

  it('captures transactional content locally without claiming provider acceptance', async () => {
    const sender = new ResendEmailSender(undefined, 'development', noopLogger);
    await expect(
      sender.sendTransactionalEmail({
        to: 'guest@example.test',
        subject: 'Receipt',
        preheader: 'Your ticket is ready.',
        html: '<p>Safe receipt</p>',
        text: 'Safe receipt',
        templateType: 'booking_receipt',
        idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      }),
    ).resolves.toEqual({ outcome: 'captured_locally', providerMessageId: null });
    expect(sender.localCaptures).toHaveLength(1);
    expect(sender.localCaptures[0]).toMatchObject({
      recipient: 'guest@example.test',
      templateType: 'booking_receipt',
      subject: 'Receipt',
      preheader: 'Your ticket is ready.',
      html: '<p>Safe receipt</p>',
      text: 'Safe receipt',
      idempotencyKey: 'booking-receipt:ord_1:fulfilled',
      sender: null,
    });
  });

  it('enforces the exact founder recipient in production before the provider request', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'email_founder' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sender = new ResendEmailSender(
      'test-key',
      'production',
      noopLogger,
      'THE C1RCLE <hello@thec1rcle.com>',
      'aayushdivase2020333@gmail.com',
      true,
    );
    await expect(
      sender.sendTransactionalEmail({
        to: 'other@example.test',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'receipt:other',
      }),
    ).rejects.toBeInstanceOf(PermanentEmailDeliveryError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      sender.sendTransactionalEmail({
        to: 'AayushDivase2020333@gmail.com',
        subject: 'Receipt',
        html: '<p>Safe</p>',
        idempotencyKey: 'receipt:founder',
      }),
    ).resolves.toEqual({ outcome: 'accepted_by_provider', providerMessageId: 'email_founder' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the shared branded shell and the same strict guard for auth mail', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'email_auth' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const sender = new ResendEmailSender(
      'test-key',
      'production',
      noopLogger,
      'THE C1RCLE <hello@thec1rcle.com>',
      'aayushdivase2020333@gmail.com',
      true,
    );
    await expect(
      sender.sendPasswordResetEmail(
        'guest@example.test',
        'https://example.test/reset?token=secret',
      ),
    ).rejects.toBeInstanceOf(PermanentEmailDeliveryError);
    expect(fetchMock).not.toHaveBeenCalled();

    await sender.sendPasswordResetEmail(
      'aayushdivase2020333@gmail.com',
      'https://example.test/reset?token=synthetic-token',
    );
    const call = fetchMock.mock.calls[0];
    const init = call?.[1];
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    expect(payload).toMatchObject({
      from: 'THE C1RCLE <hello@thec1rcle.com>',
      to: 'aayushdivase2020333@gmail.com',
      subject: 'Reset your password',
    });
    expect(payload?.html).toContain('bgcolor="#080808"');
    expect(payload?.html).toContain('RESET PASSWORD');
    expect(payload?.html).toContain('token=synthetic-token');
    expect(payload?.text).toContain(
      'RESET PASSWORD: https://example.test/reset?token=synthetic-token',
    );
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
