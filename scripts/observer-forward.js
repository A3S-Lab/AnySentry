#!/usr/bin/env node
// Bridge a3s-observer NDJSON (stdin) -> AnySentry batched ingest. Node stdlib only.
//   a3s-observer-collector | node observer-forward.js
// Target from ANYSENTRY_INGEST_URL (default http://localhost:29653/security-center/ingest).
//
// Backpressure is essential: a busy node emits a firehose of events. We bound the priority queue,
// batch network writes, cap in-flight POSTs, and pause stdin at pressure so memory stays flat.
//
// Agent scope is fail-open for attribution: known Agent and unresolved events are forwarded, and
// only events with a complete non-Agent PID ancestry are dropped. The legacy all/shadow modes also
// remove pseudo-filesystem file noise; override those prefixes via FORWARD_DROP_PATHS.
const http = require('node:http');
const https = require('node:https');
const readline = require('node:readline');
const { AgentAttributor } = require('./observer-agent-attribution');
const { AgentTemplateRegistry, loadTemplateDocument } = require('./observer-agent-templates');
const { DockerDiscovery } = require('./observer-docker-discovery');
const { BehavioralAgentDetector } = require('./observer-behavior-discovery');
const { ToolExecDeduper } = require('./observer-event-dedup');
const { DiscoveryBudget, WorkloadIdentityCache } = require('./observer-workload-filter');

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
const MAX_QUEUE = boundedNumber(process.env.FORWARD_MAX_QUEUE, 4_096, BATCH_SIZE, 100_000);
const HTTP_TIMEOUT_MS = boundedNumber(process.env.FORWARD_HTTP_TIMEOUT_MS, 10_000, 1_000, 120_000);
const UNKNOWN_FILE_BUDGET_PER_SEC = boundedNumber(
  process.env.FORWARD_UNKNOWN_FILE_BUDGET_PER_SEC,
  20,
  1,
  10_000,
);
const FORWARD_SCOPE = ['agent', 'all', 'shadow'].includes(process.env.FORWARD_SCOPE)
  ? process.env.FORWARD_SCOPE
  : 'agent';
const DROP_PATHS = (process.env.FORWARD_DROP_PATHS || '/sys/,/proc/,/run/,/dev/').split(',').map((s) => s.trim()).filter(Boolean);
const COLLECTOR_ID = process.env.A3S_OBSERVER_COLLECTOR_ID || process.env.COLLECTOR_ID || process.env.HOSTNAME || '';
const NODE_NAME = process.env.A3S_NODE_NAME || process.env.NODE_NAME || '';
const SOURCE_ID = process.env.ANYSENTRY_SOURCE_ID || '';
const SOURCE_NAME = process.env.ANYSENTRY_SOURCE_NAME || '';
const SOURCE_TYPE = process.env.ANYSENTRY_SOURCE_TYPE || 'observer';
const SOURCE_TOKEN = process.env.ANYSENTRY_INGEST_TOKEN || '';
const WORKSPACE_PATH = process.env.ANYSENTRY_WORKSPACE_PATH || '';
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
const discoveryBudget = new DiscoveryBudget({ limit: UNKNOWN_FILE_BUDGET_PER_SEC });
const bootstrap = attributor.seedFromProc();
console.error(`[observer-forward] process snapshot: scanned=${bootstrap.scanned}; agent_roots=${bootstrap.roots}; agent_descendants=${bootstrap.descendants}`);
console.error(`[observer-forward] agent templates: source=${templateRegistry.source}; loaded=${templateRegistry.metrics().loaded}; invalid=${templateRegistry.metrics().invalid + templateLoadErrors}`);
void dockerDiscovery.start((snapshot) => workloadCache.replace(snapshot, 'docker')).then((started) => {
  const docker = dockerDiscovery.metrics();
  const behavior = behaviorDetector.metrics();
  console.error(`[observer-forward] docker discovery: enabled=${docker.enabled}; started=${started}; socket=${dockerDiscovery.socketPath}`);
});
const toolExecDeduper = new ToolExecDeduper({
  windowMs: process.env.FORWARD_DEDUP_WINDOW_MS,
  maxKeys: process.env.FORWARD_MAX_DEDUP_KEYS,
});

let inflight = 0;
let pending = [];
let outputDropped = 0;
let errorCount = 0;
let eventKindCounts = Object.create(null);
let attributionCounts = {
  observed: 0,
  confirmedAgent: 0,
  probableAgent: 0,
  unknown: 0,
  nonAgent: 0,
  filteredNonAgent: 0,
  filteredNoise: 0,
  discoveryBudgetDropped: 0,
  forwarded: 0,
  queueDropped: 0,
  batches: 0,
  batchEvents: 0,
  deduplicated: 0,
};
let closing = false;
let heartbeatTimer;
let identitySnapshotTimer;
let batchTimer;
const rl = readline.createInterface({ input: process.stdin });

function isNoise(o) {
  const fa = o.event && (o.event.FileAccess || o.event.FileDelete);
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

function sourceFields() {
  return {
    ...(SOURCE_ID ? { sourceId: SOURCE_ID } : {}),
    ...(SOURCE_NAME ? { sourceName: SOURCE_NAME } : {}),
    ...(SOURCE_TYPE ? { sourceType: SOURCE_TYPE } : {}),
    ...(WORKSPACE_PATH ? { workspacePath: WORKSPACE_PATH } : {}),
  };
}

function sourceHeaders() {
  return {
    ...(SOURCE_ID ? { 'X-AnySentry-Source-Id': SOURCE_ID } : {}),
    ...(SOURCE_TOKEN ? { 'X-AnySentry-Ingest-Token': SOURCE_TOKEN } : {}),
  };
}

function postJson(url, bodyObj, timeoutMs, done) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    done(true);
    return;
  }
  const body = JSON.stringify(bodyObj);
  let settled = false;
  const finish = (failed) => {
    if (settled) return;
    settled = true;
    done(Boolean(failed));
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
      res.resume();
      res.on('end', () => finish((res.statusCode || 500) >= 400));
    },
  );
  req.on('error', () => finish(true));
  req.setTimeout(timeoutMs, () => {
    finish(true);
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
  eventKindCounts = Object.create(null);
  attributionCounts = {
    observed: 0,
    confirmedAgent: 0,
    probableAgent: 0,
    unknown: 0,
    nonAgent: 0,
    filteredNonAgent: 0,
    filteredNoise: 0,
    discoveryBudgetDropped: 0,
    forwarded: 0,
    queueDropped: 0,
    batches: 0,
    batchEvents: 0,
    deduplicated: 0,
  };
  outputDropped = 0;
  errorCount = 0;
  const status = dropped > 0 || errors > 0 ? 'degraded' : 'ok';
  postJson(
    heartbeatTarget,
    {
      collectorId: COLLECTOR_ID || undefined,
      nodeName: NODE_NAME || undefined,
      mode: `observer-forwarder:${FORWARD_SCOPE}`,
      status,
      intervalSecs: HEARTBEAT_SECS,
      eventKindCounts: counts,
      queueDepth: pending.length,
      outputDropped: dropped,
      errorCount: errors,
      message: `scope=${FORWARD_SCOPE}; observed=${classifications.observed}; forwarded=${classifications.forwarded}; confirmed_agent=${classifications.confirmedAgent}; probable_agent=${classifications.probableAgent}; unknown=${classifications.unknown}; non_agent=${classifications.nonAgent}; filtered_non_agent=${classifications.filteredNonAgent}; filtered_noise=${classifications.filteredNoise}; discovery_budget_dropped=${classifications.discoveryBudgetDropped}; deduplicated=${classifications.deduplicated}; queue_dropped=${classifications.queueDropped}; batches=${classifications.batches}; batch_events=${classifications.batchEvents}; identity_snapshot_ready=${workload.ready}; identity_snapshot_version=${workload.version}; identity_snapshot_age_seconds=${workload.ageSeconds}; identity_cache_entries=${workload.entries}; identity_cache_hits=${workload.hits}; identity_cache_misses=${workload.misses}; identity_errors=${workload.errors}; docker_enabled=${docker.enabled}; docker_ready=${docker.ready}; docker_entries=${docker.entries}; docker_reconnects=${docker.reconnects}; docker_errors=${docker.errors}; behavior_workloads=${behavior.workloads}; behavior_candidates=${behavior.candidates}; behavior_promoted=${behavior.promoted}; behavior_evicted=${behavior.evicted}; output_drops=${dropped}; errors=${errors}`,
      ...sourceFields(),
    },
    5000,
    (failed) => {
      if (failed) {
        outputDropped++;
        errorCount++;
      }
      done(Boolean(failed));
    },
  );
}

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

function closeTransports() {
  dockerDiscovery.stop();
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
  if (batchTimer || pending.length === 0) return;
  batchTimer = setTimeout(() => {
    batchTimer = undefined;
    flushPending();
  }, BATCH_FLUSH_MS);
  batchTimer.unref();
}

function finishBatch(failed, batchLength) {
  if (failed) {
    outputDropped += batchLength;
    errorCount++;
  }
  inflight = Math.max(0, inflight - 1);
  while (pending.length > 0 && inflight < MAX_INFLIGHT) flushPending();
  if (!closing && pending.length < MAX_QUEUE && inflight < MAX_INFLIGHT) rl.resume();
}

function flushPending() {
  if (pending.length === 0 || inflight >= MAX_INFLIGHT) return;
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = undefined;
  }
  const batch = pending.splice(0, BATCH_SIZE);
  inflight++;
  attributionCounts.batches++;
  attributionCounts.batchEvents += batch.length;
  postJson(
    batchTarget,
    { events: batch.map((item) => item.body) },
    HTTP_TIMEOUT_MS,
    (failed) => finishBatch(failed, batch.length),
  );
  if (pending.length > 0 && inflight < MAX_INFLIGHT) flushPending();
}

function enqueue(body, priority) {
  if (pending.length >= MAX_QUEUE) {
    let lowestIndex = 0;
    for (let index = 1; index < pending.length; index += 1) {
      if (pending[index].priority < pending[lowestIndex].priority) lowestIndex = index;
    }
    if (priority <= pending[lowestIndex].priority) {
      outputDropped++;
      attributionCounts.queueDropped++;
      return;
    }
    pending.splice(lowestIndex, 1);
    outputDropped++;
    attributionCounts.queueDropped++;
  }
  pending.push({ body, priority });
  attributionCounts.forwarded++;
  if (pending.length >= BATCH_SIZE) flushPending();
  else scheduleBatch();
  if (pending.length >= MAX_QUEUE || inflight >= MAX_INFLIGHT) rl.pause();
}

function flushAndClose() {
  if (closing) return;
  closing = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (identitySnapshotTimer) clearInterval(identitySnapshotTimer);
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = undefined;
  while (pending.length > 0 && inflight < MAX_INFLIGHT) flushPending();
  const deadline = Date.now() + Math.max(5_000, HTTP_TIMEOUT_MS + 1_000);
  const waitForInflight = () => {
    while (pending.length > 0 && inflight < MAX_INFLIGHT) flushPending();
    if ((inflight > 0 || pending.length > 0) && Date.now() < deadline) {
      setTimeout(waitForInflight, 50);
      return;
    }
    if (pending.length > 0) {
      outputDropped += pending.length;
      attributionCounts.queueDropped += pending.length;
      pending = [];
    }
    sendHeartbeat(() => {
      closeTransports();
    });
  };
  waitForInflight();
}

rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  let o;
  try { o = JSON.parse(line); } catch { return; } // skip the collector's human log lines / partials
  attributionCounts.observed++;
  if (toolExecDeduper.isDuplicate(o)) {
    attributionCounts.deduplicated++;
    return;
  }
  const workloadClassification = workloadCache.classify(o);
  const templateClassification = templateRegistry.classifyEvent(o);
  const baseClassification =
    templateClassification ??
    workloadClassification ??
    attributor.classify(o);
  const behaviorEligible =
    baseClassification.state === 'unknown' ||
    (
      baseClassification.state === 'non_agent' &&
      baseClassification.attribution?.source === 'process_graph'
    );
  const classification =
    (behaviorEligible
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
  const kind = eventKind(o);
  // A rare, high-signal security action is useful even when its workload is a known non-Agent.
  if (
    FORWARD_SCOPE === 'agent' &&
    classification.state === 'non_agent' &&
    kind !== 'SecurityAction'
  ) {
    attributionCounts.filteredNonAgent++;
    return;
  }
  // Snapshot outages fail open, but an unknown container must not flood the API with routine
  // file-write churn. Preserve the first bounded set per workload/second; ToolExec, deletes,
  // security, network, and LLM evidence never enter this budget.
  if (
    FORWARD_SCOPE === 'agent' &&
    classification.state === 'unknown' &&
    kind === 'FileAccess' &&
    !discoveryBudget.allow(o)
  ) {
    attributionCounts.discoveryBudgetDropped++;
    return;
  }
  // Preserve the legacy pseudo-filesystem noise filter in all/shadow modes. In agent mode,
  // unknown events must survive so incomplete lineage never becomes silent data loss.
  if (FORWARD_SCOPE !== 'agent' && isNoise(o)) {
    attributionCounts.filteredNoise++;
    return;
  }
  bumpEventKind(o);

  enqueue(
    {
      line,
      ...(classification.attribution ? { attribution: classification.attribution } : {}),
      ...(COLLECTOR_ID ? { collectorId: COLLECTOR_ID } : {}),
      ...(NODE_NAME ? { nodeName: NODE_NAME } : {}),
      ...sourceFields(),
    },
    queuePriority(kind, classification),
  );
});

rl.on('close', flushAndClose);
