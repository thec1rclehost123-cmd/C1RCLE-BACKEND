<!--
agent-metadata:
  doc: scanner-app/implementation
  kind: log
  purpose: Append-only, granular implementation log. Each entry logged as soon as that unit of work finishes, with why/why-not and what's next.
-->

# Scanner App — Implementation Log

> Append-only. Newest entry at the bottom. Each entry: what changed, why,
> what alternative was rejected and why, and what it unblocks next. See
> [`task.md`](task.md) for the current snapshot of what's done/pending.

---

## 2026-09-23 — Doc set + trackers created

**What:** Full `docs/scanner-app/` doc set (`README.md`,
`sota-architecture.md`, `01`–`07`), plus this log and `task.md`.

**Why:** User wanted an extreme-depth reference doc before any code, so
the frontend build has one binding source of truth (field types,
provenance, sizing, rollout order) instead of being designed from memory
of the contract doc alone.

**Why not skip straight to code:** the backend was flagged as "not up to
mark" and the frontend needs to match a specific luxury visual direction
(two Stitch mockups) — writing the structural-deviation audit first
(README §6) turned "not up to mark" into four concrete, fixable items
instead of a vague complaint.

**Unblocks:** backend modular-monolith fixes and the frontend scaffold,
both tracked in `task.md`.

---

## 2026-09-23 — Backend fix 1/4: `scanner-service.ts` moved into `application/door/`

**What:** `packages/core/src/application/scanner/scanner-service.ts` →
`packages/core/src/application/door/scanner-service.ts`. Updated the
three import sites (`application/index.ts`,
`door-ops-service.ts`, `door-ticket-sale-service.ts`) to the new
sibling-relative path (`./scanner-service.js` instead of
`../scanner/scanner-service.js`). Deleted the now-empty
`application/scanner/` directory.

**Why:** README §6.1 — one feature (door operations) had its service
files split across two sibling directories with no functional reason,
purely a navigation cost for anyone reading the module for the first
time. Modular monolith means one module owns one directory.

**Why not also rename the file** (e.g. to fold it into `door-service.ts`
directly): `scanner-service.ts` is a large, independently-tested unit
(camera scan, sessions, device pairing, confirm/deny/override) — merging
it into another file would just create a different navigation problem
(one giant file) without fixing anything. Moving the directory, not the
file's identity, was the actual bug.

**Verified:** `pnpm --filter core typecheck` clean, `pnpm --filter core
build` clean, `pnpm --filter api-gateway typecheck` clean, `pnpm --filter
core test` — 495 passed, 3 skipped (pre-existing skips, unrelated to this
move), 0 new failures.

**Unblocks:** fix 2/4 (extract `cover-wallet-service.ts`) — next.

---

## 2026-09-23 — Backend fixes 2/4 and 3/4: deferred, not skipped

**What:** Looked at what fix 2 (extract `cover-wallet-service.ts` out of
`firestore-cover-wallet-repository.ts`) and fix 3 (fix the `DoorSale`/
`CoverWalletTxn` id schemes) would actually require.

**Why deferred:** fix 2 means restructuring 839 (Firestore) + 635 (memory)
lines of money-handling transaction code across two storage backends and
every caller — a real, careful refactor, not a mechanical move like fix 1.
Fix 3 is worse: `CoverWalletTxn`/`DoorSale` ids are already live in
whatever environment this has run against; changing the id scheme is a
migration (old docs keep old-scheme ids, new docs get new ids, or a
backfill script), not a pure code change. Rushing either under time
pressure risks a real bug in payment-adjacent code — the exact thing this
whole doc set's threat-model section warns against doing carelessly.

**Why not skip entirely either:** both are logged in `task.md` as
explicitly upcoming, not silently dropped. The user's stated priority
this session is the frontend; these two get their own dedicated pass.

**Decision:** proceed to backend fix 4/4 (safe, additive) and the
frontend scaffold now; fixes 2 and 3 stay open, tracked, not forgotten.

---

## 2026-09-23 — Backend fix 4/4: `firestore.indexes.json` committed

**What:** Added `firestore.indexes.json` (the 8 composite indexes
prescribed in `docs/architecture/scanner-threat-model.md` §3.7 /
`docs/scanner-app/03-data-model.md` §4.2, transcribed exactly) and
`firebase.json` (didn't exist at all — added the minimal config pointing
at the indexes file so `firebase deploy --only firestore:indexes` is now
a real, working command instead of a doc-only prescription).

**Why:** README §6.4 — indexes were documented as required but never
committed as deployable config. With indefinite retention now confirmed
(`07-storage-sizing-caching.md` §5b), an ever-growing `v2_scan_ledger`
without these indexes gets slower every event, not just at some future
scale.

**Why not more indexes than the documented 8:** adding speculative
indexes beyond what the threat-model doc specified would be guessing at
query patterns nobody has confirmed yet — the 8 are the ones an actual
security/query-pattern review already identified.

**Verified:** pure JSON addition, no code path changed — no test run
needed, but confirmed the field names match `03-data-model.md`'s
`ScanLedger` table exactly (`eventId`, `isOffline`, `scannedAt`,
`entitlementId`, `organizationId`, `deviceId`, `operatorUid`, `status`).

**Unblocks:** frontend scaffold — next.

---

## 2026-09-23 — Frontend scaffold: `apps/scanner-app` created, monorepo tooling wired

**What:** In `C1RCLE-FRONTEND`:
- `packages/tsconfig/react-native.json` (extends `base.json`, RN jsx mode,
  no DOM lib) + registered in `packages/tsconfig/package.json` exports.
- `packages/eslint-config/src/react-native.ts` (extends `baseConfig`
  directly, not `reactConfig`, to avoid the web apps' inline-`style` ban)
  + registered in `index.ts` and `package.json` exports, built.
- `apps/scanner-app/`: `package.json` (`@c1rcle/app-scanner-app`),
  `app.config.ts`, `metro.config.js` (pnpm-workspace-aware resolver),
  `babel.config.js`, `tsconfig.json`, `eslint.config.ts`,
  `.env.example`, `src/config/env.ts` (this app's one env-owner module,
  `EXPO_PUBLIC_*` via `expo-constants`, zod-validated), `src/theme/tokens.ts`
  (the Nocturne Gala palette/type-scale ported from both Stitch mockups'
  `DESIGN.md`), and a placeholder `app/_layout.tsx` + `app/index.tsx`
  proving the scaffold actually resolves.

**Why:** README §"Repo location" — user's explicit choice (new app inside
`C1RCLE-FRONTEND`, not a standalone repo), following the exact structure
this session's own plan agent laid out before the pivot to docs-first.

**Real bugs found and fixed while verifying (not just "wrote files and
moved on"):**
1. `tokens.ts`'s doc comment contained a literal `*/` inside a file path
   string, closing the block comment early and cascading into seven
   unrelated-looking TS parse errors. Rewrote the comment to avoid the
   sequence.
2. `app.config.ts` used an Expo config field name that doesn't exist on
   the current SDK's `ExpoConfig` type; and two `process.env['VAR']` reads
   needed bracket notation under this repo's
   `noPropertyAccessFromIndexSignature` strictness.
3. `react-native.ts`'s scoped eslint overrides used a repo-root-relative
   glob (`apps/scanner-app/app/**/*.tsx`) — but flat config resolves
   `files` relative to the *consuming* app's own `eslint.config.ts`
   directory, so the pattern was silently doubling the path and never
   matching. Fixed to `app/**/*.tsx` / `src/config/env.ts`.
4. The same file's general `**/*.ts`/`**/*.tsx` rule block re-declared
   `no-restricted-syntax` and, since it came after `baseConfig`'s own
   config-file exemption in the merged array, silently re-banned
   `process.env` inside `app.config.ts` and `env.ts` again. Added an
   `ignores`/explicit exemption so the later, more specific rule doesn't
   clobber the earlier, more specific exemption.
5. `babel.config.js`/`metro.config.js` are plain CommonJS outside every
   `tsconfig` `include` — every type-aware rule threw "no type
   information" until scoped with `tseslint.configs.disableTypeChecked`
   (confirmed via `node -e` that it's a plain rules object, not a
   `tseslint.config()`-shaped array, before spreading it).
6. `z.string().url()` is deprecated in the installed zod version — `z.url()`.

**Why not skip the verification and just say "done":** every one of
these six is exactly the kind of error that looks fine on paper and fails
the moment someone actually runs `lint`/`typecheck` — logging "created
the scaffold" without running both would have been a false "done."

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean, `pnpm boundaries` shows
zero new violations (the one violation present is pre-existing, in
`guest-portal`, unrelated to this work), and the three existing web apps'
`typecheck` all still pass unaffected by the `eslint-config` package
changes.

**Not done yet, deliberately:** no auth/session modules, no API client
wiring, no real screens beyond a placeholder — those are the next
entries, per `task.md`.

**Unblocks:** device pairing + staff login screens — next.

---

## 2026-09-23 — Auth, session, and API client layer

**What:** `src/auth/staffAuth.ts` (in-memory-only staff access token +
org id, mirrors the pattern `packages/auth/src/session-store.ts` already
uses on web), `src/auth/deviceIdentity.ts` (opaque device id + pairing
flag in `expo-secure-store`), `src/auth/scannerSession.ts` (12h session
token + meta in `expo-secure-store`), `src/auth/authState.ts`
(`logged_out -> paired_no_session -> active_session` state machine hook),
`src/features/scan/coupleConfirm.ts` (real countdown from the server's
own `expiresAt`, deadline-math not `setTimeout` drift), `src/api/schemas.ts`
(zod response shapes transcribed from the contract doc), and
`src/api/scannerApiClient.ts` (wraps `@c1rcle/api-client` directly, adds
`X-Organization-Id`/`X-Scanner-Session-Token` headers per call since the
base client only knows about `Authorization`).

**Why:** this is the Phase 1 plan's auth/session/API design, executed —
`packages/auth`'s own `auth-client.ts` was confirmed unusable here (browser
cookie + CSRF model, no RN equivalent), so this is deliberately app-local,
matching the "bias toward app-local" call made when the plan was written.

**Real bugs found and fixed during verification:**
1. `sendHeartbeat` initially passed `schema: undefined as never` — would
   have thrown at runtime the first time `#parse` called
   `schema.safeParse` on `undefined`. Fixed to a real `z.unknown()` schema.
2. `exactOptionalPropertyTypes` (this repo's strict tsconfig) rejected
   passing `operatorName: undefined` explicitly — fixed with a conditional
   spread instead of an explicit `undefined` value.
3. `withOrgHeader`/`withSessionHeader` were both declared `async` with no
   `await` inside `withOrgHeader` — `@typescript-eslint/require-await`
   caught it; made `withOrgHeader` synchronous and removed the now-dead
   `await` at its three call sites.
4. `authState.ts`'s cancellation-flag pattern (`let cancelled = false`)
   made TypeScript's type-aware `no-unnecessary-condition` rule see
   `!cancelled` as always-true, because a `let` isn't narrowed across an
   async closure boundary the way a `useRef` is — switched to
   `useRef(false)`, the standard fix for this exact pattern.
5. `app.config.ts`'s `process.env['EXPO_PUBLIC_*']` reads tripped
   `no-unsafe-assignment` despite matching the bracket-notation convention
   used elsewhere in this monorepo (e.g. `admin-console/playwright.config.ts`)
   — those other files aren't part of their app's own type-checked
   project; this one deliberately is (so the rest of the file gets real
   type-checking). Scoped a narrow, file-specific rule-off instead of
   either silently accepting the error or de-typing the whole file.
6. Import order: `import-x/order` puts the `@c1rcle/**` path group in the
   "internal" bucket, which sorts AFTER plain external packages like
   `zod` in this config's group order — counter-intuitive alphabetically
   but consistent with every other file in the monorepo; used `eslint --fix`
   rather than hand-guessing the exact expected blank-line placement.

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean.

**Not done yet:** no screens consume any of this yet — that's next.

---

## 2026-09-23 — Phase 1 screens, heartbeat, fonts, and CI gate — Phase 1 complete

**What:** every screen in the Phase 1 scope now exists and is wired to the
real API/auth layer: `app/login.tsx`, `app/pairing.tsx`, `app/redeem.tsx`,
`app/(tabs)/scan.tsx` (camera + admit/deny/couple-confirm + offline-deny),
`app/(tabs)/guests.tsx` (debounced server search, `truncated` banner,
manual check-in), `app/(tabs)/stats.tsx` (focus-gated polling), plus two
shared components (`GalaButton`, `GalaTextInput`) and
`src/features/heartbeat/useHeartbeat.ts` (fires from the tab shell, so it
runs exactly while a session is active and the app is foregrounded).
`app/_layout.tsx` now loads the Nocturne Gala fonts
(`@expo-google-fonts/bodoni-moda`, `plus-jakarta-sans`) and gates all
navigation on `useScannerAuthState()` via a single `Redirect`.
`.github/workflows/ci.yml` got a scanner-app-specific env-seed step (its
own `.env`, not folded into the Next.js apps' `.env.local` loop) and an
explanatory comment on why it's excluded from the Playwright `e2e` matrix.

**Real bugs found and fixed during verification** (same discipline as the
auth-layer pass — every one is exactly the kind of thing that looks fine
until `lint`/`typecheck` actually runs):
1. `exactOptionalPropertyTypes` rejected an `undefined`-valued optional
   field again in `guests.tsx` — same conditional-spread fix as before.
2. `redeem.tsx` called `setState` synchronously inside a `useEffect` body
   for the "no org id" branch — `react-hooks/set-state-in-effect` (a real,
   not-cosmetic warning: this pattern causes an extra cascading render for
   a value that's actually static after mount). Fixed by reading
   `getOrganizationId()` directly in render (it's a synchronous module-
   state read, not a subscription) instead of stashing it through an
   effect.
3. `_layout.tsx`'s initial `<Redirect>` + `<Slot>` combination would have
   rendered BOTH simultaneously during the "checking" state transition —
   fixed so `Slot` only renders while genuinely checking, `Redirect`
   render replaces it entirely once a state is known, never both at once.
4. A dozen `no-confusing-void-expression` hits (arrow-shorthand callbacks
   returning `void`) across `guests.tsx`, `scan.tsx`, `pairing.tsx`,
   `redeem.tsx`, and `useHeartbeat.ts` — all fixed via `eslint --fix`
   rather than hand-editing each one, since the mechanical fix (add
   braces) is unambiguous and hand-editing risks a typo the auto-fixer
   won't make.
5. Import-order fixes (`zod` before `@c1rcle/api-client`, `expo-font`
   before `expo-router`) — same "internal path-group sorts after external"
   rule from the earlier auth-layer pass, same `eslint --fix` resolution.

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean, `pnpm boundaries`
shows zero new violations (the one pre-existing `guest-portal` violation
is untouched by this work), and a full regression pass on all three
existing web apps (`admin-console`, `guest-portal`, `partner-dashboard`)
— lint and typecheck both clean, confirming the `eslint-config`/CI changes
introduced no regressions. `.github/workflows/ci.yml` re-validated as
syntactically correct YAML.

**Not done, deliberately (Phase 0's open question, unresolved):** no
refresh-token logic for the staff access token — a 401 simply fails today.
This was flagged as needing a real answer from backend (cookie-based per
the contract's web-flavored wording, vs. a body-returned token for
native) before writing that logic, not guessed at.

**This closes Phase 1** (core scan flow) per `docs/scanner-app/06-v1-vs-v2-and-rollout.md`'s
phase table — pending the Phase 0 refresh-token question and a real
device-manual E2E run against staging (no physical device/camera access
in this environment to run that walkthrough here).

---

## 2026-09-23 — New UI reference reviewed: `ui_example/claude_design_ui/Circle Scanner.html`

**What:** user supplied a second design reference (a claude.ai artifact,
saved locally at `apps/scanner-app/ui_example/claude_design_ui/Circle Scanner.html`,
plus an equivalent hosted link that couldn't be read directly earlier in
this session). Unlike the hosted link, this local copy's `__bundler/template`
script tag contains readable `<x-dc>`/`{{ }}` HTML+CSS source — extracted
and read in full (not the compiled JS bundle, which is just React/ReactDOM
+ a small "dc-runtime" template-diffing helper, none of it app-specific).

**What it actually shows** — a complete, different visual direction from
the two Stitch mockups this app was built against so far:

| | Stitch ("Nocturne Gala") — used so far | This new reference |
|---|---|---|
| Background | `#151215` (warm near-black) | `#0B0A0A` (cooler near-black) |
| Primary accent | `#EC3B14`/`#FF5632` Mandarin Red | `#EE4B2B` (close, but paired very differently) |
| Secondary accent | `#A6C5E8` Blue Finch | `#A9C9F7` (near-identical blue) |
| Tertiary | Merlot `#3D101B`/`#4E1824` glass | `#4A1420` solid card fill (no glass/blur on content cards) |
| Display font | Bodoni Moda (serif, editorial) | **Anton** (condensed grotesque, all-caps, poster-style) |
| Body font | Plus Jakarta Sans | **Archivo** |
| Shape language | 4px/8px corners, "tailored" restraint | Aggressively pill-shaped: 22-30px card radii, 999px buttons/segmented-controls/tab-bar |
| Decoration | Hairline borders, chiaroscuro glow | Playful 3D illustrative elements (a turntable/vinyl motif, confetti-like scattered rects) on hero surfaces |

**Screen-by-screen content confirmed** (all read directly from the
template, not inferred): a LOGIN screen (staff ID/phone + password,
"remember this device", forgot link, gate-access-code alternative) with a
large decorative turntable illustration; a SELECT EVENT screen (colored
event cards, each a different accent color, live/upcoming badges,
occupancy counts); then a 5-tab app shell (**Scan, Door Entry, Guests,
Stats, Settings** — one more tab than this app currently has: no
"Door Entry" or "Settings" tab exists yet in Phase 1's build) with:
- **Scan**: camera viewfinder with animated corner brackets + scanline,
  "CHECKED IN X / cap" counter, a 3-column action row (big pill Scan
  button + circular Flash + circular Code buttons), manual-code entry,
  "RECENT SCANS" list with colored status pills.
- **Door Entry** (net-new vs. this app's current build): a 3-way
  segmented control (Entry Form / Walk-ins / Dine-in), a full entry form
  (name, phone, email, gender toggle, age, walk-in/dine-in toggle, a
  guest-count stepper for dine-in), and list views for walk-ins/dine-in.
- **Stats**: a large colored "checked in / capacity / %" hero card, two
  smaller stat cards (tickets scanned at gate, door walk-ins+dine-in), an
  entries-per-hour bar chart, a gender-split bar, and three small tiles
  (avg age, rejected, tables).
- **Settings** (also net-new vs. current build): staff profile card, gate
  assignment picker, toggle switches (scan sound, vibrate, auto-admit,
  continuous scanning, offline mode), switch-event, log out.
- **Guests**: search bar, horizontal filter chips, guest list with status
  pills.

**Why this matters for what's already built:** the Phase 1 screens built
earlier this session (`login.tsx`, `pairing.tsx`, `redeem.tsx`,
`(tabs)/scan.tsx`, `(tabs)/guests.tsx`, `(tabs)/stats.tsx`) are functionally
correct against the backend contract but visually follow the Stitch
tokens (`src/theme/tokens.ts`, Bodoni Moda/Plus Jakarta Sans, 4-8px
radii). None of that functional wiring (auth modules, API client,
`claimAdmission`-backed scan flow, couple-confirm timer, heartbeat) needs
to change for a retheme — only `src/theme/tokens.ts` and each screen's
`StyleSheet.create()` block would need to be rewritten to match this
reference's palette/fonts/shape language. Door Entry and Settings are
real net-new screens this reference implies but Phase 1's plan never
scoped (Door Entry maps to the backend's already-built `/door/walk-in`
and `/door/dine-in`, which were explicitly deferred to Phase 2 in
`06-v1-vs-v2-and-rollout.md` — this reference implies they may belong in
Phase 1 after all; Settings has no backend endpoint behind it at all
today, it's pure client-side device/scanner preferences).

**Not done in this pass:** no retheme or new screens built yet — this
entry is the design review only, so the next work (retheme existing
screens + decide whether to pull Door Entry into Phase 1) can be scoped
deliberately rather than started mid-review. Tracked in `task.md`.

---

## 2026-09-23 — Full retheme to "Circle Scanner" — this reference is now authoritative

**Decision (user, explicit):** stay on Expo/React Native — "React Native
IS React," the same component model and hooks as `partner-dashboard`'s
Next.js code, just a different render target (camera QR via
`expo-camera`, not `getUserMedia`). No stack pivot. Checked
`apps/partner-dashboard/src/components/` for house conventions
(PascalCase component files, one feature folder per domain) before
writing anything — this app already followed that pattern
(`GalaButton.tsx`, `GalaTextInput.tsx`), so no restructuring was needed
there, only the visual layer.

**What:** `src/theme/tokens.ts` rewritten in full to the Circle Scanner
palette (`#0B0A0A` background, `#EE4B2B` primary, `#A9C9F7` secondary,
`#4A1420` tertiary) and type scale (Anton for every display/headline/stat
number, Archivo for body/labels — replacing Bodoni Moda/Plus Jakarta
Sans). `app/_layout.tsx` swapped to `@expo-google-fonts/anton` +
`@expo-google-fonts/archivo`. `GalaButton`/`GalaTextInput` retheme (pill
shapes, new palette, `outline` variant added to match the reference's
secondary-button treatment). All six existing Phase 1 screens
(`login.tsx`, `pairing.tsx`, `redeem.tsx`, `(tabs)/scan.tsx`,
`(tabs)/guests.tsx`, `(tabs)/stats.tsx`) rewritten to match the reference's
actual layouts (brand mark + "Let the night in." hero on login; colored
per-event cards with date/live badges on the event-select screen;
corner-bracket viewfinder + pill Scan button + circular Flash/Code
buttons + checked-in counter on Scan; search + filter-ready list + status
pills on Guests; big colored hero stat + two-tile grid on Stats). Two
net-new screens added to match the reference's 5-tab shell:
`(tabs)/door.tsx` (Door Entry — segmented Entry Form/Walk-ins/Dine-in,
full form with gender/type toggles and a dine-in guest-count stepper) and
`(tabs)/settings.tsx` (staff profile card, gate/scanner/device toggle
switches, log out). `(tabs)/_layout.tsx` now renders all 5 tabs
(Scan, Door Entry, Guests, Stats, Settings) in the reference's floating
pill tab bar shape (semi-opaque `rgba` background approximating the
reference's `backdrop-filter: blur` — no blur library added, since that's
a real new dependency for a cosmetic effect not requested explicitly).

**Deliberately NOT faked — two real, disclosed gaps instead of fabricated data/behavior:**
1. **Stats screen's entries/hour bar chart, gender split, avg age,
   rejected count, and tables count** — the reference shows all of these,
   but `GET /door/stats`'s actual response schema
   (`docs/api-contracts/scanner-app.md` §9, verified against
   `src/api/schemas.ts`) only has `inside`/`capacity`/`remaining`/
   `prebooked`. Rather than inventing fake numbers to match the mockup
   visually, the stats screen shows only what the backend actually
   returns, plus an explicit on-screen note naming exactly which fields
   aren't available. Fabricating those numbers would have been a worse
   defect than an honest gap.
2. **Scan screen's Flash and Code buttons, and the checked-in counter** —
   rendered exactly per the reference, but not wired: Flash has no torch
   API called yet, Code has no manual-entry input open yet, and the
   counter is a static `0` (no running-count state exists client-side —
   it would need to come from a stats poll or local tally, neither of
   which this screen currently does). All three are visually correct,
   functionally inert, and that inertness is a comment in the file, not a
   silent gap.

**Door Entry's submit path is explicitly inert, on purpose:** the form
UI matches the reference exactly, but tapping Submit shows
"Walk-in/dine-in submission is Phase 2 backend work — not wired yet" with
a pointer to `06-v1-vs-v2-and-rollout.md`, rather than either calling the
Phase-2-scoped `/door/walk-in`/`/door/dine-in` endpoints from Phase 1 code
(which would blur the phase boundary this whole doc set is built around)
or silently doing nothing on tap (which would look like a bug, not a
decision).

**Settings' Offline mode toggle is disabled with an explanatory label**
("Not supported — offline always denies entry (see SOTA-2)") rather than
either hidden (the reference shows it, so hiding it would be a visual
regression against "exact same UI") or enabled-but-fake (which would
contradict the whole `sota-architecture.md` SOTA-2 invariant this app's
backend enforces).

**Real bug found and fixed during verification:** `app/index.tsx` (the
boot/loading screen shown only during `useScannerAuthState`'s "checking"
phase) still referenced the old token names (`colors.mandarin`,
`colors.caviar`) from before this retheme — a leftover from the very
first scaffold pass, never touched by the Phase 1 screen work since it's
not a route a logged-in session ever sees. Caught by `tsc`, not by
inspection; fixed to the new token names.

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean (after `eslint --fix`
resolved 16 mechanical void-expression findings across the new/changed
screens), `pnpm boundaries` shows zero new violations.

**Not done:** no visual QA against a running simulator/device in this
environment (no camera/display access here) — the styles are correct by
inspection against the extracted reference markup and pass every
automated check, but haven't been eyeballed side-by-side with the actual
reference render. Flash/Code/counter wiring, Door Entry backend wiring,
and any blur-effect library for the tab bar remain open, tracked in
`task.md`.

**This design (`apps/scanner-app/ui_example/claude_design_ui/Circle Scanner.html`)
is now the authoritative visual reference for this app, superseding the
two Stitch "Nocturne Gala" mockups** — earlier log entries above that
describe the Stitch tokens/fonts are historical record of what was built
first, not a currently-accurate description of the app.

---

## 2026-09-23 — Expo web target added; Door Entry backend wiring pulled forward into Phase 1

**What (web target):** confirmed no web support existed yet (no
`react-native-web`/`react-dom` deps, no `web` block in `app.config.ts`).
User clarified the stack decision further: stay on Expo, but the same
Expo app should also run as a web app — this is Expo's own built-in
capability (`react-native-web` under the hood, `expo start --web`), not a
second codebase or a pivot to Next.js. Added `react-native-web`,
`react-dom` as dependencies, a `web: { bundler: 'metro', output: 'single' }`
block to `app.config.ts`, and a `dev:web` script. Added a
`peerDependencyRules.allowedVersions` entry to the repo's
`pnpm-workspace.yaml` for a real, pre-existing peer conflict this surfaced
(`jest-expo`'s `jest-watch-typeahead` only declares `jest ^27-29` as a
peer; this monorepo is on jest 30 everywhere) — that plugin's actual API
(a `--watch` reporter) hasn't broken across that range in practice, so
allowing the version mismatch was correct over downgrading jest
repo-wide for one dev-only watch-mode plugin.

**What (Door Entry backend, Phase 2 pulled forward):** the open scope
question from the previous retheme entry — whether Door Entry's
walk-in/dine-in submission should move from Phase 2 into Phase 1 — is now
resolved: user asked to proceed with the "next phase," and with the UI
already built and matching the reference, wiring it was the concrete next
step. Added `submitWalkIn`/`submitDineIn` to `src/api/scannerApiClient.ts`
(`POST /door/walk-in`, `POST /door/dine-in`) and a `doorSaleSchema` to
`src/api/schemas.ts`. `(tabs)/door.tsx`'s form now actually submits: mints
one idempotency key per form session (`crypto.randomUUID()`, stored in
state, regenerated only after a successful submit or reset — never
per-attempt, per the contract's "one key per user intent" rule), resolves
the active event/gate from `getSessionMeta()`, calls the right endpoint
based on the walk-in/dine-in toggle, and shows a real success/failure
notice instead of the previous placeholder "Phase 2, not wired yet"
message.

**Why not build a full retry-with-backoff UI on top of this:** the
contract's `+idem` guarantee is what makes a *simple* retry safe (the
same key resubmitted never double-books an entry) — the underlying
`@c1rcle/api-client` already retries idempotent-looking failures per its
own backoff policy at the transport layer. A second, screen-level retry
loop would be redundant complexity for a form a staff member can just tap
again if it visibly failed.

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean, `pnpm boundaries`
zero new violations, `pnpm install` completes cleanly (confirmed the peer
dep fix actually resolved the failure, not just silenced a warning).

**Not done:** camera/QR scanning via `expo-camera`'s `CameraView` on the
web target is unverified in this environment (no browser to test
`getUserMedia` permission flow against) — Expo's own docs describe web
camera support as functional but with different permission UX than
native; this needs an actual browser run before calling the web target
production-ready, not just "builds."

---

## 2026-09-23 — Decorative turntable/confetti graphics reproduced (user: "exact same UI")

**What:** user explicitly asked for the reference's decorative 3D-style
graphics (the turntable/vinyl motif, scattered rotated-square "confetti"
accents), not just the structural layout/colors/fonts done in the
previous retheme pass. Added `react-native-svg` (RN's plain
`View`/`StyleSheet` has no radial/conic-gradient primitive — the
reference leans on CSS `radial-gradient`/`conic-gradient` extensively for
the turntable's grain texture, which has no RN equivalent without SVG or
a canvas library). Built two reusable decorative components:
- `src/components/decor/Turntable.tsx` — an SVG disc with a radial
  gradient "grain" fill, an animated dashed ring (rotates continuously via
  `Animated.timing` + `Animated.loop`, approximating the reference's CSS
  `@keyframes spin`), and a colored center label. Parameterized by
  `size`/`labelColor`/`durationMs` so one component serves the login hero
  (130px), event cards (80px), the scan viewfinder (104px, low opacity),
  and the stats hero (70px) — the reference draws a bespoke variant per
  placement; this app reuses one parameterized component instead, judged
  a reasonable trade given the alternative is 4+ near-duplicate SVG trees.
- `src/components/decor/ScatterAccents.tsx` — plain rotated-rect accents
  (no gradient/animation needed), reused across the same four surfaces
  with per-surface color/position sets.

**Real bug found and fixed during verification:** the first version of
`Turntable.tsx` used `useRef(new Animated.Value(0)).current` — the
project's react-hooks lint config (a newer version than this reasoning
assumed) now includes `react-hooks/refs`, which flags reading `.current`
during render as unsafe even for a non-DOM value like an `Animated.Value`.
Fixed by switching to `useState(() => new Animated.Value(0))`'s lazy
initializer, which creates the value exactly once (same guarantee as the
ref pattern) without tripping the rule — a real lint signal, not a false
positive to suppress, since the underlying concern (a value read during
render that render itself doesn't own) is legitimate even though this
particular value happens to be safe.

**Why not reproduce the reference's exact texture algorithm (`spinball`/
`spinrow` CSS `background-position` looping):** RN's `StyleSheet` has no
animatable `background-position` at all — approximated with a rotating
dashed-stroke ring instead, which reads as "the same kind of thing" (a
spinning textured disc) without the exact texture. Disclosed here rather
than left unstated.

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean (the `react-hooks/refs`
fix above was the one real finding), `pnpm boundaries` zero new
violations.

**Not done:** the reference's unique per-card 3D compositions (distinct
turntable/vinyl-adjacent shapes per event-card color, a couple of bespoke
citrus-slice/confetti arrangements on the "Sunday Brunch Club" card) were
not each individually rebuilt — the reusable `Turntable`+`ScatterAccents`
pair covers the same visual *category* (spinning disc + scattered
accents) on every surface rather than a bespoke unique composition per
surface. If literal per-instance fidelity is wanted beyond this, it's a
larger follow-up, not done here.

---

## 2026-09-23 — Verified the running app; found and fixed a real self-redirect loop; rebuilt the login art to match the actual reference screenshot

**What (verification):** started the app for real —
`npx expo start --web`, running in this session via Metro's web target
(no camera/browser access here, but this is the first time this app has
actually been executed rather than only statically checked). Confirmed:
Metro bundled all 981 modules with zero errors, the page served at
`http://localhost:8090` returned HTTP 200 with the correct `<title>`, and
the downloaded 5.2MB dev bundle contained no real `SyntaxError`/`Cannot
find module` throws (grepped, then confirmed by context that every hit
was Metro/Babel's own error-formatting infrastructure code, not an actual
build failure).

**What (real bug found from the user's live report — "keeps on
blinking"):** `app/_layout.tsx` rendered `<Redirect href={...}>`
unconditionally for the entire lifetime of a resolved auth state (only
suppressed while `state === 'checking'`, which is true for a few
milliseconds on boot and never again). Once the user landed on `/login`,
every re-render of the root layout — which happens on any navigation
event, not just auth-state changes — re-evaluated the same (unchanged)
target route and rendered `<Redirect href="/login">` **again while
already on `/login`**, which fires `router.replace('/login')` again. That
is a self-redirect loop: navigate to the page you're already on, forever,
which reads exactly as visual blinking. Fixed by adding `usePathname()`
and only rendering `<Redirect>` when the current path doesn't already
match the target — `<Slot>` now renders unconditionally (the correct
Expo Router pattern: `Redirect` overrides `Slot` only during the actual
transition, not permanently).

**Second contributing bug, same file:** `useFonts({...})` was called with
a fresh inline object literal every render. `expo-font`'s loading effect
keys off that object's identity; a new object reference each render can
re-trigger the loading effect, toggling `fontsLoaded` and remounting the
whole tree. Moved the font map to a module-level constant (`FONT_MAP`) so
its identity is stable across every render — a second real contributor
to the same reported symptom, not just the redirect loop alone.

**What (art fidelity — user provided the actual reference screenshot):**
the login hero in the reference is a full DJ console — two turntables
with tonearms flanking a center mixer panel (knobs, faders, three colored
buttons, a small "C1RCLE" wordmark) — not the single spinning disc this
session had built earlier. Built `src/components/decor/DjConsole.tsx`
(two `Deck` sub-components, each an SVG radial-gradient disc + animated
dashed ring + colored center label + a tonearm built from plain `View`s,
flanking a plain-`View` mixer panel with knob/fader/button rows) and
swapped it in on `login.tsx` in place of the single `Turntable`. The
smaller single-disc placements on the event-select cards, scan
viewfinder, and stats hero are left as `Turntable` — those match the
reference's own simpler single-disc treatment on those specific surfaces
(only the login hero has the full two-deck console in the source
markup), so this is not a fidelity gap, it's matching what's actually
there per surface.

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean, and — new this
entry — an actual running dev server confirming the fix: a fresh fetch of
the bundle after the change rebundled in 817ms with zero errors (Metro's
own incremental-build log line, not just a static check).

**Not done:** still no way to visually confirm the DJ console's on-screen
placement/scale/proportions match the screenshot pixel-for-pixel from
this environment (no browser) — the user will need to look at the
running page themselves and report back if the sizing/position needs
adjusting.

---

## 2026-09-24 — Full structural gap-closing pass, per the user's "100% same" directive and a full read of the reference's script logic

**What triggered this:** after the user reported the login screen still
didn't match, a full read of the reference file's `<script data-dc-script>`
block (not just its markup — the earlier passes never read the actual
Component class) surfaced a much longer, more structural gap list than
"missing decorations": no shared app-shell header, no scan-result
bottom-sheet modal (the reference's real core interaction), no toast
system, zero tab-bar icons, no guest filter chips, and Door Entry's
walk-ins/dine-in list views rendering nothing real. User confirmed: this
file is the only reference, and it must be 100% the same — not
approximated.

**What was built, in order:**
1. `src/components/AppScreenHeader.tsx` — the persistent back-button +
   event-name/venue + pulsing LIVE-badge strip shared by every in-app tab
   (reference lines ~356-363). Wired into Scan, Guests, Stats, Door, and
   Settings — previously each had its own disconnected title instead.
2. `src/components/TabIcons.tsx` — five hand-built geometric icons (grid+dot,
   door silhouette, ascending bars, overlapping avatars, segmented dial)
   matching the reference's `currentColor` div-shape icons exactly, plus an
   active-tab pill-highlight background in `(tabs)/_layout.tsx` (reference's
   `background:rgba(255,255,255,.1)` on the selected tab). Previously the
   tab bar was text-only labels with no icons and no active-state background.
3. `src/features/toast/{toastStore.ts,ToastHost.tsx}` — a module-level toast
   store (reference's `flash(t)` method: show, auto-clear after 1.8s, a
   newer flash replaces the pending clear rather than stacking). Wired into
   the scan flow ("X admitted", "Entry denied & logged", offline message).
4. `src/features/scan/ResultSheet.tsx` — the actual bottom-sheet modal the
   reference uses for every scan result (reference lines ~578-596): dark
   overlay, slide-up sheet, code+time row, big Anton title, guest/tier grid,
   DISMISS button. This replaces the inline result cards `scan.tsx` used
   before, which were a materially different interaction pattern, not a
   styling variant of the same one.
5. `scan.tsx` rewrite: added the scanline animation (`Animated.loop` moving
   a bar between 8%-88% of the viewfinder, matching the reference's
   `@keyframes scanline`), a real running CHECKED-IN counter, a functional
   Flash toggle (`enableTorch` on `CameraView`, with the reference's
   active-state color swap), a functional CODE→manual-entry toggle with a
   real input + CHECK button that calls the same `checkIn()` path as the
   camera, and a "RECENT SCANS" list with ADMITTED/DENIED colored pills
   (reference's `#12202f`/`#2a0f0a` backgrounds). The live camera feed
   itself is a deliberate, disclosed departure from the reference's static
   mock viewfinder — see the standing note in `task.md`.
6. `guests.tsx`: added the All/Checked-in/Pending filter chip row
   (client-side filtering — the contract's `GET /door/guests` doesn't
   support a status query param, so this filters the already-fetched page
   rather than re-querying per chip; disclosed, not silently narrower than
   the reference's own client-side filtering, which is exactly what it
   also does).
7. `door.tsx`: added `fetchDoorSales` (`GET /door/sales`) to
   `scannerApiClient.ts` + a `doorSaleSchema`/`doorSalesResponseSchema`,
   and wired the Walk-ins/Dine-in list tabs to real data — a 2-stat-card
   row (count + today's total, or tables + total guests) plus a real entry
   list (avatar, name, phone/gender/age, pax-or-Walk-in label), refetched
   after every successful submit. This replaced a placeholder notice text
   that rendered nothing.

**Real bugs found and fixed during verification:** a nullable-field
typecheck error (`entitlement.holderName` is `string | null` per the
contract schema — the earlier scan.tsx passed it straight into a
`string`-typed helper param without a fallback; fixed with `?? 'Guest'`),
a leftover `colors.outline` reference to a token removed in the earlier
retheme (fixed to `colors.border`), and `'currentColor'` used as an RN
color value in `ResultSheet.tsx` (a CSS-only keyword with no RN
equivalent — fixed by threading the actual computed foreground color into
each style that needs it).

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean (after `eslint --fix`
resolved the mechanical void-expression findings), `pnpm boundaries` zero
new violations, and — again — the actual running dev server: a fresh
bundle fetch after this whole pass rebuilt in ~650ms with zero errors.

**Not done, disclosed:** per-event-card unique 3D art (still one reusable
`Turntable`), the Stats screen's bar-chart/gender-split/avg-age (backend
doesn't return those fields), and pixel-exact spacing/proportion
verification against the screenshot (still no browser in this
environment — every fix here is verified by code-level correctness and a
clean bundle, not a visual diff). These remain the honest, named
remainder — not silently dropped.

## 2026-09-24 — Login screen fidelity pass (from user's two-screenshot diff)

The user sent the exact reference login screenshot side-by-side with a
screenshot of what had actually shipped, and named specific differences:
wrong input background color (light grey vs. our black), a different
LOG IN button shape, and a DJ console that looked thinner/lower-quality
than the reference. This is the first fidelity round backed by a direct
screenshot comparison rather than a description — treated as ground
truth over any prior re-read of the markup.

**Why the background-color bug existed:** `GalaTextInput` had one
`backgroundColor: colors.background` (`#0B0A0A`) baked in for every
caller. Re-checking the extracted reference markup line-by-line showed
two *different* fills depending on screen: login inputs are `#151313`
(`colors.surface`), door-entry form inputs are genuinely `#0B0A0A`
(confirmed correct as originally built). A blanket color swap would have
fixed login and broken door-entry, so a `surface?: boolean` prop was
added instead (default `false`, preserving door-entry's existing correct
behavior) — `login.tsx` now passes `surface` on all three inputs.

**Why a new `SplitButton` instead of extending `GalaButton`:** the
reference's LOG IN button is structurally a different shape, not a
`GalaButton` variant — a solid pill with the label left-aligned and a
*separate* circular black-on-primary arrow button inset on the right
(`justifyContent:'space-between'`, a 46×46 `arrowCircle`), vs.
`GalaButton`'s single centered label. Bolting that onto `GalaButton` via
another boolean prop would have made an already-general component read
two unrelated shapes; a small dedicated component was clearer and
`GalaButton` still serves every other pill button in the app unchanged.

**Missing login elements added**, all present in the reference markup but
never built: a "Remember this device" checkbox + "Forgot?" link row
(local `remember` boolean state, no backend meaning yet — there is no
remember-device endpoint in the contract, so it's UI-only for now); an
inline error `Text` repositioned to sit *below* that row (previously
below the button, wrong per the reference's actual layout); an "OR"
divider (two flex-1 hairlines flanking a label); and a "Use a gate access
code" outline pill button below LOG IN (present in the markup, not wired
to anything — the contract has no gate-code endpoint, so like SplitButton
it is visually complete but functionally a no-op pending a real backend
flow).

**Why not done this round:** `DjConsole.tsx`'s visual density — the
user's phrasing ("the dj console is also different... use that") reads as
wanting the console's overall polish/detail level to match the
reference's image, not a specific named bug the way the input color and
button shape were. That needs its own focused pass (denser knobs, cleaner
tonearm rendering, gradient quality) rather than being bundled into this
fix, so it stays open.

**Real lint findings fixed (not cosmetic):** three
`@typescript-eslint/no-confusing-void-expression` errors from
arrow-shorthand `Pressable onPress={() => setX(...)}` handlers — the repo's
lint config forbids implicitly returning a `void`-typed expression from an
arrow shorthand. Fixed by braced bodies (`() => { setX(...); }`), matching
the existing pattern already used elsewhere in this file (`handleLogin`).

**Verified:** `pnpm --filter @c1rcle/app-scanner-app typecheck` clean,
`pnpm --filter @c1rcle/app-scanner-app lint` clean, dev server bundle
re-fetched (HTTP 200) after the change, `pnpm boundaries` unchanged at
exactly the same 1 pre-existing `guest-portal` violation. As always: this
proves the code compiles, type-checks, and runs — it does not prove pixel
fidelity, since this environment has no browser/screenshot capability.
The next real check is another screenshot from the user.

## 2026-09-24 (later same day) — Hero background + DJ console deep rebuild

The user sent a screenshot of the reference hero alone (DJ console + "LET
THE NIGHT IN" headline) with: "not fixed the background is still all
black... check in depth also look at this part in depth the dj is
different and everything is so good, read the html and use that only."
This is the second fidelity round on this same area, and the instruction
was explicit: stop re-deriving from memory, re-read the actual markup
line-by-line, and match it exactly. A ChatGPT-authored diff table the
user forwarded was treated as reference material about visual differences,
not as instructions to follow structurally (most of its rows describe the
artifact tool's own iPhone-mockup chrome — status bar, device bezel — which
isn't part of our real app and was correctly not touched).

**Root cause of "background is still all black":** re-reading
`template.html` line 223 line-by-line (not skimmed this time) showed the
hero has an entire graphic layer that was never built: a `conic-gradient`
light-beam pattern layered under the DJ console. Separately, the existing
"glow" was a flat `View` with `opacity:0.14` and a solid `backgroundColor`
— a hard-edged tinted disc, not a soft radial falloff, so it read as a
faint dark smudge rather than a glow. Both problems compounded into a
hero that looked flat and empty next to the reference.

**`conic-gradient` → SVG wedges:** the gradient's definition
(`conic-gradient(from 150deg at 68% 30%, transparent 0 12deg,
rgba(169,201,247,.13) 12deg 20deg, transparent 20deg 44deg,
rgba(238,75,43,.16) 44deg 53deg, transparent 53deg 80deg,
rgba(244,241,238,.08) 80deg 86deg, transparent 86deg)`) turned out to be
much simpler than it looks: every color stop is given the *same* color
twice (a start and end angle), which in CSS conic-gradient syntax means a
hard-edged band, not a blend — so the whole "beam" effect is really just
3 static, solid-color wedges radiating from one point. That's cheap to
draw exactly as SVG pie slices once you convert CSS's clockwise-from-north
angle convention to standard cartesian (`x = cx + r·sin(a), y = cy −
r·cos(a)`). New file `src/components/decor/HeroRays.tsx` does exactly
that, and a shared `wedge.ts` util holds the angle math for reuse.

**Radial glow → real gradient:** new `src/components/decor/RadialGlow.tsx`
uses `react-native-svg`'s `RadialGradient` (a genuine 100%→0% opacity
stop) instead of a flat `opacity` prop, for both the hero's orange corner
glow and the console's under-panel glow ellipse. This is a meaningfully
different visual — a real soft-edged glow vs. a hard-edged translucent
circle — not a cosmetic rename.

**DJ console — rebuilt against the markup's actual DOM nesting, not
re-derived from memory:**
- The center deck label (the colored circle in the middle of each
  turntable) is nested *inside* the rotating grain div in the reference,
  so it visibly spins with the record. The first build placed it as a
  static sibling — it never moved. Fixed by nesting it inside the same
  `Animated.View` that spins.
- The tonearm and its headshell (the little rectangular cartridge at the
  tip) are one rigid rotated unit in the reference — the headshell is a
  child of the rotated arm div, so it swings with the arm. The first build
  positioned them as two independent absolutely-positioned siblings, so
  the headshell sat in a fixed spot while the arm rotated under it. Fixed
  by nesting the headshell inside the arm's rotated container.
- The "chrome ball" bearing (`radial-gradient(circle at 35% 30%,#fff,
  #9a9290)`, a small sphere at the tonearm's pivot) didn't exist in the
  first build at all — that slot was filled with a flat-colored circle
  doing double duty as something else. Added as its own SVG
  `RadialGradient` circle.
- The grain texture (`repeating-radial-gradient(circle,#121010 0
  1px,#1f1c1c 1px 3px)`) is a fine ringed vinyl-groove pattern, not a
  smooth center-to-edge blend — the first build used a smooth
  `RadialGradient`, which reads as shaded plastic, not vinyl. Replaced
  with a `GrooveRings` helper drawing 13 alternating-color concentric
  ring strokes.
- The panel's background gradient previously came from a manually-sized
  SVG `Rect` with hardcoded width/height constants that had no way to
  track the panel's actual flex-computed height, risking a mismatched
  fill if the content height ever changed. Switched to
  `expo-linear-gradient`'s `<LinearGradient style={StyleSheet.absoluteFill}>`,
  which stretches to match its parent's real rendered size automatically
  — added `expo-linear-gradient@~55.0.18` via `npx expo install` (SDK-
  matched, not hand-picked).
- Knob colors were wrong in kind, not just value: the reference's knobs
  are grey spheres (`radial-gradient(circle at 35% 30%,#5f5856,#1E1B1B)`)
  with a small colored tick line on top indicating a position marker; the
  first build used the tick's color as the knob's *entire* fill, so the
  mixer looked like solid colored dots instead of grey knobs with colored
  indicators. Fixed with an SVG radial-gradient sphere per knob plus a
  separate tick `View`, and corrected the two knob rows' tick-color
  sequence and the two LED columns' 7-item color sequences to match the
  markup exactly (previously only one 5-item LED column existed, but the
  reference has two 7-item columns side by side).
- Added the layered `box-shadow` "step" edge (`0 16px 0 #080707, 0 16px 0
  1px #2A2626`) as two offset `View`s behind the panel, giving the
  console visible physical thickness under the 3D tilt — previously
  approximated with nothing, so the panel looked flat/floating.

**Real bug during verification, not cosmetic:** after adding the new
`wedge.ts` module, Metro failed to bundle with `Unable to resolve
"@/components/decor/wedge"` — a stale Metro cache from before the file
existed (not a real path/config error; `tsc` and `eslint` both resolved
the same import fine). Restarting with `expo start --web --clear` fixed
it; port 8090 was still held by the previous dev-server process so the
restart moved to 8091.

**Verified:** `typecheck`/`lint` clean, a clean 994-module bundle rebuilt
from an empty Metro cache, HTTP 200, `pnpm boundaries` unchanged at the
same 1 pre-existing violation. Not a pixel diff — this environment has no
browser or screenshot capability.

## 2026-09-24 (third round) — Console geometry, from two CSS rules I'd mis-read

The user sent our render and the reference side by side and said the
implementation was "lacking in a lot of places." Unlike the previous two
rounds — where I was missing whole elements — this time nearly every
element was present but wrong in size or placement. Working backwards from
the screenshots to the markup, almost all of it traced to two CSS
behaviours I had modelled incorrectly.

**1. A block element with no `width` fills its container as a border-box.**
The console panel div declares no width, so it fills the 330px wrapper;
its `padding:16px 14px 12px` and `1px` border eat into that 330, leaving
300px of *content*. I had set `PANEL_WIDTH = 302` — the content width —
and then used it as the panel's RN `width`, which RN treats as the border
box. Net effect: the panel was 28px narrower than the reference, and
because the deck row uses `justify-content:space-between`, all 28px came
out of the two gaps. Reference gaps are ~15px each; ours were ~1.5px, so
the decks sat jammed against the mixer. That single number explains most
of the "squashed" look in the comparison. Now `WRAP_WIDTH = 330` and the
panel is sized to it.

**2. `box-shadow` never participates in layout, and it rides the element's
own transform.** Two separate bugs came out of this:

- The deck's `box-shadow:0 0 0 4px #3a3434, 0 0 0 5px #0a0909` is a rim
  painted *outside* its 100px box — visually 110px, but still 100px as far
  as flex is concerned. I had drawn it as a stroke inside the 100px
  circle, which both ate 4px off the platter and made the silver rim
  nearly invisible. It's now a 110px rim rendered at `-5,-5` behind a deck
  whose layout box stays 100px, so the flex arithmetic above still holds.
- The panel's `0 16px 0 #080707, 0 16px 0 1px #2A2626` pair is what gives
  the console its slab-like thickness, and because it belongs to the
  transformed element it tilts with the panel. I had built those as
  untransformed sibling Views behind a transformed panel — so they were
  flat rectangles sitting behind a tilted board, contributing no depth.
  All three now live inside one `tiltGroup` that carries the transform.

**Smaller corrections, all from re-reading rather than re-deriving:** the
grain is a 3px-period `repeating-radial-gradient` (1px dark groove on a 2px
lighter band), not evenly spaced rings; the mixer's padding is `6px 8px`,
not 6px uniform; the fader row's gap is 10, not 8; both fader thumbs and
the crossfader thumb are gradients, not flat fills; the panel gradient's
`160deg` was recomputed into expo-linear-gradient's normalized start/end
rather than eyeballed.

**Two things I had invented and removed.** The deck label's inner
`inset:13px` circle resolves to 0px on a 26px label — it renders as
nothing in the reference, but I had drawn a visible 6px light dot in the
middle of each record. And I had tinted one deck's bearing ball to match
its label colour; the reference uses `#fff→#9a9290` on both. Neither was
in the source; both are gone.

**The SHOW button was anchored to the wrong box.** In the reference the
`position:relative` wrapper contains *only* the password input, so
`right:8;top:8` measures from the input. `GalaTextInput` renders label and
input together, and the button was absolutely positioned against that
whole group — so `top:8` measured from the top of the "PASSWORD" label and
the button floated above the field, which is visible in the comparison
screenshot. The component now takes an `accessory` node rendered inside a
wrapper around the input alone.

**Login metrics**, all previously approximated with design tokens and now
taken from the markup: form padding `14px 20px 28px` and gap 14 (was a
uniform 16), input horizontal padding 18 (was 16), password padding-right
70 (was 84), label→input gap 7 (was 6), error text 12px (was 14), LOG IN
label 15px/`.14em` with `margin-top:4`, and the footer no longer
force-uppercases (the reference reads "v2.4", not "V2.4").

**Organization ID removed from the login screen — a product decision, not
just a visual one.** It has no counterpart in the reference and was the
largest remaining structural difference. Checking whether it could simply
be dropped: `POST /api/v2/auth/login` returns only the user object, and
there is no `/me` or memberships route, so the app genuinely cannot derive
the org from the session. But it also isn't a per-shift secret — a scanner
handset belongs to one venue for its entire deployed life, and asking a
door staffer to retype a tenant ID every night is worse product design
than the reference's two fields. It now resolves from
`EXPO_PUBLIC_ORGANIZATION_ID`, falling back to a SecureStore binding
written on the first successful login (`src/auth/venueBinding.ts`). Only
when both are empty does a one-time venue field appear, so an unconfigured
handset still works rather than being bricked.

**Left open deliberately:** `EXPO_PUBLIC_ORGANIZATION_ID` is blank in
`.env`. Neither repo contains a real staging organization id to seed it
with, and inventing one would make login fail in a confusing way, so it
stays empty with a comment explaining what to put there. Until it's filled
in (or one login completes and binds the handset), the login screen will
still show the extra venue field.

**Verified:** `typecheck` and `lint` clean, after fixing two real findings
the rewrite introduced — a deprecated `StyleSheet.absoluteFillObject` and
an unsafe `any` from the new `Constants.expoConfig.extra` read. Dev server
restarted with `--clear` (the `app.config.ts` `extra` change isn't picked
up without a restart) and rebuilt clean.

**Crash found on first run: `expo-secure-store` has no web implementation.**
The venue-binding read threw
`ExpoSecureStore.default.getValueWithKeyAsync is not a function` in the
browser. Chasing it showed the bug was wider than the code I'd just added:
`scannerSession.ts` and `deviceIdentity.ts` import SecureStore directly
too, so the entire web target — pairing, session persistence, every
authenticated call — would have crashed the moment it got past login. The
web target was added earlier this session without a storage layer that
works there; this was latent from that point, not new.

Fixed with one persistence boundary, `src/storage/secureStorage.ts`, which
all three modules now go through. On a handset it is still Keychain/
Keystore, which is what `docs/api-contracts/scanner-app.md` §5 requires.
**A browser has no equivalent**, so the web target necessarily uses Web
Storage, and the module splits the scopes to keep that downgrade small:

- `device` (localStorage) — the opaque device id, device name and venue
  binding. Long-lived, non-secret identifiers; leaking one authorizes
  nothing by itself.
- `session` (sessionStorage) — the scanner session token, a 12h bearer
  credential. Tab-scoped so closing the browser drops it rather than
  leaving a working door credential on a shared machine.

Every read and write is wrapped in try/catch (private mode and blocked
site data can throw on access), and the login screen's binding lookup now
has a `.catch` that falls through to asking for the venue id instead of
propagating — an unreadable store is a valid first-run state, not a crash.

**This is a real, disclosed security deviation, not a workaround to
forget:** the handset build meets the contract's storage requirement; the
web build cannot, and should be treated as staff-supervised/preview.

**Still not a pixel diff.** Everything above is derived from the markup and
verified by compilation plus a clean bundle; this environment has no
browser or screenshot capability, so the user's screenshot remains the only
real fidelity check. The sheen sweep on each vinyl disc also stays an
approximation — the reference uses a genuine smooth `conic-gradient` and
SVG has no equivalent primitive, so it's fanned into stepped-opacity
wedges that read correctly at this size but aren't a true blend.
