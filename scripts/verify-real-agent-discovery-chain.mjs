#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { symlink, unlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/, '');
const image = process.env.ANYSENTRY_REAL_OBSERVER_IMAGE || 'anysentry-observer:agent-filter-test';
const suffix = `${Date.now().toString(36)}-${process.pid}`;
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
const created = {
  collector: false,
  template: false,
  unknown: false,
  pod: false,
  hostExecutable: false,
  hostMarker: false,
};
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
    child.once('exit', (code, signal) => {
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

async function api(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  const parsed = text ? JSON.parse(text) : undefined;
  return parsed?.data ?? parsed;
}

async function eventually(label, check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not converge: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
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
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      unknownName,
      '--entrypoint',
      'node',
      image,
      '-e',
      'setInterval(() => {}, 1000)',
    ],
    { timeoutMs: 120_000 },
  );
  created.unknown = true;
}

async function startTemplateContainer() {
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      templateName,
      '--entrypoint',
      'node',
      image,
      '-e',
      'setInterval(() => {}, 1000)',
    ],
    { timeoutMs: 120_000 },
  );
  created.template = true;
}

async function startCollector(snapshotPort, nodeName) {
  const containerApi = baseUrl.replace('127.0.0.1', 'host.docker.internal');
  const templates = JSON.stringify([
    {
      id: 'real-host-template',
      agentId: 'real-host-template-agent',
      deployment: 'host',
      name: hostExecutableName,
    },
    {
      id: 'real-docker-template',
      agentId: 'real-docker-template-agent',
      deployment: 'docker',
      name: templateName,
    },
  ]);
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      collectorName,
      '--privileged',
      '--pid',
      'host',
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      '/sys:/sys:ro',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock:ro',
      '-e',
      'A3S_OBSERVER_JSON=1',
      '-e',
      'A3S_OBSERVER_FILES=1',
      '-e',
      'A3S_OBSERVER_SSL=0',
      '-e',
      `A3S_OBSERVER_COLLECTOR_ID=${collectorId}`,
      '-e',
      `A3S_NODE_NAME=${nodeName}`,
      '-e',
      `ANYSENTRY_INGEST_URL=${containerApi}/ingest`,
      '-e',
      `ANYSENTRY_IDENTITY_SNAPSHOT_URL=http://host.docker.internal:${snapshotPort}/snapshot`,
      '-e',
      'ANYSENTRY_IDENTITY_SNAPSHOT_SECS=1',
      '-e',
      'ANYSENTRY_HEARTBEAT_SECS=2',
      '-e',
      'ANYSENTRY_DOCKER_DISCOVERY=on',
      '-e',
      'FORWARD_SCOPE=shadow',
      '-e',
      `ANYSENTRY_AGENT_TEMPLATES_JSON=${templates}`,
      '-e',
      'ANYSENTRY_SOURCE_TYPE=observer',
      '-e',
      'ANYSENTRY_SOURCE_NAME=real-agent-filter-chain',
      '--entrypoint',
      '/usr/local/bin/node',
      image,
      '/opt/observer-supervisor.js',
    ],
    { timeoutMs: 120_000 },
  );
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
      timeType: 'last_30d',
      collectorId,
      limit: 5,
    });
    const metrics = health.items?.[0]?.filterMetrics;
    return metrics?.dockerReady &&
      metrics.templateMatches >= 1 &&
      metrics.identitySnapshotReady
      ? metrics
      : undefined;
  });
}

async function triggerScenarios() {
  await symlink('/bin/sh', hostExecutablePath);
  created.hostExecutable = true;
  await run(hostExecutablePath, ['-c', `printf '%s' ${hostMarker} >${hostMarkerPath}`]);
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
      timeType: 'last_30d',
      collectorId,
      includeBenign: true,
      eventKind: 'ToolExec',
      scope: 'raw',
      q: marker,
      limit: 20,
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
  const [host, docker, unknown, k8sAgent] = await Promise.all([
    find(hostMarker, (event) => event.attribution?.source === 'self_register'),
    find(dockerMarker, (event) => event.attribution?.source === 'self_register'),
    find(unknownMarker, (event) => event.attribution?.source === 'behavior'),
    find(
      k8sAgentMarker,
      (event) =>
        event.attribution?.source === 'kubernetes' &&
        event.attribution?.classification === 'confirmed_agent',
    ),
  ]);
  return {
    total: host.total + docker.total + unknown.total + k8sAgent.total,
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
}

try {
  await api('/stats');
  // Create Docker workloads before the finite-lived Kubernetes fixture. Slow local Docker
  // storage must not consume the Pod's entire test lifetime before collection starts.
  await startTemplateContainer();
  await startUnknownContainer();
  const pod = await applyRealPod();
  const snapshotPort = await createSnapshotServer(pod);
  await startCollector(snapshotPort, pod.spec.nodeName);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await triggerScenarios();
  await verifyResults();
  console.log('Real Host/Docker/Kubernetes Agent discovery chain verification passed');
} finally {
  await cleanup();
}
