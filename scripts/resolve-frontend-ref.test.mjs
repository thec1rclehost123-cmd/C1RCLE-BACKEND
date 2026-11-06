import test from 'node:test';
import assert from 'node:assert/strict';

import { readFrontendPair, resolveFrontendRef } from './resolve-frontend-ref.mjs';

const repository = 'thec1rclehost123-cmd/C1RCLE-FRONTEND';
const bodyWithPair = `Paired candidate.\n<!-- frontend-contract-pair: ${repository}#163 -->`;
const fetchOpen = async () => ({
  state: 'open',
  merged: false,
  head: { sha: 'a'.repeat(40) },
  base: { ref: 'staging', repo: { full_name: repository } },
});

test('reads a single explicit frontend pair', () => {
  assert.deepEqual(readFrontendPair(bodyWithPair), { repository, number: 163 });
  assert.equal(readFrontendPair('No paired PR'), null);
});

test('uses the exact open paired PR head SHA', async () => {
  const resolved = await resolveFrontendRef({
    eventName: 'pull_request',
    repositoryVariable: '',
    defaultRepository: repository,
    baseRef: 'staging',
    pullRequestBody: bodyWithPair,
    fetchPullRequest: fetchOpen,
  });
  assert.deepEqual(resolved, {
    repository,
    ref: 'a'.repeat(40),
    source: 'paired-pr-163-head',
  });
});

test('uses the target branch after the paired frontend PR merges', async () => {
  const resolved = await resolveFrontendRef({
    eventName: 'pull_request',
    repositoryVariable: '',
    defaultRepository: repository,
    baseRef: 'staging',
    pullRequestBody: bodyWithPair,
    fetchPullRequest: async () => ({
      state: 'closed',
      merged: true,
      base: { ref: 'staging', repo: { full_name: repository } },
    }),
  });
  assert.deepEqual(resolved, { repository, ref: 'staging', source: 'merged-pr-163-target' });
});

test('falls back to the frontend target branch when no pair is declared', async () => {
  const resolved = await resolveFrontendRef({
    eventName: 'pull_request',
    repositoryVariable: '',
    defaultRepository: repository,
    baseRef: 'staging',
    pullRequestBody: 'No pair',
    fetchPullRequest: async () => assert.fail('must not request GitHub without a pair'),
  });
  assert.deepEqual(resolved, { repository, ref: 'staging', source: 'target-base-fallback' });
});

test('fails closed for malformed, duplicate, wrong-base, wrong-repository, and closed-unmerged pairs', async () => {
  assert.throws(() => readFrontendPair('frontend-contract-pair: 163'), /malformed/);
  assert.throws(() => readFrontendPair(`${bodyWithPair}\n${bodyWithPair}`), /multiple/);

  const resolve = (fetchPullRequest) =>
    resolveFrontendRef({
      eventName: 'pull_request',
      repositoryVariable: '',
      defaultRepository: repository,
      baseRef: 'staging',
      pullRequestBody: bodyWithPair,
      fetchPullRequest,
    });

  await assert.rejects(
    resolve(async () => ({
      ...(await fetchOpen()),
      base: { ref: 'main', repo: { full_name: repository } },
    })),
    /targets main, expected staging/,
  );
  await assert.rejects(
    resolve(async () => ({
      ...(await fetchOpen()),
      base: { ref: 'staging', repo: { full_name: 'someone/else' } },
    })),
    /different repository/,
  );
  await assert.rejects(
    resolve(async () => ({
      state: 'closed',
      merged: false,
      base: { ref: 'staging', repo: { full_name: repository } },
    })),
    /closed without being merged/,
  );
  await assert.rejects(
    resolve(async () => ({
      state: 'open',
      merged: false,
      head: { sha: 'short' },
      base: { ref: 'staging', repo: { full_name: repository } },
    })),
    /no valid head SHA/,
  );
});

test('workflow dispatch uses its explicitly requested frontend ref', async () => {
  const resolved = await resolveFrontendRef({
    eventName: 'workflow_dispatch',
    dispatchRef: 'staging',
    repositoryVariable: '',
    defaultRepository: repository,
    fetchPullRequest: async () => assert.fail('dispatch must not request a PR'),
  });
  assert.deepEqual(resolved, { repository, ref: 'staging', source: 'workflow-dispatch' });
});

test('merge group resolves its target and supports configured ref', async () => {
  for (const [dispatchRef, expected] of [
    ['', 'staging'],
    ['custom-ref', 'custom-ref'],
  ]) {
    const result = await resolveFrontendRef({
      eventName: 'merge_group',
      dispatchRef,
      repositoryVariable: '',
      defaultRepository: repository,
      baseRef: 'staging',
      fetchPullRequest: async () => assert.fail('no PR lookup'),
    });
    assert.equal(result.ref, expected);
  }
});
