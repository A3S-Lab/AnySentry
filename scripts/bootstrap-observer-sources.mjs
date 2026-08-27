#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/u, '');
const managementToken = (process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();
const output = (process.env.ANYSENTRY_OBSERVER_AUTH_OUTPUT ?? '').trim();
const format = (process.env.ANYSENTRY_OBSERVER_AUTH_FORMAT ?? 'json').trim().toLowerCase();
const namePrefix = (process.env.ANYSENTRY_OBSERVER_SOURCE_NAME_PREFIX ?? 'managed-kubernetes-observer').trim();
const collectorIds = [...new Set(
  (process.env.ANYSENTRY_OBSERVER_COLLECTOR_IDS ?? '')
    .split(/[\n,]/u)
    .map((value) => value.trim())
    .filter(Boolean),
)];

function fail(message) {
  throw new Error(message);
}

if (!managementToken) fail('ANYSENTRY_MANAGEMENT_TOKEN is required');
if (!output) fail('ANYSENTRY_OBSERVER_AUTH_OUTPUT is required');
if (!['json', 'env'].includes(format)) fail('ANYSENTRY_OBSERVER_AUTH_FORMAT must be json or env');
if (!collectorIds.length || collectorIds.length > 1_000) fail('1..1000 Observer collector IDs are required');
if (format === 'env' && collectorIds.length !== 1) fail('env output requires exactly one collector ID');
for (const value of [namePrefix, ...collectorIds]) {
  if (!value || value.length > 180 || /[\u0000-\u001f\u007f]/u.test(value)) fail('Observer source identity is invalid');
}

async function request(route, method, body, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-anysentry-management-token': managementToken,
          'x-anysentry-actor-type': 'system',
          'x-anysentry-actor': 'observer-source-bootstrap',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`${method} ${route} returned ${response.status}`);
      const parsed = raw ? JSON.parse(raw) : undefined;
      return parsed?.data ?? parsed;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

const listed = await request('/sources/list', 'POST', { q: namePrefix, limit: 1_000 });
const existing = Array.isArray(listed?.items) ? listed.items : [];
const credentials = [];
for (const collectorId of collectorIds) {
  const name = `${namePrefix}:${collectorId}`.slice(0, 180);
  const current = existing.find((item) =>
    item?.name === name
    && item?.type === 'observer'
    && item?.collectorId === collectorId
    && item?.discovered !== true);
  let sourceId;
  let token;
  const body = {
    name,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId,
    owner: 'observer-source-bootstrap',
    environment: 'infrastructure',
    tags: ['managed-observer', 'capture-profile'],
    note: 'Managed exact Collector binding for authenticated Observer ingestion.',
  };
  if (current?.sourceId) {
    const updated = await request(`/sources/${encodeURIComponent(current.sourceId)}`, 'PUT', body);
    sourceId = updated?.source?.sourceId ?? updated?.sourceId ?? current.sourceId;
    const rotated = await request(`/sources/${encodeURIComponent(current.sourceId)}/rotate-token`, 'POST', {});
    token = rotated?.token;
  } else {
    const created = await request('/sources', 'POST', body);
    sourceId = created?.source?.sourceId ?? created?.sourceId;
    token = created?.token;
  }
  if (typeof sourceId !== 'string' || !sourceId.trim() || typeof token !== 'string' || !token.trim()) {
    fail(`AnySentry did not return managed credentials for collector ${collectorId}`);
  }
  credentials.push({ collectorId, sourceId: sourceId.trim(), token: token.trim() });
}

const parent = path.dirname(output);
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
const temporary = `${output}.tmp-${process.pid}`;
let serialized;
if (format === 'json') {
  serialized = `${JSON.stringify({
    schemaVersion: 'anysentry.observer_source_credentials.v1',
    generatedAt: new Date().toISOString(),
    credentials,
  })}\n`;
} else {
  const credential = credentials[0];
  const safe = (value) => {
    if (!/^[A-Za-z0-9._~+/:=@-]+$/u.test(value)) fail('credential contains unsupported env-file characters');
    return value;
  };
  serialized = [
    `ANYSENTRY_SOURCE_ID=${safe(credential.sourceId)}`,
    `ANYSENTRY_INGEST_TOKEN=${safe(credential.token)}`,
    `ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN=${safe(managementToken)}`,
    '',
  ].join('\n');
}
fs.writeFileSync(temporary, serialized, { mode: 0o600 });
fs.renameSync(temporary, output);
fs.chmodSync(output, 0o600);
console.log(`Managed Observer credentials written to ${output} for ${credentials.length} collector(s).`);
