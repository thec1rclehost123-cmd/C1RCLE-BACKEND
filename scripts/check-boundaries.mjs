/**
 * ─── Backend boundary guardrail ───────────────────────────────────────────────
 * Static scan that enforces the architecture rules for the V2 backend:
 *
 * 1. `process.env` reads are only allowed in the gateway config module.
 * 2. `fetch(` (network calls) only inside the gateway transport (lib/plugins).
 * 3. Firestore/database SDK imports never appear in domain/application code
 *    — the one exemption is `packages/core/src/infrastructure/firestore/**`,
 *    the B12 storage adapter layer, which exists specifically to own this.
 * 4. `.collection(` / `.doc(` never appear in route files.
 *
 * Exit code 0 = clean. Exit 1 = violation found (CI fails).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'apps', 'api-gateway', 'src');

const GATEWAY_CONFIG = join(SRC, 'config');
const GATEWAY_LIB = join(SRC, 'lib');
const FIRESTORE_ADAPTER_DIR = join(ROOT, 'packages', 'core', 'src', 'infrastructure', 'firestore');

const violations = [];

function walk(dir, cb) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules' || entry === '.turbo') continue;
      walk(full, cb);
    } else if (extname(full) === '.ts' && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
      cb(full);
    }
  }
}

/** Strips block + line comments so guardrail rules never fire on prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const isInside = (file, dir) => file.startsWith(dir + '\\') || file.startsWith(dir + '/');

// Rule 1: process.env only in gateway config
walk(join(ROOT, 'packages'), (file) => {
  const src = stripComments(readFileSync(file, 'utf8'));
  if (/\bprocess\s*\.\s*env\b/.test(src)) {
    violations.push(`process.env in core package (forbidden): ${file}`);
  }
});
walk(SRC, (file) => {
  const src = stripComments(readFileSync(file, 'utf8'));
  if (/\bprocess\s*\.\s*env\b/.test(src) && !isInside(file, GATEWAY_CONFIG)) {
    violations.push(`process.env outside gateway config (forbidden): ${file}`);
  }
});

// Rule 2: raw fetch only in gateway transport
walk(join(ROOT, 'packages'), (file) => {
  const src = stripComments(readFileSync(file, 'utf8'));
  if (/\bfetch\s*\(/.test(src)) {
    violations.push(`raw fetch() in core package (forbidden): ${file}`);
  }
});
walk(SRC, (file) => {
  const src = stripComments(readFileSync(file, 'utf8'));
  if (/\bfetch\s*\(/.test(src) && !isInside(file, GATEWAY_LIB) && !isInside(file, GATEWAY_CONFIG)) {
    violations.push(`raw fetch() outside transport layer (forbidden): ${file}`);
  }
});

// Rule 3: no database SDKs in domain/application
for (const dir of ['packages', 'apps']) {
  walk(join(ROOT, dir), (file) => {
    if (isInside(file, join(ROOT, 'apps', 'api-gateway', 'src', 'lib'))) return;
    if (isInside(file, FIRESTORE_ADAPTER_DIR)) return;
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const sdk of [
      'firebase-admin',
      'firebase/firestore',
      'google-cloud/firestore',
      '@google-cloud/firestore',
    ]) {
      if (src.includes(`'${sdk}'`) || src.includes(`"${sdk}"`)) {
        violations.push(`database SDK import outside allowed layer: ${file} (${sdk})`);
      }
    }
  });
}

// Rule 4: no direct database access in route files
for (const dir of [join(SRC, 'routes')]) {
  walk(dir, (file) => {
    const src = stripComments(readFileSync(file, 'utf8'));
    if (/\.collection\s*\(/.test(src) || /\.doc\s*\(/.test(src)) {
      violations.push(`direct database call in route file (forbidden): ${file}`);
    }
  });
}

if (violations.length > 0) {
  console.error('Boundary guardrail violations:');
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log('Boundary guardrails: clean');
