#!/usr/bin/env node
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_DIR = path.join(ROOT, 'docs/ai/checkpoints/local');
const AUTHORITY_FILES = {
  fixtures: path.join(ROOT, 'docs/ai/STAGING_FIXTURES.json'),
  findings: path.join(ROOT, 'docs/ai/FINDINGS.json'),
  acceptance: path.join(ROOT, 'docs/ai/ACCEPTANCE_STATE.json'),
};
const WORKFLOWS = new Set([
  'hosted-audit',
  'targeted-reacceptance',
  'cross-role-acceptance',
  'bounded-remediation',
  'milestone-implementation',
  'pr-release-packaging',
]);
const STATUSES = new Set(['ACTIVE', 'WAITING_FOR_OWNER', 'BLOCKED', 'COMPLETED', 'ABANDONED']);
const RESUMABLE = new Set(['ACTIVE', 'WAITING_FOR_OWNER', 'BLOCKED']);
const PROVIDER_STATES = new Set([
  'NONE',
  'WAITING_FOR_OWNER',
  'OWNER_COMPLETED_ACTION',
  'PROVIDER_RESULT_NEEDS_RECONCILIATION',
]);
const SESSION_STATES = new Set(['SESSION_MAY_STILL_EXIST', 'SESSION_MUST_BE_RECREATED', 'UNKNOWN']);
const SECRET_KEY =
  /password|passcode|one[_ -]?time[_ -]?code|\botp\b|cookie|authorization|bearer|bypass|api[_-]?key|secret|\btoken\b|card(?:[_ -]?(?:number|data))?|\bcvv\b|\bcvc\b|session[_-]?(?:storage|token)|refresh[_-]?token|access[_-]?token|private[_-]?key/i;
const SECRET_VALUE =
  /(?:\bbearer\s+\S{12,}|x-vercel-protection-bypass\s*[:=]\s*\S+|(?:password|passcode|otp|authorization|api[_-]?key|secret|cookie|bypass(?:[_ -]?token)?|token|card[_ -]?number|cvv|cvc)\s*[:=]\s*["']?\S{4,}|\brzp_(?:live|test)_[A-Za-z0-9]+|[?&](?:token|secret|api[_-]?key|password|bypass)=)/i;
const SHA = /^(UNKNOWN|[a-f0-9]{40})$/i;
const ID = /^cp-[a-z0-9][a-z0-9-]{2,78}$/;
const RESULT_VALUES = new Set([
  'PASS',
  'FAIL',
  'PARTIAL',
  'BLOCKED',
  'UNTESTED',
  'DEFERRED',
  'NOT_YET_RUN',
]);
const STORAGE_OBJECT_FIELDS = new Set([
  'schema_version',
  'checkpoint_id',
  'status',
  'workflow',
  'task',
  'created_at',
  'updated_at',
  'environment',
  'frontend_sha',
  'backend_sha',
  'revision_provenance',
  'roles',
  'credential_refs',
  'fixture_ids',
  'object_ids',
  'mutations',
  'completed_steps',
  'acceptance_results',
  'finding_ids',
  'blocked_items',
  'provider_state',
  'human_action_pending',
  'browser_position',
  'session_state',
  'next_action',
  'resume_verification',
  'notes',
]);
const MUTABLE_FIELDS = new Set([
  'environment',
  'frontend_sha',
  'backend_sha',
  'revision_provenance',
  'human_action_pending',
  'browser_position',
  'session_state',
  'next_action',
  'provider_state',
  'status',
]);
const ISO_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function authorityData(overrides = {}) {
  if (overrides.authority) return overrides.authority;
  const [fixtures, findings, acceptance] = await Promise.all([
    readJson(AUTHORITY_FILES.fixtures),
    readJson(AUTHORITY_FILES.findings),
    readJson(AUTHORITY_FILES.acceptance),
  ]);
  return { fixtures, findings, acceptance };
}

export function knownFixtureIds(fixtures) {
  return new Set(
    [...(fixtures.fixtures ?? []), ...(fixtures.requirements ?? [])].map((item) => item.id),
  );
}

export function knownFindingIds(findings) {
  return new Set((findings.findings ?? []).map((item) => item.id));
}

export function knownAcceptanceIds(acceptance) {
  return new Set(
    Object.values(acceptance).flatMap((value) =>
      Array.isArray(value) ? value.map((item) => item?.id).filter(Boolean) : [],
    ),
  );
}

function wordCount(value) {
  return JSON.stringify(value).match(/\S+/g)?.length ?? 0;
}

function scanForSecrets(value, keyPath = '$', errors = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${keyPath}[${index}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key))
        errors.push(`${keyPath}.${key}: secret/session fields are forbidden`);
      scanForSecrets(item, `${keyPath}.${key}`, errors);
    }
  } else if (typeof value === 'string' && SECRET_VALUE.test(value)) {
    errors.push(`${keyPath}: secret-like value is forbidden`);
  }
  return errors;
}

function exactKeys(value, keys, label, errors, requiredKeys = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value))
    if (!keys.has(key)) errors.push(`${label}.${key}: unknown field`);
  for (const key of requiredKeys)
    if (!(key in value)) errors.push(`${label}.${key}: required field missing`);
  return true;
}

function isBoundedString(value, max, allowEmpty = false) {
  return (
    typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0)
  );
}

export function validateCheckpoint(checkpoint, authority) {
  const errors = scanForSecrets(checkpoint);
  const topKeys = STORAGE_OBJECT_FIELDS;
  if (!exactKeys(checkpoint, topKeys, 'checkpoint', errors)) return errors;
  if (checkpoint.schema_version !== 1) errors.push('schema_version must be 1');
  if (typeof checkpoint.checkpoint_id !== 'string' || !ID.test(checkpoint.checkpoint_id))
    errors.push('checkpoint_id is invalid');
  if (!STATUSES.has(checkpoint.status)) errors.push('status is invalid');
  if (!WORKFLOWS.has(checkpoint.workflow))
    errors.push('workflow is not one of the Step 9 workflow names');
  if (!isBoundedString(checkpoint.task, 300)) errors.push('task must be 1–300 characters');
  for (const field of ['created_at', 'updated_at']) {
    if (
      typeof checkpoint[field] !== 'string' ||
      !ISO_DATE.test(checkpoint[field]) ||
      Number.isNaN(Date.parse(checkpoint[field]))
    )
      errors.push(`${field} must be an ISO timestamp`);
  }
  if (!isBoundedString(checkpoint.environment, 100, true)) errors.push('environment is invalid');
  for (const field of ['frontend_sha', 'backend_sha'])
    if (typeof checkpoint[field] !== 'string' || !SHA.test(checkpoint[field]))
      errors.push(`${field} must be a full SHA or UNKNOWN`);
  if (!isBoundedString(checkpoint.revision_provenance, 300, true))
    errors.push('revision_provenance is too long');
  if (!Array.isArray(checkpoint.roles) || checkpoint.roles.length > 20)
    errors.push('roles must be an array of at most 20 labels');
  else
    checkpoint.roles.forEach((role, i) => {
      const label = `roles[${i}]`;
      if (exactKeys(role, new Set(['role', 'account_label']), label, errors)) {
        if (!isBoundedString(role.role, 60) || !isBoundedString(role.account_label, 100))
          errors.push(`${label} contains an invalid label`);
      }
    });
  if (!Array.isArray(checkpoint.credential_refs) || checkpoint.credential_refs.length > 20)
    errors.push('credential_refs must be an array of at most 20 labels');
  else {
    if (new Set(checkpoint.credential_refs).size !== checkpoint.credential_refs.length)
      errors.push('credential_refs contains duplicates');
    for (const ref of checkpoint.credential_refs)
      if (typeof ref !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(ref))
        errors.push('credential_refs may contain labels only');
  }
  if (!Array.isArray(checkpoint.fixture_ids) || checkpoint.fixture_ids.length > 30)
    errors.push('fixture_ids must be an array of at most 30 IDs');
  else {
    if (new Set(checkpoint.fixture_ids).size !== checkpoint.fixture_ids.length)
      errors.push('fixture_ids contains duplicates');
    const ids = knownFixtureIds(authority.fixtures);
    for (const id of checkpoint.fixture_ids)
      if (!ids.has(id)) errors.push(`unknown fixture/requirement ID: ${id}`);
  }
  if (!Array.isArray(checkpoint.object_ids) || checkpoint.object_ids.length > 60)
    errors.push('object_ids must be an array of at most 60 entries');
  else
    checkpoint.object_ids.forEach((object, i) => {
      const label = `object_ids[${i}]`;
      if (
        exactKeys(object, new Set(['type', 'id', 'label']), label, errors, new Set(['type', 'id']))
      ) {
        if (
          !isBoundedString(object.type, 60) ||
          !isBoundedString(object.id, 160) ||
          ('label' in object && !isBoundedString(object.label, 100, true))
        )
          errors.push(`${label} contains an invalid value`);
      }
    });
  if (!Array.isArray(checkpoint.mutations) || checkpoint.mutations.length > 60)
    errors.push('mutations must be an array of at most 60 entries');
  else
    checkpoint.mutations.forEach((mutation, i) => {
      const label = `mutations[${i}]`;
      if (
        exactKeys(
          mutation,
          new Set([
            'object_type',
            'object_id',
            'action',
            'observed_result',
            'reversible',
            'reset_required',
          ]),
          label,
          errors,
        )
      ) {
        if (
          !isBoundedString(mutation.object_type, 60) ||
          !isBoundedString(mutation.object_id, 160) ||
          !isBoundedString(mutation.action, 160) ||
          !isBoundedString(mutation.observed_result, 240)
        )
          errors.push(`${label} contains an invalid value`);
        if (![true, false, 'UNKNOWN'].includes(mutation.reversible))
          errors.push(`${label}.reversible is invalid`);
        if (![true, false, 'UNKNOWN'].includes(mutation.reset_required))
          errors.push(`${label}.reset_required is invalid`);
      }
    });
  for (const field of ['completed_steps', 'blocked_items', 'resume_verification', 'notes']) {
    const max = field === 'resume_verification' ? 12 : field === 'notes' ? 12 : 60;
    const strMax =
      field === 'blocked_items' || field === 'resume_verification' || field === 'notes' ? 240 : 240;
    if (
      !Array.isArray(checkpoint[field]) ||
      checkpoint[field].length > max ||
      checkpoint[field].some((value) => !isBoundedString(value, strMax, field === 'notes'))
    )
      errors.push(`${field} must be a bounded string array`);
  }
  if (!Array.isArray(checkpoint.acceptance_results) || checkpoint.acceptance_results.length > 60)
    errors.push('acceptance_results must be an array of at most 60 entries');
  else {
    const acceptanceIds = knownAcceptanceIds(authority.acceptance);
    checkpoint.acceptance_results.forEach((item, i) => {
      const label = `acceptance_results[${i}]`;
      if (
        exactKeys(
          item,
          new Set(['item_id', 'result', 'source', 'note']),
          label,
          errors,
          new Set(['item_id', 'result', 'source']),
        )
      ) {
        if (!acceptanceIds.has(item.item_id)) errors.push(`${label}.item_id is unknown`);
        if (!RESULT_VALUES.has(item.result)) errors.push(`${label}.result is invalid`);
        if (!['NEW', 'REUSED'].includes(item.source))
          errors.push(`${label}.source must be NEW or REUSED`);
        if ('note' in item && !isBoundedString(item.note, 240, true))
          errors.push(`${label}.note is too long`);
      }
    });
  }
  if (!Array.isArray(checkpoint.finding_ids) || checkpoint.finding_ids.length > 40)
    errors.push('finding_ids must be an array of at most 40 IDs');
  else {
    if (new Set(checkpoint.finding_ids).size !== checkpoint.finding_ids.length)
      errors.push('finding_ids contains duplicates');
    const ids = knownFindingIds(authority.findings);
    for (const id of checkpoint.finding_ids)
      if (!ids.has(id)) errors.push(`unknown finding ID: ${id}`);
  }
  if (!PROVIDER_STATES.has(checkpoint.provider_state)) errors.push('provider_state is invalid');
  if (
    checkpoint.human_action_pending !== null &&
    !isBoundedString(checkpoint.human_action_pending, 300)
  )
    errors.push('human_action_pending is invalid');
  if (!isBoundedString(checkpoint.browser_position, 400, true))
    errors.push('browser_position is too long');
  if (!SESSION_STATES.has(checkpoint.session_state)) errors.push('session_state is invalid');
  if (!isBoundedString(checkpoint.next_action, 500, !RESUMABLE.has(checkpoint.status)))
    errors.push('next_action is required for resumable statuses and limited to 500 characters');
  if (wordCount(checkpoint) > 800) errors.push('checkpoint exceeds the 800-word operational limit');
  return errors;
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 54) || 'task'
  );
}

function defaultResumeVerification() {
  return [
    'Confirm this is the approved environment and use Step 10 prepare/fixture commands for current target, liveness, revision and fixture state.',
    'Compare live deployed revisions with this checkpoint; if changed or unknown, consult CHANGE_IMPACT.json and retest only affected claims before continuing.',
    'Reacquire the same fixture and object IDs read-only; confirm their current state and check for newer findings/evidence.',
    'Never assume the prior browser session or cookies remain valid; verify authentication, then recreate the session if needed.',
    'Verify owner/provider handoff state. Do not repeat a payment or other provider action; reconcile the same object after owner completion.',
  ];
}

export function createCheckpoint(options, now = new Date()) {
  const iso = now.toISOString();
  const checkpointId =
    options.checkpoint_id ??
    `cp-${iso.slice(0, 10).replaceAll('-', '')}-${slug(`${options.workflow}-${options.task}`)}`;
  return {
    schema_version: 1,
    checkpoint_id: checkpointId,
    status: 'ACTIVE',
    workflow: options.workflow,
    task: options.task,
    created_at: iso,
    updated_at: iso,
    environment: options.environment ?? 'UNKNOWN',
    frontend_sha: options.frontend_sha ?? 'UNKNOWN',
    backend_sha: options.backend_sha ?? 'UNKNOWN',
    revision_provenance:
      options.revision_provenance ??
      'UNKNOWN; verify with Step 10 before revision-specific continuation.',
    roles: options.roles ?? [],
    credential_refs: options.credential_refs ?? [],
    fixture_ids: options.fixture_ids ?? [],
    object_ids: [],
    mutations: [],
    completed_steps: [],
    acceptance_results: [],
    finding_ids: options.finding_ids ?? [],
    blocked_items: [],
    provider_state: options.provider_state ?? 'NONE',
    human_action_pending: options.human_action_pending ?? null,
    browser_position: options.browser_position ?? 'Not started',
    session_state: options.session_state ?? 'UNKNOWN',
    next_action: options.next_action,
    resume_verification: defaultResumeVerification(),
    notes: [],
  };
}

function assertSafeId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid checkpoint ID');
}

function checkpointPath(id, storageDir) {
  assertSafeId(id);
  return path.join(storageDir, `${id}.json`);
}

async function readCheckpoint(id, storageDir) {
  return readJson(checkpointPath(id, storageDir));
}

async function writeCheckpoint(checkpoint, storageDir) {
  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  await chmod(storageDir, 0o700);
  const file = checkpointPath(checkpoint.checkpoint_id, storageDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function listCheckpoints(storageDir) {
  let files = [];
  try {
    files = await readdir(storageDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    assertSafeId(id);
    records.push(await readCheckpoint(id, storageDir));
  }
  return records;
}

function checkValid(checkpoint, authority) {
  const errors = validateCheckpoint(checkpoint, authority);
  if (errors.length) throw new Error(`checkpoint validation failed: ${errors.join('; ')}`);
}

function humanShow(checkpoint) {
  return [
    `CHECKPOINT: ${checkpoint.checkpoint_id} — ${checkpoint.status}`,
    `WORKFLOW: ${checkpoint.workflow}`,
    `TASK: ${checkpoint.task}`,
    `ENVIRONMENT: ${checkpoint.environment}`,
    `REVISIONS: frontend=${checkpoint.frontend_sha}; backend=${checkpoint.backend_sha}`,
    `ROLES: ${checkpoint.roles.map((x) => `${x.role}=${x.account_label}`).join('; ') || 'none'}`,
    `FIXTURES: ${checkpoint.fixture_ids.join(', ') || 'none'}`,
    `OBJECTS: ${checkpoint.object_ids.map((x) => `${x.type}=${x.id}`).join('; ') || 'none'}`,
    `MUTATIONS: ${checkpoint.mutations.length}`,
    `COMPLETED: ${checkpoint.completed_steps.join('; ') || 'none'}`,
    `FINDINGS: ${checkpoint.finding_ids.join(', ') || 'none'}`,
    `PROVIDER: ${checkpoint.provider_state}${checkpoint.human_action_pending ? ` — ${checkpoint.human_action_pending}` : ''}`,
    `BROWSER: ${checkpoint.browser_position || 'unknown'}`,
    `SESSION: ${checkpoint.session_state}`,
    `NEXT: ${checkpoint.next_action || 'none; checkpoint is terminal'}`,
  ].join('\n');
}

function surfaceKeys(checkpoint) {
  const map = new Map([
    ['guest', 'guest'],
    ['host', 'host'],
    ['venue', 'venue'],
    ['partner', 'partner'],
    ['promoter', 'promoter'],
    ['scanner', 'scanner'],
    ['admin', 'admin'],
  ]);
  const keys = [
    ...new Set(checkpoint.roles.map((role) => map.get(role.role.toLowerCase())).filter(Boolean)),
  ];
  return keys;
}

export function buildResumePacket(checkpoint) {
  if (!RESUMABLE.has(checkpoint.status))
    throw new Error(`checkpoint ${checkpoint.status.toLowerCase()} is not resumable`);
  const step10Commands = surfaceKeys(checkpoint).map(
    (surface) => `pnpm acceptance:prepare -- prepare ${surface} --json`,
  );
  for (const fixture of checkpoint.fixture_ids)
    step10Commands.push(`pnpm acceptance:prepare -- fixture ${fixture}`);
  return {
    checkpoint_id: checkpoint.checkpoint_id,
    status: checkpoint.status,
    workflow: checkpoint.workflow,
    task: checkpoint.task,
    environment: checkpoint.environment,
    deployed_revisions: {
      frontend: checkpoint.frontend_sha,
      backend: checkpoint.backend_sha,
      provenance: checkpoint.revision_provenance,
    },
    roles: checkpoint.roles,
    credential_refs: checkpoint.credential_refs,
    fixture_ids: checkpoint.fixture_ids,
    object_ids: checkpoint.object_ids,
    mutations: checkpoint.mutations,
    completed_steps: checkpoint.completed_steps,
    acceptance_results: checkpoint.acceptance_results,
    finding_ids: checkpoint.finding_ids,
    blocked_items: checkpoint.blocked_items,
    provider_state: checkpoint.provider_state,
    human_action_pending: checkpoint.human_action_pending,
    browser_position: checkpoint.browser_position,
    session_state: checkpoint.session_state,
    verify_before_resume: checkpoint.resume_verification,
    missing_fixture_rule:
      'If a requirement is not provisioned/bound, do not search staging randomly. Consult STAGING_FIXTURES.json requirements and wait for authorized provisioning/binding.',
    step10_read_only_commands: step10Commands,
    next_action: checkpoint.next_action,
    authority_note:
      'Temporary operational state only. Permanent acceptance and findings remain in their ledgers; do not replay completed actions.',
  };
}

function textResume(packet) {
  const lines = [
    `WORKFLOW: ${packet.workflow}`,
    `TASK: ${packet.task}`,
    `CHECKPOINT: ${packet.checkpoint_id} — ${packet.status}`,
    `ENVIRONMENT: ${packet.environment}`,
    `DEPLOYED REVISIONS (recorded): frontend=${packet.deployed_revisions.frontend}; backend=${packet.deployed_revisions.backend}`,
    `ROLES: ${packet.roles.map((x) => `${x.role}=${x.account_label}`).join('; ') || 'none'}`,
    `CREDENTIAL REFS: ${packet.credential_refs.join(', ') || 'none'}`,
    `FIXTURES: ${packet.fixture_ids.join(', ') || 'none'}`,
    `OBJECTS: ${packet.object_ids.map((x) => `${x.type}=${x.id}`).join('; ') || 'none'}`,
    `MUTATIONS: ${packet.mutations.map((x) => `${x.action} ${x.object_type}=${x.object_id}: ${x.observed_result}; reversible=${x.reversible}; reset=${x.reset_required}`).join(' | ') || 'none'}`,
    `COMPLETED: ${packet.completed_steps.join('; ') || 'none'}`,
    `ACCEPTANCE: ${packet.acceptance_results.map((x) => `${x.item_id}=${x.result} (${x.source}${x.note ? `; ${x.note}` : ''})`).join('; ') || 'none'}`,
    `FINDINGS: ${packet.finding_ids.join(', ') || 'none'}`,
    `BLOCKERS: ${packet.blocked_items.join('; ') || 'none'}`,
    `PROVIDER/HUMAN: ${packet.provider_state}${packet.human_action_pending ? ` — ${packet.human_action_pending}` : ''}`,
    `BROWSER POSITION: ${packet.browser_position || 'unknown'}`,
    `SESSION STATE: ${packet.session_state}; never assume the old browser session is still valid.`,
    'VERIFY BEFORE RESUME:',
    ...packet.verify_before_resume.map((item) => `- ${item}`),
    `MISSING FIXTURE RULE: ${packet.missing_fixture_rule}`,
    ...(packet.step10_read_only_commands.length
      ? [
          'STEP 10 READ-ONLY COMMANDS:',
          ...packet.step10_read_only_commands.map((item) => `- ${item}`),
        ]
      : []),
    `NEXT ACTION: ${packet.next_action}`,
    packet.authority_note,
  ];
  return lines.join('\n');
}

function parseFlags(args, repeated = new Set()) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith('--') || i + 1 >= args.length || args[i + 1].startsWith('--'))
      throw new Error('expected --option value pairs');
    const name = key.slice(2).replaceAll('-', '_');
    const value = args[++i];
    if (values.has(name) && !repeated.has(name)) throw new Error(`duplicate option: ${name}`);
    if (repeated.has(name)) values.set(name, [...(values.get(name) ?? []), value]);
    else values.set(name, value);
  }
  return values;
}

function allowFlags(flags, allowed) {
  for (const name of flags.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option: ${name.replaceAll('_', '-')}`);
  }
}

function required(flags, name) {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`--${name.replaceAll('_', '-')} is required`);
  return value;
}

function parseTriState(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value?.toUpperCase() === 'UNKNOWN') return 'UNKNOWN';
  throw new Error(`${label} must be true, false or UNKNOWN`);
}

function appendUnique(array, value) {
  if (!array.includes(value)) array.push(value);
}

function addObject(checkpoint, object) {
  const existing = checkpoint.object_ids.find(
    (entry) => entry.type === object.type && entry.id === object.id,
  );
  if (!existing) checkpoint.object_ids.push(object);
  else if (object.label && !existing.label) existing.label = object.label;
}

function parseRole(value) {
  const split = value.indexOf('=');
  if (split < 1 || !value.slice(split + 1).trim())
    throw new Error('role must be Role=account-label');
  return { role: value.slice(0, split).trim(), account_label: value.slice(split + 1).trim() };
}

async function validateAndSave(checkpoint, authority, storageDir, now = new Date()) {
  checkpoint.updated_at = now.toISOString();
  checkValid(checkpoint, authority);
  await writeCheckpoint(checkpoint, storageDir);
  return checkpoint;
}

function makeUsage() {
  return [
    'Usage: pnpm acceptance:checkpoint -- <command> ...',
    '  create --workflow <Step9-name> --task <text> --next-action <text> [--role Role=Label] [--credential-ref LABEL] [--fixture ID]',
    '  list | show <id> | validate <id> | resume <id> [--json] | export <id> [--json]',
    '  record <id> <step|object|mutation|result|finding|fixture|credential|role> --... ',
    '  set <id> <field> <value> | block <id> --reason <text> --next-action <text>',
    '  wait-owner <id> --action <text> --next-action <text> | owner-done <id> --next-action <text>',
    '  complete <id> | abandon <id>',
  ].join('\n');
}

export async function execute(argv, dependencies = {}) {
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--');
  const command = args.shift();
  if (!command || command === 'help' || command === '--help')
    return { code: 0, output: makeUsage() };
  const storageDir = dependencies.storageDir ?? LOCAL_DIR;
  const authority = await authorityData(dependencies);
  const now = dependencies.now ?? new Date();
  let value;
  let output;

  if (command === 'create') {
    const flags = parseFlags(args, new Set(['role', 'credential_ref', 'fixture', 'finding_id']));
    allowFlags(
      flags,
      new Set([
        'workflow',
        'task',
        'next_action',
        'id',
        'environment',
        'frontend_sha',
        'backend_sha',
        'revision_provenance',
        'role',
        'credential_ref',
        'fixture',
        'finding_id',
        'provider_state',
        'human_action_pending',
        'browser_position',
        'session_state',
      ]),
    );
    const workflow = required(flags, 'workflow');
    const task = required(flags, 'task');
    const nextAction = required(flags, 'next_action');
    if (!WORKFLOWS.has(workflow)) throw new Error('workflow must match a Step 9 workflow name');
    const all = await listCheckpoints(storageDir);
    const existing = all.find(
      (checkpoint) =>
        checkpoint.workflow === workflow &&
        checkpoint.task === task &&
        RESUMABLE.has(checkpoint.status),
    );
    if (existing)
      throw new Error(
        `an active checkpoint already exists for this workflow/task: ${existing.checkpoint_id}`,
      );
    let id =
      flags.get('id') ??
      `cp-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${slug(`${workflow}-${task}`)}`;
    assertSafeId(id);
    let suffix = 2;
    while (all.some((checkpoint) => checkpoint.checkpoint_id === id)) {
      const base = flags.get('id');
      if (base) throw new Error('checkpoint ID already exists');
      id = `${id.slice(0, 74)}-${suffix++}`;
    }
    const checkpoint = createCheckpoint(
      {
        checkpoint_id: id,
        workflow,
        task,
        environment: flags.get('environment'),
        frontend_sha: flags.get('frontend_sha'),
        backend_sha: flags.get('backend_sha'),
        revision_provenance: flags.get('revision_provenance'),
        roles: (flags.get('role') ?? []).map(parseRole),
        credential_refs: flags.get('credential_ref') ?? [],
        fixture_ids: flags.get('fixture') ?? [],
        finding_ids: flags.get('finding_id') ?? [],
        provider_state: flags.get('provider_state'),
        human_action_pending: flags.get('human_action_pending'),
        browser_position: flags.get('browser_position'),
        session_state: flags.get('session_state'),
        next_action: nextAction,
      },
      now,
    );
    await validateAndSave(checkpoint, authority, storageDir, now);
    value = checkpoint;
    output = `CREATED: ${checkpoint.checkpoint_id}\nSTATUS: ${checkpoint.status}\nNEXT: ${checkpoint.next_action}`;
  } else if (command === 'list') {
    const checkpoints = await listCheckpoints(storageDir);
    value = checkpoints.map(({ checkpoint_id, status, workflow, task, updated_at }) => ({
      checkpoint_id,
      status,
      workflow,
      task,
      updated_at,
    }));
    output = value.length
      ? value
          .map((item) => `${item.checkpoint_id} — ${item.status} — ${item.workflow} — ${item.task}`)
          .join('\n')
      : 'No local checkpoints.';
  } else {
    const id = args.shift();
    assertSafeId(id);
    const checkpoint = await readCheckpoint(id, storageDir);
    if (checkpoint.checkpoint_id !== id) throw new Error('checkpoint filename/id mismatch');
    if (command === 'validate') {
      const errors = validateCheckpoint(checkpoint, authority);
      value = { valid: errors.length === 0, errors };
      output = errors.length ? `INVALID: ${errors.join('; ')}` : `VALID: ${id}`;
    } else if (command === 'show') {
      checkValid(checkpoint, authority);
      value = checkpoint;
      output = humanShow(checkpoint);
    } else if (command === 'resume') {
      checkValid(checkpoint, authority);
      value = buildResumePacket(checkpoint);
      output = textResume(value);
    } else if (command === 'export') {
      checkValid(checkpoint, authority);
      value = JSON.parse(JSON.stringify(checkpoint));
      output = JSON.stringify(value, null, 2);
    } else if (command === 'complete' || command === 'abandon') {
      checkpoint.status = command === 'complete' ? 'COMPLETED' : 'ABANDONED';
      checkpoint.next_action =
        command === 'complete' ? 'Completed; not resumable.' : 'Abandoned; not resumable.';
      await validateAndSave(checkpoint, authority, storageDir, now);
      value = checkpoint;
      output = `${checkpoint.status}: ${id}`;
    } else if (command === 'set') {
      const field = args.shift()?.replaceAll('-', '_');
      if (!MUTABLE_FIELDS.has(field)) throw new Error('field is not directly settable');
      const raw = args.join(' ');
      if (!raw) throw new Error('set requires a value');
      let parsed = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* ordinary string value */
      }
      checkpoint[field] = parsed;
      await validateAndSave(checkpoint, authority, storageDir, now);
      value = checkpoint;
      output = `UPDATED: ${id} ${field}`;
    } else if (command === 'block') {
      const flags = parseFlags(args);
      allowFlags(flags, new Set(['reason', 'next_action']));
      const reason = required(flags, 'reason');
      checkpoint.status = 'BLOCKED';
      checkpoint.next_action = required(flags, 'next_action');
      appendUnique(checkpoint.blocked_items, reason);
      await validateAndSave(checkpoint, authority, storageDir, now);
      value = checkpoint;
      output = `BLOCKED: ${id}\nNEXT: ${checkpoint.next_action}`;
    } else if (command === 'wait-owner') {
      const flags = parseFlags(args);
      allowFlags(flags, new Set(['action', 'next_action']));
      checkpoint.status = 'WAITING_FOR_OWNER';
      checkpoint.provider_state = 'WAITING_FOR_OWNER';
      checkpoint.human_action_pending = required(flags, 'action');
      checkpoint.next_action = required(flags, 'next_action');
      await validateAndSave(checkpoint, authority, storageDir, now);
      value = checkpoint;
      output = `WAITING_FOR_OWNER: ${id}\nNEXT: ${checkpoint.next_action}`;
    } else if (command === 'owner-done') {
      const flags = parseFlags(args);
      allowFlags(flags, new Set(['next_action', 'note']));
      checkpoint.status = 'ACTIVE';
      checkpoint.provider_state = 'OWNER_COMPLETED_ACTION';
      checkpoint.human_action_pending = null;
      checkpoint.next_action = required(flags, 'next_action');
      const note = flags.get('note');
      if (note) appendUnique(checkpoint.completed_steps, `Owner action completed: ${note}`);
      await validateAndSave(checkpoint, authority, storageDir, now);
      value = checkpoint;
      output = `OWNER_COMPLETED_ACTION: ${id}\nNEXT: ${checkpoint.next_action}`;
    } else if (command === 'record') {
      const kind = args.shift();
      const flags = parseFlags(args);
      const flagsByKind = {
        step: ['text'],
        object: ['type', 'object_id', 'label'],
        mutation: [
          'type',
          'object_id',
          'action',
          'observed_result',
          'reversible',
          'reset_required',
        ],
        result: ['item_id', 'result', 'source', 'note'],
        finding: ['finding_id', 'context'],
        fixture: ['fixture_id'],
        credential: ['credential_ref'],
        role: ['role', 'account_label'],
      };
      allowFlags(flags, new Set(flagsByKind[kind] ?? []));
      switch (kind) {
        case 'step':
          checkpoint.completed_steps.push(required(flags, 'text'));
          break;
        case 'object': {
          const object = { type: required(flags, 'type'), id: required(flags, 'object_id') };
          if (flags.has('label')) object.label = flags.get('label');
          addObject(checkpoint, object);
          break;
        }
        case 'mutation': {
          const mutation = {
            object_type: required(flags, 'type'),
            object_id: required(flags, 'object_id'),
            action: required(flags, 'action'),
            observed_result: required(flags, 'observed_result'),
            reversible: parseTriState(required(flags, 'reversible'), 'reversible'),
            reset_required: parseTriState(required(flags, 'reset_required'), 'reset-required'),
          };
          checkpoint.mutations.push(mutation);
          addObject(checkpoint, { type: mutation.object_type, id: mutation.object_id });
          break;
        }
        case 'result': {
          const result = {
            item_id: required(flags, 'item_id'),
            result: required(flags, 'result').toUpperCase(),
            source: required(flags, 'source').toUpperCase(),
          };
          if (flags.has('note')) result.note = flags.get('note');
          checkpoint.acceptance_results.push(result);
          break;
        }
        case 'finding':
          appendUnique(checkpoint.finding_ids, required(flags, 'finding_id'));
          if (flags.has('context'))
            appendUnique(checkpoint.notes, `Finding context: ${flags.get('context')}`);
          break;
        case 'fixture':
          appendUnique(checkpoint.fixture_ids, required(flags, 'fixture_id'));
          break;
        case 'credential':
          appendUnique(checkpoint.credential_refs, required(flags, 'credential_ref'));
          break;
        case 'role':
          checkpoint.roles.push({
            role: required(flags, 'role'),
            account_label: required(flags, 'account_label'),
          });
          break;
        default:
          throw new Error(
            'record kind must be step, object, mutation, result, finding, fixture, credential or role',
          );
      }
      await validateAndSave(checkpoint, authority, storageDir, now);
      value = checkpoint;
      output = `RECORDED: ${kind} — ${id}`;
    } else {
      throw new Error('unknown checkpoint command');
    }
  }
  return { code: 0, value, output: json ? JSON.stringify(value, null, 2) : output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await execute(process.argv.slice(2));
    if (result.output) console.log(result.output);
    process.exitCode = result.code;
  } catch (error) {
    console.error(
      `ERROR: ${error instanceof Error ? error.message : 'checkpoint operation failed'}`,
    );
    process.exitCode = 1;
  }
}
