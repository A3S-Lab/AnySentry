#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function fail(message, details) {
  console.error(`FAIL ${message}`);
  if (details !== undefined) console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(message, condition, details) {
  if (condition) pass(message);
  else fail(message, details);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function stripYamlComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      let quote = '';
      let cut = line.length;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote) {
          if (quote === '"' && char === '\\') {
            index += 1;
          } else if (char === quote) {
            quote = '';
          }
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '#') {
          cut = index;
          break;
        }
      }
      return line.slice(0, cut).replace(/[ \t]+$/u, '');
    })
    .join('\n');
}

function stripDockerComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function unquoteScalar(value) {
  return value.trim().replace(/^["']|["']$/gu, '');
}

function metadataName(lines) {
  const metadataIndex = lines.findIndex((line) => line === 'metadata:');
  if (metadataIndex < 0) return undefined;
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/u.test(line)) return undefined;
    const match = /^  name:\s*(.+?)\s*$/u.exec(line);
    if (match) return unquoteScalar(match[1]);
  }
  return undefined;
}

function documentsFromYaml(text) {
  return stripYamlComments(text)
    .split(/^---\s*$/mu)
    .map((source) => source.trim())
    .filter(Boolean)
    .map((source) => {
      const lines = source.split(/\r?\n/);
      const kind = /^kind:\s*(.+?)\s*$/mu.exec(source)?.[1]?.trim();
      return {
        source,
        kind,
        name: metadataName(lines),
      };
    });
}

function docFor(docs, kind, name) {
  return docs.find((doc) => doc.kind === kind && doc.name === name);
}

function verifyAnySentryManifest() {
  const docs = documentsFromYaml(readText('deploy/anysentry.yaml'));
  const anySentryDeployment = docFor(docs, 'Deployment', 'anysentry');
  const anySentryService = docFor(docs, 'Service', 'anysentry');
  const clickHouseDeployment = docFor(docs, 'Deployment', 'clickhouse');
  const clickHouseService = docFor(docs, 'Service', 'clickhouse');
  const redisStatefulSet = docFor(docs, 'StatefulSet', 'redis');
  const redisService = docFor(docs, 'Service', 'redis');
  const redisPvc = docFor(docs, 'PersistentVolumeClaim', 'redis-data');
  const runtimeConfig = docFor(docs, 'ConfigMap', 'anysentry-runtime');
  const fastJudge = docFor(docs, 'Deployment', 'fast-judge');
  const l3Worker = docFor(docs, 'Deployment', 'l3-worker');
  const podReaderRole = docFor(docs, 'ClusterRole', 'anysentry-pod-reader');
  const podReaderBinding = docFor(docs, 'ClusterRoleBinding', 'anysentry-pod-reader');

  assert('AnySentry Deployment manifest exists', Boolean(anySentryDeployment));
  assert(
    'AnySentry Deployment uses the published service image',
    /\bimage:\s*ghcr\.io\/a3s-lab\/anysentry:latest\b/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry Deployment binds container port 29653',
    /\bcontainerPort:\s*29653\b/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry Deployment sets PORT=29653',
    /\{\s*name:\s*PORT,\s*value:\s*"29653"\s*\}/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry Deployment points at bundled ClickHouse HTTP service',
    /CLICKHOUSE_URL:\s*"http:\/\/clickhouse:8123"/u.test(runtimeConfig?.source ?? '') &&
      /name:\s*anysentry-runtime/u.test(anySentryDeployment?.source ?? ''),
    { runtimeConfig: runtimeConfig?.source, deployment: anySentryDeployment?.source },
  );
  assert(
    'AnySentry Deployment configures cluster-wide workload identity and an independent Agent label selector',
    /\{\s*name:\s*ANYSENTRY_IDENTITY_NAMESPACES,\s*value:\s*"\*"\s*\}/u.test(anySentryDeployment?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_AGENT_LABEL_SELECTOR,\s*value:\s*"anysentry\.io\/workload-kind=agent"\s*\}/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry startup, readiness, and liveness probes use /security-center/healthz',
    countMatches(anySentryDeployment?.source ?? '', /httpGet:\s*\{\s*path:\s*\/security-center\/healthz,\s*port:\s*29653\s*\}/gu) === 3,
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry startup probe protects at least three minutes of initialization',
    /startupProbe:[\s\S]*?periodSeconds:\s*5[\s\S]*?failureThreshold:\s*36/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry readiness and liveness checks start only after the startup probe',
    /startupProbe:/u.test(anySentryDeployment?.source ?? '') &&
      /readinessProbe:/u.test(anySentryDeployment?.source ?? '') &&
      /livenessProbe:/u.test(anySentryDeployment?.source ?? '') &&
      !/initialDelaySeconds:\s*15/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry API has production-safe CPU and memory bounds',
    /requests:\s*\{\s*cpu:\s*500m,\s*memory:\s*512Mi\s*\}/u.test(anySentryDeployment?.source ?? '') &&
      /limits:\s*\{\s*cpu:\s*"2",\s*memory:\s*2Gi\s*\}/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry Service exposes port 29653 to targetPort 29653',
    /\{\s*name:\s*http,\s*port:\s*29653,\s*targetPort:\s*29653\s*\}/u.test(anySentryService?.source ?? ''),
    anySentryService?.source,
  );

  assert(
    'Bundled ClickHouse Deployment exposes HTTP port 8123',
    /\{\s*name:\s*http,\s*containerPort:\s*8123\s*\}/u.test(clickHouseDeployment?.source ?? ''),
    clickHouseDeployment?.source,
  );
  assert(
    'Bundled ClickHouse readiness probe uses /ping on 8123',
    /httpGet:\s*\{\s*path:\s*\/ping,\s*port:\s*8123\s*\}/u.test(clickHouseDeployment?.source ?? ''),
    clickHouseDeployment?.source,
  );
  assert(
    'Bundled ClickHouse Service exposes HTTP port 8123',
    /\{\s*name:\s*http,\s*port:\s*8123,\s*targetPort:\s*8123\s*\}/u.test(clickHouseService?.source ?? ''),
    clickHouseService?.source,
  );

  assert('Redis StatefulSet, Service, and persistent volume are deployed', Boolean(redisStatefulSet) && Boolean(redisService) && Boolean(redisPvc), {
    kinds: docs.map((doc) => `${doc.kind}/${doc.name}`),
  });
  assert(
    'Redis uses durable AOF and startup/readiness/liveness probes',
    /--appendonly",\s*"yes"/u.test(redisStatefulSet?.source ?? '') &&
      /--appendfsync",\s*"everysec"/u.test(redisStatefulSet?.source ?? '') &&
      /startupProbe:/u.test(redisStatefulSet?.source ?? '') &&
      /readinessProbe:/u.test(redisStatefulSet?.source ?? '') &&
      /livenessProbe:/u.test(redisStatefulSet?.source ?? ''),
    redisStatefulSet?.source,
  );
  assert(
    'Fast Judge runs the asynchronous worker with the fast role',
    /dist\/security-monitoring\/worker-main\.js/u.test(fastJudge?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_WORKER_ROLE,\s*value:\s*"fast"\s*\}/u.test(fastJudge?.source ?? ''),
    fastJudge?.source,
  );
  assert(
    'L3 Worker runs independently with bounded concurrency and two full attempts',
    /dist\/security-monitoring\/worker-main\.js/u.test(l3Worker?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_WORKER_ROLE,\s*value:\s*"l3"\s*\}/u.test(l3Worker?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_L3_CONCURRENCY,\s*value:\s*"2"\s*\}/u.test(l3Worker?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_L3_ATTEMPTS,\s*value:\s*"2"\s*\}/u.test(l3Worker?.source ?? ''),
    l3Worker?.source,
  );

  assert('AnySentry pod identity uses a cluster-wide read-only Pod metadata binding', Boolean(podReaderRole) && Boolean(podReaderBinding), {
    kinds: docs.map((doc) => `${doc.kind}/${doc.name}`),
  });
  assert(
    'AnySentry pod reader ClusterRole is read-only for pods',
    /resources:\s*\["pods"\]/u.test(podReaderRole?.source ?? '') &&
      /verbs:\s*\["get",\s*"list",\s*"watch"\]/u.test(podReaderRole?.source ?? '') &&
      !/\b(create|update|patch|delete)\b/u.test(podReaderRole?.source ?? ''),
    podReaderRole?.source,
  );
  assert(
    'AnySentry pod reader ClusterRoleBinding targets only its ServiceAccount',
    /kind:\s*ClusterRole[\s\S]*name:\s*anysentry-pod-reader/u.test(podReaderBinding?.source ?? '') &&
      /kind:\s*ServiceAccount[\s\S]*name:\s*anysentry[\s\S]*namespace:\s*anysentry/u.test(podReaderBinding?.source ?? ''),
    podReaderBinding?.source,
  );
}

function verifyStreamingManifest() {
  const docs = documentsFromYaml(readText('deploy/streaming.yaml'));
  const kafka = docFor(docs, 'StatefulSet', 'kafka');
  const kafkaService = docFor(docs, 'Service', 'kafka');
  const topicManager = docFor(docs, 'Deployment', 'kafka-topic-manager');
  const checkpointPvc = docFor(docs, 'PersistentVolumeClaim', 'flink-checkpoints');
  const jobManager = docFor(docs, 'Deployment', 'flink-jobmanager');
  const taskManager = docFor(docs, 'Deployment', 'flink-taskmanager');
  const jobSubmit = docFor(docs, 'Deployment', 'flink-job-submit');
  const streamWorker = docFor(docs, 'Deployment', 'stream-worker');
  const compositeJudge = docFor(docs, 'Deployment', 'composite-judge');
  const assessmentWorker = docFor(docs, 'Deployment', 'supply-chain-assessment');

  assert('Kafka uses a persistent KRaft StatefulSet and namespace-local Service', Boolean(kafka) && Boolean(kafkaService), {
    kinds: docs.map((doc) => `${doc.kind}/${doc.name}`),
  });
  assert(
    'Kafka has startup/readiness/liveness protection and durable storage',
    /KAFKA_PROCESS_ROLES,\s*value:\s*"broker,controller"/u.test(kafka?.source ?? '') &&
      /startupProbe:/u.test(kafka?.source ?? '') &&
      /readinessProbe:/u.test(kafka?.source ?? '') &&
      /livenessProbe:/u.test(kafka?.source ?? '') &&
      /claimName:\s*kafka-data/u.test(kafka?.source ?? ''),
    kafka?.source,
  );
  assert(
    'Kafka topic manager reconciles all required event topics',
    [
      'anysentry.events.canonical.v1',
      'anysentry.judgments.v1',
      'anysentry.risk-analysis-batches.v1',
      'anysentry.stream.findings.v1',
      'anysentry.supply-chain.context.v1',
      'anysentry.stream.dlq.v1',
    ].every((topic) => topicManager?.source.includes(topic)),
    topicManager?.source,
  );
  assert(
    'Flink deploys JobManager, TaskManager, and the job submit controller',
    Boolean(jobManager) && Boolean(taskManager) && Boolean(jobSubmit),
    { kinds: docs.map((doc) => `${doc.kind}/${doc.name}`) },
  );
  assert(
    'Flink checkpoints use an explicit shared RWX volume',
    Boolean(checkpointPvc) &&
      /accessModes:\s*\["ReadWriteMany"\]/u.test(checkpointPvc?.source ?? '') &&
      /claimName:\s*flink-checkpoints/u.test(jobManager?.source ?? '') &&
      /claimName:\s*flink-checkpoints/u.test(taskManager?.source ?? ''),
    checkpointPvc?.source,
  );
  assert(
    'Flink JobManager health is guarded by startup/readiness/liveness probes',
    countMatches(jobManager?.source ?? '', /httpGet:\s*\{\s*path:\s*\/overview,\s*port:\s*8081\s*\}/gu) === 3,
    jobManager?.source,
  );
  assert(
    'Flink submit controller runs the packaged AnySentry streaming job',
    /org\.a3s\.anysentry\.streaming\.AnySentryStreamJob/u.test(jobSubmit?.source ?? '') &&
      /anysentry-flink-streaming\.jar/u.test(jobSubmit?.source ?? '') &&
      /ANYSENTRY_FLINK_LEGACY_COMPOSITE_ENABLED,\s*value:\s*"off"/u.test(jobSubmit?.source ?? ''),
    jobSubmit?.source,
  );
  assert(
    'Stream Worker consumes Flink findings and episodes',
    /dist\/security-monitoring\/stream-worker-main\.js/u.test(streamWorker?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_STREAM_WORKER_ROLE,\s*value:\s*"all"\s*\}/u.test(streamWorker?.source ?? ''),
    streamWorker?.source,
  );
  assert(
    'Composite Judge is an independent model-review worker',
    /dist\/security-monitoring\/stream-worker-main\.js/u.test(compositeJudge?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_STREAM_WORKER_ROLE,\s*value:\s*"judge"\s*\}/u.test(compositeJudge?.source ?? '') &&
      /anysentry-model-credentials/u.test(compositeJudge?.source ?? ''),
    compositeJudge?.source,
  );
  assert(
    'OSV assessment worker refreshes supply-chain intelligence independently',
    /dist\/security-monitoring\/supply-chain-worker-main\.js/u.test(assessmentWorker?.source ?? '') &&
      /ANYSENTRY_OSV_API_URL/u.test(assessmentWorker?.source ?? '') &&
      /ANYSENTRY_OSV_REFRESH_INTERVAL_MS/u.test(assessmentWorker?.source ?? ''),
    assessmentWorker?.source,
  );
}

function verifyObserverManifest() {
  const observerText = stripYamlComments(readText('deploy/observer.yaml'));
  const docs = documentsFromYaml(observerText);
  const daemonSet = docFor(docs, 'DaemonSet', 'a3s-observer');

  assert('Observer DaemonSet manifest exists', Boolean(daemonSet));
  assert('Observer DaemonSet runs with hostPID for host process identity', /\bhostPID:\s*true\b/u.test(daemonSet?.source ?? ''), daemonSet?.source);
  assert('Observer DaemonSet grants privileged eBPF access', /\bprivileged:\s*true\b/u.test(daemonSet?.source ?? ''), daemonSet?.source);
  assert(
    'Observer DaemonSet forwards to AnySentry ingest API',
    /\{\s*name:\s*ANYSENTRY_INGEST_URL,\s*value:\s*"http:\/\/anysentry:29653\/security-center\/ingest"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet identifies itself as an observer Source',
    /\{\s*name:\s*ANYSENTRY_SOURCE_TYPE,\s*value:\s*"observer"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_SOURCE_NAME,\s*value:\s*"kubernetes-a3s-observer"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet emits collector heartbeats every 30 seconds',
    /\{\s*name:\s*ANYSENTRY_HEARTBEAT_SECS,\s*value:\s*"30"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet independently retains Unknown, drops non-Agent, and filters routine noise',
    /\{\s*name:\s*FORWARD_FILTER_MODE,\s*value:\s*"enforce"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETAIN_UNKNOWN,\s*value:\s*"true"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETAIN_NON_AGENT,\s*value:\s*"false"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_NOISE_POLICY,\s*value:\s*"balanced"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet consumes identity snapshots and uses bounded batching',
    /\{\s*name:\s*ANYSENTRY_IDENTITY_SNAPSHOT_URL,\s*value:\s*"http:\/\/anysentry:29653\/security-center\/identity\/snapshot"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_BATCH_SIZE,\s*value:\s*"32"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_QUEUE,\s*value:\s*"4096"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet pipes observe-only collector output into the Node forwarder',
    /command:\s*\["\/bin\/sh",\s*"-c"\]/u.test(daemonSet?.source ?? '') &&
      /args:\s*\["a3s-observer-collector \| node \/opt\/observer-forward\.js"\]/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert('Observer DaemonSet does not run enforcement binaries', !/\ba3s-observer-enforce\b/u.test(observerText) && !/\bfileguard\b/u.test(observerText), daemonSet?.source);
}

function verifyIngressManifest() {
  const docs = documentsFromYaml(readText('deploy/ingress.yaml'));
  const ingress = docFor(docs, 'Ingress', 'anysentry');
  assert('Ingress manifest routes to the AnySentry Service', Boolean(ingress) && /\bname:\s*anysentry\b/u.test(ingress.source), ingress?.source);
  assert('Ingress manifest routes traffic to service port 29653', /\bnumber:\s*29653\b/u.test(ingress?.source ?? ''), ingress?.source);
}

function verifyDockerfile() {
  const dockerfile = stripDockerComments(readText('Dockerfile'));

  assert('Runtime image is ubuntu:24.04 for the sentry native module ABI', /^FROM ubuntu:24\.04 AS runtime$/mu.test(dockerfile), dockerfile);
  assert('Dockerfile carries PUBLIC_BASE_PATH through build and runtime stages', countMatches(dockerfile, /^ARG PUBLIC_BASE_PATH=""$/gmu) >= 2 && /\bPUBLIC_BASE_PATH=\$\{PUBLIC_BASE_PATH\}/u.test(dockerfile), dockerfile);
  assert('Runtime image serves the built dashboard from /app/web', /\bANYSENTRY_WEB_DIR=\/app\/web\b/u.test(dockerfile) && /^COPY --from=build \/src\/apps\/web\/dist \.\/web$/mu.test(dockerfile), dockerfile);
  assert('Runtime image exposes port 29653 and starts the API entrypoint', /^EXPOSE 29653$/mu.test(dockerfile) && /^CMD \["node", "dist\/main\.js"\]$/mu.test(dockerfile), dockerfile);
}

function verifyObserverForwarderDockerfile() {
  const dockerfile = stripDockerComments(readText('deploy/observer-forwarder.Dockerfile'));

  assert(
    'Observer forwarder image defaults to the public observer image and permits a tested build override',
    /^ARG OBSERVER_IMAGE=ghcr\.io\/a3s-lab\/observer:latest$/mu.test(dockerfile) &&
      /^FROM \$\{OBSERVER_IMAGE\}$/mu.test(dockerfile),
    dockerfile,
  );
  assert(
    'Observer forwarder image copies a configurable Node runtime without package install',
    /^ARG NODE_IMAGE=node:20-bookworm-slim$/mu.test(dockerfile) &&
      /^FROM \$\{NODE_IMAGE\} AS nodebin$/mu.test(dockerfile) &&
      /^COPY --from=nodebin \/usr\/local\/bin\/node \/usr\/local\/bin\/node$/mu.test(dockerfile) &&
      !/^\s*RUN\b/mu.test(dockerfile),
    dockerfile,
  );
  assert('Observer forwarder image bundles scripts/observer-forward.js', /^COPY scripts\/observer-forward\.js \/opt\/observer-forward\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles PID attribution', /^COPY scripts\/observer-agent-attribution\.js \/opt\/observer-agent-attribution\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles ToolExec deduplication', /^COPY scripts\/observer-event-dedup\.js \/opt\/observer-event-dedup\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles workload-first filtering', /^COPY scripts\/observer-workload-filter\.js \/opt\/observer-workload-filter\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles infrastructure root filtering', /^COPY scripts\/observer-infrastructure-roots\.js \/opt\/observer-infrastructure-roots\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles the bounded priority queue', /^COPY scripts\/observer-priority-queue\.js \/opt\/observer-priority-queue\.js$/mu.test(dockerfile), dockerfile);
  assert(
    'Observer forwarder image bundles operator templates and Docker discovery',
    /^COPY scripts\/observer-agent-templates\.js \/opt\/observer-agent-templates\.js$/mu.test(dockerfile) &&
      /^COPY scripts\/observer-docker-discovery\.js \/opt\/observer-docker-discovery\.js$/mu.test(dockerfile) &&
      /^COPY scripts\/observer-behavior-discovery\.js \/opt\/observer-behavior-discovery\.js$/mu.test(dockerfile),
    dockerfile,
  );
  assert('Observer forwarder image has no npm or pnpm install step', !/\b(?:npm|pnpm|yarn)\s+(?:install|ci|add)\b/iu.test(dockerfile), dockerfile);
}

function verifyInstaller() {
  const installPath = path.join(repoRoot, 'deploy/install.sh');
  const installer = readText('deploy/install.sh');
  const mode = fs.statSync(installPath).mode;

  assert('Integrated installer is executable', Boolean(mode & 0o111), { mode: mode.toString(8) });
  assert('Integrated installer supports docker mode', /install_docker\(\)/u.test(installer) && /docker compose up -d --build/u.test(installer), installer);
  assert('Integrated installer supports kubernetes mode', /install_kubernetes\(\)/u.test(installer) && /kubernetes\|k8s/u.test(installer), installer);
  assert('Integrated installer creates namespace and ClickHouse Secret', /kubectl create namespace/u.test(installer) && /create secret generic anysentry-clickhouse/u.test(installer), installer);
  assert(
    'Integrated installer renders core, streaming, and observer manifests',
    /render_core_manifest "\$ROOT_DIR\/deploy\/anysentry\.yaml"/u.test(installer) &&
      /render_streaming_manifest "\$ROOT_DIR\/deploy\/streaming\.yaml"/u.test(installer) &&
      /deploy\/observer\.yaml/u.test(installer),
    installer,
  );
  assert(
    'Integrated installer supports immutable AnySentry and Flink image overrides',
    /ANYSENTRY_IMAGE/u.test(installer) &&
      /ANYSENTRY_FLINK_IMAGE/u.test(installer) &&
      /ANYSENTRY_FLINK_IMAGE is required/u.test(installer),
    installer,
  );
  assert('Integrated installer supports optional Ingress', /ANYSENTRY_APPLY_INGRESS/u.test(installer) && /deploy\/ingress\.yaml/u.test(installer), installer);
  assert(
    'Integrated installer waits for storage, judges, streaming, OSV, and observer rollouts',
    [
      'deploy/clickhouse',
      'statefulset/redis',
      'statefulset/kafka',
      'deploy/fast-judge',
      'deploy/l3-worker',
      'deploy/flink-jobmanager',
      'deploy/flink-taskmanager',
      'deploy/stream-worker',
      'deploy/composite-judge',
      'deploy/supply-chain-assessment',
      'daemonset/a3s-observer',
    ].every((resource) => installer.includes(`rollout status ${resource}`)),
    installer,
  );
  assert('Integrated installer documents the observer, judge, streaming, and OSV stack', /a3s-observer/u.test(installer) && /Fast Judge/u.test(installer) && /Kafka, Flink/u.test(installer) && /OSV/u.test(installer), installer);
}

function main() {
  console.log('AnySentry deployment manifest verification');
  verifyAnySentryManifest();
  verifyStreamingManifest();
  verifyObserverManifest();
  verifyIngressManifest();
  verifyDockerfile();
  verifyObserverForwarderDockerfile();
  verifyInstaller();

  if (process.exitCode) {
    console.error('Deployment manifest verification failed');
    process.exit(process.exitCode);
  }
  console.log('Deployment manifest verification passed');
}

main();
