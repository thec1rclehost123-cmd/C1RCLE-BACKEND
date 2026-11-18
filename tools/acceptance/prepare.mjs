#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES_PATH = path.join(ROOT, 'docs/ai/STAGING_FIXTURES.json');
const SURFACES_PATH = path.join(ROOT, 'tools/acceptance/surfaces.json');
const FETCH_TIMEOUT_MS = 5_000;
const SECRET_KEY = /password|otp|bypass|cookie|api.?key|token|secret|card|authorization/i;
const FULL_SHA = /^[a-f0-9]{40}$/i;
const API_TARGET = 'https://circle-v2-backend.onrender.com';
const API_PROBES = Object.freeze({
  health: '/api/v2/internal/health',
  readiness: '/api/v2/internal/readiness',
  version: '/api/v2/internal/version',
});
const SURFACE_TARGETS = Object.freeze({
  guest: 'https://guest.thec1rcle.com',
  host: 'https://staging.thec1rcle.com',
  venue: 'https://staging.thec1rcle.com',
  partner: 'https://staging.thec1rcle.com',
  promoter: 'https://staging.thec1rcle.com',
  scanner: null,
  admin: 'https://admin.thec1rcle.com',
});

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function safeUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

function approvedSurfaceTarget(surfaceKey, surface) {
  const target = SURFACE_TARGETS[surfaceKey];
  return target && surface?.app_url === target ? target : null;
}

function approvedApiTarget(config) {
  return config.api_url === API_TARGET ? API_TARGET : null;
}

function safeLocator(locator = {}) {
  const output = {};
  for (const [key, value] of Object.entries(locator ?? {})) {
    if (SECRET_KEY.test(key) && key !== 'credential_ref') continue;
    if (key === 'credential_ref') {
      output[key] =
        typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : 'MISSING';
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      output[key] = key.toLowerCase().includes('url') ? safeUrl(String(value)) : value;
    }
  }
  return output;
}

export function findRecord(id, harness) {
  for (const group of ['fixtures', 'requirements']) {
    const record = (harness[group] ?? []).find((entry) => entry.id === id);
    if (record) return { record, group };
  }
  return null;
}

function readiness(record, group) {
  if (group === 'requirements') return false;
  return record.health === 'READY' && !record.reserved_for && record.reset_required !== true;
}

export function summarizeRecord(id, harness) {
  const found = findRecord(id, harness);
  if (!found) return null;
  const { record, group } = found;
  const ready = readiness(record, group);
  const result = {
    id: record.id,
    record_type: group === 'fixtures' ? record.kind : 'REQUIREMENT',
    area: record.area,
    health: record.health,
    mutability: record.mutability,
    locator: record.locator ? safeLocator(record.locator) : null,
    purposes: record.purposes ?? [],
    known_mutations: record.known_mutations ?? [],
    reservation: record.reserved_for ?? null,
    reset_required: record.reset_required ?? null,
    acceptance_refs: record.acceptance_item_refs ?? [],
    finding_refs: record.finding_refs ?? [],
    acceptance_ready: ready,
  };
  if (group === 'requirements') {
    result.blocker = `${record.id} is an unprovisioned requirement`;
    const visited = new Set([record.id]);
    const related = [];
    const visit = (refs = []) => {
      for (const ref of refs) {
        if (visited.has(ref)) continue;
        visited.add(ref);
        const dep = findRecord(ref, harness);
        related.push({
          id: ref,
          role: /^partner_host_[ab]$/.test(ref)
            ? 'HOST'
            : /^partner_venue_[ab]$/.test(ref)
              ? 'VENUE'
              : null,
          record_type:
            dep?.group === 'requirements' ? 'REQUIREMENT' : (dep?.record.kind ?? 'UNKNOWN'),
          locator_state: dep?.record.locator ? 'BOUND' : 'UNBOUND',
          health: dep?.record.health ?? 'UNKNOWN',
          acceptance_ready: dep ? readiness(dep.record, dep.group) : false,
        });
        if (dep?.group === 'requirements') visit(dep.record.fixture_refs ?? []);
      }
    };
    visit(record.fixture_refs ?? []);
    result.related_records = related;
  } else if (!ready) {
    result.blocker = record.reserved_for
      ? `reserved for ${record.reserved_for}`
      : record.reset_required
        ? 'required reset has not been verified'
        : 'fixture needs current-state verification before use';
  }
  return result;
}

function accountCredentialRef(surfaceKey, fixtureId, harness, surface) {
  const id = fixtureId ?? surface.credential_fixture_id;
  if (!id) return null;
  const found = findRecord(id, harness);
  if (!found) return null;
  const ref = found.record.locator?.credential_ref;
  return typeof ref === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(ref) ? ref : null;
}

async function request(url, { fetchImpl = fetch, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      redirect: 'manual',
      signal: controller.signal,
    });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(response) {
  if (!response?.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function appProbe(url, fetchImpl) {
  if (!url) return { status: 'UNKNOWN', http_status: null };
  const response = await request(url, { fetchImpl });
  if (!response) return { status: 'UNREACHABLE', http_status: null };
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) {
    return { status: 'PROTECTED', http_status: response.status };
  }
  if (response.status >= 300 && response.status < 400) {
    return { status: 'REDIRECT', http_status: response.status };
  }
  if (response.status >= 200 && response.status < 300) {
    return { status: 'REACHABLE', http_status: response.status };
  }
  return { status: 'HTTP_ERROR', http_status: response.status };
}

async function apiProbe(apiUrl, probePath, { fetchImpl, token } = {}) {
  const headers = token ? { 'x-readiness-token': token } : {};
  const response = await request(`${apiUrl}${probePath}`, { fetchImpl, headers });
  if (!response) return { status: 'UNKNOWN', http_status: null };
  const body = await parseJson(response);
  if (response.status === 404 && !token) return { status: 'UNKNOWN', http_status: 404 };
  if (response.status === 200 && body?.ok === true) {
    return { status: 'PASS', http_status: 200, checks: body.checks ?? undefined };
  }
  if (response.status === 503 || response.status >= 500) {
    return { status: 'FAIL', http_status: response.status };
  }
  if (!response.ok && token) return { status: 'UNKNOWN', http_status: response.status };
  return { status: 'FAIL', http_status: response.status };
}

export async function probeServices(config, { env = process.env, fetchImpl = fetch } = {}) {
  const apiUrl = approvedApiTarget(config);
  if (!apiUrl) {
    return {
      backend_liveness: { status: 'UNKNOWN', http_status: null, scope: 'process liveness only' },
      backend_readiness: {
        status: 'UNKNOWN',
        http_status: null,
        reason: 'configured backend URL is not an approved target',
      },
      backend_sha: 'UNKNOWN',
      backend_sha_reason: 'configured backend URL is not an approved target',
      frontend_sha: 'UNKNOWN',
      frontend_sha_reason: config.frontend_sha_evidence
        ? 'configured frontend evidence source could not be verified by this helper'
        : 'no frontend runtime SHA endpoint or authorized deployment-metadata source is configured',
    };
  }
  const token = env.NGINX_READINESS_TOKEN || null;
  const liveness = await apiProbe(apiUrl, API_PROBES.health, { fetchImpl });
  const readinessResult = token
    ? await apiProbe(apiUrl, API_PROBES.readiness, { fetchImpl, token })
    : { status: 'UNKNOWN', http_status: null, reason: 'NGINX_READINESS_TOKEN unavailable' };

  let backendSha = 'UNKNOWN';
  let backendShaReason = 'NGINX_READINESS_TOKEN unavailable';
  if (token) {
    const response = await request(`${apiUrl}${API_PROBES.version}`, {
      fetchImpl,
      headers: { 'x-readiness-token': token },
    });
    const body = await parseJson(response);
    if (
      response?.status === 200 &&
      body &&
      typeof body.commit === 'string' &&
      FULL_SHA.test(body.commit)
    ) {
      backendSha = body.commit.toLowerCase();
      backendShaReason = null;
    } else {
      backendShaReason = response
        ? `version endpoint returned HTTP ${response.status} or no full SHA`
        : 'version endpoint unavailable';
    }
  }
  return {
    backend_liveness: { ...liveness, scope: 'process liveness only' },
    backend_readiness: readinessResult,
    backend_sha: backendSha,
    backend_sha_reason: backendShaReason,
    frontend_sha: 'UNKNOWN',
    frontend_sha_reason: config.frontend_sha_evidence
      ? 'configured frontend evidence source could not be verified by this helper'
      : 'no frontend runtime SHA endpoint or authorized deployment-metadata source is configured',
  };
}

export async function buildPreparation(surfaceKey, options = {}) {
  const { harness, config, fixtureId = null, fetchImpl = fetch, env = process.env } = options;
  const surface = config.surfaces[surfaceKey];
  if (!surface) throw new Error(`unknown surface: ${surfaceKey}`);
  const fixture = fixtureId ? summarizeRecord(fixtureId, harness) : null;
  if (fixtureId && !fixture) throw new Error(`unknown fixture or requirement: ${fixtureId}`);

  const appUrl = approvedSurfaceTarget(surfaceKey, surface);
  const [app, services] = await Promise.all([
    appProbe(appUrl, fetchImpl),
    probeServices(config, { env, fetchImpl }),
  ]);
  const chosen = fixtureId ? findRecord(fixtureId, harness)?.record : null;
  const credentialSourceId = chosen?.type === 'ACCOUNT' ? fixtureId : surface.credential_fixture_id;
  const credentialRef = accountCredentialRef(surfaceKey, credentialSourceId, harness, surface);
  const warnings = [];
  if (!appUrl) warnings.push(config.scanner_note);
  if (app.status === 'PROTECTED')
    warnings.push(
      'Surface is protected; use the approved browser access procedure. No bypass credential was used.',
    );
  if (app.status === 'REDIRECT')
    warnings.push('Surface redirected; inspect the actual browser destination before acceptance.');
  if (services.backend_readiness.status === 'UNKNOWN')
    warnings.push('Protected dependency readiness was not established.');
  if (services.frontend_sha === 'UNKNOWN')
    warnings.push(
      'Frontend deployed revision is UNKNOWN; do not infer it from a merged or local commit.',
    );
  if (!credentialRef)
    warnings.push(
      'No approved credential label is bound to this scenario; do not search repository files for passwords.',
    );
  if (surfaceKey === 'guest') {
    warnings.push(
      'Owner authorization is required before any paid Razorpay Test Mode action; preparation does not contact the provider.',
    );
    warnings.push(
      'Firebase phone verification may require a human/provider step when the scenario needs it.',
    );
  }
  if (fixture && !fixture.acceptance_ready) warnings.push(fixture.blocker);

  return {
    environment: config.environment,
    environment_provenance: config.environment_note,
    surface: surface.label,
    app_url: appUrl,
    app_reachability: app,
    api_url: safeUrl(config.api_url),
    ...services,
    fixture_id: fixture?.id ?? null,
    fixture_type: fixture?.record_type ?? null,
    fixture_health: fixture?.health ?? null,
    fixture_mutability: fixture?.mutability ?? null,
    acceptance_ready: fixture ? fixture.acceptance_ready : null,
    credential_ref: credentialRef ?? 'MISSING',
    provider_mode: surface.provider_mode,
    human_action_required:
      surfaceKey === 'guest'
        ? 'Owner authorization for any Test Mode payment; Firebase phone verification if required.'
        : 'Only if the approved scenario explicitly requires a provider or owner action.',
    browser_start_url: appUrl,
    browser_session_safety:
      'Keep cookies during a workflow; switch accounts deliberately; record role/account labels and verify auth after session changes. Wait for visible/enabled/application readiness, not an arbitrary fixed delay.',
    vercel_protection_safety:
      'If authorized protection bypass is needed, establish the browser cookie on initial protected navigation, then do not inject bypass headers into later or cross-origin requests. This helper never reads or stores bypass secrets.',
    required_actor_labels:
      surfaceKey === 'partner'
        ? [
            'Host and Venue use separate labelled accounts/sessions when the scenario crosses roles.',
          ]
        : [surface.label],
    fixture: fixture,
    warnings,
  };
}

export function listFixtures(harness, area = null) {
  const matches = (rows) =>
    (rows ?? []).filter((r) => !area || r.area.toLowerCase() === area.toLowerCase());
  const compact = (r, group) => ({
    id: r.id,
    type: group === 'fixtures' ? r.kind : 'REQUIREMENT',
    health: r.health,
    mutability: r.mutability,
    locator_state: r.locator ? 'ESTABLISHED IDENTITY' : 'UNBOUND',
  });
  return {
    area: area?.toUpperCase() ?? 'ALL',
    established_fixtures: matches(harness.fixtures).map((r) => compact(r, 'fixtures')),
    unprovisioned_requirements: matches(harness.requirements).map((r) =>
      compact(r, 'requirements'),
    ),
  };
}

function usage() {
  return [
    'Usage: pnpm acceptance:prepare -- <command> [options]',
    '  prepare <guest|host|venue|partner|promoter|scanner|admin> [--fixture ID] [--json]',
    '  fixture <ID> [--json]',
    '  fixtures [--area guest|partner|promoter|scanner|admin|cross_role] [--json]',
    '  deployment [surface] [--json]',
    '  health [surface] [--json]',
  ].join('\n');
}

function humanRecord(record) {
  const lines = [
    `RECORD: ${record.record_type} — ${record.id}`,
    `AREA: ${record.area}`,
    `HEALTH: ${record.health}`,
    `MUTABILITY: ${record.mutability}`,
    `LOCATOR: ${record.locator ? JSON.stringify(record.locator) : 'UNBOUND'}`,
    `PURPOSES: ${(record.purposes ?? []).join('; ') || 'none recorded'}`,
    `KNOWN MUTATIONS: ${(record.known_mutations ?? []).join('; ') || 'none recorded'}`,
    `RESERVATION: ${record.reservation ?? 'none'}`,
    `RESET REQUIRED: ${record.reset_required ?? 'unspecified'}`,
    `ACCEPTANCE REFS: ${(record.acceptance_refs ?? []).join(', ') || 'none'}`,
    `FINDING REFS: ${(record.finding_refs ?? []).join(', ') || 'none'}`,
    `ACCEPTANCE READY: ${record.acceptance_ready ? 'YES (within recorded purpose)' : 'NO'}`,
  ];
  if (record.blocker) lines.push(`BLOCKER: ${record.blocker}`);
  for (const dependency of record.dependencies ?? []) {
    lines.push(
      `DEPENDENCY: ${dependency.id} — ${dependency.record_type} — ${dependency.locator_state} — ${dependency.health}`,
    );
  }
  for (const related of record.related_records ?? []) {
    lines.push(
      `RELATED: ${related.role ? `${related.role} — ` : ''}${related.id} — ${related.record_type} — ${related.locator_state} — ${related.health}`,
    );
  }
  return lines.join('\n');
}

function humanList(list) {
  const lines = [`AREA: ${list.area}`, 'ESTABLISHED FIXTURES:'];
  lines.push(
    ...(list.established_fixtures.length
      ? list.established_fixtures.map((r) => `- ${r.id} — ${r.health} — ${r.mutability}`)
      : ['- none']),
  );
  lines.push('UNPROVISIONED REQUIREMENTS:');
  lines.push(
    ...(list.unprovisioned_requirements.length
      ? list.unprovisioned_requirements.map((r) => `- ${r.id} — NOT USABLE — ${r.mutability}`)
      : ['- none']),
  );
  return lines.join('\n');
}

function humanPreparation(result) {
  const lines = [
    `ENVIRONMENT: ${result.environment}`,
    `ENVIRONMENT PROVENANCE: ${result.environment_provenance}`,
    `SURFACE: ${result.surface}`,
    `APP URL: ${result.app_url ?? 'UNKNOWN'}`,
    `APP REACHABILITY: ${result.app_reachability.status}${result.app_reachability.http_status ? ` (${result.app_reachability.http_status})` : ''}`,
    `API URL: ${result.api_url}`,
    `FRONTEND DEPLOYED SHA: ${result.frontend_sha}`,
    `BACKEND DEPLOYED SHA: ${result.backend_sha}`,
    `BACKEND LIVENESS: ${result.backend_liveness.status} (${result.backend_liveness.scope})`,
    `BACKEND READINESS: ${result.backend_readiness.status}`,
    `FIXTURE: ${result.fixture_id ?? 'none selected'}`,
    `FIXTURE HEALTH: ${result.fixture_health ?? 'n/a'}`,
    `FIXTURE MUTABILITY: ${result.fixture_mutability ?? 'n/a'}`,
    `ACCEPTANCE READY: ${result.acceptance_ready === null ? 'n/a' : result.acceptance_ready ? 'YES' : 'NO'}`,
    `CREDENTIAL REF: ${result.credential_ref}`,
    `PROVIDER MODE: ${result.provider_mode}`,
    `HUMAN ACTION REQUIRED: ${result.human_action_required}`,
    `BROWSER START URL: ${result.browser_start_url ?? 'UNKNOWN'}`,
    `SESSION SAFETY: ${result.browser_session_safety}`,
    `VERCEL PROTECTION: ${result.vercel_protection_safety}`,
    `ACTORS: ${result.required_actor_labels.join('; ')}`,
    `WARNINGS: ${result.warnings.length ? result.warnings.join(' | ') : 'none'}`,
  ];
  if (result.fixture) lines.push('', humanRecord(result.fixture));
  return lines.join('\n');
}

export async function execute(argv, dependencies = {}) {
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--');
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') return { code: 0, output: usage() };
  const harness =
    dependencies.harness ?? (await readJson(dependencies.fixturesPath ?? FIXTURES_PATH));
  const config =
    dependencies.config ?? (await readJson(dependencies.surfacesPath ?? SURFACES_PATH));
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const env = dependencies.env ?? process.env;
  let value;
  let output;
  switch (command) {
    case 'fixture': {
      const record = summarizeRecord(args[0], harness);
      if (!record)
        return {
          code: 2,
          value: { error: `unknown fixture or requirement: ${args[0] ?? ''}` },
          output: `ERROR: unknown fixture or requirement: ${args[0] ?? ''}`,
        };
      value = record;
      output = humanRecord(record);
      break;
    }
    case 'fixtures': {
      const areaIndex = args.indexOf('--area');
      const area = areaIndex >= 0 ? args[areaIndex + 1] : null;
      value = listFixtures(harness, area);
      output = humanList(value);
      break;
    }
    case 'prepare': {
      const surfaceKey = args.shift()?.toLowerCase();
      const fixtureIndex = args.indexOf('--fixture');
      const fixtureId = fixtureIndex >= 0 ? args[fixtureIndex + 1] : null;
      value = await buildPreparation(surfaceKey, { harness, config, fixtureId, fetchImpl, env });
      output = humanPreparation(value);
      break;
    }
    case 'deployment':
    case 'health': {
      const surfaceKey = args[0]?.toLowerCase() ?? null;
      const services = await probeServices(config, { env, fetchImpl });
      const surface = surfaceKey ? config.surfaces[surfaceKey] : null;
      if (surfaceKey && !surface)
        return {
          code: 2,
          value: { error: `unknown surface: ${surfaceKey}` },
          output: `ERROR: unknown surface: ${surfaceKey}`,
        };
      const app = surface
        ? await appProbe(approvedSurfaceTarget(surfaceKey, surface), fetchImpl)
        : null;
      value =
        command === 'deployment'
          ? {
              environment: config.environment,
              environment_provenance: config.environment_note,
              surface: surface?.label ?? surfaceKey,
              frontend_sha: services.frontend_sha,
              frontend_sha_reason: services.frontend_sha_reason,
              backend_sha: services.backend_sha,
              backend_sha_reason: services.backend_sha_reason,
            }
          : {
              environment: config.environment,
              environment_provenance: config.environment_note,
              surface: surface?.label ?? surfaceKey,
              app_url: surface ? approvedSurfaceTarget(surfaceKey, surface) : null,
              app_reachability: app,
              api_url: approvedApiTarget(config),
              backend_liveness: services.backend_liveness,
              backend_readiness: services.backend_readiness,
            };
      output = JSON.stringify(value, null, 2);
      break;
    }
    default:
      return { code: 2, output: usage() };
  }
  return { code: 0, value, output: json ? JSON.stringify(value, null, 2) : output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await execute(process.argv.slice(2));
    if (result.output) console.log(result.output);
    process.exitCode = result.code;
  } catch {
    console.error(
      'ERROR: helper failed; details suppressed to avoid leaking configuration values.',
    );
    process.exitCode = 1;
  }
}
