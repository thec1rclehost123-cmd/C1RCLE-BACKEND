# Work done by Sagar — 2026-09-29

> **Historical log, as of 2026-09-29; see [ROADMAP.md](roadmap/ROADMAP.md) for current status.**

**Task:** Phase 8 — Social / discovery / notifications (`docs/roadmap/phase-08-social-notifications.md`)
**Branch:** `feat/phase-08-social-notifications` (cut from `staging` @ `b46d1f1`, already up to date with `origin/staging`)
**Focus:** pub/sub architecture — every notification is produced by an event-bus subscriber, never inline by the request that caused it.

---

## 1. Pre-work findings

- **Frontend re-audit (required by the phase doc before starting):** `C1RCLE-FRONTEND` now has notification UI in partner-dashboard (`PartnerNotifications.tsx`, `VenueNotificationDrawer.tsx`, `/host/notifications`, `/venue/notifications`), running on local mock data with no API calls yet. Guest-portal has venue and host pages. That meets the precondition for follows and notifications. There is **no chat/DM UI**, so chat stays out of scope, as the phase doc says.
- **"routemenu.ts":** neither repo has a file by that name. The route registration file is `apps/api-gateway/src/routes/v2/route-manifest.ts`, and the new routes are registered there.
- **Existing pub/sub:** `InProcessEventBus` (outbox → handlers, at-least-once, per-handler dedupe, DLQ after 5 attempts). `EventService.publish()` already emits `event.published`. It had only an audit consumer and a no-op projection consumer.

## 2. Bug fixed in the event bus

`packages/core/src/application/events/event-bus.ts`

The per-handler dedupe key was `` `${type}#${handler.name}` ``. Consumers built by a factory (such as `createAuditConsumer(...)`) are anonymous, so their `name` is `''`. Two anonymous subscribers on the same event type therefore shared one dedupe set, and **the second one silently skipped every event the first had handled.** Adding the Phase 8 fan-out subscriber next to the audit consumer on `event.published` would have hit this bug.

Fix: the key now includes a stable per-handler identity (`WeakMap<handler, id>`). Regression test: `event-bus.test.ts`, "delivers to every anonymous subscriber, not just the first".

## 3. Architecture (pub/sub)

```
Guest ──POST /follows──► SocialService.follow()
                           ├─ save edge (v2_follows)
                           └─ outbox.append(follow.created) ──► bus ──► audit consumer

Host ──publish event──► EventService.publish()
                           └─ outbox.append(event.published) ──► bus ─┬─► audit consumer
                                                                      ├─► projection (no-op)
                                                                      └─► notifyFollowersOfPublishedEvent
                                                                           ├─ re-read event (skip if no longer published)
                                                                           ├─ page venue followers + host followers (dedupe users)
                                                                           └─ createIfAbsent(notification) × N  (v2_notifications)

Guest ──GET /notifications/me──► SocialService (read-only)
```

- **Publishers do not know their subscribers.** `SocialService` only emits `follow.*`, `EventService` was not changed, and the fan-out is one `subscribe(...)` line in `lib/v2-services.ts`. Push, email, or follower counters can be added later as more subscribers without editing the publishers.
- **Idempotent consumer (at-least-once safe):**
  - The notification id is deterministic: `userId__type__eventId`. It is written with `createIfAbsent` (Firestore `create()` returns ALREADY_EXISTS as a no-op), so a retry, a `resumeSales` re-publish, or a guest who follows both the venue and its host all end up with **one** row. A row the guest already read is never set back to unread.
  - `createdAt` comes from the event's `occurredAt`, not the wall clock.
  - The consumer re-reads the event, so a stale redelivery for an event that has since been cancelled notifies nobody.
  - If the consumer throws, the outbox row stays pending, and the bus retries it and moves it to the DLQ after the maximum number of attempts.
- **Scales past one page:** followers are read in pages of 100 through an async generator, and writes run in chunks of 50 at a time.

## 4. Data model (Firestore)

| Collection | Doc id | Fields | Notes |
| --- | --- | --- | --- |
| `v2_follows` | `followerId__targetType__targetId` | followerId, targetType (`venue`\|`host`), targetId, createdAt | Replaces v1's four collections (`follows`, `userFollows/*`, `venueFollowers`, `hostFollowers`) with one edge doc. Follow is an idempotent `set`, and unfollow is an idempotent `delete`. "host" = organization id. |
| `v2_notifications` | `userId__type__subjectId` | userId, type, title, body, link, subjectId, createdAt, readAt | `readAt` is stored on the row. **Deviation from the phase doc:** there is no separate `v2_notification_reads`, because every v2 notification has exactly one recipient and a join collection adds nothing. |

5 composite indexes were added to `firestore.indexes.json`: follows by follower (with and without type), followers by target, and notifications by user (all, and unread) ordered by `createdAt DESC`.

## 5. API (all under `/api/v2`, session-scoped, no `X-Organization-Id`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/follows` | Follow `{ targetType: 'venue'\|'host', targetId }` | 201 created / 200 already following; 404 unknown target |
| DELETE | `/follows/:targetType/:targetId` | Unfollow (idempotent) | 204 |
| GET | `/follows/me?targetType=&limit=&cursor=` | My follows | `{ items, pageInfo, nextCursor }` |
| GET | `/follows/:targetType/:targetId/status` | Follow button state | `{ following, followerCount }` |
| GET | `/notifications/me?unreadOnly=&limit=&cursor=` | Inbox, newest first | `{ items, pageInfo, nextCursor }` |
| GET | `/notifications/me/unread-count` | Badge count | `{ count }` |
| POST | `/notifications/me/read` | Mark ids read `{ ids: [...] }` (1–100) | `{ updated }` (ids the caller does not own are skipped silently) |
| POST | `/notifications/me/read-all` | Mark all read | `{ updated }` |

List responses add `nextCursor` next to the shared `pageInfo`, because the shared shape has no cursor field and an inbox needs one for paging. Validation errors return 422, following the repo convention.

## 6. Files

**New**
- `packages/core/src/domain/models/social.ts`: Follow and Notification models, deterministic ids
- `packages/core/src/application/social/social-service.ts`: publisher service
- `packages/core/src/application/social/notification-consumers.ts`: fan-out subscriber
- `packages/core/src/application/social/social-service.test.ts`: 9 tests
- `packages/core/src/infrastructure/memory/memory-social-repositories.ts`
- `packages/core/src/infrastructure/firestore/firestore-social-repositories.ts`
- `packages/contracts/src/contracts/social.ts`: Zod contracts
- `apps/api-gateway/src/routes/v2/social/social-routes.ts`: 8 routes
- `apps/api-gateway/src/routes/v2/social/social-routes.test.ts`: 5 tests, including a real `EventService.publish()` → inbox end-to-end test

**Modified**
- `event-bus.ts` (+test): dedupe key fix
- `domain/events.ts`: `follow.created`, `follow.removed`
- `domain/ports/repositories.ts`: `FollowRepository`, `NotificationRepository`
- `application/context.ts`, `infrastructure/utils.ts`, and the barrels: repo registration (memory and Firestore)
- `application/index.ts`, `contracts/src/client.ts`: exports
- `apps/api-gateway/src/lib/v2-services.ts`: `social` service and bus subscriptions
- `apps/api-gateway/src/routes/v2/route-manifest.ts`: route registration
- `firestore.indexes.json`: 5 indexes
- `docs/roadmap/phase-08-social-notifications.md`: status and session log

## 7. Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | ✅ 5/5 |
| `pnpm test` | ✅ core 608 passed (4 skipped), gateway 638 passed, contracts 20 passed |
| `pnpm build` | ✅ |
| `pnpm format:check`, `boundaries`, `check:nginx` | ✅ |
| `pnpm lint` | ✅ for all new/changed files. ⚠️ One **pre-existing** error remains on `staging`, in a file this task did not touch: `packages/core/src/application/door/door-ticket-sale-service.ts:16` (import order, auto-fixable). It was left alone to keep this PR in scope. |

## 8. Not done / follow-ups

- **Chat / DM / typing / blocks / reports:** not built. No frontend need exists, and the phase doc says not to spec it until one does.
- **Fan-out runs in-process:** the bus drains on append, so the publish request waits for the fan-out. That is fine at current scale. When B12 (durable queue) lands, move the subscriber to a worker. It is already isolated, so no publisher changes are needed.
- **Partner-side (org-scoped) notifications (since built: `GET/PATCH /organizations/:organizationId/notifications…`, `notifications/notifications-routes.ts`):** at this date the partner-dashboard UI still used mocks. It needs a product decision on which partner events to notify about, and then it would be another subscriber writing to the same `v2_notifications` collection.
- **Frontend wiring:** guest-portal follow buttons and the inbox, and partner-dashboard `PartnerNotifications` → these endpoints.
- **Deploy:** run `firebase deploy --only firestore:indexes` before these routes serve real traffic, or the ordered queries will fail on Firestore.
