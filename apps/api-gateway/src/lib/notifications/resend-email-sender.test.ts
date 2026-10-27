import { noopLogger } from '@c1rcle/core';
import { PermanentEmailDeliveryError } from '@c1rcle/core/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
