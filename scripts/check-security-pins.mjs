/**
 * ─── Security pin guardrail ───────────────────────────────────────────────────
 * Enforces that every dependency pinned for a security advisory is pinned
 * DURABLY — in pnpm-workspace.yaml, not only in pnpm-lock.yaml.
 *
 * Why this exists
 * ---------------
 * pnpm resolves versions from the manifests. Hand-editing pnpm-lock.yaml (or
 * running a plain `pnpm install` on a branch whose pnpm-workspace.yaml lacks
 * the override) silently returns the tree to the vulnerable release, and
 * `pnpm audit` goes red on a later, unrelated PR. Commit 8be206f
 * ("chore: fix high severity vulnerabilities in lockfile") shipped exactly that:
 * four HIGH findings cleared in the lockfile, nothing in the workspace manifest,
 * so any later `pnpm install` reverted it.
 *
 * What it checks
 * --------------
 * For each pin in governance/security-pins.json:
 *   1. the override key exists in pnpm-workspace.yaml with the declared value;
 *   2. the same key/value is recorded in the pnpm-lock.yaml `overrides` block
 *      (proof the lockfile was generated WITH the override, not hand-patched);
 *   3. the versions the lockfile actually resolved agree with the pin
 *      (`resolved` = exact allowed set, or `minResolved` = floor per version).
 *
 * It additionally reconciles the two overrides blocks against each other, so a
 * workspace override with no matching lockfile entry (which breaks
 * `pnpm install --frozen-lockfile` in the Dockerfile) fails here too.
 *
 * With --base <ref> it also inspects commits in <ref>..HEAD for the exact shape
 * of the original bug: a commit that touches pnpm-lock.yaml, names an advisory
 * (or "high severity vulnerabilities"), and does NOT touch pnpm-workspace.yaml.
 *
 * Exit code 0 = clean. Exit 1 = violation found (CI fails).
 *
 * Run: node scripts/check-security-pins.mjs [--base <ref>]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];

// ── Minimal YAML reader ──────────────────────────────────────────────────────
// Both files we read are machine-generated / hand-maintained flat mappings
// under a single top-level `overrides:` key. A dependency would be a worse trade
// than 40 lines of parsing, and a real YAML lib would silently accept shapes
// this checker then mishandles.

/** Strip a trailing `# comment`, honouring quotes. */
function stripComment(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** `  key: value` -> `key`, with surrounding quotes removed. */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

/** Read `overrides:` from a pnpm manifest or lockfile as a plain object. */
function readOverrides(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const out = new Map();
  let inBlock = false;
  let blockIndent = 0;

  for (const raw of lines) {
    const line = stripComment(raw);
    if (line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;

    if (!inBlock) {
      // Match the top-level key only (column 0), so a nested `overrides:`
      // inside another mapping cannot be mistaken for it.
      if (/^overrides:\s*$/.test(line)) {
        inBlock = true;
        blockIndent = indent;
      }
      continue;
    }

    // Anything at or left of the owning key's indent ends the block.
    if (indent <= blockIndent) {
      inBlock = false;
      continue;
    }

    const match = line.match(/^\s*(?:- )?([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = unquote(match[1]);
    // A nested mapping (value empty) is not an override entry.
    if (match[2].trim() === '') continue;
    out.set(key, unquote(match[2]));
  }
  return out;
}

// ── Lockfile `packages:` section -> resolved versions per package name ───────

/**
 * Collect every `name@version` that the lockfile actually carries, e.g.
 * `  brace-expansion@1.1.21:` and `  '@scope/pkg@2.0.0':`.
 *
 * Restricted to the `packages:` section: the `snapshots:` section repeats every
 * dependency as `<name>: <version>` with no package name in the key, so it
 * would need a different pattern and add no information.
 */
function readResolvedVersions(file, name) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const versions = new Set();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchored on the package name so `fast-uri@^3.0.0` cannot match `fast-uri-x`.
  const key = new RegExp(`^  '?${escaped}@([^':]+)'?:$`);
  let inPackages = false;

  for (const raw of lines) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    // Any other top-level key ends the section.
    if (inPackages && /^\S/.test(raw)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;
    const match = raw.match(key);
    if (match) versions.add(match[1]);
  }
  return [...versions].sort();
}

// ── Version comparison ───────────────────────────────────────────────────────

/** Split a plain `x.y.z[-pre]` into comparable numeric parts. */
function parseVersion(v) {
  const match = String(v).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] || '' };
}

/** -1 / 0 / 1. A pre-release sorts below its release (1.0.0-rc < 1.0.0). */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const field of ['major', 'minor', 'patch']) {
    if (pa[field] !== pb[field]) return pa[field] < pb[field] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

// ── Invariant checks ─────────────────────────────────────────────────────────

const workspaceOverrides = readOverrides(join(ROOT, 'pnpm-workspace.yaml'));
const lockOverrides = readOverrides(join(ROOT, 'pnpm-lock.yaml'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'governance', 'security-pins.json'), 'utf8'));

for (const pin of manifest.pins) {
  const label = `${pin.name} (${pin.advisories.join(', ')})`;

  if (!pin.overrides || Object.keys(pin.overrides).length === 0) {
    errors.push(`${pin.name}: pin declares no overrides — remove the pin or add the override.`);
    continue;
  }

  // (1) durable pin: present in the workspace manifest
  for (const [key, value] of Object.entries(pin.overrides)) {
    const actual = workspaceOverrides.get(key);
    if (actual === undefined) {
      errors.push(
        `${label}\n  ✗ pnpm-workspace.yaml has no override for '${key}'.\n` +
          `    A pnpm-lock.yaml edit alone does NOT hold: pnpm re-resolves from the\n` +
          `    manifest, so the next plain \`pnpm install\` reverts this pin. Add:\n` +
          `      overrides:\n        '${key}': '${value}'`,
      );
    } else if (actual !== value) {
      errors.push(
        `${label}\n  ✗ pnpm-workspace.yaml pins '${key}' to '${actual}', expected '${value}'.`,
      );
    }

    // (2) the lockfile was generated with the override, not hand-patched
    const inLock = lockOverrides.get(key);
    if (inLock === undefined) {
      errors.push(
        `${label}\n  ✗ pnpm-lock.yaml records no override for '${key}'.\n` +
          `    The lockfile is out of sync with pnpm-workspace.yaml; \`pnpm install\`\n` +
          `    regenerates it and \`pnpm install --frozen-lockfile\` (Dockerfile) fails.`,
      );
    } else if (inLock !== value) {
      errors.push(
        `${label}\n  ✗ pnpm-lock.yaml records '${key}' -> '${inLock}', expected '${value}'.`,
      );
    }
  }

  // (3) what the tree actually resolved
  const resolved = readResolvedVersions(join(ROOT, 'pnpm-lock.yaml'), pin.name);

  if (resolved.length === 0) {
    // Not an error: a pin may become unreachable when the advisory is no longer
    // in the dependency graph. Surfaced so it does not rot unnoticed. Logged to
    // stdout, not stderr — stderr noise reads as a failure in CI step logs.
    console.log(`  note: ${pin.name} is pinned but absent from the lockfile — drop the pin.`);
    continue;
  }

  if (pin.resolved) {
    if (!sameSet(resolved, pin.resolved)) {
      errors.push(
        `${label}\n  ✗ pnpm-lock.yaml resolves ${pin.name}@${resolved.join(', ')}; ` +
          `the pin allows only ${pin.resolved.join(', ')}.\n` +
          `    If a newer patched release is now in the tree, update governance/\n` +
          `    security-pins.json and pnpm-workspace.yaml in the same PR.`,
      );
    }
  } else if (pin.minResolved) {
    const floor = pin.minResolved;
    const below = resolved.filter((v) => {
      const order = compareVersions(v, floor);
      return order === null ? true : order < 0;
    });
    if (below.length > 0) {
      errors.push(
        `${label}\n  ✗ pnpm-lock.yaml resolves ${pin.name}@${below.join(', ')}, ` +
          `below the pinned floor ${floor}.`,
      );
    }
  } else {
    errors.push(
      `${label}\n  ✗ pin declares neither 'resolved' nor 'minResolved' — the checker\n` +
        `    cannot verify what the lockfile installed.`,
    );
  }
}

// Reconcile the two overrides blocks: every workspace override must be recorded
// in the lockfile. Catches an override added without regenerating the lockfile.
for (const [key, value] of workspaceOverrides) {
  const inLock = lockOverrides.get(key);
  if (inLock === undefined) {
    errors.push(
      `pnpm-workspace.yaml override '${key}' is missing from pnpm-lock.yaml.\n` +
        `    Run \`pnpm install\` and commit the lockfile, otherwise --frozen-lockfile\n` +
        `    builds (Dockerfile) fail.`,
    );
  } else if (inLock !== value) {
    errors.push(
      `Override '${key}': pnpm-workspace.yaml says '${value}', pnpm-lock.yaml says '${inLock}'.`,
    );
  }
}

// ── Commit-shape check (opt-in, needs a git range) ───────────────────────────

/** Advisory IDs, or the phrase the original bad commit used. Deliberately narrow. */
const SECURITY_COMMIT =
  /(CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|\b(high|critical)\b[^.]*vulnerab)/i;

const baseArgIndex = process.argv.indexOf('--base');
const base = baseArgIndex !== -1 ? process.argv[baseArgIndex + 1] : undefined;

if (base) {
  let commits;
  try {
    const out = execFileSync('git', ['log', '--format=%H%x00%s', `${base}..HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    commits = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject] = line.split('\0');
        return { hash, subject };
      });
  } catch {
    console.log(`  note: cannot resolve '${base}..HEAD' — skipping the commit-shape check.`);
    commits = [];
  }

  for (const { hash, subject } of commits) {
    if (!SECURITY_COMMIT.test(subject)) continue;
    let files;
    try {
      // `diff-tree -m` rather than `git show`: `git show --name-only` prints
      // nothing for a merge commit (no diff by default), and every CI range
      // contains merge commits. `-m` diffs against each parent and lists the
      // touched paths for all of them.
      files = execFileSync(
        'git',
        ['diff-tree', '-m', '--no-commit-id', '--name-only', '-r', hash],
        { cwd: ROOT, encoding: 'utf8' },
      )
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      continue;
    }
    if (!files.includes('pnpm-lock.yaml')) continue;
    if (files.includes('pnpm-workspace.yaml')) continue;

    errors.push(
      `Commit ${hash.slice(0, 7)} ("${subject}") changes pnpm-lock.yaml for a security fix\n` +
        `  without touching pnpm-workspace.yaml — the lockfile-only fix that commit\n` +
        `  8be206f shipped, which the first plain \`pnpm install\` silently reverted.\n` +
        `  Add the override to pnpm-workspace.yaml (and governance/security-pins.json)\n` +
        `  in the same commit, then regenerate the lockfile.`,
    );
  }
}

// ── Result ───────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error(`security pin check FAILED — ${errors.length} error(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}\n`);
  process.exit(1);
}

console.log(
  `security pin check OK (${manifest.pins.length} advisory pins held by pnpm-workspace.yaml` +
    `${base ? `, ${base}..HEAD commits inspected` : ''})`,
);
