import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RazorpayPaymentProvider } from './razorpay-adapter.js';

const CONFIG = {
  keyId: 'rzp_test_key',
  keySecret: 'rzp_test_secret',
  webhookSecret: 'webhook_secret',
  baseUrl: 'https://razorpay.test/v1',
};

const provider = () => new RazorpayPaymentProvider(CONFIG);

function jsonResponse(payload: unknown, ok = true, status = 200, statusText = 'OK') {
  return { ok, status, statusText, json: async () => payload } as unknown as Response;
}

function jsonError(payload: unknown) {
  return {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    json: async () => payload,
  } as unknown as Response;
}

function brokenJson(statusText = 'Oops') {
  return {
    ok: false,
    status: 500,
    statusText,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RazorpayPaymentProvider — signature primitives', () => {
  // Known-answer vector, computed independently with
  //   printf 'order_EKwxwAgItmmXdp|pay_EKwxwAgItmmXdp' | openssl dgst -sha256 -hmac '<key secret>'
  // so the expected value does not come from the implementation under test.
  // (This is a self-generated vector for Razorpay's documented scheme
  // HMAC_SHA256(order_id|payment_id, key_secret), not one published by Razorpay.)
  const VECTOR = {
    keySecret: 'rzp_test_key_secret_example',
    orderId: 'order_EKwxwAgItmmXdp',
    paymentId: 'pay_EKwxwAgItmmXdp',
    signature: 'd0bd7ac27b0059bab53e8f01b37f7d9f9f0f9725336fa6738ef59a2c32ff3fe9',
  };
  const vectorProvider = () =>
    new RazorpayPaymentProvider({ ...CONFIG, keySecret: VECTOR.keySecret });

  it('signs order_id|payment_id with the KEY secret (known-answer vector)', () => {
    expect(
      vectorProvider().generateSignature({ paymentId: VECTOR.paymentId, orderId: VECTOR.orderId }),
    ).toBe(VECTOR.signature);
  });

  it('does not use the webhook secret or the old sorted key=value form', () => {
    const signature = provider().generateSignature({ paymentId: 'pay_1', orderId: 'ord_1' });
    const oldWebhookKeyed = createHmac('sha256', CONFIG.webhookSecret)
      .update('orderId=ord_1&paymentId=pay_1')
      .digest('hex');
    const webhookKeyedNewForm = createHmac('sha256', CONFIG.webhookSecret)
      .update('ord_1|pay_1')
      .digest('hex');
    expect(signature).not.toBe(oldWebhookKeyed);
    expect(signature).not.toBe(webhookKeyedNewForm);
    expect(signature).toBe(
      createHmac('sha256', CONFIG.keySecret).update('ord_1|pay_1').digest('hex'),
    );
  });

  describe('verifyPayment — checkout callback', () => {
    const capturedPayment = {
      id: VECTOR.paymentId,
      amount: 1000,
      currency: 'INR',
      status: 'captured',
      captured: true,
      order_id: VECTOR.orderId,
    };
    const verify = (signature: string, overrides: { orderId?: string; paymentId?: string } = {}) =>
      vectorProvider().verifyPayment({
        paymentId: overrides.paymentId ?? VECTOR.paymentId,
        orderId: overrides.orderId ?? VECTOR.orderId,
        signature,
      });

    it('accepts the genuine signature and reports the order the payment belongs to', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(capturedPayment)));
      await expect(verify(VECTOR.signature)).resolves.toMatchObject({
        captured: true,
        orderId: VECTOR.orderId,
        currency: 'INR',
      });
    });

    it('rejects a signature made with a different secret, without calling the provider', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const forged = createHmac('sha256', 'attacker_guess')
        .update(`${VECTOR.orderId}|${VECTOR.paymentId}`)
        .digest('hex');
      await expect(verify(forged)).rejects.toThrow('Invalid payment signature');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a valid signature replayed against a different order or payment', async () => {
      vi.stubGlobal('fetch', vi.fn());
      await expect(verify(VECTOR.signature, { orderId: 'order_OTHER' })).rejects.toThrow(
        'Invalid payment signature',
      );
      await expect(verify(VECTOR.signature, { paymentId: 'pay_OTHER' })).rejects.toThrow(
        'Invalid payment signature',
      );
    });

    it.each([
      ['truncated', VECTOR.signature.slice(0, 20)],
      ['empty', ''],
      ['over-long', `${VECTOR.signature}00`],
      ['non-hex', 'z'.repeat(64)],
    ])(
      'rejects a %s signature cleanly (an invalid-signature error, not a RangeError)',
      async (_l, bad) => {
        vi.stubGlobal('fetch', vi.fn());
        await expect(verify(bad)).rejects.toThrow('Invalid payment signature');
      },
    );
  });

  describe('verifyWebhookSignature', () => {
    const body = '{"event":"payment.captured"}';
    const good = createHmac('sha256', CONFIG.webhookSecret).update(body).digest('hex');

    it('accepts the body signed with the webhook secret', () => {
      expect(provider().verifyWebhookSignature(body, good)).toBe(true);
    });

    it('rejects a wrong or wrong-length signature without throwing', () => {
      expect(provider().verifyWebhookSignature(body, 'x'.repeat(64))).toBe(false);
      expect(provider().verifyWebhookSignature(body, good.slice(0, 10))).toBe(false);
      expect(provider().verifyWebhookSignature(body, '')).toBe(false);
    });

    it('rejects a body signed with the API key secret (the two secrets are distinct)', () => {
      const keySigned = createHmac('sha256', CONFIG.keySecret).update(body).digest('hex');
      expect(provider().verifyWebhookSignature(body, keySigned)).toBe(false);
    });
  });

  it('verifies a matching webhook HMAC', () => {
    const body = '{"event":"payment.captured"}';
    const signature = createHmac('sha256', CONFIG.webhookSecret).update(body).digest('hex');
    expect(provider().verifyWebhookSignature(body, signature)).toBe(true);
  });

  it('rejects a tampered webhook HMAC', () => {
    const signature = createHmac('sha256', CONFIG.webhookSecret)
      .update('{"event":"payment.failed"}')
      .digest('hex');
    expect(provider().verifyWebhookSignature('{"event":"payment.captured"}', signature)).toBe(
      false,
    );
  });
});

describe('RazorpayPaymentProvider — createOrder', () => {
  it('posts the order and maps a valid response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: 'order_1', amount: 50000, currency: 'INR', status: 'created' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().createOrder({
      amountPaise: 50000,
      currency: 'INR',
      idempotencyKey: 'idem-1',
      metadata: { eventId: 'evt_1' },
    });

    expect(result).toEqual({
      id: 'order_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://razorpay.test/v1/orders');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      amount: 50000,
      currency: 'INR',
      receipt: 'idem-1',
      notes: { eventId: 'evt_1' },
    });
  });

  it('throws the error description when the provider returns an error payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Insufficient balance' } })),
    );
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-2',
        metadata: {},
      }),
    ).rejects.toThrow('Insufficient balance');
  });

  it('falls back to the status text when the error payload has no description', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { code: 'BANKING_ERROR' } })),
    );
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-3',
        metadata: {},
      }),
    ).rejects.toThrow('Razorpay create order failed: Bad Request');
  });

  it('falls back to Unknown error when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(brokenJson()));
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-4',
        metadata: {},
      }),
    ).rejects.toThrow('Unknown error');
  });

  it('throws when the order payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'order_1' })));
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-5',
        metadata: {},
      }),
    ).rejects.toThrow('Invalid Razorpay order response');
  });
});

describe('RazorpayPaymentProvider — verifyPayment', () => {
  it('rejects a signature mismatch', async () => {
    const signature = createHmac('sha256', 'wrong_secret')
      .update('orderId=ord_1&paymentId=pay_1')
      .digest('hex');
    await expect(
      provider().verifyPayment({ paymentId: 'pay_1', orderId: 'ord_1', signature }),
    ).rejects.toThrow('Invalid payment signature');
  });

  it('verifies a valid signature and returns the fetched payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 1000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        }),
      ),
    );
    const signature = provider().generateSignature({ paymentId: 'pay_1', orderId: 'ord_1' });
    const result = await provider().verifyPayment({
      paymentId: 'pay_1',
      orderId: 'ord_1',
      signature,
    });
    expect(result).toMatchObject({ verified: true, paymentId: 'pay_1', captured: true });
  });

  it('throws when the signed payment cannot be found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Payment not found' } })),
    );
    const signature = provider().generateSignature({ paymentId: 'pay_missing', orderId: 'ord_1' });
    await expect(
      provider().verifyPayment({ paymentId: 'pay_missing', orderId: 'ord_1', signature }),
    ).rejects.toThrow('Payment not found');
  });
});

describe('RazorpayPaymentProvider — capturePayment', () => {
  it('captures with an explicit amount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 1000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        }),
      ),
    );
    const result = await provider().capturePayment('pay_1', 1000);
    expect(result).toMatchObject({
      verified: true,
      paymentId: 'pay_1',
      amountPaise: 1000,
      captured: true,
    });
    const [url, init] = (vi.mocked(fetch).mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://razorpay.test/v1/payments/pay_1/capture');
    expect(JSON.parse(init.body as string)).toEqual({ amount: 1000 });
  });

  it('captures without a body when no amount is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'pay_2',
        amount: 0,
        currency: 'INR',
        status: 'captured',
        captured: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await provider().capturePayment('pay_2');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('throws the provider error description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Cannot capture' } })),
    );
    await expect(provider().capturePayment('pay_1')).rejects.toThrow('Cannot capture');
  });

  it('throws when the capture payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1', amount: 100 })));
    await expect(provider().capturePayment('pay_1')).rejects.toThrow(
      'Invalid Razorpay payment response',
    );
  });
});

describe('RazorpayPaymentProvider — refundPayment', () => {
  it('posts the refund and maps a valid response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'rfnd_1', status: 'processed', amount: 1000 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider().refundPayment({
      paymentId: 'pay_1',
      amountPaise: 1000,
      idempotencyKey: 'idem-rfnd',
    });
    expect(result).toEqual({ id: 'rfnd_1', status: 'processed', amountPaise: 1000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://razorpay.test/v1/payments/pay_1/refund');
    expect(JSON.parse(init.body as string)).toEqual({ amount: 1000, receipt: 'idem-rfnd' });
  });

  it('throws the provider error description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Refund too large' } })),
    );
    await expect(
      provider().refundPayment({
        paymentId: 'pay_1',
        amountPaise: 9000,
        idempotencyKey: 'idem-rfnd-2',
      }),
    ).rejects.toThrow('Refund too large');
  });

  it('throws when the refund payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'rfnd_1' })));
    await expect(
      provider().refundPayment({
        paymentId: 'pay_1',
        amountPaise: 100,
        idempotencyKey: 'idem-rfnd-3',
      }),
    ).rejects.toThrow('Invalid Razorpay refund response');
  });
});

describe('RazorpayPaymentProvider — getPayment', () => {
  it('maps a captured payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 2500,
          currency: 'INR',
          status: 'captured',
          captured: true,
        }),
      ),
    );
    const result = await provider().getPayment('pay_1');
    expect(result).toMatchObject({
      verified: true,
      paymentId: 'pay_1',
      amountPaise: 2500,
      captured: true,
    });
  });

  it('throws NotFound-style error for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 404, 'Not Found')));
    await expect(provider().getPayment('pay_missing')).rejects.toThrow('Payment not found');
  });

  it('throws when the payment payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1' })));
    await expect(provider().getPayment('pay_1')).rejects.toThrow(
      'Invalid Razorpay payment response',
    );
  });

  it('throws the provider error description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Rate limited' } })),
    );
    await expect(provider().getPayment('pay_1')).rejects.toThrow('Rate limited');
  });
});

describe('RazorpayPaymentProvider — payment id validation', () => {
  const hostile: readonly (readonly [string, string])[] = [
    ['path traversal out of /payments/', '../../../v1/orders'],
    ['single-level traversal', '../refunds'],
    ['absolute url', 'https://evil.test/steal'],
    ['protocol-relative url', '//evil.test/steal'],
    ['query delimiter', 'pay_1?amount=1'],
    ['fragment delimiter', 'pay_1#x'],
    ['encoded traversal', 'pay_1%2F..%2Forders'],
    ['crlf injection', 'pay_1\r\nX-Injected: 1'],
    ['bare newline', 'pay_1\n'],
    ['null byte', 'pay_1 '],
    ['leading whitespace', ' pay_1'],
    ['inner space', 'pay 1'],
    ['empty string', ''],
    ['over-length', `pay_${'a'.repeat(200)}`],
  ];

  it.each(hostile)('rejects %s without issuing a request', async (_label, paymentId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().getPayment(paymentId)).rejects.toThrow('Invalid Razorpay payment id');
    await expect(provider().capturePayment(paymentId)).rejects.toThrow(
      'Invalid Razorpay payment id',
    );
    await expect(
      provider().refundPayment({ paymentId, amountPaise: 1, idempotencyKey: 'idem-x' }),
    ).rejects.toThrow('Invalid Razorpay payment id');

    // Fails closed: not one request leaves the process, so the id can never
    // reach the wire in any form.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not echo the rejected id back in the error', async () => {
    const hostileId = 'pay_1\r\nInjected-Header: 1';
    vi.stubGlobal('fetch', vi.fn());

    let message = '<no error thrown>';
    try {
      await provider().getPayment(hostileId);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    expect(message).toBe('Invalid Razorpay payment id');
    expect(message).not.toContain('Injected-Header');
    expect(message).not.toContain('\n');
  });

  it('still accepts well-formed ids unchanged', async () => {
    const captured = jsonResponse({
      id: 'pay_ABC123xyz',
      amount: 1000,
      currency: 'INR',
      status: 'captured',
      captured: true,
    });
    const fetchMock = vi.fn().mockResolvedValue(captured);
    vi.stubGlobal('fetch', fetchMock);

    for (const id of ['pay_1', 'pay_ABC123xyz', 'order_1', 'rfnd_1', 'cust_1']) {
      await provider().getPayment(id);
      const [url] = fetchMock.mock.calls.at(-1) as [string];
      expect(url).toBe(`https://razorpay.test/v1/payments/${id}`);
    }
  });
});

describe('RazorpayPaymentProvider — order amount integrity and payment mapping', () => {
  const request = {
    amountPaise: 108_850,
    currency: 'INR',
    idempotencyKey: 'idem-1',
    metadata: { holdId: 'HOLD-1' },
  };

  it('returns the order when the provider echoes the requested amount and currency', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ id: 'order_1', amount: 108_850, currency: 'INR', status: 'created' }),
        ),
    );
    await expect(provider().createOrder(request)).resolves.toMatchObject({
      id: 'order_1',
      amountPaise: 108_850,
    });
  });

  it.each([
    ['a different amount', { amount: 100, currency: 'INR' }],
    ['a different currency', { amount: 108_850, currency: 'USD' }],
  ])('refuses an order the provider created with %s', async (_l, overrides) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ id: 'order_1', status: 'created', ...overrides })),
    );
    await expect(provider().createOrder(request)).rejects.toThrow(
      'does not match the requested amount',
    );
  });

  it('maps the provider order id and currency from a fetched payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 5000,
          currency: 'INR',
          status: 'captured',
          captured: true,
          order_id: 'order_9',
        }),
      ),
    );
    await expect(provider().getPayment('pay_1')).resolves.toMatchObject({
      orderId: 'order_9',
      currency: 'INR',
    });
  });

  it('reports a null order id for a payment made without an order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 5000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        }),
      ),
    );
    await expect(provider().getPayment('pay_1')).resolves.toMatchObject({ orderId: null });
  });
});
