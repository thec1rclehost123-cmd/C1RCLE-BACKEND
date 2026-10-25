/**
 * ─── Differential contract parity over every exported schema ─────────────────
 * `cases.mjs` and `cases-wire.mjs` pin hand-written fixtures for the schemas
 * that matter most. This file covers the rest without a fixture per schema:
 * for each exported zod schema it builds one valid seed value from the BACKEND
 * schema, derives systematic variants of that seed (a field removed, a wrong
 * type, boundary lengths and numbers, an empty or oversized array, an unknown
 * key) and requires the FRONTEND copy to reach the same verdict on every one.
 *
 * It encodes no expected verdict, so it cannot be wrong about what a schema
 * "should" accept; it can only report that the two copies disagree. When both
 * accept a value it also compares the parsed output, which catches a drifted
 * `.default(...)` or `.transform(...)`.
 *
 * Boundaries come from the schemas themselves: every length and numeric bound
 * declared by EITHER copy is tested at bound-1, bound and bound+1, so loosening
 * or tightening a limit by one is caught, not only by a large amount.
 *
 * Deterministic: fixed pools and no randomness, so a failure is reproducible.
 * It reads zod 4 internals (`schema._zod.def`) to build seeds; a schema it
 * cannot seed is skipped (and says so in the check name), never silently passed.
 * Plain ESM, no build step, like the other parity files.
 *
 * @param {object} context
 * @param {Record<string, any>} context.frontend  built frontend `@c1rcle/contracts` client
 * @param {Record<string, any>} context.backend   built backend `@c1rcle/contracts` client
 * @param {string[]} context.checks               names of the checks that ran
 * @param {string[]} context.failures             drift / mistakes found
 */

const ISO = '2026-10-25T10:00:00.000Z';

const STRING_POOL = [
  'abc',
  'Abc123',
  'a1',
  'id_1',
  'x',
  'Asha Rao',
  '2026-10-25',
  '2026-10',
  '1998-04-02',
  '123456',
  '9876543210',
  'HDFC0001234',
  'INR',
  'a@example.com',
  'https://example.com/a',
  '/event/neon-nights',
  ISO,
  '0123456789abcdef'.repeat(4),
  'ABCDEF0123456789'.repeat(4),
  'a'.repeat(16),
  'a'.repeat(64),
];

const NUMBER_POOL = [1, 2, 5, 10, 18, 30, 100, 1000, 10000, 50000, 2026, 0];

const BASE_LENGTHS = [
  0, 1, 24, 25, 32, 33, 64, 65, 120, 121, 128, 129, 254, 255, 256, 257, 500, 501, 1000, 1001, 2000,
  2001, 5000, 5001,
];

const BASE_NUMBERS = [-1, 0, 1, 1.5, 2, 18, 100, 101, 1000, 1001, 1_000_000_000, 1e21];

const BASE_ARRAY_SIZES = [0, 2, 3, 4, 11, 21, 101, 201, 501];

/** Longest string or array a variant may build; keeps the run fast. */
const MAX_BUILT_LENGTH = 6000;

const WRONG_TYPES = [null, 0, 1, '', 'x', true, false, [], {}];

/** The zod definition of a schema, or `undefined` when it is not a zod 4 schema. */
const defOf = (schema) => schema?._zod?.def;

/** First pooled candidate the (leaf) schema itself accepts. */
function pick(schema, pool) {
  for (const candidate of pool) {
    if (schema.safeParse(candidate).success) return { ok: true, value: candidate };
  }
  return { ok: false };
}

/** Length-targeted strings help when only a min length or exact length is declared. */
function lengthPool(def) {
  const out = [];
  for (const check of def.checks ?? []) {
    const d = check._zod?.def;
    if (d?.check === 'min_length') out.push('a'.repeat(d.minimum));
    if (d?.check === 'length_equals') out.push('a'.repeat(d.length));
  }
  return out;
}

/**
 * Collects every length and numeric bound a schema declares, walking nested
 * objects, arrays, unions and wrappers. Used for boundary-value variants.
 */
function collectBounds(
  schema,
  acc = { lengths: new Set(), numbers: new Set(), values: new Set() },
  depth = 0,
) {
  const def = defOf(schema);
  if (def === undefined || depth > 8) return acc;
  // Enum and literal members from either copy, so a value one side added or
  // removed is tried against the other.
  if (def.type === 'enum') for (const member of Object.values(def.entries)) acc.values.add(member);
  if (def.type === 'literal') for (const member of def.values) acc.values.add(member);
  for (const check of def.checks ?? []) {
    const d = check._zod?.def;
    if (d === undefined) continue;
    if (d.check === 'min_length') acc.lengths.add(d.minimum);
    if (d.check === 'max_length') acc.lengths.add(d.maximum);
    if (d.check === 'length_equals') acc.lengths.add(d.length);
    if (d.check === 'greater_than' || d.check === 'less_than') {
      if (typeof d.value === 'number') acc.numbers.add(d.value);
    }
    if (d.check === 'multiple_of' && typeof d.value === 'number') acc.numbers.add(d.value);
  }
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'nonoptional':
    case 'readonly':
    case 'default':
    case 'prefault':
    case 'catch':
      collectBounds(def.innerType, acc, depth + 1);
      break;
    case 'lazy':
      collectBounds(def.getter(), acc, depth + 1);
      break;
    case 'pipe':
      collectBounds(def.in, acc, depth + 1);
      break;
    case 'array':
      collectBounds(def.element, acc, depth + 1);
      break;
    case 'record':
      collectBounds(def.valueType, acc, depth + 1);
      break;
    case 'union':
      for (const option of def.options) collectBounds(option, acc, depth + 1);
      break;
    case 'object':
      for (const child of Object.values(def.shape)) collectBounds(child, acc, depth + 1);
      break;
    default:
      break;
  }
  return acc;
}

/** Union of the base pools and the neighbourhood of every declared bound. */
function buildPools(...schemas) {
  const lengths = new Set(BASE_LENGTHS);
  const sizes = new Set(BASE_ARRAY_SIZES);
  const numbers = new Set(BASE_NUMBERS);
  const members = new Set();
  for (const schema of schemas) {
    const bounds = collectBounds(schema);
    for (const member of bounds.values) members.add(member);
    for (const bound of bounds.lengths) {
      for (const delta of [-1, 0, 1]) {
        const value = bound + delta;
        if (value >= 0 && value <= MAX_BUILT_LENGTH) {
          lengths.add(value);
          sizes.add(value);
        }
      }
    }
    for (const bound of bounds.numbers) {
      for (const delta of [-1, -0.5, 0, 0.5, 1]) numbers.add(bound + delta);
    }
  }
  return {
    lengths: [...lengths].sort((a, b) => a - b),
    sizes: [...sizes].filter((n) => n <= 600).sort((a, b) => a - b),
    numbers: [...numbers].sort((a, b) => a - b),
    members: [...members],
  };
}

/**
 * Builds a value `schema` accepts, or `{ ok: false }`. Optional fields are
 * included when `withOptional` is set, so a seed exercises their constraints.
 */
function seed(schema, withOptional, depth = 0) {
  const def = defOf(schema);
  if (def === undefined || depth > 8) return { ok: false };
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'nonoptional':
    case 'readonly':
    case 'default':
    case 'prefault':
    case 'catch':
      return seed(def.innerType, withOptional, depth + 1);
    case 'lazy':
      return seed(def.getter(), withOptional, depth + 1);
    case 'pipe':
      return seed(def.in, withOptional, depth + 1);
    case 'string':
      return pick(schema, [...lengthPool(def), ...STRING_POOL]);
    case 'number':
    case 'int':
      return pick(schema, NUMBER_POOL);
    case 'boolean':
      return { ok: true, value: true };
    case 'null':
      return { ok: true, value: null };
    case 'enum':
      return { ok: true, value: Object.values(def.entries)[0] };
    case 'literal':
      return { ok: true, value: def.values[0] };
    case 'void':
    case 'undefined':
      return { ok: true, value: undefined };
    case 'any':
    case 'unknown':
      return { ok: true, value: 'x' };
    case 'array': {
      const element = seed(def.element, withOptional, depth + 1);
      if (!element.ok) return { ok: false };
      for (const size of [1, 2, 3]) {
        const value = Array.from({ length: size }, () => structuredClone(element.value));
        if (schema.safeParse(value).success) return { ok: true, value };
      }
      return { ok: false };
    }
    case 'record': {
      const value = seed(def.valueType, withOptional, depth + 1);
      if (!value.ok) return { ok: false };
      for (const candidate of [{}, { key: value.value }]) {
        if (schema.safeParse(candidate).success) return { ok: true, value: candidate };
      }
      return { ok: false };
    }
    case 'union':
      for (const option of def.options) {
        const built = seed(option, withOptional, depth + 1);
        if (built.ok && schema.safeParse(built.value).success) return built;
      }
      return { ok: false };
    case 'object': {
      const value = {};
      for (const [key, child] of Object.entries(def.shape)) {
        const childDef = defOf(child);
        const isOptional = childDef?.type === 'optional' || childDef?.type === 'default';
        if (isOptional && !withOptional) continue;
        const built = seed(child, withOptional, depth + 1);
        if (!built.ok) return { ok: false };
        if (built.value !== undefined) value[key] = built.value;
      }
      return { ok: true, value };
    }
    default:
      return { ok: false };
  }
}

const describe = (value) => JSON.stringify(value);

/**
 * Yields `[label, make]` pairs derived from a valid `value`, where `make` maps
 * the current value at that position to its replacement. Pure and deterministic.
 */
function* variants(value, pools, path = '$') {
  const replacements = function* () {
    for (const wrong of WRONG_TYPES) yield [`${path} replaced by ${describe(wrong)}`, () => wrong];
  };
  if (value === null || value === undefined) {
    yield* replacements();
    return;
  }
  if (Array.isArray(value)) {
    for (const size of pools.sizes) {
      yield [
        `${path} array of ${size}`,
        () => Array.from({ length: size }, () => structuredClone(value[0])),
      ];
    }
    yield* replacements();
    if (value.length > 0) {
      for (const [label, make] of variants(value[0], pools, `${path}[0]`)) {
        yield [
          label,
          (current) => current.map((element, index) => (index === 0 ? make(element) : element)),
        ];
      }
    }
    return;
  }
  if (typeof value === 'object') {
    yield [`${path} unknown key`, (current) => ({ ...current, unexpected_key: true })];
    for (const key of Object.keys(value)) {
      yield [
        `${path}.${key} removed`,
        (current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
      ];
      for (const [label, make] of variants(value[key], pools, `${path}.${key}`)) {
        yield [label, (current) => ({ ...current, [key]: make(current[key]) })];
      }
    }
    yield* replacements();
    return;
  }
  if (typeof value === 'string') {
    for (const length of pools.lengths)
      yield [`${path} string of ${length}`, () => 'a'.repeat(length)];
    yield [`${path} untrimmed`, () => ` ${value} `];
    yield [`${path} uppercased`, () => value.toUpperCase()];
    for (const member of pools.members) yield [`${path} value ${describe(member)}`, () => member];
    yield* replacements();
    return;
  }
  if (typeof value === 'number') {
    for (const number of pools.numbers) yield [`${path} number ${number}`, () => number];
    for (const member of pools.members) yield [`${path} value ${describe(member)}`, () => member];
    yield* replacements();
    return;
  }
  yield [`${path} negated`, () => !value];
  yield* replacements();
}

const brief = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? 'undefined' : text.length > 120 ? `${text.slice(0, 117)}…` : text;
};

const safe = (schema, value) => {
  try {
    return schema.safeParse(value);
  } catch (error) {
    return { success: false, thrown: String(error) };
  }
};

/**
 * Drift that is understood, tracked and waiting on another change. An entry
 * downgrades ONLY the matching variants (schema name and label) to a printed
 * warning. It is not a way to ignore a schema: if an entry's drift is no
 * longer observed the run FAILS ("stale entry"), so the list cleans itself up
 * the moment the two sides converge. Keep it tiny and give every entry a reason.
 */
const KNOWN_DRIFT = [
  {
    id: 'tax-rule-update-admin-action',
    schemas: ['adminActionSchema', 'proposeActionSchema', 'proposedActionDtoSchema'],
    labelIncludes: 'TAX_RULE_UPDATE',
    reason:
      'The frontend mirror (#74, merged) lists the TAX_RULE_UPDATE admin action; the backend ' +
      'defines it only in the open tax-rule PRs (#127 part 2, #129). Until they merge the ' +
      'admin console could submit an action the gateway rejects. Remove this entry when they land.',
  },
];

export function runGeneratedParityCases({ frontend, backend, checks, failures }) {
  const observed = new Map();
  const report = (name, label, message) => {
    const known = KNOWN_DRIFT.find(
      (entry) => entry.schemas.includes(name) && label.includes(entry.labelIncludes),
    );
    if (known === undefined) {
      failures.push(message);
      return;
    }
    observed.set(known.id, (observed.get(known.id) ?? 0) + 1);
  };

  const names = Object.keys(backend)
    .filter((name) => name.endsWith('Schema') && defOf(backend[name]) !== undefined)
    .sort();

  for (const name of names) {
    if (frontend[name] === undefined) {
      failures.push(`frontend is missing schema \`${name}\` (exported by the backend client)`);
      continue;
    }
    if (defOf(frontend[name]) === undefined) {
      failures.push(`frontend export \`${name}\` is not a zod schema`);
      continue;
    }

    const pools = buildPools(backend[name], frontend[name]);
    let total = 0;
    let usedSeed = false;
    for (const withOptional of [false, true]) {
      const built = seed(backend[name], withOptional);
      if (!built.ok || !backend[name].safeParse(built.value).success) continue;
      usedSeed = true;
      const labelSuffix = withOptional ? ' (optional fields present)' : '';

      const seen = new Set();
      const candidates = [['seed value', built.value]];
      for (const [label, make] of variants(built.value, pools)) {
        candidates.push([label, make(structuredClone(built.value))]);
      }

      for (const [label, value] of candidates) {
        // Full serialisation, not `brief`: truncated text would merge distinct long strings.
        const key = String(JSON.stringify(value));
        if (seen.has(key)) continue;
        seen.add(key);
        total += 1;
        const back = safe(backend[name], value);
        const front = safe(frontend[name], value);
        if (front.success !== back.success) {
          report(
            name,
            label,
            `DRIFT ${name} — "${label}${labelSuffix}": frontend ${front.success ? 'accepts' : 'rejects'}, ` +
              `backend ${back.success ? 'accepts' : 'rejects'} — ${brief(value)}`,
          );
        } else if (front.success && JSON.stringify(front.data) !== JSON.stringify(back.data)) {
          report(
            name,
            label,
            `DRIFT ${name} — "${label}${labelSuffix}": both accept but parse to different output — ` +
              `frontend ${brief(front.data)}, backend ${brief(back.data)}`,
          );
        }
      }
    }
    checks.push(
      usedSeed
        ? `${name}: differential, ${total} variants agree`
        : `${name}: differential skipped (no seed could be built)`,
    );
  }

  for (const entry of KNOWN_DRIFT) {
    const count = observed.get(entry.id) ?? 0;
    if (count === 0) {
      failures.push(
        `stale known-drift entry \`${entry.id}\`: the drift it describes is gone, delete the entry ` +
          'from KNOWN_DRIFT in packages/contracts/parity/cases-generated.mjs',
      );
    } else {
      // A visible warning is the point of an accepted drift: it must show in every CI log.
      console.warn(
        `Contract parity: KNOWN DRIFT \`${entry.id}\` (${count} variants): ${entry.reason}`,
      );
    }
  }
}
