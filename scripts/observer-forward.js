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
const fs = require('node:fs');
const readline = require('node:readline');
const { AgentAttributor, readProcStartTime } = require('./observer-agent-attribution');
const { mergeAttributionClassifications } = require('./observer-attribution-merge');
const { AgentTemplateRegistry, loadTemplateDocument } = require('./observer-agent-templates');
const {
  RuntimeSignatureRegistry,
  RuntimeSignatureReloader,
  loadSignatureDocument,
} = require('./observer-agent-runtime-signatures');
const { DockerDiscovery } = require('./observer-docker-discovery');
const { BehavioralAgentDetector } = require('./observer-behavior-discovery');
const { BoundedPriorityQueue } = require('./observer-priority-queue');
const { ToolExecDeduper } = require('./observer-event-dedup');
const {
  behaviorDiscoveryEligible,
  classifyEventActivity,
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

function defaultRuntimeSnapshotUrl(ingestUrl) {
  const url = new URL(ingestUrl.toString());
  const nextPath = url.pathname.replace(/\/ingest(?:\/.*)?$/, '/runtime/snapshot');
  url.pathname = nextPath === url.pathname ? '/security-center/runtime/snapshot' : nextPath;
  url.hash = '';
  return url;
}

function defaultRuntimeLeaseUrl(runtimeSnapshotUrl) {
  const url = new URL(runtimeSnapshotUrl.toString());
  const nextPath = url.pathname.replace(/\/runtime\/snapshot(?:\/.*)?$/, '/runtime/lease');
  url.pathname = nextPath === url.pathname ? '/security-center/runtime/lease' : nextPath;
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
// Leave at least 1 MiB for the batch envelope below the API route's default 4 MiB parser ceiling.
const BATCH_MAX_BYTES = boundedNumber(
  process.env.FORWARD_BATCH_MAX_BYTES,
  512 * 1024,
  64 * 1024,
  3 * 1024 * 1024,
);
const MAX_EVENT_BYTES = boundedNumber(
  process.env.FORWARD_MAX_EVENT_BYTES,
  3 * 1024 * 1024,
  64 * 1024,
  3 * 1024 * 1024,
);
// This cap covers every event owned by the forwarder, regardless of whether it is waiting in the
// priority queue, inside an HTTP request, or waiting for an API-authorized retry. Keeping the
// retry budget separate would let a prolonged ClickHouse outage silently multiply memory. Legacy
// FORWARD_MAX_QUEUE(_BYTES) remain compatibility aliases for the unified limits; new names win.
const MAX_OUTSTANDING_EVENTS = boundedNumber(
  process.env.FORWARD_MAX_OUTSTANDING_EVENTS || process.env.FORWARD_MAX_QUEUE,
  16_384,
  1,
  1_000_000,
);
const MAX_OUTSTANDING_BYTES = boundedNumber(
  process.env.FORWARD_MAX_OUTSTANDING_BYTES || process.env.FORWARD_MAX_QUEUE_BYTES,
  64 * 1024 * 1024,
  1024,
  1024 * 1024 * 1024,
);
const RETRY_BASE_DELAY_MS = boundedNumber(process.env.FORWARD_RETRY_BASE_DELAY_MS, 250, 10, 2_000);
const RETRY_MAX_DELAY_MS = boundedNumber(
  process.env.FORWARD_RETRY_MAX_DELAY_MS,
  2_000,
  RETRY_BASE_DELAY_MS,
  2_000,
);
const RETRY_MAX_AGE_MS = boundedNumber(process.env.FORWARD_RETRY_MAX_AGE_MS, 45_000, 100, 45_000);
const RETRY_JITTER_RATIO = 0.2;
const HTTP_TIMEOUT_MS = boundedNumber(process.env.FORWARD_HTTP_TIMEOUT_MS, 10_000, 1_000, 120_000);
const BATCH_ACK_MAX_BYTES = boundedNumber(
  process.env.FORWARD_BATCH_ACK_MAX_BYTES,
  1024 * 1024,
  16 * 1024,
  4 * 1024 * 1024,
);
const IDENTITY_SNAPSHOT_MAX_BYTES = boundedNumber(
  process.env.FORWARD_IDENTITY_SNAPSHOT_MAX_BYTES,
  4 * 1024 * 1024,
  64 * 1024,
  16 * 1024 * 1024,
);
const SHUTDOWN_TIMEOUT_MS = boundedNumber(
  process.env.FORWARD_SHUTDOWN_TIMEOUT_MS,
  15_000,
  2_000,
  30_000,
);
const GRACEFUL_SHUTDOWN_SUPERSEDE = 'control request superseded by graceful shutdown';
function envBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

const rawE2eIngestMarkerPrefix = process.env.ANYSENTRY_E2E_INGEST_MARKER_PREFIX;
const e2eIngestMarkerPrefixMatch = rawE2eIngestMarkerPrefix?.match(
  /^asel-marker-([a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?)-(host|docker|k8s)-(shadow|enforce)-$/,
);
if (
  rawE2eIngestMarkerPrefix !== undefined &&
  !e2eIngestMarkerPrefixMatch
) {
  throw new Error('ANYSENTRY_E2E_INGEST_MARKER_PREFIX must identify one bounded E2E collector phase');
}
// This explicit, test-only scope prevents a lifecycle canary from turning host-wide kernel noise
// into an API load test. Every event still reaches attribution/runtime discovery below; only the
// exact run's marker-bearing ToolExec is admitted to the event queue. Production leaves it unset.
const E2E_INGEST_MARKER_PREFIX = rawE2eIngestMarkerPrefix || '';
const E2E_INGEST_MARKERS = new Set((!E2E_INGEST_MARKER_PREFIX
  ? []
  : e2eIngestMarkerPrefixMatch[2] === 'host'
    ? ['non-agent-filter-canary', 'host-codex', 'host-kimi']
    : ['unknown-filter-canary', 'pi']
).map((suffix) => E2E_INGEST_MARKER_PREFIX + suffix));

const LEGACY_FORWARD_SCOPE = ['agent', 'all', 'shadow'].includes(process.env.FORWARD_SCOPE)
  ? process.env.FORWARD_SCOPE
  : undefined;
const FILTER_MODE = ['enforce', 'shadow'].includes(process.env.FORWARD_FILTER_MODE)
  ? process.env.FORWARD_FILTER_MODE
  : LEGACY_FORWARD_SCOPE === 'agent' ? 'enforce' : 'shadow';
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
const HEARTBEAT_SECS = Math.max(0, Number(process.env.ANYSENTRY_HEARTBEAT_SECS || 30));
const heartbeatTarget = new URL(process.env.ANYSENTRY_HEARTBEAT_URL || defaultHeartbeatUrl(target));
const batchTarget = new URL(process.env.ANYSENTRY_BATCH_INGEST_URL || defaultBatchIngestUrl(target));
const IDENTITY_SNAPSHOT_SECS = Math.max(0, Number(process.env.ANYSENTRY_IDENTITY_SNAPSHOT_SECS || 15));
const identitySnapshotTarget = new URL(
  process.env.ANYSENTRY_IDENTITY_SNAPSHOT_URL || defaultIdentitySnapshotUrl(target),
);
if (NODE_NAME) identitySnapshotTarget.searchParams.set('nodeName', NODE_NAME);
const RUNTIME_SNAPSHOT_SECS = boundedNumber(
  process.env.ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS,
  10,
  1,
  300,
);
const ROOT_LIVENESS_SECS = boundedNumber(
  process.env.ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS,
  5,
  1,
  300,
);
const runtimeSnapshotTarget = new URL(
  process.env.ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL || defaultRuntimeSnapshotUrl(target),
);

function observerForwarderProcessIdentity() {
  const hostPid = positiveInteger(process.env.A3S_OBSERVER_FORWARDER_HOST_PID);
  const pid = hostPid || process.pid;
  const startTime = readProcStartTime(pid)
    // In a nested PID namespace NSpid exposes the host PID, while /proc only exposes the local
    // PID. Both names refer to the same process and therefore share one boot-relative start tick.
    || readProcStartTime(process.pid);
  return {
    pid,
    startTimeTicks: startTime || '0',
  };
}

function resolveObserverForwarderHostPid() {
  if (positiveInteger(process.env.A3S_OBSERVER_FORWARDER_HOST_PID)) return;
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const nspid = status.match(/^NSpid:\s+(.+)$/mu)?.[1]
      ?.trim()
      .split(/\s+/u)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    // With hostPID / `pid: host`, this is normally a single PID. Nested PID namespaces expose
    // outermost -> innermost values; ProcessKey uses the host-visible outermost value.
    const hostPid = nspid?.[0];
    if (hostPid) process.env.A3S_OBSERVER_FORWARDER_HOST_PID = String(hostPid);
  } catch {}
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
const runtimeLeaseTarget = new URL(
  process.env.ANYSENTRY_AGENT_RUNTIME_LEASE_URL || defaultRuntimeLeaseUrl(runtimeSnapshotTarget),
);
const eventHttpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT });
const eventHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT });
// Lifecycle/health traffic must remain available while every event socket is occupied.
const controlHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const controlHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
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
let signatureInitialLoadErrors = 0;
const signatureRegistry = new RuntimeSignatureRegistry(undefined, { source: 'builtin' });
try {
  const signatureDocument = loadSignatureDocument();
  const loaded = signatureRegistry.replaceSafely(signatureDocument.document, signatureDocument.source);
  if (!loaded.ok) throw new Error(loaded.error);
} catch (error) {
  signatureInitialLoadErrors++;
  console.error(`[observer-forward] Agent runtime signatures ignored: ${error.message}`);
}
const attributor = new AgentAttributor({
  signatureRegistry,
  hostId: process.env.A3S_OBSERVER_HOST_ID || NODE_NAME,
});
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
let inflightEvents = 0;
let inflightBytes = 0;
let outstandingEvents = 0;
let outstandingBytes = 0;
let retryOutstandingEvents = 0;
let retryOutstandingBytes = 0;
const outstandingItems = new Set();
const pending = new BoundedPriorityQueue(MAX_OUTSTANDING_EVENTS, 5, (item) => item.bytes);
const retryTasks = [];
const activeEventRequests = new Set();
const activeControlRequests = new Set();
let eventRequestsAborted = false;
let outputDropped = 0;
let errorCount = 0;
let eventKindCounts = Object.create(null);
const forwarderInstanceId = crypto.randomUUID();
let sourceEventSequence = 0;
let lastNonAgentSuppressedAt = '';
let e2eFilterReceipts = [];
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
  e2eMarkerScopedOut: 0,
  forwarded: 0,
  queueDropped: 0,
  batches: 0,
  batchEvents: 0,
  retryQueued: 0,
  retryAttempts: 0,
  retryRecovered: 0,
  retryExhausted: 0,
  workspaceConflict: 0,
  infrastructure: 0,
  deduplicated: 0,
};
let closing = false;
let heartbeatTimer;
let identitySnapshotTimer;
let runtimeSnapshotTimer;
let rootLivenessTimer;
let batchTimer;
let retryTimer;
let shutdownForceTimer;
let shutdownDeadline = 0;
let eventDrainDeadline = 0;
let shutdownFinalizing = false;
let transportsClosed = false;
let signatureReloader;
let rl;
let runtimeSnapshotVersion = 0;
let runtimeSnapshotPosts = 0;
let runtimeSnapshotErrors = 0;
let runtimeSnapshotRejected = 0;
let runtimeSnapshotDuplicates = 0;
let runtimeSnapshotRetries = 0;
let runtimeSnapshotRecovered = 0;
let lastRuntimeSnapshotAt = '';
let lastRuntimeSnapshotError = '';
let lastRuntimeSnapshotRetryAt = '';
let lastRuntimeSnapshotRetryReason = '';
let lastRuntimeSnapshotFailureAt = '';
let lastRuntimeSnapshotFailure = '';
let lastRuntimeSnapshotFailureVersion = 0;
let runtimeLeaseEpoch;
let runtimeLeaseAttempts = 0;
let runtimeLeaseErrors = 0;
let runtimeLeaseFenced = false;
let runtimeLeasePromise;
let runtimeSnapshotInFlight = false;
let runtimeSnapshotOperation = 0;
let reconcileTimer;
let reconcileRunning = false;
let reconcilePending = false;

function recordRuntimeSnapshotFailure(reason, snapshotVersion = runtimeSnapshotVersion) {
  lastRuntimeSnapshotFailureAt = new Date().toISOString();
  lastRuntimeSnapshotFailure = String(reason || 'runtime snapshot failed').slice(0, 500);
  lastRuntimeSnapshotFailureVersion = Number.isSafeInteger(snapshotVersion) && snapshotVersion > 0
    ? snapshotVersion
    : 0;
}

function retryableRuntimeSnapshotError(error) {
  if (error?.retriable === false) return false;
  const statusCode = Number(error?.statusCode);
  return !Number.isFinite(statusCode)
    || statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || statusCode >= 500;
}
let reconcileRequestedAt = 0;
const RECONCILE_MIN_INTERVAL_MS = boundedNumber(
  process.env.ANYSENTRY_AGENT_RUNTIME_RECONCILE_MIN_MS,
  2_000,
  250,
  60_000,
);
let reconciliationMetrics = {
  requested: 0,
  runs: 0,
  coalesced: 0,
  errors: 0,
  scanned: 0,
  roots: 0,
  invalidated: 0,
  lastDurationMs: 0,
};

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

function matchesE2eIngestMarkerScope(o) {
  if (!E2E_INGEST_MARKER_PREFIX) return true;
  const argv = o?.event?.ToolExec?.argv;
  return Array.isArray(argv) && argv.some((arg) => E2E_INGEST_MARKERS.has(arg));
}

function sourceEventId(line) {
  sourceEventSequence += 1;
  return `ose_${crypto.createHash('sha256')
    .update(COLLECTOR_ID)
    .update('\0')
    .update(NODE_NAME)
    .update('\0')
    .update(forwarderInstanceId)
    .update('\0')
    .update(String(sourceEventSequence))
    .update('\0')
    .update(line)
    .digest('hex')
    .slice(0, 24)}`;
}

function recordE2eFilterReceipt(o, classification, filterReason, line) {
  const markerHash = text(process.env.ANYSENTRY_E2E_FILTER_MARKER_SHA256).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(markerHash)) return;
  const payload = o?.event?.ToolExec;
  if (!payload || !Array.isArray(payload.argv)) return;
  const matched = payload.argv.some((arg) =>
    crypto.createHash('sha256').update(JSON.stringify(text(arg))).digest('hex') === markerHash,
  );
  if (!matched) return;
  const receipt = {
    schema: 'anysentry.e2e_filter_receipt.v1',
    eventKind: 'ToolExec',
    markerSha256: markerHash,
    lineSha256: crypto.createHash('sha256').update(line).digest('hex'),
    physicalWorkloadId: classification.attribution?.physicalWorkloadId,
    classification: classification.attribution?.classification || classification.state,
    filterReason,
    filteredAt: new Date().toISOString(),
  };
  e2eFilterReceipts.push(receipt);
  if (e2eFilterReceipts.length > 8) e2eFilterReceipts.shift();
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
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    done(true);
    return;
  }
  const body = JSON.stringify(bodyObj);
  let settled = false;
  let absoluteTimer;
  let req;
  let response;
  let abortReason = '';
  const state = {
    abort(reason = 'control request aborted') {
      if (settled) return;
      abortReason = reason;
      response?.destroy();
      req?.destroy();
      finish(true, reason);
    },
  };
  const finish = (failed, reason) => {
    if (settled) return;
    settled = true;
    if (absoluteTimer) clearTimeout(absoluteTimer);
    activeControlRequests.delete(state);
    done(Boolean(failed), abortReason || reason);
  };
  req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      agent: isHttps ? controlHttpsAgent : controlHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...sourceHeaders(),
      },
    },
    (res) => {
      response = res;
      res.resume();
      res.on('end', () => finish((res.statusCode || 500) >= 400));
      res.on('aborted', () => finish(true));
      res.on('error', () => finish(true));
      res.on('close', () => {
        if (!res.complete) finish(true);
      });
    },
  );
  activeControlRequests.add(state);
  req.on('error', () => finish(true));
  absoluteTimer = setTimeout(() => {
    state.abort();
  }, timeoutMs);
  req.end(body);
}

function invalidBatchAck(batchLength, reason) {
  return { dropped: batchLength, errors: 1, retryItems: [], reason };
}

function validateBatchAck(value, batch) {
  const batchLength = batch.length;
  const ack = value?.data ?? value;
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
    return invalidBatchAck(batchLength, 'batch endpoint returned no acknowledgement');
  }
  const acceptedEvents = ack.acceptedEvents;
  const rejectedEvents = ack.rejectedEvents;
  const retryableEvents = ack.retryableEvents ?? 0;
  const items = ack.items;
  if (
    !Number.isSafeInteger(acceptedEvents) || acceptedEvents < 0
    || !Number.isSafeInteger(rejectedEvents) || rejectedEvents < 0
    || !Number.isSafeInteger(retryableEvents) || retryableEvents < 0
    || acceptedEvents + rejectedEvents + retryableEvents !== batchLength
    || typeof ack.accepted !== 'boolean'
    || ack.accepted !== (acceptedEvents > 0)
    || !Array.isArray(items)
    || items.length !== batchLength
  ) {
    return invalidBatchAck(batchLength, 'batch endpoint returned an inconsistent acknowledgement');
  }
  if (
    ack.retryAfterMs !== undefined
    && (!Number.isSafeInteger(ack.retryAfterMs) || ack.retryAfterMs < 0 || retryableEvents === 0)
  ) {
    return invalidBatchAck(batchLength, 'batch endpoint returned an invalid retry delay');
  }
  let acceptedItems = 0;
  let retainedItems = 0;
  let discardedItems = 0;
  let rejectedItems = 0;
  const retryItems = [];
  let sawRetryable = false;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (
      !item || typeof item !== 'object' || Array.isArray(item)
      || item.index !== index || typeof item.accepted !== 'boolean'
    ) {
      return invalidBatchAck(batchLength, 'batch endpoint returned malformed item acknowledgements');
    }
    if (item.accepted) {
      if (sawRetryable) {
        return invalidBatchAck(batchLength, 'batch endpoint retryable items are not a contiguous suffix');
      }
      acceptedItems++;
      if (item.disposition === undefined || item.disposition === 'retained') retainedItems++;
      else if (item.disposition === 'discarded') discardedItems++;
      else return invalidBatchAck(batchLength, 'batch endpoint returned an invalid accepted disposition');
    } else if (item.disposition === 'retryable') {
      if (item.reasonCode !== 'clickhouse_event_buffer_full') {
        return invalidBatchAck(batchLength, 'batch endpoint returned an unrecognized retry reason');
      }
      sawRetryable = true;
      retryItems.push(batch[index]);
    } else if (item.disposition === undefined || item.disposition === 'rejected') {
      if (sawRetryable) {
        return invalidBatchAck(batchLength, 'batch endpoint retryable items are not a contiguous suffix');
      }
      rejectedItems++;
    } else {
      return invalidBatchAck(batchLength, 'batch endpoint returned an invalid rejected disposition');
    }
  }
  if (
    acceptedItems !== acceptedEvents
    || rejectedItems !== rejectedEvents
    || retryItems.length !== retryableEvents
  ) {
    return invalidBatchAck(batchLength, 'batch endpoint acknowledgement counts do not match its items');
  }
  if (
    (ack.retainedEvents !== undefined && (!Number.isSafeInteger(ack.retainedEvents) || ack.retainedEvents !== retainedItems))
    || (ack.discardedEvents !== undefined && (!Number.isSafeInteger(ack.discardedEvents) || ack.discardedEvents !== discardedItems))
    || (ack.retainedEvents !== undefined && ack.discardedEvents !== undefined && ack.retainedEvents + ack.discardedEvents !== acceptedEvents)
  ) {
    return invalidBatchAck(batchLength, 'batch endpoint disposition counts do not match its items');
  }
  return {
    dropped: rejectedEvents,
    errors: rejectedEvents > 0 ? 1 : 0,
    retryItems,
    retryAfterMs: ack.retryAfterMs,
    reason: rejectedEvents > 0 ? `batch endpoint rejected ${rejectedEvents} event(s)` : '',
  };
}

/** POST one event batch with a bounded response body and an absolute wall-clock timeout. */
function postEventBatch(batch, timeoutMs, done) {
  if (eventRequestsAborted) {
    done({ error: new Error('event delivery stopped during shutdown') });
    return;
  }
  const isHttps = batchTarget.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (batchTarget.protocol !== 'http:' && batchTarget.protocol !== 'https:') {
    done({ error: new Error(`unsupported protocol ${batchTarget.protocol}`) });
    return;
  }
  let body;
  try {
    body = JSON.stringify({ events: batch.map((item) => item.body) });
  } catch (error) {
    done({ error: error instanceof Error ? error : new Error(String(error)) });
    return;
  }
  let settled = false;
  let absoluteTimer;
  let req;
  let response;
  const state = {
    abort(reason = 'event batch request aborted') {
      if (settled) return;
      response?.destroy();
      req?.destroy();
      finish({ error: new Error(reason), aborted: true });
    },
  };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (absoluteTimer) clearTimeout(absoluteTimer);
    activeEventRequests.delete(state);
    done(result);
  };
  req = transport.request(
    {
      hostname: batchTarget.hostname,
      port: batchTarget.port || (isHttps ? 443 : 80),
      path: `${batchTarget.pathname}${batchTarget.search}`,
      method: 'POST',
      agent: isHttps ? eventHttpsAgent : eventHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...sourceHeaders(),
      },
    },
    (res) => {
      response = res;
      const statusCode = res.statusCode || 0;
      if (statusCode === 413) {
        // The status alone proves that the batch was rejected before the controller accepted it.
        // Do not let a proxy's generated/trickled error body delay safe binary splitting.
        res.once('error', () => {});
        res.destroy();
        finish({ statusCode, responseBody: '' });
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        res.on('end', () => finish({ statusCode, responseBody: '' }));
        res.on('aborted', () => finish({ error: new Error('batch error response aborted'), statusCode }));
        res.on('error', (error) => finish({ error, statusCode }));
        res.on('close', () => {
          if (!res.complete) finish({ error: new Error('batch error response closed early'), statusCode });
        });
        return;
      }
      let responseBody = '';
      let responseBytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (settled) return;
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > BATCH_ACK_MAX_BYTES) {
          res.destroy();
          finish({ error: new Error(`batch acknowledgement exceeds ${BATCH_ACK_MAX_BYTES} bytes`), statusCode });
          return;
        }
        responseBody += chunk;
      });
      res.on('end', () => finish({ statusCode, responseBody }));
      res.on('aborted', () => finish({ error: new Error('batch acknowledgement aborted'), statusCode }));
      res.on('error', (error) => finish({ error, statusCode }));
      res.on('close', () => {
        if (!res.complete) finish({ error: new Error('batch acknowledgement closed early'), statusCode });
      });
    },
  );
  activeEventRequests.add(state);
  req.on('error', (error) => finish({ error }));
  absoluteTimer = setTimeout(
    () => state.abort(`event batch exceeded its ${timeoutMs} ms wall-clock timeout`),
    timeoutMs,
  );
  req.end(body);
}

function combineBatchOutcomes(left, right, extraErrors = 0) {
  return {
    dropped: left.dropped + right.dropped,
    errors: left.errors + right.errors + extraErrors,
    retryItems: [...(left.retryItems ?? []), ...(right.retryItems ?? [])],
    retryAfterMs: Math.max(left.retryAfterMs ?? 0, right.retryAfterMs ?? 0),
  };
}

/** A 413 is safe to retry because Express rejects the body before the controller processes it. */
function deliverEventBatch(batch, done, absoluteDeadline = 0) {
  if (eventRequestsAborted) {
    done({ dropped: batch.length, errors: batch.length > 0 ? 1 : 0, retryItems: [] });
    return;
  }
  const remainingMs = absoluteDeadline > 0 ? absoluteDeadline - Date.now() : HTTP_TIMEOUT_MS;
  if (remainingMs <= 0) {
    done({ dropped: batch.length, errors: batch.length > 0 ? 1 : 0, retryItems: [] });
    return;
  }
  postEventBatch(batch, Math.max(1, Math.min(HTTP_TIMEOUT_MS, remainingMs)), (result) => {
    // Once a 413 header is received the request was rejected for size, regardless of whether its
    // proxy-generated response body later truncates or aborts. Splitting remains safe and useful.
    if (result.statusCode === 413) {
      if (batch.length === 1) {
        done({ dropped: 1, errors: 1, retryItems: [] });
        return;
      }
      const middle = Math.ceil(batch.length / 2);
      const left = batch.slice(0, middle);
      const right = batch.slice(middle);
      deliverEventBatch(left, (leftOutcome) => {
        deliverEventBatch(right, (rightOutcome) => {
          done(combineBatchOutcomes(leftOutcome, rightOutcome, 1));
        }, absoluteDeadline);
      }, absoluteDeadline);
      return;
    }
    if (result.error) {
      done({ dropped: batch.length, errors: 1, retryItems: [] });
      return;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      done({ dropped: batch.length, errors: 1, retryItems: [] });
      return;
    }
    let parsed;
    try {
      parsed = result.responseBody ? JSON.parse(result.responseBody) : undefined;
    } catch {
      done({ dropped: batch.length, errors: 1, retryItems: [] });
      return;
    }
    const outcome = validateBatchAck(parsed, batch);
    if (outcome.reason) console.error(`[observer-forward] ${outcome.reason}`);
    done(outcome);
  });
}

function abortActiveEventRequests(reason) {
  eventRequestsAborted = true;
  for (const state of [...activeEventRequests]) state.abort(reason);
}

function abortActiveControlRequests(reason) {
  for (const state of [...activeControlRequests]) state.abort(reason);
}

/**
 * POST a bounded JSON control-plane request and parse its business acknowledgement.
 */
function postJsonResponse(url, bodyObj, timeoutMs, done) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const error = new Error(`unsupported protocol ${url.protocol}`);
    error.retriable = false;
    done(error);
    return;
  }
  const body = JSON.stringify(bodyObj);
  let settled = false;
  let absoluteTimer;
  let req;
  let response;
  let abortReason = '';
  const state = {
    abort(reason = 'control endpoint request aborted') {
      if (settled) return;
      abortReason = reason;
      response?.destroy();
      req?.destroy();
      finish(new Error(reason));
    },
  };
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    if (absoluteTimer) clearTimeout(absoluteTimer);
    activeControlRequests.delete(state);
    done(abortReason ? new Error(abortReason) : error, value);
  };
  req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      agent: isHttps ? controlHttpsAgent : controlHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...sourceHeaders(),
      },
    },
    (res) => {
      response = res;
      let data = '';
      let oversized = false;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (oversized) return;
        if (Buffer.byteLength(data) + Buffer.byteLength(chunk) > 64 * 1024) {
          oversized = true;
          data = '';
          return;
        }
        data += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          const error = new Error(`control endpoint returned ${res.statusCode}`);
          error.statusCode = res.statusCode;
          finish(error);
          return;
        }
        if (oversized) {
          const error = new Error('control endpoint response exceeds 64 KiB');
          error.retriable = false;
          finish(error);
          return;
        }
        try {
          const parsed = data ? JSON.parse(data) : undefined;
          finish(undefined, parsed?.data ?? parsed);
        } catch {
          const error = new Error('control endpoint returned invalid JSON');
          error.retriable = false;
          finish(error);
        }
      });
      res.on('aborted', () => finish(new Error('control endpoint response aborted')));
      res.on('error', (error) => finish(error));
      res.on('close', () => {
        if (!res.complete) finish(new Error('control endpoint response closed early'));
      });
    },
  );
  activeControlRequests.add(state);
  req.on('error', (error) => finish(error));
  absoluteTimer = setTimeout(() => {
    state.abort('control endpoint request timed out');
  }, timeoutMs);
  req.end(body);
  return state;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(url, timeoutMs, done) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    done(new Error(`unsupported protocol ${url.protocol}`));
    return;
  }
  let settled = false;
  let absoluteTimer;
  let req;
  let response;
  let abortReason = '';
  const state = {
    abort(reason = 'identity snapshot request aborted') {
      if (settled) return;
      abortReason = reason;
      response?.destroy();
      req?.destroy();
      finish(new Error(reason));
    },
  };
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    if (absoluteTimer) clearTimeout(absoluteTimer);
    activeControlRequests.delete(state);
    done(abortReason ? new Error(abortReason) : error, value);
  };
  req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: isHttps ? controlHttpsAgent : controlHttpAgent,
      headers: sourceHeaders(),
    },
    (res) => {
      response = res;
      let data = '';
      let responseBytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (settled) return;
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > IDENTITY_SNAPSHOT_MAX_BYTES) {
          res.destroy();
          finish(new Error(`identity snapshot response exceeds ${IDENTITY_SNAPSHOT_MAX_BYTES} bytes`));
          return;
        }
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
      res.on('aborted', () => finish(new Error('identity snapshot response aborted')));
      res.on('error', (error) => finish(error));
      res.on('close', () => {
        if (!res.complete) finish(new Error('identity snapshot response closed early'));
      });
    },
  );
  activeControlRequests.add(state);
  req.on('error', (error) => finish(error));
  absoluteTimer = setTimeout(() => {
    state.abort('identity snapshot timeout');
  }, timeoutMs);
  req.end();
  return state;
}

function refreshIdentitySnapshot() {
  getJson(identitySnapshotTarget, 5000, (error, snapshot) => {
    if (closing && error?.message === GRACEFUL_SHUTDOWN_SUPERSEDE) return;
    if (error || !workloadCache.replace(snapshot)) {
      if (error) workloadCache.errors++;
    }
  });
}

function runtimeLeaseRequest() {
  return new Promise((resolve) => {
    runtimeLeaseAttempts++;
    const processIdentity = observerForwarderProcessIdentity();
    postJsonResponse(
      runtimeLeaseTarget,
      {
        collectorId: COLLECTOR_ID || NODE_NAME || 'observer-forwarder',
        forwarderInstanceId,
        hostId: attributor.hostId,
        bootId: attributor.bootId,
        forwarderPid: processIdentity.pid,
        forwarderStartTimeTicks: processIdentity.startTimeTicks,
      },
      5_000,
      (error, ack) => {
        if (error) {
          resolve({ ok: false, reason: error.message, transient: true });
          return;
        }
        const epoch = Number(ack?.leaseEpoch);
        if (ack?.accepted !== true || !Number.isSafeInteger(epoch) || epoch < 1) {
          resolve({
            ok: false,
            reason: typeof ack?.reason === 'string' && ack.reason.trim()
              ? ack.reason.trim().slice(0, 500)
              : 'runtime lease rejected',
            reasonCode: typeof ack?.reasonCode === 'string' ? ack.reasonCode : '',
            transient: false,
          });
          return;
        }
        runtimeLeaseEpoch = epoch;
        runtimeLeaseFenced = false;
        lastRuntimeSnapshotError = '';
        resolve({ ok: true });
      },
    );
  });
}

async function acquireRuntimeLease(maxAttempts = 1) {
  if (runtimeLeaseFenced) return false;
  if (Number.isSafeInteger(runtimeLeaseEpoch) && runtimeLeaseEpoch > 0) return true;
  if (runtimeLeasePromise) return runtimeLeasePromise;
  runtimeLeasePromise = (async () => {
    const attempts = Math.max(1, Math.min(3, Number(maxAttempts) || 1));
    for (let attempt = 0; attempt < attempts && !closing; attempt += 1) {
      const result = await runtimeLeaseRequest();
      if (result.ok) return true;
      if (closing && result.reason === GRACEFUL_SHUTDOWN_SUPERSEDE) return false;
      runtimeLeaseErrors++;
      errorCount++;
      lastRuntimeSnapshotError = result.reason;
      console.error(`[observer-forward] Agent runtime lease unavailable: ${result.reason}`);
      if (['lease_epoch_stale', 'lease_owner_mismatch', 'stale_forwarder'].includes(result.reasonCode)) {
        // A server fencing decision is final for this process instance. Retrying the same
        // identity every snapshot interval would create a control-plane retry loop and could
        // contend with the replacement that already owns the collector.
        runtimeLeaseFenced = true;
        runtimeLeaseEpoch = undefined;
        return false;
      }
      // `collector_conflict` is intentionally retryable on the next snapshot interval: a new
      // host/boot is allowed to take over after the old lease TTL. It must not consume the
      // immediate startup retry budget while the old lease is still fresh.
      if (!result.transient || attempt + 1 >= attempts) return false;
      await delay(250 * (2 ** attempt));
    }
    return false;
  })();
  try {
    return await runtimeLeasePromise;
  } finally {
    runtimeLeasePromise = undefined;
  }
}

function runtimeSnapshotBody(ready = true) {
  runtimeSnapshotVersion += 1;
  return {
    ...attributor.runtimeSnapshot(),
    collectorId: COLLECTOR_ID || NODE_NAME || 'observer-forwarder',
    forwarderInstanceId,
    leaseEpoch: runtimeLeaseEpoch,
    snapshotVersion: runtimeSnapshotVersion,
    ready,
    intervalSecs: RUNTIME_SNAPSHOT_SECS,
    filterMode: FILTER_MODE,
  };
}

function sendRuntimeSnapshot(ready = true, done = () => {}, timeoutMs = 5_000) {
  if (runtimeLeaseFenced) {
    done(true);
    return;
  }
  if (runtimeSnapshotInFlight) {
    done(false);
    return;
  }
  const operation = ++runtimeSnapshotOperation;
  runtimeSnapshotInFlight = true;
  const finish = (failed) => {
    if (operation === runtimeSnapshotOperation) runtimeSnapshotInFlight = false;
    done(Boolean(failed));
  };
  void (async () => {
    if (!Number.isSafeInteger(runtimeLeaseEpoch) || runtimeLeaseEpoch < 1) {
      if (closing || !(await acquireRuntimeLease(1))) {
        finish(true);
        return;
      }
    }
    if (operation !== runtimeSnapshotOperation) {
      finish(true);
      return;
    }
    const body = runtimeSnapshotBody(ready);
    const deadline = Date.now() + Math.max(100, timeoutMs);
    const maxAttempts = 2;
    const postSnapshot = (attempt, retryReason = '') => {
      if (operation !== runtimeSnapshotOperation) {
        finish(true);
        return;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const reason = retryReason || lastRuntimeSnapshotRetryReason || 'runtime snapshot retry deadline exceeded';
        runtimeSnapshotErrors++;
        errorCount++;
        lastRuntimeSnapshotError = reason;
        recordRuntimeSnapshotFailure(reason, body.snapshotVersion);
        finish(true);
        return;
      }
      const attemptsLeft = maxAttempts - attempt + 1;
      const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / attemptsLeft));
      if (attempt > 1) {
        runtimeSnapshotRetries++;
        lastRuntimeSnapshotRetryAt = new Date().toISOString();
        lastRuntimeSnapshotRetryReason = retryReason.slice(0, 500);
      }
      runtimeSnapshotPosts++;
      postJsonResponse(runtimeSnapshotTarget, body, attemptTimeoutMs, (error, ack) => {
        if (operation !== runtimeSnapshotOperation) {
          finish(true);
          return;
        }
        if (
          error &&
          retryableRuntimeSnapshotError(error) &&
          attempt < maxAttempts &&
          Date.now() + 150 < deadline
        ) {
          setTimeout(() => postSnapshot(attempt + 1, error.message), 100);
          return;
        }
        if (error) {
          runtimeSnapshotErrors++;
          errorCount++;
          lastRuntimeSnapshotError = error.message;
          recordRuntimeSnapshotFailure(error.message, body.snapshotVersion);
          finish(true);
          return;
        }
        if (ack?.accepted !== true || (ack?.applied !== true && ack?.duplicate !== true)) {
          const reason = typeof ack?.reason === 'string' && ack.reason.trim()
            ? ack.reason.trim().slice(0, 500)
            : 'runtime snapshot rejected';
          const reasonCode = typeof ack?.reasonCode === 'string' ? ack.reasonCode : '';
          runtimeSnapshotRejected++;
          runtimeSnapshotErrors++;
          errorCount++;
          lastRuntimeSnapshotError = reason;
          recordRuntimeSnapshotFailure(reason, body.snapshotVersion);
          if (reasonCode === 'lease_not_found') {
            // The API may have restarted and lost its in-memory lease table. A fresh server-issued
            // epoch is safe; retry on the next bounded snapshot cycle.
            runtimeLeaseEpoch = undefined;
          } else if (
            ['lease_epoch_stale', 'lease_owner_mismatch', 'stale_forwarder', 'collector_conflict'].includes(reasonCode)
            || /\b(?:fenced|superseded)\b/iu.test(reason)
          ) {
            // A fenced process must never automatically acquire a newer epoch and steal ownership
            // back from its replacement. Event forwarding remains available until normal shutdown.
            runtimeLeaseFenced = true;
            runtimeLeaseEpoch = undefined;
          }
          finish(true);
          return;
        }
        if (ack.duplicate === true) runtimeSnapshotDuplicates++;
        if (attempt > 1) runtimeSnapshotRecovered++;
        lastRuntimeSnapshotAt = new Date().toISOString();
        lastRuntimeSnapshotError = '';
        finish(false);
      });
    };
    postSnapshot(1);
  })().catch((error) => {
    if (operation !== runtimeSnapshotOperation) {
      finish(true);
      return;
    }
    runtimeSnapshotErrors++;
    errorCount++;
    lastRuntimeSnapshotError = error instanceof Error ? error.message : String(error);
    recordRuntimeSnapshotFailure(lastRuntimeSnapshotError);
    finish(true);
  });
}

async function runReconciliation() {
  if (closing || reconcileRunning) {
    reconcilePending = true;
    reconciliationMetrics.coalesced++;
    return;
  }
  reconcileRunning = true;
  reconcileTimer = undefined;
  const startedAt = Date.now();
  try {
    const result = await attributor.reconcileFromProcBatched({ invalidateSignatures: true });
    reconciliationMetrics.runs++;
    reconciliationMetrics.scanned = result.scanned;
    reconciliationMetrics.roots = result.roots;
    reconciliationMetrics.invalidated = result.invalidated;
    reconciliationMetrics.lastDurationMs = Date.now() - startedAt;
    console.error(
      `[observer-forward] Agent runtime reconciliation: scanned=${result.scanned}; ` +
      `roots=${result.roots}; invalidated=${result.invalidated}; ` +
      `duration_ms=${reconciliationMetrics.lastDurationMs}`,
    );
  } catch (error) {
    reconciliationMetrics.errors++;
    console.error(`[observer-forward] Agent runtime reconciliation failed: ${error.message}`);
  } finally {
    reconcileRunning = false;
    reconcileRequestedAt = Date.now();
    if (reconcilePending && !closing) {
      reconcilePending = false;
      requestReconciliation();
    }
  }
}

function requestReconciliation() {
  reconciliationMetrics.requested++;
  if (closing || reconcileTimer || reconcileRunning) {
    reconcilePending = true;
    reconciliationMetrics.coalesced++;
    return;
  }
  const delay = Math.max(0, reconcileRequestedAt + RECONCILE_MIN_INTERVAL_MS - Date.now());
  reconcileTimer = setTimeout(() => void runReconciliation(), delay);
  reconcileTimer.unref();
}

function eventQueueMetrics(now = Date.now()) {
  let retryQueueDepth = 0;
  let retryQueueBytes = 0;
  let outstandingOldestAt = now;
  let retryOldestAt = now;
  let inflightOldestAt = now;
  for (const task of retryTasks) {
    retryQueueDepth += task.items.length;
    retryQueueBytes += itemsBytes(task.items);
  }
  for (const item of outstandingItems) {
    outstandingOldestAt = Math.min(outstandingOldestAt, item.createdAt || now);
    if (item.retryOwned) retryOldestAt = Math.min(retryOldestAt, item.retryStartedAt || now);
    if (item.inflightSince) inflightOldestAt = Math.min(inflightOldestAt, item.inflightSince);
  }
  return {
    queueDepth: pending.length,
    queueBytes: pending.totalWeight,
    inflightEvents,
    inflightBytes,
    inflightOldestAgeMs: inflightEvents > 0 ? Math.max(0, now - inflightOldestAt) : 0,
    retryQueueDepth,
    retryQueueBytes,
    retryOutstandingEvents,
    retryOutstandingBytes,
    retryOldestAgeMs: retryOutstandingEvents > 0 ? Math.max(0, now - retryOldestAt) : 0,
    outstandingEvents,
    outstandingBytes,
    outstandingOldestAgeMs: outstandingEvents > 0 ? Math.max(0, now - outstandingOldestAt) : 0,
    outstandingEventLimit: MAX_OUTSTANDING_EVENTS,
    outstandingByteLimit: MAX_OUTSTANDING_BYTES,
  };
}

function sendHeartbeat(done = () => {}, timeoutMs = 5_000, shutdownFinal = false) {
  if (!HEARTBEAT_SECS) {
    done(false);
    return;
  }
  const counts = eventKindCounts;
  const dropped = outputDropped;
  const errors = errorCount;
  const classifications = attributionCounts;
  const filterReceipts = e2eFilterReceipts;
  const workload = workloadCache.metrics();
  const docker = dockerDiscovery.metrics();
  const behavior = behaviorDetector.metrics();
  const templates = templateRegistry.metrics();
  const processes = attributor.metrics();
  const signatures = processes.runtimeSignatures || {};
  const reloader = signatureReloader?.metrics() || {};
  const eventQueues = eventQueueMetrics();
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
    e2eMarkerScopedOut: 0,
    forwarded: 0,
    queueDropped: 0,
    batches: 0,
    batchEvents: 0,
    retryQueued: 0,
    retryAttempts: 0,
    retryRecovered: 0,
    retryExhausted: 0,
    workspaceConflict: 0,
    infrastructure: 0,
    deduplicated: 0,
  };
  e2eFilterReceipts = [];
  outputDropped = 0;
  errorCount = 0;
  const status = dropped > 0 || errors > 0 ? 'degraded' : 'ok';
  const e2eMarkerScopeMessage = E2E_INGEST_MARKER_PREFIX
    ? `e2e_marker_scope=enabled; e2e_marker_scoped_out=${classifications.e2eMarkerScopedOut}; `
    : '';
  postJson(
    heartbeatTarget,
    {
      collectorId: COLLECTOR_ID || undefined,
      nodeName: NODE_NAME || undefined,
      mode: `observer-forwarder:${FILTER_MODE}`,
      status,
      intervalSecs: HEARTBEAT_SECS,
      eventKindCounts: counts,
      queueDepth: eventQueues.queueDepth,
      outputDropped: dropped,
      errorCount: errors,
      filterMetrics: {
        scope: LEGACY_FORWARD_SCOPE ?? 'decoupled',
        // A periodic heartbeat can race with shutdown. Mark only the heartbeat emitted after the
        // final runtime snapshot and bounded event drain so lifecycle checks cannot accept an
        // ordinary interval heartbeat as shutdown evidence.
        shutdownFinal,
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
        ...(filterReceipts.length ? { e2eFilterReceipts: filterReceipts } : {}),
        deduplicated: classifications.deduplicated,
        queueDropped: classifications.queueDropped,
        batches: classifications.batches,
        batchEvents: classifications.batchEvents,
        retryQueued: classifications.retryQueued,
        retryAttempts: classifications.retryAttempts,
        retryRecovered: classifications.retryRecovered,
        retryExhausted: classifications.retryExhausted,
        queueBytes: eventQueues.queueBytes,
        inflightEvents: eventQueues.inflightEvents,
        inflightBytes: eventQueues.inflightBytes,
        inflightOldestAgeMs: eventQueues.inflightOldestAgeMs,
        retryQueueDepth: eventQueues.retryQueueDepth,
        retryQueueBytes: eventQueues.retryQueueBytes,
        retryOutstandingEvents: eventQueues.retryOutstandingEvents,
        retryOutstandingBytes: eventQueues.retryOutstandingBytes,
        retryOldestAgeMs: eventQueues.retryOldestAgeMs,
        outstandingEvents: eventQueues.outstandingEvents,
        outstandingBytes: eventQueues.outstandingBytes,
        outstandingOldestAgeMs: eventQueues.outstandingOldestAgeMs,
        outstandingEventLimit: eventQueues.outstandingEventLimit,
        outstandingByteLimit: eventQueues.outstandingByteLimit,
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
        processRootsDiscovered: processes.rootsDiscovered,
        processRootsExited: processes.rootsExited,
        processRootsLost: processes.rootsLost,
        processRootsRecovered: processes.rootsRecovered,
        processRootLivenessChecks: processes.rootLivenessChecks,
        processRootLivenessMisses: processes.rootLivenessMisses,
        processStaleGenerationMisses: processes.staleGenerationMisses,
        runtimeSignatureVersion: signatures.version,
        runtimeSignatureHash: signatures.hash,
        runtimeSignatureMatcherHash: signatures.matcherHash,
        runtimeSignatureLoaded: signatures.loaded,
        runtimeSignatureMatches: signatures.matches,
        runtimeSignatureMisses: signatures.misses,
        runtimeSignatureAmbiguous: signatures.ambiguous,
        runtimeSignatureInvalid: (signatures.invalid || 0) + signatureInitialLoadErrors,
        runtimeSignatureReloadAttempts: reloader.reloadAttempts || 0,
        runtimeSignatureReloadSuccesses: reloader.reloadSuccesses || 0,
        runtimeSignatureReloadErrors: reloader.reloadErrors || 0,
        runtimeSignatureLastGoodHash: reloader.lastGoodRawHash,
        runtimeReconcileRequested: reconciliationMetrics.requested,
        runtimeReconcileRuns: reconciliationMetrics.runs,
        runtimeReconcileCoalesced: reconciliationMetrics.coalesced,
        runtimeReconcileErrors: reconciliationMetrics.errors,
        runtimeReconcileScanned: reconciliationMetrics.scanned,
        runtimeReconcileInvalidated: reconciliationMetrics.invalidated,
        runtimeReconcileLastDurationMs: reconciliationMetrics.lastDurationMs,
        runtimeSnapshotPosts,
        runtimeSnapshotErrors,
        runtimeSnapshotRejected,
        runtimeSnapshotDuplicates,
        runtimeSnapshotRetries,
        runtimeSnapshotRecovered,
        lastRuntimeSnapshotAt: lastRuntimeSnapshotAt || undefined,
        lastRuntimeSnapshotError: lastRuntimeSnapshotError || undefined,
        lastRuntimeSnapshotRetryAt: lastRuntimeSnapshotRetryAt || undefined,
        lastRuntimeSnapshotRetryReason: lastRuntimeSnapshotRetryReason || undefined,
        lastRuntimeSnapshotFailureAt: lastRuntimeSnapshotFailureAt || undefined,
        lastRuntimeSnapshotFailure: lastRuntimeSnapshotFailure || undefined,
        lastRuntimeSnapshotFailureVersion: lastRuntimeSnapshotFailureVersion || undefined,
        runtimeLeaseEpoch,
        runtimeLeaseAttempts,
        runtimeLeaseErrors,
        runtimeLeaseFenced,
        infrastructure: classifications.infrastructure,
        workspaceConflict: classifications.workspaceConflict,
      },
      message: `filter_mode=${FILTER_MODE}; ${e2eMarkerScopeMessage}retain_unknown=${RETAIN_UNKNOWN}; retain_non_agent=${RETAIN_NON_AGENT}; noise_policy=${NOISE_POLICY}; observed=${classifications.observed}; forwarded=${classifications.forwarded}; confirmed_agent=${classifications.confirmedAgent}; probable_agent=${classifications.probableAgent}; unknown=${classifications.unknown}; non_agent=${classifications.nonAgent}; infrastructure=${classifications.infrastructure}; workspace_conflict=${classifications.workspaceConflict}; filtered_non_agent=${classifications.filteredNonAgent}; would_filter_non_agent=${classifications.wouldFilterNonAgent}; filtered_noise=${classifications.filteredNoise}; would_filter_noise=${classifications.wouldFilterNoise}; discovery_budget_dropped=${classifications.discoveryBudgetDropped}; would_discovery_budget_drop=${classifications.wouldDiscoveryBudgetDrop}; deduplicated=${classifications.deduplicated}; queue_dropped=${classifications.queueDropped}; batches=${classifications.batches}; batch_events=${classifications.batchEvents}; retry_queued=${classifications.retryQueued}; retry_attempts=${classifications.retryAttempts}; retry_recovered=${classifications.retryRecovered}; retry_exhausted=${classifications.retryExhausted}; retry_queue_depth=${eventQueues.retryQueueDepth}; retry_outstanding=${eventQueues.retryOutstandingEvents}; outstanding_events=${eventQueues.outstandingEvents}; outstanding_bytes=${eventQueues.outstandingBytes}; identity_snapshot_ready=${workload.ready}; identity_snapshot_version=${workload.version}; identity_snapshot_age_seconds=${workload.ageSeconds}; identity_cache_entries=${workload.entries}; identity_cache_hits=${workload.hits}; identity_cache_misses=${workload.misses}; identity_cgroup_hits=${workload.cgroupHits}; identity_cgroup_misses=${workload.cgroupMisses}; process_cache_hits=${processes.cacheHits}; process_cache_misses=${processes.cacheMisses}; process_proc_reads=${processes.procReads}; process_bootstrap_proc_reads=${processes.bootstrapProcReads}; process_fallback_proc_reads=${processes.fallbackProcReads}; process_ancestry_proc_reads=${processes.ancestryProcReads}; identity_errors=${workload.errors}; docker_enabled=${docker.enabled}; docker_ready=${docker.ready}; docker_entries=${docker.entries}; docker_reconnects=${docker.reconnects}; docker_errors=${docker.errors}; behavior_workloads=${behavior.workloads}; behavior_candidates=${behavior.candidates}; behavior_promoted=${behavior.promoted}; behavior_evicted=${behavior.evicted}; output_drops=${dropped}; errors=${errors}`,
      ...sourceFields(),
    },
    timeoutMs,
    (failed, reason) => {
      const intentionallySuperseded = !shutdownFinal
        && closing
        && reason === GRACEFUL_SHUTDOWN_SUPERSEDE;
      if (failed && !intentionallySuperseded) {
        outputDropped++;
        errorCount++;
      }
      done(Boolean(failed));
    },
  );
}

function closeTransports() {
  if (transportsClosed) return;
  transportsClosed = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = undefined;
  signatureReloader?.close();
  dockerDiscovery.stop();
  infrastructureResolver.close();
  abortActiveEventRequests('event transport closed');
  abortActiveControlRequests('control transport closed');
  eventHttpAgent.destroy();
  eventHttpsAgent.destroy();
  controlHttpAgent.destroy();
  controlHttpsAgent.destroy();
  if (shutdownForceTimer) clearTimeout(shutdownForceTimer);
  shutdownForceTimer = undefined;
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

function itemsBytes(items) {
  return items.reduce((sum, item) => sum + item.bytes, 0);
}

function trackOutstanding(item) {
  item.settled = false;
  outstandingItems.add(item);
  outstandingEvents++;
  outstandingBytes += item.bytes;
}

function settleOutstanding(items) {
  let settled = 0;
  let bytes = 0;
  let retrySettled = 0;
  let retryBytes = 0;
  for (const item of items) {
    if (item.settled) continue;
    item.settled = true;
    item.inflightSince = 0;
    outstandingItems.delete(item);
    settled++;
    bytes += item.bytes;
    if (item.retryOwned) {
      retrySettled++;
      retryBytes += item.bytes;
    }
  }
  outstandingEvents = Math.max(0, outstandingEvents - settled);
  outstandingBytes = Math.max(0, outstandingBytes - bytes);
  retryOutstandingEvents = Math.max(0, retryOutstandingEvents - retrySettled);
  retryOutstandingBytes = Math.max(0, retryOutstandingBytes - retryBytes);
  return settled;
}

function markRetryOwned(items) {
  const now = Date.now();
  for (const item of items) {
    if (item.retryOwned || item.settled) continue;
    item.retryOwned = true;
    item.retryStartedAt = now;
    item.retryDeadlineAt = now + RETRY_MAX_AGE_MS;
    retryOutstandingEvents++;
    retryOutstandingBytes += item.bytes;
    attributionCounts.retryQueued++;
  }
}

function recordRetryExhausted(items, operationalError = true) {
  const count = settleOutstanding(items);
  if (!count) return;
  attributionCounts.retryExhausted += count;
  outputDropped += count;
  if (operationalError) errorCount++;
}

function retryDelayMs(item, retryAfterMs) {
  const nextAttempt = Math.max(1, (item.retryAttempt ?? 0) + 1);
  const exponent = Math.min(30, nextAttempt - 1);
  const nominal = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** exponent));
  // Downward-only jitter keeps RETRY_MAX_DELAY_MS a hard bound. A server-provided retryAfterMs is
  // honored as a minimum (also bounded locally), so the API can protect a still-full write queue.
  const jittered = Math.max(1, Math.ceil(nominal * (1 - Math.random() * RETRY_JITTER_RATIO)));
  const serverDelay = Number.isSafeInteger(retryAfterMs)
    ? Math.min(RETRY_MAX_DELAY_MS, Math.max(0, retryAfterMs))
    : 0;
  return Math.max(jittered, serverDelay);
}

function scheduleRetryWakeup() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (eventRequestsAborted || retryTasks.length === 0 || inflight >= MAX_INFLIGHT) return;
  const delayMs = Math.max(0, retryTasks[0].dueAt - Date.now());
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    pumpEventWork();
  }, delayMs);
}

function scheduleRetryItems(items, retryAfterMs) {
  if (!items.length) return;
  markRetryOwned(items);
  if (eventRequestsAborted) {
    recordRetryExhausted(items);
    return;
  }
  const now = Date.now();
  const expired = items.filter((item) => now >= item.retryDeadlineAt);
  const eligible = items.filter((item) => now < item.retryDeadlineAt);
  if (expired.length) recordRetryExhausted(expired);
  if (!eligible.length) return;
  const delayMs = retryDelayMs(eligible[0], retryAfterMs);
  const expiresAt = Math.min(...eligible.map((item) => item.retryDeadlineAt));
  retryTasks.push({
    items: eligible,
    dueAt: Math.min(now + delayMs, expiresAt),
  });
  retryTasks.sort((left, right) => left.dueAt - right.dueAt);
  scheduleRetryWakeup();
}

function takeReadyRetryBatch(now = Date.now()) {
  while (retryTasks.length > 0 && retryTasks[0].dueAt <= now) {
    const task = retryTasks.shift();
    const expired = task.items.filter((item) => now >= item.retryDeadlineAt);
    const eligible = task.items.filter((item) => now < item.retryDeadlineAt);
    if (expired.length) recordRetryExhausted(expired);
    if (eligible.length) return eligible;
  }
  return undefined;
}

function finishBatch(batch, outcome, retryDelivery) {
  outputDropped += outcome.dropped;
  errorCount += outcome.errors;
  inflight = Math.max(0, inflight - 1);
  inflightEvents = Math.max(0, inflightEvents - batch.length);
  inflightBytes = Math.max(0, inflightBytes - itemsBytes(batch));
  for (const item of batch) item.inflightSince = 0;

  const retryItems = outcome.retryItems ?? [];
  const retrySet = new Set(retryItems);
  const terminalItems = batch.filter((item) => !retrySet.has(item));
  if (retryDelivery) {
    const exhausted = Math.min(terminalItems.length, outcome.dropped);
    const recovered = Math.max(0, terminalItems.length - exhausted);
    attributionCounts.retryExhausted += exhausted;
    attributionCounts.retryRecovered += recovered;
  }
  settleOutstanding(terminalItems);
  scheduleRetryItems(retryItems, outcome.retryAfterMs);
  pumpEventWork();
  updateInputFlow();
}

function dispatchEventBatch(batch, retryDelivery) {
  if (!batch.length) return;
  inflight++;
  inflightEvents += batch.length;
  inflightBytes += itemsBytes(batch);
  const dispatchedAt = Date.now();
  for (const item of batch) item.inflightSince = dispatchedAt;
  if (retryDelivery) {
    for (const item of batch) item.retryAttempt = (item.retryAttempt ?? 0) + 1;
    attributionCounts.retryAttempts += batch.length;
  } else {
    attributionCounts.batches++;
    attributionCounts.batchEvents += batch.length;
  }
  let settled = false;
  const absoluteDeadline = retryDelivery
    ? Math.min(...batch.map((item) => item.retryDeadlineAt))
    : 0;
  deliverEventBatch(batch, (outcome) => {
    if (settled) return;
    settled = true;
    finishBatch(batch, outcome, retryDelivery);
  }, absoluteDeadline);
}

function takePendingBatch() {
  if (pending.length === 0) return [];
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = undefined;
  }
  const adaptiveBatchSize =
    pending.length >= BATCH_SIZE * 8
      ? Math.min(256, BATCH_SIZE * 4)
      : pending.length >= BATCH_SIZE * 2
        ? Math.min(256, BATCH_SIZE * 2)
        : BATCH_SIZE;
  return pending.takeWeighted(adaptiveBatchSize, BATCH_MAX_BYTES, (item) => item.bytes);
}

function pumpEventWork() {
  if (eventRequestsAborted) return;
  while (inflight < MAX_INFLIGHT) {
    const retryBatch = takeReadyRetryBatch();
    if (retryBatch?.length) {
      dispatchEventBatch(retryBatch, true);
      continue;
    }
    if (pending.length === 0) break;
    dispatchEventBatch(takePendingBatch(), false);
  }
  scheduleRetryWakeup();
  // Expiring a scheduled retry can release the unified outstanding cap without an HTTP callback.
  // Re-evaluate stdin here as well as in finishBatch so that path cannot leave readline paused.
  updateInputFlow();
}

function flushPending() {
  if (eventRequestsAborted) return;
  pumpEventWork();
}

function dropQueuedItem(item) {
  if (!item) return;
  settleOutstanding([item]);
  outputDropped++;
  attributionCounts.queueDropped++;
}

function makeQueueRoom(bytes, priority) {
  const exceedsOutstanding = () => (
    outstandingEvents + 1 > MAX_OUTSTANDING_EVENTS
    || outstandingBytes + bytes > MAX_OUTSTANDING_BYTES
  );
  while (exceedsOutstanding()) {
    const lowest = pending.lowestPriority();
    if (lowest < 0 || priority <= lowest) return false;
    dropQueuedItem(pending.dropLowest());
  }
  return true;
}

function inputAtCapacity() {
  return (
    outstandingEvents >= MAX_OUTSTANDING_EVENTS
    || outstandingBytes >= MAX_OUTSTANDING_BYTES
  );
}

function updateInputFlow() {
  if (!rl || closing) return;
  if (inputAtCapacity()) rl.pause();
  else rl.resume();
}

function enqueue(body, priority, countForwarded = true) {
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body));
  } catch {
    outputDropped++;
    attributionCounts.queueDropped++;
    return;
  }
  if (bytes > MAX_EVENT_BYTES) {
    outputDropped++;
    attributionCounts.queueDropped++;
    return;
  }
  if (!makeQueueRoom(bytes, priority)) {
    outputDropped++;
    attributionCounts.queueDropped++;
    return;
  }
  const item = {
    body,
    priority,
    bytes,
    createdAt: Date.now(),
    retryAttempt: 0,
    retryOwned: false,
    retryStartedAt: 0,
    retryDeadlineAt: 0,
    inflightSince: 0,
    settled: false,
  };
  const result = pending.push(item, priority);
  if (!result.accepted) {
    outputDropped++;
    attributionCounts.queueDropped++;
    return;
  }
  if (result.dropped && !result.droppedIncoming) {
    dropQueuedItem(result.dropped);
  }
  trackOutstanding(item);
  if (countForwarded) attributionCounts.forwarded++;
  if (pending.length >= BATCH_SIZE) flushPending();
  else scheduleBatch();
  updateInputFlow();
}

function abandonPendingEvents() {
  if (pending.length === 0) return;
  while (pending.length > 0) dropQueuedItem(pending.dropLowest());
}

function abandonRetryEvents() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (retryTasks.length === 0) return;
  const abandoned = retryTasks.splice(0).flatMap((task) => task.items);
  recordRetryExhausted(abandoned);
}

function remainingShutdownMs() {
  return Math.max(100, shutdownDeadline - Date.now());
}

function finishShutdownControlPlane() {
  if (shutdownFinalizing || transportsClosed) return;
  shutdownFinalizing = true;
  // A periodic snapshot or another control request may be holding every control socket. Invalidate
  // the old snapshot callback and settle all old control requests before publishing the final,
  // higher-version snapshot. The shutdown force timer remains the outer wall-clock deadline.
  runtimeSnapshotOperation += 1;
  runtimeSnapshotInFlight = false;
  abortActiveControlRequests(GRACEFUL_SHUTDOWN_SUPERSEDE);
  const snapshotTimeout = Math.min(5_000, Math.max(100, Math.floor(remainingShutdownMs() / 2)));
  // The API derives `unobserved` when this forwarder stops reporting. A ready snapshot is
  // intentionally monotonic, so do not attempt to regress it during graceful shutdown.
  sendRuntimeSnapshot(true, () => {
    const heartbeatTimeout = Math.min(5_000, remainingShutdownMs());
    sendHeartbeat(() => closeTransports(), heartbeatTimeout, true);
  }, snapshotTimeout);
}

function forceShutdown() {
  abortActiveEventRequests('forwarder shutdown deadline exceeded');
  abandonPendingEvents();
  abandonRetryEvents();
  closeTransports();
  process.exit(process.exitCode ?? 0);
}

function flushAndClose() {
  if (closing) return;
  closing = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (identitySnapshotTimer) clearInterval(identitySnapshotTimer);
  if (runtimeSnapshotTimer) clearInterval(runtimeSnapshotTimer);
  if (rootLivenessTimer) clearInterval(rootLivenessTimer);
  if (reconcileTimer) clearTimeout(reconcileTimer);
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = undefined;
  shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  shutdownForceTimer = setTimeout(forceShutdown, SHUTDOWN_TIMEOUT_MS);
  const controlReserveMs = Math.min(5_000, Math.max(1_000, Math.floor(SHUTDOWN_TIMEOUT_MS / 3)));
  eventDrainDeadline = shutdownDeadline - controlReserveMs;
  pumpEventWork();
  const waitForInflight = () => {
    pumpEventWork();
    const hasEventWork = inflight > 0 || pending.length > 0 || retryTasks.length > 0;
    if (hasEventWork && Date.now() < eventDrainDeadline) {
      setTimeout(waitForInflight, 50);
      return;
    }
    if (hasEventWork) {
      abortActiveEventRequests('forwarder event drain deadline exceeded');
      abandonPendingEvents();
      abandonRetryEvents();
    }
    finishShutdownControlPlane();
  };
  waitForInflight();
}

function handleShutdownSignal(signal) {
  if (closing) {
    forceShutdown();
    return;
  }
  console.error(`[observer-forward] received ${signal}; draining bounded event work`);
  process.stdin.pause();
  if (typeof process.stdin.unref === 'function') process.stdin.unref();
  rl?.close();
  flushAndClose();
}

function handleLine(raw) {
  const line = raw.trim();
  if (!line) return;
  let o;
  try { o = JSON.parse(line); } catch { return; } // skip the collector's human log lines / partials
  const kind = eventKind(o);
  if (kind === 'CollectorHeartbeat') {
    // Collector health is control-plane telemetry, not Agent activity. It must reach the raw
    // heartbeat ingest seam even when Enforce suppresses unknown workloads, and it must not
    // inflate Agent observed/unknown/forwarded classification counters.
    enqueue(
      {
        line,
        sourceEventId: sourceEventId(line),
        ...(COLLECTOR_ID ? { collectorId: COLLECTOR_ID } : {}),
        ...(NODE_NAME ? { nodeName: NODE_NAME } : {}),
        ...sourceFields(''),
      },
      5,
      false,
    );
    return;
  }
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
  const activity = classifyEventActivity(o, processClassification, workloadClassification);
  const templateClassification = templateRegistry.classifyEvent(o);
  const baseClassification = mergeAttributionClassifications(
    processClassification,
    workloadClassification,
    templateClassification,
  ) ?? processClassification;
  const classification =
    (behaviorDiscoveryEligible(baseClassification)
      ? behaviorDetector.observe(o, baseClassification.attribution)
      : undefined) ??
    baseClassification;
  // Runtime lifecycle is rooted in ProcessKey, but placement/confirmation can come from Docker,
  // Kubernetes, or a trusted template. Enrich the root after field-level merge without replacing
  // its process-instance ID with a workload-level ID.
  attributor.enrichRuntimeRoot(processClassification, classification);
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
    recordE2eFilterReceipt(o, classification, filterReason, line);
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
  if (!matchesE2eIngestMarkerScope(o)) {
    attributionCounts.e2eMarkerScopedOut++;
    return;
  }
  bumpEventKind(o);

  enqueue(
    {
      line,
      sourceEventId: sourceEventId(line),
      ...(classification.attribution ? { attribution: classification.attribution } : {}),
      ...(activity ?? {}),
      ...(COLLECTOR_ID ? { collectorId: COLLECTOR_ID } : {}),
      ...(NODE_NAME ? { nodeName: NODE_NAME } : {}),
      ...sourceFields(classification.state === 'agent' ? classification.workspacePath : ''),
    },
    queuePriority(kind, classification),
  );
}

async function start() {
  resolveObserverForwarderHostPid();
  const infrastructure = await infrastructureResolver.resolve();
  if (closing) return;
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
  const signatureFile = process.env.ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE?.trim();
  if (signatureFile) {
    signatureReloader = new RuntimeSignatureReloader({
      registry: signatureRegistry,
      filePath: signatureFile,
      onReload: (reload) => {
        console.error(
          `[observer-forward] Agent runtime signatures reloaded: version=${reload.version}; ` +
          `hash=${reload.hash}; matcher_changed=${reload.matcherChanged}`,
        );
        if (reload.matcherChanged) requestReconciliation();
      },
      onError: (error, kind) => {
        // fs.watch is an acceleration path. If the host has exhausted inotify/file descriptors,
        // RuntimeSignatureReloader keeps its bounded polling fallback active. Do not report that
        // operational degradation as an invalid signature document; actual reload/registry
        // failures remain visible through runtimeSignatureReloadErrors/runtimeSignatureInvalid.
        const message = kind === 'watch'
          ? `watch unavailable; polling fallback remains active: ${error.message}`
          : `${kind || 'reload'} ignored: ${error.message}`;
        console.error(`[observer-forward] Agent runtime signatures ${message}`);
      },
    });
    signatureReloader.start();
  }
  console.error(
    `[observer-forward] Agent runtime signatures: source=${signatureRegistry.source}; ` +
    `version=${signatureRegistry.version}; loaded=${signatureRegistry.metrics().loaded}; ` +
    `hash=${signatureRegistry.hash}`,
  );
  const dockerStarted = await dockerDiscovery.start((snapshot) => workloadCache.replace(snapshot, 'docker'));
  if (closing) return;
  const docker = dockerDiscovery.metrics();
  console.error(`[observer-forward] docker discovery: enabled=${docker.enabled}; started=${dockerStarted}; socket=${dockerDiscovery.socketPath}`);

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
  // Lifecycle reporting is an independent control plane. Lease acquisition runs in the
  // background so an unavailable API never holds up stdin consumption or observer backpressure.
  void acquireRuntimeLease(3).then((acquired) => {
    if (acquired && !closing) sendRuntimeSnapshot(true);
  });
  runtimeSnapshotTimer = setInterval(() => sendRuntimeSnapshot(true), RUNTIME_SNAPSHOT_SECS * 1_000);
  runtimeSnapshotTimer.unref();
  rootLivenessTimer = setInterval(() => attributor.checkRootLiveness(), ROOT_LIVENESS_SECS * 1_000);
  rootLivenessTimer.unref();

  rl = readline.createInterface({ input: process.stdin });
  rl.on('line', handleLine);
  rl.on('close', flushAndClose);
}

process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));

void start().catch((error) => {
  console.error('[observer-forward] startup failed:', error instanceof Error ? error.message : String(error));
  closeTransports();
  process.exitCode = 1;
});
