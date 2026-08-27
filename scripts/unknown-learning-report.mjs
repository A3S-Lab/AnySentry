#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DEFAULT_LIMIT = 200_000;
const DEFAULT_SINCE_HOURS = 24;

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function text(value, limit = 500) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
  return normalized.slice(0, limit);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback = 1, max = 1_000_000_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(max, Math.max(1, Math.trunc(parsed)))
    : fallback;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== '')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

function classification(row) {
  const attribution = parseObject(row.attribution);
  const judgment = parseObject(row.judgment);
  return text(attribution.classification || judgment.classification || 'unknown', 40).toLowerCase();
}

function revisionOrder(row) {
  return [
    positiveInteger(row.decisionRevision, 1, Number.MAX_SAFE_INTEGER),
    Math.max(0, number(row.decisionUpdatedAt, row.at)),
    Math.max(0, number(row.ingestedAt, row.at)),
  ];
}

function newerRevision(left, right) {
  const leftOrder = revisionOrder(left);
  const rightOrder = revisionOrder(right);
  for (let index = 0; index < leftOrder.length; index += 1) {
    if (leftOrder[index] !== rightOrder[index]) return leftOrder[index] > rightOrder[index];
  }
  return false;
}

export function latestRevisionRows(rows) {
  const latest = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = object(raw);
    const eventId = text(row.eventId, 240);
    if (!eventId) continue;
    const previous = latest.get(eventId);
    if (!previous || newerRevision(row, previous)) latest.set(eventId, row);
  }
  return [...latest.values()];
}

function eventFacts(row) {
  const attributes = parseObject(row.attributes);
  const processInfo = parseObject(row.process);
  const attribution = parseObject(row.attribution);
  const workload = object(attribution.workloadRef);
  const physicalWorkloadId = text(attribution.physicalWorkloadId, 500);
  const cgroup = text(processInfo.cgroup, 1_000);
  const placement = text(workload.environment, 40).toLowerCase()
    || (physicalWorkloadId.startsWith('k8s:') || /kubepods/iu.test(cgroup)
      ? 'kubernetes'
      : physicalWorkloadId.startsWith('docker:') || /docker|containerd/iu.test(cgroup)
        ? 'docker'
        : physicalWorkloadId.startsWith('host:')
          ? 'host'
          : 'unknown');
  const node = text(
    processInfo.hostId || workload.nodeName || attributes.collectorNode || attributes.nodeName || row.collectorId,
    240,
  ) || 'unknown';
  const cgroupId = text(processInfo.cgroupId || processInfo.cgroup_id || attributes.cgroupId || attributes.cgroup_id, 40);
  const repeatCount = positiveInteger(
    row.repeatCount || attributes.repeatCount || attributes.repeat_count,
    1,
    10_000_000,
  );
  const pathValue = text(attributes.path || row.path, 2_000);
  const containerImage = text(workload.containerImage || attributes.containerImage || attributes.image, 500).toLowerCase();
  return {
    eventId: text(row.eventId, 240),
    at: Math.max(0, number(row.at)),
    eventKind: text(row.eventKind, 120) || 'unknown',
    repeatCount,
    placement,
    node,
    cgroupId,
    physicalWorkloadId,
    comm: text(processInfo.comm || attributes.comm, 240).toLowerCase(),
    exe: text(processInfo.exe || attributes.exe, 500).toLowerCase(),
    pathBucket: pathBucket(pathValue),
    namespace: text(workload.namespace || attributes.namespace, 240).toLowerCase(),
    ownerKind: text(workload.ownerKind || attributes.ownerKind, 120),
    ownerName: text(workload.ownerName || attributes.ownerName, 240).toLowerCase(),
    containerName: text(workload.containerName || attributes.containerName, 240).toLowerCase(),
    containerImage,
    imageDigest: imageDigest(containerImage || attributes.imageDigest),
    clusterId: clusterId(physicalWorkloadId, attributes.clusterId),
    composeProject: text(
      attributes.composeProject || attributes.dockerComposeProject || attributes['com.docker.compose.project'],
      240,
    ).toLowerCase(),
    serviceName: text(
      attributes.serviceName || attributes.composeService || attributes.dockerComposeService || attributes['com.docker.compose.service'],
      240,
    ).toLowerCase(),
  };
}

function clusterId(physicalWorkloadId, explicit) {
  const normalized = text(explicit, 240).toLowerCase();
  if (normalized) return normalized;
  if (!physicalWorkloadId.startsWith('k8s:')) return '';
  return text(physicalWorkloadId.split(':')[1], 240).toLowerCase();
}

function imageDigest(value) {
  const normalized = text(value, 500).toLowerCase();
  const marker = normalized.indexOf('sha256:');
  if (marker < 0) return '';
  const candidate = normalized.slice(marker);
  return /^sha256:[a-f0-9]{16,128}$/u.test(candidate) ? candidate : '';
}

export function pathBucket(value) {
  const normalized = text(value, 2_000).replaceAll('\\', '/').replace(/\/+/gu, '/');
  if (!normalized.startsWith('/')) return normalized ? 'relative-or-opaque' : 'none';
  for (const [prefix, bucket] of [
    ['/var/lib/clickhouse/', '/var/lib/clickhouse'],
    ['/var/lib/docker/', '/var/lib/docker'],
    ['/var/lib/containerd/', '/var/lib/containerd'],
    ['/var/tmp/', '/var/tmp'],
    ['/dev/shm/', '/dev/shm'],
    ['/workspace/', '/workspace'],
    ['/proc/', '/proc'],
    ['/sys/', '/sys'],
    ['/run/', '/run'],
    ['/tmp/', '/tmp'],
    ['/var/log/', '/var/log'],
    ['/etc/', '/etc'],
    ['/home/', '/home'],
  ]) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) return bucket;
  }
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? `/${parts.slice(0, 2).join('/')}` : '/';
}

function aggregateRows(facts, keyOf, fieldsOf, limit = 50) {
  const groups = new Map();
  for (const fact of facts) {
    const key = keyOf(fact);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = {
        ...fieldsOf(fact),
        rawEvents: 0,
        weightedEvents: 0,
        nodes: new Set(),
        physicalWorkloads: new Set(),
        cgroups: new Set(),
        firstAt: Number.POSITIVE_INFINITY,
        lastAt: 0,
      };
      groups.set(key, group);
    }
    group.rawEvents += 1;
    group.weightedEvents += fact.repeatCount;
    if (fact.node && fact.node !== 'unknown') group.nodes.add(fact.node);
    if (fact.physicalWorkloadId) group.physicalWorkloads.add(fact.physicalWorkloadId);
    if (fact.cgroupId) group.cgroups.add(fact.cgroupId);
    if (fact.at > 0) {
      group.firstAt = Math.min(group.firstAt, fact.at);
      group.lastAt = Math.max(group.lastAt, fact.at);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      distinctNodes: group.nodes.size,
      distinctPhysicalWorkloads: group.physicalWorkloads.size,
      distinctCgroups: group.cgroups.size,
      nodes: [...group.nodes].sort().slice(0, 20),
      physicalWorkloads: [...group.physicalWorkloads].sort().slice(0, 20),
      cgroups: [...group.cgroups].sort().slice(0, 20),
      firstAt: Number.isFinite(group.firstAt) ? group.firstAt : undefined,
      lastAt: group.lastAt || undefined,
    }))
    .sort((left, right) => right.weightedEvents - left.weightedEvents || right.rawEvents - left.rawEvents)
    .slice(0, limit);
}

function topValues(facts, field, limit = 5) {
  return aggregateRows(
    facts,
    (fact) => fact[field],
    (fact) => ({ value: fact[field] }),
    limit,
  ).map(({ value, rawEvents, weightedEvents }) => ({ value, rawEvents, weightedEvents }));
}

function stableSelector(fact) {
  if (fact.placement === 'kubernetes') {
    if (!fact.clusterId || !fact.namespace || !fact.ownerKind || !fact.ownerName || !fact.containerName) return undefined;
    return {
      placement: 'kubernetes',
      clusterId: fact.clusterId,
      namespace: fact.namespace,
      ownerKind: fact.ownerKind,
      ownerName: fact.ownerName,
      containerName: fact.containerName,
    };
  }
  if (fact.placement === 'docker') {
    if (!fact.composeProject || !fact.serviceName) return undefined;
    return {
      placement: 'docker',
      composeProject: fact.composeProject,
      serviceName: fact.serviceName,
    };
  }
  return undefined;
}

function selectorKey(selector) {
  return selector ? JSON.stringify(stableValue(selector)) : '';
}

function suggestionGroups(facts) {
  const groups = new Map();
  for (const fact of facts) {
    if (!fact.physicalWorkloadId) continue;
    const selector = stableSelector(fact);
    const key = selectorKey(selector);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { selector, facts: [], images: new Set() };
      groups.set(key, group);
    }
    group.facts.push(fact);
    if (fact.imageDigest) group.images.add(fact.imageDigest);
  }
  return [...groups.values()];
}

function candidateSuggestions(facts, options) {
  const covered = new Set();
  const suggestions = [];
  for (const group of suggestionGroups(facts)) {
    const nodes = new Set(group.facts.map((fact) => fact.node).filter((node) => node && node !== 'unknown'));
    const physical = new Set(group.facts.map((fact) => fact.physicalWorkloadId).filter(Boolean));
    const weightedEvents = group.facts.reduce((sum, fact) => sum + fact.repeatCount, 0);
    const repeatedAcrossRuntime = nodes.size >= 2 || physical.size >= 2;
    if (
      !repeatedAcrossRuntime ||
      group.facts.length < options.minRawEvents ||
      weightedEvents < options.minWeightedEvents
    ) continue;
    const selector = { ...group.selector };
    if (group.images.size === 1 && group.facts.every((fact) => fact.imageDigest)) {
      selector.imageDigest = [...group.images][0];
    }
    for (const fact of group.facts) covered.add(fact.eventId);
    const sourceRef = `unknown-learning:${digest(selector).slice(0, 20)}`;
    suggestions.push({
      suggestionId: `ifs_${digest([selector, [...physical].sort()]).slice(0, 20)}`,
      role: 'infrastructure',
      authority: 'candidate',
      lifecycleStage: 'draft',
      effect: 'infrastructure',
      proposedFilterAction: 'sample',
      source: { type: 'behavior_discovery', sourceRef },
      reasonCode: 'repeated_unknown_workload_pattern',
      selector,
      evidence: {
        rawEvents: group.facts.length,
        weightedEvents,
        distinctNodes: nodes.size,
        distinctPhysicalWorkloads: physical.size,
        nodes: [...nodes].sort(),
        physicalWorkloadIds: [...physical].sort().slice(0, 20),
        eventKinds: topValues(group.facts, 'eventKind'),
        processes: {
          comm: topValues(group.facts, 'comm'),
          exe: topValues(group.facts, 'exe'),
        },
        pathBuckets: topValues(group.facts, 'pathBucket'),
      },
    });
  }
  suggestions.sort((left, right) =>
    right.evidence.weightedEvents - left.evidence.weightedEvents ||
    left.suggestionId.localeCompare(right.suggestionId));
  return { suggestions, covered };
}

function reviewReason(fact, stable, selectorGroup) {
  if (!fact.physicalWorkloadId) return 'missing_physical_identity';
  if (!stable) return 'unstable_workload_selector';
  const nodes = new Set(selectorGroup.map((item) => item.node).filter((node) => node && node !== 'unknown'));
  const physical = new Set(selectorGroup.map((item) => item.physicalWorkloadId).filter(Boolean));
  return nodes.size < 2 && physical.size < 2 ? 'single_node_single_instance' : 'below_candidate_threshold';
}

function reviewClusters(facts, covered, options) {
  const remaining = facts.filter((fact) => !covered.has(fact.eventId));
  const selectorGroups = new Map();
  for (const fact of remaining) {
    const key = selectorKey(stableSelector(fact));
    if (key) selectorGroups.set(key, [...(selectorGroups.get(key) ?? []), fact]);
  }
  return aggregateRows(
    remaining,
    (fact) => {
      const stable = stableSelector(fact);
      const reason = reviewReason(fact, stable, selectorGroups.get(selectorKey(stable)) ?? [fact]);
      return JSON.stringify([
        reason,
        fact.placement,
        fact.node,
        fact.cgroupId,
        fact.physicalWorkloadId,
        fact.comm,
        fact.exe,
        fact.eventKind,
        fact.pathBucket,
      ]);
    },
    (fact) => ({
      reason: reviewReason(fact, stableSelector(fact), selectorGroups.get(selectorKey(stableSelector(fact))) ?? [fact]),
      placement: fact.placement,
      node: fact.node,
      cgroupId: fact.cgroupId || undefined,
      physicalWorkloadId: fact.physicalWorkloadId || undefined,
      comm: fact.comm || undefined,
      exe: fact.exe || undefined,
      eventKind: fact.eventKind,
      pathBucket: fact.pathBucket,
    }),
    options.reviewLimit,
  );
}

export function buildUnknownLearningReport(rows, options = {}) {
  const config = {
    minRawEvents: positiveInteger(options.minRawEvents, 2, 1_000),
    minWeightedEvents: positiveInteger(options.minWeightedEvents, 2, 1_000_000),
    dimensionLimit: positiveInteger(options.dimensionLimit, 50, 500),
    reviewLimit: positiveInteger(options.reviewLimit, 100, 1_000),
  };
  const latest = latestRevisionRows(rows);
  const allFacts = latest.map(eventFacts);
  const unknownFacts = latest
    .filter((row) => classification(row) === 'unknown')
    .map(eventFacts);
  const totalWeightedEvents = allFacts.reduce((sum, fact) => sum + fact.repeatCount, 0);
  const unknownWeightedEvents = unknownFacts.reduce((sum, fact) => sum + fact.repeatCount, 0);
  const candidates = candidateSuggestions(unknownFacts, config);
  const suggestedFacts = unknownFacts.filter((fact) => candidates.covered.has(fact.eventId));
  const suggestedWeightedEvents = suggestedFacts.reduce((sum, fact) => sum + fact.repeatCount, 0);
  const remainingUnknownEvents = unknownFacts.length - suggestedFacts.length;
  const remainingUnknownWeightedEvents = unknownWeightedEvents - suggestedWeightedEvents;
  return {
    schemaVersion: 'anysentry.unknown_learning_report.v1',
    generatedAt: new Date().toISOString(),
    input: {
      populationScope: 'retained_events_after_authoritative_filtering',
      latestRevisionEvents: latest.length,
      minRawEvents: config.minRawEvents,
      minWeightedEvents: config.minWeightedEvents,
    },
    before: {
      totalEvents: latest.length,
      totalWeightedEvents,
      unknownEvents: unknownFacts.length,
      unknownWeightedEvents,
      unknownEventRatio: ratio(unknownFacts.length, latest.length),
      unknownWeightedRatio: ratio(unknownWeightedEvents, totalWeightedEvents),
    },
    after: {
      projection: 'if_candidate_suggestions_are_reviewed_and_confirmed',
      suggestedUnknownEvents: suggestedFacts.length,
      suggestedUnknownWeightedEvents: suggestedWeightedEvents,
      remainingUnknownEvents,
      remainingUnknownWeightedEvents,
      projectedUnknownEventRatio: ratio(remainingUnknownEvents, latest.length),
      projectedUnknownWeightedRatio: ratio(remainingUnknownWeightedEvents, totalWeightedEvents),
      projectedUnknownEventReductionRatio: ratio(suggestedFacts.length, unknownFacts.length),
      projectedUnknownWeightedReductionRatio: ratio(suggestedWeightedEvents, unknownWeightedEvents),
    },
    dimensions: {
      nodeCgroupPhysicalWorkload: aggregateRows(
        unknownFacts,
        (fact) => JSON.stringify([fact.node, fact.cgroupId, fact.physicalWorkloadId]),
        (fact) => ({ node: fact.node, cgroupId: fact.cgroupId || undefined, physicalWorkloadId: fact.physicalWorkloadId || undefined }),
        config.dimensionLimit,
      ),
      kubernetes: aggregateRows(
        unknownFacts.filter((fact) => fact.placement === 'kubernetes'),
        (fact) => JSON.stringify([fact.clusterId, fact.namespace, fact.ownerKind, fact.ownerName, fact.containerName, fact.containerImage]),
        (fact) => ({
          clusterId: fact.clusterId || undefined,
          namespace: fact.namespace || undefined,
          ownerKind: fact.ownerKind || undefined,
          ownerName: fact.ownerName || undefined,
          containerName: fact.containerName || undefined,
          image: fact.containerImage || undefined,
        }),
        config.dimensionLimit,
      ),
      docker: aggregateRows(
        unknownFacts.filter((fact) => fact.placement === 'docker'),
        (fact) => JSON.stringify([fact.node, fact.composeProject, fact.serviceName, fact.containerName, fact.containerImage]),
        (fact) => ({
          node: fact.node,
          composeProject: fact.composeProject || undefined,
          serviceName: fact.serviceName || undefined,
          containerName: fact.containerName || undefined,
          image: fact.containerImage || undefined,
        }),
        config.dimensionLimit,
      ),
      process: aggregateRows(
        unknownFacts,
        (fact) => JSON.stringify([fact.comm, fact.exe]),
        (fact) => ({ comm: fact.comm || undefined, exe: fact.exe || undefined }),
        config.dimensionLimit,
      ),
      eventKind: aggregateRows(
        unknownFacts,
        (fact) => fact.eventKind,
        (fact) => ({ eventKind: fact.eventKind }),
        config.dimensionLimit,
      ),
      pathBucket: aggregateRows(
        unknownFacts,
        (fact) => fact.pathBucket,
        (fact) => ({ pathBucket: fact.pathBucket }),
        config.dimensionLimit,
      ),
    },
    candidateSuggestions: candidates.suggestions,
    reviewClusters: reviewClusters(unknownFacts, candidates.covered, config),
  };
}

export function buildLatestRevisionQuery(options = {}) {
  const database = text(options.database || process.env.CLICKHOUSE_DB || 'anysentry', 120);
  const table = text(options.table || process.env.CLICKHOUSE_EVENTS_TABLE || 'events', 120);
  if (!IDENTIFIER.test(database) || !IDENTIFIER.test(table)) {
    throw new Error('CLICKHOUSE_DB and CLICKHOUSE_EVENTS_TABLE must be plain identifiers');
  }
  const sinceHours = Math.max(1, Math.min(24 * 90, number(options.sinceHours, DEFAULT_SINCE_HOURS)));
  const sinceMs = Math.max(0, number(options.sinceMs, Date.now() - sinceHours * 60 * 60_000));
  const limit = positiveInteger(options.limit, DEFAULT_LIMIT, 1_000_000);
  return `
SELECT
  eventId, at, ingestedAt, eventKind, collectorId,
  decisionRevision, decisionUpdatedAt,
  attributes, process, attribution, judgment
FROM
(
  SELECT
    eventId, at, ingestedAt, eventKind, collectorId,
    decisionRevision, decisionUpdatedAt,
    attributes, process, attribution, judgment
  FROM ${database}.${table}
  WHERE at >= ${Math.trunc(sinceMs)}
  ORDER BY eventId ASC, decisionRevision DESC, decisionUpdatedAt DESC, ingestedAt DESC
  LIMIT 1 BY eventId
)
ORDER BY at DESC
LIMIT ${limit}
FORMAT JSONEachRow
`.trim();
}

export function parseQueryOutput(value) {
  const normalized = text(value, 100 * 1024 * 1024);
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.data)) return parsed.data;
  } catch {
    // JSONEachRow is intentionally parsed one line at a time below.
  }
  return normalized.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`query runner returned invalid JSON on line ${index + 1}: ${error.message}`);
    }
  });
}

async function clickHouseHttpQuery(query) {
  const rawUrl = text(process.env.CLICKHOUSE_URL, 2_000);
  if (!rawUrl) throw new Error('CLICKHOUSE_URL or ANYSENTRY_UNKNOWN_QUERY_RUNNER is required');
  const endpoint = new URL(rawUrl);
  endpoint.pathname = '/';
  endpoint.searchParams.set('database', text(process.env.CLICKHOUSE_DB || 'anysentry', 120));
  endpoint.searchParams.set('query', query);
  const username = process.env.CLICKHOUSE_USER || 'anysentry';
  const password = process.env.CLICKHOUSE_PASSWORD || 'anysentry';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${body.trim().slice(0, 1_000)}`);
  return parseQueryOutput(body);
}

async function externalQueryRunner(query) {
  const command = text(process.env.ANYSENTRY_UNKNOWN_QUERY_RUNNER, 2_000);
  if (!command) return clickHouseHttpQuery(query);
  let args = [];
  const argsJson = process.env.ANYSENTRY_UNKNOWN_QUERY_RUNNER_ARGS_JSON?.trim();
  if (argsJson) {
    const parsed = JSON.parse(argsJson);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('ANYSENTRY_UNKNOWN_QUERY_RUNNER_ARGS_JSON must be a JSON string array');
    }
    args = parsed.slice(0, 64);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 100 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(new Error('query runner output exceeds 100 MiB'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`query runner exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 1_000)}`));
        return;
      }
      try {
        resolve(parseQueryOutput(Buffer.concat(stdout).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(query);
  });
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function loadCliRows() {
  const input = option('--input');
  if (input) return parseQueryOutput(await readFile(path.resolve(input), 'utf8'));
  const sinceMinutes = number(option('--since-minutes'), 0);
  const query = buildLatestRevisionQuery({
    sinceHours: option('--since-hours', DEFAULT_SINCE_HOURS),
    ...(sinceMinutes > 0 ? { sinceMs: Date.now() - sinceMinutes * 60_000 } : {}),
    limit: option('--limit', DEFAULT_LIMIT),
  });
  return externalQueryRunner(query);
}

async function main() {
  const rows = await loadCliRows();
  const report = buildUnknownLearningReport(rows, {
    minRawEvents: option('--min-raw-events', 2),
    minWeightedEvents: option('--min-weighted-events', 2),
    dimensionLimit: option('--dimension-limit', 50),
    reviewLimit: option('--review-limit', 100),
  });
  process.stdout.write(`${JSON.stringify(report, null, process.argv.includes('--compact') ? 0 : 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
