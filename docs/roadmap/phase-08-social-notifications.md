# Phase 8 — Social / discovery / notifications

**Status:** partial — follow graph + guest notifications + partner (org-scoped) notification inbox LIVE on `staging` (`e5fa729`, 2026-09-29) · chat/DM not started

v1 has a substantial social/dating layer bolted onto the event platform
(`social.ts`, 36 endpoints — follow, DM/chat, typing indicators, blocks,
media, dating-style discover/matches). Nothing in the current
`C1RCLE-FRONTEND` (partner-dashboard, guest-portal, admin-console) has any
UI for this today — confirmed during this session's frontend audit. Do not
start this phase until a frontend need for it actually exists; re-audit
`C1RCLE-FRONTEND` before beginning in case that's changed.

## If/when this phase starts, v1 references

- Follow graph: `follows`, `userFollows/{uid}/venues|hosts`, `venueFollowers`,
  `hostFollowers` — fans out "new event" notifications
  (`notifyNewEvent()` per `PARTNER_ECOSYSTEM_STATUS.md`).
- Chat: `eventGroupMessages`, `privateConversations`, `directMessages`,
  `typingIndicators`, `userBlocks`, `userReports`.
- Notifications: `notifications`, `notification_reads`.

## Firestore collections

`v2_follows`, `v2_notifications` (`v2_notification_reads` was dropped — `readAt` is inline, see session log), plus chat
collections only if/when this phase actually starts (not enumerated here to
avoid speccing detail that may drift before it's relevant).

## Session Log

### 2026-09-29 — follow graph + "new event" notifications (pub/sub)

Re-audit of `C1RCLE-FRONTEND`: partner-dashboard now ships notification UI
(`PartnerNotifications`, `VenueNotificationDrawer`) on local mock data, and
guest-portal has venue/host pages — the precondition above is met for
follows + notifications. No chat/DM UI exists, so chat stays out of scope.

Built:
- `v2_follows` (one edge doc per follower+target, deterministic id) and
  `v2_notifications` (one row per recipient+type+subject, `readAt` inline —
  no separate `v2_notification_reads`, every row has exactly one recipient).
- Domain events `follow.created` / `follow.removed` (audited).
- `SocialService` publishes only; notifications are written by the bus
  subscriber `createFollowerFanOutConsumer` on `event.published`
  (replaces v1's inline `notifyNewEvent()`). Idempotent under redelivery and
  `resumeSales` re-publish.
- Bus fix: per-handler dedupe was keyed by `handler.name`, so two anonymous
  subscribers on one event type shared a dedupe set and the second never ran.
- Routes (session-scoped): `POST /follows`, `DELETE /follows/:type/:id`,
  `GET /follows/me`, `GET /follows/:type/:id/status`, `GET /notifications/me`,
  `GET /notifications/me/unread-count`, `POST /notifications/me/read`,
  `POST /notifications/me/read-all`.

Open: fan-out runs in-process inside the publish request (bus drains on
append) — move to the durable queue worker when B12 lands. Chat/DM remains unbuilt.

**Update (verified 2026-10-02):** partner-side org-scoped notifications are now live too: `GET /organizations/:organizationId/notifications`, `PATCH .../:notificationId/read`, `PATCH .../read-all`, `POST .../:notificationId/action` (`notifications/notifications-routes.ts`, gated by `organization.read`).
