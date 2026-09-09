import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertValidStagingEnvironment, cidrToGeoLines } from './validate-environment.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');

function usage() {
  console.error('Usage: node deploy/staging/render-nginx.mjs --output <path>');
  console.error('   or: node deploy/staging/render-nginx.mjs --stdout');
}

function readOutputPath(args) {
  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1) {
    const output = args[outputIndex + 1];
    if (!output || output.startsWith('--')) throw new Error('--output requires a file path');
    return output;
  }
  if (args.includes('--stdout')) return null;
  usage();
  throw new Error('choose --output or --stdout');
}

export function renderStagingNginx(environment = process.env) {
  const result = assertValidStagingEnvironment(environment);
  const templateName =
    result.values.tlsMode === 'nginx' ? 'production.conf.template' : 'staging.conf.template';
  const templatePath = path.join(repositoryRoot, 'deploy/nginx/templates', templateName);
  let template = fs.readFileSync(templatePath, 'utf8');

  const replacements = {
    FASTIFY_UPSTREAM: result.values.upstream,
    NGINX_HTTP_PORT: String(result.values.httpPort),
    NGINX_HTTPS_PORT: result.values.httpsPort === null ? '' : String(result.values.httpsPort),
    NGINX_SERVER_NAME: result.values.serverName,
    NGINX_TLS_CERTIFICATE: result.values.tlsCertificate,
    NGINX_TLS_CERTIFICATE_KEY: result.values.tlsCertificateKey,
    NGINX_READINESS_ALLOWLIST_LINES: cidrToGeoLines(result.values.readinessCidrs),
    NGINX_FORWARDED_PROTO: result.values.forwardedProto,
  };

  for (const [name, value] of Object.entries(replacements)) {
    template = template.replaceAll(`\${${name}}`, value);
  }
  if (template.includes('${'))
    throw new Error('Rendered Nginx config contains unresolved placeholders');
  return { templateName, content: template };
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entrypoint === path.resolve(fileURLToPath(import.meta.url))) {
  const outputPath = readOutputPath(process.argv.slice(2));
  if (outputPath === null) {
    process.stdout.write(renderStagingNginx().content);
  } else {
    const rendered = renderStagingNginx();
    const absoluteOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
    fs.writeFileSync(absoluteOutput, rendered.content, { encoding: 'utf8', mode: 0o600 });
    console.log(`Rendered ${rendered.templateName} to ${absoluteOutput}`);
  }
}
