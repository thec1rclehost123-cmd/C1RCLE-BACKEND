/**
 * Prints the `--from` ref that `commitlint` should start after when linting a
 * pull request's commits.
 *
 * Why this exists: the `Commit messages` job used to lint
 * `origin/<base>..<head>` wholesale. A PR whose base lags the integration
 * branch necessarily carries that branch's history inside the range, because
 * merging it in is exactly how the branch catches up. So the job judged the PR
 * on commits it never authored — including squash-merge commits whose subject
 * is the original PR title, e.g. `Fix/guest portal update (#47)`, which is
 * neither a conventional type nor a conventional subject. That is a real
 * failure, but not one this PR could act on, and a gate that fails on history
 * you cannot edit is a gate people learn to bypass.
 *
 * The fix is the same shape as `scripts/check-security-pins.mjs`: narrow the
 * *history* audit to what this branch actually introduces, and leave every
 * invariant check to run against the current tree. Here that means
 * `git rev-list <base>..<head> --not <already-merged refs>` — the commits in
 * range that the integration branch has not already accepted.
 *
 * Output is a single line, meant to be captured:
 *   - a commit SHA: lint `--from <sha> --to <head>`
 *   - `NONE`:        nothing in range is unreviewed, so there is nothing to lint
 *                    (a pure promotion PR, whose every commit already passed
 *                    review on the integration branch)
 *   - the base ref:  the narrowing could not be computed, so fall back to the
 *                    original unscoped range. Fail-safe: same as today's
 *                    behaviour, never weaker.
 *
 * Known coarseness, stated rather than hidden: commitlint only accepts a
 * contiguous `--from/--to` range, so it walks every commit between the two
 * endpoints, including already-merged ones that sit between the oldest
 * unreviewed commit and the head. That happens only when a branch is behind
 * its base — merge the base in and the range collapses to the branch's own
 * commits (measured: a staging-based PR whose head contains the staging tip
 * inspects exactly its own commits). So the residual risk is the gate being
 * slightly *stricter* than strictly necessary on a stale branch, never more
 * permissive. It cannot be made exact without changing the linter, because a
 * filtered commit list is not a range.
 *
 * Run: node scripts/pr-commit-range.mjs --base <ref> --head <ref>
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The empty tree: stands in for "before the first commit" for a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const base = arg('base');
const head = arg('head');

if (!base || !head) {
  console.error('usage: node scripts/pr-commit-range.mjs --base <ref> --head <ref>');
  process.exit(1);
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** Refs whose commits are already reviewed, so they need not be linted again. */
const EXEMPT_REFS = ['origin/staging', 'origin/main'].filter((ref) => {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    // A missing ref is an ordinary, expected outcome (shallow fetch, or a fork
    // that has no `origin/main`), not something worth a warning.
    return false;
  }
});

// No integration refs resolved (shallow clone, unusual remote layout): keep the
// original range rather than silently linting nothing.
if (EXEMPT_REFS.length === 0) {
  console.log(base);
  process.exit(0);
}

let oldestUnreviewed;
try {
  // `--reverse` puts the oldest first, which is the one whose parent is the
  // correct `--from`: everything after it, and nothing before it.
  // Split on `\r?\n` so a CRLF checkout (this repo is developed on Windows)
  // cannot leave a trailing `\r` glued onto the SHA and break `rev-parse`.
  oldestUnreviewed = git(['rev-list', '--reverse', `${base}..${head}`, '--not', ...EXEMPT_REFS])
    .split(/\r?\n/)
    .filter(Boolean)[0];
} catch (err) {
  // Could not compute the narrowing — fall back to auditing the whole range.
  // Say so on stderr: a silent fallback here looks identical to a correct
  // narrowing in the Actions log, which is exactly the bug you want to catch.
  console.error(
    'pr-commit-range: could not compute the unreviewed set, falling back to the base ref:',
    err instanceof Error ? err.message : String(err),
  );
  console.log(base);
  process.exit(0);
}

// Every commit in range is already merged. A legitimate answer, not a failure:
// this PR introduces nothing that has not been reviewed.
if (!oldestUnreviewed) {
  console.log('NONE');
  process.exit(0);
}

// A root commit has no parent; start from the empty tree so it is still linted.
let from;
try {
  from = git(['rev-parse', '--verify', '--quiet', `${oldestUnreviewed}^`]);
  if (!from) from = EMPTY_TREE;
} catch {
  from = EMPTY_TREE;
}

console.log(from);
