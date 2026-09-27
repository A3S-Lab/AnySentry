#!/usr/bin/env node
/**
 * Poll AnySentry collector + identity snapshot until Observer control-plane
 * readiness is proven. Replaces fixed OBSERVER_STARTUP_SETTLE_SECONDS sleeps.
 *
 * Plane gates (always):
 *   filterMetricsReported, identitySnapshotReady, unifiedProjectionState=ready,
 *   captureProfileControlPlaneState=ready (when reported), optional dockerReady
 *
 * Workload gates (optional):
 *   OBSERVER_READY_MIN_DOCKER_ENTRIES — Observer docker inventory size via
 *     collectors/health filterMetrics (this is the cold-start signal for host
 *     compose labs).
 *   OBSERVER_READY_CONTAINER_NAMES / OBSERVER_READY_AGENT_IDS — match reviewed
 *     platform /identity/snapshot entries. Only enable when those agents are
 *     expected in the control-plane snapshot; Observer-local docker discovery
 *     is NOT mirrored there today.
 *
 * Exit 0 only when every requested gate is true. Never marks missing evidence
 * as success. Does not push, deploy, or mutate rules.
 *
 * Env:
 *   ANYSENTRY_API_BASE / API_BASE
 *   ANYSENTRY_MANAGEMENT_TOKEN / ANYSENTRY_ADMIN_TOKEN
 *   OBSERVER_READY_TIMEOUT_MS (default 180000)
 *   OBSERVER_READY_POLL_MS (default 2000)
 *   OBSERVER_READY_REQUIRE_DOCKER (default 1)
 *   OBSERVER_READY_MAX_SNAPSHOT_AGE_SEC (default 90)
 *   OBSERVER_READY_CONTAINER_NAMES  comma list
 *   OBSERVER_READY_AGENT_IDS       comma list
 *   OBSERVER_READY_MIN_DOCKER_ENTRIES (default 0)
 */
import { managementAuthHeaders } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '32653'}/security-center`)
  .replace(/\/$/, '');

const timeoutMs = positiveInt(process.env.OBSERVER_READY_TIMEOUT_MS, 180_000, 600_000);
const pollMs = positiveInt(process.env.OBSERVER_READY_POLL_MS, 2_000, 30_000);
const requireDocker = (process.env.OBSERVER_READY_REQUIRE_DOCKER ?? '1') !== '0';
const maxSnapshotAgeSec = positiveInt(process.env.OBSERVER_READY_MAX_SNAPSHOT_AGE_SEC, 90, 600);
const minDockerEntries = positiveInt(process.env.OBSERVER_READY_MIN_DOCKER_ENTRIES, 0, 10_000);
const containerNames = csv(process.env.OBSERVER_READY_CONTAINER_NAMES);
const agentIds = csv(process.env.OBSERVER_READY_AGENT_IDS);

function positiveInt(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function csv(raw) {
  return String(raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function authHeaders() {
  const headers = { 'content-type': 'application/json', ...managementAuthHeaders() };
  const token = (process.env.ANYSENTRY_MANAGEMENT_TOKEN
    ?? process.env.ANYSENTRY_ADMIN_TOKEN
    ?? '').trim();
  if (token && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request(path, method = 'GET', body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }
  return payload?.data ?? payload;
}

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

function entryNames(entry) {
  return [
    entry?.containerName,
    entry?.agentDisplayName,
    entry?.agentScopeId,
    ...(Array.isArray(entry?.ids) ? entry.ids : []),
  ].map(normalizeName).filter(Boolean);
}

function entryMatchesWant(entry, want) {
  const names = entryNames(entry);
  const agentScope = normalizeName(entry?.agentScopeId);
  return agentScope === want || names.some((have) => have === want || have.includes(want));
}

function entryMatches(entry) {
  // When both lists are set, an entry must hit at least one requested name and
  // one requested agent id (AND across dimensions). Missing members are checked
  // separately in evaluateWorkload so partial discovery cannot pass.
  const nameHit = containerNames.length === 0
    || containerNames.some((want) => entryMatchesWant(entry, want));
  const agentHit = agentIds.length === 0
    || agentIds.some((want) => entryMatchesWant(entry, want));
  return nameHit && agentHit;
}

function evaluatePlane(healthItem) {
  const metrics = healthItem?.filterMetrics ?? {};
  const reasons = [];
  if (!healthItem) reasons.push('collector_health_missing');
  if (healthItem && healthItem.filterMetricsReported !== true) reasons.push('filter_metrics_not_reported');
  if (metrics.identitySnapshotReady !== true) reasons.push('identity_snapshot_not_ready');
  if (metrics.unifiedProjectionState !== 'ready') {
    reasons.push(`unified_projection_${metrics.unifiedProjectionState ?? 'missing'}`);
  }
  if (metrics.captureProfileControlPlaneState
    && metrics.captureProfileControlPlaneState !== 'ready') {
    reasons.push(`capture_profile_${metrics.captureProfileControlPlaneState}`);
  }
  if (requireDocker && metrics.dockerReady !== true) reasons.push('docker_not_ready');
  const age = Number(metrics.identitySnapshotAgeSeconds);
  if (Number.isFinite(age) && age > maxSnapshotAgeSec) {
    reasons.push(`identity_snapshot_stale_${age}s`);
  }
  if (minDockerEntries > 0 && Number(metrics.dockerEntries ?? 0) < minDockerEntries) {
    reasons.push(`docker_entries_${metrics.dockerEntries ?? 0}_lt_${minDockerEntries}`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    summary: {
      collectorId: healthItem?.collectorId,
      state: healthItem?.state,
      filterMetricsReported: healthItem?.filterMetricsReported === true,
      identitySnapshotReady: metrics.identitySnapshotReady === true,
      unifiedProjectionState: metrics.unifiedProjectionState ?? null,
      captureProfileControlPlaneState: metrics.captureProfileControlPlaneState ?? null,
      dockerReady: metrics.dockerReady === true,
      dockerEntries: metrics.dockerEntries ?? 0,
      identitySnapshotAgeSeconds: metrics.identitySnapshotAgeSeconds ?? null,
      identitySnapshotVersion: metrics.identitySnapshotVersion ?? null,
      filterRuleVersion: metrics.filterRuleVersion ?? null,
      unifiedCatalogVersion: metrics.unifiedCatalogVersion ?? null,
      queueDropped: metrics.queueDropped ?? 0,
      queueDepth: metrics.queueDepth ?? metrics.queueBytes ?? null,
    },
  };
}

function evaluateWorkload(snapshot) {
  if (containerNames.length === 0 && agentIds.length === 0) {
    return { ok: true, reasons: [], matched: [], ready: snapshot?.ready === true };
  }
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const matched = entries.filter(entryMatches);
  const reasons = [];
  if (snapshot?.ready !== true) reasons.push('identity_snapshot_payload_not_ready');
  const missingAgents = agentIds.filter(
    (want) => !entries.some((entry) => entryMatchesWant(entry, want)),
  );
  const missingContainers = containerNames.filter(
    (want) => !entries.some((entry) => entryMatchesWant(entry, want)),
  );
  if (missingAgents.length) reasons.push(`missing_agents:${missingAgents.join('|')}`);
  if (missingContainers.length) reasons.push(`missing_containers:${missingContainers.join('|')}`);
  if (matched.length === 0 && reasons.length === 0) {
    reasons.push('required_workloads_missing');
  }
  return {
    ok: reasons.length === 0,
    reasons,
    matched: matched.map((entry) => ({
      containerName: entry.containerName,
      agentScopeId: entry.agentScopeId,
      classification: entry.classification,
      physicalWorkloadId: entry.physicalWorkloadId,
    })),
    ready: snapshot?.ready === true,
    entryCount: entries.length,
  };
}

async function sample() {
  const health = await request('/collectors/health', 'POST', {
    timeType: 'last_1h',
    limit: 10,
  });
  const items = Array.isArray(health?.items) ? health.items : [];
  const preferred = items.find((item) => item?.state === 'healthy' && item.filterMetricsReported)
    ?? items.find((item) => item?.filterMetricsReported)
    ?? items[0];
  const plane = evaluatePlane(preferred);

  let workload = { ok: true, reasons: [], matched: [] };
  if (containerNames.length || agentIds.length) {
    const snapshot = await request('/identity/snapshot');
    workload = evaluateWorkload(snapshot);
  }
  return { plane, workload, at: new Date().toISOString() };
}

async function main() {
  const started = Date.now();
  let last;
  console.log(JSON.stringify({
    event: 'observer_readiness_wait_start',
    baseUrl,
    timeoutMs,
    pollMs,
    requireDocker,
    maxSnapshotAgeSec,
    minDockerEntries,
    containerNames,
    agentIds,
  }));

  while (Date.now() - started <= timeoutMs) {
    try {
      last = await sample();
      const ok = last.plane.ok && last.workload.ok;
      console.log(JSON.stringify({
        event: 'observer_readiness_sample',
        elapsedMs: Date.now() - started,
        ok,
        plane: last.plane.summary,
        planeReasons: last.plane.reasons,
        workloadReady: last.workload.ready,
        workloadMatched: last.workload.matched,
        workloadReasons: last.workload.reasons,
      }));
      if (ok) {
        console.log(JSON.stringify({
          event: 'observer_readiness_ready',
          elapsedMs: Date.now() - started,
          plane: last.plane.summary,
          workloadMatched: last.workload.matched,
        }));
        return;
      }
    } catch (error) {
      last = { error: String(error?.message ?? error) };
      console.log(JSON.stringify({
        event: 'observer_readiness_error',
        elapsedMs: Date.now() - started,
        error: last.error,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  console.error(JSON.stringify({
    event: 'observer_readiness_timeout',
    elapsedMs: Date.now() - started,
    last,
  }));
  process.exitCode = 1;
}

await main();
