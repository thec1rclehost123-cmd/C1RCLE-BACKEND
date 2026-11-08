/**
 * ─── Firestore composite-index guardrail ─────────────────────────────────────
 * Fails when a Firestore query in `packages/core/src/infrastructure/firestore`
 * needs a composite index that `firestore.indexes.json` does not declare.
 *
 * Why this exists
 * ---------------
 * Firestore answers an unindexed composite query with `FAILED_PRECONDITION:
 * The query requires an index`, which the gateway surfaces as a bare HTTP 500.
 * The in-memory adapters and the unit tests never hit it, so the first symptom
 * is a live endpoint failing — `GET /public/discovery` shipped that way, with
 * no `v2_events` index declared at all.
 *
 * What it checks
 * --------------
 * Every `.where()` / `.orderBy()` chain is unrolled with the TypeScript
 * compiler (following `const base = ...where()` variables inside the same
 * function) and the collection is resolved from the enclosing class. A
 * composite index is required when the query has:
 *   - an inequality/range filter or an `orderBy` on a field, together with an
 *     equality filter (`==`, `in`, `array-contains`) on a different field; or
 *   - more than one distinct `orderBy`; or
 *   - a range filter on one field and an `orderBy` on another.
 * Equality-only queries use Firestore's automatic single-field indexes and are
 * skipped. A declared index covers a query when it is on the same collection,
 * contains every field the query touches, and ends with the query's
 * range/order fields (equality fields may come first, in any order).
 *
 * Known limits: it only sees chains built from literal field names and
 * same-function variables. A query assembled across functions is not analysed —
 * the check is a net for the common shape, not a proof.
 *
 * Usage: node scripts/check-firestore-indexes.mjs     (exit 0 = covered, 1 = gap)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_DIR = join(ROOT, 'packages/core/src/infrastructure/firestore');
const INDEXES_FILE = join(ROOT, 'firestore.indexes.json');

const EQUALITY_OPS = new Set(['==', 'in', 'array-contains', 'array-contains-any']);

const declared = JSON.parse(readFileSync(INDEXES_FILE, 'utf8').replace(/^\uFEFF/u, '')).indexes;

function literalText(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.getText();
}

/** Unrolls `a.b(x).c(y)` into its calls, inlining same-function `const` roots. */
function unroll(node, env) {
  const calls = [];
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current)
    ) {
      current = current.expression;
    } else if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      calls.unshift({ name: current.expression.name.text, args: [...current.arguments] });
      current = current.expression.expression;
    } else if (ts.isIdentifier(current) && env.has(current.text)) {
      const inner = unroll(env.get(current.text), env);
      calls.unshift(...inner.calls);
      return { root: inner.root, calls };
    } else {
      return { root: current, calls };
    }
  }
}

function collectQueries(file, source) {
  const consts = new Map();
  for (const m of source.text.matchAll(/const\s+(\w+)\s*=\s*['"`](v2_[a-z_]+)['"`]/gu)) {
    consts.set(m[1], m[2]);
  }
  const collectionsIn = (node) => {
    const text = node.getText();
    const names = new Set([...text.matchAll(/['"`](v2_[a-z_]+)['"`]/gu)].map((m) => m[1]));
    for (const [name, value] of consts) {
      if (new RegExp(`\\b${name}\\b`, 'u').test(text)) names.add(value);
    }
    return [...names];
  };
  const enclosingClass = (node) => {
    let current = node;
    while (current && !ts.isClassDeclaration(current)) current = current.parent;
    return current;
  };

  const queries = [];
  const visitFunction = (fn) => {
    const env = new Map();
    ts.forEachChild(fn, function collect(node) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        env.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    });
    const seen = new Set();
    ts.forEachChild(fn, function walk(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const { root, calls } = unroll(node, env);
        if (calls.some((c) => c.name === 'where' || c.name === 'orderBy')) {
          const key = calls.map((c) => `${c.name}(${c.args.map((a) => a.getText())})`).join('.');
          if (!seen.has(key)) {
            seen.add(key);
            const inline = [
              ...root.getText().matchAll(/collection\(\s*([A-Z_]+|['"`]v2_[a-z_]+['"`])/gu),
            ].map((m) => {
              const name = m[1].replace(/['"`]/gu, '');
              return consts.get(name) ?? name;
            });
            const owner = enclosingClass(node);
            queries.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              collections: inline.length > 0 ? inline : owner ? collectionsIn(owner) : [],
              filters: calls
                .filter((c) => c.name === 'where')
                .map((c) => ({ field: literalText(c.args[0]), op: literalText(c.args[1]) })),
              orders: calls
                .filter((c) => c.name === 'orderBy')
                .map((c) => ({
                  field: literalText(c.args[0]),
                  dir: literalText(c.args[1]) ?? 'asc',
                })),
            });
          }
        }
      }
      ts.forEachChild(node, walk);
    });
  };
  ts.forEachChild(source, function top(node) {
    if (
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      visitFunction(node);
    } else {
      ts.forEachChild(node, top);
    }
  });
  return queries;
}

const needed = new Map();
for (const file of readdirSync(SOURCE_DIR).filter(
  (f) => f.endsWith('.ts') && !f.includes('.test.'),
)) {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(SOURCE_DIR, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const query of collectQueries(file, source)) {
    const equality = query.filters.filter((f) => EQUALITY_OPS.has(f.op)).map((f) => f.field);
    const range = query.filters.filter((f) => !EQUALITY_OPS.has(f.op)).map((f) => f.field);
    const order = query.orders.map((o) => o.field);
    const tail = [...new Set([...range, ...order])];
    const requiresComposite =
      tail.length > 0 &&
      (equality.some((f) => !tail.includes(f)) ||
        order.length > 1 ||
        (range.length > 0 && order.length > 0 && !range.every((r) => order.includes(r))));
    if (!requiresComposite) continue;
    const key = `${query.collections.join('|')}::${JSON.stringify([equality, tail])}`;
    if (!needed.has(key)) needed.set(key, { ...query, equality, tail });
  }
}

const gaps = [];
for (const q of needed.values()) {
  const fields = [...new Set([...q.equality, ...q.tail])];
  const covered = q.collections.some((collection) =>
    declared.some(
      (index) =>
        index.collectionGroup === collection &&
        fields.every((f) => index.fields.some((x) => x.fieldPath === f)) &&
        index.fields
          .slice(-q.tail.length)
          .map((x) => x.fieldPath)
          .join() === q.tail.join(),
    ),
  );
  if (!covered) gaps.push(q);
}

if (gaps.length > 0) {
  console.error(
    `✖ ${gaps.length} Firestore quer${gaps.length === 1 ? 'y needs' : 'ies need'} a composite index missing from firestore.indexes.json:\n`,
  );
  for (const q of gaps) {
    const direction = q.orders.find((o) => o.field === q.tail.at(-1))?.dir.toLowerCase();
    console.error(
      `  ${q.file}:${q.line}  ${q.collections.join(' | ')}\n` +
        `    equality: ${JSON.stringify(q.equality)}  range/order: ${JSON.stringify(q.tail)}\n` +
        `    add: { "collectionGroup": "${q.collections[0]}", "queryScope": "COLLECTION", "fields": [` +
        [...q.equality, ...q.tail]
          .map(
            (f) =>
              `{ "fieldPath": "${f}", "order": "${q.tail.includes(f) && direction === 'desc' ? 'DESCENDING' : 'ASCENDING'}" }`,
          )
          .join(', ') +
        `] }\n`,
    );
  }
  process.exit(1);
}
console.log(`✔ ${needed.size} composite-index queries, all covered by firestore.indexes.json`);
