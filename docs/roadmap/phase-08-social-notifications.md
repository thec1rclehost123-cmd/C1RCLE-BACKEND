# Phase 8 — Social / discovery / notifications

**Status:** not started · **Priority:** lowest — build only once Phases 0–7 are live

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

`v2_follows`, `v2_notifications`, `v2_notification_reads`, plus chat
collections only if/when this phase actually starts (not enumerated here to
avoid speccing detail that may drift before it's relevant).

## Session Log

(none yet)
