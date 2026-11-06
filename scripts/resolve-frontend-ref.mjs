import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PAIR_MARKER =
  /<!--\s*frontend-contract-pair:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\s*-->/gi;

export function readFrontendPair(body) {
  const matches = [...String(body ?? '').matchAll(PAIR_MARKER)];
  if (matches.length > 1) throw new Error('Backend PR declares multiple frontend contract pairs.');
  if (matches.length === 0) {
    if (/frontend-contract-pair/i.test(String(body ?? ''))) {
      throw new Error('Backend PR frontend contract pair marker is malformed.');
    }
    return null;
  }

  return { repository: matches[0][1], number: Number(matches[0][2]) };
}

export async function resolveFrontendRef({
  eventName,
  dispatchRef,
  repositoryVariable,
  defaultRepository,
  baseRef,
  pullRequestBody,
  fetchPullRequest,
}) {
  const repository = repositoryVariable || defaultRepository;
  if (eventName === 'workflow_dispatch') {
    const ref = dispatchRef || baseRef;
    if (!ref) throw new Error('workflow_dispatch requires a frontend ref.');
    return { repository, ref, source: 'workflow-dispatch' };
  }

  if (eventName === 'merge_group') {
    if (!baseRef) throw new Error('Merge group requires a target base ref.');
    return { repository, ref: dispatchRef || baseRef, source: 'merge-group-target' };
  }

  if (eventName !== 'pull_request') {
    throw new Error(`Unsupported contract parity event: ${eventName}`);
  }

  const pair = readFrontendPair(pullRequestBody);
  if (!pair) return { repository, ref: dispatchRef || baseRef, source: 'target-base-fallback' };
  if (pair.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`Declared frontend pair must target ${repository}.`);
  }

  const pairedPr = await fetchPullRequest(repository, pair.number);
  if (pairedPr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Declared frontend contract PR belongs to a different repository.');
  }
  if (pairedPr.base?.ref !== baseRef) {
    throw new Error(
      `Frontend PR #${pair.number} targets ${pairedPr.base?.ref}, expected ${baseRef}.`,
    );
  }

  if (pairedPr.state === 'open' && pairedPr.merged !== true) {
    if (!/^[a-f0-9]{40}$/i.test(pairedPr.head?.sha ?? '')) {
      throw new Error(`Frontend PR #${pair.number} has no valid head SHA.`);
    }
    return {
      repository,
      ref: pairedPr.head.sha,
      source: `paired-pr-${pair.number}-head`,
    };
  }

  if (pairedPr.state === 'closed' && pairedPr.merged === true) {
    return { repository, ref: baseRef, source: `merged-pr-${pair.number}-target` };
  }

  throw new Error(`Frontend PR #${pair.number} is closed without being merged.`);
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repositoryVariable = process.env.FRONTEND_REPO || '';
  const defaultRepository = 'thec1rclehost123-cmd/C1RCLE-FRONTEND';
  const apiToken = process.env.FRONTEND_REPO_TOKEN;
  const result = await resolveFrontendRef({
    eventName: process.env.GITHUB_EVENT_NAME,
    dispatchRef: process.env.FRONTEND_REF_INPUT,
    repositoryVariable,
    defaultRepository,
    baseRef:
      event.pull_request?.base?.ref ??
      event.merge_group?.base_ref?.replace(/^refs\/heads\//, '') ??
      '',
    pullRequestBody: event.pull_request?.body ?? '',
    fetchPullRequest: async (repository, number) => {
      if (!apiToken)
        throw new Error('FRONTEND_REPO_TOKEN is required to resolve a paired private frontend PR.');
      const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${apiToken}`,
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok)
        throw new Error(`Could not read paired frontend PR #${number} (HTTP ${response.status}).`);
      return response.json();
    },
  });

  if (!result.ref) throw new Error('Could not resolve a frontend contract ref.');
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `frontend_ref=${result.ref}\nsource=${result.source}\n`,
  );
  console.log(`Frontend contract source: ${result.source}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Frontend contract ref resolution failed.',
    );
    process.exitCode = 1;
  });
}
