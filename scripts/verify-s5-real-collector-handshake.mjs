#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  FilterRulePublisher,
  CAPTURE_PROFILE_CAPABILITIES,
  CAPTURE_PROFILE_ACK_SCHEMA,
  digest,
} = require('./observer-filter-rules.js');
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const observerBinary = path.resolve(
  process.env.ANYSENTRY_OBSERVER_BIN
    ?? path.join(repoRoot, '../Observer/target/release/a3s-observer-collector'),
);
assert(fs.statSync(observerBinary).isFile(), `Observer binary not found: ${observerBinary}`);

function currentCgroupId() {
  const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((value) => value.startsWith('0::'));
  assert(line, 'cgroup v2 is required');
  const relative = line.slice(3);
  return fs.statSync(path.join('/sys/fs/cgroup', relative), { bigint: true }).ino.toString();
}

function command(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${args.join(' ')} exited ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

async function eventually(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError}` : ''}`);
}

function readAck(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function copyAckFromContainer(container, hostFile) {
  const raw = await command([
    'docker', 'exec', container, 'cat', '/run/anysentry-filter/rules.ack.json',
  ], 10_000);
  const parsed = JSON.parse(raw);
  // The production Collector and Forwarder share one root-owned container. This host-side test
  // runs the publisher as an unprivileged user, so atomically replace the 0640 root-owned ACK with
  // the exact bytes read from the container before exercising the real Forwarder validator.
  const temporary = `${hostFile}.host-${process.pid}`;
  fs.writeFileSync(temporary, `${raw}\n`, { mode: 0o640 });
  fs.renameSync(temporary, hostFile);
  return parsed;
}

function collectorArgs(name, directory) {
  return [
    'docker', 'run', '-d', '--name', name, '--privileged', '--pid', 'host',
    '-v', '/sys:/sys:ro',
    '-v', `${observerBinary}:/usr/local/bin/a3s-observer-collector:ro`,
    '-v', `${directory}:/run/anysentry-filter`,
    'ubuntu:24.04', 'env',
    'A3S_OBSERVER_JSON=1',
    'A3S_OBSERVER_FILE_ACCESS=1',
    'A3S_OBSERVER_FILE_DELETE=0',
    'A3S_OBSERVER_COLLECTOR_ID=collector-a',
    'A3S_NODE_NAME=node-a',
    'ANYSENTRY_CAPTURE_PROFILE_MODE=enforce',
    'ANYSENTRY_FILTER_RULES_FILE=/run/anysentry-filter/rules.json',
    'ANYSENTRY_FILTER_RULES_ACK_FILE=/run/anysentry-filter/rules.ack.json',
    '/usr/local/bin/a3s-observer-collector',
  ];
}

function parseEvents(logs) {
  return logs.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anysentry-s5-real-handshake-'));
const rulesFile = path.join(directory, 'rules.json');
const ackFile = path.join(directory, 'rules.ack.json');
const suffix = `${process.pid}-${Date.now()}`;
const firstName = `anysentry-s5-handshake-a-${suffix}`;
const secondName = `anysentry-s5-handshake-b-${suffix}`;
let firstExists = false;
let secondExists = false;
const now = Date.now;

try {
  const cgroupId = currentCgroupId();
  const publisher = new FilterRulePublisher({
    file: rulesFile,
    ackFile,
    captureProfileMode: 'enforce',
    publisherInstanceId: `publisher-${suffix}`,
    nodeId: 'node-a',
    collectorId: 'collector-a',
    hostBootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    now,
    flushIntervalMs: 5_000,
    ttlMs: 300_000,
    ackMaxAgeMs: 300_000,
  });
  const desiredProbeActions = {
    exec: 'full', exit: 'full', tls: 'aggregate', connect: 'aggregate', dns: 'aggregate',
    file_access: 'drop', file_delete: 'sample', llm: 'aggregate', ssl: 'aggregate', security: 'full',
  };
  publisher.synchronizePolicyDecisions([{
    scopeType: 'cgroup',
    scopeKey: `cgroup:${cgroupId}`,
    cgroupId,
    classification: 'non_agent',
    authority: 'authoritative',
    action: 'drop',
    reasonCode: 'real_handshake_fixture',
    source: 'platform_inventory',
    physicalWorkloadId: `host:test:${cgroupId}`,
    ruleId: 'real-handshake-rule',
    ruleRevision: 1,
    materializationId: 'real-handshake-materialization',
    policyVersion: 7,
    captureProfile: 'infrastructure_aggregate',
    desiredProbeActions,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }], 7);
  publisher.flush();
  const preview = publisher.publishedSnapshot();
  assert.equal(preview.activation.mode, 'preview');

  await command(collectorArgs(firstName, directory));
  firstExists = true;
  const previewAck = await eventually('real Collector preview ACK', async () => {
    if (!fs.existsSync(ackFile)) return undefined;
    const value = await copyAckFromContainer(firstName, ackFile);
    return value.epoch === preview.epoch && value.status === 'applied' ? value : undefined;
  }, 45_000);
  assert.equal(previewAck.schemaVersion, CAPTURE_PROFILE_ACK_SCHEMA);
  assert.equal(previewAck.destructiveEnabled, false);
  assert.deepEqual(previewAck.downgrades, []);
  assert.deepEqual(previewAck.capabilities.probeNames, CAPTURE_PROFILE_CAPABILITIES.probeNames);
  assert.equal(previewAck.capabilitiesHash, digest(previewAck.capabilities));
  assert.equal(publisher.consumeAckFile().accepted, true);
  const request = publisher.materializationReport();
  assert.equal(request.bindings.length, 1);
  const central = {
    ...request,
    accepted: true,
    reportId: `report-${suffix}`,
    filterRuleEntries: [{
      scopeKey: `cgroup:${cgroupId}`,
      cgroupId,
      ruleId: 'real-handshake-rule',
      ruleRevision: 1,
      physicalWorkloadId: `host:test:${cgroupId}`,
      action: 'drop',
    }],
  };
  assert.equal(publisher.acceptCentralMaterialization(previewAck, central), true);
  publisher.flush();
  const enforceSnapshot = publisher.publishedSnapshot();
  assert.equal(enforceSnapshot.activation.mode, 'enforce');
  const enforceAck = await eventually('generation-bound destructive ACK', async () => {
    const value = await copyAckFromContainer(firstName, ackFile);
    return value.epoch === enforceSnapshot.epoch && value.status === 'applied' && value.destructiveEnabled === true
      ? value
      : undefined;
  }, 30_000);
  assert.deepEqual(enforceAck.downgrades, []);

  const marker = path.join(os.tmpdir(), `anysentry-s5-handshake-marker-${suffix}`);
  for (let index = 0; index < 200; index += 1) {
    const fd = fs.openSync(marker, 'w');
    fs.closeSync(fd);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await command(['docker', 'stop', '--timeout', '15', firstName], 30_000);
  const firstLogs = await command(['docker', 'logs', firstName], 30_000);
  const firstEvents = parseEvents(firstLogs);
  const aggregate = firstEvents
    .map((event) => event.event?.CaptureAggregate)
    .find((value) => value?.cgroupId === Number(cgroupId) && value.probe === 'file_access' && value.effectiveAction === 'drop');
  assert(aggregate?.count >= 200, 'enforced DROP must emit an exact CaptureAggregate');
  const finalHeartbeat = firstEvents.map((event) => event.event?.CollectorHeartbeat).filter(Boolean).at(-1);
  assert.equal(finalHeartbeat.shutdown_final, true);
  assert.equal(finalHeartbeat.captureProfile.destructiveEnabled, true);
  assert.equal(finalHeartbeat.captureProfile.probes.find((probe) => probe.probe === 'file_access').ringDropped, 0);
  fs.rmSync(marker, { force: true });
  await command(['docker', 'rm', firstName]);
  firstExists = false;

  // Replaying the still-valid snapshot in a new Collector process must fail the generation fence
  // and stay discovery-safe until a fresh preview is acknowledged.
  await command(collectorArgs(secondName, directory));
  secondExists = true;
  const restartedAck = await eventually('restart generation-fence ACK', async () => {
    const value = await copyAckFromContainer(secondName, ackFile);
    return value.epoch === enforceSnapshot.epoch
      && value.collectorInstanceId !== enforceAck.collectorInstanceId
      ? value
      : undefined;
  }, 45_000);
  assert.equal(restartedAck.status, 'applied');
  assert.equal(restartedAck.destructiveEnabled, false);
  assert(restartedAck.downgrades.some((reason) =>
    reason === 'activation_grant_collector_instance_mismatch'
    || reason === 'preview_not_seen_by_current_instance'));
  await command(['docker', 'stop', '--timeout', '15', secondName], 30_000);
  await command(['docker', 'rm', secondName]);
  secondExists = false;
  publisher.close();
  console.log(JSON.stringify({
    previewEpoch: preview.epoch,
    enforceEpoch: enforceSnapshot.epoch,
    collectorRestartFenced: true,
    aggregateDropCount: aggregate.count,
    ringDropped: 0,
  }));
  console.log('S5 real Collector preview/ACK/grant/restart E2E passed');
} finally {
  if (firstExists) {
    await command(['docker', 'stop', '--timeout', '5', firstName], 15_000).catch(() => {});
    await command(['docker', 'rm', '-f', firstName], 15_000).catch(() => {});
  }
  if (secondExists) {
    await command(['docker', 'stop', '--timeout', '5', secondName], 15_000).catch(() => {});
    await command(['docker', 'rm', '-f', secondName], 15_000).catch(() => {});
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
