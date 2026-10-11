import { describe, expect, it } from 'vitest';

import {
  holdIdFromNotes,
  summariseWebhookForLog,
  webhookPayloadSchema,
} from './razorpay-webhook.js';

/** A payment entity as Razorpay really sends it, personal data included. */
const realEntity = {
  id: 'pay_TmgaJ3JMsO12ql',
  entity: 'payment',
  amount: 10000,
  currency: 'INR',
  status: 'captured',
  order_id: 'order_TmgXYJ1eoQ5SpI',
  method: 'card',
  captured: true,
  email: 'payer@example.com',
  contact: '+919999999999',
  card: { name: 'A Payer', last4: '1111', network: 'Visa' },
  vpa: null,
  notes: [] as unknown,
};

const event = (entityOverrides: Record<string, unknown> = {}, name = 'payment.captured') => ({
  entity: 'event',
  event: name,
  payload: { payment: { entity: { ...realEntity, ...entityOverrides } } },
});

describe('webhookPayloadSchema', () => {
  it('accepts a real captured payment whose notes are an EMPTY ARRAY (the case that was dropped)', () => {
    expect(webhookPayloadSchema.safeParse(event()).success).toBe(true);
  });

  it('accepts notes as an object, as null, or absent', () => {
    expect(webhookPayloadSchema.safeParse(event({ notes: { holdId: 'h1' } })).success).toBe(true);
    expect(webhookPayloadSchema.safeParse(event({ notes: null })).success).toBe(true);
    const { notes: _omitted, ...withoutNotes } = realEntity;
    expect(
      webhookPayloadSchema.safeParse({
        event: 'payment.captured',
        payload: { payment: { entity: withoutNotes } },
      }).success,
    ).toBe(true);
  });

  it('accepts events that carry no payment at all (disputes, refunds, settlements)', () => {
    expect(
      webhookPayloadSchema.safeParse({ event: 'settlement.processed', payload: {} }).success,
    ).toBe(true);
    expect(webhookPayloadSchema.safeParse({ event: 'payment.dispute.created' }).success).toBe(true);
  });

  it('still rejects a payment with no id, and a body with no event name', () => {
    expect(webhookPayloadSchema.safeParse(event({ id: '' })).success).toBe(false);
    expect(webhookPayloadSchema.safeParse({ payload: {} }).success).toBe(false);
  });

  it('strips the payer’s personal data from the parsed value', () => {
    const parsed = webhookPayloadSchema.parse(event({ notes: { holdId: 'h1' } }));
    const serialised = JSON.stringify(parsed);

    for (const secret of ['payer@example.com', '+919999999999', 'A Payer', '1111']) {
      expect(serialised).not.toContain(secret);
    }
    expect(parsed.payload?.payment?.entity.id).toBe('pay_TmgaJ3JMsO12ql');
  });
});

describe('holdIdFromNotes', () => {
  it('reads the hold id from an object', () => {
    expect(holdIdFromNotes({ holdId: 'hold_1' })).toBe('hold_1');
  });

  it('treats an empty array, null, undefined and non-strings as "no hold"', () => {
    expect(holdIdFromNotes([])).toBeUndefined();
    expect(holdIdFromNotes(null)).toBeUndefined();
    expect(holdIdFromNotes(undefined)).toBeUndefined();
    expect(holdIdFromNotes({ holdId: 42 })).toBeUndefined();
    expect(holdIdFromNotes({ holdId: '' })).toBeUndefined();
    expect(holdIdFromNotes('hold_1')).toBeUndefined();
  });
});

describe('summariseWebhookForLog', () => {
  it('keeps the event name and the payment and order ids, and nothing else', () => {
    expect(summariseWebhookForLog(event())).toEqual({
      event: 'payment.captured',
      paymentId: 'pay_TmgaJ3JMsO12ql',
      orderId: 'order_TmgXYJ1eoQ5SpI',
    });
  });

  it('never lets payer details through, however the body is shaped', () => {
    const summaries = [
      summariseWebhookForLog(event()),
      // A body the schema would reject still must not leak.
      summariseWebhookForLog(event({ id: 12345 })),
      summariseWebhookForLog({
        event: 'x',
        payload: { payment: { entity: realEntity } },
        extra: realEntity,
      }),
    ].map((summary) => JSON.stringify(summary));

    for (const text of summaries) {
      for (const secret of ['payer@example.com', '+919999999999', 'A Payer', '1111', 'Visa']) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('copes with bodies that are not objects, or have no payment', () => {
    expect(summariseWebhookForLog(null)).toEqual({});
    expect(summariseWebhookForLog('nope')).toEqual({});
    expect(summariseWebhookForLog({ event: 'settlement.processed' })).toEqual({
      event: 'settlement.processed',
    });
  });
});
