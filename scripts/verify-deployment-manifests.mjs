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

function hasCanonicalSelfInventory(doc) {
  const source = doc?.source ?? '';
  return countMatches(source, /io\.anysentry\.observe:\s*"false"/gu) === 2 &&
    countMatches(source, /anysentry\.io\/workload-role:\s*"anysentry_internal"/gu) === 2;
}

function verifyAnySentryManifest() {
  const anySentryManifest = readText('deploy/anysentry.yaml');
  const docs = documentsFromYaml(anySentryManifest);
  const compose = stripYamlComments(readText('docker-compose.yml'));
  const manualCompose = stripYamlComments(readText('deploy/docker-compose.manual-test.yml'));
  const manualRuntimeDocs = documentsFromYaml(readText('deploy/manual-test/runtime-on.yaml'));
  const manualPolicy = JSON.parse(readText('deploy/manual-test/policy.json'));
  const clickHouseConfigFile = readText('deploy/clickhouse-memory.xml').trim();
  const expectedClickHouseConfig = `<clickhouse>
  <max_server_memory_usage>2147483648</max_server_memory_usage>
  <merges_mutations_memory_usage_soft_limit>536870912</merges_mutations_memory_usage_soft_limit>
  <merge_tree>
    <vertical_merge_algorithm_min_rows_to_activate>0</vertical_merge_algorithm_min_rows_to_activate>
  </merge_tree>
  <!-- High-volume metric_log remains explicitly disabled by 10-anysentry-server.xml. -->
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
  const clickHouseBaseConfig = docFor(docs, 'ConfigMap', 'clickhouse-base-config');
  const clickHouseDeployment = docFor(docs, 'Deployment', 'clickhouse');
  const clickHouseService = docFor(docs, 'Service', 'clickhouse');
  const redisStatefulSet = docFor(docs, 'StatefulSet', 'redis');
  const redisService = docFor(docs, 'Service', 'redis');
  const redisPvc = docFor(docs, 'PersistentVolumeClaim', 'redis-data');
  const runtimeConfig = docFor(docs, 'ConfigMap', 'anysentry-runtime');
  const manualRuntimeConfig = docFor(manualRuntimeDocs, 'ConfigMap', 'anysentry-runtime');
  const fastJudge = docFor(docs, 'Deployment', 'fast-judge');
  const l3Worker = docFor(docs, 'Deployment', 'l3-worker');
  const podReaderRole = docFor(docs, 'ClusterRole', 'anysentry-pod-reader');
  const podReaderBinding = docFor(docs, 'ClusterRoleBinding', 'anysentry-pod-reader');
  const clickHouseSelectedResources = docs
    .filter((doc) => /^  labels:\s*\{\s*app:\s*clickhouse(?:\s*,[^}]*)?\s*\}\s*$/mu.test(doc.source))
    .map((doc) => `${doc.kind}/${doc.name}`)
    .sort();

  assert('AnySentry Deployment manifest exists', Boolean(anySentryDeployment));
  assert(
    'Canonical core workloads publish exact AnySentry self-inventory while retaining the compatibility label',
    [clickHouseDeployment, redisStatefulSet, anySentryDeployment, fastJudge, l3Worker]
      .every(hasCanonicalSelfInventory) &&
      /x-anysentry-infrastructure-labels:[\s\S]*?io\.anysentry\.observe:\s*"false"[\s\S]*?anysentry\.io\/workload-role:\s*"anysentry_internal"[\s\S]*?\nservices:/u.test(compose),
    {
      workloads: [clickHouseDeployment, redisStatefulSet, anySentryDeployment, fastJudge, l3Worker]
        .map((doc) => `${doc?.kind}/${doc?.name}`),
      compose: compose.slice(0, compose.indexOf('\nservices:') + '\nservices:'.length),
    },
  );
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
    'AnySentry Deployment bounds its event hot set and Observer request bodies',
    /\{\s*name:\s*ANYSENTRY_HOT_EVENT_LIMIT,\s*value:\s*"5000"\s*\}/u.test(anySentryDeployment?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_OBSERVER_BODY_LIMIT,\s*value:\s*"16mb"\s*\}/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'Docker Compose explicitly bounds the API hot event set with the current setting name',
    /^      ANYSENTRY_HOT_EVENT_LIMIT:\s*\$\{ANYSENTRY_HOT_EVENT_LIMIT:-5000\}\s*$/mu.test(anySentryComposeService),
    anySentryComposeService,
  );
  assert(
    'Redis Source current-state projection is explicitly coalesced in Kubernetes and Compose',
    /ANYSENTRY_CURRENT_STATE_SOURCE_FLUSH_MS:\s*"1000"/u.test(runtimeConfig?.source ?? '') &&
      /^      ANYSENTRY_CURRENT_STATE_SOURCE_FLUSH_MS:\s*\$\{ANYSENTRY_CURRENT_STATE_SOURCE_FLUSH_MS:-1000\}\s*$/mu.test(anySentryComposeService),
    { runtimeConfig: runtimeConfig?.source, compose: anySentryComposeService },
  );
  assert(
    'API V8 heap is fenced below the container memory limit',
    /\{\s*name:\s*NODE_OPTIONS,\s*value:\s*"--max-old-space-size=1024"\s*\}/u.test(anySentryDeployment?.source ?? '') &&
      /^      NODE_OPTIONS:\s*\$\{ANYSENTRY_API_NODE_OPTIONS:---max-old-space-size=1024\}\s*$/mu.test(anySentryComposeService),
    { deployment: anySentryDeployment?.source, compose: anySentryComposeService },
  );
  assert(
    'Deployment manifests and Compose no longer advertise the legacy event-ring setting',
    !/ANYSENTRY_EVENT_RING_MAX/u.test(anySentryManifest) && !/ANYSENTRY_EVENT_RING_MAX/u.test(compose),
    { manifest: anySentryManifest, compose },
  );
  assert(
    'AnySentry Deployment points at bundled ClickHouse HTTP service',
    /CLICKHOUSE_URL:\s*"http:\/\/clickhouse:8123"/u.test(runtimeConfig?.source ?? '') &&
      /name:\s*anysentry-runtime/u.test(anySentryDeployment?.source ?? ''),
    { runtimeConfig: runtimeConfig?.source, deployment: anySentryDeployment?.source },
  );
  assert(
    'Production manifests retain streaming and supply-chain configuration without enabling it by default',
    /ANYSENTRY_STREAMING:\s*"off"/u.test(runtimeConfig?.source ?? '') &&
      /ANYSENTRY_SUPPLY_CHAIN:\s*"off"/u.test(runtimeConfig?.source ?? '') &&
      /ANYSENTRY_SUPPLY_CHAIN_RUNTIME:\s*"off"/u.test(runtimeConfig?.source ?? '') &&
      /^      ANYSENTRY_STREAMING:\s*\$\{ANYSENTRY_STREAMING:-off\}\s*$/mu.test(anySentryComposeService) &&
      /^      ANYSENTRY_SUPPLY_CHAIN:\s*\$\{ANYSENTRY_SUPPLY_CHAIN:-off\}\s*$/mu.test(anySentryComposeService) &&
      /^      ANYSENTRY_SUPPLY_CHAIN_RUNTIME:\s*\$\{ANYSENTRY_SUPPLY_CHAIN_RUNTIME:-off\}\s*$/mu.test(anySentryComposeService),
    { runtimeConfig: runtimeConfig?.source, compose: anySentryComposeService },
  );
  assert(
    'Canonical API declares compatible shadow readers for trusted identity, capture, and S3 semantics',
    /ANYSENTRY_TRUSTED_CORRELATION_MODE:\s*"shadow"/u.test(runtimeConfig?.source ?? '') &&
      /ANYSENTRY_CAPTURE_PROFILE_MODE:\s*"shadow"/u.test(runtimeConfig?.source ?? '') &&
      /ANYSENTRY_UNKNOWN_RETENTION_MODE:\s*"shadow"/u.test(runtimeConfig?.source ?? ''),
    runtimeConfig?.source,
  );
  assert(
    'AnySentry Deployment configures cluster-wide workload identity and an independent Agent label selector',
    /\{\s*name:\s*ANYSENTRY_IDENTITY_NAMESPACES,\s*value:\s*"\*"\s*\}/u.test(anySentryDeployment?.source ?? '') &&
      /\{\s*name:\s*ANYSENTRY_AGENT_LABEL_SELECTOR,\s*value:\s*"anysentry\.io\/workload-kind=agent"\s*\}/u.test(anySentryDeployment?.source ?? ''),
    anySentryDeployment?.source,
  );
  assert(
    'AnySentry API reads management authentication only from a Kubernetes Secret',
    /name:\s*ANYSENTRY_MANAGEMENT_TOKEN/u.test(anySentryDeployment?.source ?? '') &&
      /secretKeyRef:\s*\{\s*name:\s*anysentry-control-auth,\s*key:\s*management-token/u.test(anySentryDeployment?.source ?? '') &&
      !/ANYSENTRY_MANAGEMENT_TOKEN,\s*value:/u.test(anySentryDeployment?.source ?? ''),
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
      /^data:\s*\n  memory\.xml:\s*\|\s*\n    <clickhouse>\s*\n      <max_server_memory_usage>2147483648<\/max_server_memory_usage>\s*\n      <merges_mutations_memory_usage_soft_limit>536870912<\/merges_mutations_memory_usage_soft_limit>\s*\n      <merge_tree>\s*\n        <vertical_merge_algorithm_min_rows_to_activate>0<\/vertical_merge_algorithm_min_rows_to_activate>\s*\n      <\/merge_tree>\s*\n      <!-- High-volume metric_log remains explicitly disabled by server\.xml\. -->\s*\n    <\/clickhouse>\s*$/mu.test(
        clickHouseMemoryConfig?.source ?? '',
      ) &&
      countMatches(clickHouseMemoryConfig?.source ?? '', /<max_server_memory_usage>/gu) === 1 &&
      countMatches(clickHouseMemoryConfig?.source ?? '', /<merges_mutations_memory_usage_soft_limit>/gu) === 1 &&
      countMatches(clickHouseMemoryConfig?.source ?? '', /<vertical_merge_algorithm_min_rows_to_activate>/gu) === 1 &&
      !/<metric_log>/u.test(clickHouseMemoryConfig?.source ?? '') &&
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
    'Docker and Kubernetes merge the server, user-profile, and memory ClickHouse configurations',
    Boolean(clickHouseBaseConfig) &&
      /<logger>\s*\n\s*<level>warning<\/level>/u.test(clickHouseBaseConfig?.source ?? '') &&
      /<metric_log remove="remove"\s*\/>/u.test(clickHouseBaseConfig?.source ?? '') &&
      /<query_log>\s*\n\s*<ttl>event_date \+ INTERVAL 3 DAY DELETE<\/ttl>/u.test(clickHouseBaseConfig?.source ?? '') &&
      /<max_memory_usage>1073741824<\/max_memory_usage>/u.test(clickHouseBaseConfig?.source ?? '') &&
      /configMap:\s*\n\s*name:\s*clickhouse-base-config/u.test(clickHouseDeployment?.source ?? '') &&
      /config\.d\/10-anysentry-server\.xml/u.test(clickHouseDeployment?.source ?? '') &&
      /config\.d\/20-anysentry-memory\.xml/u.test(clickHouseDeployment?.source ?? '') &&
      /users\.d\/10-anysentry-users\.xml/u.test(clickHouseDeployment?.source ?? '') &&
      /config\/clickhouse\/anysentry-server\.xml:\/etc\/clickhouse-server\/config\.d\/10-anysentry-server\.xml:ro/u.test(clickHouseComposeService) &&
      /config\/clickhouse\/anysentry-users\.xml:\/etc\/clickhouse-server\/users\.d\/10-anysentry-users\.xml:ro/u.test(clickHouseComposeService),
    { baseConfig: clickHouseBaseConfig?.source, deployment: clickHouseDeployment?.source, compose: clickHouseComposeService },
  );
  assert(
    'ClickHouse PodTemplate pins the mounted merge configuration revision',
    /annotations:\s*\n\s*anysentry\.io\/clickhouse-config-revision:\s*"memory-and-merge-v3"/u.test(
      clickHouseDeployment?.source ?? '',
    ),
    clickHouseDeployment?.source,
  );
  assert(
    'Manual-test overrides enable streaming, supply-chain, runtime correlation, and all judgment tiers without credentials',
    /ANYSENTRY_STREAMING:\s*"on"/u.test(manualCompose) &&
      /ANYSENTRY_SUPPLY_CHAIN:\s*"on"/u.test(manualCompose) &&
      /ANYSENTRY_SUPPLY_CHAIN_RUNTIME:\s*"on"/u.test(manualCompose) &&
      /ANYSENTRY_STREAMING:\s*"on"/u.test(manualRuntimeConfig?.source ?? '') &&
      /ANYSENTRY_SUPPLY_CHAIN:\s*"on"/u.test(manualRuntimeConfig?.source ?? '') &&
      /ANYSENTRY_SUPPLY_CHAIN_RUNTIME:\s*"on"/u.test(manualRuntimeConfig?.source ?? '') &&
      /ANYSENTRY_ASSISTANT:\s*"on"/u.test(manualRuntimeConfig?.source ?? '') &&
      /ANYSENTRY_TRUSTED_CORRELATION_MODE:\s*"enabled"/u.test(manualRuntimeConfig?.source ?? '') &&
      /ANYSENTRY_CAPTURE_PROFILE_MODE:\s*"enforce"/u.test(manualRuntimeConfig?.source ?? '') &&
      /ANYSENTRY_UNKNOWN_RETENTION_MODE:\s*"enforce"/u.test(manualRuntimeConfig?.source ?? '') &&
      /ANYSENTRY_UNKNOWN_LEARNING_ENABLED:\s*"true"/u.test(manualRuntimeConfig?.source ?? '') &&
      Array.isArray(manualPolicy.rules) &&
      Boolean(manualPolicy.llm?.url) &&
      Boolean(manualPolicy.deepModel?.url) &&
      Boolean(manualPolicy.agent?.bin) &&
      !/apiKey|api_key|key/iu.test(JSON.stringify(manualPolicy)),
    { manualCompose, manualRuntime: manualRuntimeConfig?.source, manualPolicy },
  );
  assert(
    'Manual-test Observer keeps deterministic signature and workload discovery without behavior-promoting unrelated workloads',
    /ANYSENTRY_DOCKER_DISCOVERY:\s*"on"/u.test(manualCompose) &&
      /ANYSENTRY_BEHAVIOR_DISCOVERY:\s*"off"/u.test(manualCompose) &&
      /observer:[\s\S]*?io\.anysentry\.observe:\s*"false"[\s\S]*?anysentry\.io\/workload-role:\s*"anysentry_internal"/u.test(manualCompose),
    manualCompose,
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
    'The ClickHouse apply selector includes both configuration maps, Deployment, and Service',
    JSON.stringify(clickHouseSelectedResources) ===
      JSON.stringify(['ConfigMap/clickhouse-base-config', 'ConfigMap/clickhouse-memory-config', 'Deployment/clickhouse', 'Service/clickhouse']),
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
    'Redis reserves its recovered working set and bounded AOF replay headroom',
    /requests:\s*\{\s*cpu:\s*100m,\s*memory:\s*1Gi\s*\}/u.test(redisStatefulSet?.source ?? '') &&
      /limits:\s*\{\s*cpu:\s*"1",\s*memory:\s*2Gi\s*\}/u.test(redisStatefulSet?.source ?? ''),
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
    'AnySentry workload reader ClusterRole is read-only for Pods, Services, ConfigMaps, and ReplicaSets',
    /resources:\s*\["pods",\s*"services",\s*"configmaps"\]/u.test(podReaderRole?.source ?? '') &&
      /apiGroups:\s*\["apps"\][\s\S]*resources:\s*\["replicasets"\]/u.test(podReaderRole?.source ?? '') &&
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
  const topicManager = docFor(docs, 'Job', 'kafka-topic-manager');
  const checkpointPvc = docFor(docs, 'PersistentVolumeClaim', 'flink-checkpoints');
  const jobManagerService = docFor(docs, 'Service', 'flink-jobmanager');
  const jobManager = docFor(docs, 'Deployment', 'flink-jobmanager');
  const taskManager = docFor(docs, 'Deployment', 'flink-taskmanager');
  const jobSubmit = docFor(docs, 'Deployment', 'flink-job-submit');
  const streamWorker = docFor(docs, 'Deployment', 'stream-worker');
  const compositeJudge = docFor(docs, 'Deployment', 'composite-judge');
  const assessmentWorker = docFor(docs, 'Deployment', 'supply-chain-assessment');

  assert(
    'Canonical streaming workloads publish exact AnySentry self-inventory while retaining the compatibility label',
    [kafka, topicManager, jobManager, taskManager, jobSubmit, streamWorker, compositeJudge, assessmentWorker]
      .every(hasCanonicalSelfInventory),
    [kafka, topicManager, jobManager, taskManager, jobSubmit, streamWorker, compositeJudge, assessmentWorker]
      .map((doc) => doc?.source),
  );

  assert('Kafka uses a persistent KRaft StatefulSet and namespace-local Service', Boolean(kafka) && Boolean(kafkaService), {
    kinds: docs.map((doc) => `${doc.kind}/${doc.name}`),
  });
  assert(
    'Kafka headless Service publishes its not-ready endpoint for single-node KRaft self-bootstrap',
    /clusterIP:\s*None/u.test(kafkaService?.source ?? '') &&
      /publishNotReadyAddresses:\s*true/u.test(kafkaService?.source ?? ''),
    kafkaService?.source,
  );
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
    'Kafka topic manager creates all required topics once without a permanent process loop',
    [
      'anysentry.events.canonical.v1',
      'anysentry.judgments.v1',
      'anysentry.risk-analysis-batches.v1',
      'anysentry.stream.findings.v1',
      'anysentry.supply-chain.context.v1',
      'anysentry.stream.dlq.v1',
    ].every((topic) => topicManager?.source.includes(topic)) &&
      /restartPolicy:\s*OnFailure/u.test(topicManager?.source ?? '') &&
      /backoffLimit:\s*20/u.test(topicManager?.source ?? '') &&
      /ttlSecondsAfterFinished:\s*600/u.test(topicManager?.source ?? '') &&
      !/while\s+true|sleep\s+60/u.test(topicManager?.source ?? ''),
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
    'Flink JobManager Service exposes RPC, BlobServer, and REST ports',
    /\{\s*name:\s*rpc,\s*port:\s*6123,\s*targetPort:\s*6123\s*\}/u.test(jobManagerService?.source ?? '') &&
      /\{\s*name:\s*blob,\s*port:\s*6124,\s*targetPort:\s*6124\s*\}/u.test(jobManagerService?.source ?? '') &&
      /\{\s*name:\s*rest,\s*port:\s*8081,\s*targetPort:\s*8081\s*\}/u.test(jobManagerService?.source ?? '') &&
      /\{\s*name:\s*blob,\s*containerPort:\s*6124\s*\}/u.test(jobManager?.source ?? ''),
    { service: jobManagerService?.source, deployment: jobManager?.source },
  );
  assert(
    'Flink submit controller runs the packaged AnySentry streaming job',
    /org\.a3s\.anysentry\.streaming\.AnySentryStreamJob/u.test(jobSubmit?.source ?? '') &&
      /anysentry-flink-streaming\.jar/u.test(jobSubmit?.source ?? '') &&
      /ANYSENTRY_FLINK_LEGACY_COMPOSITE_ENABLED,\s*value:\s*"off"/u.test(jobSubmit?.source ?? ''),
    jobSubmit?.source,
  );
  assert(
    'Flink submit controller treats one exact non-terminal job name as active',
    jobSubmit?.source.includes("grep -Eq ' : AnySentry Flink Shadow Risk \\([[:upper:]_]+\\)$'") &&
      !jobSubmit?.source.includes('AnySentry Flink Shadow Risk (RUNNING)'),
    jobSubmit?.source,
  );
  assert(
    'Flink submit controller uses Recreate so manifest updates cannot overlap reconcilers',
    /strategy:\s*\n\s*type:\s*Recreate/u.test(jobSubmit?.source ?? ''),
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
  assert(
    'Observer publishes exact AnySentry self-inventory while retaining the compatibility label',
    hasCanonicalSelfInventory(daemonSet),
    daemonSet?.source,
  );
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
    'Observer DaemonSet consumes per-node managed Source credentials and management auth from Secrets',
    /ANYSENTRY_SOURCE_CREDENTIALS_FILE[\s\S]*?\/etc\/anysentry-auth\/observer-sources\.json/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN[\s\S]*?anysentry-control-auth[\s\S]*?management-token/u.test(daemonSet?.source ?? '') &&
      /secretName:\s*anysentry-observer-auth/u.test(daemonSet?.source ?? '') &&
      /key:\s*observer-sources\.json,\s*path:\s*observer-sources\.json,\s*mode:\s*0400/u.test(daemonSet?.source ?? ''),
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
      /\{\s*name:\s*ANYSENTRY_UNKNOWN_RETENTION_MODE,\s*value:\s*"shadow"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETAIN_UNKNOWN,\s*value:\s*"true"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETAIN_NON_AGENT,\s*value:\s*"false"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_NOISE_POLICY,\s*value:\s*"balanced"\s*\}/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet shares one shadow Capture Profile/ACK wire between Collector and Forwarder',
    /\{\s*name:\s*ANYSENTRY_CAPTURE_PROFILE_MODE,\s*value:\s*"shadow"\s*\}/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_FILTER_RULES_ACK_FILE[\s\S]*?filter-rules\.ack\.json/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_INFRASTRUCTURE_POLICY_URL[\s\S]*?infrastructure-rules\/policy/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_INFRASTRUCTURE_MATERIALIZATION_URL[\s\S]*?infrastructure-rules\/materializations\/report/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_FILTER_RULE_PROJECTION_URL[\s\S]*?filter-rules\/projections\/forwarder/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_FILTER_RULE_PROJECTION_SECS,\s*value:\s*"5"/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_FILTER_RULE_PROJECTION_MAX_BYTES,\s*value:\s*"16777216"/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_TLS_AGENT_CGROUPS_FILE[\s\S]*?tls-agent-cgroups\.json/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_CAPTURE_PROFILE_ACK_POLL_MS,\s*value:\s*"250"/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet bounds probable-Agent investigation by TTL and node capacity',
    /ANYSENTRY_PROBABLE_PROFILE_TTL_MS,\s*value:\s*"120000"/u.test(daemonSet?.source ?? '') &&
      /ANYSENTRY_PROBABLE_PROFILE_MAX_ENTRIES,\s*value:\s*"4096"/u.test(daemonSet?.source ?? ''),
    daemonSet?.source,
  );
  assert(
    'Observer DaemonSet consumes identity snapshots and bounds all queued, in-flight, and retry-owned events',
    /\{\s*name:\s*ANYSENTRY_IDENTITY_SNAPSHOT_URL,\s*value:\s*"http:\/\/anysentry:29653\/security-center\/identity\/snapshot"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_IDENTITY_SNAPSHOT_MAX_BYTES,\s*value:\s*"4194304"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_BATCH_SIZE,\s*value:\s*"32"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_INFLIGHT,\s*value:\s*"4"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*A3S_OBSERVER_JSON_BULK_QUEUE_CAPACITY,\s*value:\s*"262144"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*A3S_OBSERVER_BULK_INBOX_CAPACITY,\s*value:\s*"65536"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_CONTROL_HTTP_TIMEOUT_MS,\s*value:\s*"15000"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_SPOOL_COMPACT_MAX_LIVE_RECORDS,\s*value:\s*"16384"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_WAL_PENDING_MAX_EVENTS,\s*value:\s*"65536"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_WAL_PENDING_MAX_BYTES,\s*value:\s*"268435456"\s*\}/u.test(daemonSet?.source ?? '') &&
      /requests:\s*\{\s*cpu:\s*50m,\s*memory:\s*256Mi\s*\}/u.test(daemonSet?.source ?? '') &&
      /limits:\s*\{\s*memory:\s*2Gi\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_BATCH_MAX_BYTES,\s*value:\s*"524288"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_EVENT_BYTES,\s*value:\s*"12582912"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_OUTSTANDING_EVENTS,\s*value:\s*"16384"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_MAX_OUTSTANDING_BYTES,\s*value:\s*"67108864"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_PROTECTED_RESERVE_EVENTS,\s*value:\s*"4096"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_PROTECTED_RESERVE_BYTES,\s*value:\s*"16777216"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETRY_BASE_DELAY_MS,\s*value:\s*"250"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETRY_MAX_DELAY_MS,\s*value:\s*"2000"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_RETRY_MAX_AGE_MS,\s*value:\s*"45000"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_SPOOL_REPLAY_INTERVAL_MS,\s*value:\s*"500"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_SPOOL_REPLAY_BATCH_SIZE,\s*value:\s*"256"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_SPOOL_DEGRADED_AGE_MS,\s*value:\s*"60000"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_SHUTDOWN_TIMEOUT_MS,\s*value:\s*"15000"\s*\}/u.test(daemonSet?.source ?? '') &&
      /\{\s*name:\s*FORWARD_SPOOL_PATH,\s*value:\s*"\/var\/lib\/anysentry-forwarder\/spool\.wal"\s*\}/u.test(daemonSet?.source ?? '') &&
      /name:\s*forwarder-spool[\s\S]*mountPath:\s*\/var\/lib\/anysentry-forwarder/u.test(daemonSet?.source ?? '') &&
      /name:\s*forwarder-spool[\s\S]*hostPath:\s*\{\s*path:\s*\/var\/lib\/anysentry-forwarder,\s*type:\s*DirectoryOrCreate\s*\}/u.test(daemonSet?.source ?? '') &&
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

function verifyManualKubernetesObserverOverlay() {
  const kustomization = stripYamlComments(readText('deploy/manual-test/k8s-observer/kustomization.yaml'));
  const observerPatchText = readText('deploy/manual-test/k8s-observer/observer-manual-patch.yaml');
  const observerPatch = stripYamlComments(observerPatchText);
  const fileCanaryKustomization = stripYamlComments(readText('deploy/manual-test/k8s-observer-file-canary/kustomization.yaml'));
  const fileCanaryPatch = stripYamlComments(readText('deploy/manual-test/k8s-observer-file-canary/file-access-canary-patch.yaml'));
  const fullFileKustomization = stripYamlComments(readText('deploy/manual-test/k8s-observer-files-full/kustomization.yaml'));
  const fullFilePatch = stripYamlComments(readText('deploy/manual-test/k8s-observer-files-full/full-file-probe-patch.yaml'));
  const manualGuide = readText('deploy/manual-test/README.md');
  const rulesPatch = readText('deploy/manual-test/k8s-observer/rules-version2-patch.yaml');
  const rulesLines = rulesPatch.split(/\r?\n/u);
  const literalStart = rulesLines.findIndex((line) => /^  agent-runtime-signatures\.json:\s*\|\s*$/u.test(line));
  const literalLines = [];
  for (const line of rulesLines.slice(literalStart + 1)) {
    if (line !== '' && !/^    /u.test(line)) break;
    literalLines.push(line);
  }
  let runtimeDocument;
  try {
    runtimeDocument = JSON.parse(literalLines.map((line) => line.slice(4)).join('\n'));
  } catch {
    runtimeDocument = undefined;
  }

  assert(
    'Manual Kubernetes Observer overlay pins one immutable local image digest',
    /resources:\s*\n\s*-\s*\.\.\/\.\.\/observer\.yaml/u.test(kustomization) &&
      /newName:\s*127\.0\.0\.1:5000\/anysentry-observer/u.test(kustomization) &&
      /digest:\s*sha256:[0-9a-f]{64}/u.test(kustomization) &&
      !/:latest\b/u.test(kustomization),
    kustomization,
  );
  assert(
    'Manual Kubernetes Observer overlay keeps one Docker-aware lossless collector while disabling fixed-ring file capture and behavior promotion',
    /\{\s*name:\s*ANYSENTRY_BEHAVIOR_DISCOVERY,\s*value:\s*"off"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*FORWARD_FILTER_MODE,\s*value:\s*"enforce"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*ANYSENTRY_UNKNOWN_RETENTION_MODE,\s*value:\s*"enforce"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*ANYSENTRY_CAPTURE_PROFILE_MODE,\s*value:\s*"enforce"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*FORWARD_RETAIN_UNKNOWN,\s*value:\s*"true"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*FORWARD_RETAIN_NON_AGENT,\s*value:\s*"false"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*A3S_OBSERVER_FILES,\s*value:\s*"0"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*A3S_OBSERVER_FILE_ACCESS,\s*value:\s*"0"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*A3S_OBSERVER_FILE_DELETE,\s*value:\s*"0"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*A3S_OBSERVER_SSL,\s*value:\s*"1"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*ANYSENTRY_DOCKER_DISCOVERY,\s*value:\s*"on"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*ANYSENTRY_DOCKER_SOCKET,\s*value:\s*"\/var\/run\/docker\.sock"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*FORWARD_BATCH_SIZE,\s*value:\s*"32"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*FORWARD_HTTP_TIMEOUT_MS,\s*value:\s*"30000"\s*\}/u.test(observerPatch) &&
      /name:\s*docker-sock[\s\S]*mountPath:\s*\/var\/run\/docker\.sock[\s\S]*readOnly:\s*true/u.test(observerPatch) &&
      /name:\s*docker-sock[\s\S]*hostPath:\s*\{\s*path:\s*\/var\/run\/docker\.sock,\s*type:\s*Socket\s*\}/u.test(observerPatch) &&
      /fixed FILE_EVENTS ring/u.test(observerPatchText) &&
      /security-center\/ingest\/batch/u.test(observerPatch),
    observerPatch,
  );
  assert(
    'Manual FileAccess canary explicitly layers on the stable Observer profile and split probes',
    /resources:\s*\n\s*-\s*\.\.\/k8s-observer/u.test(fileCanaryKustomization) &&
      /\{\s*name:\s*ANYSENTRY_UNKNOWN_RETENTION_MODE,\s*value:\s*"enforce"\s*\}/u.test(observerPatch) &&
      /\{\s*name:\s*ANYSENTRY_CAPTURE_PROFILE_MODE,\s*value:\s*"enforce"\s*\}/u.test(observerPatch) &&
      /A3S_OBSERVER_FILES,\s*value:\s*"0"/u.test(fileCanaryPatch) &&
      /A3S_OBSERVER_FILE_ACCESS,\s*value:\s*"1"/u.test(fileCanaryPatch) &&
      /A3S_OBSERVER_FILE_DELETE,\s*value:\s*"0"/u.test(fileCanaryPatch) &&
      /A3S_OBSERVER_FILE_UNKNOWN_POLICY,\s*value:\s*"keep"/u.test(fileCanaryPatch) &&
      /FORWARD_FILTER_MODE,\s*value:\s*"enforce"/u.test(fileCanaryPatch) &&
      /FORWARD_RETAIN_UNKNOWN,\s*value:\s*"true"/u.test(fileCanaryPatch) &&
      /FORWARD_FILE_AGGREGATION,\s*value:\s*"true"/u.test(fileCanaryPatch) &&
      /FORWARD_BATCH_SIZE,\s*value:\s*"64"/u.test(fileCanaryPatch) &&
      /FORWARD_BATCH_FLUSH_MS,\s*value:\s*"50"/u.test(fileCanaryPatch),
    `${fileCanaryKustomization}\n${fileCanaryPatch}`,
  );
  assert(
    'Manual full-file Observer profile is a separate final gate with both rings, all rollout planes, and one exact host OpenSSL inode',
    /resources:\s*\n\s*-\s*\.\.\/k8s-observer/u.test(fullFileKustomization) &&
      /path:\s*full-file-probe-patch\.yaml/u.test(fullFileKustomization) &&
      /manual-observer-profile:\s*"agent-prefilter-files-full-v1"/u.test(fullFilePatch) &&
      /A3S_OBSERVER_FILES,\s*value:\s*"0"/u.test(fullFilePatch) &&
      /A3S_OBSERVER_FILE_ACCESS,\s*value:\s*"1"/u.test(fullFilePatch) &&
      /A3S_OBSERVER_FILE_DELETE,\s*value:\s*"1"/u.test(fullFilePatch) &&
      /A3S_OBSERVER_FILE_UNKNOWN_POLICY,\s*value:\s*"keep"/u.test(fullFilePatch) &&
      /FORWARD_FILTER_MODE,\s*value:\s*"enforce"/u.test(fullFilePatch) &&
      /ANYSENTRY_UNKNOWN_RETENTION_MODE,\s*value:\s*"enforce"/u.test(fullFilePatch) &&
      /ANYSENTRY_CAPTURE_PROFILE_MODE,\s*value:\s*"enforce"/u.test(fullFilePatch) &&
      /FORWARD_RETAIN_UNKNOWN,\s*value:\s*"true"/u.test(fullFilePatch) &&
      /FORWARD_RETAIN_NON_AGENT,\s*value:\s*"false"/u.test(fullFilePatch) &&
      /FORWARD_FILE_AGGREGATION,\s*value:\s*"true"/u.test(fullFilePatch) &&
      /FORWARD_BATCH_SIZE,\s*value:\s*"64"/u.test(fullFilePatch) &&
      /FORWARD_BATCH_FLUSH_MS,\s*value:\s*"50"/u.test(fullFilePatch) &&
      /A3S_OBSERVER_HOST_LIBSSL,\s*value:\s*"\/usr\/lib\/x86_64-linux-gnu\/libssl\.so\.3"/u.test(fullFilePatch) &&
      /A3S_OBSERVER_SSL,\s*value:\s*"\/opt\/host-libs\/libssl\.so\.3"/u.test(fullFilePatch) &&
      /name:\s*host-libssl[\s\S]*mountPath:\s*\/opt\/host-libs\/libssl\.so\.3[\s\S]*readOnly:\s*true/u.test(fullFilePatch) &&
      /name:\s*host-libssl[\s\S]*hostPath:\s*\{\s*path:\s*\/usr\/lib\/x86_64-linux-gnu\/libssl\.so\.3,\s*type:\s*File\s*\}/u.test(fullFilePatch),
    `${fullFileKustomization}\n${fullFilePatch}`,
  );
  assert(
    'Manual guide stages stable Observer before Access-only, Delete-only, and final full-file capacity gates',
    /k8s-observer-file-canary[\s\S]*FileDelete-only[\s\S]*k8s-observer-files-full/u.test(manualGuide) &&
      /at least two heartbeat\/TTL windows/u.test(manualGuide) &&
      /do not\s+compensate by increasing Ring capacity/u.test(manualGuide),
    manualGuide,
  );
  const runtimeIds = new Set(runtimeDocument?.runtimes?.map((runtime) => runtime.id));
  assert(
    'Manual Kubernetes Observer overlay replaces the complete versioned signature document while inheriting templates',
    runtimeDocument?.schemaVersion === 'anysentry.agent_runtime_signatures.v1' &&
      Number.isInteger(runtimeDocument?.version) &&
      runtimeDocument.version > 1 &&
      ['codex', 'pi', 'a3s-code', 'claude-code', 'gemini-cli', 'kimi-cli'].every((id) => runtimeIds.has(id)) &&
      runtimeDocument.runtimes.every((runtime) => Array.isArray(runtime.variants) && runtime.variants.length > 0) &&
      runtimeDocument.runtimes.find((runtime) => runtime.id === 'a3s-code')?.agentScopeId === 'a3s code' &&
      runtimeDocument.runtimes.find((runtime) => runtime.id === 'claude-code')?.agentScopeId === 'Claude Code' &&
      !/^  agent-templates\.json:/mu.test(rulesPatch) &&
      /resources:\s*\n\s*-\s*\.\.\/\.\.\/observer\.yaml/u.test(kustomization),
    { runtimeDocument, kustomization },
  );
}

function verifyManualKubernetesLocalPathOverlay() {
  const kustomization = stripYamlComments(readText('deploy/manual-test/k8s-local-path/kustomization.yaml'));
  const checkpointPatch = stripYamlComments(readText('deploy/manual-test/k8s-local-path/flink-checkpoints-rwo.yaml'));
  const nodePortPatch = stripYamlComments(readText('deploy/manual-test/k8s-local-path/anysentry-nodeport-patch.yaml'));
  const fullLoadCapacityPatch = stripYamlComments(readText('deploy/manual-test/k8s-local-path/full-load-capacity-patch.yaml'));
  const supportText = readText('deploy/manual-test/k8s-local-path/manual-support.yaml');
  const contextProbeText = readText('deploy/manual-test/k8s-local-path/service-context-probe.yaml');
  const contextProbeDocs = documentsFromYaml(contextProbeText);
  const contextProbe = docFor(contextProbeDocs, 'Deployment', 'system-context-probe');
  const contextProbeScript = readText('scripts/service-context-probe.mjs');
  const contextProbeDockerfile = stripDockerComments(readText('deploy/manual-test/context-probe.Dockerfile'));
  const supportDocs = documentsFromYaml(supportText);
  const postgresPvc = docFor(supportDocs, 'PersistentVolumeClaim', 'postgres-data');
  const postgresService = docFor(supportDocs, 'Service', 'postgres');
  const postgresStatefulSet = docFor(supportDocs, 'StatefulSet', 'postgres');
  const scannerConfig = docFor(supportDocs, 'ConfigMap', 'anysentry-workspace-scanner');
  const scannerDeployment = docFor(supportDocs, 'Deployment', 'workspace-scanner');
  const manualGuide = readText('deploy/manual-test/README.md');

  assert(
    'Manual Kubernetes local-path overlay composes canonical core, streaming, and single-node support with the complete runtime-on patch',
    /resources:\s*\n\s*-\s*\.\.\/\.\.\/anysentry\.yaml\s*\n\s*-\s*\.\.\/\.\.\/streaming\.yaml/u.test(kustomization) &&
      /-\s*manual-support\.yaml/u.test(kustomization) &&
      /path:\s*\.\.\/runtime-on\.yaml/u.test(kustomization) &&
      /path:\s*flink-checkpoints-rwo\.yaml/u.test(kustomization) &&
      /path:\s*anysentry-nodeport-patch\.yaml/u.test(kustomization) &&
      /path:\s*full-load-capacity-patch\.yaml/u.test(kustomization),
    kustomization,
  );
  assert(
    'Manual full-load profile reserves ClickHouse cgroup headroom without raising per-query memory',
    /kind:\s*Deployment/u.test(fullLoadCapacityPatch) &&
      /name:\s*clickhouse/u.test(fullLoadCapacityPatch) &&
      /requests:\s*\{\s*cpu:\s*500m,\s*memory:\s*2Gi\s*\}/u.test(fullLoadCapacityPatch) &&
      /limits:\s*\{\s*cpu:\s*"3",\s*memory:\s*6Gi\s*\}/u.test(fullLoadCapacityPatch),
    fullLoadCapacityPatch,
  );
  assert(
    'Manual Kubernetes local-path overlay pins AnySentry, Flink, Workspace Scanner, and Context probe by immutable local digests',
    /newName:\s*127\.0\.0\.1:5000\/anysentry\s*\n\s*digest:\s*sha256:[0-9a-f]{64}/u.test(kustomization) &&
      /newName:\s*127\.0\.0\.1:5000\/anysentry-flink-streaming\s*\n\s*digest:\s*sha256:[0-9a-f]{64}/u.test(kustomization) &&
      /newName:\s*127\.0\.0\.1:5000\/anysentry-workspace-scanner\s*\n\s*digest:\s*sha256:[0-9a-f]{64}/u.test(kustomization) &&
      /newName:\s*127\.0\.0\.1:5000\/anysentry-context-probe\s*\n\s*digest:\s*sha256:[0-9a-f]{64}/u.test(kustomization) &&
      /-\s*service-context-probe\.yaml/u.test(kustomization) &&
      !/:latest\b/u.test(kustomization),
    kustomization,
  );
  assert(
    'Manual Kubernetes local-path overlay changes only Flink checkpoints to explicit local-path RWO storage',
    /^kind:\s*PersistentVolumeClaim$/mu.test(checkpointPatch) &&
      /^  name:\s*flink-checkpoints$/mu.test(checkpointPatch) &&
      /storageClassName:\s*local-path/u.test(checkpointPatch) &&
      /accessModes:\s*\["ReadWriteOnce"\]/u.test(checkpointPatch) &&
      /storage:\s*20Gi/u.test(checkpointPatch) &&
      /manual-storage-profile:\s*"single-node-local-path-rwo-v1"/u.test(checkpointPatch),
    checkpointPatch,
  );
  assert(
    'Manual Kubernetes support plane runs durable Postgres 17 from externally supplied database credentials',
    Boolean(postgresPvc && postgresService && postgresStatefulSet) &&
      /storageClassName:\s*local-path/u.test(postgresPvc?.source ?? '') &&
      /accessModes:\s*\["ReadWriteOnce"\]/u.test(postgresPvc?.source ?? '') &&
      /storage:\s*5Gi/u.test(postgresPvc?.source ?? '') &&
      /clusterIP:\s*None/u.test(postgresService?.source ?? '') &&
      /port:\s*5432/u.test(postgresService?.source ?? '') &&
      /image:\s*postgres:17-alpine/u.test(postgresStatefulSet?.source ?? '') &&
      ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'].every((key) =>
        new RegExp(`name:\\s*${key}[\\s\\S]*?name:\\s*anysentry-database[\\s\\S]*?key:\\s*${key}`, 'u')
          .test(postgresStatefulSet?.source ?? '')) &&
      /terminationGracePeriodSeconds:\s*30/u.test(postgresStatefulSet?.source ?? '') &&
      countMatches(postgresStatefulSet?.source ?? '', /pg_isready/gu) === 3 &&
      !supportDocs.some((doc) => doc.kind === 'Secret'),
    { postgresPvc: postgresPvc?.source, postgresService: postgresService?.source, postgresStatefulSet: postgresStatefulSet?.source },
  );
  assert(
    'Manual Kubernetes Workspace Scanner is digest-replaceable, unprivileged, token-authenticated, and read-only over one explicit host checkout',
    Boolean(scannerConfig && scannerDeployment) &&
      /"scannerId":\s*"manual-local-scanner"/u.test(scannerConfig?.source ?? '') &&
      /"workspaceId":\s*"manual-anysentry-workspace"/u.test(scannerConfig?.source ?? '') &&
      /"localPath":\s*"\/workspace\/AnySentry"/u.test(scannerConfig?.source ?? '') &&
      /image:\s*ghcr\.io\/a3s-lab\/anysentry-workspace-scanner:latest/u.test(scannerDeployment?.source ?? '') &&
      /runAsNonRoot:\s*true/u.test(scannerDeployment?.source ?? '') &&
      /runAsUser:\s*1000/u.test(scannerDeployment?.source ?? '') &&
      /allowPrivilegeEscalation:\s*false/u.test(scannerDeployment?.source ?? '') &&
      /readOnlyRootFilesystem:\s*true/u.test(scannerDeployment?.source ?? '') &&
      /drop:\s*\["ALL"\]/u.test(scannerDeployment?.source ?? '') &&
      /name:\s*ANYSENTRY_WORKSPACE_SCANNER_TOKEN[\s\S]*name:\s*anysentry-supply-chain[\s\S]*key:\s*ANYSENTRY_WORKSPACE_SCANNER_TOKEN/u.test(scannerDeployment?.source ?? '') &&
      /mountPath:\s*\/workspace\/AnySentry[\s\S]*readOnly:\s*true/u.test(scannerDeployment?.source ?? '') &&
      /hostPath:\s*\{\s*path:\s*\/srv\/anysentry\/AnySentry,\s*type:\s*Directory\s*\}/u.test(scannerDeployment?.source ?? ''),
    { scannerConfig: scannerConfig?.source, scannerDeployment: scannerDeployment?.source },
  );
  assert(
    'Manual Kubernetes Context probe continuously publishes authenticated real service measurements without cluster credentials',
    Boolean(contextProbe) &&
      /image:\s*127\.0\.0\.1:5000\/anysentry-context-probe:local/u.test(contextProbe?.source ?? '') &&
      /automountServiceAccountToken:\s*false/u.test(contextProbe?.source ?? '') &&
      /runAsNonRoot:\s*true/u.test(contextProbe?.source ?? '') &&
      /readOnlyRootFilesystem:\s*true/u.test(contextProbe?.source ?? '') &&
      /allowPrivilegeEscalation:\s*false/u.test(contextProbe?.source ?? '') &&
      /name:\s*ANYSENTRY_CONTEXT_SOURCE_ID[\s\S]*?name:\s*anysentry-system-context-source[\s\S]*?key:\s*source-id/u.test(contextProbe?.source ?? '') &&
      /name:\s*ANYSENTRY_CONTEXT_TOKEN[\s\S]*?name:\s*anysentry-system-context-source[\s\S]*?key:\s*source-token/u.test(contextProbe?.source ?? '') &&
      /ENTRYPOINT \["node", "\/opt\/anysentry\/service-context-probe\.mjs"\]/u.test(contextProbeDockerfile) &&
      ['anysentry.http.request', 'clickhouse.query', 'redis.command', 'postgres.query'].every((name) =>
        contextProbeScript.includes(name)) &&
      /acceptedEvents !== 12/u.test(contextProbeScript) &&
      !contextProbeDocs.some((doc) => doc.kind === 'Secret'),
    { contextProbe: contextProbe?.source, contextProbeDockerfile },
  );
  assert(
    'Manual Kubernetes AnySentry Service remains on stable NodePort 32653 after full overlay apply',
    /^kind:\s*Service$/mu.test(nodePortPatch) &&
      /^  name:\s*anysentry$/mu.test(nodePortPatch) &&
      /type:\s*NodePort/u.test(nodePortPatch) &&
      /port:\s*29653/u.test(nodePortPatch) &&
      /targetPort:\s*29653/u.test(nodePortPatch) &&
      /nodePort:\s*32653/u.test(nodePortPatch) &&
      manualGuide.includes('http://${NODE_IP}:32653/'),
    { nodePortPatch, manualGuide },
  );
  assert(
    'Manual Kubernetes guide creates support Secrets out of band and waits for Postgres and Scanner before final API health',
    /create secret generic anysentry-database/u.test(manualGuide) &&
      /ANYSENTRY_DATABASE_URL/u.test(manualGuide) &&
      /create secret generic anysentry-supply-chain/u.test(manualGuide) &&
      /ANYSENTRY_WORKSPACE_SCANNER_TOKEN/u.test(manualGuide) &&
      /create secret generic anysentry-system-context-source/u.test(manualGuide) &&
      /source-token/u.test(manualGuide) &&
      /rollout status statefulset\/postgres/u.test(manualGuide) &&
      /rollout status deployment\/workspace-scanner/u.test(manualGuide) &&
      /rollout status deployment\/system-context-probe/u.test(manualGuide) &&
      /rollout restart deployment\/anysentry/u.test(manualGuide),
    manualGuide,
  );
}

function verifyManualKubernetesCoreOverlay() {
  const kustomization = stripYamlComments(readText('deploy/manual-test/k8s-core/kustomization.yaml'));
  assert(
    'Manual Kubernetes core overlay stages canonical core with full runtime flags and one immutable image',
    /resources:\s*\n\s*-\s*\.\.\/\.\.\/anysentry\.yaml/u.test(kustomization) &&
      /path:\s*\.\.\/runtime-on\.yaml/u.test(kustomization) &&
      /newName:\s*127\.0\.0\.1:5000\/anysentry\s*\n\s*digest:\s*sha256:[0-9a-f]{64}/u.test(kustomization) &&
      !/streaming\.yaml/u.test(kustomization) &&
      !/:latest\b/u.test(kustomization),
    kustomization,
  );
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
  const observerScripts = [
    'observer-supervisor.js',
    'observer-forward.js',
    'observer-agent-attribution.js',
    'observer-attribution-merge.js',
    'observer-agent-runtime-signatures.js',
    'observer-event-dedup.js',
    'observer-workload-filter.js',
    'observer-infrastructure-roots.js',
    'observer-infrastructure-rules.js',
    'observer-infrastructure-policy.js',
    'observer-capture-profile-control.js',
    'observer-capture-profile-reporter.js',
    'observer-filter-rules.js',
    'observer-filter-rule-publisher.js',
    'observer-unified-filter-policy.js',
    'observer-file-aggregation.js',
    'observer-e2e-witness.js',
    'observer-priority-queue.js',
    'observer-agent-templates.js',
    'observer-docker-discovery.js',
    'observer-behavior-discovery.js',
  ];
  assert(
    'Observer forwarder image batches the complete Observer script closure into one rebuild layer',
    /^COPY scripts\/observer-\*\.js \/opt\/$/mu.test(dockerfile) &&
      observerScripts.every((filename) => fs.existsSync(path.join(repoRoot, 'scripts', filename))),
    { dockerfile, observerScripts },
  );
  assert(
    'Observer forwarder image defaults to the supervisor as PID1',
    /^ENTRYPOINT \["\/usr\/local\/bin\/node", "\/opt\/observer-supervisor\.js"\]$/mu.test(dockerfile),
    dockerfile,
  );
  assert('Observer forwarder image has no npm or pnpm install step', !/\b(?:npm|pnpm|yarn)\s+(?:install|ci|add)\b/iu.test(dockerfile), dockerfile);
}

function verifyObserverLabWiring() {
  const dockerfile = stripDockerComments(readText('examples/agent-runtime-lab/Dockerfile.observer'));
  const compose = stripYamlComments(readText('examples/agent-runtime-lab/compose.yaml'));

  assert(
    'Agent runtime lab Observer image bundles the same PID1 supervisor',
    /^COPY scripts\/observer-\*\.js \/opt\/$/mu.test(dockerfile) &&
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
  assert(
    'Agent runtime lab Observer publishes exact self inventory and overlays the complete S3 dependency closure',
    /docker-observer:[\s\S]*?labels:[\s\S]*?io\.anysentry\.observe:\s*"false"[\s\S]*?anysentry\.io\/workload-role:\s*anysentry_internal/u.test(compose) &&
      [
        'observer-classification-semantics.js',
        'observer-infrastructure-policy.js',
        'observer-infrastructure-rules.js',
        'observer-pipeline-accounting.js',
      ].every((filename) => compose.includes(`../../scripts/${filename}:/opt/${filename}:ro`)),
    compose,
  );
}

function verifyModuleDevelopmentDeployment() {
  const dockerfile = stripDockerComments(readText('Dockerfile.modules'));
  const compose = stripYamlComments(readText('deploy/docker-compose.modules.yml'));
  const nginx = readText('deploy/modules/nginx.conf');
  const flinkReplace = readText('deploy/modules/flink-job-replace.sh');
  const guide = readText('deploy/modules/README.md');
  const fileCanary = stripYamlComments(readText('deploy/modules/observer-file-canary.yml'));
  const nodeDistDev = stripYamlComments(readText('deploy/modules/node-dist-dev.yml'));
  const kubeIdentityDev = stripYamlComments(readText('deploy/modules/kube-identity-dev.yml'));
  const allFeatures = stripYamlComments(readText('deploy/modules/all-features.yml'));
  const scannerConfig = JSON.parse(readText('deploy/modules/workspace-scanner.docker.json'));
  const scannerScript = readText('scripts/workspace-scanner.mjs');

  assert(
    'Module Dockerfile shares one lockfile-keyed Node dependency layer across API, Worker, and Web targets',
    /^FROM \$\{NODE_BUILD_IMAGE\} AS node-dependencies$/mu.test(dockerfile) &&
      countMatches(dockerfile, /pnpm install --frozen-lockfile/gu) === 1 &&
      /^FROM node-runtime AS api$/mu.test(dockerfile) &&
      /^FROM node-runtime AS worker$/mu.test(dockerfile) &&
      /^FROM \$\{NGINX_IMAGE\} AS web$/mu.test(dockerfile),
    dockerfile,
  );
  assert(
    'Module API source rebuilds compile dist without rerunning the manifest-only production dependency deployment',
    /^FROM node-dependencies AS api-production-dependencies$/mu.test(dockerfile) &&
      /^RUN pnpm --filter @anysentry\/api --prod deploy \/out \\/mu.test(dockerfile) &&
      /^COPY --from=api-production-dependencies \/out\/node_modules \.\/node_modules$/mu.test(dockerfile) &&
      /^COPY --from=api-production-dependencies \/out\/anysentry-production-components\.json \.\/anysentry-production-components\.json$/mu.test(dockerfile) &&
      /^COPY --from=api-build \/src\/apps\/api\/dist \.\/dist$/mu.test(dockerfile) &&
      /^CMD \["node", "dist\/main\.js"\]$/mu.test(dockerfile) &&
      /^CMD \["node", "dist\/security-monitoring\/worker-main\.js"\]$/mu.test(dockerfile) &&
      /^COPY --from=web-build \/src\/apps\/web\/dist \/usr\/share\/nginx\/html$/mu.test(dockerfile),
    dockerfile,
  );
  assert(
    'Module Compose assigns independent API, Worker, and Web image variables and build targets',
    /ANYSENTRY_API_IMAGE:-anysentry-api:modules/u.test(compose) &&
      /ANYSENTRY_WORKER_IMAGE:-anysentry-worker:modules/u.test(compose) &&
      /ANYSENTRY_WEB_IMAGE:-anysentry-web:modules/u.test(compose) &&
      countMatches(compose, /^\s+target:\s*(?:api|worker|web)\s*$/gmu) >= 3,
    compose,
  );
  assert(
    'Module Compose leaves stable ClickHouse, Redis, Postgres, and Kafka services to the canonical file',
    !/^  (?:clickhouse|redis|postgres|kafka):\s*$/mu.test(compose),
    compose,
  );
  assert(
    'Module-only Web, Observer, and Workspace Scanner retain exact AnySentry self-inventory labels',
    countMatches(compose, /anysentry\.io\/workload-role:\s*"anysentry_internal"/gu) === 2 &&
      countMatches(allFeatures, /anysentry\.io\/workload-role:\s*"anysentry_internal"/gu) === 1 &&
      countMatches(compose, /io\.anysentry\.observe:\s*"false"/gu) === 2 &&
      countMatches(allFeatures, /io\.anysentry\.observe:\s*"false"/gu) === 1,
    { compose, allFeatures },
  );
  assert(
    'Module Web proxy preserves same-origin API seams and SPA fallback',
    /\(security-center\|open\|api\)/u.test(nginx) &&
      /resolver 127\.0\.0\.11 valid=10s ipv6=off;/u.test(nginx) &&
      /set \$anysentry_api http:\/\/anysentry:29653;/u.test(nginx) &&
      /proxy_pass \$anysentry_api;/u.test(nginx) &&
      /try_files \$uri \$uri\/ \/index\.html;/u.test(nginx),
    nginx,
  );
  assert(
    'Module Observer is a thin stable-Collector wrapper with read-only script overlays and whole-service restart semantics',
    /^ARG OBSERVER_COLLECTOR_IMAGE=ghcr\.io\/a3s-lab\/observer:latest$/mu.test(dockerfile) &&
      /^FROM \$\{OBSERVER_COLLECTOR_IMAGE\} AS observer-wrapper$/mu.test(dockerfile) &&
      /\.\/scripts:\/opt\/anysentry-forwarder-dev:ro/u.test(compose) &&
      /up -d --no-deps observer/u.test(guide) &&
      /not.*lossless Forwarder-only restart/isu.test(guide) &&
      /durable relay\/spool and ACK protocol/u.test(guide),
    { dockerfile, compose, guide },
  );
  assert(
    'Module Observer shares the Capture Profile snapshot/ACK path and central materialization endpoint',
    /ANYSENTRY_CAPTURE_PROFILE_MODE:\s*\$\{ANYSENTRY_CAPTURE_PROFILE_MODE:-legacy\}/u.test(compose) &&
      /ANYSENTRY_UNKNOWN_RETENTION_MODE:\s*\$\{ANYSENTRY_UNKNOWN_RETENTION_MODE:-legacy\}/u.test(compose) &&
      /ANYSENTRY_FILTER_RULES_ACK_FILE:\s*\/run\/anysentry-filter\/filter-rules\.ack\.json/u.test(compose) &&
      /ANYSENTRY_INFRASTRUCTURE_MATERIALIZATION_URL:[^\n]*infrastructure-rules\/materializations\/report/u.test(compose) &&
      /ANYSENTRY_CAPTURE_PROFILE_ACK_POLL_MS:\s*\$\{ANYSENTRY_CAPTURE_PROFILE_ACK_POLL_MS:-250\}/u.test(compose) &&
      /ANYSENTRY_OBSERVER_AUTH_ENV_FILE:-\.local\/observer-auth\.env/u.test(compose),
    compose,
  );
  assert(
    'Module FileAccess canary is explicit, lossless-Unknown, authoritative-enforce, and independent from FileDelete',
    /A3S_OBSERVER_FILE_ACCESS:\s*"1"/u.test(fileCanary) &&
      /A3S_OBSERVER_FILE_DELETE:\s*"0"/u.test(fileCanary) &&
      /A3S_OBSERVER_FILE_UNKNOWN_POLICY:\s*"keep"/u.test(fileCanary) &&
      !/A3S_OBSERVER_FILE_UNKNOWN_PER_(?:NODE|CGROUP)/u.test(fileCanary) &&
      /FORWARD_FILTER_MODE:\s*"enforce"/u.test(fileCanary) &&
      /FORWARD_BATCH_SIZE:\s*"64"/u.test(fileCanary) &&
      /FORWARD_BATCH_FLUSH_MS:\s*"50"/u.test(fileCanary),
    fileCanary,
  );
  assert(
    'Module Node dist overlay mounts compiled output read-only into API and Worker roles',
    /\.\/apps\/api\/dist:\/app\/dist:ro/u.test(nodeDistDev) &&
      /^  anysentry:\s*$/mu.test(nodeDistDev) &&
      /^  stream-worker:\s*$/mu.test(nodeDistDev) &&
      /node-dist-dev\.yml/u.test(guide),
    { nodeDistDev, guide },
  );
  assert(
    'Module all-features overlay enables every non-legacy API subsystem',
    [
      'ANYSENTRY_ASYNC_JUDGE',
      'ANYSENTRY_STREAMING',
      'ANYSENTRY_STREAM_AGENT_ONLY',
      'ANYSENTRY_SUPPLY_CHAIN',
      'ANYSENTRY_SUPPLY_CHAIN_RUNTIME',
      'ANYSENTRY_ASSISTANT',
    ].every((name) => new RegExp(`^\\s+${name}:\\s*"on"\\s*$`, 'mu').test(allFeatures)) &&
      /ANYSENTRY_TRUSTED_CORRELATION_MODE:\s*"enabled"/u.test(allFeatures) &&
      /ANYSENTRY_UNKNOWN_RETENTION_MODE:\s*"enforce"/u.test(allFeatures) &&
      /ANYSENTRY_UNKNOWN_LEARNING_ENABLED:\s*"true"/u.test(allFeatures) &&
      !/ANYSENTRY_(?:FLINK_)?LEGACY_COMPOSITE_ENABLED:\s*"on"/u.test(allFeatures),
    allFeatures,
  );
  assert(
    'Module all-features Supply Chain worker waits for Kafka topic initialization before runtime publishing',
    /^  supply-chain-assessment:\s*$/mu.test(allFeatures) &&
      /supply-chain-assessment:[\s\S]*?depends_on:[\s\S]*?kafka-init:[\s\S]*?condition:\s*service_completed_successfully/u.test(allFeatures) &&
      /supply-chain-assessment:[\s\S]*?ANYSENTRY_SUPPLY_CHAIN_RUNTIME:\s*"on"/u.test(allFeatures) &&
      /supply-chain-assessment:[\s\S]*?ANYSENTRY_OSV_INTELLIGENCE_MODE:\s*"online"/u.test(allFeatures),
    allFeatures,
  );
  assert(
    'Module Workspace Scanner is an unprivileged isolated target with pinned OSV-Scanner and shared API authentication',
    /^ARG OSV_SCANNER_IMAGE=ghcr\.io\/google\/osv-scanner:v2\.3\.8$/mu.test(dockerfile) &&
      /^FROM \$\{NODE_BUILD_IMAGE\} AS workspace-scanner$/mu.test(dockerfile) &&
      /^COPY --from=osv-scanner-bin \/osv-scanner \/usr\/local\/bin\/osv-scanner$/mu.test(dockerfile) &&
      /^COPY scripts\/workspace-scanner\.mjs \/opt\/anysentry\/workspace-scanner\.mjs$/mu.test(dockerfile) &&
      /^USER node$/mu.test(dockerfile) &&
      /^ENTRYPOINT \["node", "\/opt\/anysentry\/workspace-scanner\.mjs"\]$/mu.test(dockerfile) &&
      /ANYSENTRY_WORKSPACE_SCANNER_IMAGE:-anysentry-workspace-scanner:modules/u.test(allFeatures) &&
      /target:\s*workspace-scanner/u.test(allFeatures) &&
      /workspace-scanner:[\s\S]*?anysentry:[\s\S]*?condition:\s*service_healthy/u.test(allFeatures) &&
      countMatches(
        allFeatures,
        /ANYSENTRY_WORKSPACE_SCANNER_TOKEN:\s*\$\{ANYSENTRY_WORKSPACE_SCANNER_TOKEN:\?set a 32\+ character Workspace Scanner token\}/gu,
      ) === 2 &&
      /(?:^|\s)(?:\.|\.\/):\/workspace\/AnySentry:ro/u.test(allFeatures) &&
      /workspace-scanner\.docker\.json:\/etc\/anysentry\/workspace-scanner\.json:ro/u.test(allFeatures) &&
      /Workspace Scanner must run as an unprivileged user/u.test(scannerScript) &&
      /Workspace Scanner token must contain at least 32 characters/u.test(scannerScript) &&
      scannerConfig.scannerId === 'docker-anysentry-workspace-scanner' &&
      scannerConfig.allowedRoots?.includes('/workspace') &&
      scannerConfig.workspaces?.some((workspace) => workspace.localPath === '/workspace/AnySentry'),
    { dockerfile, allFeatures, scannerConfig },
  );
  assert(
    'Module all-features Observer uses an immutable in-image script set and enables independent Access/Delete plus host OpenSSL probes',
    /^  observer:\s*$/mu.test(allFeatures) &&
      /observer:[\s\S]*?build:\s*!reset\s+null/u.test(allFeatures) &&
      /entrypoint:\s*\["\/usr\/local\/bin\/node",\s*"\/opt\/observer-supervisor\.js"\]/u.test(allFeatures) &&
      /A3S_OBSERVER_FILES:\s*"0"/u.test(allFeatures) &&
      /A3S_OBSERVER_FILE_ACCESS:\s*"1"/u.test(allFeatures) &&
      /A3S_OBSERVER_FILE_DELETE:\s*"1"/u.test(allFeatures) &&
      /A3S_OBSERVER_FILE_UNKNOWN_POLICY:\s*"keep"/u.test(allFeatures) &&
      /ANYSENTRY_CAPTURE_PROFILE_MODE:\s*"enforce"/u.test(allFeatures) &&
      /ANYSENTRY_UNKNOWN_RETENTION_MODE:\s*"enforce"/u.test(allFeatures) &&
      /ANYSENTRY_FILTER_RULES_ACK_FILE:\s*\/run\/anysentry-filter\/filter-rules\.ack\.json/u.test(allFeatures) &&
      /A3S_OBSERVER_SSL:\s*\/opt\/host-libs\/libssl\.so\.3/u.test(allFeatures) &&
      /FORWARD_FILTER_MODE:\s*"enforce"/u.test(allFeatures) &&
      /FORWARD_RETAIN_UNKNOWN:\s*"true"/u.test(allFeatures) &&
      /FORWARD_RETAIN_NON_AGENT:\s*"false"/u.test(allFeatures) &&
      /FORWARD_FILE_AGGREGATION:\s*"true"/u.test(allFeatures) &&
      /FORWARD_BATCH_SIZE:\s*"64"/u.test(allFeatures) &&
      /FORWARD_BATCH_FLUSH_MS:\s*"50"/u.test(allFeatures) &&
      /volumes:\s*!override/u.test(allFeatures) &&
      /\$\{A3S_OBSERVER_HOST_LIBSSL:-\/usr\/lib\/x86_64-linux-gnu\/libssl\.so\.3\}:\/opt\/host-libs\/libssl\.so\.3:ro/u.test(allFeatures) &&
      !/anysentry-forwarder-dev/u.test(allFeatures) &&
      /^COPY scripts\/observer-\*\.js \/opt\/$/mu.test(dockerfile) &&
      fs.existsSync(path.join(repoRoot, 'scripts/observer-infrastructure-policy.js')) &&
      fs.existsSync(path.join(repoRoot, 'scripts/observer-infrastructure-rules.js')) &&
      fs.existsSync(path.join(repoRoot, 'scripts/observer-file-aggregation.js')),
    { dockerfile, allFeatures },
  );
  assert(
    'Module Kubernetes identity bridge keeps host credentials out of images and mounts kubeconfig read-only only in the opt-in overlay',
    /ANYSENTRY_KUBECONFIG:\s*\/etc\/anysentry\/kubeconfig/u.test(kubeIdentityDev) &&
      /ANYSENTRY_KUBE_SERVER:\s*\$\{ANYSENTRY_KUBE_SERVER:-https:\/\/host\.docker\.internal:6443\}/u.test(kubeIdentityDev) &&
      /host\.docker\.internal:host-gateway/u.test(kubeIdentityDev) &&
      /ANYSENTRY_KUBECONFIG_HOST_PATH:-\/etc\/rancher\/k3s\/k3s\.yaml\}:\/etc\/anysentry\/kubeconfig:ro/u.test(kubeIdentityDev) &&
      !/kubeconfig/u.test(dockerfile),
    { kubeIdentityDev, dockerfile },
  );
  assert(
    'Module Flink target isolates the business JAR from stable JobManager and TaskManager runtime images',
    /^FROM \$\{FLINK_RUNTIME_IMAGE\} AS flink-job$/mu.test(dockerfile) &&
      /ANYSENTRY_FLINK_RUNTIME_IMAGE:-flink:2\.2\.1-java17/u.test(compose) &&
      /ANYSENTRY_FLINK_JOB_IMAGE:-anysentry-flink-job:modules/u.test(compose) &&
      countMatches(compose, /^\s+build:\s*!reset\s+null\s*$/gmu) === 3 &&
      /target:\s*flink-job/u.test(compose) &&
      /flink cancel -m "\$jobmanager" "\$job_id"/u.test(flinkReplace) &&
      /ANYSENTRY_FLINK_RESTORE_PATH/u.test(flinkReplace),
    { dockerfile, compose, flinkReplace },
  );
  assert(
    'Module guide requires local tests before modular Docker E2E and final immutable Kubernetes validation',
    /Run the smallest local unit and contract tests/u.test(guide) &&
      /After all planned features pass/u.test(guide) &&
      /modular Docker end-to-end/u.test(guide) &&
      /Kubernetes\s+rollout validation only after this gate passes/u.test(guide) &&
      /only one mutating Compose command at a time/u.test(guide) &&
      /temporary service\s+DNS gap/u.test(guide) &&
      /--no-deps/u.test(guide),
    guide,
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
    'Integrated installer bootstraps managed per-node Observer Sources without repository credentials',
    /create secret generic anysentry-control-auth/u.test(installer) &&
      /openssl rand -hex 32/u.test(installer) &&
      /bootstrap-observer-sources\.mjs/u.test(installer) &&
      /create secret generic anysentry-observer-auth/u.test(installer) &&
      /--from-file=observer-sources\.json=/u.test(installer) &&
      /rollout restart deployment\/anysentry/u.test(installer) &&
      /rollout restart daemonset\/a3s-observer/u.test(installer) &&
      installer.indexOf('create secret generic anysentry-observer-auth') < installer.indexOf('deploy/observer.yaml'),
    installer,
  );
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
  verifyManualKubernetesObserverOverlay();
  verifyManualKubernetesLocalPathOverlay();
  verifyManualKubernetesCoreOverlay();
  verifyIngressManifest();
  verifyDockerfile();
  verifyObserverForwarderDockerfile();
  verifyObserverLabWiring();
  verifyModuleDevelopmentDeployment();
  verifyInstaller();

  if (process.exitCode) {
    console.error('Deployment manifest verification failed');
    process.exit(process.exitCode);
  }
  console.log('Deployment manifest verification passed');
}

main();
