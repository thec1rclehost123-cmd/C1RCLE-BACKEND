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

## Not done — disclosed gaps (visually correct, functionally inert or partial — not fabricated)

- [ ] Stats screen: entries/hour bar chart, gender split, avg age, rejected count, tables count — `GET /door/stats` doesn't return these fields; shown as an explicit on-screen note, not fake numbers.
- [ ] Scan screen keeps a real live camera feed (`expo-camera`) alongside the reference's tap-to-scan mock pattern — a deliberate, disclosed departure (a real scanner needs a real camera); the reference's own tap/manual-code/scanline UI is now also present and functional.
- [ ] Settings: Offline mode toggle is disabled with an explanatory label (offline always denies per SOTA-2) rather than hidden or fake-enabled.
- [ ] No visual QA against a running simulator/device (native or web) — no camera/display/browser access in this environment; correctness verified by code inspection + a clean running dev-server bundle, not a pixel diff. `expo-camera` on the web target specifically is unverified.
- [ ] The reference's *exact* per-card bespoke 3D compositions (unique shapes per event card, the CSS `background-position`-looped grain texture) are approximated by one reusable `Turntable`+`ScatterAccents` pair, not rebuilt per-instance — same visual category, not pixel-identical per surface.

## Not done — open questions blocking full Phase 1 closure

- [ ] **Staff access-token refresh mechanism for native** — the contract's "refresh cookie" wording is browser-flavored; confirm with backend whether native gets a body-returned refresh token instead. No refresh logic exists yet; a 401 just fails today.
- [ ] Manual E2E walkthrough against real staging (pair → redeem → scan valid/couple/already-used → offline → recover → search roster → manual check-in → heartbeat observed, plus Door Entry walk-in/dine-in submit) — needs a physical device with camera access.

## Upcoming — Phase 2+ (deferred by design, not started)

- [ ] Cover-wallet charge tab
- [ ] Paid ticket-sale (`/door/ticket-sale`, tiered pricing) — walk-in/dine-in headcount entries are now done, ticket-sale is not
- [ ] Staff-deny / override UI
- [ ] SSE live stats
- [ ] Attendance-report endpoint (backend, likely admin-console-facing — `07-storage-sizing-caching.md` §5b)
