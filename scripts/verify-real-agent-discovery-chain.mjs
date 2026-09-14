#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { symlink, unlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/, '');
const managementToken = String(process.env.ANYSENTRY_REAL_MANAGEMENT_TOKEN || '').trim();
const image = String(process.env.ANYSENTRY_REAL_OBSERVER_IMAGE || '').trim();
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const testStartedAt = new Date(Date.now() - 5_000).toISOString();
const collectorName = `anysentry-filter-chain-${suffix}`;
const templateName = `anysentry-template-chain-${suffix}`;
const unknownName = `anysentry-unknown-chain-${suffix}`;
const hostExecutableName = `anysentry-host-agent-${suffix}`;
const hostExecutablePath = path.join(os.tmpdir(), hostExecutableName);
const podName = `anysentry-filter-k8s-${suffix}`.slice(0, 63);
const collectorId = `real-filter-${suffix}`;
const hostMarker = `marker-host-template-${suffix}`;
const hostMarkerPath = path.join(os.tmpdir(), hostMarker);
const dockerMarker = `marker-docker-template-${suffix}`;
const unknownMarker = `marker-unknown-behavior-${suffix}`;
const k8sAgentMarker = `marker-k8s-agent-${suffix}`;
const k8sSidecarMarker = `marker-k8s-sidecar-${suffix}`;
const namespace = process.env.ANYSENTRY_REAL_K8S_NAMESPACE || 'default';
const controlNamespace = process.env.ANYSENTRY_REAL_CONTROL_NAMESPACE || 'anysentry';
const capacityGate = process.env.ANYSENTRY_REAL_CAPACITY_GATE !== 'off';
const maxApiMemoryMiB = Number(process.env.ANYSENTRY_REAL_MAX_API_MEMORY_MIB || 600);
const maxClickHouseMemoryMiB = Number(process.env.ANYSENTRY_REAL_MAX_CLICKHOUSE_MEMORY_MIB || 1_800);
const created = {
  source: false,
  collector: false,
  template: false,
  unknown: false,
  pod: false,
  hostExecutable: false,
  hostMarker: false,
};
let sourceCredentials;
let snapshotServer;
let sidecarSnapshotAttribution;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      if (options.allowFailure) {
        resolve({ code: null, signal: 'timeout', stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} timed out\n${stderr}`));
      }
    }, options.timeoutMs ?? 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    // `exit` can precede the final stdout data event for short-lived kubectl/docker commands;
    // wait for stdio `close` so capacity and cleanup decisions use complete command output.
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || options.allowFailure) {
        resolve({ code, signal, stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${signal ?? code}\n${stderr}`));
      }
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function startDetachedDocker(containerName, args, options = {}) {
  // `docker run -d` can keep the client attached while the daemon prepares a privileged
  // host-PID container. Separating create/start makes that boundary observable and keeps
  // cleanup deterministic when startup fails.
  await run('docker', ['create', ...args], options);
  await run('docker', ['start', containerName], options);
}

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(managementToken ? { 'x-anysentry-management-token': managementToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  const parsed = text ? JSON.parse(text) : undefined;
  return parsed?.data ?? parsed;
}

async function createEphemeralSource() {
  const result = await api('/sources', {
    name: `real-agent-filter-chain-${suffix}`,
    type: 'observer',
    enabled: true,
    requireToken: true,
    collectorId,
    environment: 'test',
    tags: ['verification', 'ephemeral'],
    note: 'bounded real discovery verification; disable after run',
  });
  if (!result?.source?.sourceId || !result?.token) {
    throw new Error('source registration did not return sourceId and token');
  }
  sourceCredentials = { sourceId: result.source.sourceId, token: result.token };
  created.source = true;
}

async function eventually(label, check, timeoutMs = 45_000) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let last;
  let firstError;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
      firstError ||= error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const format = (value) => value instanceof Error ? value.message : JSON.stringify(value);
  throw new Error(
    `${label} did not converge after ${Date.now() - startedAt}ms (${attempts} attempts); `
      + `first=${format(firstError)}; last=${format(last)}`,
  );
}

function memoryMiB(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)$/u);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const factor = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024 }[match[2]];
  return amount * factor;
}

async function assertSharedCapacitySample() {
  if (!capacityGate) return;
  const result = await run('kubectl', [
    '-n', controlNamespace, 'top', 'pod', '--no-headers',
  ], { allowFailure: true, timeoutMs: 10_000 });
  if (result.code !== 0) {
    throw new Error(`capacity gate could not read kubectl top; refusing real workload creation: ${result.stderr.trim()}`);
  }
  const observed = new Map();
  for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 3) continue;
    if (fields[0].startsWith('anysentry-')) observed.set('anysentry', memoryMiB(fields.at(-1)));
    else if (fields[0].startsWith('clickhouse-')) observed.set('clickhouse', memoryMiB(fields.at(-1)));
  }
  const apiMemory = observed.get('anysentry');
  const clickhouseMemory = observed.get('clickhouse');
  if (!Number.isFinite(apiMemory) || !Number.isFinite(clickhouseMemory)) {
    throw new Error(`capacity gate missing AnySentry/ClickHouse memory samples: ${JSON.stringify(Object.fromEntries(observed))}; code=${result.code}; stderr=${result.stderr.trim()}`);
  }
  if (apiMemory > maxApiMemoryMiB || clickhouseMemory > maxClickHouseMemoryMiB) {
    throw new Error(
      `capacity gate refused real workload: anysentry=${apiMemory.toFixed(1)}MiB/${maxApiMemoryMiB}MiB; `
      + `clickhouse=${clickhouseMemory.toFixed(1)}MiB/${maxClickHouseMemoryMiB}MiB`,
    );
  }
  return { apiMemory, clickhouseMemory };
}

async function assertSharedCapacity() {
  if (!capacityGate) return;
  const samples = Math.max(1, Math.min(10, Number(process.env.ANYSENTRY_REAL_CAPACITY_SAMPLES || 3)));
  const intervalMs = Math.max(100, Math.min(10_000, Number(process.env.ANYSENTRY_REAL_CAPACITY_SAMPLE_INTERVAL_MS || 1_000)));
  let latest;
  for (let index = 0; index < samples; index += 1) {
    latest = await assertSharedCapacitySample();
    if (index + 1 < samples) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.error(`[real-discovery] capacity gate passed ${samples} samples: `
    + `anysentry=${latest.apiMemory.toFixed(1)}MiB; clickhouse=${latest.clickhouseMemory.toFixed(1)}MiB`);
}

async function applyRealPod() {
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace,
      labels: {
        'anysentry.io/workload-kind': 'agent',
        'anysentry.io/agent-id': 'real-k8s-agent',
        'anysentry.io/agent-container': 'agent',
      },
    },
    spec: {
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      containers: [
        {
          name: 'agent',
          image: 'redis:7-alpine',
          imagePullPolicy: 'IfNotPresent',
          command: ['/bin/sh', '-c', 'sleep 600'],
        },
        {
          name: 'metrics',
          image: 'redis:7-alpine',
          imagePullPolicy: 'IfNotPresent',
          command: ['/bin/sh', '-c', 'sleep 600'],
        },
      ],
    },
  };
  await run('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(pod) });
  created.pod = true;
  await run(
    'kubectl',
    ['-n', namespace, 'wait', '--for=condition=Ready', `pod/${podName}`, '--timeout=60s'],
    { timeoutMs: 70_000 },
  );
  const result = await run('kubectl', ['-n', namespace, 'get', 'pod', podName, '-o', 'json']);
  return JSON.parse(result.stdout);
}

async function createSnapshotServer(pod) {
  process.env.ANYSENTRY_CLUSTER_ID = 'real-chain';
  const { KubeIdentityService } = await import(
    '../apps/api/dist/security-monitoring/kube-identity.service.js'
  );
  const service = new KubeIdentityService();
  service.podsByNamespace.set(namespace, new Map([[pod.metadata.uid, pod]]));
  service.readyNamespaces.add(namespace);
  service.rebuild();
  const snapshot = service.snapshot(pod.spec.nodeName);
  const baseProjection = await api('/filter-rules/projections/forwarder');
  const agentEntry = snapshot.entries.find((entry) => entry.containerName === 'agent');
  const sidecarEntry = snapshot.entries.find((entry) => entry.containerName === 'metrics');
  assert.equal(agentEntry?.classification, 'confirmed_agent');
  assert.equal(sidecarEntry?.classification, 'non_agent');
  sidecarSnapshotAttribution = {
    classification: sidecarEntry.classification,
    monitored: false,
    source: sidecarEntry.attributionSource ?? sidecarEntry.source,
    physicalWorkloadId: sidecarEntry.physicalWorkloadId,
    workloadRef: {
      environment: sidecarEntry.environment,
      kind: 'container',
      name: sidecarEntry.podName,
      namespace: sidecarEntry.namespace,
      podName: sidecarEntry.podName,
      podUid: sidecarEntry.podUid,
      nodeName: sidecarEntry.nodeName,
      containerName: sidecarEntry.containerName,
      containerImage: sidecarEntry.containerImage,
    },
  };
  snapshotServer = http.createServer((request, response) => {
    if (request.url?.startsWith('/filter-projection')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(discoveryProjection(baseProjection)));
      return;
    }
    if (request.url?.startsWith('/snapshot')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(snapshot));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    snapshotServer.once('error', reject);
    snapshotServer.listen(0, '0.0.0.0', resolve);
  });
  return snapshotServer.address().port;
}

async function startUnknownContainer() {
  await startDetachedDocker(unknownName, [
      '--name',
      unknownName,
      '--entrypoint',
      'node',
      image,
      '-e',
      'setInterval(() => {}, 1000)',
    ], { timeoutMs: 120_000 });
  created.unknown = true;
}

async function startTemplateContainer() {
  await startDetachedDocker(templateName, [
      '--name',
      templateName,
      '--entrypoint',
      'node',
      image,
      '-e',
      'setInterval(() => {}, 1000)',
    ], { timeoutMs: 120_000 });
  created.template = true;
}

function discoveryTemplates() {
  return [
    {
      id: 'real-host-template',
      agentId: 'real-host-template-agent',
      deployment: 'host',
      match: { command: `${hostExecutablePath}*` },
    },
    {
      id: 'real-docker-template',
      agentId: 'real-docker-template-agent',
      deployment: 'docker',
      match: { container: templateName },
    },
  ];
}

// The API projection owns runtime templates after hot load. Keep test-only bindings in the
// temporary control-plane fixture, not in an env bootstrap that the first refresh replaces.
// All capture and retention rules remain those served by the real API.
export function discoveryProjection(base, now = Date.now()) {
  const { filterRuleDigest } = require('../apps/api/dist/security-monitoring/filter-rule-builtins.js');
  const { projectionIntentDigest } = require('./observer-unified-filter-policy.js');
  const { contentHash: _hash, ...projection } = structuredClone(base);
  projection.generatedAt = new Date(now).toISOString();
  projection.expiresAt = new Date(now + 120_000).toISOString();
  projection.agentTemplates.templates.push(...discoveryTemplates());
  projection.intentHash = projectionIntentDigest(projection);
  return { ...projection, contentHash: filterRuleDigest(projection) };
}

export function collectorLaunch(snapshotPort, nodeName, credentials, controlToken, observerImage, apiBase) {
  const containerApi = apiBase.replace('127.0.0.1', 'host.docker.internal');
  // Pass values through the Docker client's environment. In particular, credentials must never
  // appear in its argv or in the command text used by error diagnostics.
  const environment = {
    A3S_OBSERVER_JSON: '1',
    A3S_OBSERVER_FILES: '1',
    A3S_OBSERVER_JSON_QUEUE_CAPACITY: '4096',
    A3S_OBSERVER_CRITICAL_INBOX_CAPACITY: '2048',
    A3S_OBSERVER_SEMANTIC_INBOX_CAPACITY: '4096',
    A3S_OBSERVER_BULK_INBOX_CAPACITY: '1024',
    A3S_OBSERVER_FILE_UNKNOWN_POLICY: 'sample',
    A3S_OBSERVER_FILE_UNKNOWN_PER_CGROUP: '4',
    A3S_OBSERVER_FILE_UNKNOWN_PER_NODE: '100',
    A3S_OBSERVER_SSL: '0',
    A3S_OBSERVER_COLLECTOR_ID: collectorId,
    A3S_NODE_NAME: nodeName,
    ANYSENTRY_INGEST_URL: `${containerApi}/ingest`,
    ANYSENTRY_SOURCE_ID: credentials.sourceId,
    ANYSENTRY_INGEST_TOKEN: credentials.token,
    ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN: controlToken,
    ANYSENTRY_IDENTITY_SNAPSHOT_URL: `http://host.docker.internal:${snapshotPort}/snapshot`,
    ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '1',
    ANYSENTRY_FILTER_RULE_PROJECTION_URL: `http://host.docker.internal:${snapshotPort}/filter-projection`,
    ANYSENTRY_HEARTBEAT_SECS: '2',
    ANYSENTRY_DOCKER_DISCOVERY: 'on',
    FORWARD_MAX_OUTSTANDING_EVENTS: '256',
    FORWARD_MAX_OUTSTANDING_BYTES: '8388608',
    FORWARD_WAL_PENDING_MAX_EVENTS: '512',
    FORWARD_WAL_PENDING_MAX_BYTES: '16777216',
    FORWARD_SCOPE: 'shadow',
    ANYSENTRY_SOURCE_TYPE: 'observer',
    ANYSENTRY_SOURCE_NAME: 'real-agent-filter-chain',
  };
  return {
    args: [
      '--name', collectorName,
      '--privileged', '--pid', 'host',
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', '/sys:/sys:ro',
      '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
      ...Object.keys(environment).flatMap((key) => ['-e', key]),
      '--entrypoint', '/usr/local/bin/node',
      observerImage, '/opt/observer-supervisor.js',
    ],
    env: environment,
  };
}

async function startCollector(snapshotPort, nodeName) {
  const launch = collectorLaunch(snapshotPort, nodeName, sourceCredentials, managementToken, image, baseUrl);
  await startDetachedDocker(collectorName, launch.args, { timeoutMs: 120_000, env: launch.env });
  created.collector = true;
  await eventually('current Observer probes and Docker discovery', async () => {
    const logs = await run('docker', ['logs', collectorName]);
    return logs.stderr.includes('probes attached') &&
      logs.stderr.includes('total') &&
      logs.stderr.includes('docker discovery: enabled=true; started=true')
      ? logs.stderr
      : undefined;
  });
  await eventually('Docker and Kubernetes identity snapshots', async () => {
    const health = await api('/collectors/health', {
      timeType: 'last_1h',
      collectorId,
      limit: 5,
    });
    const metrics = health.items?.[0]?.filterMetrics;
    return metrics?.dockerReady &&
      metrics.templateLoaded >= 2 &&
      metrics.identitySnapshotReady
      ? metrics
      : undefined;
  });
}

async function triggerScenarios() {
  await symlink('/bin/sh', hostExecutablePath);
  created.hostExecutable = true;
  await run(hostExecutablePath, ['-c', `printf '%s' ${hostMarker} >${hostMarkerPath}; sleep 2`]);
  created.hostMarker = true;

  await run('docker', [
    'exec',
    templateName,
    '/bin/sh',
    '-c',
    `printf '%s' ${dockerMarker} >/tmp/${dockerMarker}; sleep 2`,
  ]);

  // Keep each phase alive briefly. Observer exports exec, connect and file records from
  // independent ring buffers, so zero-lifetime processes make the intended causal order depend
  // on scheduler timing rather than the real behavior sequence we want this test to validate.
  await run('docker', ['exec', unknownName, '/bin/sleep', '2']);
  await run(
    'docker',
    [
      'exec',
      unknownName,
      'node',
      '-e',
      "const https=require('https');const done=()=>setTimeout(()=>process.exit(0),1500);const r=https.get('https://api.openai.com/',(res)=>{res.resume();done()});r.on('error',done);setTimeout(()=>process.exit(0),5000)",
    ],
    { timeoutMs: 10_000, allowFailure: true },
  );
  await run('docker', [
    'exec',
    unknownName,
    '/bin/sh',
    '-c',
    `printf '%s' ${unknownMarker} >/tmp/${unknownMarker}; sleep 2`,
  ]);
  // The file write completes tool A -> network/decision -> tool B -> workspace change.
  // Verify a later tool inherits the resulting probable identity instead of accepting raw
  // exec/file volume as sufficient evidence.
  await run('docker', [
    'exec',
    unknownName,
    '/bin/echo',
    unknownMarker,
  ]);

  await run('kubectl', [
    '-n',
    namespace,
    'exec',
    podName,
    '-c',
    'agent',
    '--',
    '/bin/sh',
    '-c',
    // Keep the first observed process in this container alive long enough for Observer to read
    // its full cgroup path and establish cgroup_id -> Container ID. A genuinely shorter first
    // event can only carry cgroup_id and must remain fail-open unknown until such a binding exists.
    `printf '%s' ${k8sAgentMarker} >/tmp/${k8sAgentMarker}; sleep 2`,
  ]);
  await run('kubectl', [
    '-n',
    namespace,
    'exec',
    podName,
    '-c',
    'metrics',
    '--',
    '/bin/sh',
    '-c',
    // Emit spaced child processes after the shell starts. On a busy host the first exec event may
    // precede /proc cgroup enrichment; a later child must still inherit the authoritative sidecar
    // identity. Distinct arguments keep this a lineage/identity test instead of a dedup test.
    `printf '%s' ${k8sSidecarMarker} >/tmp/${k8sSidecarMarker}; sleep 1; /bin/echo ${k8sSidecarMarker}-1; sleep 1; /bin/echo ${k8sSidecarMarker}-2; sleep 1`,
  ]);
}

async function matchingEvents() {
  const find = async (marker, predicate) => {
    const result = await api('/events/list', {
      timeType: 'custom', startTime: testStartedAt, endTime: new Date().toISOString(),
      collectorId, includeBenign: true, eventKind: 'ToolExec', scope: 'raw', q: marker, limit: 10,
    });
    const candidates = result.items?.filter(
      (candidate) => JSON.stringify(candidate).includes(marker),
    ) ?? [];
    return {
      total: result.total,
      event: candidates.find(predicate),
      observed: candidates.slice(0, 5).map((candidate) => ({
        eventId: candidate.eventId,
        subject: candidate.subject,
        process: candidate.process,
        attribution: candidate.attribution,
      })),
    };
  };
  const host = await find(hostMarker, (event) => event.attribution?.source === 'self_register');
  const docker = await find(dockerMarker, (event) => event.attribution?.source === 'self_register');
  const unknown = await find(unknownMarker, (event) => event.attribution?.source === 'behavior');
  const k8sAgent = await find(
      k8sAgentMarker,
      (event) =>
        event.attribution?.source === 'self_register' &&
      event.attribution?.classification === 'confirmed_agent',
  );
  return {
    total: result.total,
    host: host.event,
    docker: docker.event,
    unknown: unknown.event,
    k8sAgent: k8sAgent.event,
    observed: {
      host: host.observed,
      docker: docker.observed,
      unknown: unknown.observed,
      k8sAgent: k8sAgent.observed,
    },
  };
}

async function verifyResults() {
  let lastEvents;
  let events;
  try {
    // Authoritative non-Agent events are intentionally rejected before ClickHouse ingestion.
    // Verify the four retained identities here and the Kubernetes sidecar via snapshot/counters.
    events = await eventually('four retained real scenario events', async () => {
      const current = await matchingEvents();
      lastEvents = current;
      return current.host &&
        current.docker &&
        current.unknown &&
        current.k8sAgent
        ? current
        : undefined;
    });
  } catch (error) {
    error.message += `; scenario state=${JSON.stringify({
      total: lastEvents?.total,
      host: Boolean(lastEvents?.host),
      docker: Boolean(lastEvents?.docker),
      unknown: Boolean(lastEvents?.unknown),
      k8sAgent: Boolean(lastEvents?.k8sAgent),
      observed: lastEvents?.observed,
    })}`;
    throw error;
  }
  console.log(JSON.stringify({
    observedAttribution: {
      host: events.host.attribution,
      docker: events.docker.attribution,
      unknown: events.unknown.attribution,
      k8sAgent: events.k8sAgent.attribution,
      k8sSidecar: sidecarSnapshotAttribution,
    },
  }, null, 2));
  assert.equal(events.host.attribution?.classification, 'confirmed_agent');
  assert.equal(events.host.attribution?.agentScopeId, 'real-host-template-agent');
  assert.equal(events.host.attribution?.source, 'self_register');
  assert.equal(events.docker.attribution?.classification, 'confirmed_agent');
  assert.equal(events.docker.attribution?.agentScopeId, 'real-docker-template-agent');
  assert.equal(events.docker.attribution?.source, 'self_register');
  assert.equal(events.unknown.attribution?.classification, 'probable_agent');
  assert.equal(events.unknown.attribution?.source, 'behavior');
  assert.equal(events.k8sAgent.attribution?.classification, 'confirmed_agent');
  assert.equal(events.k8sAgent.attribution?.agentScopeId, 'real-k8s-agent');
  assert.equal(events.k8sAgent.attribution?.source, 'kubernetes');
  assert.equal(sidecarSnapshotAttribution?.classification, 'non_agent');
  assert.equal(sidecarSnapshotAttribution?.monitored, false);

  const heartbeat = await eventually('structured real collector heartbeat', async () => {
    const health = await api('/collectors/health', {
      timeType: 'last_30d',
      collectorId,
      limit: 5,
    });
    const item = health.items?.[0];
    return item?.filterMetrics?.dockerReady &&
      item.filterMetrics.behaviorCandidates >= 1 &&
      item.filterMetrics.identityCgroupHits > 0 &&
      item.filterMetrics.nonAgent > 0 &&
      item.filterMetrics.wouldFilterNonAgent > 0
      ? item
      : undefined;
  });
  console.log(JSON.stringify({
    collectorId,
    events: {
      hostTemplate: events.host.attribution,
      dockerTemplate: events.docker.attribution,
      unknownBehavior: events.unknown.attribution,
      kubernetesAgent: events.k8sAgent.attribution,
      kubernetesSidecar: sidecarSnapshotAttribution,
    },
    filterMetrics: heartbeat.filterMetrics,
  }, null, 2));
  assert.equal(heartbeat.filterMetrics.queueDropped, 0);
  assert.ok(
    heartbeat.filterMetrics.processCacheHits > 0,
    'real numeric Observer ProcessKey facts did not produce a process cache hit',
  );
  assert.ok(
    heartbeat.filterMetrics.processFallbackProcReads <
      heartbeat.filterMetrics.processClassifications,
    'current-process /proc fallback ran for every classified event',
  );
}

async function cleanup() {
  // A timed-out `docker run` can create its container before the CLI returns. Always remove all
  // exact, run-unique names even when the corresponding creation flag was not set.
  await run(
    'docker',
    ['rm', '-f', collectorName, unknownName, templateName],
    { allowFailure: true, timeoutMs: 120_000 },
  );
  if (created.pod) {
    await run(
      'kubectl',
      ['-n', namespace, 'delete', 'pod', podName, '--wait=true', '--timeout=30s'],
      { timeoutMs: 40_000, allowFailure: true },
    );
  }
  if (created.hostExecutable) {
    await unlink(hostExecutablePath).catch(() => {});
  }
  if (created.hostMarker) {
    await unlink(hostMarkerPath).catch(() => {});
  }
  if (snapshotServer) {
    await new Promise((resolve) => snapshotServer.close(resolve));
  }
  if (created.source && sourceCredentials?.sourceId) {
    await api(`/sources/${encodeURIComponent(sourceCredentials.sourceId)}`, {
      enabled: false,
      note: 'disabled after bounded real discovery verification',
    }, 'PUT').catch((error) => {
      console.error(`[real-discovery] source cleanup failed: ${error.message}`);
    });
  }
}

async function main() {
try {
  if (!managementToken) {
    throw new Error('ANYSENTRY_REAL_MANAGEMENT_TOKEN is required; refusing to create test workloads without control-plane auth');
  }
  if (!image) {
    throw new Error('ANYSENTRY_REAL_OBSERVER_IMAGE is required; refusing to use an unverified Observer image');
  }
  await assertSharedCapacity();
  console.error(`[real-discovery] API probe: ${baseUrl}/stats`);
  await api('/stats');
  await createEphemeralSource();
  // Create Docker workloads before the finite-lived Kubernetes fixture. Slow local Docker
  // storage must not consume the Pod's entire test lifetime before collection starts.
  console.error(`[real-discovery] starting template workload: ${templateName}`);
  await startTemplateContainer();
  console.error(`[real-discovery] starting unknown workload: ${unknownName}`);
  await startUnknownContainer();
  console.error(`[real-discovery] creating Kubernetes workload: ${podName}`);
  const pod = await applyRealPod();
  const snapshotPort = await createSnapshotServer(pod);
  console.error(`[real-discovery] starting collector: ${collectorName}`);
  await startCollector(snapshotPort, pod.spec.nodeName);
  console.error('[real-discovery] collector ready; triggering scenarios');
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await triggerScenarios();
  await verifyResults();
  console.log('Real Host/Docker/Kubernetes Agent discovery chain verification passed');
} finally {
  await cleanup();
}

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
