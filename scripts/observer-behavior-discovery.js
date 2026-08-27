'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { eventIdentityCandidates } = require('./observer-workload-filter');

const LLM_HOST_HINTS = [
  'api.openai.com',
  'anthropic.com',
  'generativelanguage.googleapis.com',
  'bedrock-runtime',
  'api.mistral.ai',
  'api.cohere.ai',
  'dashscope',
  'deepseek',
  'openrouter.ai',
];

const DEFAULT_SERVICE_DATA_PATHS = [
  '/var/lib/clickhouse/',
  '/var/lib/postgresql/',
  '/var/lib/mysql/',
  '/var/lib/redis/',
  '/var/lib/kafka/',
  '/bitnami/kafka/',
  '/opt/kafka/',
  '/opt/apache-doris/',
];

const DEFAULT_INFRASTRUCTURE_NAME_PATTERNS = [
  /(?:^|[-_.:/])(?:kafka|clickhouse|doris(?:-fe|-be)?|postgres(?:ql)?|redis|mysql|mariadb|zookeeper)(?:[-_.:/]|$)/i,
  /(?:^|[-_.:/])flink(?:-jobmanager|-taskmanager)?(?:[-_.:/]|$)/i,
  /(?:^|[-_.:/])ai-apm(?:[-_.:/]|$)/i,
];

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function eventPayload(observerEvent) {
  const entries = Object.entries(observerEvent?.event ?? {});
  return entries.length > 0 && entries[0][1] && typeof entries[0][1] === 'object'
    ? entries[0][1]
    : {};
}

function eventKind(observerEvent) {
  return Object.keys(observerEvent?.event ?? {})[0] || '';
}

function processInfo(observerEvent) {
  return observerEvent?.process && typeof observerEvent.process === 'object'
    ? observerEvent.process
    : {};
}

function behaviorKey(observerEvent, attribution) {
  if (text(attribution?.physicalWorkloadId)) return text(attribution.physicalWorkloadId);
  const identity = eventIdentityCandidates(observerEvent);
  if (identity.candidates[0]) return `container:${identity.candidates[0]}`;
  const process = processInfo(observerEvent);
  const host = text(process.hostId ?? process.host_id) || 'host';
  const boot = text(process.bootId ?? process.boot_id) || 'boot';
  const cgroupId = text(process.cgroupId ?? process.cgroup_id);
  if (cgroupId && cgroupId !== '0') return `host:${host}:${boot}:cgroup:${cgroupId}`;
  const pid = text(process.pid ?? eventPayload(observerEvent).pid);
  const start = text(
    process.startTimeTicks ??
      process.start_time_ticks ??
      process.startTimeNs ??
      process.start_time_ns,
  );
  return pid ? `host:${host}:${boot}:process:${pid}:${start || 'unknown'}` : '';
}

function addBounded(set, value, max) {
  const normalized = text(value);
  if (!normalized || set.has(normalized)) return;
  if (set.size < max) set.add(normalized);
}

function targetText(payload) {
  return text(
    payload.host ??
      payload.hostname ??
      payload.domain ??
      payload.query ??
      payload.address ??
      payload.peer ??
      payload.remote ??
      payload.endpoint ??
      payload.url ??
      payload.sni,
  ).toLowerCase();
}

function toolText(payload) {
  const argv = Array.isArray(payload.argv) ? payload.argv.map(String) : text(payload.argv).split(/\s+/);
  return path.posix.basename(text(argv[0])).toLowerCase();
}

function toolSignature(payload) {
  const argv = Array.isArray(payload.argv) ? payload.argv.map(String) : text(payload.argv).split(/\s+/);
  return argv
    .slice(0, 3)
    .map((part, index) => index === 0 ? path.posix.basename(text(part)).toLowerCase() : text(part))
    .filter(Boolean)
    .join(' ')
    .slice(0, 240);
}

function executableText(observerEvent) {
  const process = processInfo(observerEvent);
  return text(process.exe) || text(process.comm);
}

function workloadRef(observerEvent, attribution) {
  if (attribution?.workloadRef && typeof attribution.workloadRef === 'object') {
    return attribution.workloadRef;
  }
  const process = processInfo(observerEvent);
  const cgroup = text(process.cgroup);
  const physicalWorkloadId = text(attribution?.physicalWorkloadId);
  const environment =
    physicalWorkloadId.startsWith('k8s:') || /kubepods/i.test(cgroup)
      ? 'kubernetes'
      : physicalWorkloadId.startsWith('docker:') ||
          /(?:docker|containerd|crio|libpod)/i.test(cgroup)
        ? 'docker'
        : 'host';
  const systemdUnit =
    text(process.systemdUnit ?? process.systemd_unit) ||
    cgroup
      .split(/[/:]/)
      .map((item) => item.trim())
      .find((item) => /\.(?:service|scope)$/.test(item)) ||
    '';
  const executable = text(process.exe);
  const processName = text(process.comm) || (executable ? path.posix.basename(executable) : '');
  const name = systemdUnit || processName;
  return {
    environment,
    kind: systemdUnit ? 'service' : processName ? 'process' : 'cgroup',
    ...(name ? { name } : {}),
    ...(text(process.hostId ?? process.host_id)
      ? { nodeName: text(process.hostId ?? process.host_id) }
      : {}),
    ...(systemdUnit ? { systemdUnit } : {}),
    ...(processName ? { processName } : {}),
    ...(executable ? { executable } : {}),
  };
}

function workloadDisplayName(ref) {
  return text(
    ref?.podName ??
      ref?.containerName ??
      ref?.systemdUnit ??
      ref?.name ??
      ref?.processName,
  );
}

function isKnownInfrastructureWorkload(ref, attribution) {
  const values = [
    attribution?.physicalWorkloadId,
    ref?.name,
    ref?.podName,
    ref?.containerName,
    ref?.containerImage,
    ref?.systemdUnit,
    ref?.processName,
    ref?.executable,
  ].map(text).filter(Boolean);
  return values.some((value) =>
    DEFAULT_INFRASTRUCTURE_NAME_PATTERNS.some((pattern) => pattern.test(value)),
  );
}

function isLlmEvent(kind, payload) {
  if (['LlmApi', 'LlmCall'].includes(kind)) return true;
  const target = targetText(payload);
  return Boolean(target && LLM_HOST_HINTS.some((hint) => target.includes(hint)));
}

function normalizedPathPrefix(value) {
  const normalized = text(value).replace(/\/+$/, '');
  return normalized ? `${normalized}/` : '';
}

function serviceDataPrefixes(value) {
  const configured = Array.isArray(value)
    ? value
    : text(value)
      ? text(value).split(',')
      : [];
  return [...new Set(
    [...DEFAULT_SERVICE_DATA_PATHS, ...configured]
      .map(normalizedPathPrefix)
      .filter(Boolean),
  )].slice(0, 128);
}

function isServiceDataFile(payload, prefixes = DEFAULT_SERVICE_DATA_PATHS) {
  const value = text(payload.path);
  if (!value) return false;
  const normalizedPrefixes = Array.isArray(prefixes) ? prefixes : serviceDataPrefixes(prefixes);
  return normalizedPrefixes.some((prefix) =>
    value === prefix.slice(0, -1) || value.startsWith(prefix),
  );
}

function isWorkspaceFile(payload, prefixes = DEFAULT_SERVICE_DATA_PATHS) {
  const value = text(payload.path);
  if (!value) return false;
  return (
    !['/proc/', '/sys/', '/dev/', '/run/'].some((prefix) => value.startsWith(prefix)) &&
    !isServiceDataFile(payload, prefixes)
  );
}

function incrementBounded(map, value, max) {
  const normalized = text(value);
  if (!normalized) return;
  if (!map.has(normalized) && map.size >= max) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function dominantCount(map) {
  let max = 0;
  for (const count of map.values()) max = Math.max(max, count);
  return max;
}

function scoreRecord(record) {
  const llm = Math.min(8, record.llmEvents * 4);
  const tools = Math.min(4, record.toolExecs);
  const uniqueTools = Math.min(3, record.uniqueTools.size);
  const alternation = Math.min(6, record.alternations * 2);
  const network = Math.min(2, record.networkTargets.size);
  const workspace = record.workspaceFiles >= 2 ? 1 : 0;
  const fanout = record.childPids.size >= 3 ? 1 : 0;
  const sequences = Math.min(8, record.agentSequences * 4);
  return llm + tools + uniqueTools + alternation + network + workspace + fanout + sequences;
}

function qualifies(record, threshold) {
  const llmToolPattern =
    record.llmEvents > 0 &&
    record.toolExecs > 0 &&
    (record.alternations > 0 || record.uniqueTools.size >= 2);
  const autonomousToolPattern =
    record.agentSequences > 0 &&
    record.toolExecs >= 2 &&
    record.uniqueTools.size >= 2 &&
    record.workspaceFiles > 0;
  return record.score >= threshold && (llmToolPattern || autonomousToolPattern);
}

function strongInfrastructurePattern(record, now, minAgeMs, ref, attribution) {
  if (record.llmEvents === 0 && isKnownInfrastructureWorkload(ref, attribution)) {
    return 'known_infrastructure_workload';
  }
  const fileEvents = record.workspaceFiles + record.serviceDataFiles;
  const serviceDataDominant =
    record.serviceDataFiles >= 4 &&
    record.serviceDataFiles / Math.max(1, fileEvents) >= 0.8;
  const executableDominant =
    record.events >= 6 &&
    dominantCount(record.executables) / record.events >= 0.8;
  const lacksAgentCycle =
    record.llmEvents === 0 &&
    record.agentSequences === 0 &&
    record.alternations === 0 &&
    record.uniqueTools.size <= 1;
  return (
    now - record.firstSeenAt >= minAgeMs &&
    serviceDataDominant &&
    executableDominant &&
    lacksAgentCycle
  ) ? 'service_data_pattern' : '';
}

class BehavioralAgentDetector {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.windowMs = boundedNumber(
      options.windowMs ?? process.env.ANYSENTRY_BEHAVIOR_WINDOW_SECS * 1000,
      5 * 60_000,
      10_000,
      24 * 60 * 60_000,
    );
    this.probableTtlMs = boundedNumber(
      options.probableTtlMs ?? process.env.ANYSENTRY_BEHAVIOR_PROBABLE_TTL_SECS * 1000,
      10 * 60_000,
      this.windowMs,
      24 * 60 * 60_000,
    );
    this.threshold = boundedNumber(
      options.threshold ?? process.env.ANYSENTRY_BEHAVIOR_THRESHOLD,
      8,
      4,
      100,
    );
    this.negativeMinAgeMs = boundedNumber(
      options.negativeMinAgeMs ?? process.env.ANYSENTRY_BEHAVIOR_NEGATIVE_MIN_AGE_SECS * 1000,
      60_000,
      1_000,
      24 * 60 * 60_000,
    );
    this.serviceDataPaths = serviceDataPrefixes(
      options.serviceDataPaths ?? process.env.ANYSENTRY_BEHAVIOR_SERVICE_DATA_PATHS,
    );
    this.maxWorkloads = boundedNumber(
      options.maxWorkloads ?? process.env.ANYSENTRY_BEHAVIOR_MAX_WORKLOADS,
      20_000,
      100,
      1_000_000,
    );
    this.enabled = !['0', 'false', 'off', 'no', 'disabled'].includes(
      text(options.enabled ?? process.env.ANYSENTRY_BEHAVIOR_DISCOVERY ?? 'on').toLowerCase(),
    );
    this.records = new Map();
    this.stats = {
      observed: 0,
      promoted: 0,
      probableEvents: 0,
      evicted: 0,
      expired: 0,
      demoted: 0,
      negativeEvidenceEvents: 0,
      missingKey: 0,
    };
    this.operations = 0;
  }

  observe(observerEvent, attribution) {
    if (!this.enabled) return undefined;
    this.stats.observed++;
    const key = behaviorKey(observerEvent, attribution);
    if (!key) {
      this.stats.missingKey++;
      return undefined;
    }
    const now = this.now();
    this.operations++;
    if (this.operations % 1_024 === 0 || this.records.size >= this.maxWorkloads) this.prune(now);
    let record = this.records.get(key);
    if (!record || now - record.windowStartedAt >= this.windowMs) {
      const previousProbableUntil = record?.probableUntil ?? 0;
      record = {
        key,
        candidateId: `discovered-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
        firstSeenAt: record?.firstSeenAt ?? now,
        windowStartedAt: now,
        lastSeenAt: now,
        probableUntil: previousProbableUntil,
        events: 0,
        llmEvents: 0,
        toolExecs: 0,
        workspaceFiles: 0,
        serviceDataFiles: 0,
        alternations: 0,
        agentSequences: 0,
        uniqueTools: new Set(),
        networkTargets: new Set(),
        serviceDataDirectories: new Set(),
        childPids: new Set(),
        executables: new Map(),
        lastSignal: '',
        lastToolSignature: '',
        decisionSinceTool: false,
        awaitingWorkspace: false,
        score: 0,
      };
      this.records.set(key, record);
    }
    record.lastSeenAt = now;
    const kind = eventKind(observerEvent);
    const payload = eventPayload(observerEvent);
    const llm = isLlmEvent(kind, payload);
    const tool = kind === 'ToolExec';
    const network =
      ['Egress', 'DnsQuery', 'Dns', 'Connect'].includes(kind) &&
      Boolean(targetText(payload));
    record.events++;
    incrementBounded(record.executables, executableText(observerEvent), 32);
    if (llm) record.llmEvents++;
    if (tool) {
      record.toolExecs++;
      addBounded(record.uniqueTools, toolText(payload), 32);
      addBounded(record.childPids, payload.pid, 64);
      const signature = toolSignature(payload);
      if (
        record.decisionSinceTool &&
        record.lastToolSignature &&
        signature &&
        signature !== record.lastToolSignature
      ) {
        record.awaitingWorkspace = true;
      }
      if (signature) record.lastToolSignature = signature;
      record.decisionSinceTool = false;
    }
    if (network || llm) {
      addBounded(record.networkTargets, targetText(payload), 32);
      if (record.lastToolSignature) record.decisionSinceTool = true;
    }
    if (kind === 'FileAccess') {
      if (isServiceDataFile(payload, this.serviceDataPaths)) {
        record.serviceDataFiles++;
        addBounded(record.serviceDataDirectories, path.posix.dirname(text(payload.path)), 64);
      } else if (isWorkspaceFile(payload, this.serviceDataPaths)) {
        record.workspaceFiles++;
        if (record.awaitingWorkspace) {
          record.agentSequences++;
          record.awaitingWorkspace = false;
        }
      }
    }
    const signal = llm ? 'llm' : tool ? 'tool' : '';
    if (signal && record.lastSignal && signal !== record.lastSignal) record.alternations++;
    if (signal) record.lastSignal = signal;
    record.score = scoreRecord(record);
    if (qualifies(record, this.threshold) && record.probableUntil < now) {
      record.probableUntil = now + this.probableTtlMs;
      this.stats.promoted++;
    }
    const candidateWorkload = workloadRef(observerEvent, attribution);
    const negative = strongInfrastructurePattern(
      record,
      now,
      this.negativeMinAgeMs,
      candidateWorkload,
      attribution,
    );
    if (negative) {
      if (record.probableUntil > now) {
        record.probableUntil = 0;
        this.stats.demoted++;
      }
      this.stats.negativeEvidenceEvents++;
      if (attribution?.classification === 'non_agent') return undefined;
      return {
        state: 'unknown',
        attribution: {
          monitored: false,
          classification: 'unknown',
          physicalWorkloadId: text(attribution?.physicalWorkloadId) || key,
          workloadRef: candidateWorkload,
          confidence: 0,
          reason: 'not_evaluated',
          source: 'behavior',
          evidence: [
            ...(Array.isArray(attribution?.evidence) ? attribution.evidence : []),
            `behavior:negative=${negative}`,
            `behavior:service_data_files=${record.serviceDataFiles}`,
            `behavior:service_data_directories=${record.serviceDataDirectories.size}`,
            `behavior:dominant_executable_ratio=${(
              dominantCount(record.executables) / Math.max(1, record.events)
            ).toFixed(2)}`,
            'behavior:llm=0',
            `behavior:agent_sequences=${record.agentSequences}`,
          ].slice(-16),
        },
      };
    }
    if (record.probableUntil <= now) return undefined;
    this.stats.probableEvents++;
    return {
      state: 'agent',
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        agentScopeId: record.candidateId,
        agentDisplayName: workloadDisplayName(candidateWorkload) || record.candidateId,
        agentInstanceId: key,
        physicalWorkloadId: text(attribution?.physicalWorkloadId) || key,
        workloadRef: candidateWorkload,
        confidence: Math.min(0.9, 0.5 + record.score / Math.max(20, this.threshold * 2) * 0.4),
        reason: 'hint_only',
        source: 'behavior',
        evidence: [
          `behavior:score=${record.score}`,
          `behavior:llm=${record.llmEvents}`,
          `behavior:tools=${record.toolExecs}`,
          `behavior:unique_tools=${record.uniqueTools.size}`,
          `behavior:alternations=${record.alternations}`,
          `behavior:network_targets=${record.networkTargets.size}`,
          `behavior:workspace_files=${record.workspaceFiles}`,
          `behavior:service_data_files=${record.serviceDataFiles}`,
          `behavior:agent_sequences=${record.agentSequences}`,
          `behavior:child_fanout=${record.childPids.size}`,
        ],
      },
    };
  }

  prune(now = this.now()) {
    for (const [key, record] of this.records) {
      const expiresAt = Math.max(
        record.lastSeenAt + this.windowMs,
        record.probableUntil,
      );
      if (expiresAt <= now) {
        this.records.delete(key);
        this.stats.expired++;
      }
    }
    while (this.records.size >= this.maxWorkloads) {
      let oldestKey;
      let oldestAt = Infinity;
      for (const [key, record] of this.records) {
        if (record.lastSeenAt < oldestAt) {
          oldestAt = record.lastSeenAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.records.delete(oldestKey);
      this.stats.evicted++;
    }
  }

  metrics() {
    let candidates = 0;
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.probableUntil > now) candidates++;
    }
    return {
      enabled: this.enabled,
      workloads: this.records.size,
      candidates,
      ...this.stats,
    };
  }
}

module.exports = {
  BehavioralAgentDetector,
  behaviorKey,
  isLlmEvent,
  isServiceDataFile,
  isWorkspaceFile,
  qualifies,
  scoreRecord,
  strongInfrastructurePattern,
};
