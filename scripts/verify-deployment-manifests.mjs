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
  const compose = stripYamlComments(readText('docker-compose.yml'));
  const clickHouseConfigFile = readText('deploy/clickhouse-memory.xml').trim();
  const expectedClickHouseConfig = `<clickhouse>
  <max_server_memory_usage>2147483648</max_server_memory_usage>
  <merges_mutations_memory_usage_soft_limit>536870912</merges_mutations_memory_usage_soft_limit>
  <merge_tree>
    <vertical_merge_algorithm_min_rows_to_activate>0</vertical_merge_algorithm_min_rows_to_activate>
  </merge_tree>
  <metric_log>
    <collect_interval_milliseconds>10000</collect_interval_milliseconds>
    <flush_interval_milliseconds>60000</flush_interval_milliseconds>
  </metric_log>
</clickhouse>`;
  const clickHouseComposeService = compose
    .split(/^  clickhouse:\s*$/mu)[1]
    ?.split(/^  [a-zA-Z0-9_-]+:\s*$/mu)[0] ?? '';
  const anySentryComposeService = compose
    .split(/^  anysentry:\s*$/mu)[1]
    ?.split(/^  [a-zA-Z0-9_-]+:\s*$/mu)[0] ?? '';
  const anySentryDeployment = docFor(docs, 'Deployment', 'anysentry');
  const anySentryService = docFor(docs, 'Service', 'anysentry');
  const clickHouseMemoryConfig = docFor(docs, 'ConfigMap', 'clickhouse-memory-config');
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
  const clickHouseSelectedResources = docs
    .filter((doc) => /^  labels:\s*\{\s*app:\s*clickhouse\s*\}\s*$/mu.test(doc.source))
    .map((doc) => `${doc.kind}/${doc.name}`)
    .sort();

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
    'AnySentry Deployment bounds its event hot ring and Observer request bodies',
    /\{\s*name:\s*ANYSENTRY_EVENT_RING_MAX,\s*value:\s*"10000"\s*\}/u.test(anySentryDeployment?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_OBSERVER_BODY_LIMIT,\s*value:\s*"4mb"\s*\}/u.test(anySentryDeployment?.source ?? ''),
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
    'AnySentry gives its graceful event-buffer drain 30 seconds',
    /^\s{6}terminationGracePeriodSeconds:\s*30\s*$/mu.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'Docker Compose gives AnySentry the same 30-second event-buffer drain',
    /^    stop_grace_period:\s*30s\s*$/mu.test(anySentryComposeService),
    anySentryComposeService,
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
    'Bundled ClickHouse readiness probe gates /ping every second and fails after three misses',
    /readinessProbe:\s*\n\s*httpGet:\s*\{\s*path:\s*\/ping,\s*port:\s*8123\s*\}\s*\n\s*initialDelaySeconds:\s*0\s*\n\s*periodSeconds:\s*1\s*\n\s*timeoutSeconds:\s*1\s*\n\s*failureThreshold:\s*3\s*\n\s*successThreshold:\s*1/u.test(
      clickHouseDeployment?.source ?? '',
    ),
    clickHouseDeployment?.source,
  );
  assert(
    'Bundled ClickHouse gets a 30-second graceful stop window',
    /^\s{6}terminationGracePeriodSeconds:\s*30\s*$/mu.test(clickHouseDeployment?.source ?? ''),
    clickHouseDeployment?.source,
  );
  assert(
    'Bundled ClickHouse has explicit foreground and background memory guards',
    Boolean(clickHouseMemoryConfig) &&
      /^  namespace:\s*anysentry\s*$/mu.test(clickHouseMemoryConfig?.source ?? '') &&
      /labels:\s*\{\s*app:\s*clickhouse\s*\}/u.test(clickHouseMemoryConfig?.source ?? '') &&
      /^data:\s*\n  memory\.xml:\s*\|\s*\n    <clickhouse>\s*\n      <max_server_memory_usage>2147483648<\/max_server_memory_usage>\s*\n      <merges_mutations_memory_usage_soft_limit>536870912<\/merges_mutations_memory_usage_soft_limit>\s*\n      <merge_tree>\s*\n        <vertical_merge_algorithm_min_rows_to_activate>0<\/vertical_merge_algorithm_min_rows_to_activate>\s*\n      <\/merge_tree>\s*\n      <metric_log>\s*\n        <collect_interval_milliseconds>10000<\/collect_interval_milliseconds>\s*\n        <flush_interval_milliseconds>60000<\/flush_interval_milliseconds>\s*\n      <\/metric_log>\s*\n    <\/clickhouse>\s*$/mu.test(
        clickHouseMemoryConfig?.source ?? '',
      ) &&
      countMatches(clickHouseMemoryConfig?.source ?? '', /<max_server_memory_usage>/gu) === 1 &&
      countMatches(clickHouseMemoryConfig?.source ?? '', /<merges_mutations_memory_usage_soft_limit>/gu) === 1 &&
      countMatches(clickHouseMemoryConfig?.source ?? '', /<vertical_merge_algorithm_min_rows_to_activate>/gu) === 1 &&
      clickHouseConfigFile === expectedClickHouseConfig &&
      !/max_server_memory_usage_to_ram_ratio/u.test(clickHouseMemoryConfig?.source ?? ''),
    clickHouseMemoryConfig?.source,
  );
  assert(
    'Docker Compose mounts the same ClickHouse guards with a 4 GiB no-swap cgroup and 30-second stop',
    /^      - \.\/deploy\/clickhouse-memory\.xml:\/etc\/clickhouse-server\/config\.d\/20-anysentry-memory\.xml:ro\s*$/mu.test(
      clickHouseComposeService,
    ) &&
      /^    mem_limit:\s*4g\s*$/mu.test(clickHouseComposeService) &&
      /^    memswap_limit:\s*4g\s*$/mu.test(clickHouseComposeService) &&
      /^    stop_grace_period:\s*30s\s*$/mu.test(clickHouseComposeService),
    clickHouseComposeService,
  );
  assert(
    'ClickHouse PodTemplate pins the mounted merge configuration revision',
    /annotations:\s*\n\s*anysentry\.io\/clickhouse-config-revision:\s*"memory-and-merge-v2"/u.test(
      clickHouseDeployment?.source ?? '',
    ),
    clickHouseDeployment?.source,
  );
  assert(
    'Bundled ClickHouse mounts the memory budget read-only',
    /\{\s*name:\s*memory-config,\s*mountPath:\s*\/etc\/clickhouse-server\/config\.d\/20-anysentry-memory\.xml,\s*subPath:\s*memory\.xml,\s*readOnly:\s*true\s*\}/u.test(
      clickHouseDeployment?.source ?? '',
    ) &&
      /name:\s*memory-config\s*\n\s*configMap:\s*\n\s*name:\s*clickhouse-memory-config\s*\n\s*items:\s*\n\s*-\s*\{\s*key:\s*memory\.xml,\s*path:\s*memory\.xml\s*\}/u.test(
        clickHouseDeployment?.source ?? '',
      ),
    clickHouseDeployment?.source,
  );
  assert(
    'The ClickHouse apply selector targets only its ConfigMap, Deployment, and Service',
    JSON.stringify(clickHouseSelectedResources) ===
      JSON.stringify(['ConfigMap/clickhouse-memory-config', 'Deployment/clickhouse', 'Service/clickhouse']),
    clickHouseSelectedResources,
  );
  assert(
    'Bundled ClickHouse reserves 1 GiB and is capped at 4 GiB',
    /requests:\s*\{\s*cpu:\s*250m,\s*memory:\s*1Gi\s*\}/u.test(clickHouseDeployment?.source ?? '') &&
      /limits:\s*\{\s*cpu:\s*"2",\s*memory:\s*4Gi\s*\}/u.test(clickHouseDeployment?.source ?? ''),
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
    'Observer DaemonSet gives the PID1 supervisor a 30-second termination window',
    /\bterminationGracePeriodSeconds:\s*30\b/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
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
    'Observer DaemonSet starts in shadow while measuring Unknown, non-Agent, and routine-noise decisions',
    /\{\s*name:\s*FORWARD_FILTER_MODE,\s*value:\s*"shadow"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETAIN_UNKNOWN,\s*value:\s*"true"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETAIN_NON_AGENT,\s*value:\s*"false"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_NOISE_POLICY,\s*value:\s*"balanced"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet consumes identity snapshots and bounds all queued, in-flight, and retry-owned events',
    /\{\s*name:\s*ANYSENTRY_IDENTITY_SNAPSHOT_URL,\s*value:\s*"http:\/\/anysentry:29653\/security-center\/identity\/snapshot"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_IDENTITY_SNAPSHOT_MAX_BYTES,\s*value:\s*"4194304"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_BATCH_SIZE,\s*value:\s*"32"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_BATCH_MAX_BYTES,\s*value:\s*"524288"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_EVENT_BYTES,\s*value:\s*"3145728"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_OUTSTANDING_EVENTS,\s*value:\s*"16384"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_OUTSTANDING_BYTES,\s*value:\s*"67108864"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETRY_BASE_DELAY_MS,\s*value:\s*"250"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETRY_MAX_DELAY_MS,\s*value:\s*"2000"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETRY_MAX_AGE_MS,\s*value:\s*"45000"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_SHUTDOWN_TIMEOUT_MS,\s*value:\s*"15000"\s*\}/u.test(daemonSet?.source ?? '') &&
      !/\{\s*name:\s*FORWARD_MAX_QUEUE(?:_BYTES)?,/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet mounts a hot-reloadable low-trust runtime signature document',
    /agent-runtime-signatures\.json/u.test(observerText) &&
      /\{\s*name:\s*ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE,\s*value:\s*"\/etc\/anysentry\/agent-runtime-signatures\.json"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet reports independent runtime snapshots outside event ingest',
    /\{\s*name:\s*ANYSENTRY_AGENT_RUNTIME_LEASE_URL,\s*value:\s*"http:\/\/anysentry:29653\/security-center\/runtime\/lease"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL,\s*value:\s*"http:\/\/anysentry:29653\/security-center\/runtime\/snapshot"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS,\s*value:\s*"10"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet runs the no-shell lifecycle supervisor as container PID1',
    /command:\s*\["\/usr\/local\/bin\/node"\]/u.test(daemonSet?.source ?? '') &&
      /args:\s*\["\/opt\/observer-supervisor\.js"\]/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*OBSERVER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS,\s*value:\s*"20000"\s*\}/u.test(daemonSet?.source ?? '') &&
      !/command:\s*\["\/bin\/sh",\s*"-c"\]/u.test(daemonSet?.source ?? '') &&
      !/a3s-observer-collector\s*\|/u.test(daemonSet?.source ?? ''),
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
  assert('Observer forwarder image bundles the PID1 supervisor', /^COPY scripts\/observer-supervisor\.js \/opt\/observer-supervisor\.js$/mu.test(dockerfile), dockerfile);
  assert(
    'Observer forwarder image defaults to the supervisor as PID1',
    /^ENTRYPOINT \["\/usr\/local\/bin\/node", "\/opt\/observer-supervisor\.js"\]$/mu.test(dockerfile),
    dockerfile,
  );
  assert('Observer forwarder image bundles scripts/observer-forward.js', /^COPY scripts\/observer-forward\.js \/opt\/observer-forward\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles PID attribution', /^COPY scripts\/observer-agent-attribution\.js \/opt\/observer-agent-attribution\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles field-merge attribution', /^COPY scripts\/observer-attribution-merge\.js \/opt\/observer-attribution-merge\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles dynamic runtime signatures', /^COPY scripts\/observer-agent-runtime-signatures\.js \/opt\/observer-agent-runtime-signatures\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles ToolExec deduplication', /^COPY scripts\/observer-event-dedup\.js \/opt\/observer-event-dedup\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles workload-first filtering', /^COPY scripts\/observer-workload-filter\.js \/opt\/observer-workload-filter\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles infrastructure root filtering', /^COPY scripts\/observer-infrastructure-roots\.js \/opt\/observer-infrastructure-roots\.js$/mu.test(dockerfile), dockerfile);
  assert('Observer forwarder image bundles the test-only bounded raw witness', /^COPY scripts\/observer-e2e-witness\.js \/opt\/observer-e2e-witness\.js$/mu.test(dockerfile), dockerfile);
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

function verifyObserverLabWiring() {
  const dockerfile = stripDockerComments(readText('examples/agent-runtime-lab/Dockerfile.observer'));
  const compose = stripYamlComments(readText('examples/agent-runtime-lab/compose.yaml'));

  assert(
    'Agent runtime lab Observer image bundles the same PID1 supervisor',
    /^COPY scripts\/observer-supervisor\.js \/opt\/observer-supervisor\.js$/mu.test(dockerfile) &&
      /^ENTRYPOINT \["\/usr\/local\/bin\/node", "\/opt\/observer-supervisor\.js"\]$/mu.test(dockerfile),
    dockerfile,
  );
  assert(
    'Agent runtime lab runs the no-shell supervisor with a 30-second stop window',
    /\bstop_grace_period:\s*30s\b/u.test(compose) &&
      /entrypoint:\s*\["\/usr\/local\/bin\/node"\]/u.test(compose) &&
      /command:\s*\["\/opt\/observer-supervisor\.js"\]/u.test(compose) &&
      /observer-supervisor\.js:\/opt\/observer-supervisor\.js:ro/u.test(compose) &&
      !/a3s-observer-collector\s*\|/u.test(compose) &&
      !/entrypoint:\s*\["\/bin\/sh",\s*"-c"\]/u.test(compose),
    compose,
  );
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
  verifyObserverLabWiring();
  verifyInstaller();

  if (process.exitCode) {
    console.error('Deployment manifest verification failed');
    process.exit(process.exitCode);
  }
  console.log('Deployment manifest verification passed');
}

main();
