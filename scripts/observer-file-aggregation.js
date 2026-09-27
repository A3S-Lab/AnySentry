'use strict';

const path = require('node:path');

const DEFAULT_EXCLUDED_PREFIXES = [
  '/boot/',
  '/dev/',
  '/etc/',
  '/proc/',
  '/root/',
  '/sys/',
  '/usr/bin/',
  '/usr/sbin/',
];

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function eventStartMarker(processInfo) {
  return text(
    processInfo.startTimeTicks ?? processInfo.start_time_ticks ??
    processInfo.startTimeNs ?? processInfo.start_time_ns,
  );
}

const AGGREGATION_METADATA_FIELDS = new Set([
  'repeatCount',
  'repeat_count',
  'firstEventAt',
  'first_event_at',
  'lastEventAt',
  'last_event_at',
  'aggregationWindowMs',
  'aggregation_window_ms',
]);

function canonicalValue(value, depth = 0) {
  if (depth > 8) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > 128) return undefined;
    const next = value.map((item) => canonicalValue(item, depth + 1));
    return next.some((item) => item === undefined) ? undefined : next;
  }
  if (!value || typeof value !== 'object') return undefined;
  const next = {};
  const keys = Object.keys(value).sort();
  if (keys.length > 128) return undefined;
  for (const key of keys) {
    const nested = canonicalValue(value[key], depth + 1);
    if (nested === undefined) return undefined;
    next[key] = nested;
  }
  return next;
}

function canonicalJson(value) {
  const normalized = canonicalValue(value);
  return normalized === undefined ? '' : JSON.stringify(normalized);
}

function semanticFilePayload(file) {
  const semantic = {};
  for (const key of Object.keys(file).sort()) {
    if (AGGREGATION_METADATA_FIELDS.has(key)) continue;
    semantic[key] = file[key];
  }
  return semantic;
}

function classificationSemantics(classification) {
  const attribution = classification?.attribution && typeof classification.attribution === 'object'
    ? classification.attribution
    : {};
  return {
    state: text(classification?.state),
    classification: text(attribution.classification),
    agentInstanceId: text(attribution.agentInstanceId),
    physicalWorkloadId: text(attribution.physicalWorkloadId),
    rootKey: text(attribution.rootKey),
    rootPid: Number(attribution.rootPid) || 0,
    rootStartTime: text(attribution.rootStartTime ?? attribution.rootStartTimeTicks),
    rootGeneration: Number(attribution.rootGeneration) || 0,
    conflict: attribution.conflict === true,
    workspacePath: text(classification?.workspacePath),
    workspaceSource: text(classification?.workspaceSource),
    workspaceConflict: classification?.workspaceConflict === true,
  };
}

function filterDecisionSemantics(decision) {
  if (!decision || typeof decision !== 'object') return null;
  return {
    action: text(decision.action),
    authority: text(decision.authority),
    reasonCode: text(decision.reasonCode),
    scopeType: text(decision.scopeType),
    scopeKey: text(decision.scopeKey),
    classification: text(decision.classification),
    source: text(decision.source),
    physicalWorkloadId: text(decision.physicalWorkloadId),
    agentInstanceId: text(decision.agentInstanceId),
    ruleVersion: Number(decision.ruleVersion) || 0,
  };
}

function positiveCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function representedCount(record) {
  const file = record?.observerEvent?.event?.FileAccess ?? {};
  const supplied = [record?.representedEvents, file.repeatCount, file.repeat_count]
    .filter((value) => value !== undefined);
  if (!supplied.length) return 1;
  const normalized = supplied.map(positiveCount);
  if (normalized.some((value) => value === undefined)) return 0;
  return normalized.every((value) => value === normalized[0]) ? normalized[0] : 0;
}

function eventTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordSpan(record, fallbackAt) {
  const file = record?.observerEvent?.event?.FileAccess ?? {};
  const firstValues = [file.firstEventAt, file.first_event_at].filter((value) => value !== undefined);
  const lastValues = [file.lastEventAt, file.last_event_at].filter((value) => value !== undefined);
  const parsedFirst = firstValues.map(eventTimestamp);
  const parsedLast = lastValues.map(eventTimestamp);
  if (
    parsedFirst.some((value) => value === undefined) ||
    parsedLast.some((value) => value === undefined) ||
    (parsedFirst.length > 1 && !parsedFirst.every((value) => value === parsedFirst[0])) ||
    (parsedLast.length > 1 && !parsedLast.every((value) => value === parsedLast[0]))
  ) return undefined;
  const firstAt = parsedFirst[0] ?? fallbackAt;
  const lastAt = parsedLast[0] ?? fallbackAt;
  return firstAt <= lastAt ? { firstAt, lastAt } : undefined;
}

function excludedPath(value, prefixes = DEFAULT_EXCLUDED_PREFIXES) {
  const normalized = path.posix.normalize(text(value));
  if (!normalized.startsWith('/')) return true;
  if (normalized.includes('/.ssh/') || normalized.includes('/.aws/')) return true;
  return prefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function fileAggregationKey(observerEvent, classification, options = {}) {
  const file = observerEvent?.event?.FileAccess;
  if (
    !file ||
    typeof file !== 'object' ||
    !['agent', 'unknown'].includes(classification?.state)
  ) return '';
  const filePath = text(file.path);
  const prefixes = Array.isArray(options.excludedPrefixes)
    ? options.excludedPrefixes.map(text).filter(Boolean)
    : DEFAULT_EXCLUDED_PREFIXES;
  if (excludedPath(filePath, prefixes)) return '';
  const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
  const pid = Number(processInfo.pid);
  const filePid = Number(file.pid);
  const start = eventStartMarker(processInfo) || text(options.processStartTime);
  const host = text(processInfo.hostId ?? processInfo.host_id);
  const boot = text(processInfo.bootId ?? processInfo.boot_id);
  const cgroupId = text(processInfo.cgroupId ?? processInfo.cgroup_id);
  const cgroup = text(processInfo.cgroup);
  const instance = text(
    classification.attribution?.agentInstanceId ??
    classification.attribution?.physicalWorkloadId,
  );
  if (
    !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isSafeInteger(filePid) || filePid !== pid ||
    !start || !host || !boot || !cgroupId || !cgroup ||
    typeof file.write !== 'boolean' ||
    (
      Object.hasOwn(file, 'flags') &&
      (!Number.isSafeInteger(file.flags) || file.flags < 0)
    ) ||
    (classification.state === 'agent' && !instance)
  ) return '';

  const processKey = [host, boot, pid, start];
  const semanticFile = semanticFilePayload(file);
  const signatures = {
    process: canonicalJson(processInfo),
    file: canonicalJson(semanticFile),
    identity: canonicalJson(observerEvent.identity ?? null),
    workload: canonicalJson(observerEvent.workload ?? null),
    observation: canonicalJson(observerEvent.observation ?? null),
    provider: canonicalJson(observerEvent.provider ?? null),
    classification: canonicalJson(classificationSemantics(classification)),
    activity: canonicalJson(options.activity ?? null),
    filterDecision: canonicalJson(filterDecisionSemantics(options.filterDecision)),
  };
  if (Object.values(signatures).some((value) => !value)) return '';
  return JSON.stringify([
    classification.state,
    instance,
    processKey,
    cgroupId,
    cgroup,
    filePath,
    signatures,
  ]);
}

function aggregatedRecord(record, count, firstAt, lastAt, windowMs) {
  if (count <= 1) return record;
  const original = record.observerEvent;
  const file = original.event.FileAccess;
  const observerEvent = {
    ...original,
    event: {
      ...original.event,
      FileAccess: {
        ...file,
        repeatCount: count,
        repeat_count: count,
        firstEventAt: new Date(firstAt).toISOString(),
        first_event_at: new Date(firstAt).toISOString(),
        lastEventAt: new Date(lastAt).toISOString(),
        last_event_at: new Date(lastAt).toISOString(),
        aggregationWindowMs: windowMs,
        aggregation_window_ms: windowMs,
      },
    },
  };
  return { ...record, observerEvent, line: JSON.stringify(observerEvent), representedEvents: count };
}

class FileAccessAggregator {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.windowMs = boundedNumber(options.windowMs, 100, 10, 5_000);
    this.maxKeys = boundedNumber(options.maxKeys, 20_000, 100, 1_000_000);
    this.excludedPrefixes = Array.isArray(options.excludedPrefixes)
      ? options.excludedPrefixes.map(text).filter(Boolean)
      : DEFAULT_EXCLUDED_PREFIXES;
    this.autoSchedule = options.autoSchedule !== false;
    this.entries = new Map();
    this.timer = undefined;
    this.stats = { observed: 0, eligible: 0, coalesced: 0, emitted: 0, evicted: 0 };
  }

  push(record, emit) {
    this.stats.observed++;
    const key = fileAggregationKey(record.observerEvent, record.classification, {
      excludedPrefixes: this.excludedPrefixes,
      processStartTime: record.processStartTime,
      activity: record.activity,
      filterDecision: record.filterDecision,
    });
    const weight = representedCount(record);
    const now = this.now();
    const span = weight ? recordSpan(record, now) : undefined;
    if (!key || !weight || !span) {
      emit(record);
      this.stats.emitted++;
      return false;
    }
    this.stats.eligible++;
    const existing = this.entries.get(key);
    const combinedCount = existing ? existing.count + weight : 0;
    if (
      existing &&
      now - existing.firstAt < this.windowMs &&
      Number.isSafeInteger(combinedCount)
    ) {
      existing.count = combinedCount;
      existing.lastAt = now;
      existing.firstEventAt = Math.min(existing.firstEventAt, span.firstAt);
      existing.lastEventAt = Math.max(existing.lastEventAt, span.lastAt);
      this.stats.coalesced++;
      return true;
    }
    if (existing) this.flushEntry(key, existing);
    if (this.entries.size >= this.maxKeys) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        const oldest = this.entries.get(oldestKey);
        this.flushEntry(oldestKey, oldest);
        this.stats.evicted++;
      }
    }
    this.entries.set(key, {
      record,
      emit,
      count: weight,
      firstAt: now,
      lastAt: now,
      firstEventAt: span.firstAt,
      lastEventAt: span.lastAt,
    });
    this.schedule();
    return true;
  }

  schedule() {
    if (!this.autoSchedule || this.timer || this.entries.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushExpired();
      this.schedule();
    }, Math.max(10, Math.min(50, this.windowMs)));
    this.timer.unref?.();
  }

  flushEntry(key, entry) {
    if (!entry) return false;
    const output = aggregatedRecord(
      entry.record,
      entry.count,
      entry.firstEventAt,
      entry.lastEventAt,
      this.windowMs,
    );
    // Delete only after a synchronous sink has accepted the output. If it throws, the pending
    // aggregate remains available for retry instead of being silently discarded.
    entry.emit(output);
    this.entries.delete(key);
    this.stats.emitted++;
    return true;
  }

  flushExpired() {
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.firstAt >= this.windowMs) this.flushEntry(key, entry);
    }
  }

  flushAll() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const [key, entry] of [...this.entries]) this.flushEntry(key, entry);
  }

  metrics() {
    return { ...this.stats, pendingKeys: this.entries.size, windowMs: this.windowMs };
  }
}

module.exports = {
  DEFAULT_EXCLUDED_PREFIXES,
  FileAccessAggregator,
  aggregatedRecord,
  excludedPath,
  fileAggregationKey,
};
