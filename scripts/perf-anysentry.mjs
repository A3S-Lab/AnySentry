#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { safeProbeId } from './probe-id.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const apiBase = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? 'http://127.0.0.1:29653/security-center').replace(/\/+$/u, '');
const webBase = (process.env.ANYSENTRY_WEB_BASE ?? process.env.WEB_BASE ?? webBaseFromApiBase(apiBase)).replace(/\/+$/u, '');
const runId = process.env.ANYSENTRY_PERF_RUN_ID ?? safeProbeId('perf');
const reportDir = path.resolve(repoRoot, process.env.ANYSENTRY_PERF_REPORT_DIR ?? 'perf-results');
const requestTimeoutMs = positiveInt(process.env.ANYSENTRY_PERF_REQUEST_TIMEOUT_MS, 15000);
const readDurationMs = positiveInt(process.env.ANYSENTRY_PERF_READ_DURATION_MS ?? process.env.ANYSENTRY_PERF_DURATION_MS, 5000);
const writeDurationMs = positiveInt(process.env.ANYSENTRY_PERF_WRITE_DURATION_MS ?? process.env.ANYSENTRY_PERF_DURATION_MS, 7000);
const readConcurrency = positiveInt(process.env.ANYSENTRY_PERF_READ_CONCURRENCY ?? process.env.ANYSENTRY_PERF_CONCURRENCY, 4);
const writeConcurrency = positiveInt(process.env.ANYSENTRY_PERF_WRITE_CONCURRENCY, 2);
const ingestBatchSize = positiveInt(process.env.ANYSENTRY_PERF_INGEST_BATCH_SIZE, 5);
const warmupRequests = positiveInt(process.env.ANYSENTRY_PERF_WARMUP_REQUESTS, 2);
const failOnThreshold = ['1', 'true', 'yes'].includes(String(process.env.ANYSENTRY_PERF_FAIL_ON_THRESHOLD ?? '').toLowerCase());
const enabledScenarios = scenarioFilter(process.env.ANYSENTRY_PERF_SCENARIOS);

const thresholds = {
  errorRate: numberEnv('ANYSENTRY_PERF_MAX_ERROR_RATE', 0),
  readP95Ms: numberEnv('ANYSENTRY_PERF_READ_P95_MS', 1000),
  writeP95Ms: numberEnv('ANYSENTRY_PERF_WRITE_P95_MS', 2000),
};

const capturedEventIds = [];
let observerAgentIds = [];
let sequence = 0;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scenarioFilter(raw) {
  const names = String(raw ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function enabled(name) {
  return !enabledScenarios || enabledScenarios.has(name);
}

function webBaseFromApiBase(base) {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/security-center\/?$/u, '').replace(/\/$/u, '');
  return `${url.origin}${prefix}`;
}

function apiUrl(pathname) {
  return `${apiBase}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function webUrl(pathname) {
  return `${webBase}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...init,
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function requestJson(pathname, init = {}) {
  const res = await fetchWithTimeout(apiUrl(pathname), {
    ...init,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, bytes: Buffer.byteLength(text), json: json?.data ?? json, text };
}

async function requestText(url, init = {}) {
  const res = await fetchWithTimeout(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, bytes: Buffer.byteLength(text), text, contentType: res.headers.get('content-type') ?? '' };
}

async function requestBytes(url, init = {}) {
  const res = await fetchWithTimeout(url, init);
  const bytes = await res.arrayBuffer();
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}: ${Buffer.from(bytes).toString('utf8', 0, 500)}`);
  return { status: res.status, bytes: bytes.byteLength, contentType: res.headers.get('content-type') ?? '' };
}

function eventAttributes(kind, index) {
  const base = {
    'perf.runId': runId,
    'perf.kind': kind,
    'perf.sequence': index,
  };
  if (kind === 'tool') {
    return { kind, argv: ['bash', '-lc', `printf anysentry-perf-${index}`], cwd: '/workspace', attributes: base };
  }
  if (kind === 'llm') {
    return {
      kind,
      endpoint: 'api.openai.com',
      model: 'perf-model',
      promptTokens: 24,
      completionTokens: 12,
      latencyMs: 120,
      attributes: base,
    };
  }
  if (kind === 'egress') {
    return { kind, peer: '203.0.113.10', port: 443, attributes: base };
  }
  return { kind: 'file', path: `/workspace/perf-${index}.txt`, attributes: base };
}

function nextEvents(count, source) {
  const kinds = ['tool', 'llm', 'egress', 'file'];
  return Array.from({ length: count }, () => {
    const index = sequence++;
    const kind = kinds[index % kinds.length];
    return {
      ...eventAttributes(kind, index),
      agentId: `${runId}-${source}-agent-${index % 16}`,
      sessionId: `${runId}-${source}-session-${index % 8}`,
      runId,
      workspacePath: `repo://anysentry/perf/${source}`,
      userId: 'perf-user',
    };
  });
}

function observerLine(index) {
  const eventKinds = ['ToolExec', 'Egress', 'Dns', 'FileAccess'];
  const kind = eventKinds[index % eventKinds.length];
  const agentId = observerAgentIds.length ? observerAgentIds[index % observerAgentIds.length] : `${runId}-observer-agent-${index % 16}`;
  const base = { pid: 1000 + (index % 100), uid: 1000, cwd: '/workspace' };
  const inner =
    kind === 'ToolExec'
      ? { ...base, argv: ['bash', '-lc', `printf anysentry-observer-perf-${index}`] }
      : kind === 'Egress'
        ? { ...base, peer: '203.0.113.20', port: 443 }
        : kind === 'Dns'
          ? { ...base, query: 'api.openai.com' }
          : { ...base, path: `/workspace/observer-perf-${index}.txt` };
  return JSON.stringify({
    identity: {
      agent: agentId,
      session: runId,
      task: `${index}`,
    },
    event: { [kind]: inner },
  });
}

function captureItems(result) {
  for (const item of result?.items ?? []) {
    if (item?.accepted && item.eventId) capturedEventIds.push(item.eventId);
  }
}

async function runLoadScenario(scenario) {
  for (let i = 0; i < warmupRequests; i += 1) {
    await scenario.request(i);
  }

  const startedAt = Date.now();
  const deadline = startedAt + scenario.durationMs;
  const samples = [];
  const errors = [];
  let requestIndex = 0;

  async function worker() {
    while (Date.now() < deadline) {
      const index = requestIndex++;
      const before = performance.now();
      try {
        const result = await scenario.request(index);
        samples.push({
          latencyMs: performance.now() - before,
          status: result.status ?? 200,
          bytes: result.bytes ?? 0,
          events: result.events ?? 0,
        });
      } catch (error) {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          latencyMs: performance.now() - before,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: scenario.concurrency }, () => worker()));
  const finishedAt = Date.now();
  return summarizeScenario(scenario, samples, errors, finishedAt - startedAt);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function round(value, decimals = 2) {
  return Number(value.toFixed(decimals));
}

function summarizeScenario(scenario, samples, errors, elapsedMs) {
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const total = samples.length + errors.length;
  const bytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  const events = samples.reduce((sum, sample) => sum + sample.events, 0);
  const statusCounts = {};
  for (const sample of samples) statusCounts[sample.status] = (statusCounts[sample.status] ?? 0) + 1;

  const result = {
    name: scenario.name,
    group: scenario.group,
    dependencyCoverage: scenario.dependencyCoverage,
    durationMs: elapsedMs,
    concurrency: scenario.concurrency,
    requests: {
      total,
      ok: samples.length,
      failed: errors.length,
      perSecond: round((samples.length / elapsedMs) * 1000),
      errorRate: total ? round(errors.length / total, 4) : 0,
      statusCounts,
    },
    events: {
      accepted: events,
      perSecond: elapsedMs ? round((events / elapsedMs) * 1000) : 0,
    },
    bytes: {
      total: bytes,
      perSecond: elapsedMs ? Math.round((bytes / elapsedMs) * 1000) : 0,
    },
    latencyMs: {
      min: round(latencies[0] ?? 0),
      avg: round(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)),
      p50: round(percentile(latencies, 50)),
      p90: round(percentile(latencies, 90)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies[latencies.length - 1] ?? 0),
    },
    thresholds: evaluateThresholds(scenario, errors, total, percentile(latencies, 95)),
    errorSamples: errors.slice(0, 5),
  };
  result.pass = result.requests.failed === 0 && result.thresholds.every((threshold) => threshold.pass || threshold.warnOnly);
  return result;
}

function evaluateThresholds(scenario, errors, total, p95) {
  const maxP95 = scenario.p95Ms ?? (scenario.group === 'write' ? thresholds.writeP95Ms : thresholds.readP95Ms);
  return [
    {
      metric: 'errorRate',
      actual: total ? round(errors.length / total, 4) : 0,
      limit: thresholds.errorRate,
      pass: total ? errors.length / total <= thresholds.errorRate : true,
      warnOnly: !failOnThreshold,
    },
    {
      metric: 'latency.p95.ms',
      actual: round(p95),
      limit: maxP95,
      pass: p95 <= maxP95,
      warnOnly: !failOnThreshold,
    },
  ];
}

async function discoverDashboardAssets() {
  const root = await requestText(webUrl('/'));
  const assets = [...root.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => new URL(match[1], `${webBase}/`).toString());
  return {
    indexOk: root.text.includes('<div id="root"'),
    rootBytes: root.bytes,
    assets: assets.slice(0, 6),
  };
}

function scenarioDefinitions(dashboard) {
  const aggregatePaths = [
    '/top/healthCard',
    '/top/performanceCard',
    '/risks/summary',
    '/sessions/decisionFunnel',
    '/sessions/agentObservability',
  ];

  const scenarios = [
    {
      name: 'healthz',
      group: 'read',
      dependencyCoverage: ['api', 'policy-state', 'storage-status'],
      durationMs: readDurationMs,
      concurrency: readConcurrency,
      request: async () => {
        const result = await requestJson('/healthz');
        if (result.json?.status !== 'ok') throw new Error(`unexpected healthz payload: ${JSON.stringify(result.json)}`);
        return result;
      },
    },
    {
      name: 'dashboard.index',
      group: 'read',
      dependencyCoverage: ['api-static-server', 'dashboard-html'],
      durationMs: readDurationMs,
      concurrency: Math.max(1, Math.ceil(readConcurrency / 2)),
      request: async () => {
        const result = await requestText(webUrl('/'));
        if (!result.text.includes('<div id="root"')) throw new Error('dashboard root did not return SPA HTML');
        return result;
      },
    },
    {
      name: 'dashboard.assets',
      group: 'read',
      dependencyCoverage: ['api-static-server', 'dashboard-js-css'],
      durationMs: readDurationMs,
      concurrency: Math.max(1, Math.ceil(readConcurrency / 2)),
      p95Ms: numberEnv('ANYSENTRY_PERF_ASSET_P95_MS', 3000),
      request: async (index) => {
        if (!dashboard.assets.length) throw new Error('dashboard index did not expose JS/CSS assets');
        const result = await requestBytes(dashboard.assets[index % dashboard.assets.length]);
        if (result.bytes <= 0) throw new Error('dashboard asset was empty');
        return result;
      },
    },
    {
      name: 'capabilities.discovery',
      group: 'read',
      dependencyCoverage: ['api', 'progressive-api-schema'],
      durationMs: readDurationMs,
      concurrency: readConcurrency,
      request: async (index) => {
        const pathnames = [
          '/capabilities?action=list',
          '/capabilities?action=search&query=runtime%20guard',
          '/capabilities?action=describe&module=security-center&operation=assessRuntimeAction',
        ];
        const result = await requestJson(pathnames[index % pathnames.length]);
        if (!result.json) throw new Error('empty capabilities response');
        return result;
      },
    },
    {
      name: 'progressive.guard.dryRun',
      group: 'read',
      dependencyCoverage: ['api', 'progressive-api-dispatch'],
      durationMs: readDurationMs,
      concurrency: readConcurrency,
      request: async (index) => {
        const result = await requestJson('/capabilities', {
          method: 'POST',
          body: {
            action: 'execute',
            module: 'security-center',
            operation: 'assessRuntimeAction',
            dryRun: true,
            params: {
              autonomy: 'guarded',
              stage: 'tool',
              workspacePath: 'repo://anysentry/perf/dry-run',
              agentId: `${runId}-dry-run-agent-${index % 8}`,
              sessionId: `${runId}-dry-run-session`,
              runId,
              toolName: 'bash',
              command: ['bash', '-lc', 'id'],
            },
          },
        });
        if (result.json?.valid !== true || result.json?.operation !== 'assessRuntimeAction') {
          throw new Error(`unexpected dryRun response: ${JSON.stringify(result.json)}`);
        }
        return result;
      },
    },
    {
      name: 'progressive.recordSecurityEvents',
      group: 'write',
      dependencyCoverage: ['api', 'progressive-api-execute', '@a3s-lab/sentry', 'clickhouse-write'],
      durationMs: writeDurationMs,
      concurrency: writeConcurrency,
      request: async (index) => {
        const result = await requestJson('/capabilities', {
          method: 'POST',
          body: {
            action: 'execute',
            module: 'security-center',
            operation: 'recordSecurityEvents',
            params: {
              sourceName: 'anysentry-perf-progressive',
              sourceType: 'custom',
              collectorId: `${runId}-progressive-collector`,
              workspacePath: 'repo://anysentry/perf/progressive',
              agentId: `${runId}-progressive-agent-${index % 16}`,
              sessionId: `${runId}-progressive-session-${index % 8}`,
              events: nextEvents(1, 'progressive'),
            },
          },
        });
        if (result.json?.accepted !== true || result.json?.acceptedEvents !== 1) {
          throw new Error(`progressive record failed: ${JSON.stringify(result.json)}`);
        }
        captureItems(result.json);
        return { ...result, events: result.json.acceptedEvents };
      },
    },
    {
      name: 'ingest.observer.ndjson',
      group: 'write',
      dependencyCoverage: ['api', 'observer-ndjson-ingest', '@a3s-lab/sentry', 'clickhouse-write', 'source-registry'],
      durationMs: writeDurationMs,
      concurrency: writeConcurrency,
      request: async (index) => {
        const result = await requestJson('/ingest', {
          method: 'POST',
          body: {
            line: observerLine(index),
            sourceName: 'anysentry-perf-observer',
            sourceType: 'observer',
            collectorId: `${runId}-observer-collector`,
            workspacePath: 'repo://anysentry/perf/observer',
          },
        });
        if (result.json?.accepted !== true || !result.json?.eventId) {
          throw new Error(`observer ingest failed: ${JSON.stringify(result.json)}`);
        }
        capturedEventIds.push(result.json.eventId);
        return { ...result, events: 1 };
      },
    },
    {
      name: 'ingest.events.batch',
      group: 'write',
      dependencyCoverage: ['api', 'generic-ingest', '@a3s-lab/sentry', 'clickhouse-write', 'source-registry'],
      durationMs: writeDurationMs,
      concurrency: writeConcurrency,
      request: async () => {
        const result = await requestJson('/ingest/events', {
          method: 'POST',
          body: {
            sourceName: 'anysentry-perf-batch',
            sourceType: 'custom',
            collectorId: `${runId}-batch-collector`,
            workspacePath: 'repo://anysentry/perf/batch',
            events: nextEvents(ingestBatchSize, 'batch'),
          },
        });
        if (result.json?.accepted !== true || result.json?.acceptedEvents !== ingestBatchSize) {
          throw new Error(`batch ingest failed: ${JSON.stringify(result.json)}`);
        }
        captureItems(result.json);
        return { ...result, events: result.json.acceptedEvents };
      },
    },
    {
      name: 'events.list',
      group: 'read',
      dependencyCoverage: ['api', 'aggregation-service', 'event-ring', 'clickhouse-read'],
      durationMs: readDurationMs,
      concurrency: readConcurrency,
      request: async () => {
        const result = await requestJson('/events/list', {
          method: 'POST',
          body: { timeType: 'last_30d', runId, limit: 50 },
        });
        if (!Array.isArray(result.json?.items)) throw new Error(`unexpected events/list response: ${JSON.stringify(result.json)}`);
        return result;
      },
    },
    {
      name: 'aggregate.dashboard',
      group: 'read',
      dependencyCoverage: ['api', 'aggregation-service', 'dashboard-query-set', 'clickhouse-read'],
      durationMs: readDurationMs,
      concurrency: readConcurrency,
      request: async (index) => {
        const pathname = aggregatePaths[index % aggregatePaths.length];
        const result = await requestJson(pathname, {
          method: 'POST',
          body: { timeType: 'last_30d', runId, limit: 50 },
        });
        if (result.json === undefined || result.json === null) throw new Error(`empty aggregate response for ${pathname}`);
        return result;
      },
    },
    {
      name: 'evidence.bundle',
      group: 'read',
      dependencyCoverage: ['api', 'evidence-assembly', 'aggregation-service', 'clickhouse-read'],
      durationMs: readDurationMs,
      concurrency: Math.max(1, Math.ceil(readConcurrency / 2)),
      p95Ms: numberEnv('ANYSENTRY_PERF_EVIDENCE_P95_MS', 5000),
      request: async (index) => {
        if (!capturedEventIds.length) throw new Error('no captured event ids available for evidence bundle scenario');
        const eventId = capturedEventIds[index % capturedEventIds.length];
        const result = await requestJson('/capabilities', {
          method: 'POST',
          body: {
            action: 'execute',
            module: 'security-center',
            operation: 'buildEvidenceBundle',
            params: { timeType: 'last_30d', eventId, limit: 30 },
          },
        });
        if (!result.json?.bundleId && !result.json?.scope) {
          throw new Error(`unexpected evidence bundle response: ${JSON.stringify(result.json)}`);
        }
        return result;
      },
    },
  ];

  return scenarios.filter((scenario) => enabled(scenario.name));
}

async function waitForIngestVisibility() {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    last = await requestJson('/events/list', {
      method: 'POST',
      body: { timeType: 'last_30d', runId, limit: 10 },
    });
    if (last.json?.items?.length) return last.json;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`ingested events were not queryable within 15s: ${JSON.stringify(last?.json)}`);
}

async function collectKubernetesSnapshot(label) {
  const namespace = process.env.ANYSENTRY_PERF_K8S_NAMESPACE ?? process.env.ANYSENTRY_NAMESPACE;
  if (!namespace) return undefined;
  const selector = process.env.ANYSENTRY_PERF_K8S_SELECTOR ?? 'app in (anysentry,clickhouse,a3s-observer)';
  const snapshot = { label, namespace, selector };

  try {
    const { stdout } = await execFileAsync('kubectl', ['-n', namespace, 'get', 'pods', '-l', selector, '-o', 'json'], {
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const podList = JSON.parse(stdout);
    snapshot.pods = (podList.items ?? []).map((pod) => ({
      name: pod.metadata?.name,
      phase: pod.status?.phase,
      ready: (pod.status?.containerStatuses ?? []).every((status) => status.ready),
      restarts: (pod.status?.containerStatuses ?? []).reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
      images: (pod.status?.containerStatuses ?? []).map((status) => status.image),
      nodeName: pod.spec?.nodeName,
    }));
  } catch (error) {
    snapshot.podError = error instanceof Error ? error.message : String(error);
  }

  try {
    const { stdout } = await execFileAsync('kubectl', ['-n', namespace, 'top', 'pods', '-l', selector, '--no-headers'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    snapshot.top = stdout.trim().split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    snapshot.topError = error instanceof Error ? error.message : String(error);
  }

  return snapshot;
}

async function discoverObserverAgentIds() {
  const explicit = String(process.env.ANYSENTRY_PERF_OBSERVER_AGENT_ID ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;

  const namespaces = String(process.env.ANYSENTRY_PERF_OBSERVER_AGENT_NAMESPACE ?? process.env.ANYSENTRY_AGENT_NAMESPACES ?? 'default')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const ids = [];
  for (const namespace of namespaces) {
    try {
      const { stdout } = await execFileAsync('kubectl', ['-n', namespace, 'get', 'pods', '-o', 'json'], {
        timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const podList = JSON.parse(stdout);
      for (const pod of podList.items ?? []) {
        if (pod.status?.phase !== 'Running' || !pod.metadata?.uid) continue;
        ids.push(String(pod.metadata.uid));
      }
    } catch {
      // The observer scenario can still pass for non-Kubernetes/local deployments where enrichment is off.
    }
  }
  return ids.slice(0, 64);
}

function thresholdSummary(results) {
  return results.flatMap((result) =>
    result.thresholds
      .filter((threshold) => !threshold.pass)
      .map((threshold) => ({
        scenario: result.name,
        metric: threshold.metric,
        actual: threshold.actual,
        limit: threshold.limit,
        warnOnly: threshold.warnOnly,
      })),
  );
}

function markdownReport(report) {
  const lines = [
    `# AnySentry Performance Report`,
    '',
    `- Run ID: \`${report.runId}\``,
    `- API base: \`${report.apiBase}\``,
    `- Web base: \`${report.webBase}\``,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Host: ${report.host.hostname} (${report.host.platform} ${report.host.arch}, ${report.host.cpus} CPUs)`,
    `- Storage: \`${JSON.stringify(report.preflight.health.storage)}\``,
    '',
    '| Scenario | Group | Req/s | Events/s | p50 ms | p95 ms | p99 ms | Errors | Dependencies |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const result of report.results) {
    lines.push(
      `| ${result.name} | ${result.group} | ${result.requests.perSecond} | ${result.events.perSecond} | ${result.latencyMs.p50} | ${result.latencyMs.p95} | ${result.latencyMs.p99} | ${result.requests.failed} | ${result.dependencyCoverage.join(', ')} |`,
    );
  }
  if (report.thresholdWarnings.length) {
    lines.push('', '## Threshold Warnings', '');
    for (const warning of report.thresholdWarnings) {
      lines.push(`- ${warning.scenario} ${warning.metric}: ${warning.actual} > ${warning.limit}${warning.warnOnly ? ' (warn only)' : ''}`);
    }
  }
  if (report.kubernetes?.length) {
    lines.push('', '## Kubernetes Snapshot', '');
    for (const snapshot of report.kubernetes) {
      lines.push(`### ${snapshot.label}`);
      if (snapshot.pods?.length) {
        for (const pod of snapshot.pods) {
          lines.push(`- ${pod.name}: ${pod.phase}, ready=${pod.ready}, restarts=${pod.restarts}, node=${pod.nodeName}`);
        }
      }
      if (snapshot.top?.length) {
        lines.push('', '```text', ...snapshot.top, '```');
      }
      if (snapshot.podError) lines.push(`- pod snapshot error: ${snapshot.podError}`);
      if (snapshot.topError) lines.push(`- metrics snapshot error: ${snapshot.topError}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log('AnySentry performance test');
  console.log(`API base: ${apiBase}`);
  console.log(`Web base: ${webBase}`);
  console.log(`Run ID: ${runId}`);

  const beforeKubernetes = await collectKubernetesSnapshot('before');
  observerAgentIds = await discoverObserverAgentIds();
  const health = (await requestJson('/healthz')).json;
  if (health?.status !== 'ok') throw new Error(`healthz failed before load: ${JSON.stringify(health)}`);
  const stats = (await requestJson('/stats')).json;
  const dashboard = await discoverDashboardAssets();
  if (!dashboard.indexOk) throw new Error('dashboard index preflight did not return SPA root');

  const results = [];
  for (const scenario of scenarioDefinitions(dashboard)) {
    console.log(`Running ${scenario.name} (${scenario.concurrency} concurrency, ${scenario.durationMs}ms)`);
    if (scenario.name === 'events.list' || scenario.name === 'aggregate.dashboard' || scenario.name === 'evidence.bundle') {
      await waitForIngestVisibility();
    }
    const result = await runLoadScenario(scenario);
    results.push(result);
    console.log(
      `${result.name}: ${result.requests.perSecond} req/s, ${result.events.perSecond} events/s, p95=${result.latencyMs.p95}ms, errors=${result.requests.failed}`,
    );
  }

  const afterHealth = (await requestJson('/healthz')).json;
  const afterKubernetes = await collectKubernetesSnapshot('after');
  const finishedAt = new Date().toISOString();
  const thresholdWarnings = thresholdSummary(results);
  const report = {
    schemaVersion: 'anysentry.performance_report.v1',
    runId,
    apiBase,
    webBase,
    startedAt,
    finishedAt,
    config: {
      requestTimeoutMs,
      readDurationMs,
      writeDurationMs,
      readConcurrency,
      writeConcurrency,
      ingestBatchSize,
      warmupRequests,
      failOnThreshold,
      thresholds,
      scenarios: enabledScenarios ? Array.from(enabledScenarios) : 'all',
      observerAgentIdsDiscovered: observerAgentIds.length,
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      node: process.version,
    },
    preflight: {
      health,
      stats,
      dashboard,
    },
    postflight: {
      health: afterHealth,
    },
    kubernetes: [beforeKubernetes, afterKubernetes].filter(Boolean),
    capturedEventIds: capturedEventIds.slice(0, 50),
    results,
    thresholdWarnings,
  };

  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, `${runId}.json`);
  const mdPath = path.join(reportDir, `${runId}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, markdownReport(report));

  console.log(`Wrote ${path.relative(repoRoot, jsonPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, mdPath)}`);

  const hardFailures = results.filter((result) => result.requests.failed > 0);
  const thresholdFailures = failOnThreshold ? thresholdWarnings.filter((warning) => !warning.warnOnly) : [];
  if (hardFailures.length || thresholdFailures.length) {
    console.error('Performance test failed');
    process.exitCode = 1;
  } else if (thresholdWarnings.length) {
    console.warn('Performance test completed with threshold warnings');
  } else {
    console.log('Performance test passed');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
