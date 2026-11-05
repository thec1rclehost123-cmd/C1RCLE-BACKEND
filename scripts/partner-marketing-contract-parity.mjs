import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Focused parity for the new subpath; the existing general parity sweep stays unchanged.
const frontendRoot = process.argv[2];
if (!frontendRoot) throw new Error('Pass the paired frontend worktree path');
const backend = await import(
  pathToFileURL(resolve('packages/contracts/src/contracts/partner-marketing.ts')).href
);
const frontend = await import(
  pathToFileURL(resolve(frontendRoot, 'packages/contracts/src/contracts/partner-marketing.ts')).href
);
const empty = { rows: [], events: [], tiers: [], total: 0, nextOffset: null };
const row = {
  id: 'opaque',
  name: 'Synthetic Guest',
  eventId: 'event-a',
  eventName: 'Night',
  tickets: 1,
  totalSpendPaise: 0,
};
const cases = [
  ['marketingAudienceSchema', empty, true],
  ['marketingAudienceSchema', { ...empty, rows: [row], total: 1 }, true],
  [
    'marketingAudienceSchema',
    { ...empty, rows: [{ ...row, email: 'private@example.invalid' }] },
    false,
  ],
  ['marketingAudienceSchema', { ...empty, phone: '+919000000000' }, false],
  ['marketingAudienceQuerySchema', { search: 'Synthetic', offset: 0 }, true],
  ['marketingAudienceQuerySchema', { email: 'private@example.invalid' }, false],
  ['marketingAudienceQuerySchema', { offset: -1 }, false],
  [
    'ticketTierPerformanceSchema',
    { rows: [], channels: { promoter: 0, unattributed: 0 }, purchaseDays: [0, 0, 0, 0, 0, 0, 0] },
    true,
  ],
];
for (const [schema, value, expected] of cases) {
  const left = backend[schema].safeParse(value);
  const right = frontend[schema].safeParse(value);
  assert.equal(left.success, expected, `${schema} backend expectation`);
  assert.equal(right.success, expected, `${schema} frontend expectation`);
  if (left.success && right.success) assert.deepEqual(left.data, right.data);
}
console.log(`Partner Marketing contract parity: ${cases.length} cases agree`);
