#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import process from 'node:process';

const HELP = `
AnySentry final Kubernetes E2E verifier

Usage:
  node scripts/verify-final-kubernetes-e2e.mjs --help
  node scripts/verify-final-kubernetes-e2e.mjs --validate-manifest
  node scripts/verify-final-kubernetes-e2e.mjs --render-manifest
  node scripts/verify-final-kubernetes-e2e.mjs --run

--help               No cluster access and no environment requirements.
--validate-manifest  Static, side-effect-free validation using digest-pinned placeholders when
                     final image variables are absent.
--render-manifest    Print only non-secret Kubernetes JSON. It never prints Source tokens, the
                     management token, model configuration, or the model credential.
--run                Create a unique temporary namespace, execute the E2E, then always delete the
                     entire namespace. Existing anysentry and anysentry-agent-test namespaces are
                     never selected or modified.

Required only for --run (all must be immutable image@sha256 references):
  ANYSENTRY_E2E_API_IMAGE
  ANYSENTRY_E2E_OBSERVER_IMAGE
  ANYSENTRY_E2E_AGENT_IMAGE

Optional real Pi turn (missing/incomplete configuration is reported as SKIP, never printed):
  ANYSENTRY_E2E_PI_MODELS_FILE   Read-only local models.json
  ANYSENTRY_E2E_PI_KEY_FILE      Read-only local model credential
  ANYSENTRY_E2E_PI_PROVIDER
  ANYSENTRY_E2E_PI_MODEL
  ANYSENTRY_E2E_PI_THINKING      Default: off

Other optional settings:
  ANYSENTRY_E2E_KUBECTL          Default: kubectl
  ANYSENTRY_E2E_NODE             Pin the E2E to this Ready node; otherwise the first Ready,
                                 schedulable node is selected.
  ANYSENTRY_E2E_IMAGE_PULL_POLICY  Default: IfNotPresent
  ANYSENTRY_E2E_TIMEOUT_MS        Default: 180000
`;

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.size === 0) {
  process.stdout.write(HELP.trimStart());
  process.exit(0);
}
const allowedArgs = new Set(['--validate-manifest', '--render-manifest', '--run']);
assert([...args].every((arg) => allowedArgs.has(arg)), 'unknown argument; use --help');
assert(args.size === 1, 'choose exactly one mode');

const mode = [...args][0];
const runMode = mode === '--run';
const kubectl = process.env.ANYSENTRY_E2E_KUBECTL?.trim() || 'kubectl';
const timeoutMs = boundedInteger(process.env.ANYSENTRY_E2E_TIMEOUT_MS, 180_000, 30_000, 600_000);
const pullPolicy = ['Always', 'IfNotPresent', 'Never'].includes(process.env.ANYSENTRY_E2E_IMAGE_PULL_POLICY ?? '')
  ? process.env.ANYSENTRY_E2E_IMAGE_PULL_POLICY
  : 'IfNotPresent';
const placeholderDigest = '0'.repeat(64);
const placeholderImages = {
  api: `registry.invalid/anysentry@sha256:${placeholderDigest}`,
  observer: `registry.invalid/anysentry-observer@sha256:${placeholderDigest}`,
  agent: `registry.invalid/anysentry-agent-runtime-lab@sha256:${placeholderDigest}`,
};
const images = {
  api: process.env.ANYSENTRY_E2E_API_IMAGE?.trim() || placeholderImages.api,
  observer: process.env.ANYSENTRY_E2E_OBSERVER_IMAGE?.trim() || placeholderImages.observer,
  agent: process.env.ANYSENTRY_E2E_AGENT_IMAGE?.trim() || placeholderImages.agent,
};
const immutableImage = /^[A-Za-z0-9._/:@-]+@sha256:[a-f0-9]{64}$/u;
if (runMode) {
  for (const [name, image] of Object.entries(images)) {
    assert(immutableImage.test(image), `ANYSENTRY_E2E_${name.toUpperCase()}_IMAGE must be image@sha256:<64 lowercase hex>`);
    assert(!image.startsWith('registry.invalid/'), `${name} final image is required for --run`);
  }
}

const runSuffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const namespace = runMode ? `anysentry-e2e-${runSuffix}` : 'anysentry-e2e-manifest-dry-run';
const protectedNamespaces = new Set(['anysentry', 'anysentry-agent-test', 'default', 'kube-system']);
assert(!protectedNamespaces.has(namespace) && /^anysentry-e2e-[a-z0-9-]+$/u.test(namespace));
const tenantId = `tenant-${runSuffix}`;
const environmentId = `k8s-${runSuffix}`;
const workspacePath = '/workspace';
const collectorId = `collector-${runSuffix}`;
const customAgentId = `custom-agent-${runSuffix}`;
const piAgentId = `pi-agent-${runSuffix}`;
const invocationId = `invocation-${runSuffix}`;
const sourceSecretName = 'e2e-source-credentials';
const controlSecretName = 'e2e-control-auth';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function env(name, value) {
  return { name, value: String(value) };
}

function secretEnv(name, secretName, key) {
  return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
}

function list(items) {
  return { apiVersion: 'v1', kind: 'List', items };
}

function customAgentProgram() {
  return String.raw`
import { createHash } from 'node:crypto';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// Exercise the bundled Pi root signature so the Forwarder establishes a generation-safe root;
// K8s workload identity alone is intentionally too coarse to prove a direct bash child.
process.title = 'pi';

const endpoint = process.env.ANYSENTRY_ADAPTER_URL;
const sourceId = process.env.ANYSENTRY_SOURCE_ID;
const token = process.env.ANYSENTRY_SOURCE_TOKEN;
const workspace = process.env.ANYSENTRY_WORKSPACE_PATH || '/workspace';
const invocationId = process.env.ANYSENTRY_INVOCATION_ID;
const sessionId = process.env.ANYSENTRY_SESSION_ID;
const agentId = process.env.AGENT_ID;
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const traceId = sha256(sessionId + '\0' + invocationId).slice(0, 32);

function namespaceInode(value) { return value.match(/^pid:\[(\d+)\]$/u)?.[1]; }
function namespacePid(value) {
  const line = value.split(/\r?\n/u).find((item) => item.startsWith('NSpid:'));
  const pid = Number(line?.slice(6).trim().split(/\s+/u).at(-1));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : process.pid;
}
async function facts() {
  const stat = await readFile('/proc/self/stat', 'utf8');
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  const hostId = await readFile('/etc/machine-id', 'utf8').then((value) => value.trim()).catch(() => undefined);
  return {
    pid: process.pid,
    startTimeTicks: fields[19],
    pidNamespace: namespaceInode(await readlink('/proc/self/ns/pid')),
    namespacePid: namespacePid(await readFile('/proc/self/status', 'utf8')),
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    ...(hostId ? { hostId } : {}),
    cgroup: (await readFile('/proc/self/cgroup', 'utf8')).trim(),
  };
}
const processFacts = await facts();
function baseAttributes(operation, phase) {
  return {
    'anysentry.adapter.schema': 'anysentry.agent_adapter_event.v1',
    'anysentry.adapter.runtime': 'custom-e2e',
    'anysentry.lifecycle.phase': phase,
    'gen_ai.operation.name': operation,
    'gen_ai.agent.name': agentId,
    'gen_ai.conversation.id': sessionId,
    tenantId: process.env.ANYSENTRY_TENANT_ID,
    environmentId: process.env.ANYSENTRY_ENVIRONMENT_ID,
    pid: processFacts.pid,
    startTimeTicks: processFacts.startTimeTicks,
    pidNamespace: processFacts.pidNamespace,
    namespacePid: processFacts.namespacePid,
    bootId: processFacts.bootId,
    hostId: processFacts.hostId,
    cgroup: processFacts.cgroup,
  };
}
function event(kind, operation, phase, toolCallId, toolName, attributes) {
  const spanId = sha256(traceId + '\0' + (toolCallId || operation)).slice(0, 16);
  return {
    id: 'e2e-' + sha256(invocationId + '\0' + (toolCallId || '') + '\0' + phase).slice(0, 24),
    at: Date.now(), eventKind: kind, eventCategory: kind === 'AgentTool' ? 'tool' : 'runtime',
    activityContext: 'agent_action', subject: operation + ' ' + phase,
    workspacePath: workspace, agentId, sessionId, invocationId, toolCallId,
    traceId, spanId, runId: invocationId, taskId: toolCallId,
    pid: processFacts.pid, cwd: workspace,
    attributes: { ...baseAttributes(operation, phase), ...(toolCallId ? { 'gen_ai.tool.call.id': toolCallId } : {}),
      ...(toolName ? { 'gen_ai.tool.name': toolName } : {}), ...attributes },
  };
}
async function send(events) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token,
      'x-anysentry-source-id': sourceId },
    body: JSON.stringify({ sourceId, sourceType: 'custom', workspacePath: workspace, events }),
  });
  if (!response.ok) throw new Error('adapter ingest failed with status ' + response.status);
  const body = await response.json();
  if (Number(body.acceptedEvents ?? body.data?.acceptedEvents) !== events.length) throw new Error('adapter batch was not fully accepted');
}
async function tool(toolCallId, toolName, attributes, action) {
  await send([event('AgentTool', 'execute_tool', 'start', toolCallId, toolName, attributes)]);
  action();
  await send([event('AgentTool', 'execute_tool', 'end', toolCallId, toolName, attributes)]);
}

await writeFile(workspace + '/canary.txt', 'AnySentry Kubernetes E2E canary\n');
// Give API inventory and the Forwarder identity snapshot at least several refresh cycles before
// producing kernel evidence; Unknown/non-Agent events are intentionally not retained here.
await new Promise((resolve) => setTimeout(resolve, 15000));
await send([event('AgentInvocation', 'invoke_agent', 'start')]);
await tool('read-' + invocationId, 'read', {
  'anysentry.tool.resource_kind': 'file',
  'anysentry.tool.resource_hash': sha256(workspace + '/canary.txt'),
  'anysentry.tool.resource_path': workspace + '/canary.txt',
}, () => readFileSync(workspace + '/canary.txt', 'utf8'));
await tool('write-' + invocationId, 'write', {
  'anysentry.tool.resource_kind': 'file',
  'anysentry.tool.resource_hash': sha256(workspace + '/write-output.txt'),
  'anysentry.tool.resource_path': workspace + '/write-output.txt',
}, () => writeFileSync(workspace + '/write-output.txt', 'write-evidence\n'));
// Keep the direct child alive long enough for host /proc namespace enrichment. A zero-duration
// shell is intentionally allowed to degrade to semantic-only when those strong facts disappear.
const command = 'printf bash-evidence >> /workspace/bash-output.txt; sleep 2';
await tool('bash-' + invocationId, 'bash', {
  'anysentry.tool.resource_kind': 'command', 'anysentry.tool.command_hash': sha256(command),
  'anysentry.tool.command_executable': 'printf',
}, () => {
  const result = spawnSync('/bin/bash', ['-c', command], { cwd: workspace });
  if (result.status !== 0) throw new Error('bash tool failed');
});
await tool('custom-' + invocationId, 'custom_remote', {}, () => ({ status: 'semantic-only' }));
await send([event('AgentInvocation', 'invoke_agent', 'end')]);
await writeFile('/tmp/e2e-ready', 'ready\n');
setInterval(() => {}, 60000);
`;
}

function baseResources(nodeName, includePi = false) {
  const apiLabels = { app: 'anysentry-e2e-api', 'io.anysentry.observe': 'false' };
  const observerLabels = { app: 'anysentry-e2e-observer', 'io.anysentry.observe': 'false' };
  const items = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { 'anysentry.io/e2e': runSuffix } } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'e2e-api', namespace } },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'e2e-pod-reader', namespace },
      rules: [
        { apiGroups: [''], resources: ['pods', 'services', 'configmaps'], verbs: ['get', 'list', 'watch'] },
        { apiGroups: ['apps'], resources: ['replicasets'], verbs: ['get', 'list', 'watch'] },
      ] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'e2e-pod-reader', namespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'e2e-pod-reader' },
      subjects: [{ kind: 'ServiceAccount', name: 'e2e-api', namespace }] },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'anysentry', namespace, labels: apiLabels },
      spec: { replicas: 1, selector: { matchLabels: apiLabels }, template: { metadata: { labels: apiLabels }, spec: {
        serviceAccountName: 'e2e-api', terminationGracePeriodSeconds: 30,
        containers: [{ name: 'api', image: images.api, imagePullPolicy: pullPolicy,
          env: [env('PORT', 29653), env('ANYSENTRY_TRUSTED_CORRELATION_MODE', 'shadow'),
            env('ANYSENTRY_UNKNOWN_RETENTION_MODE', 'shadow'), env('ANYSENTRY_UNKNOWN_LEARNING_ENABLED', 'true'),
            env('ANYSENTRY_HOT_EVENT_LIMIT', '25000'),
            env('ANYSENTRY_IDENTITY_NAMESPACES', namespace), env('ANYSENTRY_AGENT_LABEL_SELECTOR', 'anysentry.io/workload-kind=agent'),
            secretEnv('ANYSENTRY_MANAGEMENT_TOKEN', controlSecretName, 'management-token')],
          ports: [{ name: 'http', containerPort: 29653 }],
          readinessProbe: { httpGet: { path: '/security-center/healthz', port: 29653 }, periodSeconds: 2, failureThreshold: 60 },
          resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '2', memory: '2Gi' } } }],
      } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'anysentry', namespace }, spec: {
      selector: apiLabels, ports: [{ name: 'http', port: 29653, targetPort: 29653 }] } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'e2e-custom-agent', namespace },
      data: { 'custom-agent.mjs': customAgentProgram() } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'observer', namespace, labels: observerLabels },
      spec: { replicas: 1, selector: { matchLabels: observerLabels }, template: { metadata: { labels: observerLabels }, spec: {
        nodeName, hostPID: true, terminationGracePeriodSeconds: 30,
        tolerations: [{ operator: 'Exists' }],
        containers: [{ name: 'observer', image: images.observer, imagePullPolicy: pullPolicy,
          securityContext: { privileged: true },
          env: [env('A3S_OBSERVER_JSON', '1'), env('A3S_OBSERVER_FILES', '0'),
            env('A3S_OBSERVER_FILE_ACCESS', '1'), env('A3S_OBSERVER_FILE_DELETE', '0'), env('A3S_OBSERVER_SSL', '0'),
            env('A3S_OBSERVER_CONNECT', '0'), env('A3S_OBSERVER_TLS', '0'), env('A3S_OBSERVER_DNS', '0'),
            env('A3S_OBSERVER_LLM', '0'),
            env('A3S_OBSERVER_COLLECTOR_ID', collectorId), env('A3S_NODE_NAME', nodeName),
            env('ANYSENTRY_SOURCE_TYPE', 'observer'), env('ANYSENTRY_SOURCE_NAME', 'final-k8s-e2e-observer'),
            env('ANYSENTRY_SOURCE_CREDENTIALS_FILE', '/etc/anysentry-auth/observer-sources.json'),
            secretEnv('ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN', controlSecretName, 'management-token'),
            env('ANYSENTRY_INGEST_URL', `http://anysentry.${namespace}.svc:29653/security-center/ingest`),
            env('ANYSENTRY_BATCH_INGEST_URL', `http://anysentry.${namespace}.svc:29653/security-center/ingest/batch`),
            env('ANYSENTRY_IDENTITY_SNAPSHOT_URL', `http://anysentry.${namespace}.svc:29653/security-center/identity/snapshot`),
            env('ANYSENTRY_IDENTITY_SNAPSHOT_SECS', '2'), env('ANYSENTRY_HEARTBEAT_SECS', '2'),
            env('ANYSENTRY_FILTER_RULES_FILE', '/run/anysentry-filter/filter-rules.json'),
            env('ANYSENTRY_FILTER_RULES_ACK_FILE', '/run/anysentry-filter/filter-rules.ack.json'),
            env('ANYSENTRY_CAPTURE_PROFILE_MODE', 'enforce'), env('ANYSENTRY_CAPTURE_PROFILE_ACK_POLL_MS', '100'),
            env('ANYSENTRY_INFRASTRUCTURE_POLICY_URL', `http://anysentry.${namespace}.svc:29653/security-center/infrastructure-rules/policy`),
            env('ANYSENTRY_INFRASTRUCTURE_MATERIALIZATION_URL', `http://anysentry.${namespace}.svc:29653/security-center/infrastructure-rules/materializations/report`),
            env('ANYSENTRY_INFRASTRUCTURE_POLICY_SECS', '2'),
            env('ANYSENTRY_FILTER_RULE_PROJECTION_URL', `http://anysentry.${namespace}.svc:29653/security-center/filter-rules/projections/forwarder`),
            env('ANYSENTRY_FILTER_RULE_PROJECTION_SECS', '2'),
            env('A3S_OBSERVER_FILE_UNKNOWN_PER_CGROUP', '20'),
            env('A3S_OBSERVER_FILE_UNKNOWN_PER_NODE', '200'),
            env('A3S_OBSERVER_FILE_SAMPLE_WINDOW_MS', '1000'),
            env('ANYSENTRY_PROBABLE_PROFILE_TTL_MS', '120000'),
            env('FORWARD_SHUTDOWN_TIMEOUT_MS', '15000'),
            env('OBSERVER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS', '20000'),
            env('FORWARD_FILTER_MODE', 'shadow'),
            env('FORWARD_RETAIN_UNKNOWN', 'false'), env('FORWARD_RETAIN_NON_AGENT', 'false'),
            env('FORWARD_FILE_AGGREGATION', 'false'), env('FORWARD_BATCH_SIZE', '32'), env('FORWARD_BATCH_FLUSH_MS', '50')],
          volumeMounts: [{ name: 'sys', mountPath: '/sys', readOnly: true },
            { name: 'source-auth', mountPath: '/etc/anysentry-auth', readOnly: true },
            { name: 'filter-rules', mountPath: '/run/anysentry-filter' }],
          resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '1Gi' } } }],
        volumes: [{ name: 'sys', hostPath: { path: '/sys' } },
          { name: 'source-auth', secret: { secretName: sourceSecretName, items: [
            { key: 'observer-sources.json', path: 'observer-sources.json', mode: 0o400 }] } },
          { name: 'filter-rules', emptyDir: {} }],
      } } } },
    customAgentDeployment(nodeName),
  ];
  if (includePi) items.push(piDeployment(nodeName, { withLlm: false, redactConfiguration: true }));
  return list(items);
}

function customAgentDeployment(nodeName) {
  const labels = { app: 'e2e-custom-agent', 'anysentry.io/workload-kind': 'agent',
    'anysentry.io/agent-id': customAgentId, 'anysentry.io/agent-container': 'agent' };
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'custom-agent', namespace, labels },
    spec: { replicas: 1, selector: { matchLabels: { app: labels.app } }, template: { metadata: { labels }, spec: {
      nodeName, terminationGracePeriodSeconds: 5,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      containers: [{ name: 'agent', image: images.agent, imagePullPolicy: pullPolicy,
        command: ['node', '/e2e/custom-agent.mjs'],
        env: [env('AGENT_ID', customAgentId), env('ANYSENTRY_ADAPTER_URL', `http://anysentry.${namespace}.svc:29653/security-center/ingest/events`),
          env('ANYSENTRY_TENANT_ID', tenantId), env('ANYSENTRY_ENVIRONMENT_ID', environmentId),
          env('ANYSENTRY_WORKSPACE_PATH', workspacePath), env('ANYSENTRY_INVOCATION_ID', invocationId),
          env('ANYSENTRY_SESSION_ID', `session-${runSuffix}`),
          secretEnv('ANYSENTRY_SOURCE_ID', sourceSecretName, 'adapter-source-id'),
          secretEnv('ANYSENTRY_SOURCE_TOKEN', sourceSecretName, 'adapter-token')],
        volumeMounts: [{ name: 'script', mountPath: '/e2e', readOnly: true }, { name: 'workspace', mountPath: workspacePath }],
        readinessProbe: { exec: { command: ['/usr/bin/test', '-f', '/tmp/e2e-ready'] }, periodSeconds: 2, failureThreshold: 90 },
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '1', memory: '512Mi' } } }],
      volumes: [{ name: 'script', configMap: { name: 'e2e-custom-agent' } }, { name: 'workspace', emptyDir: {} }],
    } } } };
}

function piDeployment(nodeName, { withLlm = false, redactConfiguration = false } = {}) {
  const labels = { app: 'e2e-pi-agent', 'anysentry.io/workload-kind': 'agent',
    'anysentry.io/agent-id': piAgentId, 'anysentry.io/agent-container': 'agent' };
  const piEnv = [env('AGENT_RUNTIME', 'pi'), env('AGENT_ID', piAgentId), env('AGENT_WORKSPACE', workspacePath),
    env('AGENT_INTERVAL_SECONDS', '600'), env('PI_EXECUTION_MODE', withLlm ? 'loop' : 'rpc'),
    env('PI_TURN_TIMEOUT_SECONDS', '180'),
    env('ANYSENTRY_PI_ADAPTER_URL', `http://anysentry.${namespace}.svc:29653/security-center/ingest/events`),
    env('ANYSENTRY_TENANT_ID', tenantId), env('ANYSENTRY_ENVIRONMENT_ID', environmentId),
    env('ANYSENTRY_WORKSPACE_PATH', workspacePath),
    secretEnv('ANYSENTRY_ADAPTER_SOURCE_ID', sourceSecretName, 'adapter-source-id'),
    secretEnv('ANYSENTRY_ADAPTER_TOKEN', sourceSecretName, 'adapter-token')];
  const volumeMounts = [{ name: 'workspace', mountPath: workspacePath }];
  const volumes = [{ name: 'workspace', emptyDir: {} }];
  if (withLlm) {
    piEnv.push(
      env('PI_PROVIDER', redactConfiguration ? 'configured-provider' : process.env.ANYSENTRY_E2E_PI_PROVIDER),
      env('PI_MODEL', redactConfiguration ? 'configured-model' : process.env.ANYSENTRY_E2E_PI_MODEL),
      env('PI_THINKING', redactConfiguration ? 'off' : (process.env.ANYSENTRY_E2E_PI_THINKING || 'off')),
      env('PI_AGENT_PROMPT', 'Use read on /workspace/canary.txt, write a short file to /workspace/pi-write.txt, then use bash to append pi-bash to /workspace/pi-bash.txt. Do not access any other path.'),
      env('DEEPSEEK_API_KEY_FILE', '/run/pi/api-key'),
    );
    volumeMounts.push(
      { name: 'pi-runtime', mountPath: '/home/node/.pi/agent/models.json', subPath: 'models.json', readOnly: true },
      { name: 'pi-runtime', mountPath: '/run/pi/api-key', subPath: 'api-key', readOnly: true },
    );
    volumes.push({ name: 'pi-runtime', secret: { secretName: 'e2e-pi-runtime' } });
  }
  return { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'pi-agent', namespace, labels },
    spec: { replicas: 1, selector: { matchLabels: { app: labels.app } }, template: { metadata: { labels }, spec: {
      nodeName, terminationGracePeriodSeconds: 15,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      containers: [{ name: 'agent', image: images.agent, imagePullPolicy: pullPolicy,
        env: piEnv, volumeMounts,
        readinessProbe: { exec: { command: ['/usr/bin/test', '-f', '/tmp/agent-ready'] }, periodSeconds: 2, failureThreshold: 90 },
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '1', memory: '768Mi' } } }],
      volumes,
    } } } };
}

function validateManifest(manifest) {
  assert.equal(manifest.kind, 'List');
  assert(manifest.items.some((item) => item.kind === 'Namespace' && item.metadata.name === namespace));
  const api = manifest.items.find((item) => item.kind === 'Deployment' && item.metadata.name === 'anysentry');
  const observer = manifest.items.find((item) => item.kind === 'Deployment' && item.metadata.name === 'observer');
  const custom = manifest.items.find((item) => item.kind === 'Deployment' && item.metadata.name === 'custom-agent');
  const pi = manifest.items.find((item) => item.kind === 'Deployment' && item.metadata.name === 'pi-agent');
  assert(immutableImage.test(api.spec.template.spec.containers[0].image));
  assert.equal(observer.spec.template.spec.hostPID, true);
  assert.equal(observer.spec.template.spec.containers[0].securityContext.privileged, true);
  assert.equal(observer.spec.template.spec.containers[0].image, images.observer);
  assert(immutableImage.test(observer.spec.template.spec.containers[0].image));
  assert(immutableImage.test(custom.spec.template.spec.containers[0].image));
  if (pi) assert(immutableImage.test(pi.spec.template.spec.containers[0].image));
  assert.equal(custom.spec.template.metadata.labels['anysentry.io/workload-kind'], 'agent');
  assert(customAgentProgram().includes("tool('read-'"));
  assert(customAgentProgram().includes("tool('write-'"));
  assert(customAgentProgram().includes("tool('bash-'"));
  assert(customAgentProgram().includes("tool('custom-'"));
  assert(!JSON.stringify(manifest).includes('management-token-value'));
  assert(!manifest.items.some((item) => item.kind === 'Secret'), 'dry-run manifest must never contain Secret data');
  assert(!manifest.items.some((item) => ['ClusterRole', 'ClusterRoleBinding', 'PersistentVolume'].includes(item.kind)),
    'all E2E state must be namespace-scoped and removable with the namespace');
  assert(manifest.items.every((item) => item.kind === 'Namespace' || item.metadata?.namespace === namespace));
}

const dryManifest = baseResources(process.env.ANYSENTRY_E2E_NODE?.trim() || 'dry-run-node', true);
validateManifest(dryManifest);
if (mode === '--validate-manifest') {
  console.log('Final Kubernetes E2E non-secret manifest validation passed');
  process.exit(0);
}
if (mode === '--render-manifest') {
  process.stdout.write(`${JSON.stringify(dryManifest, null, 2)}\n`);
  process.exit(0);
}

const activeChildren = new Set();
let shutdownSignal;
let portForward;
let namespaceCleanupArmed = false;
const managementToken = randomBytes(32).toString('base64url');
let baseUrl;

async function command(commandName, commandArgs, options = {}) {
  const { input, timeout = timeoutMs, silent = false } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(commandName, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBytes = 8 * 1024 * 1024;
    child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes <= maxBytes) stdout.push(chunk); });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes <= maxBytes) stderr.push(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    child.once('error', (error) => {
      activeChildren.delete(child);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve({ stdout: out, stderr: err });
      else {
        const failure = new Error(`${commandName} ${commandArgs.slice(0, 4).join(' ')} failed (${signal ?? code})${silent ? '' : `: ${err.slice(0, 500)}`}`);
        failure.stderr = err;
        failure.exitCode = code;
        reject(failure);
      }
    });
  });
}

const kube = (commandArgs, options) => command(kubectl, commandArgs, options);
async function applyObject(object, silent = false) {
  await kube(['apply', '-f', '-'], { input: JSON.stringify(object), silent });
}
async function applySecret(name, stringData) {
  await applyObject({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: 'Opaque', stringData }, true);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitUntil(label, probe, timeout = timeoutMs, interval = 500) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (shutdownSignal) throw new Error(`received ${shutdownSignal}`);
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdownSignal = signal;
    if (portForward && !portForward.killed) portForward.kill('SIGTERM');
    for (const child of activeChildren) child.kill('SIGTERM');
  });
}
async function api(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-anysentry-management-token': managementToken, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
  const parsed = text ? JSON.parse(text) : undefined;
  return parsed?.data ?? parsed;
}
async function createSource(body) {
  const created = await api('/sources', 'POST', { enabled: true, requireToken: true,
    owner: 'final-kubernetes-e2e', tags: [runSuffix], ...body });
  assert(created?.source?.sourceId && created?.token, 'managed Source did not return credentials');
  return { sourceId: created.source.sourceId, token: created.token };
}
function sourceHeaders(source) {
  return { 'x-anysentry-source-id': source.sourceId, authorization: `Bearer ${source.token}` };
}

async function chooseNode() {
  const requested = process.env.ANYSENTRY_E2E_NODE?.trim();
  const nodes = JSON.parse((await kube(['get', 'nodes', '-o', 'json'])).stdout).items ?? [];
  const ready = nodes.filter((node) => !node.spec?.unschedulable &&
    node.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'));
  const selected = requested ? ready.find((node) => node.metadata?.name === requested) : ready[0];
  assert(selected?.metadata?.name, requested ? 'requested E2E node is not Ready/schedulable' : 'no Ready schedulable node');
  return selected.metadata.name;
}

async function optionalPiFiles() {
  const modelsPath = process.env.ANYSENTRY_E2E_PI_MODELS_FILE?.trim();
  const keyPath = process.env.ANYSENTRY_E2E_PI_KEY_FILE?.trim();
  const provider = process.env.ANYSENTRY_E2E_PI_PROVIDER?.trim();
  const model = process.env.ANYSENTRY_E2E_PI_MODEL?.trim();
  if (!modelsPath || !keyPath || !provider || !model) return { enabled: false, reason: 'LLM files/provider/model not fully configured' };
  try {
    const [modelsStat, keyStat] = await Promise.all([stat(modelsPath), stat(keyPath)]);
    if (!modelsStat.isFile() || !keyStat.isFile() || modelsStat.size > 1024 * 1024 || keyStat.size > 16 * 1024) {
      return { enabled: false, reason: 'LLM files are invalid or exceed the bounded size' };
    }
    const [models, key] = await Promise.all([readFile(modelsPath, 'utf8'), readFile(keyPath, 'utf8')]);
    if (!models.trim() || !key.trim()) return { enabled: false, reason: 'LLM files are empty' };
    return { enabled: true, models, key: key.trim() };
  } catch {
    return { enabled: false, reason: 'LLM files are missing or unreadable' };
  }
}

try {
  const namespaceAlreadyExists = await kube(['get', 'namespace', namespace, '-o', 'name'], { silent: true, timeout: 15_000 })
    .then(
      () => true,
      (error) => {
        if (/\bNotFound\b|not found/iu.test(error.stderr ?? '')) return false;
        throw new Error('could not establish the pre-run namespace state');
      },
    );
  assert.equal(namespaceAlreadyExists, false, 'generated E2E namespace unexpectedly already exists');
  namespaceCleanupArmed = true;
  await kube(['create', 'namespace', namespace]);
  console.log(`Created isolated namespace ${namespace}`);
  const nodeName = await chooseNode();
  await applySecret(controlSecretName, { 'management-token': managementToken });

  const initial = baseResources(nodeName, false);
  initial.items = initial.items.filter((item) => item.kind !== 'Namespace' &&
    !['observer', 'custom-agent'].includes(item.metadata?.name));
  await applyObject(initial);
  await kube(['-n', namespace, 'rollout', 'status', 'deployment/anysentry', `--timeout=${Math.ceil(timeoutMs / 1000)}s`]);

  const localPort = await freePort();
  portForward = spawn(kubectl, ['-n', namespace, 'port-forward', 'service/anysentry', `${localPort}:29653`],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  baseUrl = `http://127.0.0.1:${localPort}/security-center`;
  await waitUntil('AnySentry health', async () => {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  });

  const observerSource = await createSource({ name: `Observer ${collectorId}`, type: 'observer', collectorId,
    correlationClaims: { enabled: true, authority: 'observer_runtime', bindings: { collectorIds: [collectorId] } } });
  const adapterSource = await createSource({ name: `Adapter ${runSuffix}`, type: 'custom', workspacePath,
    correlationClaims: { enabled: true, authority: 'agent_adapter', bindings: {
      tenantIds: [tenantId], environmentIds: [environmentId], workspacePaths: [workspacePath],
    } } });
  const observerCredentialDocument = JSON.stringify({
    schemaVersion: 'anysentry.observer_source_credentials.v1', generatedAt: new Date().toISOString(),
    credentials: [{ collectorId, sourceId: observerSource.sourceId, token: observerSource.token }],
  });
  await applySecret(sourceSecretName, {
    'observer-sources.json': observerCredentialDocument,
    'adapter-source-id': adapterSource.sourceId,
    'adapter-token': adapterSource.token,
  });

  const observerOnly = baseResources(nodeName, false);
  observerOnly.items = observerOnly.items.filter((item) => item.metadata?.name === 'observer');
  await applyObject(observerOnly);
  await kube(['-n', namespace, 'rollout', 'status', 'deployment/observer', `--timeout=${Math.ceil(timeoutMs / 1000)}s`]);

  const collector = await waitUntil('Collector accounting', async () => {
    const health = await api('/collectors/health', 'POST', { timeType: 'last_30d', collectorId, limit: 5 });
    const item = health.items?.find((candidate) => candidate.collectorId === collectorId);
    return item?.pipelineAccounting?.reported ? item : undefined;
  });
  assert.equal(collector.pipelineAccounting.reported, true);
  assert(collector.pipelineAccounting.window?.heartbeatCount >= 1);
  assert(collector.pipelineAccounting.window?.acceptedWindowCount >= 1);
  assert.equal(typeof collector.pipelineAccounting.latest?.producerInstanceId, 'string');

  await applyObject(list([customAgentDeployment(nodeName)]));
  await kube(['-n', namespace, 'rollout', 'status', 'deployment/custom-agent', `--timeout=${Math.ceil(timeoutMs / 1000)}s`]);
  const evidence = await waitUntil('custom ToolEvidence', async () => {
    const result = await api('/events/tool-evidence', 'POST', {
      timeType: 'last_30d', invocationId, workspacePath, limit: 1_000,
    });
    const indexed = Object.fromEntries((result.items ?? []).map((item) => [item.toolName, item]));
    return result.items?.length === 4
      && indexed.read?.status === 'linked'
      && indexed.write?.status === 'linked'
      && indexed.bash?.status === 'linked'
      ? result
      : undefined;
  }, timeoutMs, 1_000);
  // Freeze only after the API has acknowledged all strong links. Scaling first made correctness
  // depend on a node's pod-termination/pipe-drain timing and could discard evidence that had not
  // reached the API yet.
  await kube(['-n', namespace, 'scale', 'deployment/observer', '--replicas=0']);
  await kube(['-n', namespace, 'rollout', 'status', 'deployment/observer', `--timeout=${Math.ceil(timeoutMs / 1000)}s`]);
  const byTool = Object.fromEntries(evidence.items.map((item) => [item.toolName, item]));
  assert.equal(byTool.read?.status, 'linked');
  assert.equal(byTool.write?.status, 'linked');
  assert.equal(byTool.bash?.status, 'linked');
  assert.equal(byTool.custom_remote?.status, 'semantic_only');
  const semanticToolEvents = await api('/events/list', 'POST', {
    timeType: 'last_30d', scope: 'raw', workspacePath, invocationId, eventKind: 'AgentTool',
    includeUnknown: true, limit: 100,
  });
  assert.equal(semanticToolEvents.items?.length, 8, 'four ToolCalls retain start/end semantic records');
  assert(semanticToolEvents.items.every((item) => item.detectedClassification === 'confirmed_agent'));
  assert(semanticToolEvents.items.every((item) => item.runtime === 'kubernetes'));
  assert(semanticToolEvents.items.every((item) => item.attribution?.agentInstanceId));
  assert(semanticToolEvents.items.every((item) => item.attribution?.physicalWorkloadId));
  assert(semanticToolEvents.items.every((item) => item.classificationSemantics?.captureProfile === 'agent_full'));
  assert.equal(new Set(semanticToolEvents.items.map((item) => item.agentAssetId)).size, 1,
    'authenticated semantic events resolve to one canonical Agent Asset');

  let previousObserverAccepted = -1;
  let stableObserverReads = 0;
  await waitUntil('Observer ingest drain', async () => {
    const sources = await api('/sources/list', 'POST', { sourceId: observerSource.sourceId, limit: 1 });
    const current = Number(sources.items?.[0]?.acceptedEvents);
    if (!Number.isSafeInteger(current) || current < 0) return undefined;
    if (current === previousObserverAccepted) stableObserverReads += 1;
    else stableObserverReads = 0;
    previousObserverAccepted = current;
    return stableObserverReads >= 2;
  }, timeoutMs, 1_000);

  const agent = await waitUntil('Agent asset', async () => {
    const inventory = await api('/agents/inventory', 'POST', {
      timeType: 'last_30d', scope: 'raw', workspacePath, agentId: customAgentId, limit: 100,
    });
    return inventory.items?.find((item) => item.agentId === customAgentId && item.agentAssetId);
  });
  assert.equal(semanticToolEvents.items[0].agentAssetId, agent.agentAssetId,
    'ToolEvidence and Agent inventory share the same canonical Asset identity');
  const contextWorkspacePath = agent.workspacePath;
  assert.equal(typeof contextWorkspacePath, 'string');
  assert(contextWorkspacePath.length > 0);
  const contextSource = await createSource({
    name: `Context ${runSuffix}`, type: 'otel', workspacePath: contextWorkspacePath,
    tags: [runSuffix, 'system-context'],
  });
  const contextSourceRecord = (await api('/sources/list', 'POST', {
    sourceId: contextSource.sourceId, limit: 1,
  })).items?.[0];
  assert.equal(contextSourceRecord?.sourceId, contextSource.sourceId);
  assert.equal(contextSourceRecord?.enabled, true);
  assert.equal(contextSourceRecord?.requireToken, true);
  assert.equal(contextSourceRecord?.discovered, false);
  assert(contextSourceRecord?.tags?.includes('system-context'));

  // Ask the server for its current canonical focus before publishing topology facts. Asset
  // grouping can acquire physical workload evidence after the first inventory read; deriving the
  // seed locally would race that merge and create an orphan edge.
  const baselineContext = await api('/context/system', 'POST', {
    timeType: 'last_30d', workspacePath: contextWorkspacePath,
    agentAssetId: agent.agentAssetId, agentInstanceId: agent.agentInstanceId,
  });
  const agentResourceId = baselineContext.focus?.physicalWorkloadId || `agent-asset:${agent.agentAssetId}`;
  const contextEvents = [
    ['resource-agent', 'resource', { 'context.resource.id': agentResourceId, 'context.resource.kind': 'agent_runtime',
      'context.resource.role': 'agent', 'context.resource.name': customAgentId,
      'context.resource.physical_workload_id': agentResourceId }],
    ['resource-service', 'resource', { 'context.resource.id': 'service:e2e-api', 'context.resource.kind': 'service',
      'context.resource.role': 'business_service', 'context.resource.name': 'e2e-api' }],
    ['edge', 'dependency', { 'context.dependency.edge_id': 'edge:e2e-agent-service',
      'context.dependency.source_resource_id': agentResourceId,
      'context.dependency.target_resource_id': 'service:e2e-api', 'context.dependency.relation': 'calls',
      'context.dependency.event_count': 1, 'context.dependency.aggregated': true }],
    ['metric', 'metric', { 'context.metric.id': 'metric:e2e-errors', 'context.metric.resource_id': 'service:e2e-api',
      'context.metric.name': 'e2e.error_rate', 'context.metric.value': 0.1,
      'context.metric.unit': 'ratio', 'context.metric.kind': 'rate', 'context.metric.status': 'anomalous' }],
  ].map(([id, factType, attributes]) => ({
    id: `${runSuffix}-${id}`, at: Date.now(), kind: 'SystemContext', eventCategory: 'runtime',
    workspacePath: contextWorkspacePath, agentId: 'e2e-context', sessionId: `context-${runSuffix}`, userId: 'system',
    subject: `${factType} context`, attributes: { 'context.fact.type': factType,
      'context.source.kind': 'otel', 'context.association.confidence': 1,
      'context.association.method': 'exact_resource_identity', ...attributes },
  }));
  const contextIngest = await api('/ingest/events', 'POST', {
    sourceId: contextSource.sourceId, sourceType: 'otel', workspacePath: contextWorkspacePath, events: contextEvents,
  }, sourceHeaders(contextSource));
  assert.equal(contextIngest.acceptedEvents, contextEvents.length);
  const pinnedContextEvents = (await Promise.all((contextIngest.items ?? []).map(async (accepted) => {
    if (!accepted.eventId) return undefined;
    const result = await api('/events/list', 'POST', {
      timeType: 'last_30d', scope: 'raw', durable: false, includeUnknown: true,
      eventId: accepted.eventId, limit: 1,
    });
    return result.items?.[0];
  }))).filter(Boolean);
  if (pinnedContextEvents.length !== contextEvents.length) {
    console.error(JSON.stringify({
      acceptedContextItems: contextIngest.items,
      pinnedContextEvents: pinnedContextEvents.map((item) => ({
        eventId: item.eventId, workspacePath: item.workspacePath, sourceId: item.sourceId,
        attribution: item.attribution,
      })),
    }, null, 2));
  }
  assert.equal(pinnedContextEvents.length, contextEvents.length, 'accepted SystemContext facts remain addressable by immutable eventId');
  assert(pinnedContextEvents.every((item) => item.eventKind === 'SystemContext'));
  const contextBundle = await api('/context/system', 'POST', {
    timeType: 'last_30d', workspacePath: contextWorkspacePath,
    agentAssetId: agent.agentAssetId, agentInstanceId: agent.agentInstanceId,
  });
  assert.equal(contextBundle.schemaVersion, 'anysentry.system_context_bundle.v1');
  if (
    !contextBundle.relatedResources.some((item) => item.resourceId === 'service:e2e-api')
    || !contextBundle.metrics.some((item) => item.name === 'e2e.error_rate')
  ) {
    console.error(JSON.stringify({
      focus: contextBundle.focus,
      expectedFocusResourceId: agentResourceId,
      contextWorkspacePath,
      contextSourceRecord: {
        sourceId: contextSourceRecord.sourceId,
        enabled: contextSourceRecord.enabled,
        requireToken: contextSourceRecord.requireToken,
        discovered: contextSourceRecord.discovered,
        workspacePath: contextSourceRecord.workspacePath,
        tags: contextSourceRecord.tags,
      },
      contextEventTrust: pinnedContextEvents.map((item) => ({
        eventId: item.eventId, at: item.at, workspacePath: item.workspacePath, sourceId: item.sourceId,
        monitored: item.attribution?.monitored,
        classification: item.attribution?.classification,
        evidence: item.attribution?.evidence,
      })),
      bundleWindow: contextBundle.window,
      resources: contextBundle.relatedResources.map((item) => item.resourceId),
      dependencies: contextBundle.dependencies.map((item) => [item.sourceResourceId, item.targetResourceId]),
      metrics: contextBundle.metrics.map((item) => item.name),
      qualityReasons: contextBundle.quality?.reasons,
      sourceStatus: contextBundle.quality?.sources,
    }, null, 2));
  }
  assert(contextBundle.relatedResources.some((item) => item.resourceId === 'service:e2e-api'));
  assert(contextBundle.metrics.some((item) => item.name === 'e2e.error_rate'));

  const piFiles = await optionalPiFiles();
  if (!piFiles.enabled) {
    await applyObject(list([piDeployment(nodeName)]));
    await kube(['-n', namespace, 'rollout', 'status', 'deployment/pi-agent', `--timeout=${Math.ceil(timeoutMs / 1000)}s`]);
    console.log(`SKIP real Pi turn: ${piFiles.reason}`);
  } else {
    await applySecret('e2e-pi-runtime', { 'models.json': piFiles.models, 'api-key': piFiles.key });
    await applyObject(list([piDeployment(nodeName, { withLlm: true })]));
    await waitUntil('Pi Tool spans', async () => {
      const events = await api('/events/list', 'POST', {
        timeType: 'last_30d', scope: 'raw', workspacePath, agentId: piAgentId,
        eventKind: 'AgentTool', includeUnknown: true, limit: 100,
      });
      const tools = new Set(events.items?.map((item) => item.attributes?.['gen_ai.tool.name']));
      return ['read', 'write', 'bash'].every((tool) => tools.has(tool));
    }, timeoutMs, 2_000);
    console.log('PASS real Pi read/write/bash Tool spans');
  }

  console.log('PASS Agent asset discovery');
  console.log('PASS custom read/write/bash/custom ToolEvidence');
  console.log('PASS authenticated SystemContext bundle');
  console.log('PASS Collector pipeline accounting');
  console.log('Final isolated Kubernetes E2E passed');
} finally {
  if (portForward && !portForward.killed) portForward.kill('SIGTERM');
  if (namespaceCleanupArmed) {
    let deleteError;
    try {
      await kube(['delete', 'namespace', namespace, '--wait=true', `--timeout=${Math.ceil(timeoutMs / 1000)}s`],
        { silent: true, timeout: timeoutMs + 30_000 });
    } catch (error) {
      deleteError = error;
    }
    const stillExists = await kube(['get', 'namespace', namespace, '-o', 'name'], { silent: true, timeout: 15_000 })
      .then(
        () => true,
        (error) => {
          if (/\bNotFound\b|not found/iu.test(error.stderr ?? '')) return false;
          throw new Error(`could not verify namespace cleanup for ${namespace}`);
        },
      );
    if (stillExists) {
      throw new Error(`cleanup failed for isolated namespace ${namespace}${deleteError ? `: ${deleteError.message}` : ''}`);
    }
    console.log(`Cleaned isolated namespace ${namespace}`);
  }
}
