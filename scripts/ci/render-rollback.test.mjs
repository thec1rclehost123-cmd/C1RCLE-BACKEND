import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const safeSha = 'a'.repeat(40);
const badSha = 'b'.repeat(40);
function run(approvedSha, deploySha = safeSha) {
  const preload = `globalThis.fetch = async (_url, init = {}) => {
    console.log('MOCK_METHOD:' + (init.method ?? 'GET'));
    return { ok: true, status: 200, text: async () => JSON.stringify([
      { deploy: { id: 'dep-old', status: 'live', commit: { id: '${deploySha}' } } }
    ]) };
  };`;
  return spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(preload)}`,
      'scripts/ci/render-rollback.mjs',
      '--safe-sha',
      approvedSha,
    ],
    {
      encoding: 'utf8',
      env: {
        RENDER_API_KEY: 'synthetic-test-value',
        RENDER_SERVICE_ID: 'srv-test',
        GITHUB_SHA: badSha,
        GITHUB_STEP_SUMMARY: '',
      },
      timeout: 5000,
    },
  );
}
for (const approved of ['', 'main', 'a'.repeat(7), badSha]) {
  test(`refuses an absent, invalid or failing approved revision (${approved.length})`, () => {
    const result = run(approved);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /MOCK_METHOD:POST/);
  });
}
test('refuses previous live revision outside the approved safe SHA', () => {
  const result = run(safeSha, 'c'.repeat(40));
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /MOCK_METHOD:POST/);
});
test('rolls back only to the exact approved live revision', () => {
  const result = run(safeSha);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MOCK_METHOD:POST/);
});
