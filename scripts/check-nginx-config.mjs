#!/usr/bin/env node
// Guardrail: statically validate deploy/nginx config without a running nginx.
//
// Catches the failure classes nginx reports at startup as `[emerg]`:
//   1. duplicate single-assignment directives in the same context
//      (e.g. `proxy_buffering` set by an included snippet AND by the location
//      that includes it — the exact bug that took down the production
//      sidecar deploy);
//   2. `include` targets that do not resolve to a file the image ships;
//   3. duplicate `location` prefixes inside one server block.
//
// It mirrors the include expansion the runtime performs: templates are
// envsubst'd (${...} masked here) and rendered into /etc/nginx/conf.d, and
// every `/etc/nginx/snippets/c1rcle/<name>` include pastes the repo file
// `deploy/nginx/snippets/<name>` into the same context.
//
// Run: node scripts/check-nginx-config.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.C1RCLE_REPO_ROOT
  ? process.env.C1RCLE_REPO_ROOT
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const nginxDir = join(root, 'deploy', 'nginx');

// Single-value nginx directives: defining them twice in one context is an
// `[emerg] ... is duplicate` error. Everything else we track is either
// repeatable (proxy_set_header, proxy_hide_header, proxy_no_cache,
// proxy_cache_bypass, proxy_redirect, proxy_pass, add_header, ...) or not a
// proxy_* policy line.
const SINGLE_ASSIGNMENT = new Set([
  'proxy_buffering',
  'proxy_cache',
  'proxy_http_version',
  'proxy_read_timeout',
  'proxy_send_timeout',
  'proxy_connect_timeout',
  'proxy_request_buffering',
  'proxy_pass_request_headers',
  'proxy_pass_request_body',
  'proxy_next_upstream',
]);

const ENTRY_POINTS = [
  'nginx.conf',
  'conf.d/api.conf',
  'templates/staging.conf.template',
  'templates/production.conf.template',
  'templates/staging-edge.conf.template',
  'templates/production-edge.conf.template',
].map((p) => join(nginxDir, p));

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

// Strip `#` comments (respecting quoted strings) and `/* */` blocks, then
// mask ${PLACEHOLDERS} and tokenize. Returns tokens with {line} attached.
function tokenize(source, lineNo) {
  // Remove block comments first (none in this tree, but be safe).
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const lines = source.split('\n');
  let base = lineNo;
  for (const raw of lines) {
    let line = raw;
    // Mask envsubst placeholders BEFORE any structural analysis.
    line = line.replace(/\$\{[^}]*\}/g, 'PH');
    const toks = [];
    let i = 0;
    let inQuote = null;
    let cur = '';
    const flush = () => {
      if (cur) {
        toks.push(cur);
        cur = '';
      }
    };
    while (i < line.length) {
      const ch = line[i];
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
          cur += ch; // keep quotes; only used for uniqueness of values
        } else {
          cur += ch;
        }
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inQuote = ch;
        cur += ch;
        i++;
        continue;
      }
      if (ch === '#') {
        break; // comment to end of line
      }
      if ('{};'.includes(ch)) {
        flush();
        toks.push(ch);
        i++;
        continue;
      }
      if (/\s/.test(ch)) {
        flush();
        i++;
        continue;
      }
      cur += ch;
      i++;
    }
    flush();
    for (const t of toks) out.push({ t, line: base });
    base++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser: expand includes into contexts, detect duplicates
// ---------------------------------------------------------------------------

const errors = [];

/**
 * Parse a file and fold its statements into the current context(s).
 *
 * @param {string} absPath repo path of the file
 * @param {Array}  stack   context stack (bottom = root context)
 * @param {Set}    includeChain paths being expanded (cycle guard)
 */
function parseFile(absPath, stack, includeChain) {
  const rel = relative(root, absPath).replace(/\\/g, '/');
  if (includeChain.has(rel)) {
    errors.push(`include cycle detected: ${rel}`);
    return;
  }

  let source;
  try {
    source = readFileSync(absPath, 'utf8');
  } catch {
    errors.push(`cannot read ${rel}`);
    return;
  }

  const tokens = tokenize(source, 1);
  const chain = new Set(includeChain).add(rel);
  let pending = []; // header/directive tokens since last `;` / `{` / `}`
  let curLine = 1;

  const record = () => {
    if (pending.length === 0) return;
    const name = pending[0].t;
    const ctx = stack[stack.length - 1];
    // Directive statements (end with `;`) land in the current context.
    if (name === 'include') {
      const target = pending[1]?.t ?? '';
      const resolved = resolveInclude(target);
      if (resolved === '__missing__') {
        errors.push(
          `include '${target}' at ${rel}:${pending[0].line} does not resolve to a shipped file`,
        );
      } else if (resolved === '__skip__') {
        // package-provided / runtime-resolved include — nothing to check
      } else {
        parseFile(resolved, stack, chain);
      }
    } else if (SINGLE_ASSIGNMENT.has(name)) {
      const seen = ctx.single.get(name);
      if (process.env.C1RCLE_DEBUG === '1') {
        console.error(
          `[debug] ${name} -> ctx ${ctx.kind} '${ctx.args.join(' ')}' @ ${rel}:${pending[0].line} (${seen ? 'DUP of ' + seen : 'first'})`,
        );
      }
      if (seen) {
        errors.push(
          `duplicate '${name}' in same context: first at ${seen}, again at ${rel}:${pending[0].line}`,
        );
      } else {
        ctx.single.set(name, `${rel}:${pending[0].line}`);
      }
    }
    pending = [];
  };

  for (const { t, line } of tokens) {
    curLine = line;
    if (t === '{') {
      // Everything collected so far is a block header (server/location/map/...).
      const kind = pending.length ? pending[0].t : '(anonymous)';
      const ctx = {
        kind,
        args: pending.map((p) => p.t),
        line,
        file: rel,
        single: new Map(),
        locations: new Map(),
        children: [],
      };
      stack[stack.length - 1].children.push(ctx);
      stack.push(ctx);
      pending = [];
    } else if (t === '}') {
      if (stack.length > 1) stack.pop();
      pending = [];
    } else if (t === ';') {
      record();
    } else {
      pending.push({ t, line });
    }
  }
  // Trailing statement without `;` is a config syntax problem worth flagging.
  if (pending.length > 0) {
    errors.push(`unterminated statement in ${rel} near line ${curLine}: ${pending[0].t}`);
  }
}

/** Map the in-container include path back to a repo file.
 * Returns a path to parse, the string "__skip__" for package-provided /
 * runtime-resolved includes (mime.types, conf.d globs), or null when a
 * c1rcle snippet referenced by the repo does not exist in the tree. */
function resolveInclude(target) {
  const m = target.match(/^\/etc\/(.+)$/);
  if (!m) return null;
  const parts = m[1].split('/'); // e.g. ["nginx","snippets","c1rcle","api-locations.conf"]
  if (parts[0] === 'nginx' && parts[1] === 'snippets' && parts[2] === 'c1rcle') {
    const f = join(nginxDir, 'snippets', parts.slice(3).join('/'));
    return existsSync(f) ? f : '__missing__';
  }
  return '__skip__'; // /etc/nginx/* (mime.types, conf.d globs) — not in this tree
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

for (const entry of ENTRY_POINTS) {
  const rootCtx = {
    kind: 'http',
    args: [],
    line: 0,
    file: relative(root, entry).replace(/\\/g, '/'),
    single: new Map(),
    locations: new Map(),
    children: [],
  };
  const stack = [rootCtx];
  parseFile(entry, stack, new Set());
  // Duplicate-location check: direct `location` children of each server.
  const walk = (ctx) => {
    if (ctx.kind === 'server') {
      const seen = ctx.locations;
      for (const child of ctx.children) {
        if (child.kind === 'location') {
          const key = child.args.join(' ');
          const first = seen.get(key);
          if (first) {
            errors.push(
              `duplicate location '${key}' in server ${rootCtx.file}: first ${first}, again ${child.file}:${child.line}`,
            );
          } else {
            seen.set(key, `${child.file}:${child.line}`);
          }
        }
      }
    }
    for (const child of ctx.children) walk(child);
  };
  walk(rootCtx);
}

if (errors.length > 0) {
  console.error(`nginx config check FAILED — ${errors.length} error(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`nginx config check OK (${ENTRY_POINTS.length} entry points, includes expanded)`);
