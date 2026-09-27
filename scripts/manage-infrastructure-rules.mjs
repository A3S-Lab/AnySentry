#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

const command = process.argv[2] || 'status';
const api = (process.env.ANYSENTRY_API_URL || 'http://127.0.0.1:29653').replace(/\/+$/u, '');
const projectFilter = process.env.ANYSENTRY_INFRA_COMPOSE_PROJECT || '';
const nodeId = process.env.ANYSENTRY_INFRA_NODE_ID || hostname();
const clusterId = process.env.ANYSENTRY_CLUSTER_ID || 'default-cluster';
const managementToken = process.env.ANYSENTRY_MANAGEMENT_TOKEN || '';
const author = process.env.ANYSENTRY_INFRA_AUTHOR || 'infrastructure-inventory-controller';
const approver = process.env.ANYSENTRY_INFRA_APPROVER || 'infrastructure-rule-approver';

const knownDockerServices = new Set((process.env.ANYSENTRY_INFRA_DOCKER_SERVICES || [
  'anysentry',
  'fast-judge',
  'l3-worker',
  'stream-worker',
  'composite-judge',
  'supply-chain-assessment',
  'web',
  'observer',
  'clickhouse',
  'kafka',
  'redis',
  'postgres',
  'flink-jobmanager',
  'flink-taskmanager',
  'flink-job-submit',
  'etcd',
  'minio',
  'rustfs',
  'api',
  'gateway',
  'registry',
  'nginx',
].join(',')).split(',').map((value) => value.trim()).filter(Boolean));

const knownKubernetesWorkloads = new Set([
  'kube-system/Deployment/coredns/coredns',
  'a3s/Deployment/a3s-api/api',
  'a3s/Deployment/a3s-gateway/gateway',
  'a3s/Deployment/a3s-registry/registry',
  'a3s/Deployment/a3s-web/nginx',
  'a3s/Deployment/clickhouse/clickhouse',
  'a3s/StatefulSet/etcd/etcd',
  'a3s/StatefulSet/postgres/postgres',
  'a3s/Deployment/redis/redis',
  'a3s/Deployment/rustfs/rustfs',
  'anysentry/Deployment/clickhouse/clickhouse',
  'anysentry/Deployment/anysentry/anysentry',
  'anysentry/Deployment/composite-judge/composite-judge',
  'anysentry/Deployment/fast-judge/fast-judge',
  'anysentry/Deployment/flink-job-submit/job-submit',
  'anysentry/Deployment/flink-jobmanager/jobmanager',
  'anysentry/Deployment/flink-taskmanager/taskmanager',
  'anysentry/StatefulSet/kafka/kafka',
  'anysentry/Job/kafka-topic-manager/topic-manager',
  'anysentry/Deployment/l3-worker/l3-worker',
  'anysentry/StatefulSet/redis/redis',
  'anysentry/Deployment/stream-worker/stream-worker',
  'anysentry/Deployment/supply-chain-assessment/supply-chain-assessment',
  'anysentry/DaemonSet/a3s-observer/a3s-observer',
]);

const knownHostUnits = (process.env.ANYSENTRY_INFRA_HOST_UNITS || [
  'docker.service',
  'containerd.service',
  'k3s.service',
  'kubelet.service',
  'edr-server.service',
].join(',')).split(',').map((value) => value.trim()).filter(Boolean);

const knownStandaloneDocker = new Map([
  ['a3s-k8s-test-control-plane', 'kindest/node:'],
]);

function runJson(binary, args) {
  return JSON.parse(execFileSync(binary, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

function classificationForLabels(labels) {
  const kind = String(labels['anysentry.io/workload-kind'] || '').toLowerCase();
  const observe = String(labels['io.anysentry.observe'] || '').toLowerCase();
  if (kind === 'agent') return 'confirmed_agent';
  if (['non-agent', 'non_agent', 'infrastructure'].includes(kind)) return 'non_agent';
  if (['0', 'false', 'off', 'no', 'disabled'].includes(observe)) return 'non_agent';
  return 'unknown';
}

function dockerInventory() {
  let ids = [];
  try {
    ids = execFileSync('docker', ['ps', '--format', '{{.ID}}'], { encoding: 'utf8' })
      .split('\n').map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
  if (!ids.length) return [];
  const inspections = runJson('docker', ['inspect', ...ids]);
  return inspections.flatMap((inspect) => {
    const labels = inspect?.Config?.Labels ?? {};
    const composeProject = labels['com.docker.compose.project'];
    const serviceName = labels['com.docker.compose.service'];
    const containerName = String(inspect.Name || '').replace(/^\//u, '');
    const imageName = String(inspect.Config?.Image || '');
    const standaloneImagePrefix = knownStandaloneDocker.get(containerName);
    const composeKnown = Boolean(
      composeProject &&
      (!projectFilter || composeProject === projectFilter) &&
      knownDockerServices.has(serviceName),
    );
    const standaloneKnown = Boolean(
      !composeProject && standaloneImagePrefix && imageName.startsWith(standaloneImagePrefix),
    );
    if (
      !composeKnown && !standaloneKnown
    ) return [];
    const containerId = String(inspect.Id || '').replace(/^sha256:/u, '');
    return [{
      placement: 'docker',
      nodeId,
      composeProject,
      serviceName,
      containerName,
      imageDigest: String(inspect.Image || '').replace(/^sha256:/u, 'sha256:'),
      labels,
      physicalWorkloadId: `docker:${nodeId}:${containerId}`,
      // This list is itself a platform-inventory allowlist. Any positive Agent label still wins;
      // otherwise the exact project/service/image tuple is authoritative Infrastructure evidence.
      classification: classificationForLabels(labels) === 'confirmed_agent'
        ? 'confirmed_agent'
        : 'non_agent',
    }];
  });
}

function hostInventory() {
  return knownHostUnits.flatMap((systemdUnit) => {
    const cgroupPath = `/sys/fs/cgroup/system.slice/${systemdUnit}`;
    if (!existsSync(cgroupPath)) return [];
    return [{
      placement: 'host',
      nodeId,
      systemdUnit,
      labels: {},
      physicalWorkloadId: `host:${nodeId}:systemd:${systemdUnit}`,
      classification: 'non_agent',
    }];
  });
}

function kubernetesInventory() {
  let pods;
  let replicaSets;
  try {
    pods = runJson('kubectl', ['get', 'pods', '-A', '-o', 'json']);
    replicaSets = runJson('kubectl', ['get', 'replicasets.apps', '-A', '-o', 'json']);
  } catch {
    return [];
  }
  const replicaSetOwners = new Map((replicaSets.items || []).flatMap((item) => {
    const namespace = item.metadata?.namespace;
    const name = item.metadata?.name;
    const owner = (item.metadata?.ownerReferences || []).find((entry) => entry.controller)
      || item.metadata?.ownerReferences?.[0];
    return namespace && name && owner?.kind && owner.name
      ? [[`${namespace}/${name}`, { kind: owner.kind, name: owner.name }]]
      : [];
  }));
  return (pods.items || []).flatMap((pod) => {
    const namespace = pod.metadata?.namespace;
    const podUid = pod.metadata?.uid;
    const podName = pod.metadata?.name;
    const directOwner = (pod.metadata?.ownerReferences || []).find((entry) => entry.controller)
      || pod.metadata?.ownerReferences?.[0];
    const owner = directOwner?.kind === 'ReplicaSet'
      ? replicaSetOwners.get(`${namespace}/${directOwner.name}`) || directOwner
      : directOwner;
    if (!namespace || !owner?.kind || !owner.name) return [];
    const labels = pod.metadata?.labels ?? {};
    const statusByName = new Map((pod.status?.containerStatuses || [])
      .map((status) => [status.name, status.containerID]));
    return (pod.spec?.containers || []).flatMap((container) => {
      if (!knownKubernetesWorkloads.has(
        `${namespace}/${owner.kind}/${owner.name}/${container.name}`,
      )) return [];
      const containerId = String(statusByName.get(container.name) || '').replace(/^[^:]+:\/\//u, '');
      return [{
        placement: 'kubernetes',
        nodeId: pod.spec?.nodeName,
        clusterId,
        namespace,
        ownerKind: owner.kind,
        ownerName: owner.name,
        serviceAccount: pod.spec?.serviceAccountName,
        containerName: container.name,
        labels,
        physicalWorkloadId: `k8s:${clusterId}:${podUid}:${containerId || podName}`,
        classification: 'non_agent',
      }];
    });
  });
}

function inventory() {
  return [...dockerInventory(), ...hostInventory(), ...kubernetesInventory()];
}

function definitions(workloads) {
  const definitionsByName = new Map();
  for (const workload of workloads) {
    if (workload.placement === 'docker') {
      const name = workload.composeProject
        ? `Infrastructure/Docker/${workload.composeProject}/${workload.serviceName}`
        : `Infrastructure/Docker/standalone/${workload.containerName}`;
      definitionsByName.set(name, {
        name,
        selector: {
          placement: 'docker',
          ...(workload.composeProject
            ? { composeProject: workload.composeProject, serviceName: workload.serviceName }
            : { containerName: workload.containerName }),
          imageDigest: workload.labels?.['io.anysentry.observe'] === 'false' && workload.composeProject
            ? undefined : workload.imageDigest,
          labels: workload.labels?.['io.anysentry.observe'] === 'false'
            ? { 'io.anysentry.observe': 'false' }
            : {},
        },
        source: {
          type: 'platform_inventory',
          sourceRef: workload.composeProject
            ? `docker-compose:${workload.composeProject}/${workload.serviceName}@${workload.imageDigest}`
            : `docker-standalone:${workload.containerName}@${workload.imageDigest}`,
        },
        reasonCode: 'platform_infrastructure',
        changeTicket: 'docker-infrastructure-file-filter-v1',
      });
    } else if (workload.placement === 'host') {
      const name = `Infrastructure/Host/${workload.nodeId}/${workload.systemdUnit}`;
      definitionsByName.set(name, {
        name,
        selector: {
          placement: 'host',
          nodeId: workload.nodeId,
          systemdUnit: workload.systemdUnit,
          labels: {},
        },
        source: { type: 'platform_inventory', sourceRef: `systemd:${workload.systemdUnit}` },
        reasonCode: 'platform_infrastructure',
        changeTicket: 'host-infrastructure-file-filter-v1',
      });
    } else if (workload.placement === 'kubernetes') {
      const name = `Infrastructure/Kubernetes/${workload.clusterId}/${workload.namespace}/${workload.ownerKind}/${workload.ownerName}/${workload.containerName}`;
      definitionsByName.set(name, {
        name,
        selector: {
          placement: 'kubernetes',
          clusterId: workload.clusterId,
          namespace: workload.namespace,
          ownerKind: workload.ownerKind,
          ownerName: workload.ownerName,
          containerName: workload.containerName,
          labels: {},
        },
        source: {
          type: 'kubernetes',
          sourceRef: `kubernetes:${workload.clusterId}/${workload.namespace}/${workload.ownerKind}/${workload.ownerName}/${workload.containerName}`,
        },
        reasonCode: 'platform_infrastructure',
        changeTicket: 'kubernetes-infrastructure-file-filter-v1',
      });
    }
  }
  return [...definitionsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function request(method, path, body, actorId = author) {
  const response = await fetch(`${api}/security-center/infrastructure-rules${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-AnySentry-Actor': actorId,
      'X-AnySentry-Actor-Type': 'system',
      ...(managementToken ? { 'X-AnySentry-Management-Token': managementToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await response.json().catch(() => ({}));
  const value = parsed?.data ?? parsed;
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(value)}`);
  }
  return value;
}

async function existingRules() {
  const result = await request('GET', '?limit=500');
  return result.items || [];
}

async function ensureShadow(definition, currentByName) {
  let rule = currentByName.get(definition.name);
  if (!rule || rule.lifecycleStage === 'revoked') {
    rule = await request('POST', '', definition, author);
  }
  if (rule.lifecycleStage === 'draft') {
    rule = await request('POST', `/${encodeURIComponent(rule.ruleId)}/shadow`, {
      expectedRevision: rule.revision,
      reason: 'Authoritative platform inventory entered shadow observation',
      changeTicket: definition.changeTicket,
    }, author);
  }
  currentByName.set(definition.name, rule);
  return rule;
}

async function shadowRules(workloads) {
  const currentByName = new Map((await existingRules()).map((rule) => [rule.name, rule]));
  const output = [];
  for (const definition of definitions(workloads)) {
    const rule = await ensureShadow(definition, currentByName);
    output.push({ name: rule.name, ruleId: rule.ruleId, revision: rule.revision, stage: rule.lifecycleStage });
  }
  return output;
}

async function promoteRules(workloads) {
  const currentByName = new Map((await existingRules()).map((rule) => [rule.name, rule]));
  const output = [];
  for (const definition of definitions(workloads)) {
    let rule = await ensureShadow(definition, currentByName);
    if (rule.lifecycleStage === 'shadow') {
      const validation = await request(
        'POST',
        `/${encodeURIComponent(rule.ruleId)}/impact-preview`,
        {},
        author,
      );
      if (!validation.valid || validation.matchedAssets === 0 || validation.agentConflicts > 0) {
        output.push({ name: rule.name, stage: rule.lifecycleStage, validation });
        continue;
      }
      rule = await request('POST', `/${encodeURIComponent(rule.ruleId)}/promote`, {
        expectedRevision: rule.revision,
        reason: 'Shadow inventory validation matched real workload with zero Agent conflicts',
        changeTicket: definition.changeTicket,
      }, approver);
      currentByName.set(definition.name, rule);
    }
    output.push({ name: rule.name, ruleId: rule.ruleId, revision: rule.revision, stage: rule.lifecycleStage });
  }
  return output;
}

const workloads = inventory();
if (command === 'inventory') {
  console.log(JSON.stringify({ nodeId, clusterId, workloads, definitions: definitions(workloads) }, null, 2));
} else if (command === 'shadow') {
  console.log(JSON.stringify({ nodeId, workloads: workloads.length, rules: await shadowRules(workloads) }, null, 2));
} else if (command === 'promote') {
  console.log(JSON.stringify({ nodeId, workloads: workloads.length, rules: await promoteRules(workloads) }, null, 2));
} else if (command === 'status') {
  const [status, rules] = await Promise.all([request('GET', '/status'), existingRules()]);
  console.log(JSON.stringify({ status, rules: rules.map((rule) => ({
    ruleId: rule.ruleId,
    name: rule.name,
    revision: rule.revision,
    authority: rule.authority,
    stage: rule.lifecycleStage,
    selector: rule.selector,
  })) }, null, 2));
} else {
  throw new Error('usage: manage-infrastructure-rules.mjs inventory|shadow|promote|status');
}
