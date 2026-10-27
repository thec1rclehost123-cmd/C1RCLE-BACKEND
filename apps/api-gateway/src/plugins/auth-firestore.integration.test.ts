import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import type { EmailSender } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../config/index.js';

import { buildBetterAuth } from './auth.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(emulator)('Better Auth with the Firestore adapter', () => {
  it('creates an account, signs in, and resolves the session', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    let resetUrl = '';
    const sender: EmailSender = {
      name: 'test',
      sendOtpEmail: async () => {},
      sendStaffInvitationEmail: async () => {},
      sendPasswordResetEmail: async (_recipient, url) => {
        resetUrl = url;
      },
      sendOnboardingChangesRequestedEmail: async () => {},
    };
    const config = getGatewayConfig({
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'local-emulator-test-secret-at-least-32-chars',
      BETTER_AUTH_URL: 'http://localhost:8080',
    });
    const auth = buildBetterAuth(config, db, sender);
    const email = `${randomUUID()}@example.test`;
    const password = 'a-strong-test-password';
    const signup = await auth.api.signUpEmail({
      body: { email, password, name: 'Test Guest', role: 'guest' },
    });
    expect(signup.user.email).toBe(email);
    const login = await auth.api.signInEmail({ body: { email, password } });
    expect(login.token).toBeTruthy();
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${login.token}` }),
    });
    expect(session?.user.email).toBe(email);
    await auth.api.requestPasswordReset({ body: { email } });
    expect(resetUrl).toBeTruthy();
    const token = new URL(resetUrl).pathname.split('/').pop();
    if (!token) throw new Error('Expected a password reset token');
    const newPassword = 'another-strong-test-password';
    await auth.api.resetPassword({ body: { token, newPassword } });
    const newLogin = await auth.api.signInEmail({ body: { email, password: newPassword } });
    expect(newLogin.user.email).toBe(email);
  });
});
