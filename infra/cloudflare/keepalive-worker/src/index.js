// Keep-alive for the API on a Render free web service.
//
// Render's free tier shuts an instance down after ~15 minutes without inbound
// traffic, and the next request then waits (or, as on 2026-11-08, hangs until
// Cloudflare answers 524). This Worker runs on a Cron Trigger and requests the
// public health endpoint through Cloudflare so the instance stays up.
//
// The probe path is the one the nginx origin lock deliberately leaves open
// (GET /api/v2/internal/health returns only {ok, uptime}), so no secret is
// needed here. HEALTH_URL is the only configuration.

const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 5_000;

export async function probe(
  url,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  let last = 'no attempt made';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'user-agent': 'c1rcle-keepalive/1' },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (response.ok) {
        return { ok: true, status: response.status, attempt };
      }
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: last, attempt: ATTEMPTS };
}

export default {
  async scheduled(_controller, env) {
    const url = env.HEALTH_URL;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('HEALTH_URL must be set to an https URL');
    }
    const result = await probe(url);
    console.log(JSON.stringify({ event: 'keepalive', url, ...result }));
    if (!result.ok) {
      // Throwing marks the invocation as failed in Cloudflare's cron history.
      throw new Error(`keepalive failed after ${result.attempt} attempts: ${result.error}`);
    }
  },
};
