import { describe, expect, it, vi } from 'vitest';

import { LoggingEmailSender } from './email-sender.js';

import type { Logger } from '../../telemetry/logger.js';

describe('LoggingEmailSender', () => {
  it('never logs secrets or recipient details from suppressed development email', async () => {
    const info = vi.fn((_message: string, _fields?: Record<string, unknown>) => {});
    const logger: Logger = { info, warn: () => {}, error: () => {} };
    const sender = new LoggingEmailSender(logger);
    const secretValues = {
      otp: '123456',
      temporaryPassword: 'temporary-password-secret',
      resetUrl: 'https://example.test/reset?token=reset-secret',
      recipient: 'private@example.test',
      legalName: 'Legal Name',
      reviewNote: 'Private review note',
      idempotencyKey: 'order-private-reference',
      subject: 'Guest private subject',
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
    await sender.sendOnboardingChangesRequestedEmail(secretValues.recipient, {
      legalName: secretValues.legalName,
      note: secretValues.reviewNote,
    });
    await sender.sendTransactionalEmail({
      to: secretValues.recipient,
      subject: secretValues.subject,
      html: '<p>Private body</p>',
      idempotencyKey: secretValues.idempotencyKey,
    });

    const calls = info.mock.calls;
    expect(calls).toEqual([
      ['dev_email_otp', { delivery: 'suppressed' }],
      ['dev_email_staff_invitation', { delivery: 'suppressed' }],
      ['dev_email_password_reset', { delivery: 'suppressed' }],
      ['dev_email_onboarding_changes_requested', { delivery: 'suppressed' }],
      ['dev_email_transactional', { delivery: 'suppressed' }],
    ]);
    const logged = JSON.stringify(calls);
    for (const secret of Object.values(secretValues)) expect(logged).not.toContain(secret);
  });
});
