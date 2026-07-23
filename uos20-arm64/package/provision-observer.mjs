#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';

const [envFile, baseUrl] = process.argv.slice(2);
if (!envFile || !baseUrl) {
  console.error('usage: provision-observer.mjs <environment-file> <security-center-base-url>');
  process.exit(2);
}

const source = fs.readFileSync(envFile, 'utf8');
const values = Object.fromEntries(
  source
    .split(/\r?\n/u)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);

if (values.ANYSENTRY_SOURCE_ID && values.ANYSENTRY_INGEST_TOKEN) {
  console.log(`Preserving Observer Source: ${values.ANYSENTRY_SOURCE_ID}`);
  process.exit(0);
}
if (!values.ANYSENTRY_ADMIN_TOKEN) throw new Error('ANYSENTRY_ADMIN_TOKEN is missing');

const collectorId = values.A3S_OBSERVER_COLLECTOR_ID || `observer-${os.hostname()}`;
const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/sources`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-anysentry-admin-token': values.ANYSENTRY_ADMIN_TOKEN,
  },
  body: JSON.stringify({
    name: `UOS host Observer (${os.hostname()})`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId,
    workspacePath: values.ANYSENTRY_WORKSPACE_PATH || `host://${os.hostname()}`,
    owner: 'offline-installer',
    tags: ['uos20', 'linux-4.19', 'offline'],
  }),
});
const payload = await response.json().catch(() => ({}));
const result = payload?.data ?? payload;
if (!response.ok || !result?.source?.sourceId || !result?.token) {
  throw new Error(`Observer Source provisioning failed with HTTP ${response.status}`);
}

const replacements = {
  ANYSENTRY_SOURCE_ID: result.source.sourceId,
  ANYSENTRY_INGEST_TOKEN: result.token,
  A3S_OBSERVER_COLLECTOR_ID: collectorId,
};
const found = new Set();
const lines = source.split(/\r?\n/u).map((line) => {
  const key = line.slice(0, line.indexOf('='));
  if (!(key in replacements)) return line;
  found.add(key);
  return `${key}=${replacements[key]}`;
});
for (const [key, value] of Object.entries(replacements)) {
  if (!found.has(key)) lines.push(`${key}=${value}`);
}
const temporary = `${envFile}.tmp.${process.pid}`;
fs.writeFileSync(temporary, `${lines.join('\n').replace(/\n+$/u, '')}\n`, { mode: 0o600 });
fs.renameSync(temporary, envFile);
fs.chmodSync(envFile, 0o600);
console.log(`Provisioned protected Observer Source: ${result.source.sourceId}`);
