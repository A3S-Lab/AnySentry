#!/usr/bin/env node
// Bridge a3s-observer NDJSON (stdin) -> AnySentry /ingest. Node stdlib only (apt-free container).
//   a3s-observer-collector | node observer-forward.js
// Target from ANYSENTRY_INGEST_URL (default http://localhost:29653/security-center/ingest).
//
// Backpressure is essential: a busy node emits a firehose of events. We cap in-flight POSTs and
// pause reading when at the cap — so memory stays flat and, under extreme load, the collector
// (which drops on a slow consumer by design) sheds the excess rather than us OOMing.
//
// Agent scope is fail-open for attribution: known Agent and unresolved events are forwarded, and
// only events with a complete non-Agent PID ancestry are dropped. The legacy all/shadow modes also
// remove pseudo-filesystem file noise; override those prefixes via FORWARD_DROP_PATHS.
const http = require('node:http');
const https = require('node:https');
const readline = require('node:readline');
const { AgentAttributor } = require('./observer-agent-attribution');
const { ToolExecDeduper } = require('./observer-event-dedup');
const { WorkloadIdentityCache } = require('./observer-workload-filter');

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

const MAX_INFLIGHT = Number(process.env.FORWARD_MAX_INFLIGHT || 24);
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
const IDENTITY_SNAPSHOT_SECS = Math.max(0, Number(process.env.ANYSENTRY_IDENTITY_SNAPSHOT_SECS || 15));
const identitySnapshotTarget = new URL(
  process.env.ANYSENTRY_IDENTITY_SNAPSHOT_URL || defaultIdentitySnapshotUrl(target),
);
if (NODE_NAME) identitySnapshotTarget.searchParams.set('nodeName', NODE_NAME);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT });
const attributor = new AgentAttributor();
const workloadCache = new WorkloadIdentityCache();
const bootstrap = attributor.seedFromProc();
console.error(`[observer-forward] process snapshot: scanned=${bootstrap.scanned}; agent_roots=${bootstrap.roots}; agent_descendants=${bootstrap.descendants}`);
const toolExecDeduper = new ToolExecDeduper({
  windowMs: process.env.FORWARD_DEDUP_WINDOW_MS,
  maxKeys: process.env.FORWARD_MAX_DEDUP_KEYS,
});

let inflight = 0;
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
  deduplicated: 0,
};
let closing = false;
let heartbeatTimer;
let identitySnapshotTimer;
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
  eventKindCounts = Object.create(null);
  attributionCounts = {
    observed: 0,
    confirmedAgent: 0,
    probableAgent: 0,
    unknown: 0,
    nonAgent: 0,
    filteredNonAgent: 0,
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
      queueDepth: inflight,
      outputDropped: dropped,
      errorCount: errors,
      message: `scope=${FORWARD_SCOPE}; observed=${classifications.observed}; confirmed_agent=${classifications.confirmedAgent}; probable_agent=${classifications.probableAgent}; unknown=${classifications.unknown}; non_agent=${classifications.nonAgent}; filtered_non_agent=${classifications.filteredNonAgent}; deduplicated=${classifications.deduplicated}; identity_snapshot_ready=${workload.ready}; identity_snapshot_version=${workload.version}; identity_snapshot_age_seconds=${workload.ageSeconds}; identity_cache_entries=${workload.entries}; identity_cache_hits=${workload.hits}; identity_cache_misses=${workload.misses}; identity_errors=${workload.errors}; output_drops=${dropped}; errors=${errors}`,
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
  httpAgent.destroy();
  httpsAgent.destroy();
}

function flushAndClose() {
  if (closing) return;
  closing = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (identitySnapshotTimer) clearInterval(identitySnapshotTimer);
  const deadline = Date.now() + 5000;
  const waitForInflight = () => {
    if (inflight > 0 && Date.now() < deadline) {
      setTimeout(waitForInflight, 50);
      return;
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
  const classification = workloadCache.classify(o) ?? attributor.classify(o);
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
  if (FORWARD_SCOPE === 'agent' && classification.state === 'non_agent') {
    attributionCounts.filteredNonAgent++;
    return;
  }
  // Preserve the legacy pseudo-filesystem noise filter in all/shadow modes. In agent mode,
  // unknown events must survive so incomplete lineage never becomes silent data loss.
  if (FORWARD_SCOPE !== 'agent' && isNoise(o)) return;
  bumpEventKind(o);

  inflight++;
  let settled = false;
  const finish = (failed) => {
    if (settled) return;
    settled = true;
    if (failed) {
      outputDropped++;
      errorCount++;
    }
    inflight = Math.max(0, inflight - 1);
    if (!closing && inflight < MAX_INFLIGHT) rl.resume();
  };

  postJson(
    target,
    {
      line,
      ...(classification.attribution ? { attribution: classification.attribution } : {}),
      ...(COLLECTOR_ID ? { collectorId: COLLECTOR_ID } : {}),
      ...(NODE_NAME ? { nodeName: NODE_NAME } : {}),
      ...sourceFields(),
    },
    5000,
    finish,
  );

  if (inflight >= MAX_INFLIGHT) rl.pause(); // stop reading until requests drain
});

rl.on('close', flushAndClose);
