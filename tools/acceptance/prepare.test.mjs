import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from './prepare.mjs';
import {
  buildPreparation,
  execute,
  findRecord,
  probeServices,
  safeUrl,
  summarizeRecord,
} from './prepare.mjs';

const root = new URL('../../', import.meta.url);
const harness = await readJson(new URL('docs/ai/STAGING_FIXTURES.json', root));
const config = await readJson(new URL('tools/acceptance/surfaces.json', root));

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test('established fixture and unprovisioned requirement remain distinct', () => {
  const fixture = summarizeRecord('guest_canonical_paid_event', harness);
  const requirement = summarizeRecord('guest_incomplete_account', harness);
  assert.equal(fixture.record_type, 'FIXTURE');
  assert.equal(fixture.locator.slug, 'c1rcle-staging-acceptance-001');
  assert.equal(fixture.acceptance_ready, false);
  assert.equal(requirement.record_type, 'REQUIREMENT');
  assert.equal(requirement.locator, null);
  assert.equal(requirement.acceptance_ready, false);
  assert.match(requirement.blocker, /unprovisioned requirement/);
});

test('historical paid record is identified as read-only historical evidence', () => {
  const result = summarizeRecord('guest_historical_paid_booking', harness);
  assert.equal(result.record_type, 'HISTORICAL_EVIDENCE');
  assert.equal(result.mutability, 'READ_ONLY');
  assert.equal(result.acceptance_ready, true);
});

test('invalid fixture fails with a compact error after pnpm argument forwarding', async () => {
  const result = await execute(['--', 'fixture', 'not_a_fixture', '--json'], { harness, config });
  assert.equal(result.code, 2);
  assert.match(result.output, /unknown fixture or requirement/);
});

test('publication scenario lists its linked unprovisioned actors and setup records', () => {
  const result = summarizeRecord('publication_journey', harness);
  assert.equal(result.acceptance_ready, false);
  assert.ok(result.related_records.some((dependency) => dependency.id === 'partner_host_a'));
  assert.ok(result.related_records.some((dependency) => dependency.id === 'partner_venue_a'));
  assert.ok(
    result.related_records.some((dependency) => dependency.id === 'partner_available_slot'),
  );
  assert.ok(result.related_records.every((dependency) => dependency.record_type === 'REQUIREMENT'));
  assert.ok(result.related_records.every((dependency) => dependency.locator_state === 'UNBOUND'));
});

test('JSON fixture output is valid JSON and concise', async () => {
  const result = await execute(['--', 'fixture', 'guest_historical_paid_booking', '--json'], {
    harness,
    config,
  });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.id, 'guest_historical_paid_booking');
  assert.equal(parsed.record_type, 'HISTORICAL_EVIDENCE');
  assert.equal(parsed.acceptance_ready, true);
});

test('UNKNOWN backend SHA and protected readiness when no token is available', async () => {
  let called = false;
  const result = await probeServices(config, {
    env: {},
    fetchImpl: async () => {
      called = true;
      throw new Error('unreachable');
    },
  });
  assert.equal(called, true);
  assert.equal(result.backend_sha, 'UNKNOWN');
  assert.equal(result.frontend_sha, 'UNKNOWN');
  assert.equal(result.backend_readiness.status, 'UNKNOWN');
});

test('version verification accepts only an actual full SHA and never returns token material', async () => {
  const secretMaterial = ['not', 'printed', 'credential', 'sentinel'].join('-');
  const requested = [];
  const result = await probeServices(config, {
    env: { NGINX_READINESS_TOKEN: secretMaterial },
    fetchImpl: async (url, init) => {
      requested.push({ url, init });
      if (url.endsWith(config.version_path))
        return response(200, { commit: 'a'.repeat(40), version: 'x' });
      if (url.endsWith(config.readiness_path))
        return response(200, { ok: true, checks: { gateway: 'up' } });
      return response(200, { ok: true });
    },
  });
  assert.equal(result.backend_sha, 'a'.repeat(40));
  assert.ok(requested.every(({ init }) => init.method === 'GET'));
  assert.ok(requested.every(({ url }) => !url.includes('?')));
  assert.ok(JSON.stringify(result).includes('a'.repeat(40)));
  assert.ok(!JSON.stringify(result).includes(secretMaterial));
  assert.ok(requested.some(({ init }) => init.headers['x-readiness-token'] === secretMaterial));
});

test('readiness failure is not reported as pass', async () => {
  const result = await probeServices(config, {
    env: { NGINX_READINESS_TOKEN: 'x'.repeat(32) },
    fetchImpl: async (url) =>
      url.endsWith(config.readiness_path)
        ? response(503, { ok: false })
        : url.endsWith(config.version_path)
          ? response(200, { commit: null })
          : response(200, { ok: true }),
  });
  assert.equal(result.backend_readiness.status, 'FAIL');
  assert.equal(result.backend_sha, 'UNKNOWN');
});

test('missing credential label is explicit and prep probes use only GET', async () => {
  const calls = [];
  const result = await buildPreparation('partner', {
    harness,
    config,
    fixtureId: 'partner_slot_accept',
    env: {},
    fetchImpl: async (url, init) => {
      calls.push(init);
      return response(200, { ok: true });
    },
  });
  assert.equal(result.credential_ref, 'MISSING');
  assert.equal(result.acceptance_ready, false);
  assert.ok(calls.every((init) => init.method === 'GET'));
  assert.ok(calls.every((init) => !('x-vercel-protection-bypass' in init.headers)));
});

test('URL output strips query values and credentials', () => {
  assert.equal(
    safeUrl('https://example.test/path?token=private#frag'),
    'https://example.test/path',
  );
  assert.equal(safeUrl('not a URL'), null);
  assert.ok(findRecord('guest_historical_paid_booking', harness));
});

test('surface map uses the established custom hosted aliases and leaves Scanner unestablished', () => {
  assert.equal(config.surfaces.guest.app_url, 'https://guest.thec1rcle.com');
  assert.equal(config.surfaces.host.app_url, 'https://staging.thec1rcle.com');
  assert.equal(config.surfaces.venue.app_url, 'https://staging.thec1rcle.com');
  assert.equal(config.surfaces.partner.app_url, 'https://staging.thec1rcle.com');
  assert.equal(config.surfaces.promoter.app_url, 'https://staging.thec1rcle.com');
  assert.equal(config.surfaces.admin.app_url, 'https://admin.thec1rcle.com');
  assert.equal(config.surfaces.scanner.app_url, null);
  assert.equal(config.api_url, 'https://circle-v2-backend.onrender.com');
});

test('Guest preparation probes the canonical hosted URL without bypass headers', async () => {
  const urls = [];
  const result = await buildPreparation('guest', {
    harness,
    config,
    env: {},
    fetchImpl: async (url, init) => {
      urls.push({ url, init });
      return response(url === config.surfaces.guest.app_url ? 401 : 200, { ok: true });
    },
  });
  assert.equal(result.app_url, 'https://guest.thec1rcle.com');
  assert.equal(result.app_reachability.status, 'PROTECTED');
  assert.ok(urls.some(({ url }) => url === 'https://guest.thec1rcle.com'));
  assert.ok(urls.every(({ init }) => !('x-vercel-protection-bypass' in init.headers)));
});

test('unapproved file-configured origins never reach outbound requests', async () => {
  const calls = [];
  const unapproved = {
    ...config,
    api_url: 'http://169.254.169.254/latest/meta-data',
    surfaces: {
      ...config.surfaces,
      guest: { ...config.surfaces.guest, app_url: 'http://127.0.0.1:8080/admin' },
    },
  };
  const result = await buildPreparation('guest', {
    harness,
    config: unapproved,
    env: { NGINX_READINESS_TOKEN: 'x'.repeat(32) },
    fetchImpl: async (url) => {
      calls.push(url);
      return response(200, { ok: true });
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(result.app_url, null);
  assert.equal(result.app_reachability.status, 'UNKNOWN');
  assert.equal(result.backend_liveness.status, 'UNKNOWN');
});

test('probe paths come from fixed endpoints rather than file configuration', async () => {
  const calls = [];
  await probeServices(
    {
      ...config,
      health_path: 'https://127.0.0.1/metadata',
      readiness_path: '//169.254.169.254/latest/meta-data',
      version_path: '/../../admin',
    },
    {
      env: { NGINX_READINESS_TOKEN: 'x'.repeat(32) },
      fetchImpl: async (url) => {
        calls.push(url);
        return response(200, { ok: true, commit: 'a'.repeat(40) });
      },
    },
  );

  assert.deepEqual(calls, [
    'https://circle-v2-backend.onrender.com/api/v2/internal/health',
    'https://circle-v2-backend.onrender.com/api/v2/internal/readiness',
    'https://circle-v2-backend.onrender.com/api/v2/internal/version',
  ]);
});
