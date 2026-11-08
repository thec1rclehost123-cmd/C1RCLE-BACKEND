# Keep-alive Worker

A Cloudflare Worker on a Cron Trigger (every 10 minutes) that requests the API health endpoint so the Render free instance does not idle out. Free plan: 5 cron triggers per account, 100k requests/day; this uses 144 invocations/day.

- Source: `src/index.js` (no dependencies). Config: `wrangler.toml` (`HEALTH_URL` var, cron).
- Test: `node --test infra/cloudflare/keepalive-worker/test`
- Deploy: `npx wrangler deploy` from this directory (account `1efb743a1ee3b8bd7bee174ee125841d`). No secrets are needed: the probe path is the one path the nginx origin lock leaves open.
- A failed run (three attempts, 20 s each) throws, so it shows as failed in Workers > c1rcle-keepalive-staging > Cron events.

Limits: this reduces idle shutdowns, it does not remove cold starts after a deploy, and Render free allows ~750 instance hours a month, which one always-on service just fits. For production, use a paid instance instead of this.
