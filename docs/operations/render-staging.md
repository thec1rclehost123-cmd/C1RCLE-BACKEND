# Existing Render Gateway: non-production acceptance

This is the approved single-service topology. Do not create another Render Web
Service, private service, sidecar instance or Blueprint deployment. The same
Gateway is intended for a later separately approved production cutover.

## Inspected service and source

| Setting | Existing value / required candidate behavior |
| --- | --- |
| Service | `circle-v2-backend` (`srv-daar7op42hec73ecesdg`) |
| Runtime / region / compute | Docker / Singapore / Free; no plan upgrade authorized |
| Source branch | `staging`; do not push/merge it during candidate preparation |
| Last inspected deployed SHA | `57902358612172fa1b1f0a1f9f66f54dc33121ee` |
| Dockerfile / context | `deploy/docker/Dockerfile.sidecar` / repository root |
| Public HTTPS | `https://circle-v2-backend.onrender.com` |
| Existing custom HTTPS | `https://api-staging.thec1rcle.com` |
| Fastify | `127.0.0.1:8081`, started by the existing container entrypoint |
| nginx | Render-injected public `PORT`, proxying to loopback Fastify |
| Auto-deploy | Off; CI can still explicitly deploy on a successful staging push |
| PR previews | Inspected as Automatic; disabling requires approval to avoid additional instances |
| Render health path | Inspected blank; proposed `/api/v2/internal/health`, not yet changed |

Render's environment label is currently `Production`. This label and
`NODE_ENV=production` do not authorize production activity or Razorpay Live Mode.
The acceptance data project remains `c1rcle-v2`.

```text
Clients -> Render TLS -> existing nginx public PORT
                     -> Fastify 127.0.0.1:8081 in the SAME service/container
                     -> c1rcle-v2 Firestore / Storage
```

## Configuration and secrets

Use [the environment contract](staging-environment-contract.md). Keep both
`PUBLIC_API_URL` and `BETTER_AUTH_URL` on the existing native HTTPS URL for this
pass, preserving the registered Test Mode webhook. Keep nginx profile `staging`,
forwarded protocol `https`, native server name plus the existing custom alias,
and `TRUSTED_PROXY_CIDRS=127.0.0.1/32`. Do not broaden trust to arbitrary forwarded
headers or `/0`. Custom-domain Cloudflare origin proof still needs connected
verification; a health 200 alone does not prove end-client IP identity.

Hosted credentials belong only in this existing service's protected environment.
Local macOS Keychain is not a hosted dependency. Transfer requires separate
approval and must be memory-to-protected-provider only, without plaintext files,
command arguments, console values, API response echoes or frontend variables.
Do not generate replacement bank material over unidentified existing ciphertext.

Render can save environment changes without deploying via **Save only**. Other
save choices can deploy/rebuild immediately. No such change is authorized by
candidate preparation. Docker environment variables may be available during
build: do not consume secrets through Docker `ARG`/`ENV`, echo them, or bake them
into image layers. `.dockerignore` excludes local environment files.

## Startup, workers and probes

The existing entrypoint starts Fastify on loopback, waits for health and starts
nginx. Retain that behavior; do not add a second service or replace it with an
unreviewed command. Render supplies public `PORT`; `SIDECAR_FASTIFY_PORT=8081` is
the internal listener. Build provenance must come from the exact deployed SHA,
including Render's `RENDER_GIT_COMMIT` fallback where `BUILD_SHA` is unset.

Set every safety flag in the environment contract explicitly false before a
future approved candidate deployment. The candidate base already contains the
`BACKGROUND_WORKERS_ENABLED` guard around assignment expiry, maintenance and
analytics timers. The old inspected deployed SHA does not have this guard;
setting a flag on that old build does not disable its timers. Do not claim the
currently hosted workers are OFF or use that build as an unexamined safe rollback.

- `/api/v2/internal/health`: public liveness, not dependency readiness.
- `/api/v2/internal/version`: protected by `X-Readiness-Token`; verify exact SHA.
- `/api/v2/internal/readiness`: same token protection; verify Firestore, Storage,
  active Redis if configured, and configuration checks without weakening probes.
- Payment readiness checks configuration presence, not provider usability.
- Preserve Packet 2.3's bounded shared in-flight probe and honest timeout/down
  result. The historical initial Firestore-timeout cause remains UNVERIFIED.

Initial inspected health probes timed out at 15 seconds; later warm samples
returned 200 under one second. This is not a complete cold-start measurement.
Protected version/readiness returned expected 404 without the token; hosted
dependency/provenance acceptance remains UNVERIFIED. Free-service cold wake
behavior must be recorded separately from warm latency.

## Release sequence and rollback boundary

1. Prepare isolated reviewed M1/M2 source and matching generated frontend
   contracts. Preserve unrelated dirty work. No commit or publication is implied.
2. Obtain explicit commit/push/CI approval for the exact file list. Feature-branch
   publication and its automation must be reviewed separately from deployment.
3. Obtain approval for existing-service settings/secrets and an exact-SHA deploy.
   Do not push/merge staging/main or adopt a Blueprint. CI currently posts `{}`
   to Render on successful staging pushes; a pinned `commitId`/explicit release
   gate is a separate proposed correction, not silently implemented here.
4. Coordinate compatible secrets and any specifically approved session/credential
   invalidation before activating the candidate. Recheck current ciphertext and
   credentials; historical zero-record/session counts are not current proof.
5. Verify SHA, safe flags, cold/warm dependency readiness, explicit origins,
   proxy identity, Test Mode and provider adapter configuration. Do not send
   emails, process outbox or make payments/refunds/payouts as startup checks.
6. Agree rollback code AND protected configuration. Code rollback does not restore
   key compatibility or undo data/provider actions. An older worker-starting
   build is not an automatically safe fallback; service suspension also requires
   approval. Do not blindly revert encryption/signing keys.

For future production cutover, retain this service and `c1rcle-v2`. Require final
milestone evidence, approved commercial/privacy policies, namespaced acceptance
record retention/cleanup approval, backup/restore proof, explicit production
origins/credentials/provider-mode decisions and a compatible rollback plan.
Stop non-production test writers before real customer traffic. Never infer release
approval from an environment label or enable workers/payouts/M5 flags implicitly.

Current status: source/configuration candidate only. Hosted modification,
webhook changes, deployment, broad M2 gate and Milestone 3 remain separately gated.
