# Guest invitation origin

`GUEST_PORTAL_URL` is the Gateway's optional server-owned HTTP(S) Guest origin. Core defaults to `https://thec1rcle.com` when it is absent. Ticket invitation emails append the encoded invitation identifier to `/ticket-transfer/` on that origin; browser commands cannot override it. Configuration rejects credentials, paths, query strings, fragments and non-HTTP(S) schemes.

Before connected non-production invitation verification, set this existing Gateway configuration to the actual authorized Guest staging deployment origin and verify its authenticated signup/verify/return route. Guest/Admin canonical domains were not switched to their staging Preview deployments by M2. A canonical production link is therefore not staging acceptance evidence.

This implementation did not change hosted configuration or send email. Manual invitation links use the current Guest browser origin. Provider email delivery and real inbox receipt remain distinct evidence requirements.
