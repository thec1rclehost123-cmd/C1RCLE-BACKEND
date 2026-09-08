# CI/CD

Three workflows, one required status check, and a deploy that Render triggers
but GitHub verifies.

```
push / PR ──► ci.yml ──────────► CI OK ──► verify-deploy (main only)
              security.yml ────► Security OK
   cron ────► maintenance.yml
```

---

## 1. The workflows

### `ci.yml` — every push and pull request to `main`

One pipeline, fanned out. All gates run in parallel off a shared composite
setup (`.github/actions/setup`), then `ci-ok` aggregates them.

| Job | What it proves |
| --- | --- |
| `changes` | Which paths moved, so expensive jobs can skip |
| `static` | Format, lint, typecheck, architecture boundaries, and a no-focused-tests guard — **one runner, one install**, with `if: always()` on each step so a single run reports every failure at once |
| `test` | `pnpm build` + full suite + coverage ratchet + sticky PR comment. The build step here is **the only place a `tsc` break in `@c1rcle/core` or `api-gateway` is caught**, because the Docker image compiles neither (see §4) |
| `docker` | Builds the real `Dockerfile`, Trivy-scans the image, boots the container, and asserts it **refuses** to boot when misconfigured |
| `contract-parity` | Cross-repo schema agreement with `C1RCLE-FRONTEND` (opt-in, see §3) |
| `actionlint` | Lints the workflows themselves, shellcheck included |
| `commit-lint` | Conventional-commit check on the PR commits **and the PR title** — the title is what a squash merge writes to `main` |
| `ci-ok` | **The one check to require in branch protection** |
| `verify-deploy` | `main` only — waits for Render, smoke-tests production, rolls back on failure |

### Why so few jobs

Format, lint and typecheck run **locally** on every commit and push (§5), so CI
is a backstop, not the primary loop. Three consolidations follow from that:

- **`static`** absorbed the old `format`, `lint`, `typecheck` and `boundaries`
  jobs. Four jobs meant four checkouts and four `pnpm install`s to re-prove what
  a hook already proved.
- **`test`** absorbed the old `build` job. `test` already had to run `pnpm build`
  (turbo's `test` depends on `build`), so a separate build job was re-compiling
  the workspace on its own runner for nothing.
- **`scan`** in `security.yml` absorbed `audit`, `secret-scan` and `config-scan`
  — three checkouts and two identical installs for scanners that finish in a
  couple of minutes.

That is 13 jobs down to 9, and roughly half the runner-minutes per pull request.
`if: always()` on each step preserves the one thing the split bought: a single
run still reports *everything* that is broken, rather than making you fix
failures one round trip at a time.

`ci-ok` treats `skipped` as a pass and `failure`/`cancelled` as a fail. That is
deliberate: path filters and opt-in gates legitimately skip, and requiring
`success` from all of them would block every docs-only pull request. Because it
aggregates, **adding a new gate never means editing branch-protection settings**.

Concurrency cancels superseded pull-request runs but never cancels a `main`
run — the tail of a `main` run is verifying a production deploy that is already
in flight.

### `security.yml` — pull requests, `main`, and Mondays 06:15 UTC

Four jobs: CodeQL (`javascript-typescript` + `actions`, `build-mode: none`),
dependency review (fails on `high`, denies copyleft licences), a combined `scan`
job (`pnpm audit --audit-level=high`, TruffleHog, Trivy config + filesystem), and
OSSF Scorecard. Aggregated by `security-ok`.

Split from `ci.yml` because it runs on a different cadence and needs
`security-events: write`, which the fast gates must not inherit.

The weekly cron matters: it catches CVEs published against code that has not
changed.

### `maintenance.yml` — daily 20:30 UTC (02:00 IST)

- **`production-health`** — runs the same smoke assertions against production.
  On failure it opens (or comments on) a `production-incident` issue; on
  recovery it comments and closes it. Unlike V1's health check, whose only
  failure signal was `echo "::error::"` and a TODO comment, this one reaches a
  human.
- **`lockfile-integrity`** — proves `pnpm-lock.yaml` and the `package.json`
  files have not drifted apart. That drift bricks every other job at install.
- **`stale`** — 30 days to stale, 14 more to close. `production-incident`,
  `security`, and `pinned` are exempt.

---

## 2. Deployment model

Render auto-deploys on push to `main`, out of band from GitHub Actions. CI does
not trigger the deploy; it **verifies** it.

```
push main
   ├─► Render builds the Dockerfile and swaps traffic   (out of band)
   └─► ci.yml gates ──► ci-ok ──► verify-deploy
                                    │
                                    ├─ wait-for-deploy.mjs  poll /api/v2/internal/version
                                    │                       until commit == GITHUB_SHA
                                    ├─ smoke.mjs            6 black-box assertions
                                    └─ on failure           render-rollback.mjs + open an issue
```

**Why the version endpoint carries a commit.** Smoke-testing immediately after a
push would hit the *previous* build and pass — worse than not testing at all.
Render injects `RENDER_GIT_COMMIT` into every deploy; the gateway now surfaces
it at `GET /api/v2/internal/version` as `commit`, so CI can tell the new build
from the old one. If the live build predates that field it reports `null`, and
`wait-for-deploy.mjs` warns and proceeds rather than blocking on a feature it
cannot detect.

**Rollback** needs `RENDER_API_KEY` and `RENDER_SERVICE_ID`. Without them the
job logs a notice and skips the rollback step — it still fails the run and files
the incident issue.

### Smoke assertions

Each was verified against the live service before being written:

1. `/api/v2/internal/health` → `200 {ok:true, uptimeMs:number}`
2. `/api/v2/internal/readiness` → `200 {ok:true, checks:{gateway:"up"}}`
3. `/api/v2/internal/version` → `200`, semver-shaped `version`
4. `/api/v2/organizations` with no session → `401 {code:"unauthorized"}` — proves auth is enforced, not merely present
5. An unknown route → `404 {code:"not_found", requestId}` — proves the error envelope survived
6. Two requests carry two different `requestId`s — proves request correlation

---

## 3. One-time setup

### Required before the first run

```bash
pnpm install     # installs deps AND the git hooks (via the `prepare` script)
```

`prepare` is `husky || true` on purpose: the Docker build and the containerised
CI harness both install from a context with no `.git` (see `.dockerignore`),
where husky exits non-zero. Hook installation is a developer convenience, never
a build dependency.

### Branch protection on `main`

Require exactly two checks:

- `CI OK`
- `Security OK`

Do **not** list the individual jobs. They are already aggregated, and listing
them means every new gate needs a settings change.

### Repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Needed? | Effect |
| --- | --- | --- |
| `CONTRACT_PARITY_ENABLED` | optional | Set to `true` to turn on the cross-repo contract gate |
| `FRONTEND_REPO` | optional | Defaults to `thec1rclehost123-cmd/C1RCLE-FRONTEND` |
| `FRONTEND_REF` | optional | Defaults to `main` |
| `COVERAGE_MIN_LINES` and `_STATEMENTS` / `_FUNCTIONS` / `_BRANCHES` | optional | Absolute coverage floors layered on top of the ratchet |

### Secrets

| Secret | Needed? | Effect |
| --- | --- | --- |
| `RENDER_API_KEY` | optional | Enables automatic rollback |
| `RENDER_SERVICE_ID` | optional | Enables automatic rollback |
| `FRONTEND_REPO_TOKEN` | optional | Only if `C1RCLE-FRONTEND` is private; falls back to `GITHUB_TOKEN` |

Everything else runs on the built-in `GITHUB_TOKEN`. There are no deploy
credentials in CI, because CI does not deploy.

### The `production` environment

`verify-deploy` declares `environment: production`. GitHub creates it on first
use. Add required reviewers there if you want a human gate before production is
verified — note this gates the *verification*, not the deploy, which Render has
already performed.

### Contract parity

`scripts/contract-parity.mjs` cannot run in a single-repo job: it needs a
`C1RCLE-FRONTEND` checkout plus built `dist` output on both sides. The job
handles all of that, but it is off by default. It is deliberately **not**
`continue-on-error` — when it runs, it is a real gate. Its exit codes are
`0` agree, `1` drift, `2` cannot check; only `0` passes.

It also requires Node ≥ 22.15 for `module.registerHooks`. CI pins Node 24 via
`.nvmrc`, so this is satisfied — but note the root `engines` range still permits
`^22.13.0`, where that API does not exist.

---

## 4. Things worth knowing

**Node version has one source of truth.** `.nvmrc` says `24`; every workflow
uses `node-version-file: .nvmrc`; the Dockerfile uses `node:24-slim`. V1 drifted
three ways — `.nvmrc` 20, workflows 24, image 20 — and tested on a version it
never shipped.

**Every action is SHA-pinned** with a trailing version comment. Dependabot's
`github-actions` ecosystem updates the SHA and rewrites the comment, so pinning
costs nothing to maintain. A tag is mutable; a SHA is not.

**No gate is `continue-on-error`.** V1 had five, including one on a production
deploy step, which meant a failed deploy reported green. A check that cannot
fail is worse than no check, because it looks like coverage you do not have.

**The Docker image runs TypeScript through the `tsx` loader** and only compiles
`@c1rcle/contracts`. `@c1rcle/core` and `api-gateway` are never `tsc`-compiled in
the image, which is why the `build` job is a required gate rather than a
formality.

**The gateway fails closed, and CI proves it.** `apps/api-gateway/src/config/`
rejects, at boot, a production deploy that still carries the development signing
secret `dev-only-change-me`, a `BETTER_AUTH_SECRET` under 32 characters, an
`http://` `BETTER_AUTH_URL`, or `STORAGE_DRIVER=firestore` without credentials.
The `docker` job asserts each refusal by actually running the image — a fail-closed
guard nobody tests is a guard that quietly stops working.

> **Before merging this to `main`:** confirm `BETTER_AUTH_SECRET` (32+ chars, not
> the default) and an `https://` `BETTER_AUTH_URL` are set on the Render service.
> These are now boot requirements, so a deploy with either missing will refuse to
> start rather than serve traffic with a publicly-known session key.

**A focused test fails the build.** A stray `it.only` silently disables every
other test in its file, so a green suite can be hiding almost all of itself. The
`static` job greps for it.

**Coverage is a ratchet, not a fixed number.** `scripts/ci/coverage-ratchet.mjs`
compares against the last value recorded on `main` (carried in the Actions
cache), with `coverage-baseline.json` as a committed fallback when the cache is
cold. Coverage may not drop more than 0.5 points. This calibrates itself, so it
is never red merely for lack of a hand-picked threshold.

**ESLint override globs must be `**`-anchored.** Turbo runs `eslint .` from
inside each package, where a root-relative glob such as
`packages/core/src/infrastructure/firestore/**` can never match. When that
happened, the same code linted clean from the repo root and failed from the
package directory. Any new override in `eslint.config.mjs` needs a `**/` prefix.

---

## 5. Local gates (git hooks)

The fast checks run on your machine, not on a runner. Installed by `pnpm install`
via the `prepare` script.

| Hook | Runs | Why there |
| --- | --- | --- |
| `pre-commit` | `lint-staged` → `prettier --write` + `eslint --fix` on **staged files only** | Sub-second, and it fixes rather than complains |
| `commit-msg` | `commitlint` | Conventional Commits, so the history stays machine-readable |
| `pre-push` | `pnpm typecheck && pnpm boundaries && pnpm test` | Whole-project gates a staged-file check cannot cover |

The split is deliberate: whole-project work belongs on `pre-push`, not
`pre-commit`. A pre-commit hook that takes 40 seconds is a pre-commit hook people
bypass with `--no-verify`, and then you have neither the local check nor the
habit.

CI still re-runs all of it. Hooks are a fast feedback loop, not a security
boundary — `--no-verify` exists, GitHub's web editor never runs them, and a hook
only ever saw the files that developer happened to stage.

To skip them deliberately (a work-in-progress commit on your own branch):

```bash
git commit --no-verify
git push --no-verify
```

---

## 6. Running the gates by hand

```bash
pnpm check          # format:check && lint && typecheck && boundaries && test && build
pnpm test:coverage  # single-pass coverage across all three packages
node scripts/ci/smoke.mjs --url https://circle-v2-backend.onrender.com
```

`pnpm check` does not include `contract-parity` — it needs the sibling frontend
repository.

On a machine whose Node is older than the `engines` range, run the gates in a
container instead:

```bash
docker run --rm -v "$PWD:/src:ro" node:24-slim bash -c '
  corepack enable && mkdir /w && cd /src &&
  tar cf - --exclude=./node_modules --exclude=./.git . | (cd /w && tar xf -) &&
  cd /w && pnpm install --frozen-lockfile && pnpm check'
```
