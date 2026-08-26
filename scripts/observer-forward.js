#!/usr/bin/env node
// Bridge a3s-observer NDJSON (stdin) -> AnySentry batched ingest. Node stdlib only.
//   a3s-observer-collector | node observer-forward.js
// Target from ANYSENTRY_INGEST_URL (default http://localhost:29653/security-center/ingest).
//
// Backpressure is essential: a busy node emits a firehose of events. We bound the priority queue,
// batch network writes, cap in-flight POSTs, and pause stdin at pressure so memory stays flat.
//
// Retention, routine-noise filtering, and shadow evaluation are independent controls. Unknown is
// retained by default so an operator can discover missed Agents later; known non-Agents and
// infrastructure roots are not retained. Override routine noise prefixes via FORWARD_DROP_PATHS.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { AgentAttributor } = require('./observer-agent-attribution');
const { AgentTemplateRegistry, loadTemplateDocument } = require('./observer-agent-templates');
const { DockerDiscovery } = require('./observer-docker-discovery');
const { BehavioralAgentDetector } = require('./observer-behavior-discovery');
const { DurableSpool, safeId, stableWriterId } = require('./observer-durable-spool');
const { ToolExecDeduper } = require('./observer-event-dedup');
const {
  behaviorDiscoveryEligible,
  WorkloadIdentityCache,
} = require('./observer-workload-filter');
const { InfrastructureRootResolver } = require('./observer-infrastructure-roots');

const target = new URL(process.env.ANYSENTRY_INGEST_URL || 'http://localhost:29653/security-center/ingest');
function defaultHeartbeatUrl(ingestUrl) {
  const url = new URL(ingestUrl.toString());
  const nextPath = url.pathname.replace(/\/ingest(?:\/.*)?$/, '/collectors/heartbeat');
  url.pathname = nextPath === url.pathname ? '/security-center/collectors/heartbeat' : nextPath;
  url.hash = '';
  return url;
}

function defaultIdentitySnapshotUrl(ingestUrl) {
  const url = new URL(ingestUrl.toString());
  const nextPath = url.pathname.replace(/\/ingest(?:\/.*)?$/, '/identity/snapshot');
  url.pathname = nextPath === url.pathname ? '/security-center/identity/snapshot' : nextPath;
  url.hash = '';
  return url;
}

function defaultBatchIngestUrl(ingestUrl) {
  const url = new URL(ingestUrl.toString());
  const nextPath = url.pathname.replace(/\/ingest(?:\/.*)?$/, '/ingest/batch');
  url.pathname = nextPath === url.pathname ? '/security-center/ingest/batch' : nextPath;
  url.hash = '';
  return url;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

const MAX_INFLIGHT = boundedNumber(process.env.FORWARD_MAX_INFLIGHT, 8, 1, 64);
const BATCH_SIZE = boundedNumber(process.env.FORWARD_BATCH_SIZE, 32, 1, 256);
const BATCH_FLUSH_MS = boundedNumber(process.env.FORWARD_BATCH_FLUSH_MS, 50, 1, 5_000);
const BATCH_MAX_BYTES = boundedNumber(
  process.env.FORWARD_BATCH_MAX_BYTES,
  80 * 1024,
  16 * 1024,
  1024 * 1024,
);
const HTTP_TIMEOUT_MS = boundedNumber(process.env.FORWARD_HTTP_TIMEOUT_MS, 10_000, 1_000, 120_000);
const RETRY_BASE_MS = boundedNumber(process.env.FORWARD_RETRY_BASE_MS, 250, 50, 30_000);
const RETRY_MAX_MS = boundedNumber(process.env.FORWARD_RETRY_MAX_MS, 30_000, RETRY_BASE_MS, 300_000);
function envBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const LEGACY_FORWARD_SCOPE = ['agent', 'all', 'shadow'].includes(process.env.FORWARD_SCOPE)
  ? process.env.FORWARD_SCOPE
  : undefined;
const FILTER_MODE = ['enforce', 'shadow'].includes(process.env.FORWARD_FILTER_MODE)
  ? process.env.FORWARD_FILTER_MODE
  : LEGACY_FORWARD_SCOPE === 'shadow' ? 'shadow' : 'enforce';
const RETAIN_UNKNOWN = envBoolean(process.env.FORWARD_RETAIN_UNKNOWN, true);
const RETAIN_NON_AGENT = envBoolean(process.env.FORWARD_RETAIN_NON_AGENT, false);
const NOISE_POLICY = ['balanced', 'include'].includes(process.env.FORWARD_NOISE_POLICY)
  ? process.env.FORWARD_NOISE_POLICY
  : 'balanced';
const DROP_PATHS = (process.env.FORWARD_DROP_PATHS || '/sys/,/proc/,/run/,/dev/').split(',').map((s) => s.trim()).filter(Boolean);
const COLLECTOR_ID = process.env.A3S_OBSERVER_COLLECTOR_ID || process.env.COLLECTOR_ID || process.env.HOSTNAME || '';
const NODE_NAME = process.env.A3S_NODE_NAME || process.env.NODE_NAME || '';
const SOURCE_ID = process.env.ANYSENTRY_SOURCE_ID || '';
const SOURCE_NAME = process.env.ANYSENTRY_SOURCE_NAME || '';
const SOURCE_TYPE = process.env.ANYSENTRY_SOURCE_TYPE || 'observer';
const SOURCE_TOKEN = process.env.ANYSENTRY_INGEST_TOKEN || '';
const WORKSPACE_PATH = process.env.ANYSENTRY_WORKSPACE_PATH || '';
const WRITER_VERSION = process.env.ANYSENTRY_WRITER_VERSION || 'observer-forwarder/1.0.0';
const IDEMPOTENCY_PROTOCOL_VERSION =
  process.env.ANYSENTRY_IDEMPOTENCY_PROTOCOL_VERSION || 'anysentry.idempotency.v1';
const WRITER_ID = stableWriterId([
  SOURCE_ID,
  COLLECTOR_ID,
  NODE_NAME,
  SOURCE_TYPE,
  process.env.A3S_OBSERVER_HOST_ID || '',
  os.hostname(),
]);
const SPOOL_PATH = process.env.FORWARD_SPOOL_PATH ||
  path.join(os.tmpdir(), 'anysentry-forwarder', safeId(WRITER_ID), 'spool.wal');
const spool = new DurableSpool({
  writerId: WRITER_ID,
  filePath: SPOOL_PATH,
  dlqPath: process.env.FORWARD_DLQ_PATH,
  maxRecords: process.env.FORWARD_SPOOL_MAX_RECORDS,
  maxBytes: process.env.FORWARD_SPOOL_MAX_BYTES,
  fsyncMode: process.env.FORWARD_SPOOL_FSYNC,
  fsyncMs: process.env.FORWARD_SPOOL_FSYNC_MS,
});
const HEARTBEAT_SECS = Math.max(0, Number(process.env.ANYSENTRY_HEARTBEAT_SECS || 30));
const heartbeatTarget = new URL(process.env.ANYSENTRY_HEARTBEAT_URL || defaultHeartbeatUrl(target));
const batchTarget = new URL(process.env.ANYSENTRY_BATCH_INGEST_URL || defaultBatchIngestUrl(target));
const IDENTITY_SNAPSHOT_SECS = Math.max(0, Number(process.env.ANYSENTRY_IDENTITY_SNAPSHOT_SECS || 15));
const identitySnapshotTarget = new URL(
  process.env.ANYSENTRY_IDENTITY_SNAPSHOT_URL || defaultIdentitySnapshotUrl(target),
);
if (NODE_NAME) identitySnapshotTarget.searchParams.set('nodeName', NODE_NAME);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT });
let templateDocument;
let templateLoadErrors = 0;
try {
  templateDocument = loadTemplateDocument();
} catch (error) {
  templateLoadErrors++;
  templateDocument = { templates: [], source: 'invalid' };
  console.error(`[observer-forward] agent templates ignored: ${error.message}`);
}
const templateRegistry = new AgentTemplateRegistry(templateDocument);
const attributor = new AgentAttributor();
const workloadCache = new WorkloadIdentityCache({ templateRegistry });
const dockerDiscovery = new DockerDiscovery({
  nodeName: NODE_NAME,
  hostId: process.env.A3S_OBSERVER_HOST_ID || NODE_NAME,
});
const behaviorDetector = new BehavioralAgentDetector();
const infrastructureResolver = new InfrastructureRootResolver();
const toolExecDeduper = new ToolExecDeduper({
  windowMs: process.env.FORWARD_DEDUP_WINDOW_MS,
  maxKeys: process.env.FORWARD_MAX_DEDUP_KEYS,
});

let inflight = 0;
const inflightIds = new Set();
const retryBatches = new Map();
let outputDropped = 0;
let errorCount = 0;
let eventKindCounts = Object.create(null);
let retryCount = 0;
let durableAckCount = 0;
let permanentRejectionCount = 0;
let lastNonAgentSuppressedAt = '';
let attributionCounts = {
  observed: 0,
  confirmedAgent: 0,
  probableAgent: 0,
  unknown: 0,
  nonAgent: 0,
  filteredNonAgent: 0,
  wouldFilterNonAgent: 0,
  filteredNoise: 0,
  wouldFilterNoise: 0,
  discoveryBudgetDropped: 0,
  wouldDiscoveryBudgetDrop: 0,
  forwarded: 0,
  queueDropped: 0,
  batches: 0,
  batchEvents: 0,
  workspaceConflict: 0,
  infrastructure: 0,
  deduplicated: 0,
};
let closing = false;
let heartbeatTimer;
let identitySnapshotTimer;
let batchTimer;
let rl;
const writerSessionId = crypto.randomBytes(12).toString('hex');
let writerEventSequence = 0;

function isNoise(o) {
  const fa = o.event && o.event.FileAccess;
  return !!(fa && typeof fa.path === 'string' && DROP_PATHS.some((p) => fa.path.startsWith(p)));
}

function eventKind(o) {
  if (!o || !o.event || typeof o.event !== 'object') return '';
  return Object.keys(o.event)[0] || '';
}

function bumpEventKind(o) {
  const kind = eventKind(o);
  if (!kind || kind === 'CollectorHeartbeat') return;
  eventKindCounts[kind] = (eventKindCounts[kind] || 0) + 1;
}

function sourceEventId(line, observedAt) {
  writerEventSequence += 1;
  return `ose_${crypto.createHash('sha256')
    .update(WRITER_ID)
    .update('\0')
    .update(writerSessionId)
    .update('\0')
    .update(String(observedAt))
    .update('\0')
    .update(String(writerEventSequence))
    .update('\0')
    .update(line)
    .digest('hex')
    .slice(0, 24)}`;
}

function sourceFields(inferredWorkspacePath = '') {
  const workspacePath = WORKSPACE_PATH || inferredWorkspacePath;
  return {
    ...(SOURCE_ID ? { sourceId: SOURCE_ID } : {}),
    ...(SOURCE_NAME ? { sourceName: SOURCE_NAME } : {}),
    ...(SOURCE_TYPE ? { sourceType: SOURCE_TYPE } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  };
}

function sourceHeaders() {
  return {
    ...(SOURCE_ID ? { 'X-AnySentry-Source-Id': SOURCE_ID } : {}),
    ...(SOURCE_TOKEN ? { 'X-AnySentry-Ingest-Token': SOURCE_TOKEN } : {}),
  };
}

function postJson(url, bodyObj, timeoutMs, done) {
  postJsonDetailed(url, bodyObj, timeoutMs, (result) => done(!result.ok));
}

function postJsonDetailed(url, bodyObj, timeoutMs, done) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    done({ ok: false, retryable: false, error: `unsupported protocol ${url.protocol}` });
    return;
  }
  const body = JSON.stringify(bodyObj);
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    done(result);
  };
  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...sourceHeaders(),
      },
    },
    (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (data.length < 8 * 1024 * 1024) data += chunk;
      });
      res.on('end', () => {
        const statusCode = res.statusCode || 500;
        if (statusCode >= 400) {
          finish({
            ok: false,
            retryable: statusCode === 408 || statusCode === 429 || statusCode >= 500,
            statusCode,
            error: data.slice(0, 2_000),
          });
          return;
        }
        try {
          const parsed = data ? JSON.parse(data) : {};
          finish({ ok: true, statusCode, data: parsed?.data ?? parsed });
        } catch (error) {
          finish({ ok: false, retryable: true, statusCode, error: error.message });
        }
      });
    },
  );
  req.on('error', (error) => finish({ ok: false, retryable: true, error: error.message }));
  req.setTimeout(timeoutMs, () => {
    finish({ ok: false, retryable: true, error: 'request timeout' });
    req.destroy();
  });
  req.end(body);
}

function getJson(url, timeoutMs, done) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    done(new Error(`unsupported protocol ${url.protocol}`));
    return;
  }
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    done(error, value);
  };
  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: isHttps ? httpsAgent : httpAgent,
      headers: sourceHeaders(),
    },
    (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          finish(new Error(`identity snapshot returned ${res.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          finish(undefined, parsed?.data ?? parsed);
        } catch (error) {
          finish(error);
        }
      });
    },
  );
  req.on('error', (error) => finish(error));
  req.setTimeout(timeoutMs, () => {
    finish(new Error('identity snapshot timeout'));
    req.destroy();
  });
  req.end();
}

function refreshIdentitySnapshot() {
  getJson(identitySnapshotTarget, 5000, (error, snapshot) => {
    if (error || !workloadCache.replace(snapshot)) {
      if (error) workloadCache.errors++;
    }
  });
}

function sendHeartbeat(done = () => {}) {
  if (!HEARTBEAT_SECS) {
    done(false);
    return;
  }
  const counts = eventKindCounts;
  const dropped = outputDropped;
  const errors = errorCount;
  const classifications = attributionCounts;
  const workload = workloadCache.metrics();
  const docker = dockerDiscovery.metrics();
  const behavior = behaviorDetector.metrics();
  const templates = templateRegistry.metrics();
  const processes = attributor.metrics();
  const spoolStatus = spool.status();
  const retries = retryCount;
  const durableAcks = durableAckCount;
  const permanentRejections = permanentRejectionCount;
  eventKindCounts = Object.create(null);
  attributionCounts = {
    observed: 0,
    confirmedAgent: 0,
    probableAgent: 0,
    unknown: 0,
    nonAgent: 0,
    filteredNonAgent: 0,
    wouldFilterNonAgent: 0,
    filteredNoise: 0,
    wouldFilterNoise: 0,
    discoveryBudgetDropped: 0,
    wouldDiscoveryBudgetDrop: 0,
    forwarded: 0,
    queueDropped: 0,
    batches: 0,
    batchEvents: 0,
    workspaceConflict: 0,
    infrastructure: 0,
    deduplicated: 0,
  };
  outputDropped = 0;
  errorCount = 0;
  retryCount = 0;
  durableAckCount = 0;
  permanentRejectionCount = 0;
  const status = dropped > 0 || errors > 0 ? 'degraded' : 'ok';
  postJson(
    heartbeatTarget,
    {
      collectorId: COLLECTOR_ID || undefined,
      nodeName: NODE_NAME || undefined,
      mode: `observer-forwarder:${FILTER_MODE}`,
      status,
      intervalSecs: HEARTBEAT_SECS,
      eventKindCounts: counts,
      queueDepth: spoolStatus.records,
      outputDropped: dropped,
      errorCount: errors,
      filterMetrics: {
        scope: LEGACY_FORWARD_SCOPE ?? 'decoupled',
        filterMode: FILTER_MODE,
        retainUnknown: RETAIN_UNKNOWN,
        retainNonAgent: RETAIN_NON_AGENT,
        noisePolicy: NOISE_POLICY,
        observed: classifications.observed,
        forwarded: classifications.forwarded,
        confirmedAgent: classifications.confirmedAgent,
        probableAgent: classifications.probableAgent,
        unknown: classifications.unknown,
        nonAgent: classifications.nonAgent,
        filteredNonAgent: classifications.filteredNonAgent,
        wouldFilterNonAgent: classifications.wouldFilterNonAgent,
        lastSuppressedAt: lastNonAgentSuppressedAt || undefined,
        filteredNoise: classifications.filteredNoise,
        wouldFilterNoise: classifications.wouldFilterNoise,
        discoveryBudgetDropped: classifications.discoveryBudgetDropped,
        wouldDiscoveryBudgetDrop: classifications.wouldDiscoveryBudgetDrop,
        deduplicated: classifications.deduplicated,
        queueDropped: classifications.queueDropped,
        batches: classifications.batches,
        batchEvents: classifications.batchEvents,
        writerId: WRITER_ID,
        writerVersion: WRITER_VERSION,
        idempotencyProtocolVersion: IDEMPOTENCY_PROTOCOL_VERSION,
        spoolRecords: spoolStatus.records,
        spoolBytes: spoolStatus.logicalBytes,
        spoolWalBytes: spoolStatus.walBytes,
        spoolOldestMs: spoolStatus.oldestMs,
        spoolAtCapacity: spoolStatus.atCapacity,
        retryCount: retries,
        durableAckCount: durableAcks,
        permanentRejectionCount: permanentRejections,
        identitySnapshotReady: workload.ready,
        identitySnapshotVersion: workload.version,
        identitySnapshotAgeSeconds: workload.ageSeconds,
        identityCacheEntries: workload.entries,
        identityCacheHits: workload.hits,
        identityCacheMisses: workload.misses,
        identityCandidateCacheEntries: workload.candidateCacheEntries,
        identityCgroupBindings: workload.cgroupBindings,
        identityCgroupHits: workload.cgroupHits,
        identityCgroupMisses: workload.cgroupMisses,
        identityErrors: workload.errors,
        dockerEnabled: docker.enabled,
        dockerReady: docker.ready,
        dockerEntries: docker.entries,
        dockerReconnects: docker.reconnects,
        dockerErrors: docker.errors,
        behaviorWorkloads: behavior.workloads,
        behaviorCandidates: behavior.candidates,
        behaviorPromoted: behavior.promoted,
        behaviorEvicted: behavior.evicted,
        templateLoaded: templates.loaded,
        templateInvalid: templates.invalid + templateLoadErrors,
        templateMatches: templates.matches,
        templateAmbiguous: templates.ambiguous,
        processCacheEntries: processes.processes,
        processTombstones: processes.tombstones,
        processClassifications: processes.classifications,
        processCacheHits: processes.cacheHits,
        processCacheMisses: processes.cacheMisses,
        processProcReads: processes.procReads,
        processBootstrapProcReads: processes.bootstrapProcReads,
        processFallbackProcReads: processes.fallbackProcReads,
        processAncestryProcReads: processes.ancestryProcReads,
        infrastructure: classifications.infrastructure,
        workspaceConflict: classifications.workspaceConflict,
      },
      message: `filter_mode=${FILTER_MODE}; retain_unknown=${RETAIN_UNKNOWN}; retain_non_agent=${RETAIN_NON_AGENT}; noise_policy=${NOISE_POLICY}; observed=${classifications.observed}; forwarded=${classifications.forwarded}; confirmed_agent=${classifications.confirmedAgent}; probable_agent=${classifications.probableAgent}; unknown=${classifications.unknown}; non_agent=${classifications.nonAgent}; infrastructure=${classifications.infrastructure}; workspace_conflict=${classifications.workspaceConflict}; filtered_non_agent=${classifications.filteredNonAgent}; would_filter_non_agent=${classifications.wouldFilterNonAgent}; filtered_noise=${classifications.filteredNoise}; would_filter_noise=${classifications.wouldFilterNoise}; discovery_budget_dropped=${classifications.discoveryBudgetDropped}; would_discovery_budget_drop=${classifications.wouldDiscoveryBudgetDrop}; deduplicated=${classifications.deduplicated}; queue_dropped=${classifications.queueDropped}; batches=${classifications.batches}; batch_events=${classifications.batchEvents}; spool_records=${spoolStatus.records}; spool_bytes=${spoolStatus.logicalBytes}; spool_oldest_ms=${spoolStatus.oldestMs}; retries=${retries}; durable_acks=${durableAcks}; permanent_rejections=${permanentRejections}; identity_snapshot_ready=${workload.ready}; identity_snapshot_version=${workload.version}; identity_snapshot_age_seconds=${workload.ageSeconds}; identity_cache_entries=${workload.entries}; identity_cache_hits=${workload.hits}; identity_cache_misses=${workload.misses}; identity_cgroup_hits=${workload.cgroupHits}; identity_cgroup_misses=${workload.cgroupMisses}; process_cache_hits=${processes.cacheHits}; process_cache_misses=${processes.cacheMisses}; process_proc_reads=${processes.procReads}; process_bootstrap_proc_reads=${processes.bootstrapProcReads}; process_fallback_proc_reads=${processes.fallbackProcReads}; process_ancestry_proc_reads=${processes.ancestryProcReads}; identity_errors=${workload.errors}; docker_enabled=${docker.enabled}; docker_ready=${docker.ready}; docker_entries=${docker.entries}; docker_reconnects=${docker.reconnects}; docker_errors=${docker.errors}; behavior_workloads=${behavior.workloads}; behavior_candidates=${behavior.candidates}; behavior_promoted=${behavior.promoted}; behavior_evicted=${behavior.evicted}; output_drops=${dropped}; errors=${errors}`,
      ...sourceFields(),
    },
    5000,
    (failed) => {
      if (failed) {
        outputDropped++;
        errorCount++;
      } else if (retryBatches.size > 0) {
        for (const batch of retryBatches.values()) {
          if (!batch.sending) batch.nextAttemptAt = Date.now();
        }
        pumpSpool();
      }
      done(Boolean(failed));
    },
  );
}

function closeTransports() {
  dockerDiscovery.stop();
  infrastructureResolver.close();
  httpAgent.destroy();
  httpsAgent.destroy();
}

function queuePriority(kind, classification) {
  if (kind === 'SecurityAction') return 5;
  if (classification.attribution?.classification === 'confirmed_agent') return 4;
  if (classification.state === 'agent') return 3;
  if (classification.state === 'unknown') return 2;
  if (kind === 'ToolExec' || kind === 'ProcessExit') return 1;
  return 0;
}

function scheduleBatch() {
  if (batchTimer || spool.records.size === 0) return;
  batchTimer = setTimeout(() => {
    batchTimer = undefined;
    pumpSpool();
  }, BATCH_FLUSH_MS);
  batchTimer.unref();
}

function retryDelay(attempt) {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(16, attempt)));
  return Math.max(RETRY_BASE_MS, Math.round(ceiling * (0.75 + Math.random() * 0.5)));
}

function stableBatchId(records) {
  const hash = crypto.createHash('sha256')
    .update(WRITER_ID)
    .update('\0')
    .update(IDEMPOTENCY_PROTOCOL_VERSION);
  for (const record of records) hash.update('\0').update(record.id);
  return `ob_${hash.digest('hex').slice(0, 32)}`;
}

function applySpoolBackpressure() {
  if (!rl || closing) return;
  const status = spool.status();
  if (status.atCapacity) {
    rl.pause();
    return;
  }
  if (
    status.records < Math.floor(spool.maxRecords * 0.8) &&
    status.logicalBytes < Math.floor(spool.maxBytes * 0.8)
  ) rl.resume();
}

function scheduleNextRetry() {
  if (batchTimer) clearTimeout(batchTimer);
  const dueAt = [...retryBatches.values()].filter((batch) => !batch.sending).reduce(
    (minimum, batch) => Math.min(minimum, batch.nextAttemptAt),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(dueAt)) {
    batchTimer = undefined;
    return;
  }
  const delay = Math.max(1, dueAt - Date.now());
  batchTimer = setTimeout(() => {
    batchTimer = undefined;
    pumpSpool();
  }, delay);
  batchTimer.unref();
}

function retainForRetry(batch, error) {
  batch.attempt += 1;
  batch.sending = false;
  batch.lastError = String(error || 'batch not durably acknowledged').slice(0, 2_000);
  batch.nextAttemptAt = Date.now() + retryDelay(batch.attempt);
  retryBatches.set(batch.batchId, batch);
  retryCount++;
  errorCount++;
  if (batch.attempt === 1 || (batch.attempt & (batch.attempt - 1)) === 0) {
    console.warn(
      `[observer-forward] batch retry scheduled: batch=${batch.batchId}; `
      + `events=${batch.records.length}; attempt=${batch.attempt}; error=${batch.lastError}`,
    );
  }
}

function finishBatch(batch, result) {
  if (!result.ok && result.statusCode === 413) {
    for (const record of batch.records) inflightIds.delete(record.id);
    retryBatches.delete(batch.batchId);
    inflight = Math.max(0, inflight - 1);
    if (batch.records.length === 1) {
      spool.deadLetter(batch.records, 'single observer event exceeds API request-body limit');
      permanentRejectionCount++;
      outputDropped++;
    } else {
      const middle = Math.ceil(batch.records.length / 2);
      for (const records of [
        batch.records.slice(0, middle),
        batch.records.slice(middle),
      ]) {
        const split = {
          batchId: stableBatchId(records),
          records,
          attempt: batch.attempt + 1,
          nextAttemptAt: Date.now(),
          sending: false,
          lastError: 'HTTP 413; batch split',
        };
        for (const record of records) inflightIds.add(record.id);
        retryBatches.set(split.batchId, split);
      }
      retryCount++;
    }
    pumpSpool();
    return;
  }
  const itemResults = result.ok && Array.isArray(result.data?.items) ? result.data.items : [];
  const bySourceEventId = new Map(
    itemResults
      .filter((item) => item?.sourceEventId)
      .map((item) => [String(item.sourceEventId), item]),
  );
  const acknowledged = [];
  const rejected = [];
  const retryRecords = [];
  const retryErrors = [];
  for (const record of batch.records) {
    const item = bySourceEventId.get(record.id);
    if (item?.accepted === true && item?.durable === true) {
      acknowledged.push(record.id);
    } else if (item?.retryable === false) {
      rejected.push({ record, reason: item?.error || 'permanent ingest rejection' });
    } else {
      retryRecords.push(record);
      if (item?.error) retryErrors.push(String(item.error));
    }
  }
  if (acknowledged.length) {
    durableAckCount += spool.ack(acknowledged);
  }
  for (const rejection of rejected) {
    spool.deadLetter([rejection.record], rejection.reason);
    permanentRejectionCount++;
    outputDropped++;
  }
  for (const record of batch.records) inflightIds.delete(record.id);
  retryBatches.delete(batch.batchId);
  inflight = Math.max(0, inflight - 1);

  if (retryRecords.length) {
    const retryBatch = {
      ...batch,
      records: retryRecords,
      batchId: stableBatchId(retryRecords),
    };
    for (const record of retryRecords) inflightIds.add(record.id);
    retainForRetry(
      retryBatch,
      retryErrors[0]
        || result.error
        || `HTTP ${result.statusCode || 'unknown'} without durable item ack: `
          + JSON.stringify(result.data ?? {}).slice(0, 1_000),
    );
  }
  applySpoolBackpressure();
  pumpSpool();
}

function submitBatch(batch) {
  if (batch.sending || inflight >= MAX_INFLIGHT) return;
  batch.sending = true;
  inflight++;
  attributionCounts.batches++;
  attributionCounts.batchEvents += batch.records.length;
  postJsonDetailed(
    batchTarget,
    {
      schemaVersion: 'anysentry.observer_batch.v2',
      batchId: batch.batchId,
      writerId: WRITER_ID,
      writerVersion: WRITER_VERSION,
      idempotencyProtocolVersion: IDEMPOTENCY_PROTOCOL_VERSION,
      events: batch.records.map((record) => record.body),
    },
    HTTP_TIMEOUT_MS,
    (result) => finishBatch(batch, result),
  );
}

function pumpSpool() {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = undefined;
  }
  const now = Date.now();
  const pendingRetries = [...retryBatches.values()];
  for (const batch of pendingRetries) {
    if (inflight >= MAX_INFLIGHT) break;
    if (!batch.sending && batch.nextAttemptAt <= now) submitBatch(batch);
  }
  // A poison event must not block unrelated evidence. Retry cardinality remains bounded by
  // MAX_INFLIGHT; once all retry lanes are occupied, new observations stay durably spooled.
  if (retryBatches.size >= MAX_INFLIGHT) {
    scheduleNextRetry();
    return;
  }
  while (inflight < MAX_INFLIGHT && retryBatches.size < MAX_INFLIGHT) {
    const candidates = spool.available(inflightIds, BATCH_SIZE);
    const records = [];
    let batchBytes = 1024;
    for (const candidate of candidates) {
      if (records.length && batchBytes + candidate.bytes > BATCH_MAX_BYTES) break;
      records.push(candidate);
      batchBytes += candidate.bytes + 64;
    }
    if (!records.length) break;
    for (const record of records) inflightIds.add(record.id);
    submitBatch({
      batchId: stableBatchId(records),
      records,
      attempt: 0,
      nextAttemptAt: now,
      sending: false,
    });
  }
  if (spool.records.size > inflightIds.size) scheduleBatch();
}

function enqueue(body, priority) {
  const id = body.sourceEventId;
  try {
    spool.put({ id, body, priority, queuedAt: Date.now() });
  } catch (error) {
    outputDropped++;
    attributionCounts.queueDropped++;
    errorCount++;
    console.error(`[observer-forward] durable spool write failed; input paused: ${error.message}`);
    if (rl) rl.pause();
    process.exitCode = 1;
    return;
  }
  attributionCounts.forwarded++;
  if (spool.records.size >= BATCH_SIZE) pumpSpool();
  else scheduleBatch();
  applySpoolBackpressure();
}

function flushAndClose() {
  if (closing) return;
  closing = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (identitySnapshotTimer) clearInterval(identitySnapshotTimer);
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = undefined;
  pumpSpool();
  const deadline = Date.now() + Math.max(30_000, HTTP_TIMEOUT_MS + RETRY_BASE_MS + 1_000);
  const waitForInflight = () => {
    pumpSpool();
    if ((inflight > 0 || spool.records.size > 0) && Date.now() < deadline) {
      setTimeout(waitForInflight, 50);
      return;
    }
    sendHeartbeat(() => {
      spool.close();
      closeTransports();
    });
  };
  waitForInflight();
}

function handleLine(raw) {
  const line = raw.trim();
  if (!line) return;
  let o;
  try { o = JSON.parse(line); } catch { return; } // skip the collector's human log lines / partials
  const kind = eventKind(o);
  // The Forwarder emits its own live heartbeat with WAL depth, retry and durable-ack metrics.
  // Spooling the Observer's periodic heartbeat makes an old cumulative snapshot compete with the
  // current one during recovery, and the batch API cannot durably acknowledge that control-plane
  // record. Keep the WAL exclusively for evidence events.
  if (kind === 'CollectorHeartbeat') return;
  attributionCounts.observed++;
  if (toolExecDeduper.isDuplicate(o)) {
    attributionCounts.deduplicated++;
    return;
  }
  const processClassification = attributor.classify(o);
  // A trusted deployment label explicitly opts these process trees out. Infrastructure wins over
  // templates and discovery caches and is dropped before ingest in every scope.
  if (processClassification.state === 'infrastructure') {
    attributionCounts.infrastructure++;
    return;
  }
  const workloadClassification = workloadCache.classify(o);
  const templateClassification = templateRegistry.classifyEvent(o);
  const baseClassification =
    templateClassification ??
    workloadClassification ??
    processClassification;
  const classification =
    (behaviorDiscoveryEligible(baseClassification)
      ? behaviorDetector.observe(o, baseClassification.attribution)
      : undefined) ??
    baseClassification;
  const classificationName = classification.attribution?.classification;
  if (classification.state === 'agent' && classificationName === 'confirmed_agent') {
    attributionCounts.confirmedAgent++;
  } else if (classification.state === 'agent') {
    attributionCounts.probableAgent++;
  } else if (classification.state === 'non_agent') {
    attributionCounts.nonAgent++;
  } else {
    attributionCounts.unknown++;
  }
  if (classification.workspaceConflict || classification.attribution?.conflict) {
    attributionCounts.workspaceConflict++;
  }
  let filterReason = '';
  if (classification.state === 'non_agent' && !RETAIN_NON_AGENT) {
    filterReason = 'non_agent';
  } else if (classification.state === 'unknown' && !RETAIN_UNKNOWN) {
    filterReason = 'unknown';
  } else if (NOISE_POLICY === 'balanced' && isNoise(o)) {
    // Routine pseudo-filesystem writes are an independent, explainable noise rule. FileDelete is
    // deliberately excluded because deletion remains high-value evidence.
    filterReason = 'routine_noise';
  }
  if (filterReason) {
    if (FILTER_MODE === 'shadow') {
      if (filterReason === 'non_agent') attributionCounts.wouldFilterNonAgent++;
      else if (filterReason === 'unknown') attributionCounts.wouldDiscoveryBudgetDrop++;
      else attributionCounts.wouldFilterNoise++;
    } else {
      if (filterReason === 'non_agent') {
        attributionCounts.filteredNonAgent++;
        lastNonAgentSuppressedAt = new Date().toISOString();
      } else if (filterReason === 'unknown') {
        attributionCounts.discoveryBudgetDropped++;
      } else {
        attributionCounts.filteredNoise++;
      }
      return;
    }
  }
  bumpEventKind(o);

  const observedAt = Date.now();
  enqueue(
    {
      line,
      sourceEventId: sourceEventId(line, observedAt),
      observedAt,
      ...(classification.attribution ? { attribution: classification.attribution } : {}),
      ...(COLLECTOR_ID ? { collectorId: COLLECTOR_ID } : {}),
      ...(NODE_NAME ? { nodeName: NODE_NAME } : {}),
      ...sourceFields(classification.state === 'agent' ? classification.workspacePath : ''),
    },
    queuePriority(kind, classification),
  );
}

async function start() {
  const infrastructure = await infrastructureResolver.resolve();
  attributor.setInfrastructureRoots(infrastructure.roots);
  const bootstrap = attributor.seedFromProc();
  console.error(
    `[observer-forward] process snapshot: scanned=${bootstrap.scanned}; ` +
    `agent_roots=${bootstrap.roots}; agent_descendants=${bootstrap.descendants}; ` +
    `infrastructure_roots=${bootstrap.infrastructureRoots}; ` +
    `infrastructure_descendants=${bootstrap.infrastructureDescendants}` +
    (infrastructure.error ? `; infrastructure_discovery=${infrastructure.error}` : ''),
  );
  infrastructureResolver.start((next) => {
    attributor.setInfrastructureRoots(next.roots);
  });

  console.error(`[observer-forward] agent templates: source=${templateRegistry.source}; loaded=${templateRegistry.metrics().loaded}; invalid=${templateRegistry.metrics().invalid + templateLoadErrors}`);
  const dockerStarted = await dockerDiscovery.start((snapshot) => workloadCache.replace(snapshot, 'docker'));
  const docker = dockerDiscovery.metrics();
  console.error(`[observer-forward] docker discovery: enabled=${docker.enabled}; started=${dockerStarted}; socket=${dockerDiscovery.socketPath}`);
  const spoolStatus = spool.status();
  console.error(
    `[observer-forward] durable spool: writer=${WRITER_ID}; path=${spoolStatus.filePath}; ` +
    `recovered=${spoolStatus.records}; bytes=${spoolStatus.logicalBytes}; fsync=${spoolStatus.fsyncMode}`,
  );

  if (HEARTBEAT_SECS > 0) {
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_SECS * 1000);
    heartbeatTimer.unref();
  }
  if (IDENTITY_SNAPSHOT_SECS > 0) {
    refreshIdentitySnapshot();
    identitySnapshotTimer = setInterval(refreshIdentitySnapshot, IDENTITY_SNAPSHOT_SECS * 1000);
    identitySnapshotTimer.unref();
  }

  rl = readline.createInterface({ input: process.stdin });
  rl.on('line', handleLine);
  rl.on('close', flushAndClose);
  process.once('SIGTERM', () => rl.close());
  process.once('SIGINT', () => rl.close());
  pumpSpool();
}

void start().catch((error) => {
  console.error('[observer-forward] startup failed:', error instanceof Error ? error.message : String(error));
  spool.close();
  closeTransports();
  process.exitCode = 1;
});
