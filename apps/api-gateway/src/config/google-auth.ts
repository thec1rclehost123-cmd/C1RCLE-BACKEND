import { z } from 'zod';

const schema = z
  .object({
    GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.url().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      new Set([
        Boolean(value.GOOGLE_CLIENT_ID),
        Boolean(value.GOOGLE_CLIENT_SECRET),
        Boolean(value.GOOGLE_REDIRECT_URI),
      ]).size > 1
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Google authentication requires both client ID and secret.',
      });
    }
  });

/** Optional until configured; partial configuration fails closed without logging secrets. */
export function getGoogleAuthConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid Google authentication configuration.');
  const {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REDIRECT_URI: redirectURI,
  } = parsed.data;
  if (
    redirectURI &&
    (new URL(redirectURI).pathname !== '/api/auth/google/callback' ||
      new URL(redirectURI).search ||
      new URL(redirectURI).hash)
  )
    throw new Error('Invalid Google authentication callback configuration.');
  if (redirectURI) {
    const callback = new URL(redirectURI);
    if (
      callback.username ||
      callback.password ||
      (callback.protocol !== 'https:' &&
        !(
          callback.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
        ))
    )
      throw new Error('Google callback requires HTTPS outside loopback.');
  }
  return clientId && clientSecret && redirectURI
    ? { clientId, clientSecret, redirectURI }
    : undefined;
}
