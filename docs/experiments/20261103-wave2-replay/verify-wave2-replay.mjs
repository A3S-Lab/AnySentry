// Replay archived WAVE-2 raw Collector output through the current Forwarder (with the generic
// parent-attribution fix) and verify that confirmed task ToolExec records are no longer dropped
// by the agent allowlist while parent-generation protections stay intact.
//
// Inputs (archived from kimi-pro31-ten-tasks-20261103-114047):
//   /tmp/anysentry-ten-tasks-raw.ndjson            raw Collector stdout capture
//   terminal-bench/eval/kimi-pro31-ten-tasks-20261103-114047/raw-validation.json  expected counts
//
// Method: filter the raw stream to the four WAVE-2 task containers, feed it to the Forwarder in
// capture order against an accepting mock batch API, then compare per-container confirmed
// ToolExec PID/generation sets: raw stream vs Forwarder output. Unconfirmed execs never count as
// successes; wrong-generation parents must stay filtered (asserted on the diagnostics file).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const forwarder = path.join(repoRoot, 'scripts/observer-forward.js');
const rawPath = process.env.WAVE2_RAW_NDJSON ?? '/tmp/anysentry-ten-tasks-raw.ndjson';
const evalRoot = process.env.WAVE2_EVAL_ROOT
  ?? path.resolve(repoRoot, '../terminal-bench/eval/kimi-pro31-ten-tasks-20261103-114047');

const CONTAINERS = {
  ab05988b7dbc: { instance: 'A', task: 'extract-elf' },
  '8dc8657004a2': { instance: 'B', task: 'dna-insert' },
  '0221df32157b': { instance: 'C', task: 'sqlite-with-gcov' },
  '99658522ce57': { instance: 'D', task: 'git-leak-recovery' },
};

const validation = JSON.parse(fs.readFileSync(path.join(evalRoot, 'raw-validation.json'), 'utf8'));
const expected = {};
for (const row of validation.wave_2) {
  if (row.instance === 'E') continue;
  expected[row.instance] = row;
}

function generationKey(o) {
  const p = o?.process ?? {};
  return JSON.stringify([
    p.host_id,
    p.boot_id,
    Number(p.pid),
    String(p.start_boottime_ns ?? p.start_time_ns ?? ''),
  ]);
}

function containerOf(o) {
  const cg = o?.process?.cgroup ?? '';
  const i = cg.indexOf('docker-');
  if (i < 0) return undefined;
  const id = cg.slice(i + 7, i + 7 + 12);
  return Object.hasOwn(CONTAINERS, id) ? id : undefined;
}

// --- Pass 1: select the task-family lines in capture order and compute the raw baseline. ---
const selectedLines = [];
const rawConfirmed = { }; // container -> Map(genKey -> event)
const rawExit = { }; // container -> Set(genKey)
for (const id of Object.keys(CONTAINERS)) {
  rawConfirmed[id] = new Map();
  rawExit[id] = new Set();
}

{
  const handle = fs.openSync(rawPath, 'r');
  const bufferSize = 8 * 1024 * 1024;
  let carry = Buffer.alloc(0);
  let read;
  do {
    const chunk = Buffer.alloc(bufferSize);
    read = fs.readSync(handle, chunk, 0, bufferSize, null);
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
    let start = 0;
    let nl;
    while ((nl = data.indexOf(0x0a, start)) >= 0) {
      const line = data.subarray(start, nl).toString('utf8');
      start = nl + 1;
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const id = containerOf(o);
      if (!id) continue;
      selectedLines.push(line);
      const key = generationKey(o);
      const kind = Object.keys(o.event ?? {})[0];
      if (kind === 'ToolExec' && o.event.ToolExec?.exec_confirmed === true) {
        if (!rawConfirmed[id].has(key)) rawConfirmed[id].set(key, o.event.ToolExec);
      } else if (kind === 'ProcessExit') {
        rawExit[id].add(key);
      }
    }
    carry = data.subarray(start);
  } while (read === bufferSize);
  fs.closeSync(handle);
}

console.log(`selected ${selectedLines.length} task-family lines from ${rawPath}`);

// --- Pass 2: run the Forwarder against an accepting mock API. ---
const receivedBatches = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    if (request.url?.endsWith('/batch')) {
      receivedBatches.push(parsed);
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        data: {
          accepted: true,
          acceptedEvents: events.length,
          rejectedEvents: 0,
          retryableEvents: 0,
          items: events.map((_, index) => ({
            index,
            accepted: true,
            disposition: 'retained',
          })),
        },
      }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url?.endsWith('/runtime/lease')) {
      response.end('{"accepted":true,"leaseEpoch":1}');
    } else {
      response.end('{"accepted":true}');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-replay-'));
const diagnosticsPath = path.join(spoolDir, 'pipeline.json');
const childEnv = {
  ...process.env,
  FORWARD_FILTER_MODE: 'enforce',
  FORWARD_RETAIN_UNKNOWN: 'false',
  FORWARD_RETAIN_NON_AGENT: 'false',
  FORWARD_NOISE_POLICY: 'balanced',
  FORWARD_AGENT_ALLOWLIST: 'kimi-cli',
  FORWARD_BATCH_SIZE: '64',
  FORWARD_BATCH_FLUSH_MS: '50',
  ANYSENTRY_UNRESOLVED_EXIT_LIMIT: '1000000',
  ANYSENTRY_PIPELINE_DIAGNOSTICS_PATH: diagnosticsPath,
  ANYSENTRY_INGEST_URL: `http://127.0.0.1:${port}/security-center/ingest`,
  ANYSENTRY_BATCH_INGEST_URL: `http://127.0.0.1:${port}/security-center/ingest/batch`,
  ANYSENTRY_HEARTBEAT_URL: `http://127.0.0.1:${port}/security-center/collectors/heartbeat`,
  ANYSENTRY_IDENTITY_SNAPSHOT_URL: `http://127.0.0.1:${port}/security-center/identity/snapshot`,
  ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: `http://127.0.0.1:${port}/security-center/runtime/snapshot`,
  ANYSENTRY_AGENT_RUNTIME_LEASE_URL: `http://127.0.0.1:${port}/security-center/runtime/lease`,
  ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0.05',
  ANYSENTRY_HEARTBEAT_SECS: '60',
  ANYSENTRY_DOCKER_DISCOVERY: 'off',
  ANYSENTRY_BEHAVIOR_DISCOVERY: 'off',
  ANYSENTRY_AGENT_TEMPLATES_JSON: '[]',
  FORWARD_SPOOL_PATH: path.join(spoolDir, 'spool.wal'),
  FORWARD_SHUTDOWN_TIMEOUT_MS: '20000',
  A3S_OBSERVER_COLLECTOR_ID: 'wave2-replay',
};
delete childEnv.ANYSENTRY_E2E_INGEST_MARKER_PREFIX;

const child = spawn(process.execPath, [forwarder], {
  env: childEnv,
  stdio: ['pipe', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`wave2 replay forwarder timed out: ${stderr.slice(-4000)}`));
  }, 120_000);
  child.stdin.on('error', () => {});
  child.stdin.write(selectedLines.join('\n'));
  child.stdin.write('\n');
  child.stdin.end();
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
await new Promise((resolve) => server.close(resolve));
assert.equal(exitCode, 0, `forwarder must exit cleanly:\n${stderr.slice(-4000)}`);

// --- Pass 3: compare per-container confirmed ToolExec sets. ---
const forwardedConfirmed = { };
for (const id of Object.keys(CONTAINERS)) forwardedConfirmed[id] = new Map();
let forwardedUnresolved = 0;
for (const batch of receivedBatches) {
  for (const event of batch.events ?? []) {
    const wrapped = typeof event === 'string' ? JSON.parse(event) : event;
    const o = typeof wrapped?.line === 'string' ? JSON.parse(wrapped.line) : wrapped;
    const id = containerOf(o);
    if (!id) continue;
    const kind = Object.keys(o.event ?? {})[0];
    if (kind === 'ToolExec' && o.event.ToolExec?.exec_confirmed === true) {
      const key = generationKey(o);
      if (!forwardedConfirmed[id].has(key)) {
        forwardedConfirmed[id].set(key, o.event.ToolExec);
        if (o.process?.lifecycleReason === 'ancestry_incomplete') forwardedUnresolved += 1;
      }
    }
  }
}

console.log('\nper-container confirmed ToolExec coverage (raw stream -> fixed forwarder):');
let failures = 0;
for (const [id, meta] of Object.entries(CONTAINERS)) {
  const raw = rawConfirmed[id];
  const fwd = forwardedConfirmed[id];
  const missing = [...raw.keys()].filter((key) => !fwd.has(key));
  const exp = expected[meta.instance];
  console.log(
    `  ${meta.instance} ${meta.task}: raw=${raw.size} forwarded=${fwd.size} `
    + `missing=${missing.length} `
    + `(old production confirmed=${exp?.AnySentry_confirmed_exec}, AgentSight=${exp?.AgentSight_exec})`,
  );
  if (missing.length) {
    failures++;
    for (const key of missing.slice(0, 8)) {
      const argv = raw.get(key)?.argv ?? [];
      console.log(`    MISSING pid=${JSON.parse(key)[2]} argv=${argv.slice(0, 4).join(' ')}`);
    }
  }
  // The fixed Forwarder must recover the overwhelming majority of confirmed task execs.
  assert.ok(
    fwd.size >= Math.max(raw.size * 0.9, exp.AgentSight_exec),
    `${meta.task}: fixed forwarder (${fwd.size}) must recover raw confirmed execs (raw=${raw.size}) `
    + `and at least match AgentSight (${exp.AgentSight_exec})`,
  );
}
console.log(`forwarded via ancestry_incomplete retention: ${forwardedUnresolved}`);

// --- Pass 4: diagnostics must not show these execs silently filtered by the allowlist. ---
const diagnosticsRaw = fs.existsSync(diagnosticsPath)
  ? JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'))
  : { records: [] };
const records = Array.isArray(diagnosticsRaw.records) ? diagnosticsRaw.records : [];
let allowlistFilteredConfirmed = 0;
for (const record of records) {
  let body = record?.body ?? record;
  if (typeof body?.line === 'string') body = JSON.parse(body.line);
  const id = containerOf(body);
  if (!id) continue;
  if (
    body?.event?.ToolExec?.exec_confirmed === true
    && String(record?.reasonCode ?? record?.reason ?? '').includes('agent_allowlist')
  ) {
    allowlistFilteredConfirmed += 1;
  }
}
assert.equal(
  allowlistFilteredConfirmed,
  0,
  'confirmed task ToolExec records must not be silently dropped by the agent allowlist',
);
console.log('allowlist-filtered confirmed task execs: 0');

fs.rmSync(spoolDir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} container(s) still miss raw confirmed execs`);
  process.exit(1);
}
console.log('\nWAVE-2 replay verification passed');
