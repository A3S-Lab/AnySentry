#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
const adminToken = process.env.ANYSENTRY_ADMIN_TOKEN?.trim();
const componentManifest = resolve(
  process.env.ANYSENTRY_REAL_OSV_COMPONENT
    ?? process.argv[2]
    ?? 'node_modules/.pnpm/minimist@1.2.0/node_modules/minimist/package.json',
);
const startedAt = Date.now();
const packageJson = createRequire(import.meta.url)(componentManifest);
assert.equal(typeof packageJson.name, 'string');
assert.equal(typeof packageJson.version, 'string');

// The actual process chain is Node(component loaded) -> bash -> curl. The installed component
// path is an argument of the child Node Exec, producing a high-confidence runtime match before
// the direct shell child and external-egress consequence. Throttle curl so it remains alive long
// enough for asynchronous process enrichment to resolve its generation instead of racing exit.
const childProgram = `
  require(process.argv[1]);
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('/bin/bash', [
    '-c',
    'sleep 2; curl -sS --limit-rate 1 --max-time 5 -o /dev/null https://example.com/; code=$?; [ "$code" -eq 0 ] || [ "$code" -eq 28 ]; sleep 20',
  ], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
`;
const child = spawnSync(process.execPath, ['-e', childProgram, componentManifest], {
  stdio: 'inherit',
});
assert.equal(child.status, 0);

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  const payload = text ? JSON.parse(text) : undefined;
  return payload?.data ?? payload;
}

const deadline = Date.now() + Number(process.env.ANYSENTRY_STREAM_VERIFY_TIMEOUT_MS ?? 120_000);
let judgment;
while (Date.now() < deadline) {
  const findings = await request('/stream/findings', { timeType: 'last_3h', limit: 50 });
  judgment = findings.compositeJudgments?.find((item) =>
    item.ruleVersion === 'supply-chain-temporal-v2'
    && item.synthetic === false
    && item.judgedAt >= startedAt
    && item.status === 'succeeded'
    && item.evidence.some((evidence) =>
      evidence.runtimeVulnerabilities?.some((match) =>
        match.packageName === packageJson.name && match.version === packageJson.version)));
  if (judgment) break;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}

assert.ok(judgment, `real OSV Temporal Episode was not produced for ${packageJson.name}@${packageJson.version}`);
assert.equal(judgment.decisionSource, 'deterministic_rule');
assert.equal(judgment.classification, 'suspicious');
assert.equal(judgment.verdict, 'allow');
assert.equal(judgment.attackType, 'known-vulnerability-exploitation');
assert.equal(judgment.evidence.length, 3);
assert.ok(judgment.evidence.every((item) => item.processIdentity?.pid));
console.log(JSON.stringify({
  component: `${packageJson.name}@${packageJson.version}`,
  episodeId: judgment.episodeId,
  ruleVersion: judgment.ruleVersion,
  decisionSource: judgment.decisionSource,
  classification: judgment.classification,
  evidence: judgment.evidence.map((item) => ({
    eventId: item.eventId,
    executable: item.executable,
    pid: item.processIdentity?.pid,
    ppid: item.processIdentity?.ppid,
  })),
}, null, 2));
console.log('Real OSV supply-chain Temporal runtime verification passed');
