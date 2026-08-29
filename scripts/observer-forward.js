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
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { AgentAttributor, readProcStartTime } = require('./observer-agent-attribution');
const { mergeAttributionClassifications } = require('./observer-attribution-merge');
const { classificationSemanticsEnvelope } = require('./observer-classification-semantics');
const { AgentTemplateRegistry, loadTemplateDocument } = require('./observer-agent-templates');
const {
  RuntimeSignatureRegistry,
  RuntimeSignatureReloader,
  loadSignatureDocument,
} = require('./observer-agent-runtime-signatures');
const { DockerDiscovery } = require('./observer-docker-discovery');
const { BehavioralAgentDetector } = require('./observer-behavior-discovery');
const { DurableSpool, safeId, stableWriterId } = require('./observer-durable-spool');
const { BoundedPriorityQueue } = require('./observer-priority-queue');
const { ToolExecDeduper } = require('./observer-event-dedup');
const {
  behaviorDiscoveryEligible,
  classifyEventActivity,
  WorkloadIdentityCache,
} = require('./observer-workload-filter');
const { InfrastructureRootResolver } = require('./observer-infrastructure-roots');
const { InfrastructurePolicyRegistry } = require('./observer-infrastructure-policy');
const { alwaysKeepEventKind } = require('./observer-infrastructure-rules');
const { FilterRulePublisher } = require('./observer-filter-rules');
const { CaptureProfileReporter } = require('./observer-capture-profile-reporter');
const { FileAccessAggregator } = require('./observer-file-aggregation');
const { ForwarderPipelineAccounting } = require('./observer-pipeline-accounting');
const { UnifiedFilterPolicyRegistry } = require('./observer-unified-filter-policy');
const { TlsAgentCgroupPublisher } = require('./observer-tls-agent-cgroups');

// Only immutable, software-versioned rules may override the generic lifecycle discovery
// guardrail. User-created SUPPRESS rules can never add an ID to this closed set.
const PROTECTED_LIFECYCLE_SUPPRESSION_RULES = new Set([
  'fr_builtin_f2_trusted_infrastructure_lifecycle_suppress',
  'fr_builtin_f2_trusted_non_agent_family_lifecycle_suppress',
]);
const TRUSTED_NON_AGENT_PROCESS_FAMILY_RULES = new Set([
  'fr_builtin_non_agent_runtime_vscode_cpu_sampler',
]);

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

function defaultInfrastructurePolicyUrl(ingestUrl) {
  const url = new URL(ingestUrl.toString());
  const nextPath = url.pathname.replace(/\/ingest(?:\/.*)?$/, '/infrastructure-rules/policy');
  url.pathname = nextPath === url.pathname
    ? '/security-center/infrastructure-rules/policy'
    : nextPath;
  url.hash = '';
  return url;
}

function defaultInfrastructureMaterializationUrl(ingestUrl) {
  const url = new URL(ingestUrl.toString());
  const nextPath = url.pathname.replace(
    /\/ingest(?:\/.*)?$/,
    '/infrastructure-rules/materializations/report',
  );
  url.pathname = nextPath === url.pathname
    ? '/security-center/infrastructure-rules/materializations/report'
    : nextPath;
  url.hash = '';
  return url;
}

function defaultUnifiedFilterProjectionUrl(ingestUrl) {
  const url = new URL(ingestUrl.toString());
  const nextPath = url.pathname.replace(/\/ingest(?:\/.*)?$/, '/filter-rules/projections/forwarder');
  url.pathname = nextPath === url.pathname
    ? '/security-center/filter-rules/projections/forwarder'
    : nextPath;
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
// Most batches stay small for latency. `takeWeighted` still admits one oversized first item so an
// explicitly allowed inline multimodal request can use the separate per-event ceiling below.
const BATCH_MAX_BYTES = boundedNumber(
  process.env.FORWARD_BATCH_MAX_BYTES,
  512 * 1024,
  64 * 1024,
  3 * 1024 * 1024,
);
const MAX_EVENT_BYTES = boundedNumber(
  process.env.FORWARD_MAX_EVENT_BYTES,
  12 * 1024 * 1024,
  64 * 1024,
  12 * 1024 * 1024,
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
// Infrastructure noise must not consume every ownership slot before Agent and protected
// lifecycle/security evidence reaches the Forwarder. This is a reservation inside the existing
// hard cap, not extra memory: lower-priority traffic can use only the non-reserved share, while
// Agent, ToolExec, ProcessExit and SecurityAction may use the full bounded budget.
const PROTECTED_PRIORITY = 3;
const PROTECTED_RESERVE_EVENTS = boundedNumber(
  process.env.FORWARD_PROTECTED_RESERVE_EVENTS,
  Math.floor(MAX_OUTSTANDING_EVENTS / 4),
  0,
  MAX_OUTSTANDING_EVENTS,
);
const PROTECTED_RESERVE_BYTES = boundedNumber(
  process.env.FORWARD_PROTECTED_RESERVE_BYTES,
  Math.floor(MAX_OUTSTANDING_BYTES / 4),
  0,
  MAX_OUTSTANDING_BYTES,
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
const SPOOL_REPLAY_INTERVAL_MS = boundedNumber(
  process.env.FORWARD_SPOOL_REPLAY_INTERVAL_MS,
  1_000,
  100,
  60_000,
);
const SPOOL_REPLAY_BATCH_SIZE = boundedNumber(
  process.env.FORWARD_SPOOL_REPLAY_BATCH_SIZE,
  256,
  1,
  4_096,
);
const SPOOL_DEGRADED_AGE_MS = boundedNumber(
  process.env.FORWARD_SPOOL_DEGRADED_AGE_MS,
  60_000,
  1_000,
  3_600_000,
);
const WAL_PENDING_MAX_EVENTS = boundedNumber(
  process.env.FORWARD_WAL_PENDING_MAX_EVENTS,
  65_536,
  1_024,
  250_000,
);
const WAL_PENDING_MAX_BYTES = boundedNumber(
  process.env.FORWARD_WAL_PENDING_MAX_BYTES,
  256 * 1024 * 1024,
  16 * 1024 * 1024,
  2 * 1024 * 1024 * 1024,
);
const HTTP_TIMEOUT_MS = boundedNumber(process.env.FORWARD_HTTP_TIMEOUT_MS, 10_000, 1_000, 120_000);
const CONTROL_HTTP_TIMEOUT_MS = boundedNumber(
  process.env.FORWARD_CONTROL_HTTP_TIMEOUT_MS,
  15_000,
  100,
  120_000,
);
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
const UNIFIED_FILTER_PROJECTION_MAX_BYTES = boundedNumber(
  process.env.ANYSENTRY_FILTER_RULE_PROJECTION_MAX_BYTES,
  16 * 1024 * 1024,
  64 * 1024,
  32 * 1024 * 1024,
);
const CAPTURE_PROFILE_REPORT_RESPONSE_MAX_BYTES = boundedNumber(
  process.env.ANYSENTRY_CAPTURE_PROFILE_REPORT_RESPONSE_MAX_BYTES,
  4 * 1024 * 1024,
  64 * 1024,
  16 * 1024 * 1024,
);
const CAPTURE_PROFILE_REPORT_TIMEOUT_MS = boundedNumber(
  process.env.ANYSENTRY_CAPTURE_PROFILE_REPORT_TIMEOUT_MS,
  8_000,
  1_000,
  30_000,
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
let FILTER_MODE = ['enforce', 'shadow'].includes(process.env.FORWARD_FILTER_MODE)
  ? process.env.FORWARD_FILTER_MODE
  : LEGACY_FORWARD_SCOPE === 'agent' ? 'enforce' : 'shadow';
// Unknown is evidence, not a negative identity decision. It is always retained; only exact
// lossless aggregation may reduce repeated records. The legacy env remains accepted by manifests
// but cannot authorize silent Unknown loss.
const RETAIN_UNKNOWN = true;
const OBSERVER_FILE_UNKNOWN_POLICY = text(process.env.A3S_OBSERVER_FILE_UNKNOWN_POLICY).toLowerCase() === 'sample'
  ? 'sample'
  : 'keep';
let RETAIN_NON_AGENT = envBoolean(process.env.FORWARD_RETAIN_NON_AGENT, false);
let NOISE_POLICY = ['balanced', 'include'].includes(process.env.FORWARD_NOISE_POLICY)
  ? process.env.FORWARD_NOISE_POLICY
  : 'balanced';
const DROP_PATHS = (process.env.FORWARD_DROP_PATHS || '/sys/,/proc/,/run/,/dev/').split(',').map((s) => s.trim()).filter(Boolean);
const FILTER_RULES_FILE = text(process.env.ANYSENTRY_FILTER_RULES_FILE);
const TLS_AGENT_CGROUPS_FILE = text(process.env.ANYSENTRY_TLS_AGENT_CGROUPS_FILE)
  || (FILTER_RULES_FILE ? path.join(path.dirname(FILTER_RULES_FILE), 'tls-agent-cgroups.json') : '');
const CAPTURE_PROFILE_MODE = ['legacy', 'shadow', 'enforce'].includes(
  text(process.env.ANYSENTRY_CAPTURE_PROFILE_MODE).toLowerCase(),
)
  ? text(process.env.ANYSENTRY_CAPTURE_PROFILE_MODE).toLowerCase()
  : 'legacy';
const FILTER_RULES_ACK_FILE = CAPTURE_PROFILE_MODE === 'legacy'
  ? ''
  : text(process.env.ANYSENTRY_FILTER_RULES_ACK_FILE)
    || (FILTER_RULES_FILE ? `${FILTER_RULES_FILE}.ack.json` : '');
const CAPTURE_PROFILE_ACK_POLL_MS = boundedNumber(
  process.env.ANYSENTRY_CAPTURE_PROFILE_ACK_POLL_MS,
  250,
  50,
  60_000,
);
let FILE_AGGREGATION_ENABLED = envBoolean(process.env.FORWARD_FILE_AGGREGATION, false);
let FILE_AGGREGATION_WINDOW_MS = boundedNumber(
  process.env.FORWARD_FILE_AGGREGATION_WINDOW_MS,
  100,
  10,
  5_000,
);
const COLLECTOR_ID = process.env.A3S_OBSERVER_COLLECTOR_ID || process.env.COLLECTOR_ID || process.env.HOSTNAME || '';
const NODE_NAME = process.env.A3S_NODE_NAME || process.env.NODE_NAME || '';
function sourceCredentialsFromFile(file, collectorId, nodeName) {
  const target = text(file);
  if (!target) return {};
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0) return {};
    const document = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (
      document?.schemaVersion !== 'anysentry.observer_source_credentials.v1'
      || !Array.isArray(document.credentials)
      || document.credentials.length > 10_000
    ) return {};
    const expected = [text(collectorId), text(nodeName)].filter(Boolean);
    const entry = document.credentials.find((candidate) =>
      candidate && typeof candidate === 'object' && expected.includes(text(candidate.collectorId)));
    const sourceId = text(entry?.sourceId);
    const token = text(entry?.token);
    if (!sourceId || sourceId.length > 160 || !token || token.length > 500) return {};
    return { sourceId, token };
  } catch {
    return {};
  }
}
const sourceCredentials = sourceCredentialsFromFile(
  process.env.ANYSENTRY_SOURCE_CREDENTIALS_FILE,
  COLLECTOR_ID,
  NODE_NAME,
);
const SOURCE_ID = process.env.ANYSENTRY_SOURCE_ID || sourceCredentials.sourceId || '';
const SOURCE_NAME = process.env.ANYSENTRY_SOURCE_NAME || '';
const SOURCE_TYPE = process.env.ANYSENTRY_SOURCE_TYPE || 'observer';
const SOURCE_TOKEN = process.env.ANYSENTRY_INGEST_TOKEN || sourceCredentials.token || '';
const WORKSPACE_PATH = process.env.ANYSENTRY_WORKSPACE_PATH || '';
const WRITER_VERSION = process.env.ANYSENTRY_WRITER_VERSION || 'observer-forwarder/2.0.0';
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
  compactMaxLiveRecords: process.env.FORWARD_SPOOL_COMPACT_MAX_LIVE_RECORDS,
  fsyncMode: process.env.FORWARD_SPOOL_FSYNC,
  fsyncMs: process.env.FORWARD_SPOOL_FSYNC_MS,
  onAsyncError(error) {
    console.error(`[observer-forward] durable spool async operation failed: ${error.message}`);
    if (rl) rl.pause();
    process.exitCode = 1;
  },
});
const HEARTBEAT_SECS = Math.max(0, Number(process.env.ANYSENTRY_HEARTBEAT_SECS || 30));
const heartbeatTarget = new URL(process.env.ANYSENTRY_HEARTBEAT_URL || defaultHeartbeatUrl(target));
const batchTarget = new URL(process.env.ANYSENTRY_BATCH_INGEST_URL || defaultBatchIngestUrl(target));
const IDENTITY_SNAPSHOT_SECS = Math.max(0, Number(process.env.ANYSENTRY_IDENTITY_SNAPSHOT_SECS || 15));
const identitySnapshotTarget = new URL(
  process.env.ANYSENTRY_IDENTITY_SNAPSHOT_URL || defaultIdentitySnapshotUrl(target),
);
if (NODE_NAME) identitySnapshotTarget.searchParams.set('nodeName', NODE_NAME);
const INFRASTRUCTURE_POLICY_SECS = Math.max(
  0,
  Number(process.env.ANYSENTRY_INFRASTRUCTURE_POLICY_SECS || 5),
);
const infrastructurePolicyTarget = new URL(
  process.env.ANYSENTRY_INFRASTRUCTURE_POLICY_URL || defaultInfrastructurePolicyUrl(target),
);
const infrastructureMaterializationTarget = new URL(
  process.env.ANYSENTRY_INFRASTRUCTURE_MATERIALIZATION_URL
    || defaultInfrastructureMaterializationUrl(target),
);
const INFRASTRUCTURE_POLICY_TOKEN = text(process.env.ANYSENTRY_INFRASTRUCTURE_POLICY_TOKEN);
const UNIFIED_FILTER_PROJECTION_SECS = Math.max(
  0,
  Number(process.env.ANYSENTRY_FILTER_RULE_PROJECTION_SECS || 5),
);
const unifiedFilterProjectionTarget = new URL(
  process.env.ANYSENTRY_FILTER_RULE_PROJECTION_URL || defaultUnifiedFilterProjectionUrl(target),
);
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
let templateRegistry = new AgentTemplateRegistry(templateDocument);
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
const unifiedFilterPolicy = new UnifiedFilterPolicyRegistry();
const infrastructureResolver = new InfrastructureRootResolver();
const infrastructurePolicy = new InfrastructurePolicyRegistry({
  hostGroup:
    process.env.ANYSENTRY_INFRASTRUCTURE_HOST_GROUP ||
    process.env.A3S_OBSERVER_HOST_ID ||
    NODE_NAME ||
    'local',
  canaryEnabled: envBoolean(process.env.ANYSENTRY_INFRASTRUCTURE_CANARY, false),
});
const toolExecDeduper = new ToolExecDeduper({
  windowMs: process.env.FORWARD_DEDUP_WINDOW_MS,
  maxKeys: process.env.FORWARD_MAX_DEDUP_KEYS,
});
const filterRulePublisher = new FilterRulePublisher({
  file: FILTER_RULES_FILE,
  ackFile: FILTER_RULES_ACK_FILE,
  captureProfileMode: CAPTURE_PROFILE_MODE,
  nodeId: NODE_NAME || COLLECTOR_ID,
  collectorId: COLLECTOR_ID || NODE_NAME,
  hostBootId: attributor.bootId,
  enforceDrops: CAPTURE_PROFILE_MODE === 'legacy' ? FILTER_MODE === 'enforce' : true,
  ttlMs: process.env.FORWARD_FILTER_RULE_TTL_MS,
  probableTtlMs: process.env.ANYSENTRY_PROBABLE_PROFILE_TTL_MS,
  lkgTtlMs: process.env.ANYSENTRY_CAPTURE_PROFILE_LKG_TTL_MS,
  riskPromotionTtlMs: process.env.ANYSENTRY_CAPTURE_PROFILE_PROMOTION_TTL_MS,
  ackMaxAgeMs: process.env.ANYSENTRY_CAPTURE_PROFILE_ACK_MAX_AGE_MS,
  flushIntervalMs: process.env.FORWARD_FILTER_RULE_FLUSH_MS,
  maxEntries: process.env.FORWARD_FILTER_RULE_MAX_ENTRIES,
  maxProbableEntries: process.env.ANYSENTRY_PROBABLE_PROFILE_MAX_ENTRIES,
  maxSnapshotBytes: process.env.ANYSENTRY_CAPTURE_PROFILE_MAX_SNAPSHOT_BYTES,
});
const tlsAgentCgroupPublisher = new TlsAgentCgroupPublisher({ file: TLS_AGENT_CGROUPS_FILE });
let lastCaptureProfileReportError = '';
const captureProfileReporter = new CaptureProfileReporter({
  publisher: filterRulePublisher,
  pollIntervalMs: CAPTURE_PROFILE_ACK_POLL_MS,
  retryBaseMs: process.env.ANYSENTRY_CAPTURE_PROFILE_REPORT_RETRY_MS,
  postReport(report, done) {
    postJsonResponse(
      infrastructureMaterializationTarget,
      report,
      CAPTURE_PROFILE_REPORT_TIMEOUT_MS,
      done,
      INFRASTRUCTURE_POLICY_TOKEN
        ? { 'X-AnySentry-Management-Token': INFRASTRUCTURE_POLICY_TOKEN }
        : {},
      CAPTURE_PROFILE_REPORT_RESPONSE_MAX_BYTES,
      // Capture grants are safety-critical and low frequency. A dedicated non-pooled connection
      // cannot wait behind identity/runtime/policy sockets or reuse a stale keep-alive socket.
      false,
    );
  },
  onError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastCaptureProfileReportError) return;
    lastCaptureProfileReportError = message;
    console.error(`[observer-forward] Capture Profile materialization unavailable: ${message}`);
  },
});
const fileAccessAggregator = new FileAccessAggregator({
  windowMs: FILE_AGGREGATION_WINDOW_MS,
  maxKeys: process.env.FORWARD_FILE_AGGREGATION_MAX_KEYS,
});

function emptyAttributionCounts() {
  return {
    observed: 0,
    confirmedAgent: 0,
    probableAgent: 0,
    unknown: 0,
    nonAgent: 0,
    filteredNonAgent: 0,
    wouldFilterNonAgent: 0,
    filteredUnknown: 0,
    wouldFilterUnknown: 0,
    filteredNoise: 0,
    wouldFilterNoise: 0,
    discoveryBudgetDropped: 0,
    wouldDiscoveryBudgetDrop: 0,
    e2eMarkerScopedOut: 0,
    forwarded: 0,
    queueDropped: 0,
    queueParked: 0,
    batches: 0,
    batchEvents: 0,
    retryQueued: 0,
    retryAttempts: 0,
    retryRecovered: 0,
    retryExhausted: 0,
    retryParked: 0,
    spoolReplayAttempts: 0,
    spoolReplayAdmitted: 0,
    spoolReplayDeferred: 0,
    heartbeatDeliveryFailures: 0,
    workspaceConflict: 0,
    infrastructure: 0,
    deduplicated: 0,
    aggregatedFileEvents: 0,
    aggregationOutputs: 0,
    captureAggregateOutputs: 0,
    captureAggregateDecisionAttempts: 0,
    protectedQueueDropped: 0,
    queueDroppedByClass: Object.create(null),
    unknownReasons: Object.create(null),
  };
}

let inflight = 0;
let inflightEvents = 0;
let inflightBytes = 0;
let outstandingEvents = 0;
let outstandingBytes = 0;
let retryOutstandingEvents = 0;
let retryOutstandingBytes = 0;
let walPendingEvents = 0;
let walPendingBytes = 0;
const outstandingItems = new Set();
const activeSpoolIds = new Set();
const pending = new BoundedPriorityQueue(MAX_OUTSTANDING_EVENTS, 5, (item) => item.bytes);
const retryTasks = [];
const activeEventRequests = new Set();
const activeControlRequests = new Set();
let eventRequestsAborted = false;
let outputDropped = 0;
let errorCount = 0;
let eventKindCounts = Object.create(null);
const forwarderInstanceId = crypto.randomUUID();
const pipelineAccounting = new ForwarderPipelineAccounting({
  producerInstanceId: forwarderInstanceId,
});
let sourceEventSequence = 0;
let lastNonAgentSuppressedAt = '';
let e2eFilterReceipts = [];
let attributionCounts = emptyAttributionCounts();
let closing = false;
let heartbeatTimer;
let heartbeatDeliveryInFlight = false;
let pendingHeartbeatDelivery;
let identitySnapshotTimer;
let infrastructurePolicyTimer;
let unifiedFilterProjectionTimer;
let runtimeSnapshotTimer;
let rootLivenessTimer;
let batchTimer;
let retryTimer;
let spoolReplayTimer;
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
const controlPlaneLanes = Object.fromEntries(
  ['identity', 'filter_rules', 'infrastructure_policy', 'runtime_snapshot'].map((lane) => [
    lane,
    { lastSuccessAt: 0, lastFailureAt: 0, lastFailure: '' },
  ]),
);
const enabledControlPlaneLanes = new Set([
  ...(IDENTITY_SNAPSHOT_SECS > 0 ? ['identity'] : []),
  ...(UNIFIED_FILTER_PROJECTION_SECS > 0 ? ['filter_rules'] : []),
  ...(INFRASTRUCTURE_POLICY_SECS > 0 ? ['infrastructure_policy'] : []),
  'runtime_snapshot',
]);

function markControlPlaneSuccess(lane) {
  if (!controlPlaneLanes[lane]) return;
  controlPlaneLanes[lane].lastSuccessAt = Date.now();
}

function markControlPlaneFailure(lane, reason) {
  if (!controlPlaneLanes[lane]) return;
  controlPlaneLanes[lane].lastFailureAt = Date.now();
  controlPlaneLanes[lane].lastFailure = String(reason || 'control plane failure').slice(0, 500);
}

function controlPlaneMetrics() {
  const failedLanes = [];
  const startingLanes = [];
  const lanes = {};
  for (const [lane, state] of Object.entries(controlPlaneLanes)) {
    if (!enabledControlPlaneLanes.has(lane)) continue;
    if (!state.lastSuccessAt && !state.lastFailureAt) startingLanes.push(lane);
    if (state.lastFailureAt > state.lastSuccessAt) failedLanes.push(lane);
    lanes[lane] = {
      ...(state.lastSuccessAt ? { lastSuccessAt: new Date(state.lastSuccessAt).toISOString() } : {}),
      ...(state.lastFailureAt ? {
        lastFailureAt: new Date(state.lastFailureAt).toISOString(),
        lastFailure: state.lastFailure,
      } : {}),
    };
  }
  return {
    state: failedLanes.length ? 'degraded' : startingLanes.length ? 'starting' : 'healthy',
    failedLanes,
    startingLanes,
    lanes,
  };
}

function recordRuntimeSnapshotFailure(reason, snapshotVersion = runtimeSnapshotVersion) {
  lastRuntimeSnapshotFailureAt = new Date().toISOString();
  lastRuntimeSnapshotFailure = String(reason || 'runtime snapshot failed').slice(0, 500);
  lastRuntimeSnapshotFailureVersion = Number.isSafeInteger(snapshotVersion) && snapshotVersion > 0
    ? snapshotVersion
    : 0;
  markControlPlaneFailure('runtime_snapshot', lastRuntimeSnapshotFailure);
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

function durableRecordKind(body) {
  try {
    return eventKind(JSON.parse(String(body?.line || '')));
  } catch {
    return '';
  }
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
    .update(WRITER_ID)
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
  let timeoutAbortImmediate;
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
    if (timeoutAbortImmediate) clearImmediate(timeoutAbortImmediate);
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
    absoluteTimer = undefined;
    timeoutAbortImmediate = setImmediate(() => {
      timeoutAbortImmediate = undefined;
      state.abort();
    });
  }, timeoutMs);
  req.end(body);
}

function pipelineCount(stage, reason, count) {
  return count > 0 ? [{ stage, reason, count }] : [];
}

function invalidBatchAck(batchLength, reason) {
  return {
    dropped: batchLength,
    errors: 1,
    retryItems: [],
    acceptedItems: [],
    rejectedItems: [],
    pipelineCounts: pipelineCount('api_rejected', 'invalid_ack', batchLength),
    reason,
  };
}

function eventBatchEnvelope(batch) {
  const events = batch.map((item) => item.body);
  const canonical = JSON.stringify(events);
  const payloadDigest = crypto.createHash('sha256').update(canonical).digest('hex');
  const batchId = `obat_${crypto.createHash('sha256')
    .update(WRITER_ID)
    .update('\0')
    .update(payloadDigest)
    .digest('hex')
    .slice(0, 24)}`;
  return {
    schemaVersion: 'anysentry.observer_batch.v2',
    batchId,
    payloadDigest,
    durableReplay: batch.some((item) => item.recovered === true),
    writerId: WRITER_ID,
    writerVersion: WRITER_VERSION,
    idempotencyProtocolVersion: IDEMPOTENCY_PROTOCOL_VERSION,
    events,
  };
}

function validateBatchAck(value, batch, envelope = eventBatchEnvelope(batch)) {
  const batchLength = batch.length;
  const ack = value?.data ?? value;
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) {
    return invalidBatchAck(batchLength, 'batch endpoint returned no acknowledgement');
  }
  if (
    (ack.batchId !== undefined && ack.batchId !== envelope.batchId)
    || (ack.payloadDigest !== undefined && ack.payloadDigest !== envelope.payloadDigest)
  ) {
    return invalidBatchAck(batchLength, 'batch endpoint acknowledgement identity mismatch');
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
  let structuralItems = 0;
  let discardedItems = 0;
  let rejectedItems = 0;
  const acceptedBatchItems = [];
  const rejectedBatchItems = [];
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
      acceptedBatchItems.push(batch[index]);
      if (item.disposition === undefined || item.disposition === 'retained') retainedItems++;
      else if (item.disposition === 'discarded') {
        discardedItems++;
        if (item.structuralConsumed === true || item.reasonCode === 'non_agent_structural_consumed') {
          structuralItems++;
        }
      }
      else return invalidBatchAck(batchLength, 'batch endpoint returned an invalid accepted disposition');
    } else if (item.disposition === 'retryable') {
      if (!['clickhouse_event_buffer_full', 'delivery_incomplete', 'batch_commit_retryable'].includes(item.reasonCode)) {
        return invalidBatchAck(batchLength, 'batch endpoint returned an unrecognized retry reason');
      }
      sawRetryable = true;
      retryItems.push(batch[index]);
    } else if (item.disposition === undefined || item.disposition === 'rejected') {
      if (sawRetryable) {
        return invalidBatchAck(batchLength, 'batch endpoint retryable items are not a contiguous suffix');
      }
      rejectedItems++;
      rejectedBatchItems.push(batch[index]);
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
    || (ack.structuralEvents !== undefined && (!Number.isSafeInteger(ack.structuralEvents) || ack.structuralEvents !== structuralItems))
    || (ack.discardedEvents !== undefined && (!Number.isSafeInteger(ack.discardedEvents) || ack.discardedEvents !== discardedItems))
    || (
      ack.retainedEvents !== undefined
      && ack.discardedEvents !== undefined
      && ack.retainedEvents + ack.discardedEvents !== acceptedEvents
    )
  ) {
    return invalidBatchAck(batchLength, 'batch endpoint disposition counts do not match its items');
  }
  return {
    dropped: rejectedEvents,
    errors: rejectedEvents > 0 ? 1 : 0,
    acceptedItems: acceptedBatchItems,
    rejectedItems: rejectedBatchItems,
    retryItems,
    retryAfterMs: ack.retryAfterMs,
    pipelineCounts: [
      ...pipelineCount('api_retained', 'ack', retainedItems),
      ...pipelineCount('api_discarded', 'structural_consumed', structuralItems),
      ...pipelineCount('api_discarded', 'ack', discardedItems - structuralItems),
      ...pipelineCount('api_rejected', 'ack', rejectedItems),
      ...pipelineCount('api_retryable', 'ack', retryItems.length),
    ],
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
  let envelope;
  try {
    envelope = eventBatchEnvelope(batch);
    body = JSON.stringify(envelope);
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
    done({ ...result, envelope });
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
    acceptedItems: [...(left.acceptedItems ?? []), ...(right.acceptedItems ?? [])],
    rejectedItems: [...(left.rejectedItems ?? []), ...(right.rejectedItems ?? [])],
    retryItems: [...(left.retryItems ?? []), ...(right.retryItems ?? [])],
    retryAfterMs: Math.max(left.retryAfterMs ?? 0, right.retryAfterMs ?? 0),
    pipelineCounts: [...(left.pipelineCounts ?? []), ...(right.pipelineCounts ?? [])],
  };
}

/** A 413 is safe to retry because Express rejects the body before the controller processes it. */
function deliverEventBatch(batch, done, absoluteDeadline = 0) {
  if (eventRequestsAborted) {
    done({
      dropped: batch.length,
      errors: batch.length > 0 ? 1 : 0,
      retryItems: [],
      pipelineCounts: pipelineCount('api_rejected', 'shutdown', batch.length),
    });
    return;
  }
  const remainingMs = absoluteDeadline > 0 ? absoluteDeadline - Date.now() : HTTP_TIMEOUT_MS;
  if (remainingMs <= 0) {
    done({
      dropped: batch.length,
      errors: batch.length > 0 ? 1 : 0,
      retryItems: [],
      pipelineCounts: pipelineCount('api_rejected', 'retry_deadline', batch.length),
    });
    return;
  }
  postEventBatch(batch, Math.max(1, Math.min(HTTP_TIMEOUT_MS, remainingMs)), (result) => {
    // Once a 413 header is received the request was rejected for size, regardless of whether its
    // proxy-generated response body later truncates or aborts. Splitting remains safe and useful.
    if (result.statusCode === 413) {
      if (batch.length === 1) {
        done({
          dropped: 1,
          errors: 1,
          acceptedItems: [],
          rejectedItems: batch,
          retryItems: [],
          pipelineCounts: pipelineCount('api_rejected', 'payload_too_large', 1),
        });
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
      done({
        dropped: 0,
        errors: 0,
        retryItems: batch,
        pipelineCounts: pipelineCount('api_retryable', 'transport_error', batch.length),
      });
      return;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      if (result.statusCode === 408 || result.statusCode === 425 || result.statusCode === 429 || result.statusCode >= 500) {
        done({
          dropped: 0,
          errors: 0,
          retryItems: batch,
          pipelineCounts: pipelineCount('api_retryable', 'http_retryable', batch.length),
        });
      } else {
        done({
          dropped: batch.length,
          errors: 1,
          acceptedItems: [],
          rejectedItems: batch,
          retryItems: [],
          pipelineCounts: pipelineCount('api_rejected', 'http_rejected', batch.length),
        });
      }
      return;
    }
    let parsed;
    try {
      parsed = result.responseBody ? JSON.parse(result.responseBody) : undefined;
    } catch {
      done({
        dropped: batch.length,
        errors: 1,
        retryItems: [],
        pipelineCounts: pipelineCount('api_rejected', 'invalid_ack', batch.length),
      });
      return;
    }
    const outcome = validateBatchAck(parsed, batch, result.envelope);
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
function postJsonResponse(
  url,
  bodyObj,
  timeoutMs,
  done,
  extraHeaders = {},
  maxResponseBytes = 64 * 1024,
  requestAgent,
) {
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
  let timeoutAbortImmediate;
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
    if (timeoutAbortImmediate) clearImmediate(timeoutAbortImmediate);
    activeControlRequests.delete(state);
    done(abortReason ? new Error(abortReason) : error, value);
  };
  req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      agent: requestAgent === false
        ? false
        : isHttps ? controlHttpsAgent : controlHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...sourceHeaders(),
        ...extraHeaders,
      },
    },
    (res) => {
      response = res;
      let data = '';
      let oversized = false;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (oversized) return;
        if (Buffer.byteLength(data) + Buffer.byteLength(chunk) > maxResponseBytes) {
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
          const error = new Error(`control endpoint response exceeds ${maxResponseBytes} bytes`);
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
    absoluteTimer = undefined;
    // A synchronous WAL or classification burst can resume the event loop after both the
    // deadline and the HTTP response are already ready. Give the poll phase one turn to consume
    // that on-time response before an overdue timer destroys its socket.
    timeoutAbortImmediate = setImmediate(() => {
      timeoutAbortImmediate = undefined;
      state.abort('control endpoint request timed out');
    });
  }, timeoutMs);
  req.end(body);
  return state;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(url, timeoutMs, done, extraHeaders = {}, requestAgent, maxResponseBytes = IDENTITY_SNAPSHOT_MAX_BYTES) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    done(new Error(`unsupported protocol ${url.protocol}`));
    return;
  }
  let settled = false;
  let absoluteTimer;
  let timeoutAbortImmediate;
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
    if (timeoutAbortImmediate) clearImmediate(timeoutAbortImmediate);
    activeControlRequests.delete(state);
    done(abortReason ? new Error(abortReason) : error, value);
  };
  req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      agent: requestAgent === false
        ? false
        : isHttps ? controlHttpsAgent : controlHttpAgent,
      headers: { ...sourceHeaders(), ...extraHeaders },
    },
    (res) => {
      response = res;
      let data = '';
      let responseBytes = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (settled) return;
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > maxResponseBytes) {
          res.destroy();
          finish(new Error(`control projection response exceeds ${maxResponseBytes} bytes`));
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
    absoluteTimer = undefined;
    // See postJsonResponse: an expired timer must not outrank response bytes that arrived while
    // the Forwarder event loop was briefly occupied by the data plane.
    timeoutAbortImmediate = setImmediate(() => {
      timeoutAbortImmediate = undefined;
      state.abort('control endpoint request timed out');
    });
  }, timeoutMs);
  req.end();
  return state;
}

let identitySnapshotRefreshInFlight = false;
function refreshIdentitySnapshot() {
  if (identitySnapshotRefreshInFlight) return;
  identitySnapshotRefreshInFlight = true;
  getJson(identitySnapshotTarget, CONTROL_HTTP_TIMEOUT_MS, (error, snapshot) => {
    identitySnapshotRefreshInFlight = false;
    if (closing && error?.message === GRACEFUL_SHUTDOWN_SUPERSEDE) return;
    if (error || !workloadCache.replace(snapshot)) {
      if (error) workloadCache.errors++;
      markControlPlaneFailure('identity', error?.message || 'identity snapshot rejected');
      return;
    }
    markControlPlaneSuccess('identity');
    synchronizeInfrastructurePolicyRules();
  }, {}, false);
}

function synchronizeInfrastructurePolicyRules() {
  const policyMetrics = infrastructurePolicy.metrics();
  if (!policyMetrics.ready) return { removed: 0, applied: 0 };
  const decisions = [];
  const inventory = [
    ...workloadCache.infrastructureInventory().map((facts) =>
      infrastructurePolicy.resolveCgroupFacts(facts)),
    ...infrastructurePolicy.hostInventory(),
  ];
  infrastructurePolicy.replaceMaterializedFacts(inventory);
  for (const facts of inventory) {
    if (CAPTURE_PROFILE_MODE === 'legacy') {
      const evaluation = infrastructurePolicy.evaluateFacts(facts, 'FileAccess');
      if (evaluation?.fileDecision) decisions.push(evaluation.fileDecision);
      continue;
    }
    const captureDecision = infrastructurePolicy.materializeCaptureProfile(facts);
    if (captureDecision) decisions.push(captureDecision);
  }
  const synchronized = filterRulePublisher.synchronizePolicyDecisions(
    decisions,
    policyMetrics.policyVersion,
  );
  if (CAPTURE_PROFILE_MODE !== 'legacy') filterRulePublisher.flush();
  return synchronized;
}

let lastInfrastructurePolicyError = '';
let lastLoggedInfrastructurePolicyVersion = -1;
let infrastructurePolicyRefreshInFlight = false;
function refreshInfrastructurePolicy() {
  if (!INFRASTRUCTURE_POLICY_SECS) return;
  if (infrastructurePolicyRefreshInFlight) return;
  infrastructurePolicyRefreshInFlight = true;
  getJson(
    infrastructurePolicyTarget,
    CONTROL_HTTP_TIMEOUT_MS,
    (error, policy) => {
      infrastructurePolicyRefreshInFlight = false;
      if (closing && error?.message === GRACEFUL_SHUTDOWN_SUPERSEDE) return;
      if (error) {
        markControlPlaneFailure('infrastructure_policy', error.message);
        infrastructurePolicy.recordLoadError();
        filterRulePublisher.degradeToLastKnownGood(error.message);
        if (error.message !== lastInfrastructurePolicyError) {
          console.error(`[observer-forward] Infrastructure policy unavailable: ${error.message}`);
          lastInfrastructurePolicyError = error.message;
        }
        return;
      }
      const loaded = infrastructurePolicy.replace(policy);
      if (!loaded.ok) {
        markControlPlaneFailure('infrastructure_policy', loaded.error);
        filterRulePublisher.degradeToLastKnownGood(loaded.error);
        if (loaded.error !== lastInfrastructurePolicyError) {
          console.error(`[observer-forward] Infrastructure policy ignored: ${loaded.error}`);
          lastInfrastructurePolicyError = loaded.error;
        }
        return;
      }
      lastInfrastructurePolicyError = '';
      markControlPlaneSuccess('infrastructure_policy');
      filterRulePublisher.markControlPlaneReady();
      const synchronized = synchronizeInfrastructurePolicyRules();
      if (loaded.version !== lastLoggedInfrastructurePolicyVersion) {
        console.error(
          `[observer-forward] Infrastructure policy loaded: version=${loaded.version}; ` +
          `rules=${loaded.rules}; materialized=${synchronized.applied}; removed=${synchronized.removed}`,
        );
        lastLoggedInfrastructurePolicyVersion = loaded.version;
      }
    },
    INFRASTRUCTURE_POLICY_TOKEN
      ? { 'X-AnySentry-Management-Token': INFRASTRUCTURE_POLICY_TOKEN }
      : {},
    // The low-frequency policy refresh must not reuse a server-expired control socket. Identity
    // snapshots remain on the shared high-frequency pool.
    false,
  );
}

let lastUnifiedFilterProjectionError = '';
let lastUnifiedFilterProjectionVersion = -1;
let unifiedFilterProjectionRefreshInFlight = false;
function refreshUnifiedFilterProjection(done = () => {}) {
  if (!UNIFIED_FILTER_PROJECTION_SECS) {
    done();
    return;
  }
  if (unifiedFilterProjectionRefreshInFlight) {
    done();
    return;
  }
  unifiedFilterProjectionRefreshInFlight = true;
  getJson(
    unifiedFilterProjectionTarget,
    CONTROL_HTTP_TIMEOUT_MS,
    (error, projection) => {
      unifiedFilterProjectionRefreshInFlight = false;
      if (closing && error?.message === GRACEFUL_SHUTDOWN_SUPERSEDE) {
        done();
        return;
      }
      if (error) {
        markControlPlaneFailure('filter_rules', error.message);
        unifiedFilterPolicy.degrade(error.message);
        if (error.message !== lastUnifiedFilterProjectionError) {
          console.error(`[observer-forward] Unified Filter Rule projection unavailable: ${error.message}`);
          lastUnifiedFilterProjectionError = error.message;
        }
        done();
        return;
      }
      const loaded = unifiedFilterPolicy.replace(projection);
      if (!loaded.ok) {
        markControlPlaneFailure('filter_rules', loaded.error);
        unifiedFilterPolicy.degrade(loaded.error);
        if (loaded.error !== lastUnifiedFilterProjectionError) {
          console.error(`[observer-forward] Unified Filter Rule projection ignored: ${loaded.error}`);
          lastUnifiedFilterProjectionError = loaded.error;
        }
        done();
        return;
      }
      lastUnifiedFilterProjectionError = '';
      markControlPlaneSuccess('filter_rules');
      if (loaded.changed) {
        const signatureResult = signatureRegistry.replaceSafely(
          unifiedFilterPolicy.runtimeSignatureDocument(),
          'unified-filter-rule-control-plane',
        );
        if (!signatureResult.ok) {
          unifiedFilterPolicy.degrade(signatureResult.error);
          console.error(`[observer-forward] Unified Agent Runtime signatures ignored: ${signatureResult.error}`);
          done();
          return;
        }
        templateRegistry = new AgentTemplateRegistry({
          ...unifiedFilterPolicy.agentTemplateDocument(),
          source: 'unified-filter-rule-control-plane',
        });
        workloadCache.templateRegistry = templateRegistry;
        const settings = unifiedFilterPolicy.settings();
        FILTER_MODE = settings.filterMode;
        RETAIN_NON_AGENT = settings.retainNonAgent;
        NOISE_POLICY = settings.noisePolicy;
        FILE_AGGREGATION_ENABLED = settings.fileAggregationEnabled;
        FILE_AGGREGATION_WINDOW_MS = settings.fileAggregationWindowMs;
        fileAccessAggregator.windowMs = settings.fileAggregationWindowMs;
        signatureReloader?.close();
        if (signatureResult.matcherChanged) requestReconciliation();
      }
      if (loaded.catalogVersion !== lastUnifiedFilterProjectionVersion) {
        const metrics = unifiedFilterPolicy.metrics();
        console.error(
          `[observer-forward] Unified Filter Rule projection loaded: catalog=${metrics.catalogVersion}; ` +
          `identity=${metrics.domainVersions.identity}; capture=${metrics.domainVersions.capture}; ` +
          `forwarder=${metrics.domainVersions.forwarder}; signatures=${metrics.runtimeSignatures}; ` +
          `templates=${metrics.agentTemplates}; semantic_rules=${metrics.semanticRetentionRules}`,
        );
        lastUnifiedFilterProjectionVersion = loaded.catalogVersion;
      }
      done();
    },
    INFRASTRUCTURE_POLICY_TOKEN
      ? { 'X-AnySentry-Management-Token': INFRASTRUCTURE_POLICY_TOKEN }
      : {},
    false,
    UNIFIED_FILTER_PROJECTION_MAX_BYTES,
  );
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
      CONTROL_HTTP_TIMEOUT_MS,
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

function sendRuntimeSnapshot(ready = true, done = () => {}, timeoutMs = CONTROL_HTTP_TIMEOUT_MS) {
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
        markControlPlaneSuccess('runtime_snapshot');
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
    protectedReserveEvents: PROTECTED_RESERVE_EVENTS,
    protectedReserveBytes: PROTECTED_RESERVE_BYTES,
    walPendingEvents,
    walPendingBytes,
    walPendingEventLimit: WAL_PENDING_MAX_EVENTS,
    walPendingByteLimit: WAL_PENDING_MAX_BYTES,
  };
}

function durableSpoolMetrics() {
  const status = spool.status();
  return {
    records: status.records,
    activeRecords: activeSpoolIds.size,
    parkedRecords: Math.max(0, status.records - activeSpoolIds.size),
    logicalBytes: status.logicalBytes,
    walBytes: status.walBytes,
    oldestAgeMs: status.oldestMs,
    atCapacity: status.atCapacity,
    fsyncMode: status.fsyncMode,
    compactionDeferred: status.compactionDeferred,
    compactions: status.compactions,
    compactMaxLiveRecords: status.compactMaxLiveRecords,
    pendingPutRecords: status.pendingPutRecords,
    pendingPutBytes: status.pendingPutBytes,
    pendingOperations: status.pendingOperations,
    asyncSyncActive: status.asyncSyncActive,
  };
}

function deliverPendingHeartbeat(done, timeoutMs) {
  const delivery = pendingHeartbeatDelivery;
  if (!delivery) throw new Error('missing pending heartbeat delivery');
  heartbeatDeliveryInFlight = true;
  postJson(heartbeatTarget, delivery.body, timeoutMs, (failed, reason) => {
    heartbeatDeliveryInFlight = false;
    if (failed) {
      pipelineAccounting.failDelivery();
    } else {
      pipelineAccounting.completeDelivery();
      pendingHeartbeatDelivery = undefined;
    }
    const intentionallySuperseded = !delivery.shutdownFinal
      && closing
      && reason === GRACEFUL_SHUTDOWN_SUPERSEDE;
    if (failed && !intentionallySuperseded) {
      // The failed heartbeat window remains frozen for an exact retry. Its own transport failure
      // belongs to the active next window, not to the payload whose delivery is uncertain. A
      // heartbeat transport failure is control evidence, not an event-output loss.
      attributionCounts.heartbeatDeliveryFailures++;
      errorCount++;
    }
    done(Boolean(failed));
  });
}

function sendHeartbeat(done = () => {}, timeoutMs = CONTROL_HTTP_TIMEOUT_MS, shutdownFinal = false) {
  if (!HEARTBEAT_SECS) {
    done(false);
    return;
  }
  if (heartbeatDeliveryInFlight) {
    // Periodic heartbeats may overlap a slow control request. Keep both active and frozen windows
    // intact; a later interval will retry rather than duplicate the in-flight sequence.
    done(false);
    return;
  }
  if (shutdownFinal && pendingHeartbeatDelivery && !pendingHeartbeatDelivery.shutdownFinal) {
    // Shutdown has already aborted the old in-flight control request, so its delivery is
    // indeterminate. Do not rewrite or merge that sequence, and do not spend the final bounded
    // control slot retrying it ahead of lifecycle evidence. Advancing the sequence makes the
    // uncertainty an explicit API-visible gap while the final heartbeat reports only the active
    // shutdown delta and always carries shutdownFinal=true.
    pipelineAccounting.abandonPendingDelivery();
    pendingHeartbeatDelivery = undefined;
  }
  if (pendingHeartbeatDelivery) {
    const retriedWindow = pipelineAccounting.beginDelivery();
    if (!retriedWindow) {
      done(false);
      return;
    }
    deliverPendingHeartbeat(done, timeoutMs);
    return;
  }
  const eventQueues = eventQueueMetrics();
  const spoolMetrics = durableSpoolMetrics();
  const controlPlane = controlPlaneMetrics();
  const accountingWindow = pipelineAccounting.beginDelivery({
    queueEvents: eventQueues.queueDepth,
    queueBytes: eventQueues.queueBytes,
    inflightEvents: eventQueues.inflightEvents,
    inflightBytes: eventQueues.inflightBytes,
    retryEvents: eventQueues.retryOutstandingEvents,
    retryBytes: eventQueues.retryOutstandingBytes,
    outstandingEvents: eventQueues.outstandingEvents,
    outstandingBytes: eventQueues.outstandingBytes,
  });
  // A slow heartbeat must not create concurrent deliveries for the same delta window. The next
  // interval (or shutdown heartbeat after aborting the old request) retries the frozen payload.
  if (!accountingWindow) {
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
  const filterRules = filterRulePublisher.metrics();
  const captureProfileReports = captureProfileReporter.metrics();
  const infrastructureRules = infrastructurePolicy.metrics();
  const unifiedRules = unifiedFilterPolicy.metrics();
  const fileAggregation = fileAccessAggregator.metrics();
  const signatures = processes.runtimeSignatures || {};
  const reloader = signatureReloader?.metrics() || {};
  eventKindCounts = Object.create(null);
  attributionCounts = emptyAttributionCounts();
  e2eFilterReceipts = [];
  outputDropped = 0;
  errorCount = 0;
  const status = (
    dropped > 0
    || errors > 0
    || spoolMetrics.parkedRecords > 0
    || spoolMetrics.oldestAgeMs > SPOOL_DEGRADED_AGE_MS
    || spoolMetrics.atCapacity
  ) ? 'degraded' : 'ok';
  const e2eMarkerScopeMessage = E2E_INGEST_MARKER_PREFIX
    ? `e2e_marker_scope=enabled; e2e_marker_scoped_out=${classifications.e2eMarkerScopedOut}; `
    : '';
  const heartbeatBody = {
      collectorId: COLLECTOR_ID || undefined,
      nodeName: NODE_NAME || undefined,
      mode: `observer-forwarder:${FILTER_MODE}`,
      status,
      intervalSecs: HEARTBEAT_SECS,
      eventKindCounts: counts,
      queueDepth: eventQueues.queueDepth,
      outputDropped: dropped,
      errorCount: errors,
      // These compatibility counters are reset per successfully frozen Forwarder window. They
      // have never been process-lifetime cumulative counters; make that contract machine-readable.
      legacyCounterTemporality: 'delta',
      pipelineAccounting: accountingWindow,
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
        unknownReasonCounts: classifications.unknownReasons,
        nonAgent: classifications.nonAgent,
        filteredNonAgent: classifications.filteredNonAgent,
        wouldFilterNonAgent: classifications.wouldFilterNonAgent,
        filteredUnknown: classifications.filteredUnknown,
        wouldFilterUnknown: classifications.wouldFilterUnknown,
        lastSuppressedAt: lastNonAgentSuppressedAt || undefined,
        filteredNoise: classifications.filteredNoise,
        wouldFilterNoise: classifications.wouldFilterNoise,
        discoveryBudgetDropped: classifications.discoveryBudgetDropped,
        wouldDiscoveryBudgetDrop: classifications.wouldDiscoveryBudgetDrop,
        // This describes Collector pre-ring behavior, not merely Forwarder retention. A sampled
        // Unknown stream must never be reported as lossless in the enriched heartbeat.
        unknownFileLossless: OBSERVER_FILE_UNKNOWN_POLICY === 'keep',
        unknownFileBudgetLimit: 0,
        unknownFileGlobalBudgetLimit: 0,
        unknownFileBudgetAllowed: 0,
        unknownFileBudgetSuppressed: 0,
        fileAggregationEnabled: FILE_AGGREGATION_ENABLED,
        fileAggregationWindowMs: fileAggregation.windowMs,
        fileAggregationPendingKeys: fileAggregation.pendingKeys,
        fileAggregationCoalesced: fileAggregation.coalesced,
        aggregatedFileEvents: classifications.aggregatedFileEvents,
        aggregationOutputs: classifications.aggregationOutputs,
        captureAggregateOutputs: classifications.captureAggregateOutputs,
        // decision-op summary count; deliberately separate from physical Forwarder event counts.
        captureAggregateDecisionAttempts: classifications.captureAggregateDecisionAttempts,
        protectedQueueDropped: classifications.protectedQueueDropped,
        queueDroppedByClass: classifications.queueDroppedByClass,
        filterRulePublisherEnabled: filterRules.enabled,
        filterRuleEnforceDrops: filterRules.enforceDrops,
        captureProfileMode: filterRules.captureProfileMode,
        captureProfileActivationMode: filterRules.activationMode,
        captureProfileActivationReason: filterRules.activationReason,
        captureProfileControlPlaneState: filterRules.controlPlaneState,
        captureProfileAckEnabled: filterRules.ackEnabled,
        captureProfileAckAccepted: filterRules.ackAccepted,
        captureProfileAckRejected: filterRules.ackRejected,
        captureProfileAckReplayIgnored: filterRules.ackReplayIgnored,
        captureProfileCentralAccepted: filterRules.centralAccepted,
        captureProfileCentralRejected: filterRules.centralRejected,
        captureProfileActivationGrants: filterRules.activationGrants,
        captureProfileActivationRevoked: filterRules.activationRevoked,
        captureProfileIntentChanges: filterRules.intentChanges,
        captureProfileTtlRefreshes: filterRules.ttlRefreshes,
        captureProfileCoalescedTtlRefreshes: filterRules.coalescedTtlRefreshes,
        captureProfileSemanticNoops: filterRules.semanticNoops,
        captureProfileLkgDegraded: filterRules.lkgDegraded,
        captureProfileCapacityEvicted: filterRules.capacityEvicted,
        captureProfileCapacityAgentEvicted: filterRules.capacityAgentEvicted,
        captureProfileOversizeSnapshots: filterRules.oversizeSnapshots,
        captureProfileReportInFlight: captureProfileReports.inFlight,
        captureProfileReportPosts: captureProfileReports.reports,
        captureProfileReportErrors: captureProfileReports.reportErrors,
        captureProfileReportAccepted: captureProfileReports.centralAccepted,
        captureProfileReportRejected: captureProfileReports.centralRejected,
        filterRuleVersion: filterRules.version,
        filterRuleEntries: filterRules.entries,
        filterRuleWrites: filterRules.writes,
        filterRuleErrors: filterRules.errors,
        filterRuleConflicts: filterRules.conflicts,
        unifiedCatalogVersion: unifiedRules.catalogVersion,
        unifiedIdentityVersion: unifiedRules.domainVersions.identity,
        unifiedCaptureVersion: unifiedRules.domainVersions.capture,
        unifiedForwarderVersion: unifiedRules.domainVersions.forwarder,
        unifiedRetentionVersion: unifiedRules.domainVersions.retention,
        unifiedProjectionState: unifiedRules.state,
        unifiedProjectionHash: unifiedRules.contentHash || undefined,
        unifiedProjectionIntentHash: unifiedRules.intentHash || undefined,
        unifiedProjectionLoads: unifiedRules.loads,
        unifiedProjectionLoadErrors: unifiedRules.loadErrors,
        unifiedProjectionDegraded: unifiedRules.degraded,
        unifiedIdentityRules: unifiedRules.identityRules,
        unifiedCaptureRules: unifiedRules.captureProfileRules,
        unifiedSemanticRules: unifiedRules.semanticRetentionRules,
        unifiedRuntimeSignatures: unifiedRules.runtimeSignatures,
        unifiedAgentTemplates: unifiedRules.agentTemplates,
        unifiedIdentityIndexBuckets: unifiedRules.identityIndexBuckets,
        unifiedCaptureIndexBuckets: unifiedRules.captureIndexBuckets,
        unifiedSemanticIndexBuckets: unifiedRules.semanticIndexBuckets,
        unifiedMaxIndexBucketSize: unifiedRules.maxIndexBucketSize,
        unifiedIdentityMatches: unifiedRules.identityMatches,
        unifiedCaptureMatches: unifiedRules.captureMatches,
        unifiedSemanticMatches: unifiedRules.semanticMatches,
        unifiedSampleSuppressed: unifiedRules.sampleSuppressed,
        infrastructurePolicyReady: infrastructureRules.ready,
        infrastructurePolicyVersion: infrastructureRules.policyVersion,
        infrastructurePolicyRules: infrastructureRules.rules,
        infrastructurePolicyLoads: infrastructureRules.loads,
        infrastructurePolicyLoadErrors: infrastructureRules.loadErrors,
        infrastructurePolicyMatches: infrastructureRules.matches,
        infrastructurePolicyWouldDrop: infrastructureRules.wouldDrop,
        infrastructurePolicyEnforced: infrastructureRules.enforced,
        infrastructurePolicyAgentConflicts: infrastructureRules.agentConflicts,
        infrastructurePolicyMaterialized: infrastructureRules.materialized,
        infrastructurePolicyExpiresInSeconds: infrastructureRules.expiresInSeconds,
        ...(filterReceipts.length ? { e2eFilterReceipts: filterReceipts } : {}),
        deduplicated: classifications.deduplicated,
        queueDropped: classifications.queueDropped,
        queueParked: classifications.queueParked,
        batches: classifications.batches,
        batchEvents: classifications.batchEvents,
        retryQueued: classifications.retryQueued,
        retryAttempts: classifications.retryAttempts,
        retryRecovered: classifications.retryRecovered,
        retryExhausted: classifications.retryExhausted,
        retryParked: classifications.retryParked,
        spoolReplayAttempts: classifications.spoolReplayAttempts,
        spoolReplayAdmitted: classifications.spoolReplayAdmitted,
        spoolReplayDeferred: classifications.spoolReplayDeferred,
        heartbeatDeliveryFailures: classifications.heartbeatDeliveryFailures,
        controlPlaneState: controlPlane.state,
        controlPlaneFailedLanes: controlPlane.failedLanes,
        controlPlaneStartingLanes: controlPlane.startingLanes,
        controlPlaneLanes: controlPlane.lanes,
        spoolRecords: spoolMetrics.records,
        spoolActiveRecords: spoolMetrics.activeRecords,
        spoolParkedRecords: spoolMetrics.parkedRecords,
        spoolBytes: spoolMetrics.logicalBytes,
        spoolWalBytes: spoolMetrics.walBytes,
        spoolOldestAgeMs: spoolMetrics.oldestAgeMs,
        spoolAtCapacity: spoolMetrics.atCapacity,
        spoolFsyncMode: spoolMetrics.fsyncMode,
        spoolCompactionDeferred: spoolMetrics.compactionDeferred,
        spoolCompactions: spoolMetrics.compactions,
        spoolCompactMaxLiveRecords: spoolMetrics.compactMaxLiveRecords,
        spoolPendingPutRecords: spoolMetrics.pendingPutRecords,
        spoolPendingPutBytes: spoolMetrics.pendingPutBytes,
        spoolPendingOperations: spoolMetrics.pendingOperations,
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
        protectedReserveEvents: eventQueues.protectedReserveEvents,
        protectedReserveBytes: eventQueues.protectedReserveBytes,
        walPendingEvents: eventQueues.walPendingEvents,
        walPendingBytes: eventQueues.walPendingBytes,
        walPendingEventLimit: eventQueues.walPendingEventLimit,
        walPendingByteLimit: eventQueues.walPendingByteLimit,
        identitySnapshotReady: workload.ready,
        identitySnapshotVersion: workload.version,
        identityKubernetesVersion: workload.sources?.kubernetes?.version,
        identityDockerVersion: workload.sources?.docker?.version,
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
      message: `filter_mode=${FILTER_MODE}; ${e2eMarkerScopeMessage}retain_unknown=${RETAIN_UNKNOWN}; retain_non_agent=${RETAIN_NON_AGENT}; noise_policy=${NOISE_POLICY}; observed=${classifications.observed}; forwarded=${classifications.forwarded}; confirmed_agent=${classifications.confirmedAgent}; probable_agent=${classifications.probableAgent}; unknown=${classifications.unknown}; non_agent=${classifications.nonAgent}; infrastructure=${classifications.infrastructure}; workspace_conflict=${classifications.workspaceConflict}; filtered_non_agent=${classifications.filteredNonAgent}; would_filter_non_agent=${classifications.wouldFilterNonAgent}; filtered_unknown=${classifications.filteredUnknown}; would_filter_unknown=${classifications.wouldFilterUnknown}; filtered_noise=${classifications.filteredNoise}; would_filter_noise=${classifications.wouldFilterNoise}; discovery_budget_dropped=${classifications.discoveryBudgetDropped}; would_discovery_budget_drop=${classifications.wouldDiscoveryBudgetDrop}; aggregated_file_events=${classifications.aggregatedFileEvents}; aggregation_outputs=${classifications.aggregationOutputs}; filter_rule_version=${filterRules.version}; filter_rule_entries=${filterRules.entries}; deduplicated=${classifications.deduplicated}; queue_dropped=${classifications.queueDropped}; queue_parked=${classifications.queueParked}; batches=${classifications.batches}; batch_events=${classifications.batchEvents}; retry_queued=${classifications.retryQueued}; retry_attempts=${classifications.retryAttempts}; retry_recovered=${classifications.retryRecovered}; retry_exhausted=${classifications.retryExhausted}; retry_parked=${classifications.retryParked}; heartbeat_delivery_failures=${classifications.heartbeatDeliveryFailures}; spool_records=${spoolMetrics.records}; spool_parked=${spoolMetrics.parkedRecords}; spool_oldest_ms=${spoolMetrics.oldestAgeMs}; retry_queue_depth=${eventQueues.retryQueueDepth}; retry_outstanding=${eventQueues.retryOutstandingEvents}; outstanding_events=${eventQueues.outstandingEvents}; outstanding_bytes=${eventQueues.outstandingBytes}; identity_snapshot_ready=${workload.ready}; identity_snapshot_version=${workload.version}; identity_snapshot_age_seconds=${workload.ageSeconds}; identity_cache_entries=${workload.entries}; identity_cache_hits=${workload.hits}; identity_cache_misses=${workload.misses}; identity_cgroup_hits=${workload.cgroupHits}; identity_cgroup_misses=${workload.cgroupMisses}; process_cache_hits=${processes.cacheHits}; process_cache_misses=${processes.cacheMisses}; process_proc_reads=${processes.procReads}; process_bootstrap_proc_reads=${processes.bootstrapProcReads}; process_fallback_proc_reads=${processes.fallbackProcReads}; process_ancestry_proc_reads=${processes.ancestryProcReads}; identity_errors=${workload.errors}; docker_enabled=${docker.enabled}; docker_ready=${docker.ready}; docker_entries=${docker.entries}; docker_reconnects=${docker.reconnects}; docker_errors=${docker.errors}; behavior_workloads=${behavior.workloads}; behavior_candidates=${behavior.candidates}; behavior_promoted=${behavior.promoted}; behavior_evicted=${behavior.evicted}; output_drops=${dropped}; errors=${errors}`,
      ...sourceFields(),
  };
  pendingHeartbeatDelivery = { body: heartbeatBody, shutdownFinal };
  deliverPendingHeartbeat(done, timeoutMs);
}

function closeTransports() {
  if (transportsClosed) return;
  transportsClosed = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (spoolReplayTimer) clearTimeout(spoolReplayTimer);
  spoolReplayTimer = undefined;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = undefined;
  captureProfileReporter.close();
  signatureReloader?.close();
  if (infrastructurePolicyTimer) clearInterval(infrastructurePolicyTimer);
  infrastructurePolicyTimer = undefined;
  dockerDiscovery.stop();
  infrastructureResolver.close();
  abortActiveEventRequests('event transport closed');
  abortActiveControlRequests('control transport closed');
  eventHttpAgent.destroy();
  eventHttpsAgent.destroy();
  controlHttpAgent.destroy();
  controlHttpsAgent.destroy();
  try {
    spool.close();
  } catch (error) {
    console.error(`[observer-forward] durable spool close failed: ${error.message}`);
    process.exitCode = 1;
  }
  if (shutdownForceTimer) clearTimeout(shutdownForceTimer);
  shutdownForceTimer = undefined;
}

function queuePriority(kind, classification) {
  if (kind === 'CaptureAggregate') return 0;
  if (kind === 'SecurityAction') return 5;
  if (kind === 'ToolExec' || kind === 'ProcessExit' || kind === 'LlmInteraction') return 4;
  if (classification.attribution?.classification === 'confirmed_agent') return 4;
  if (classification.state === 'agent') return 3;
  if (classification.state === 'unknown') return 2;
  return 0;
}

function queueDropClass(kind, priority) {
  if (kind === 'ToolExec') return 'tool_exec';
  if (kind === 'ProcessExit') return 'process_exit';
  if (kind === 'SecurityAction') return 'security';
  if (kind === 'CollectorHeartbeat') return 'collector_heartbeat';
  if (kind === 'CaptureAggregate') return 'capture_aggregate';
  if (priority >= PROTECTED_PRIORITY) return 'agent';
  return 'other';
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

function recordPipelineCounts(counts) {
  for (const item of counts ?? []) {
    pipelineAccounting.record(item.stage, item.reason, item.count);
  }
}

function trackOutstanding(item) {
  item.settled = false;
  outstandingItems.add(item);
  if (item.spoolId) activeSpoolIds.add(item.spoolId);
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
    if (item.spoolId) activeSpoolIds.delete(item.spoolId);
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
  if (settled > 0 && !closing) scheduleSpoolReplay(0);
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

function recordRetryExhausted(items, operationalError = true, reason = 'retry_exhausted') {
  const unsettled = items.filter((item) => !item.settled);
  const parked = unsettled.filter((item) => item.spoolId).length;
  const durableIds = unsettled.map((item) => item.spoolId).filter(Boolean);
  const count = settleOutstanding(unsettled);
  if (!count) return;
  attributionCounts.retryExhausted += count;
  attributionCounts.retryParked += parked;
  outputDropped += Math.max(0, count - parked);
  pipelineAccounting.record('queue_dropped', reason, count);
  spool.defer(durableIds);
  if (operationalError) errorCount++;
  scheduleSpoolReplay();
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
    recordRetryExhausted(items, true, 'shutdown');
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
  errorCount += outcome.errors;
  recordPipelineCounts(outcome.pipelineCounts);
  inflight = Math.max(0, inflight - 1);
  inflightEvents = Math.max(0, inflightEvents - batch.length);
  inflightBytes = Math.max(0, inflightBytes - itemsBytes(batch));
  for (const item of batch) item.inflightSince = 0;

  const retryItems = outcome.retryItems ?? [];
  const retrySet = new Set(retryItems);
  const terminalItems = batch.filter((item) => !retrySet.has(item));
  const acceptedItems = outcome.acceptedItems ?? [];
  const rejectedItems = outcome.rejectedItems ?? [];
  const acceptedSet = new Set(acceptedItems);
  const rejectedSet = new Set(rejectedItems);
  const unresolvedTerminalItems = terminalItems.filter((item) =>
    !acceptedSet.has(item) && !rejectedSet.has(item));
  const parkedDropped = Math.min(
    outcome.dropped,
    unresolvedTerminalItems.filter((item) => item.spoolId).length,
  );
  outputDropped += Math.max(0, outcome.dropped - parkedDropped);
  if (parkedDropped > 0) {
    if (retryDelivery) attributionCounts.retryParked += parkedDropped;
    else attributionCounts.queueParked += parkedDropped;
  }
  if (acceptedItems.length) {
    spool.ackAsync(acceptedItems.map((item) => item.spoolId).filter(Boolean));
  }
  if (rejectedItems.length) {
    spool.deadLetter(
      rejectedItems
        .filter((item) => item.spoolId)
        .map((item) => ({
          id: item.spoolId,
          body: item.body,
          priority: item.priority,
          queuedAt: item.createdAt,
        })),
      outcome.reason || 'permanent ingest rejection',
    );
  }
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

function recordQueueDrop(kind, priority, reason, durablyParked = false) {
  if (durablyParked) attributionCounts.queueParked++;
  else outputDropped++;
  attributionCounts.queueDropped++;
  const dropClass = queueDropClass(kind, priority);
  attributionCounts.queueDroppedByClass[dropClass] =
    (attributionCounts.queueDroppedByClass[dropClass] || 0) + 1;
  if (priority >= PROTECTED_PRIORITY) attributionCounts.protectedQueueDropped++;
  pipelineAccounting.record('queue_dropped', reason);
}

function dropQueuedItem(item, reason = 'priority_evicted') {
  if (!item) return;
  settleOutstanding([item]);
  recordQueueDrop(item.kind, item.priority, reason, Boolean(item.spoolId));
  scheduleSpoolReplay();
}

function makeQueueRoom(bytes, priority) {
  const protectedTraffic = priority >= PROTECTED_PRIORITY;
  const eventLimit = protectedTraffic
    ? MAX_OUTSTANDING_EVENTS
    : Math.max(0, MAX_OUTSTANDING_EVENTS - PROTECTED_RESERVE_EVENTS);
  const byteLimit = protectedTraffic
    ? MAX_OUTSTANDING_BYTES
    : Math.max(0, MAX_OUTSTANDING_BYTES - PROTECTED_RESERVE_BYTES);
  const exceedsOutstanding = () => (
    outstandingEvents + 1 > eventLimit
    || outstandingBytes + bytes > byteLimit
  );
  while (exceedsOutstanding()) {
    const lowest = pending.lowestPriority();
    if (lowest < 0 || priority <= lowest) return false;
    dropQueuedItem(pending.dropLowest(), 'priority_evicted');
  }
  return true;
}

function inputAtCapacity() {
  return (
    walPendingEvents >= WAL_PENDING_MAX_EVENTS
    || walPendingBytes >= WAL_PENDING_MAX_BYTES
    || spool.atCapacity()
  );
}

function updateInputFlow() {
  if (!rl || closing) return;
  if (inputAtCapacity()) rl.pause();
  else rl.resume();
}

function admitDurableEvent(
  durableBody,
  bytes,
  spoolId,
  priority,
  countForwarded,
  kind,
  recovered,
) {
  if (!makeQueueRoom(bytes, priority)) {
    if (recovered) attributionCounts.spoolReplayDeferred++;
    else recordQueueDrop(
      kind,
      priority,
      priority >= PROTECTED_PRIORITY ? 'outstanding_limit' : 'protected_reserve',
      Boolean(spoolId),
    );
    scheduleSpoolReplay();
    return false;
  }
  const item = {
    body: durableBody,
    spoolId,
    kind,
    priority,
    bytes,
    createdAt: Date.now(),
    retryAttempt: 0,
    retryOwned: false,
    retryStartedAt: 0,
    retryDeadlineAt: 0,
    inflightSince: 0,
    recovered,
    settled: false,
  };
  const result = pending.push(item, priority);
  if (!result.accepted) {
    if (recovered) attributionCounts.spoolReplayDeferred++;
    else recordQueueDrop(kind, priority, 'queue_rejected', Boolean(spoolId));
    scheduleSpoolReplay();
    return false;
  }
  if (result.dropped && !result.droppedIncoming) {
    dropQueuedItem(result.dropped);
  }
  trackOutstanding(item);
  if (!recovered) {
    pipelineAccounting.record(
      'queue_admitted',
      countForwarded ? 'event' : 'collector_heartbeat',
    );
  }
  if (countForwarded) attributionCounts.forwarded++;
  if (pending.length >= BATCH_SIZE) flushPending();
  else scheduleBatch();
  updateInputFlow();
  return true;
}

function enqueue(body, priority, countForwarded = true, kind = '', recovered = false) {
  const observedAt = Number(body.observedAt) || Date.now();
  const durableBody = body.observedAt ? body : { ...body, observedAt };
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(durableBody));
  } catch {
    recordQueueDrop(kind, priority, 'serialization_error');
    return false;
  }
  if (bytes > MAX_EVENT_BYTES) {
    recordQueueDrop(kind, priority, 'event_too_large');
    return false;
  }
  const spoolId = kind === 'CollectorHeartbeat'
    ? undefined
    : String(durableBody.sourceEventId || '');
  if (!spoolId || recovered) {
    return admitDurableEvent(
      durableBody,
      bytes,
      spoolId,
      priority,
      countForwarded,
      kind,
      recovered,
    );
  }
  if (
    walPendingEvents + 1 > WAL_PENDING_MAX_EVENTS
    || walPendingBytes + bytes > WAL_PENDING_MAX_BYTES
    || spool.atCapacity()
  ) {
    recordQueueDrop(kind, priority, 'wal_pending_capacity');
    updateInputFlow();
    return false;
  }
  walPendingEvents += 1;
  walPendingBytes += bytes;
  spool.putAsync({
    id: spoolId,
    body: durableBody,
    priority,
    queuedAt: observedAt,
  }, (error, inserted) => {
    walPendingEvents = Math.max(0, walPendingEvents - 1);
    walPendingBytes = Math.max(0, walPendingBytes - bytes);
    if (error) {
      recordQueueDrop(kind, priority, 'durable_spool_error');
      updateInputFlow();
      return;
    }
    if (inserted) {
      admitDurableEvent(
        durableBody,
        bytes,
        spoolId,
        priority,
        countForwarded,
        kind,
        false,
      );
    }
    updateInputFlow();
  });
  updateInputFlow();
  return true;
}

function scheduleSpoolReplay(delayMs = SPOOL_REPLAY_INTERVAL_MS) {
  if (closing || transportsClosed || spoolReplayTimer) return;
  spoolReplayTimer = setTimeout(() => {
    spoolReplayTimer = undefined;
    pumpDurableSpool();
  }, Math.max(0, delayMs));
  spoolReplayTimer.unref();
}

function pumpDurableSpool() {
  if (closing || transportsClosed) return;
  const spoolStatus = spool.status();
  if (spoolStatus.records <= activeSpoolIds.size) {
    scheduleSpoolReplay();
    return;
  }
  const availableSlots = Math.max(0, MAX_OUTSTANDING_EVENTS - outstandingEvents);
  if (availableSlots <= 0 || outstandingBytes >= MAX_OUTSTANDING_BYTES) {
    scheduleSpoolReplay();
    return;
  }
  const records = spool.available(
    activeSpoolIds,
    Math.min(SPOOL_REPLAY_BATCH_SIZE, availableSlots),
  );
  let admitted = 0;
  for (const record of records) {
    attributionCounts.spoolReplayAttempts++;
    if (!enqueue(
      record.body,
      record.priority,
      false,
      durableRecordKind(record.body),
      true,
    )) break;
    admitted++;
    attributionCounts.spoolReplayAdmitted++;
  }
  if (admitted > 0) pumpEventWork();
  scheduleSpoolReplay(admitted > 0 ? 0 : SPOOL_REPLAY_INTERVAL_MS);
}

function abandonPendingEvents() {
  if (pending.length === 0) return;
  while (pending.length > 0) dropQueuedItem(pending.dropLowest(), 'shutdown');
}

function abandonRetryEvents() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (retryTasks.length === 0) return;
  const abandoned = retryTasks.splice(0).flatMap((task) => task.items);
  recordRetryExhausted(abandoned, true, 'shutdown');
}

function remainingShutdownMs() {
  return Math.max(100, shutdownDeadline - Date.now());
}

function sendFinalHeartbeat(done) {
  const attempt = () => {
    const remainingMs = remainingShutdownMs();
    const timeoutMs = Math.min(5_000, remainingMs);
    sendHeartbeat((failed) => {
      if (failed && Date.now() + 100 < shutdownDeadline) {
        setTimeout(attempt, 50);
        return;
      }
      done(Boolean(failed));
    }, timeoutMs, true);
  };
  attempt();
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
    sendFinalHeartbeat(() => closeTransports());
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
  // Stop scheduling new periodic WAL fsync operations before the bounded drain checks the current
  // async operation set. Otherwise a timer can start between the final status read and close(),
  // turning a clean shutdown into a false pending-operation failure.
  spool.prepareClose();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (identitySnapshotTimer) clearInterval(identitySnapshotTimer);
  if (infrastructurePolicyTimer) clearInterval(infrastructurePolicyTimer);
  if (unifiedFilterProjectionTimer) clearInterval(unifiedFilterProjectionTimer);
  if (runtimeSnapshotTimer) clearInterval(runtimeSnapshotTimer);
  if (rootLivenessTimer) clearInterval(rootLivenessTimer);
  if (reconcileTimer) clearTimeout(reconcileTimer);
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = undefined;
  captureProfileReporter.close();
  fileAccessAggregator.flushAll();
  filterRulePublisher.close();
  shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  shutdownForceTimer = setTimeout(forceShutdown, SHUTDOWN_TIMEOUT_MS);
  // Event evidence is already durable in the WAL, while the final runtime snapshot and heartbeat
  // are the only lifecycle proof that the API can use during a rollout. Reserve half of the
  // Forwarder budget for those two serial control requests instead of leaving them an exact,
  // scheduler-fragile five-second tail.
  const controlReserveMs = Math.min(10_000, Math.max(2_000, Math.floor(SHUTDOWN_TIMEOUT_MS / 2)));
  eventDrainDeadline = shutdownDeadline - controlReserveMs;
  pumpEventWork();
  const waitForInflight = () => {
    pumpEventWork();
    const spoolStatus = spool.status();
    const hasEventWork = inflight > 0
      || pending.length > 0
      || retryTasks.length > 0
      || walPendingEvents > 0
      || spoolStatus.pendingOperations > 0
      || spoolStatus.asyncSyncActive;
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

function enqueueClassifiedRecord(record) {
  const {
    observerEvent,
    line,
    classification,
    activity,
    classificationSemantics,
    filterDecision: decision,
    semanticDecision,
    representedEvents = 1,
  } = record;
  const kind = eventKind(observerEvent);
  const nextSourceEventId = sourceEventId(line);
  const sourceSequence = sourceEventSequence;
  bumpEventKind(observerEvent);
  if (representedEvents > 1) {
    attributionCounts.aggregatedFileEvents += representedEvents - 1;
    attributionCounts.aggregationOutputs++;
    pipelineAccounting.record('aggregated', 'file_access_coalesced', representedEvents - 1);
  }
  enqueue(
    {
      line,
      sourceEventId: nextSourceEventId,
      // S3 rollout-resolved view. It was computed once from the final internal classification and
      // deliberately ignores any producer-supplied field with the same name.
      ...classificationSemantics,
      ...(classification.attribution ? { attribution: classification.attribution } : {}),
      ...(activity ?? {}),
      attributes: {
        sourceSequence,
        ...(decision ? {
          filterAction: decision.action,
          filterReasonCode: decision.reasonCode,
          filterRuleVersion: decision.ruleVersion,
          filterRuleAuthority: decision.authority,
        } : {}),
        ...(semanticDecision ? {
          filterF2RuleId: semanticDecision.ruleId,
          filterF2RuleRevision: semanticDecision.ruleRevision,
          filterF2Action: semanticDecision.action,
          filterF2ReasonCode: semanticDecision.reasonCode,
          filterRuleCatalogVersion: semanticDecision.catalogVersion,
          filterRuleForwarderVersion: semanticDecision.domainVersion,
        } : {}),
      },
      ...(COLLECTOR_ID ? { collectorId: COLLECTOR_ID } : {}),
      ...(NODE_NAME ? { nodeName: NODE_NAME } : {}),
      ...sourceFields(classification.state === 'agent' ? classification.workspacePath : ''),
    },
    queuePriority(kind, classification),
    true,
    kind,
  );
}

function handleLine(raw) {
  const line = raw.trim();
  if (!line) return;
  pipelineAccounting.record('received', 'input');
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    // Collector human log lines and partial writes are intentionally ignored, but remain visible
    // as an explicit parse boundary loss instead of disappearing from the conservation chain.
    pipelineAccounting.record('parse_error', 'invalid_json');
    return;
  }
  const kind = eventKind(o);
  if (kind === 'CollectorHeartbeat') {
    // Collector health is control-plane telemetry, not Agent activity. It must reach the raw
    // heartbeat ingest seam even when Enforce suppresses unknown workloads, and it must not
    // inflate Agent observed/unknown/forwarded classification counters.
    pipelineAccounting.record('classified', 'collector_heartbeat');
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
      kind,
    );
    return;
  }
  if (kind === 'CaptureAggregate') {
    const summary = o.event.CaptureAggregate;
    // Observer summaries use `count` as decision-op units. Older development fixtures used an
    // attempted alias; accept it only as a compatibility fallback while never mixing the value
    // into physical event/ring counters.
    const attempted = Number(
      summary?.count
      ?? summary?.decisionAttempted
      ?? summary?.decision_attempted
      ?? summary?.attempted,
    );
    attributionCounts.captureAggregateOutputs++;
    if (Number.isSafeInteger(attempted) && attempted >= 0) {
      attributionCounts.captureAggregateDecisionAttempts += attempted;
    }
    // The summary is already a bounded capture decision output. Preserve its own profile metadata
    // and do not run workload/PID classification, behavior discovery, identity counters, raw
    // filtering, file coalescing, or profile learning a second time.
    pipelineAccounting.record('classified', 'capture_aggregate');
    const nextSourceEventId = sourceEventId(line);
    const sourceSequence = sourceEventSequence;
    bumpEventKind(o);
    enqueue({
      line,
      sourceEventId: nextSourceEventId,
      attributes: {
        sourceSequence,
        captureAggregate: true,
        captureWindowStartUnixNs: String(
          summary?.windowStartUnixNsExact
          ?? summary?.window_start_unix_ns_exact
          ?? summary?.windowStartUnixNs
          ?? summary?.window_start_unix_ns
          ?? '',
        ),
        captureWindowEndUnixNs: String(
          summary?.windowEndUnixNsExact
          ?? summary?.window_end_unix_ns_exact
          ?? summary?.windowEndUnixNs
          ?? summary?.window_end_unix_ns
          ?? '',
        ),
        captureCgroupId: String(summary?.cgroupId ?? summary?.cgroup_id ?? ''),
        captureProbe: summary?.probe,
        captureEffectiveAction: summary?.effectiveAction ?? summary?.effective_action ?? summary?.action,
        captureQualifier: summary?.qualifier,
        captureProfile: summary?.profile,
        captureEpoch: summary?.epoch,
        capturePolicyVersion: summary?.policyVersion ?? summary?.policy_version,
        captureCount: Number.isSafeInteger(attempted) && attempted >= 0 ? attempted : undefined,
        captureBytes: Number.isSafeInteger(Number(summary?.bytes)) && Number(summary?.bytes) >= 0
          ? Number(summary.bytes)
          : undefined,
        captureAuthority: summary?.authority,
        captureReason: summary?.reason,
        captureTerminal: summary?.terminal === true,
      },
      eventCategory: 'runtime',
      ...(COLLECTOR_ID ? { collectorId: COLLECTOR_ID } : {}),
      ...(NODE_NAME ? { nodeName: NODE_NAME } : {}),
      ...sourceFields(''),
    }, 0, true, kind);
    return;
  }
  attributionCounts.observed++;
  if (toolExecDeduper.isDuplicate(o)) {
    attributionCounts.deduplicated++;
    pipelineAccounting.record('filtered', 'deduplicated');
    return;
  }
  const processClassification = attributor.classify(o);
  const workloadClassification = workloadCache.classify(o);
  const activity = classifyEventActivity(o, processClassification, workloadClassification);
  const templateClassification = templateRegistry.classifyEvent(o);
  const baseClassification = mergeAttributionClassifications(
    processClassification,
    workloadClassification,
    templateClassification,
  ) ?? processClassification;
  let catalogClassification = baseClassification;
  let trustedNonAgentRuleId = '';
  for (const candidate of unifiedFilterPolicy.identityCandidates(o, catalogClassification)) {
    if (
      candidate.attribution?.classification === 'non_agent'
      && TRUSTED_NON_AGENT_PROCESS_FAMILY_RULES.has(candidate.ruleId)
    ) {
      trustedNonAgentRuleId = candidate.ruleId;
    }
    catalogClassification = mergeAttributionClassifications(catalogClassification, candidate)
      ?? catalogClassification;
  }
  if (
    trustedNonAgentRuleId
    && catalogClassification.state === 'non_agent'
    && catalogClassification.attribution?.classification === 'non_agent'
    && catalogClassification.attribution?.conflict !== true
  ) {
    attributor.rememberTrustedNonAgent(o, trustedNonAgentRuleId);
  }
  const infrastructureEvaluation = infrastructurePolicy.evaluate(o, workloadClassification);
  // Stable authoritative inventory is resolved before heuristic behavior discovery. A weak
  // high-volume file pattern must never promote ClickHouse/Postgres into a probable Agent and then
  // defeat its exact Infrastructure rule. Existing positive Agent signatures/labels remain in
  // baseClassification and still win during the merge below.
  const authoritativeInfrastructure =
    infrastructureEvaluation?.classification?.state === 'infrastructure';
  const identityClassification =
    (!authoritativeInfrastructure && behaviorDiscoveryEligible(catalogClassification)
      ? behaviorDetector.observe(o, catalogClassification.attribution)
      : undefined) ??
    catalogClassification;
  const classification = infrastructureEvaluation?.classification
    ? mergeAttributionClassifications(
        identityClassification,
        infrastructureEvaluation.classification,
      ) ?? identityClassification
    : identityClassification;
  const classificationSemantics = classificationSemanticsEnvelope(classification, o);
  const unknownReason = classificationSemantics.classificationSemantics?.unknownReason;
  if (unknownReason) {
    attributionCounts.unknownReasons[unknownReason] =
      (attributionCounts.unknownReasons[unknownReason] || 0) + 1;
  }
  if (
    infrastructureEvaluation
    && classification.state === 'agent'
    && infrastructureEvaluation.resolution.role === 'infrastructure'
  ) {
    infrastructurePolicy.recordAgentConflict();
  }
  const catalogCaptureDecision = unifiedFilterPolicy.captureDecision(o, classification);
  const resolvedCaptureDecision = catalogCaptureDecision?.captureProfile === 'investigation_full'
    ? catalogCaptureDecision
    : (CAPTURE_PROFILE_MODE === 'legacy'
        ? infrastructureEvaluation?.fileDecision
        : infrastructureEvaluation?.captureDecision)
      ?? catalogCaptureDecision;
  const decision = filterRulePublisher.observe(
    o,
    classification,
    resolvedCaptureDecision,
  );
  // Runtime lifecycle is rooted in ProcessKey, but placement/confirmation can come from Docker,
  // Kubernetes, or a trusted template. Enrich the root after field-level merge without replacing
  // its process-instance ID with a workload-level ID.
  attributor.enrichRuntimeRoot(processClassification, classification);
  const classificationName = classification.attribution?.classification;
  if (classification.state === 'agent' && classificationName === 'confirmed_agent') {
    attributionCounts.confirmedAgent++;
    pipelineAccounting.record('classified', 'confirmed_agent');
  } else if (classification.state === 'agent') {
    attributionCounts.probableAgent++;
    pipelineAccounting.record('classified', 'probable_agent');
  } else if (classification.state === 'infrastructure') {
    attributionCounts.infrastructure++;
    attributionCounts.nonAgent++;
    pipelineAccounting.record('classified', 'infrastructure');
  } else if (classification.state === 'non_agent') {
    attributionCounts.nonAgent++;
    pipelineAccounting.record('classified', 'non_agent');
  } else {
    attributionCounts.unknown++;
    pipelineAccounting.record('classified', 'unknown');
  }
  if (classification.workspaceConflict || classification.attribution?.conflict) {
    attributionCounts.workspaceConflict++;
  }
  let filterReason = '';
  // Control-plane, lifecycle and security evidence is protected independently of how the
  // workload identity was learned. Exact self/manual non-Agent inventory may suppress routine
  // syscall detail, but it must never suppress these event kinds merely because no central
  // Infrastructure rule happened to materialize for the same workload.
  const semanticDecision = unifiedFilterPolicy.semanticDecision(o, classification);
  const trustedLifecycleSuppression = (
    (kind === 'ToolExec' || kind === 'ProcessExit')
    && semanticDecision?.action === 'suppress'
    && PROTECTED_LIFECYCLE_SUPPRESSION_RULES.has(semanticDecision.ruleId)
  );
  const alwaysKeep = alwaysKeepEventKind(kind) && !trustedLifecycleSuppression;
  if (!alwaysKeep && semanticDecision) {
    if (semanticDecision.action === 'suppress') {
      filterReason = semanticDecision.reasonCode || 'non_agent';
    } else if (
      semanticDecision.action === 'sample'
      && !unifiedFilterPolicy.shouldKeepSample(
        `${semanticDecision.ruleId}:${classification.attribution?.physicalWorkloadId || classification.attribution?.agentInstanceId || kind}`,
      )
    ) {
      filterReason = 'semantic_sample';
    }
  } else if (!alwaysKeep && !unifiedFilterPolicy.active()) {
    if (
      (classification.state === 'non_agent' || classification.state === 'infrastructure')
      && !RETAIN_NON_AGENT
      && (
        classification.state !== 'infrastructure'
        || !infrastructureEvaluation
        || infrastructureEvaluation.decision?.action === 'drop'
      )
    ) {
      filterReason = 'non_agent';
    } else if (
      NOISE_POLICY === 'balanced'
      && (classification.state === 'non_agent' || classification.state === 'infrastructure')
      && isNoise(o)
    ) {
      // Paths may reduce an already proven non-Agent workload, but can never turn Unknown into a
      // negative identity or silently suppress its evidence.
      filterReason = 'routine_noise';
    }
  }
  if (filterReason) {
    recordE2eFilterReceipt(o, classification, filterReason, line);
    if (FILTER_MODE === 'shadow') {
      if (filterReason === 'non_agent') attributionCounts.wouldFilterNonAgent++;
      else if (filterReason === 'unknown') attributionCounts.wouldFilterUnknown++;
      else if (filterReason === 'discovery_budget') attributionCounts.wouldDiscoveryBudgetDrop++;
      else attributionCounts.wouldFilterNoise++;
    } else {
      if (filterReason === 'non_agent') {
        attributionCounts.filteredNonAgent++;
        lastNonAgentSuppressedAt = new Date().toISOString();
      } else if (filterReason === 'unknown') {
        attributionCounts.filteredUnknown++;
      } else if (filterReason === 'discovery_budget') {
        attributionCounts.discoveryBudgetDropped++;
      } else {
        attributionCounts.filteredNoise++;
      }
      pipelineAccounting.record('filtered', filterReason);
      return;
    }
  }
  if (!matchesE2eIngestMarkerScope(o)) {
    attributionCounts.e2eMarkerScopedOut++;
    pipelineAccounting.record('filtered', 'e2e_scope');
    return;
  }
  const record = {
    observerEvent: o,
    line,
    classification,
    activity,
    classificationSemantics,
    filterDecision: decision,
    semanticDecision,
    processStartTime: attributor.stableProcessStartTime(o),
  };
  if (FILE_AGGREGATION_ENABLED && kind === 'FileAccess') {
    fileAccessAggregator.push(record, enqueueClassifiedRecord);
  } else {
    enqueueClassifiedRecord(record);
  }
}

async function start() {
  resolveObserverForwarderHostPid();
  // Attach stdin before the first asynchronous startup step. A short-lived collector or a test
  // pipe can write its complete NDJSON stream and close while infrastructure/Docker discovery is
  // still initializing. Creating readline afterwards loses that already-ended stream and lets the
  // process exit successfully without forwarding any evidence. Pausing the interface keeps the
  // kernel pipe as the bounded startup buffer, so producers naturally see backpressure until the
  // identity state is ready; resuming preserves the original line order without an unbounded JS
  // queue.
  rl = readline.createInterface({ input: process.stdin });
  rl.pause();
  rl.on('line', handleLine);
  rl.on('close', flushAndClose);
  const spoolStatus = spool.status();
  console.error(
    `[observer-forward] durable spool: writer=${WRITER_ID}; path=${spoolStatus.filePath}; `
    + `recovered=${spoolStatus.records}; bytes=${spoolStatus.logicalBytes}; `
    + `fsync=${spoolStatus.fsyncMode}`,
  );
  pumpDurableSpool();

  // The central catalog is the authoritative definition source. ConfigMap signatures and
  // deployment environment values above remain a bounded bootstrap/LKG path only; wait for one
  // short control request before scanning existing processes so a newly enforced signature does
  // not miss an Agent that started before the Forwarder.
  await new Promise((resolve) => refreshUnifiedFilterProjection(resolve));
  if (closing) return;

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
  if (signatureFile && !unifiedFilterPolicy.active()) {
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
  if (CAPTURE_PROFILE_MODE !== 'legacy') captureProfileReporter.start();
  if (UNIFIED_FILTER_PROJECTION_SECS > 0) {
    unifiedFilterProjectionTimer = setInterval(
      refreshUnifiedFilterProjection,
      UNIFIED_FILTER_PROJECTION_SECS * 1_000,
    );
    unifiedFilterProjectionTimer.unref();
  }
  refreshInfrastructurePolicy();
  if (INFRASTRUCTURE_POLICY_SECS > 0) {
    infrastructurePolicyTimer = setInterval(
      refreshInfrastructurePolicy,
      INFRASTRUCTURE_POLICY_SECS * 1_000,
    );
    infrastructurePolicyTimer.unref();
  }
  const dockerStarted = await dockerDiscovery.start((snapshot) => {
    tlsAgentCgroupPublisher.publish(snapshot);
    if (workloadCache.replace(snapshot, 'docker')) synchronizeInfrastructurePolicyRules();
  });
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

  rl.resume();
}

process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));

void start().catch((error) => {
  console.error('[observer-forward] startup failed:', error instanceof Error ? error.message : String(error));
  process.stdin.pause();
  if (typeof process.stdin.unref === 'function') process.stdin.unref();
  rl?.close();
  closeTransports();
  process.exitCode = 1;
});
