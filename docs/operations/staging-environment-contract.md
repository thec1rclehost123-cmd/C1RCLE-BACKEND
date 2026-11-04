# Non-production acceptance environment contract

Use the single existing Render Gateway described in
[the deployment procedure](render-staging.md). No second service, private edge,
new paid instance or new Firebase project is required or approved.

## Explicit non-secret runtime selection

| Variable | Required value / rule |
| --- | --- |
| `NODE_ENV` | `production` on Render, independently of payment mode |
| `STORAGE_DRIVER` | `firestore` |
| `FIRESTORE_PROJECT_ID` | `c1rcle-v2` |
| `FIREBASE_STORAGE_BUCKET` | Existing verified bucket; do not invent or change it |
| `SIDECAR_FASTIFY_PORT` | `8081`; entrypoint binds Fastify to loopback |
| `PORT` | Supplied by Render for nginx's public listener |
| `NGINX_PROFILE` | `staging` |
| `NGINX_SERVER_NAME` | `circle-v2-backend.onrender.com` |
| `NGINX_ADDITIONAL_SERVER_NAMES` | Existing `api-staging.thec1rcle.com` |
| `NGINX_ORIGIN_LOCKED_SERVER_NAMES` | Existing custom API hostname; retain verified origin proof |
| `NGINX_FORWARDED_PROTO` | `https` |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1/32`; never arbitrary client-supplied forwarding headers |
| `PUBLIC_API_URL` / `BETTER_AUTH_URL` | `https://circle-v2-backend.onrender.com` for current acceptance |
| `ALLOWED_ORIGINS` / `BETTER_AUTH_TRUSTED_ORIGINS` | Approved exact HTTPS browser origins below |
| `CORS_ALLOWED_ORIGINS` | Optional explicit override; if used, reconcile with the same approved origins |
| `RATE_LIMIT_STORE` | Existing single-instance `memory` constraint; Redis requires separate approval |
| `REDIS_URL` | Only for an approved active Redis configuration; no new infrastructure implied |
| `APP_VERSION` | Candidate semantic version |
| `BUILD_SHA` | Immutable candidate SHA or verified `RENDER_GIT_COMMIT` fallback |
| `LOG_LEVEL` | Supported level; no credential/body logging |

## Safety profile

Set all of these explicitly to the string `false`; defaults are not acceptance
proof. Do not enable workers merely to refresh analytics or drain old outbox.

```text
PAYOUTS_ENABLED=false
BACKGROUND_WORKERS_ENABLED=false
M5_PRIVATE_ACCESS_ENABLED=false
M5_ELIGIBILITY_RULES_ENABLED=false
M5_TICKET_TRANSFERS_ENABLED=false
M5_OFFLINE_TICKET_MANIFESTS_ENABLED=false
M5_OFFLINE_MANIFEST_DRAIN_COMPLETE=false
M5_COVER_SALES_ENABLED=false
M5_TICKET_ADDONS_ENABLED=false
M5_COVER_MERCHANT_APPROVED=false
M5_COVER_ACTIVATION_APPROVED=false
M5_COVER_ACCOUNTING_APPROVED=false
```

No fixture, configuration parse or disabled button proves connected enforcement.
The worker guard exists in the candidate base but not the older deployed build.

## Protected configuration

| Name | Requirement |
| --- | --- |
| `BETTER_AUTH_SECRET` | Independent high-entropy approved non-production auth material; compatible session transition |
| `EMAIL_OTP_SECRET` | Independent approved OTP HMAC secret; outstanding-code invalidation if changed |
| `MAGIC_TICKET_SECRET` | Approved ticket/QR signing secret; preserve ownership and admission history across transitions |
| `ENCRYPTION_KEY` / `ENCRYPTION_SALT` | Stable compatible approved bank pair; prove ciphertext footprint before changing either |
| `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Existing approved c1rcle-v2 service account; no IAM/rules mutation implied |
| `RESEND_API_KEY` | Dedicated approved non-production Sending key; sender `noreply@thec1rcle.com` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Matching current TEST MODE pair; never Live Mode |
| `RAZORPAY_WEBHOOK_SECRET` | Matches the existing Test Mode webhook; API-key regeneration does not establish this binding |
| `NGINX_READINESS_TOKEN` | Protected operator token for version/readiness; never return it in evidence |
| `NGINX_ORIGIN_VERIFY_SECRET` | Matching existing Cloudflare/nginx origin proof; never expose or rotate implicitly |

Never commit values or copy them into `.env.local`, logs, frontend variables,
Docker layers or ordinary temporary files. Local protected launchers read macOS
Keychain; hosted startup uses Render's protected environment. A local credential
check does not prove hosted binding. Do not deploy secret changes automatically.

The earlier bank-record/session inventories are historical snapshots, not current
permission to migrate data or invalidate newly created sessions. Explicitly
approve any broader transition discovered by a fresh compatibility inventory.

## Discovered client origins

Canonical deployed CI targets (each returned HTTP 200 at inspection):

- Guest: `https://c1rcle-v2-guest-portal.vercel.app`
- Partner, including Venue/Host/Promoter:
  `https://c1-rcle-frontend-partner-dashboard.vercel.app`
- Admin: `https://c1rcle-v2-admin-console.vercel.app`

Already configured additional origins:

- `https://c1rcle-v2-admin-console-thec1rcles-projects.vercel.app`
- `https://staging.thec1rcle.com`
- `https://guest.thec1rcle.com`
- `https://admin.thec1rcle.com`

The additional Admin/Guest aliases redirected to Vercel login; the staging alias
returned 200 without establishing its persona/Gateway binding. Retain/remove
existing aliases only after usage review and approval, aligning CORS and auth
trust; do not silently disrupt them. Current hosted auth trust excludes the
three custom aliases. Do not invent URLs, wildcard authenticated traffic, or
assume a reachable page uses the correct backend.

Guest/Partner/Admin BFF runtime variables must target the approved Gateway;
Scanner uses `EXPO_PUBLIC_API_BASE_URL`. Native Scanner scheme `c1rclescanner`
is not an HTTP origin. No deployed Scanner web origin has been established.

## Provider boundaries and pending acceptance

Existing enabled Razorpay TEST MODE webhook:
`https://circle-v2-backend.onrender.com/api/v2/webhooks/payments/razorpay`.
The inspected registration has 46 events. Source handles `payment.captured`,
`refund.processed`, and dispute `created`, `action_required`, `under_review`,
`won`, `lost`, `closed`. Narrowing to those eight and verifying signing-secret
binding require separate approval. Keep raw-body HMAC validation and provider
fact deduplication; never use a fabricated signed financial event as a harmless
probe. No order/payment/capture/refund/payout is part of configuration verification.

Local A5 Resend verification proved provider acceptance of one approved test
message, not human receipt. Local A6 refreshed Test credentials returned HTTP 200
for a read-only provider GET. Neither establishes hosted secret validity, payment
fulfillment, email outbox draining or production readiness. Workers remain OFF;
another email send requires separate approval.

The 14 approved missing indexes reached READY during earlier remediation.
Do not redeploy them or change Firestore rules/IAM. Protected hosted readiness,
exact code provenance, safe flags, client/proxy behavior and webhook binding are
still required before the M2 broad gate. Preserve M1's 63 skipped/unverified
cases and the unproven historical Firestore startup-timeout cause.
