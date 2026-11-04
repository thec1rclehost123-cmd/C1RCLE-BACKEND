import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import type { EmailSender } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../../../config/index.js';
import { BetterAuthStaffCredentialProvisioner } from '../../../lib/auth/staff-credential-provisioner.js';
import { buildBetterAuth } from '../../../plugins/auth.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(emulator)('native session revocation (local Emulator)', () => {
  it('revokes old sessions on password change and reset, rejects old credentials and token replay', async () => {
    if (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator))
      throw new Error('Requires loopback Firestore Emulator');
    const db = new Firestore({ projectId: 'c1rcle-v2', host: emulator, ssl: false });
    const email = `packet-1-8-${randomUUID()}@example.invalid`;
    let userId: string | undefined;
    let resetToken: string | undefined;
    const sender = {
      name: 'capture-only',
      sendPasswordResetEmail: async (_email: string, url: string) => {
        resetToken = new URL(url).pathname.split('/').pop();
      },
    } as EmailSender;
    const auth = buildBetterAuth(
      getGatewayConfig({
        NODE_ENV: 'test',
        BETTER_AUTH_SECRET: 'local-emulator-session-security-at-least-32',
        BETTER_AUTH_URL: 'http://localhost:8080',
      }),
      db,
      sender,
    );
    const password = 'Synthetic-original-password-16';
    const changed = 'Synthetic-changed-password-16';
    const reset = 'Synthetic-reset-password-16';
    try {
      const signup = await auth.api.signUpEmail({
        body: { email, password, name: 'Synthetic', role: 'guest' },
      });
      userId = signup.user.id;
      const login = await auth.api.signInEmail({ body: { email, password } });
      const credentials = (token: string | null) =>
        new Headers({ authorization: `Bearer ${token ?? ''}` });
      const first = credentials(signup.token);
      const second = credentials(login.token);
      const provisioner = new BetterAuthStaffCredentialProvisioner(
        auth,
        {
          findUserIdByEmail: async (address) => (address === email ? (userId ?? null) : null),
          getEmailById: async () => email,
        },
        { info: () => {}, warn: () => {}, error: () => {} },
      );
      expect(await provisioner.provisionLogin(email, 'Synthetic')).toEqual({
        userId,
        created: false,
        temporaryPassword: null,
      });
      expect(await auth.api.getSession({ headers: first })).not.toBeNull();
      expect(await auth.api.getSession({ headers: second })).not.toBeNull();
      await auth.api.changePassword({
        headers: second,
        body: {
          currentPassword: password,
          newPassword: changed,
          revokeOtherSessions: true,
        },
      });
      for (const headers of [first, second])
        expect(await auth.api.getSession({ headers })).toBeNull();
      await expect(auth.api.signInEmail({ body: { email, password } })).rejects.toThrow();
      const relogin = await auth.api.signInEmail({ body: { email, password: changed } });
      const active = credentials(relogin.token);
      await auth.api.requestPasswordReset({ body: { email } });
      expect(resetToken).toBeTruthy();
      if (!resetToken) throw new Error('Expected captured reset token');
      await auth.api.resetPassword({ body: { token: resetToken, newPassword: reset } });
      expect(await auth.api.getSession({ headers: active })).toBeNull();
      await expect(
        auth.api.resetPassword({ body: { token: resetToken, newPassword: changed } }),
      ).rejects.toThrow();
      await expect(auth.api.signInEmail({ body: { email, password: changed } })).rejects.toThrow();
      expect((await auth.api.signInEmail({ body: { email, password: reset } })).user.id).toBe(
        userId,
      );
    } finally {
      userId ??= (await db.collection('v2_auth_users').where('email', '==', email).get()).docs[0]
        ?.id;
      if (userId) {
        for (const collection of ['v2_auth_sessions', 'v2_auth_accounts']) {
          const docs = await db.collection(collection).where('userId', '==', userId).get();
          await Promise.all(docs.docs.map((doc) => doc.ref.delete()));
        }
        await db.collection('v2_auth_users').doc(userId).delete();
      }
      if (resetToken) {
        const docs = await db
          .collection('v2_auth_verification_tokens')
          .where('identifier', '==', `reset-password:${resetToken}`)
          .get();
        await Promise.all(docs.docs.map((doc) => doc.ref.delete()));
      }
      await db.terminate();
    }
  }, 60_000);
});
