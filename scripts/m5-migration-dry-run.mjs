#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ALLOWED_COLLECTIONS = new Set([
  'v2_orders',
  'v2_events',
  'v2_entitlements',
  'v2_event_cover_accounts',
  'v2_financial_journals',
]);
const BATCH_SIZE_DEFAULT = 500;

function usage() {
  return [
    'Read-only M5 migration inventory for a local JSONL export.',
    'Input rows: {"source":"v2_entitlements","id":"...","data":{...}}',
    'Required: --input FILE --run-id ID --checkpoint FILE --report FILE',
    'Optional: --batch-size N --resume',
    'This tool never connects to Firebase or writes to source records.',
  ].join('\n');
}

function parseArgs(argv) {
  const result = { resume: false, batchSize: BATCH_SIZE_DEFAULT };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') return { help: true };
    if (option === '--resume') {
      result.resume = true;
      continue;
    }
    if (!['--input', '--run-id', '--checkpoint', '--report', '--batch-size'].includes(option)) {
      throw new Error(`unknown_option:${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${option}`);
    index += 1;
    if (option === '--batch-size') result.batchSize = Number(value);
    else
      result[option.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] =
        value;
  }
  if (!result.input || !result.runId || !result.checkpoint || !result.report) {
    throw new Error('required_options_missing');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result.runId)) {
    throw new Error('invalid_run_id');
  }
  if (
    !Number.isSafeInteger(result.batchSize) ||
    result.batchSize < 1 ||
    result.batchSize > 10_000
  ) {
    throw new Error('invalid_batch_size');
  }
  return result;
}

function emptySummary() {
  return {
    recordsRead: 0,
    invalidRows: 0,
    ignoredCollections: 0,
    orders: 0,
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
  };
}

function classify(row, summary) {
  if (
    !row ||
    typeof row !== 'object' ||
    typeof row.source !== 'string' ||
    typeof row.id !== 'string' ||
    !row.data ||
    typeof row.data !== 'object' ||
    Array.isArray(row.data)
  ) {
    summary.invalidRows += 1;
    return;
  }
  if (!ALLOWED_COLLECTIONS.has(row.source)) {
    summary.ignoredCollections += 1;
    return;
  }
  const data = row.data;
  if (row.source === 'v2_orders') {
    summary.orders += 1;
  } else if (row.source === 'v2_events') {
    summary.events += 1;
    const privateEvent = data.visibilityMode === 'code' || data.visibilityMode === 'invited';
    if (privateEvent && typeof data.imageUrl === 'string' && data.imageUrl.length > 0) {
      summary.privateEventsWithPosterUrl += 1;
      if (hasExpectedOrganizationPosterPath(data.imageUrl, data.organizationId)) {
        summary.privateEventsWithPosterUrlMatchingOrganizationPath += 1;
      } else {
        summary.privateEventsWithUnrecognizedPosterUrl += 1;
      }
    }
    if (privateEvent && typeof data.privateImageStoragePath === 'string') {
      summary.privateEventsWithPrivatePosterPath += 1;
      if (hasExpectedOrganizationPosterKey(data.privateImageStoragePath, data.organizationId)) {
        summary.privatePosterPathsMatchingOrganization += 1;
      } else {
        summary.privatePosterPathsWithUnrecognizedOrganization += 1;
      }
      const publicPosterKey = expectedOrganizationPosterKey(data.imageUrl, data.organizationId);
      if (publicPosterKey !== null && publicPosterKey !== data.privateImageStoragePath) {
        summary.privateEventsWithPosterPathMismatch += 1;
      }
    }
  } else if (row.source === 'v2_entitlements') {
    summary.entitlements += 1;
    if (!Object.hasOwn(data, 'currentHolderUserId')) summary.entitlementsMissingHolderField += 1;
    else if (data.currentHolderUserId === null) summary.entitlementsExplicitlyUnassigned += 1;
    else summary.entitlementsWithHolder += 1;
    if (!Number.isSafeInteger(data.credentialVersion) || data.credentialVersion < 1) {
      summary.entitlementsMissingCredentialVersion += 1;
    }
    if (typeof data.unitKind !== 'string' || data.unitKind.length === 0) {
      summary.entitlementsMissingUnitKind += 1;
    }
  } else if (row.source === 'v2_event_cover_accounts') {
    summary.coverAccounts += 1;
    if (
      data.currency !== 'INR' ||
      !Number.isSafeInteger(data.issuedPaise) ||
      data.issuedPaise <= 0 ||
      !Number.isSafeInteger(data.remainingPaise) ||
      data.remainingPaise < 0 ||
      !Number.isSafeInteger(data.reservedPaise) ||
      data.reservedPaise < 0 ||
      !Number.isSafeInteger(data.redeemedPaise) ||
      data.redeemedPaise < 0 ||
      !Number.isSafeInteger(data.refundedPaise) ||
      data.refundedPaise < 0 ||
      data.remainingPaise + data.reservedPaise + data.redeemedPaise + data.refundedPaise !==
        data.issuedPaise
    )
      summary.coverAccountsWithInvalidBalance += 1;
  } else {
    summary.financialJournals += 1;
    const lines = Array.isArray(data.lines) ? data.lines : [];
    let debits = 0;
    let credits = 0;
    for (const line of lines) {
      if (!Number.isSafeInteger(line?.amountPaise) || line.amountPaise < 0) {
        summary.unbalancedFinancialJournals += 1;
        return;
      }
      if (line.side === 'debit') debits += line.amountPaise;
      else if (line.side === 'credit') credits += line.amountPaise;
      else {
        summary.unbalancedFinancialJournals += 1;
        return;
      }
      if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
        summary.unbalancedFinancialJournals += 1;
        return;
      }
    }
    if (lines.length < 2 || debits !== credits) summary.unbalancedFinancialJournals += 1;
  }
}

function expectedOrganizationPosterKey(value, organizationId) {
  if (
    typeof value !== 'string' ||
    typeof organizationId !== 'string' ||
    organizationId.length === 0
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'storage.googleapis.com' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    const segments = url.pathname
      .split('/')
      .slice(1)
      .map((segment) => decodeURIComponent(segment));
    const isManagedOrganizationPoster =
      segments.length >= 4 &&
      segments[0] !== '' &&
      segments[1] === 'posters' &&
      segments[2] === organizationId &&
      segments.slice(3).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
    return isManagedOrganizationPoster ? segments.slice(1).join('/') : null;
  } catch {
    return null;
  }
}

function hasExpectedOrganizationPosterPath(value, organizationId) {
  return expectedOrganizationPosterKey(value, organizationId) !== null;
}

function hasExpectedOrganizationPosterKey(value, organizationId) {
  if (typeof value !== 'string' || typeof organizationId !== 'string') return false;
  const parts = value.split('/');
  return (
    parts.length === 3 &&
    parts[0] === 'posters' &&
    parts[1] === organizationId &&
    /^[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/.test(parts[2] ?? '')
  );
}

async function fingerprint(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function atomicWrite(path, value) {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, path);
}

async function execute(options) {
  const inputPath = resolve(options.input);
  const checkpointPath = resolve(options.checkpoint);
  const reportPath = resolve(options.report);
  if (new Set([inputPath, checkpointPath, reportPath]).size !== 3) {
    throw new Error('input_checkpoint_report_paths_must_be_distinct');
  }
  const inputFingerprint = await fingerprint(inputPath);
  let checkpoint;
  if (options.resume) {
    checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    if (checkpoint.runId !== options.runId || checkpoint.inputSha256 !== inputFingerprint) {
      throw new Error('checkpoint_run_or_input_mismatch');
    }
    if (
      checkpoint.schemaVersion !== 3 ||
      !Number.isSafeInteger(checkpoint.nextLine) ||
      checkpoint.nextLine < 1 ||
      !checkpoint.summary ||
      Object.keys(emptySummary()).some(
        (key) => !Number.isSafeInteger(checkpoint.summary[key]) || checkpoint.summary[key] < 0,
      )
    )
      throw new Error('checkpoint_shape_invalid');
  } else {
    try {
      await fs.access(checkpointPath);
      throw new Error('checkpoint_exists_use_resume');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.access(reportPath);
      throw new Error('report_exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    checkpoint = {
      schemaVersion: 3,
      runId: options.runId,
      inputSha256: inputFingerprint,
      nextLine: 1,
      summary: emptySummary(),
      complete: false,
    };
  }

  if (!checkpoint.complete) {
    let lineNumber = 0;
    let linesSinceCheckpoint = 0;
    const input = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
    for await (const line of input) {
      lineNumber += 1;
      if (lineNumber < checkpoint.nextLine) continue;
      checkpoint.summary.recordsRead += 1;
      try {
        classify(JSON.parse(line), checkpoint.summary);
      } catch {
        checkpoint.summary.invalidRows += 1;
      }
      checkpoint.nextLine = lineNumber + 1;
      linesSinceCheckpoint += 1;
      if (linesSinceCheckpoint >= options.batchSize) {
        await atomicWrite(checkpointPath, checkpoint);
        linesSinceCheckpoint = 0;
      }
    }
    checkpoint.complete = true;
    checkpoint.completedAt = new Date().toISOString();
    await atomicWrite(checkpointPath, checkpoint);
  }
  const report = {
    schemaVersion: 3,
    runId: checkpoint.runId,
    inputSha256: checkpoint.inputSha256,
    completedAt: checkpoint.completedAt,
    readOnly: true,
    summary: checkpoint.summary,
    notes: [
      'This inventory does not mutate source rows or infer missing ownership, cover balances, or policy approval.',
      'Counts are not a migration authorization or proof of complete cross-collection reconciliation.',
    ],
  };
  await atomicWrite(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${usage()}\n`);
  else await execute(options);
} catch (error) {
  const code = error instanceof Error ? error.message : 'unknown_error';
  process.stderr.write(`M5 dry-run stopped: ${code}\n${usage()}\n`);
  process.exitCode = 1;
}
