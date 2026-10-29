import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./m5-migration-dry-run.mjs', import.meta.url);

function makeFixture(lines) {
  const directory = mkdtempSync(join(tmpdir(), 'c1rcle-m5-dry-run-'));
  const input = join(directory, 'fixture.jsonl');
  const checkpoint = join(directory, 'checkpoint.json');
  const report = join(directory, 'report.json');
  writeFileSync(input, `${lines.join('\n')}\n`);
  return { directory, input, checkpoint, report };
}

function runFixture(fixture, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT.pathname,
      '--input',
      fixture.input,
      '--run-id',
      'test-run-1',
      '--checkpoint',
      fixture.checkpoint,
      '--report',
      fixture.report,
      '--batch-size',
      '2',
      ...extraArgs,
    ],
    { encoding: 'utf8' },
  );
  return { ...fixture, result };
}

describe('M5 migration dry-run inventory', () => {
  it('classifies legacy records, reports only counts and never prints record identifiers', (context) => {
    const fixture = makeFixture([
      JSON.stringify({
        source: 'v2_entitlements',
        id: 'private-ticket-1',
        data: { userId: 'private-user@example.test' },
      }),
      JSON.stringify({
        source: 'v2_entitlements',
        id: 'private-ticket-2',
        data: { currentHolderUserId: null, credentialVersion: 1, unitKind: 'paid' },
      }),
      JSON.stringify({
        source: 'v2_events',
        id: 'private-event-managed',
        data: {
          organizationId: 'org-managed',
          visibilityMode: 'code',
          imageUrl: 'https://storage.googleapis.com/c1rcle-test/posters/org-managed/poster.webp',
          privateImageStoragePath: 'posters/org-managed/poster.webp',
        },
      }),
      JSON.stringify({
        source: 'v2_events',
        id: 'private-event-foreign',
        data: {
          organizationId: 'org-foreign',
          visibilityMode: 'invited',
          imageUrl: 'https://storage.googleapis.com/c1rcle-test/posters/org-managed/poster.webp',
        },
      }),
      JSON.stringify({
        source: 'v2_events',
        id: 'private-event-mismatched-poster',
        data: {
          organizationId: 'org-mismatch',
          visibilityMode: 'code',
          imageUrl: 'https://storage.googleapis.com/c1rcle-test/posters/org-mismatch/public.webp',
          privateImageStoragePath: 'posters/org-mismatch/private.webp',
        },
      }),
      JSON.stringify({
        source: 'v2_event_cover_accounts',
        id: 'private-cover-1',
        data: {
          currency: 'INR',
          issuedPaise: 150000,
          remainingPaise: 150000,
          reservedPaise: 0,
          redeemedPaise: 0,
          refundedPaise: 0,
        },
      }),
      JSON.stringify({
        source: 'v2_financial_journals',
        id: 'private-journal-1',
        data: {
          lines: [
            { side: 'debit', amountPaise: 100 },
            { side: 'credit', amountPaise: 99 },
          ],
        },
      }),
      '{invalid json',
      JSON.stringify({ source: 'unrelated_collection', id: 'private-other-1', data: {} }),
    ]);
    const run = runFixture(fixture);
    context.after(() => rmSync(run.directory, { recursive: true, force: true }));

    assert.equal(run.result.status, 0, run.result.stderr);
    assert.doesNotMatch(run.result.stdout, /private-ticket|private-user@example\.test/);
    assert.deepEqual(JSON.parse(readFileSync(run.report, 'utf8')).summary, {
      recordsRead: 9,
      invalidRows: 1,
      ignoredCollections: 1,
      orders: 0,
      events: 3,
      privateEventsWithPosterUrl: 3,
      privateEventsWithPosterUrlMatchingOrganizationPath: 2,
      privateEventsWithUnrecognizedPosterUrl: 1,
      privateEventsWithPrivatePosterPath: 2,
      privatePosterPathsMatchingOrganization: 2,
      privatePosterPathsWithUnrecognizedOrganization: 0,
      privateEventsWithPosterPathMismatch: 1,
      entitlements: 2,
      entitlementsMissingHolderField: 1,
      entitlementsExplicitlyUnassigned: 1,
      entitlementsWithHolder: 0,
      entitlementsMissingCredentialVersion: 1,
      entitlementsMissingUnitKind: 1,
      coverAccounts: 1,
      coverAccountsWithInvalidBalance: 0,
      financialJournals: 1,
      unbalancedFinancialJournals: 1,
    });
  });

  it('resumes from a fingerprint-bound checkpoint without recounting prior lines', (context) => {
    const rowOne = JSON.stringify({
      source: 'v2_orders',
      id: 'order-private',
      data: { status: 'paid' },
    });
    const rowTwo = JSON.stringify({
      source: 'v2_orders',
      id: 'order-private-2',
      data: { status: 'paid' },
    });
    const fixture = makeFixture([rowOne, rowTwo]);
    const run = { ...fixture, result: null };
    context.after(() => rmSync(run.directory, { recursive: true, force: true }));
    const digest = createHash('sha256').update(`${rowOne}\n${rowTwo}\n`).digest('hex');
    writeFileSync(
      run.checkpoint,
      JSON.stringify({
        schemaVersion: 3,
        runId: 'test-run-1',
        inputSha256: digest,
        nextLine: 2,
        summary: {
          recordsRead: 1,
          invalidRows: 0,
          ignoredCollections: 0,
          orders: 1,
          events: 0,
          privateEventsWithPosterUrl: 0,
          privateEventsWithPosterUrlMatchingOrganizationPath: 0,
          privateEventsWithUnrecognizedPosterUrl: 0,
          privateEventsWithPrivatePosterPath: 0,
          privatePosterPathsMatchingOrganization: 0,
          privatePosterPathsWithUnrecognizedOrganization: 0,
          privateEventsWithPosterPathMismatch: 0,
          entitlements: 0,
          entitlementsMissingHolderField: 0,
          entitlementsExplicitlyUnassigned: 0,
          entitlementsWithHolder: 0,
          entitlementsMissingCredentialVersion: 0,
          entitlementsMissingUnitKind: 0,
          coverAccounts: 0,
          coverAccountsWithInvalidBalance: 0,
          financialJournals: 0,
          unbalancedFinancialJournals: 0,
        },
        complete: false,
      }),
    );

    run.result = runFixture(fixture, ['--resume']).result;

    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(JSON.parse(readFileSync(run.report, 'utf8')).summary.recordsRead, 2);
    assert.equal(JSON.parse(readFileSync(run.report, 'utf8')).summary.orders, 2);
    unlinkSync(run.report);
    run.result = runFixture(fixture, ['--resume']).result;
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(JSON.parse(readFileSync(run.report, 'utf8')).summary.recordsRead, 2);
  });

  it('refuses a resume checkpoint for a different input fingerprint', (context) => {
    const row = JSON.stringify({ source: 'v2_orders', id: 'order-private', data: {} });
    const fixture = makeFixture([row]);
    const run = { ...fixture, result: null };
    context.after(() => rmSync(run.directory, { recursive: true, force: true }));
    writeFileSync(run.checkpoint, JSON.stringify({ runId: 'test-run-1', inputSha256: 'wrong' }));
    run.result = runFixture(fixture, ['--resume']).result;

    assert.equal(run.result.status, 1);
    assert.match(run.result.stderr, /checkpoint_run_or_input_mismatch/);
  });
});
