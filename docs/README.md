# C1RCLE-BACKEND documentation map

Four kinds of document live here, each with a different job. Don't mix them —
that's what caused this folder to need reorganizing once already.

```
docs/
├── README.md            you are here — index only, no content of its own
├── roadmap/              WHAT'S IMPLEMENTED VS REMAINING (start here)
├── architecture/         HOW the system is built, and WHY (design + decisions)
└── reference/            Point-in-time material copied in from elsewhere —
                          not maintained, read for context, not truth
```

## `docs/roadmap/` — implemented vs remaining (the status tracker)

**Start here.** [`ROADMAP.md`](roadmap/ROADMAP.md) is the master index: one row
per phase, current status, link to detail. Each phase file names its exact
endpoints, the v1 business logic it ports, and a dated Session Log so a new
session can resume without re-deriving context. This is the *only* place
status is tracked — don't duplicate a "what's done" list anywhere else.

- Phase 0 (Foundation: auth, persistence, the frozen partner slice) — **done**.
- Phases 1–8 (partner dashboards → social) — not started, fully specified.

## `docs/architecture/` — how the system is built, and why

Living design documentation. Update it when the system's shape changes, not
just when a task finishes.

- [`README.md`](architecture/README.md) — the one request end-to-end, every
  file's purpose, the security rule list, a built/pending status ledger.
- [`decisions.md`](architecture/decisions.md) — the decision log (D-001…).
  Append-only: every architectural choice that must survive a session, with
  its problem/options/choice/why. Never rewrite past entries.

## `docs/reference/` — point-in-time material, not maintained

Everything here was copied from elsewhere (the frozen `thec1rcle` repo, or a
frontend-audit snapshot) at a specific date. Treat it as **a snapshot to read
for context, not as current truth** — if it disagrees with live code or with
`docs/architecture/`, live code and `docs/architecture/` win.

- `frontend-api-map.md` — `C1RCLE-FRONTEND` route/contract mapping as of
  2026-08-12. Useful for "what does the frontend expect," not for "what's
  live in this backend today" (that's `docs/roadmap/`).
- `task.md`, `route-manifest.ts`, `API_V2_ROUTE_MANIFEST.md`,
  `API_ROUTE_CATALOG.generated.md`, `V1_TO_V2_PARITY.md`,
  `MASTER_LAUNCH_IMPLEMENTATION_PLAN.md`,
  `Dream Architecture Implementation Plan.md`, `chatgpt_response.md` — the
  T-series design authority and full-platform destination plans, copied from
  the frozen `thec1rcle` repo. Source of proven patterns and business logic
  to port — see each `docs/roadmap/phase-*.md` file for exactly which parts.

## Root-level docs (not in `docs/`)

- `/task.md` — the original B-series execution plan for this repo. High
  visibility by design (repo root, like `AGENTS.md`/`CLAUDE.md` elsewhere).
  Its checkboxes are historical and can lag — the "Verified B-series state"
  note near the top of the file points to `docs/roadmap/` for current status.

## Rule of thumb for adding new docs

Ask which of the three folders it belongs to before creating a file:
- Tracking what's built vs not, phase by phase → `docs/roadmap/`
- Explaining a lasting design choice or how a layer works → `docs/architecture/`
- Copying in outside material for one-time reference → `docs/reference/`

If it doesn't fit any of those, it probably shouldn't be a top-level `docs/`
file — consider whether it belongs inside an existing phase file instead.
