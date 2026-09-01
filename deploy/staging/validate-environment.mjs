import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TLS_MODES = new Set(['external', 'nginx']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);

function hasValue(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0;
}

function addIssue(issues, field, message) {
  issues.push(`${field}: ${message}`);
}

function requireValue(env, issues, name) {
  if (!hasValue(env, name)) {
    addIssue(issues, name, 'is required and must not rely on a development default');
    return '';
  }
  return env[name].trim();
}

function parsePort(value, field, issues) {
  if (!/^\d+$/.test(value)) {
    addIssue(issues, field, 'must be an integer from 1 to 65535');
    return null;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    addIssue(issues, field, 'must be an integer from 1 to 65535');
    return null;
  }
  return port;
}

function validateHost(host, field, issues, { rejectLocal = true } = {}) {
  if (!host || host.length > 253 || /[/?#\s]/.test(host)) {
    addIssue(issues, field, 'must be a hostname or IP address without a scheme or path');
    return;
  }

  const lower = host.toLowerCase();
  const localNames = new Set(['localhost', 'localhost.localdomain']);
  const placeholderName = lower.includes('example') || lower.endsWith('.test');
  if (
    rejectLocal &&
    (localNames.has(lower) || placeholderName || lower === 'host.docker.internal')
  ) {
    addIssue(issues, field, 'must be the real staging host, not a local or placeholder host');
    return;
  }

  const ipVersion = isIP(host);
  if (ipVersion > 0) {
    if (lower === '0.0.0.0' || lower === '::') {
      addIssue(issues, field, 'must not use an unspecified address as an upstream host');
    }
    if (
      rejectLocal &&
      ((ipVersion === 4 && (lower === '127.0.0.1' || lower.startsWith('127.'))) || lower === '::1')
    ) {
      addIssue(issues, field, 'must not point to loopback in staging');
    }
    return;
  }

  const labels = host.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
    )
  ) {
    addIssue(issues, field, 'contains an invalid DNS label');
  }
}

function parseHostPort(value, field, issues) {
  let host = '';
  let portText = '';
  if (value.startsWith('[')) {
    const closing = value.indexOf(']');
    if (closing === -1 || value[closing + 1] !== ':') {
      addIssue(issues, field, 'must use host:port or [IPv6]:port syntax');
      return { host: '', port: null };
    }
    host = value.slice(1, closing);
    portText = value.slice(closing + 2);
  } else {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || value.indexOf(':') !== separator) {
      addIssue(issues, field, 'must use host:port syntax');
      return { host: '', port: null };
    }
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }
  validateHost(host, `${field}.host`, issues);
  const port = parsePort(portText, `${field}.port`, issues);
  return { host, port };
}

function validateCidrList(value, field, issues) {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    addIssue(issues, field, 'must contain at least one CIDR');
    return [];
  }

  for (const entry of entries) {
    const separator = entry.lastIndexOf('/');
    if (separator <= 0 || separator === entry.length - 1) {
      addIssue(issues, field, `invalid CIDR: ${entry}`);
      continue;
    }
    const address = entry.slice(0, separator);
    const version = isIP(address);
    const prefix = Number(entry.slice(separator + 1));
    const maximum = version === 4 ? 32 : version === 6 ? 128 : 0;
    if (!version || !Number.isInteger(prefix) || prefix < 1 || prefix > maximum) {
      addIssue(issues, field, `invalid or unrestricted CIDR: ${entry}`);
    }
  }
  return entries;
}

function validateUrl(value, field, issues, { requireHttps = true } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    addIssue(issues, field, 'must be a valid URL');
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    addIssue(issues, field, 'must use HTTP or HTTPS');
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    addIssue(issues, field, 'must use HTTPS for staging');
  }
  if (
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    addIssue(issues, field, 'must be an origin/base URL without a path, query, or credentials');
  }
  validateHost(parsed.hostname, `${field}.hostname`, issues);
  return parsed;
}

function validateOrigins(value, field, issues) {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    addIssue(issues, field, 'must contain at least one origin');
    return [];
  }
  for (const origin of origins) {
    if (origin.includes('*')) {
      addIssue(issues, field, `wildcards are not allowed: ${origin}`);
      continue;
    }
    validateUrl(origin, field, issues, { requireHttps: true });
  }
  return origins;
}

function rejectPlaceholder(value, field, issues) {
  if (/\b(?:change[_ -]?me|replace[_ -]?me|todo|placeholder)\b/i.test(value)) {
    addIssue(issues, field, 'contains a placeholder value');
  }
}

export function cidrToGeoLines(entries) {
  return entries.map((entry) => `${entry} 1;`).join('\n');
}

export function validateStagingEnvironment(env = process.env) {
  const issues = [];
  const values = {};

  values.profile = requireValue(env, issues, 'NGINX_PROFILE');
  if (values.profile !== 'staging') addIssue(issues, 'NGINX_PROFILE', 'must be staging');

  values.tlsMode = requireValue(env, issues, 'NGINX_TLS_MODE');
  if (!TLS_MODES.has(values.tlsMode))
    addIssue(issues, 'NGINX_TLS_MODE', 'must be external or nginx');

  values.serverName = requireValue(env, issues, 'NGINX_SERVER_NAME');
  validateHost(values.serverName, 'NGINX_SERVER_NAME', issues);

  values.upstream = requireValue(env, issues, 'FASTIFY_UPSTREAM');
  const upstream = values.upstream
    ? parseHostPort(values.upstream, 'FASTIFY_UPSTREAM', issues)
    : { host: '', port: null };
  values.upstreamHost = upstream.host;
  values.upstreamPort = upstream.port;

  values.httpPort = parsePort(
    requireValue(env, issues, 'NGINX_HTTP_PORT'),
    'NGINX_HTTP_PORT',
    issues,
  );
  const httpsPortValue = hasValue(env, 'NGINX_HTTPS_PORT') ? env.NGINX_HTTPS_PORT.trim() : '';
  values.httpsPort = httpsPortValue ? parsePort(httpsPortValue, 'NGINX_HTTPS_PORT', issues) : null;
  if (values.tlsMode === 'nginx' && values.httpsPort === null) {
    addIssue(issues, 'NGINX_HTTPS_PORT', 'is required when Nginx owns TLS');
  }
  if (
    values.tlsMode === 'nginx' &&
    values.httpPort !== null &&
    values.httpsPort !== null &&
    values.httpPort === values.httpsPort
  ) {
    addIssue(issues, 'NGINX_HTTPS_PORT', 'must differ from NGINX_HTTP_PORT');
  }
  if (values.tlsMode === 'external' && httpsPortValue) {
    addIssue(issues, 'NGINX_HTTPS_PORT', 'must be omitted when TLS is terminated before Nginx');
  }
  values.fastifyPort = parsePort(requireValue(env, issues, 'PORT'), 'PORT', issues);
  if (
    values.upstreamPort !== null &&
    values.fastifyPort !== null &&
    values.upstreamPort !== values.fastifyPort
  ) {
    addIssue(issues, 'FASTIFY_UPSTREAM', 'port must match Fastify PORT');
  }

  const readinessCidrs = validateCidrList(
    requireValue(env, issues, 'NGINX_READINESS_ALLOWLIST_CIDRS'),
    'NGINX_READINESS_ALLOWLIST_CIDRS',
    issues,
  );
  values.readinessCidrs = readinessCidrs;

  const trustedProxyCidrs = validateCidrList(
    requireValue(env, issues, 'TRUSTED_PROXY_CIDRS'),
    'TRUSTED_PROXY_CIDRS',
    issues,
  );
  values.trustedProxyCidrs = trustedProxyCidrs;

  const edgeTrustedRaw = hasValue(env, 'NGINX_EDGE_TRUSTED_CIDRS')
    ? env.NGINX_EDGE_TRUSTED_CIDRS.trim()
    : '';
  const edgeTrustedCidrs = edgeTrustedRaw
    ? validateCidrList(edgeTrustedRaw, 'NGINX_EDGE_TRUSTED_CIDRS', issues)
    : [];
  if (values.tlsMode === 'external' && edgeTrustedCidrs.length === 0) {
    addIssue(
      issues,
      'NGINX_EDGE_TRUSTED_CIDRS',
      'is required when an external TLS/CDN/LB hop is trusted',
    );
  }
  if (values.tlsMode === 'nginx' && edgeTrustedCidrs.length > 0) {
    addIssue(
      issues,
      'NGINX_EDGE_TRUSTED_CIDRS',
      'must be omitted when Nginx owns TLS and is the TLS trust boundary',
    );
  }
  values.edgeTrustedCidrs = edgeTrustedCidrs;

  values.publicApiUrl = requireValue(env, issues, 'PUBLIC_API_URL');
  const publicApiUrl = validateUrl(values.publicApiUrl, 'PUBLIC_API_URL', issues);
  if (publicApiUrl && values.serverName && publicApiUrl.hostname !== values.serverName) {
    addIssue(issues, 'PUBLIC_API_URL', 'hostname must match NGINX_SERVER_NAME');
  }

  values.allowedOrigins = validateOrigins(
    requireValue(env, issues, 'ALLOWED_ORIGINS'),
    'ALLOWED_ORIGINS',
    issues,
  );
  values.betterAuthOrigins = validateOrigins(
    requireValue(env, issues, 'BETTER_AUTH_TRUSTED_ORIGINS'),
    'BETTER_AUTH_TRUSTED_ORIGINS',
    issues,
  );
  values.betterAuthUrl = requireValue(env, issues, 'BETTER_AUTH_URL');
  validateUrl(values.betterAuthUrl, 'BETTER_AUTH_URL', issues);

  values.nodeEnv = requireValue(env, issues, 'NODE_ENV');
  if (values.nodeEnv !== 'production')
    addIssue(issues, 'NODE_ENV', 'must be production for staging safeguards');
  values.host = requireValue(env, issues, 'HOST');
  if (values.host !== '0.0.0.0' && values.host !== '::') {
    addIssue(issues, 'HOST', 'must bind the private Fastify service on 0.0.0.0 or ::');
  }
  values.storageDriver = requireValue(env, issues, 'STORAGE_DRIVER');
  if (values.storageDriver !== 'firestore')
    addIssue(issues, 'STORAGE_DRIVER', 'must be firestore for staging');

  values.firestoreProjectId = requireValue(env, issues, 'FIRESTORE_PROJECT_ID');
  rejectPlaceholder(values.firestoreProjectId, 'FIRESTORE_PROJECT_ID', issues);
  values.firebaseStorageBucket = requireValue(env, issues, 'FIREBASE_STORAGE_BUCKET');
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(values.firebaseStorageBucket)) {
    addIssue(issues, 'FIREBASE_STORAGE_BUCKET', 'must be a valid Firebase Storage bucket name');
  }
  values.firebaseClientEmail = requireValue(env, issues, 'FIREBASE_CLIENT_EMAIL');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.firebaseClientEmail)) {
    addIssue(issues, 'FIREBASE_CLIENT_EMAIL', 'must be a service-account email');
  }
  values.firebasePrivateKey = requireValue(env, issues, 'FIREBASE_PRIVATE_KEY');
  if (!values.firebasePrivateKey.includes('BEGIN PRIVATE KEY')) {
    addIssue(issues, 'FIREBASE_PRIVATE_KEY', 'must contain a PEM private-key marker');
  }

  values.redisUrl = requireValue(env, issues, 'REDIS_URL');
  try {
    const redisUrl = new URL(values.redisUrl);
    if (!['redis:', 'rediss:'].includes(redisUrl.protocol))
      addIssue(issues, 'REDIS_URL', 'must use redis:// or rediss://');
    if (['localhost', '127.0.0.1', '::1'].includes(redisUrl.hostname)) {
      addIssue(issues, 'REDIS_URL', 'must not use a local development endpoint');
    }
  } catch {
    addIssue(issues, 'REDIS_URL', 'must be a valid redis:// or rediss:// URL');
  }

  values.betterAuthSecret = requireValue(env, issues, 'BETTER_AUTH_SECRET');
  if (values.betterAuthSecret.length < 32 || values.betterAuthSecret === 'dev-only-change-me') {
    addIssue(
      issues,
      'BETTER_AUTH_SECRET',
      'must be a non-development secret of at least 32 characters',
    );
  }

  values.appVersion = requireValue(env, issues, 'APP_VERSION');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(values.appVersion)) {
    addIssue(issues, 'APP_VERSION', 'must be semantic-version shaped');
  }
  values.buildSha = requireValue(env, issues, 'BUILD_SHA');
  if (!/^[0-9a-f]{7,64}$/i.test(values.buildSha))
    addIssue(issues, 'BUILD_SHA', 'must be a commit SHA');
  values.logLevel = requireValue(env, issues, 'LOG_LEVEL');
  if (!LOG_LEVELS.has(values.logLevel))
    addIssue(issues, 'LOG_LEVEL', 'must be a supported log level');

  if (values.tlsMode === 'nginx') {
    values.tlsCertificate = requireValue(env, issues, 'NGINX_TLS_CERTIFICATE');
    values.tlsCertificateKey = requireValue(env, issues, 'NGINX_TLS_CERTIFICATE_KEY');
    rejectPlaceholder(values.tlsCertificate, 'NGINX_TLS_CERTIFICATE', issues);
    rejectPlaceholder(values.tlsCertificateKey, 'NGINX_TLS_CERTIFICATE_KEY', issues);
  } else {
    if (hasValue(env, 'NGINX_TLS_CERTIFICATE')) {
      addIssue(
        issues,
        'NGINX_TLS_CERTIFICATE',
        'must be omitted when TLS is terminated before Nginx',
      );
    }
    if (hasValue(env, 'NGINX_TLS_CERTIFICATE_KEY')) {
      addIssue(
        issues,
        'NGINX_TLS_CERTIFICATE_KEY',
        'must be omitted when TLS is terminated before Nginx',
      );
    }
    values.tlsCertificate = '';
    values.tlsCertificateKey = '';
  }

  return { ok: issues.length === 0, issues, values };
}

export function assertValidStagingEnvironment(env = process.env) {
  const result = validateStagingEnvironment(env);
  if (!result.ok) {
    throw new Error(
      `Invalid staging environment:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}`,
    );
  }
  return result;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entrypoint === path.resolve(fileURLToPath(import.meta.url))) {
  const result = validateStagingEnvironment();
  if (!result.ok) {
    console.error('Staging environment validation failed:');
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 64;
  } else {
    console.log(`Staging environment contract passed (TLS mode: ${result.values.tlsMode}).`);
  }
}
