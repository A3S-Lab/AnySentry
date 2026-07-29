#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/, '');
const image = process.env.ANYSENTRY_REAL_OBSERVER_IMAGE || 'anysentry-observer:agent-filter-test';
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const collectorName = `anysentry-filter-chain-${suffix}`;
const templateName = `anysentry-template-chain-${suffix}`;
const unknownName = `anysentry-unknown-chain-${suffix}`;
const podName = `anysentry-filter-k8s-${suffix}`.slice(0, 63);
const collectorId = `real-filter-${suffix}`;
const dockerMarker = `marker-docker-template-${suffix}`;
const unknownMarker = `marker-unknown-behavior-${suffix}`;
const k8sAgentMarker = `marker-k8s-agent-${suffix}`;
const k8sSidecarMarker = `marker-k8s-sidecar-${suffix}`;
const namespace = process.env.ANYSENTRY_REAL_K8S_NAMESPACE || 'default';
const created = { collector: false, template: false, unknown: false, pod: false };
let snapshotServer;

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
      reject(new Error(`${command} ${args.join(' ')} timed out\n${stderr}`));
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
          command: ['/bin/sh', '-c', 'sleep 180'],
        },
        {
          name: 'metrics',
          image: 'redis:7-alpine',
          imagePullPolicy: 'IfNotPresent',
          command: ['/bin/sh', '-c', 'sleep 180'],
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
  await run('docker', [
    'run',
    '-d',
    '--name',
    unknownName,
    '--entrypoint',
    'node',
    image,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  created.unknown = true;
}

async function startTemplateContainer() {
  await run('docker', [
    'run',
    '-d',
    '--name',
    templateName,
    '--entrypoint',
    'node',
    image,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  created.template = true;
}

async function startCollector(snapshotPort, nodeName) {
  const containerApi = baseUrl.replace('127.0.0.1', 'host.docker.internal');
  const templates = JSON.stringify([
    {
      id: 'real-docker-template',
      agentId: 'real-docker-template-agent',
      deployment: 'docker',
      name: templateName,
    },
  ]);
  await run('docker', [
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
    'A3S_OBSERVER_FILES=0',
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
    '/bin/sh',
    image,
    '-c',
    'a3s-observer-collector | node /opt/observer-forward.js',
  ]);
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
  await run('docker', [
    'exec',
    templateName,
    '/bin/sh',
    '-c',
    `printf '%s' ${dockerMarker} >/tmp/${dockerMarker}`,
  ]);

  await run('docker', ['exec', unknownName, '/bin/sh', '-c', 'true']);
  await run(
    'docker',
    [
      'exec',
      unknownName,
      'node',
      '-e',
      "const https=require('https');const r=https.get('https://api.openai.com/',()=>process.exit(0));r.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),3000)",
    ],
    { timeoutMs: 10_000, allowFailure: true },
  );
  await run('docker', [
    'exec',
    unknownName,
    '/bin/sh',
    '-c',
    `printf '%s' ${unknownMarker} >/tmp/${unknownMarker}`,
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
    `printf '%s' ${k8sAgentMarker} >/tmp/${k8sAgentMarker}`,
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
    `printf '%s' ${k8sSidecarMarker} >/tmp/${k8sSidecarMarker}`,
  ]);
}

async function matchingEvents() {
  const result = await api('/events/list', {
    timeType: 'last_30d',
    collectorId,
    includeBenign: true,
    eventKind: 'ToolExec',
    scope: 'raw',
    limit: 200,
  });
  const items = result.items ?? [];
  const find = (marker, predicate) => items.find(
    (event) => JSON.stringify(event).includes(marker) && predicate(event),
  );
  return {
    total: result.total,
    docker: find(
      dockerMarker,
      (event) => event.attribution?.source === 'self_register',
    ),
    unknown: find(
      unknownMarker,
      (event) => event.attribution?.source === 'behavior',
    ),
    k8sAgent: find(
      k8sAgentMarker,
      (event) =>
        event.attribution?.source === 'kubernetes' &&
        event.attribution?.classification === 'confirmed_agent',
    ),
    k8sSidecar: find(
      k8sSidecarMarker,
      (event) =>
        event.attribution?.source === 'kubernetes' &&
        event.attribution?.classification === 'non_agent',
    ),
  };
}

async function verifyResults() {
  const events = await eventually('four real scenario events', async () => {
    const current = await matchingEvents();
    return current.docker && current.unknown && current.k8sAgent && current.k8sSidecar
      ? current
      : undefined;
  });
  console.log(JSON.stringify({
    observedAttribution: {
      docker: events.docker.attribution,
      unknown: events.unknown.attribution,
      k8sAgent: events.k8sAgent.attribution,
      k8sSidecar: events.k8sSidecar.attribution,
    },
  }, null, 2));
  assert.equal(events.docker.attribution?.classification, 'confirmed_agent');
  assert.equal(events.docker.attribution?.agentScopeId, 'real-docker-template-agent');
  assert.equal(events.docker.attribution?.source, 'self_register');
  assert.equal(events.unknown.attribution?.classification, 'probable_agent');
  assert.equal(events.unknown.attribution?.source, 'behavior');
  assert.equal(events.k8sAgent.attribution?.classification, 'confirmed_agent');
  assert.equal(events.k8sAgent.attribution?.agentScopeId, 'real-k8s-agent');
  assert.equal(events.k8sAgent.attribution?.source, 'kubernetes');
  assert.equal(events.k8sSidecar.attribution?.classification, 'non_agent');
  assert.equal(events.k8sSidecar.attribution?.monitored, false);

  const heartbeat = await eventually('structured real collector heartbeat', async () => {
    const health = await api('/collectors/health', {
      timeType: 'last_30d',
      collectorId,
      limit: 5,
    });
    const item = health.items?.[0];
    return item?.filterMetrics?.dockerReady &&
      item.filterMetrics.behaviorCandidates >= 1 &&
      item.filterMetrics.identityCgroupHits > 0
      ? item
      : undefined;
  });
  console.log(JSON.stringify({
    collectorId,
    events: {
      dockerTemplate: events.docker.attribution,
      unknownBehavior: events.unknown.attribution,
      kubernetesAgent: events.k8sAgent.attribution,
      kubernetesSidecar: events.k8sSidecar.attribution,
    },
    filterMetrics: heartbeat.filterMetrics,
  }, null, 2));
}

async function cleanup() {
  if (created.collector) {
    await run('docker', ['stop', '--time', '5', collectorName], {
      timeoutMs: 15_000,
      allowFailure: true,
    });
    await run('docker', ['rm', '-f', collectorName], { allowFailure: true });
  }
  if (created.unknown) {
    await run('docker', ['rm', '-f', unknownName], { allowFailure: true });
  }
  if (created.template) {
    await run('docker', ['rm', '-f', templateName], { allowFailure: true });
  }
  if (created.pod) {
    await run(
      'kubectl',
      ['-n', namespace, 'delete', 'pod', podName, '--wait=true', '--timeout=30s'],
      { timeoutMs: 40_000, allowFailure: true },
    );
  }
  if (snapshotServer) {
    await new Promise((resolve) => snapshotServer.close(resolve));
  }
}

try {
  await api('/stats');
  const pod = await applyRealPod();
  const snapshotPort = await createSnapshotServer(pod);
  await startTemplateContainer();
  await startUnknownContainer();
  await startCollector(snapshotPort, pod.spec.nodeName);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await triggerScenarios();
  await verifyResults();
  console.log('Real Host/Docker/Kubernetes Agent discovery chain verification passed');
} finally {
  await cleanup();
}
