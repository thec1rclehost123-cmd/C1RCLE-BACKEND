<!--
agent-metadata:
  doc: scanner-app/task
  kind: tracker
  purpose: Living task list for the scanner-app build (frontend + backend modular-monolith fixes). Update in place; move items between sections as they change state.
-->

# Scanner App — Task Tracker

> Companion to [`implementation.md`](implementation.md) (append-only log of
> *why*/*why not* per finished unit). This file is the current snapshot;
> that file is the history. Both live in `docs/scanner-app/`.

## Done — Phase 0 (docs)

- [x] Full doc set (`README.md`, `sota-architecture.md`, `01`–`07`).

## Done — Backend structural fixes

- [x] Fix 1/4: `scanner-service.ts` moved into `application/door/`.
- [x] Fix 4/4: `firestore.indexes.json` + `firebase.json` committed.

## Deferred — Backend structural fixes (logged, not forgotten)

- [ ] Fix 2/4: extract `cover-wallet-service.ts` — needs a careful refactor of 1,474 lines across two storage backends, not a mechanical move.
- [ ] Fix 3/4: fix `DoorSale`/`CoverWalletTxn` id schemes — needs a migration plan, not just a code change (live doc ids already exist in that scheme).

## Done — Phase 1 (core scan flow) — `apps/scanner-app`, C1RCLE-FRONTEND

- [x] Monorepo tooling: `packages/tsconfig/react-native.json`, `packages/eslint-config/src/react-native.ts`.
- [x] App scaffold: package.json, app.config.ts, metro/babel config, tsconfig, eslint.config.ts.
- [x] Env module (`src/config/env.ts`), zod schemas (`src/api/schemas.ts`), API client wrapper (`src/api/scannerApiClient.ts`).
- [x] Auth/session modules: `staffAuth.ts`, `deviceIdentity.ts`, `scannerSession.ts`, `authState.ts`.
- [x] Couple-confirm real timer (`src/features/scan/coupleConfirm.ts`).
- [x] Screens: login, pairing, redeem (event select + code redemption), scan (camera + admit/deny/couple-confirm + offline-deny), guests (server search/paginate/truncated + manual check-in), stats (focus-gated polling).
- [x] Heartbeat (`src/features/heartbeat/useHeartbeat.ts`), fired from the tab shell.
- [x] Root-layout auth-state-gated navigation.
- [x] CI gate updates (`.github/workflows/ci.yml`): scanner-app env-seed step, e2e-matrix exclusion comment.

## Done — "Circle Scanner" retheme (authoritative UI reference, supersedes the Stitch mockups)

- [x] `src/theme/tokens.ts` rewritten to the Circle Scanner palette (`#0B0A0A`/`#EE4B2B`/`#A9C9F7`/`#4A1420`) and fonts (Anton, Archivo — via `@expo-google-fonts/anton` + `@expo-google-fonts/archivo`).
- [x] `GalaButton`/`GalaTextInput` retheme (pill shapes, `outline` variant added).
- [x] All 6 Phase 1 screens retheme'd to match the reference's actual layouts.
- [x] Two net-new screens added to match the reference's 5-tab shell: **Door Entry** (`(tabs)/door.tsx`, UI complete, submit intentionally inert — see below) and **Settings** (`(tabs)/settings.tsx`, fully functional, client-only, no backend needed).
- [x] `(tabs)/_layout.tsx` now 5 tabs (Scan, Door Entry, Guests, Stats, Settings), floating pill bar shape.
- [x] Verification: `typecheck`/`lint` clean, `pnpm boundaries` zero new violations.

## Done — Expo web target + Door Entry backend wiring (Phase 2 pulled forward)

- [x] Expo web support: `react-native-web`, `react-dom`, `web` block in `app.config.ts`, `dev:web` script — same Expo app, no second codebase.
- [x] Fixed a real pre-existing peer-dep conflict (`jest-expo` → `jest-watch-typeahead` vs. repo-wide jest 30) via `pnpm-workspace.yaml`'s `peerDependencyRules.allowedVersions` — confirmed `pnpm install` now completes cleanly, not just warns.
- [x] Door Entry backend wiring: `submitWalkIn`/`submitDineIn` in `scannerApiClient.ts`, `doorSaleSchema`, form now calls real `POST /door/walk-in`/`POST /door/dine-in` with a per-form-session idempotency key.

## Done — app actually run + real blink bug fixed + login art rebuilt from screenshot

- [x] Ran the app for real (`expo start --web`) — confirmed clean 981-module bundle, HTTP 200, no build errors, not just static checks.
- [x] Fixed a real self-redirect loop in `app/_layout.tsx` (`<Redirect>` stayed mounted forever, re-firing `router.replace` to the already-current route on every re-render — the reported "blinking").
- [x] Fixed a second contributing bug: `useFonts({...})` given a fresh object literal every render, re-triggering the font-load effect — moved to a module-level `FONT_MAP` constant.
- [x] Rebuilt the login hero as `src/components/decor/DjConsole.tsx` (two turntables + mixer panel) to match the user-provided reference screenshot — the single-disc `Turntable` elsewhere (event cards/scan/stats) is correct as-is per the source markup.
- [x] Verified fix via a fresh bundle fetch against the running dev server (817ms rebuild, zero errors).

## Done — decorative graphics reproduced (`src/components/decor/`)

- [x] `Turntable.tsx` (react-native-svg — RN has no radial/conic-gradient primitive) — spinning grain-textured disc, reused at 4 sizes across login/redeem/scan/stats.
- [x] `ScatterAccents.tsx` — rotated-rect confetti accents, same 4 surfaces.
- [x] Verification: `typecheck`/`lint` clean (fixed one real `react-hooks/refs` finding), `pnpm boundaries` zero new violations.

## Done — structural gap-closing pass (per full read of the reference's script logic + user's "100% same" directive)

- [x] `AppScreenHeader` — shared back+event+LIVE-badge header, now on every tab (was: disconnected per-tab titles).
- [x] `TabIcons` — 5 hand-built geometric icons + active-tab pill background (was: text-only labels).
- [x] Toast system (`toastStore`/`ToastHost`) — matches reference's `flash(t)`.
- [x] `ResultSheet` — real bottom-sheet modal for scan results (was: inline cards, a different interaction pattern).
- [x] Scan screen: scanline animation, real running counter, functional Flash toggle, functional manual-code entry, Recent Scans list with ADMITTED/DENIED pills.
- [x] Guests: All/Checked-in/Pending filter chips (client-side, matching the reference's own client-side filtering).
- [x] Door Entry: Walk-ins/Dine-in tabs now show real data via new `fetchDoorSales` (`GET /door/sales`) — 2-stat-card row + real entry list, refetched after submit.
- [x] Verified against the running dev server after every batch — clean bundle, zero errors, not just static checks.

## Done — login screen fidelity pass (per screenshot-diff feedback)

- [x] `GalaTextInput`: added `surface?: boolean` prop — login inputs now render `#151313` fill (was incorrectly `#0B0A0A`, same as screen background); door-entry form inputs untouched (`#0B0A0A` is correct there, confirmed against markup).
- [x] `SplitButton` — new component: exact reference LOG IN button shape (left-aligned label + separate inset circular arrow button), replacing `GalaButton`'s centered-text pill for this one screen.
- [x] `login.tsx` rewritten: `surface` on all 3 inputs, `SplitButton label="LOG IN"` (was `GalaButton label="ENTER →"`), added "Remember this device" checkbox + "Forgot?" row, inline error moved below that row, "OR" divider, "Use a gate access code" outline pill button.
- [x] Verification: `typecheck`/`lint` clean (fixed 3 real `no-confusing-void-expression` findings from arrow-shorthand `onPress` handlers), dev-server bundle re-fetched (HTTP 200), `pnpm boundaries` still exactly 1 pre-existing unrelated violation.
- [ ] Not done: `DjConsole.tsx` visual density/quality pass (user flagged it still looks thinner than the reference's image-1 polish) — not started this round.
- [ ] Not done: no visual/screenshot verification possible from this environment — functional/structural correctness confirmed only; user's own screenshot is still the only real fidelity check.

## Done — hero background + DJ console deep rebuild (second fidelity round, from exact markup re-read)

- [x] Root cause confirmed: the hero was missing two whole graphic layers present in the reference (`template.html` line 223) — a conic-gradient light-beam pattern and a soft radial orange glow. The flat-opacity `heroGlow` View gave a hard-edged blob instead of a glow, and the beam layer didn't exist at all — this is the concrete cause of "background is still all black."
- [x] `src/components/decor/HeroRays.tsx` (new) — the conic-gradient's stop pairs are hard-edged bands (same color twice per stop), i.e. really just 3 static wedges, not a smooth blend — drawn as exact SVG pie slices converted from CSS's clockwise-from-north angle convention.
- [x] `src/components/decor/RadialGlow.tsx` (new) — reusable real `radial-gradient`-equivalent via SVG `RadialGradient`, replacing flat-opacity circles for both the hero glow and the console's under-panel glow.
- [x] `src/components/decor/wedge.ts` (new) — shared polar-coordinate math, used by both `HeroRays` and the DJ console's spinning sheen sweep.
- [x] `DjConsole.tsx` fully rebuilt against the exact markup nesting (not re-derived from memory): center deck label now spins together with the grain (was static — the reference nests it inside the rotating div); tonearm + headshell are one rigid rotated unit (was two independently-positioned pieces, so the headshell never actually rotated with the arm); added the chrome bearing ball with real radial-gradient sphere shading (was missing entirely); grain texture is now concentric vinyl-groove rings instead of a smooth radial blend; panel background uses `expo-linear-gradient` so it auto-sizes to the panel's real flex-computed height instead of a manually-sized SVG rect that could drift out of sync; knob/LED colors corrected to the exact per-row sequence transcribed from the markup (knobs are grey spheres with a small colored tick, not flat-colored circles as previously built); added the layered `box-shadow` "step" edge via two offset Views behind the panel.
- [x] Added `expo-linear-gradient@~55.0.18` (SDK-matched via `npx expo install`).
- [x] Real bug hit and fixed during verification: Metro failed to resolve the new `wedge.ts` module with a stale bundler cache after adding it — restarted the dev server with `--clear` (port 8090 was still held by the previous process, moved to 8091) and confirmed a clean 994-module bundle with zero resolution errors.
- [x] Verified: `typecheck`/`lint` clean (one `import-x/order` finding auto-fixed), dev server bundle rebuilt clean on a fresh cache, `pnpm boundaries` unchanged at the same 1 pre-existing violation.
- [ ] Not done, disclosed: the reference's sheen sweep is a true smooth conic-gradient; this is approximated with ~12 stepped-opacity wedge slices per lobe rather than a real blend (SVG has no conic-gradient primitive) — close but not pixel-identical up close.
- [ ] Not done: still no browser/screenshot access in this environment — every claim above is verified by code correctness and a clean bundle, not a pixel diff. The next real check needs the user's own screenshot.

## Done — third fidelity round: console geometry + login metrics (from side-by-side screenshots)

- [x] **Panel sized to the wrong box.** The reference panel has no explicit width, so it fills its 330px wrapper as a border-box; `PANEL_WIDTH` was set to 302 (the *content* width after padding+border). That stole 28px from the flex row, collapsing the `space-between` gaps from ~15px to ~1.5px — the decks were jammed against the mixer. Now 330.
- [x] **Deck rim drawn inside instead of outside.** `box-shadow:0 0 0 4px #3a3434, 0 0 0 5px #0a0909` paints a rim *outside* the deck's 100px box (110px visually, still 100px for layout — box-shadow never affects layout). It was being stroked inside the circle, eating the platter and losing the silver rim entirely. Now an overflowing 110px rim behind a 100px layout box.
- [x] **Console had no physical thickness.** The panel's `0 16px 0 #080707, 0 16px 0 1px #2A2626` slabs belong to the transformed element, so they tilt with it; they were untransformed siblings. All three now share one `tiltGroup` transform.
- [x] Grain texture is now the real 3px-period groove pattern (1px dark ring on a 2px lighter band), not evenly-spaced approximated rings.
- [x] Removed an invented light center dot on the deck label (`inset:13px` on a 26px label resolves to 0px — invisible in the reference) and an invented per-deck bearing tint (both decks use `#fff→#9a9290`).
- [x] Added the label's `inset 0 0 0 3px rgba(0,0,0,.18)` inner ring; fader/hFader thumbs are now gradients, not flat fills; mixer padding corrected to `6px 8px`; fader row gap 10 (was 8); panel gradient direction computed from the real `160deg` angle.
- [x] **SHOW button floated above the password input.** It was positioned against the label+input wrapper, so `top:8` measured from the top of the *label*. `GalaTextInput` now takes an `accessory` rendered in a wrapper around the input alone.
- [x] Login metrics corrected against the markup: form padding `14/20/28` and gap 14 (was 16 everywhere), input padding 18 (was 16), password padding-right 70 (was 84), label/input gap 7 (was 6), error text 12px (was 14), LOG IN label 15px/.14em with `margin-top:4`, footer no longer force-uppercased.
- [x] **Organization ID field removed from login** — it has no counterpart in the reference and is the single largest structural difference. The backend has no endpoint that resolves it (`POST /auth/login` returns only the user; no `/me` or memberships route), and it isn't a per-shift secret — a handset belongs to one venue for its deployed life. Now resolved from `EXPO_PUBLIC_ORGANIZATION_ID`, falling back to a SecureStore binding written on first successful login (`src/auth/venueBinding.ts`). A one-time venue field appears only when both are empty, so an unconfigured handset isn't bricked.
- [x] Verified: `typecheck`/`lint` clean (two real findings fixed — a deprecated `StyleSheet.absoluteFillObject` and an unsafe `any` from the new `extra` read).
- [ ] Not done: `EXPO_PUBLIC_ORGANIZATION_ID` is blank in `.env` — no real staging org id exists anywhere in either repo to seed it with, and inventing one would fail login confusingly. Until it's set (or one login completes), the login screen shows the extra venue field.

## Done — web target storage crash (`expo-secure-store` is native-only)

- [x] **Runtime crash fixed:** `ExpoSecureStore.default.getValueWithKeyAsync is not a function` in the browser. `expo-secure-store` has no web implementation at all — and the problem was wider than the new venue-binding code: `scannerSession.ts` and `deviceIdentity.ts` import it directly too, so pairing, session persistence and every authenticated call would have crashed as soon as the web target got past login. Latent since the web target was added earlier this session.
- [x] `src/storage/secureStorage.ts` (new) — the app's single persistence boundary; all three auth modules now route through it. Keychain/Keystore on a handset (contract-compliant), Web Storage on web with scopes split to limit the downgrade: `device`/localStorage for the non-secret device id, device name and venue binding; `session`/sessionStorage for the 12h scanner session token, so a live door credential doesn't outlive the browser session on a shared machine. All reads/writes try/catch'd (private mode and blocked site data throw on access).
- [x] Login's venue-binding lookup now has a `.catch` — unreadable storage falls through to asking for the venue id rather than crashing the screen.
- [x] Verified: `typecheck`/`lint` clean, dev server hot-rebuilt (63ms) and serves HTTP 200 with the error gone.
- [ ] **Disclosed security deviation:** the web build cannot meet the contract's SecureStore requirement (no browser equivalent exists) and should be treated as staff-supervised/preview. The handset build is the compliant one. Worth a decision from the team on whether the web target ships to real doors at all.

## Done — fourth round: tab shell + all five tabs taken through the same markup-transcription pass as login

- [x] **Tab bar rebuilt as a custom `tabBar`** (`(tabs)/_layout.tsx`). Two details can't be expressed via `screenOptions`: the active state is a pill behind the *whole* cell (icon + label), not a ring around the icon, and the bar sits over a 120px gradient scrim. Also added the real `backdrop-filter` via `expo-blur` (was faked with a more-opaque solid) and the `inset`/drop shadow pair. Labels were being force-uppercased by `typography.label` — the reference renders "Door Entry", not "DOOR ENTRY".
- [x] `TabIcons`: scan grid cells corrected to 9.5px (were 8.5 — the reference's `1fr 1fr` with `gap:3` on a 22px box), the 26px-wide Guests icon no longer clipped by a 22px wrapper, and the Settings dial is now the real 8-spoke `repeating-conic-gradient` drawn as SVG wedges (was a plain ring).
- [x] **`AppScreenHeader` moved into the tab layout** and now sources the event from the session itself. It was being rendered per-screen with a per-screen title, so the Door tab's header read "Door" instead of the event name. The reference has *both*: one shared event header, plus each tab's own big Anton title — several tabs were missing the latter entirely.
- [x] **Real functional bug fixed: `onTouchEnd` on a `View` does not fire for mouse clicks under react-native-web.** The Door segmented control, its gender/type choice buttons, the guest-count stepper, and the header back button were all dead on the web target. All converted to `Pressable`.
- [x] `door.tsx` rebuilt: literal values throughout (was `spacing`/`radii` tokens), its own "Door" title block, the reference's exact `ON`/`OFF` choice-button palette, `1fr 1fr 0.9fr` gender/age grid, and validation matching the reference's own order and messages.
- [x] `settings.tsx` rebuilt: added the entirely-missing ASSIGNED GATE 3-segment selector and the "Switch event" row; replaced RN's platform `Switch` with the reference's 50x30 pill toggle; profile card now has its scatter accents.
- [x] `guests.tsx` rebuilt: five filter chips, not three — the two tier filters (VIP, Guestlist) were missing; tier-coloured avatars; `IN`/`PENDING` status pills with the reference's exact colours.
- [x] `stats.tsx` rebuilt to the reference's full layout (hero card, tickets/door pair, chart card, gender split, three small cards).
- [x] Verified: `typecheck`/`lint` clean. Typecheck caught two real bugs mid-rebuild — the header was reading `event.name`/`event.venue` which don't exist on the contract's event shape (`title`/`venueId`), and lint caught two `??` guards on fields that aren't actually nullable.

## Done — Select Event screen + per-card 3D art (last screen in the reference)

- [x] `src/components/decor/EventCardArt.tsx` (new) — the reference gives each of its four cards a different composition; the build reused one turntable on all of them, which lost what makes the list read as four distinct nights. Now: a record beside its sleeve, two balloons, a lone turntable, and two striped party hats, each with the reference's `floaty` bob and its own rotation/delay.
- [x] `redeem.tsx` rebuilt: per-card palette/height/title-size cycling (200px for the first card, 180 for the rest), the date pill, the gate chip in the header that was missing entirely, the 44px arrow circle with per-card colours, and the 62px "Select / Event" title block at the markup's `26px 4px 18px`.
- [x] LIVE badge now keys off the event's real `status === 'live'` rather than always decorating the first card.
- [x] Deliberate functional addition: the reference jumps straight from a card tap into the app, but a real shift needs a door code redeemed for a scanner session (contract §5), so selecting a card reveals the code field.
- [x] Real lint finding fixed: `Rect`'s `x`/`y` props are deprecated in this react-native-svg version — stripe bands redrawn as paths. Also caught and fixed a clipping bug while doing it: the rotation was on the same `<G>` as the clip path, which would have rotated the cone's outline along with its stripes; the rotation now sits on an inner group so the cone stays upright.

## Not done — Stats data the backend cannot supply (layout built, numbers not invented)

`GET /door/stats` returns `occupancy` only (inside / capacity / remaining / prebooked). The reference's Stats screen shows considerably more. Current handling, and why:

- [x] CHECKED IN hero, capacity, percent, progress bar — real, straight from `occupancy`.
- [x] DOOR headcount and TABLES — real, derived from `GET /door/sales` records.
- [x] TICKETS — derived as `inside − doorHeads`. Defensible, but it is a derivation, not a reported figure.
- [x] GENDER SPLIT and AVG AGE — computed from door-sale records, which do carry gender/age, and labelled "door entries only" since scanned tickets carry neither. Partial by nature.
- [ ] ENTRIES / HOUR — no per-hour data exists in any endpoint. Card renders with an explicit unavailable note rather than a plausible-looking chart.
- [ ] REJECTED — no denied-scan count is exposed. Renders "—".
- [ ] **Backend gap worth a decision:** if Stats is meant to match the design, `GET /door/stats` needs hourly buckets, a denied count, and a gender/age breakdown across all entries, not just door sales.

## Not done — disclosed gaps (visually correct, functionally inert or partial — not fabricated)

- [ ] Stats screen: entries/hour bar chart, gender split, avg age, rejected count, tables count — `GET /door/stats` doesn't return these fields; shown as an explicit on-screen note, not fake numbers.
- [ ] Scan screen keeps a real live camera feed (`expo-camera`) alongside the reference's tap-to-scan mock pattern — a deliberate, disclosed departure (a real scanner needs a real camera); the reference's own tap/manual-code/scanline UI is now also present and functional.
- [ ] Settings: Offline mode toggle is disabled with an explanatory label (offline always denies per SOTA-2) rather than hidden or fake-enabled.
- [ ] No visual QA against a running simulator/device (native or web) — no camera/display/browser access in this environment; correctness verified by code inspection + a clean running dev-server bundle, not a pixel diff. `expo-camera` on the web target specifically is unverified.
- [ ] The reference's *exact* per-card bespoke 3D compositions (unique shapes per event card, the CSS `background-position`-looped grain texture) are approximated by one reusable `Turntable`+`ScatterAccents` pair, not rebuilt per-instance — same visual category, not pixel-identical per surface.

## Not done — open questions blocking full Phase 1 closure

- [ ] **Staff access-token refresh mechanism for native** — the contract's "refresh cookie" wording is browser-flavored; confirm with backend whether native gets a body-returned refresh token instead. No refresh logic exists yet; a 401 just fails today.
- [ ] Manual E2E walkthrough against real staging (pair → redeem → scan valid/couple/already-used → offline → recover → search roster → manual check-in → heartbeat observed, plus Door Entry walk-in/dine-in submit) — needs a physical device with camera access.

## Done — Phase 2 (money surfaces) + three contract defects found in the already-shipped walk-in/dine-in

Checking the frozen contract (`docs/api-contracts/scanner-app.md` §9) before building on top of walk-in/dine-in turned up defects in what was already there:

- [x] **`paymentMode` was never sent.** It is required on every money call. Walk-in and dine-in were posting without it.
- [x] **`totalGuests` was only sent for dine-in.** The contract is explicit that it is the priced party size and required on both — a walk-in was being priced with no headcount.
- [x] **`doorSaleSchema` claimed fields the server never returns.** It declared `guestPhone`, `guestAge` and `gender`; `DoorSaleResponse` returns headcount and money (`eventId`, `totalGuests`, `amountPaise`, `paymentMode`, `status`). The Door register rendered those three and so displayed "—" on every row, permanently. Schema corrected; the register now shows pax, payment mode and amount.
- [x] **Correction to an earlier claim in this file.** The previous round said Stats' gender split and average age were "computed from door-sale records, which do carry gender/age". That was wrong — those are write-only inputs and are never returned. Typecheck caught it the moment the schema was fixed. Both cards now state they are unavailable; a new TAKEN AT THE DOOR card shows real money instead.
- [x] Session now persists `tiers` — `POST /door/ticket-sale` needs a `tierId`, and the shift payload is the only place tiers arrive.

### New Phase 2 surfaces

- [x] **Paid ticket sale** (`POST /door/ticket-sale`) — folded into the Door form as a third entry Type rather than a fourth segment, since the form already asks what kind of entry this is and the reference's 3-segment control is the shape being matched. Tier list from the shift payload, sold-out tiers disabled via `tier.available`, `pricePaise × quantity` shown so staff collect the right cash (never sent — the server recomputes). **`replayed: true` surfaces as "do not collect again"**, which is the difference between a retry and a double charge.
- [x] **Cover-tab charging** (`POST /door/wallet-qr` + `/door/wallet-charge`) — `app/wallet.tsx`. Buttons render from `presetItems`; there is no free-amount keypad because the API has no amount field. Null `balancePaise` renders as "hidden by venue", never `0`. The QR is re-scanned for every charge (the call takes the QR, not a saved wallet id). The 3-per-minute velocity limit is enforced client-side so staff don't hit a server refusal mid-queue.
- [x] Real lint finding fixed: the velocity gate computed `Date.now()` during render — impure, and the limit would never have cleared on its own since nothing triggers a re-render when time passes. Now pruned on a timer.
- [x] Verified: `typecheck`/`lint` clean.

### Deviations from the reference, deliberate

- Cover tab is a separate route reached from the Door tab, not a sixth tab: the reference's nav is a fixed five, and this surface only exists for shifts granted `canCharge`. `05-cover-wallet-door-sales.md` D1 calls it a "Charge tab" — worth confirming whether a sixth tab is wanted instead.
- The form still requires phone/gender/age, which the contract treats as optional, because the reference marks them required. Stricter than the server; flag if that blocks real entries.

## Done — Phase 3 (operator escalation) + a foundational Phase 1 defect found first

Before building override, checked whether the existing manual-check-in path even had the right permission gating — since override needs the identical `ticket.override` right. It didn't, and the check surfaced something worse underneath.

- [x] **`doorGuestSchema` was wrong in kind, not just missing fields.** It used `entitlementId`/`holderName`/`tierName`/a free-text `status` — none of which the server returns. The real `DoorGuest` (`packages/contracts/src/contracts/phase5.ts`) is `id`/`name`/`ticketType`/`entryType`/`quantity`/`source`/a `status` enum of exactly `entered`|`not_entered`. **Every guest-roster fetch would have thrown a zod validation error against real staging** — this was never exercised against the actual backend before now.
- [x] **`guestListResponseSchema` required a `cursor` key the server never sends.** The roster uses `limit` + `truncated`, not cursor pagination. Compounding the previous defect — the fetch would fail before the guest-shape mismatch was even reached.
- [x] **`manualCheckIn` parsed the wrong response schema entirely.** It ran the result through `checkInResultSchema` (the camera-scan discriminated union: consumed/denied/confirmation_required). The real response to `POST /door/guests/check-in` is `{ guest: DoorGuest, checkInId }` — a completely different shape. Manual check-in would have thrown on every successful call.
- [x] **No permission gate existed for manual check-in at all.** The contract and the backend route both require `ticket.override` (a role-level RBAC right — owner/admin/manager, not member — separate from the door-session's `canScan`/`canWalkIn`/`canCharge` booleans). Any staff could tap the button and get an unexplained 403.
- [x] `guests.tsx` rebuilt against the corrected schema: three real filters (All/Entered/Not entered) replacing five, two of which (VIP/Guestlist) were fabricated tier categories with no corresponding field on `DoorGuest`.
- [x] `canOverride(role)` added to `staffAuth.ts` — a UI-only mirror of the backend's RBAC rule, explicitly documented as not a security boundary (the server enforces the real thing and 403s regardless).

### New Phase 3 surfaces

- [x] **Staff-deny** (`POST /door/staff-deny`) — "Deny without a ticket" link under the Scan screen's manual-code panel, for refusing someone who never presents a scannable ticket (a banned patron, or a code the camera can't read). Reused the manual-code field as an optional `qrPayload` if one was typed. Does not spend the ticket, per the contract.
- [x] **Override** (`POST /door/override`) — an OVERRIDE pill on denied Recent Scans rows, shown only to staff `canOverride` returns true for, opening a reason-capture modal (the endpoint requires a non-empty reason; a hardcoded placeholder string was considered and rejected — it would have destroyed the actual audit trail the field exists for). `denyReason`/`denyMessage` are left on the row per the contract; the UI marks it OVERRIDDEN rather than rewriting it to ADMITTED.
- [x] `RecentEntry` now carries the scan's real `checkInId` (present for denied entries, null for admitted ones — nothing to override on an admission) so override has something to act on.
- [x] Verified: `typecheck`/`lint` clean, `pnpm boundaries` unchanged at the same 1 pre-existing violation.

## Done — Phase 1 & 2 E2E run against a real backend, and six real defects found and fixed

Ran the actual HTTP sequence `scannerApiClient.ts` sends against a local, Firestore-backed `api-gateway` instance (the deployed staging backend's CORS policy is explicit-list/no-wildcard by design and will never allow a localhost dev port — pointed `apps/scanner-app/.env` at `http://localhost:8080` instead, and widened the *local* gateway's `ALLOWED_ORIGINS` in its gitignored `.env.local`). Seeded real data (`apps/api-gateway/src/scripts/seed-scanner-e2e.ts`, `seed_e2e_`-prefixed, confirmed with the user before writing to the live `c1rcle-v2` Firestore project) and drove every Phase 1–3 endpoint end to end (`apps/api-gateway/src/scripts/e2e-scanner-check.ts`).

**Not a substitute for the documented manual walkthrough** — no browser-automation tool exists in this environment, so nothing clicked a button in the running app. What it proves: the real backend, end to end, returns what the frontend's schemas expect.

**Six real defects found, all fixed, all invisible to `pnpm test` (which runs against in-memory repos that don't replicate real Firestore transaction/index semantics):**

1. `v2_scan_ledger` was missing 2 composite indexes the admission-stats aggregate needs — genuinely absent from the committed `firestore.indexes.json`, not just undeployed. Added + deployed (`firebase deploy --only firestore:indexes`).
2. `GET /door/sales` 500'd on every empty result (`pageInfo.pageSize: query.limit ?? items.length` → `0` when no sales exist yet, failing its own response schema). Fixed to `?? 1000` (the documented fetch cap).
3. Every walk-in/dine-in creation 500'd — `door-service.ts`'s `auditRecord()` passed bare `undefined` (not the documented `null`) for a create's `before`/`after`; Firestore Admin SDK rejects literal `undefined`. Fixed with `?? null`.
4. The identical bug, independently, in `cover-wallet-service.ts`'s own `auditRecord()` — every wallet-charge 500'd for the same reason. Same fix.
5. **`recordTicketSale` never actually settled any paid order — door or online, this writer is shared with the live checkout path.** `FirestoreLedgerRepository.createBatch` read-then-wrote inside a loop inside one transaction; Firestore requires all reads before any writes, violated on every real sale (4+ ledger entries). Failure was silent: order/tickets save via earlier separate writes regardless, and the idempotent-replay path never re-attempts settlement — a sold, walked-in ticket could get **no ledger entry, ever, with no retry error to reveal it**. Fixed: read every idempotency doc up front, before any write.
6. `staffDenyResponseSchema` (frontend, written earlier this session) declared a minimal shape matching the contract doc's abbreviated prose; the real response is the full `CheckInDto`, keyed `id` not `checkInId`. Fixed the schema and its one call site in `scan.tsx`.

**Result: 24/25 checks passed** (login, pairing, redeem, valid/couple/already-used scan, guest roster, heartbeat, walk-in, dine-in, door sales, ticket-sale with genuine idempotent replay, staff-deny, override, stats, cover-wallet charging). The one non-pass is a test-ordering artifact (entitlements already consumed by earlier steps in the same run), confirmed by direct re-check, not assumed. Backend regressions: `api-gateway` (529 tests) and `@c1rcle/core` (584 tests) both fully green after all six fixes.

## Done — fifth fidelity round: login-navigation bug, stale seed data, Select Event markup fixes, Scan Ticket header gap

- [x] Fixed login-stuck-on-login-page bug: `notifyAuthStateChanged()` pub-sub pattern replaces direct `router.replace()` in login/pairing/redeem/logout (see `implementation.md`).
- [x] Split `paired_no_session` into `needs_pairing`/`needs_redeem` states — a just-paired device was looping back to `/pairing` instead of reaching `/redeem`.
- [x] Fixed "no events appear" — stale seed data (calendar-day mismatch), not a code bug. Re-seeded.
- [x] Verified color tokens twice against user-supplied analyses — both false alarms (tokens already exact; one screenshot was a DevTools inspection-overlay artifact).
- [x] `redeem.tsx`: fixed real card-border/letter-spacing/line-height deviations from the markup; added `cardTitleBlock` `maxWidth: '62%'` so long real titles don't run under the card art.
- [x] **`scan.tsx`: added the missing event-context header** (back button → `/redeem`, event title, gate, LIVE badge) sourced from `getSessionMeta()` — the screen previously jumped straight to "Scan Ticket" with no link back to which event/gate was redeemed, a real structural gap vs. the reference's `isScan` block.
- [x] **`scan.tsx`: checked-in counter now reads `inside / capacity`** via `fetchStats(event.id)` on mount (was a client-local `recent.filter(admitted).length` with no denominator, unrelated to the actual event occupancy). Bumped locally on each real admit so it doesn't lag between polls.
- [x] Verified: `typecheck`/`lint` clean, dev server restarted clean, `200` on `:8090`.
- [ ] Not done: no periodic re-poll of `fetchStats` — single fetch on mount, live SSE/poll stats stream stays Phase 4 scope per the architecture doc.

## Done — D-030: device + GPS geofence layered on top of the door code

- [x] Raised concerns before building (via `AskUserQuestion`) on dropping door code for device+IP auth: code does per-shift revoke/permission-scope/event-select, none of which device pairing alone replaces; IP geofencing unreliable on cellular. User chose: keep code, add GPS as an extra layer.
- [x] `scannerSessionCreateBodySchema` — additive optional `deviceLocation:{lat,lng}`.
- [x] `door-ops-service.ts` — `enforceGeofence()` in `startShift()`, haversine vs. `Venue.public.address.lat/lng` (already existed, no migration), 500m radius, skips silently when either side of the comparison is missing.
- [x] `venues` repo wired into `DoorOpsServiceDeps` / `v2-services.ts`; route forwards `body.deviceLocation`.
- [x] Denial surfaces as 404 (existing `hideForbidden: true` IDOR convention on this route), not a new 403 — deliberate, matched to the codebase's own pattern.
- [x] `scanner-routes.test.ts` — 3 new tests (inside radius/far outside/no-location-sent), real venue+coords seeded since existing fixtures use `venueId: null`.
- [x] Frontend: `expo-location` installed, `app.config.ts` permission strings + plugin, `redeem.tsx`'s `tryGetDeviceLocation()` (permission-gated, never throws), wired into `handleRedeem`; `scannerApiClient.redeemDoorCode` accepts the optional field.
- [x] Verified: contracts build clean; core (580 passed) and api-gateway (532 passed, +3 new) full suites green; scanner-app `typecheck`/`lint` clean; both dev servers confirmed live post-change (`tsx watch` auto-reload on backend, `--clear` rebuild on frontend for the new native module).
- [ ] Not done, disclosed: no per-scan geofence (shift-open only), no IP-based check (GPS is the substitute), no admin UI to set a venue's lat/lng — check is a silent no-op until one exists.

## Done — Phase 4 SSE live stats: backend already existed, frontend now consumes it

- [x] **Doc correction:** `task.md` said "Phase 4+ not started" — false. `GET /door/stats/stream` was already fully implemented and tested in `phase5-routes.ts` (`door-stats-stream.test.ts`, all passing, connection-budget limiter and all). The frontend just never switched off polling.
- [x] `stats.tsx` rewired: occupancy now comes from the SSE stream (`onStats` per frame), not a 15s `setInterval` poll. Door-sale-derived numbers (walk-ins/dine-ins → tables/revenue) still poll — no stream exists for those, only occupancy is streamed. Auto-reconnects 2s after any close (covers the server's own bounded 15-minute stream lifetime rotating, and ordinary drops).
- [x] **Added `ApiClient.openEventStream`** (`packages/api-client`) rather than a raw `fetch`/`EventSource` in the app — this repo's architecture rule (`no-restricted-globals`/`no-restricted-syntax` ESLint rules) forbids any module but `@c1rcle/api-client` from touching the network, and plain `EventSource` can't attach the `Authorization`/`X-Organization-Id` headers this endpoint requires anyway (exactly the credential-in-query-string leak SSE was chosen over WebSocket to avoid, per `phase5-routes.ts`'s own header comment). New method reuses `#send`'s existing base-URL/auth/error handling, reads the body via a `ReadableStream` reader, and parses SSE frames (`event:`/`data:` pairs, bare `: keep-alive` comments dropped).
- [x] `scannerApiClient.ts`'s `openStatsStream` now a thin wrapper over `openEventStream`, dispatching `stats`/`closed` frames to zod-validated handlers.
- [x] Real lint-driven fix along the way: a `let closed = false` flag mutated only inside a separately-returned closure hit TS's control-flow narrowing (`no-unnecessary-condition` false positive — genuinely can't see the async mutation). Replaced with checking `signal.aborted` through a named function, which also fixed a real gap: the old flag never reflected an externally-passed `AbortSignal` firing, only the client's own.
- [x] Verified: `@c1rcle/api-client` build/lint/test clean (18/18, no regression), scanner-app `typecheck`/`lint` clean, dev server restarted `--clear` (workspace package changed), confirmed `200` on a fresh 1009-module bundle.
- [ ] Not done, disclosed: no automated test added for the frontend stream-consumption path itself (no browser/E2E harness in this environment) — correctness here rests on typecheck/lint plus a byte-for-byte read of the server's own frame-writing code (`phase5-routes.ts`'s `send()`), not a running client-server round trip.

## Done — Phase 2 exit criterion closed: real double-charge race found and fixed

- [x] Resumed and ran `e2e-double-tap-check.ts` (written earlier, never run) against fresh seed data. **Found a real double-charge**: two concurrent identical-idempotency-key requests both debited the cover wallet. Also found ticket-sale leaking a raw domain "Version conflict" error under the same race instead of a clean idempotency response.
- [x] Root cause: `wallet-charge` and `ticket-sale` were the only two door-money routes not wrapped in the generic atomic `runIdempotent` claim — they passed `idempotencyKey` straight into a domain-level `findByIdempotencyKey` (read) → write check, a classic TOCTOU race. Walk-in/dine-in/check-ins were already correctly protected (confirmed clean `409 already in flight` under the same test, not a bug — fixed the test's wrong assertion instead of the routes).
- [x] Fix: wrapped both routes in the same atomic `runIdempotent` claim, keyed off `body.idempotencyKey`. No data migration — the separately-tracked `DoorSale`/`CoverWalletTxn` id-scheme migration (Fix 3/4 below) stays deferred; this closes the exploit without it.
- [x] Fixed a regression the wrap caused: ticket-sale's legitimate sequential-retry test broke (returned frozen `201` instead of `200`/`replayed:true`) — fixed by making the outer layer's own `replayed` flag authoritative over the frozen stored response.
- [x] Re-seeded, re-ran the double-tap script against the fix: **5/5 passed**, including the two that previously failed.
- [x] Verified: `@c1rcle/core`/`api-gateway` typecheck+lint clean, full `api-gateway` suite green (532/532).
- [x] **Phase 2's exit criterion is now closed** — genuine concurrent double-tap ran against the real backend and confirmed safe.

## Not done — remaining

- [x] SSE live stats (Phase 4) — closed above; was actually already built backend-side, frontend now wired to it too.
- [x] **Attendance-report endpoint (Phase 5) — built.** `GET /door/attendance-report?eventId=` (`door-ops-routes.ts`), backed by `DoorOpsService.getAttendanceReport`. Per `07-storage-sizing-caching.md` §5b's own confirmed scope: answers who entered/didn't, when, and the real headcount (`admittedCount` sums `scanCount` so a half-used couple ticket counts correctly), scoped to `Entitlement` only — door-sold guests already have `GET /door/sales`. Deliberately does NOT add a gate/device/hour breakdown (needs `ScanLedger` grouped queries against composite indexes not verified for this exact shape — stays out rather than being built on an unconfirmed index). Voided entitlements are excluded from the guest list entirely (a refund is not a no-show) — caught by a failing test, not written correctly the first time. 3 new tests (headcount math incl. a half-used couple ticket, cross-tenant 404, empty-event zeros); full `api-gateway` suite green (535/535, was 532), `@c1rcle/core` unchanged at 580/584 (4 skipped).
- [x] **Phase 2's exit criterion, closed above** (see "Phase 2 exit criterion closed" section) — a genuine concurrent double-tap ran against the real backend, found and fixed a real double-charge race. Superseded this line, kept for history.
- [ ] **The documented manual walkthrough (physical device, real camera, a human tapping through the app) has still never been run.** The HTTP-level E2E pass above now stands in for a meaningful slice of Phase 1's exit criterion, but it is not the same thing and should not be treated as closing it. This needs a physical device — cannot be done from this environment.

## Upcoming — Phase 2+ (superseded by the section above; kept for the original ordering)

- [ ] Cover-wallet charge tab
- [ ] Paid ticket-sale (`/door/ticket-sale`, tiered pricing) — walk-in/dine-in headcount entries are now done, ticket-sale is not
- [ ] Staff-deny / override UI
- [ ] SSE live stats
- [ ] Attendance-report endpoint (backend, likely admin-console-facing — `07-storage-sizing-caching.md` §5b)
