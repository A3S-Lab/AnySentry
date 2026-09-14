'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { eventIdentityCandidates } = require('./observer-workload-filter');

// Host names are only a compatibility hint. Candidate discovery must work when a service uses
// an internal gateway, an IP address, or a self-hosted model endpoint. Protocol/event shape is
// the primary signal; deployments may extend this bounded list through configuration.
const DEFAULT_LLM_HOST_HINTS = [
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

// Keep the scoring contract independent from any framework, tool name, or provider.  A
// deployment may tune bounded weights, but the snapshot must carry an explicit version so a
// candidate can always explain which signal registry produced it.
const DEFAULT_BEHAVIOR_SIGNAL_REGISTRY = Object.freeze({
  version: 'behavior-window-v1',
  weights: Object.freeze({
    llm: 4,
    tool: 1,
    uniqueTool: 1,
    alternation: 2,
    networkTarget: 1,
    workspace: 1,
    childFanout: 1,
    agentSequence: 4,
  }),
  caps: Object.freeze({
    llm: 8,
    uniqueTool: 3,
    alternation: 6,
    networkTarget: 2,
    agentSequence: 8,
  }),
});

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
  // A physical workload is the retention boundary, not a process-generation identity.  A
  // A restarted service (or two agent roots sharing one pod/cgroup) must not inherit the previous
  // short-window score. Use explicit runtime/root fences when available, while retaining
  // workload-level aggregation for child processes and older collectors without a root fence.
  if (text(attribution?.physicalWorkloadId)) {
    // processGenerationKey identifies an individual observed process in the kernel lane, not
    // necessarily the workload root. Prefer explicit runtime/AgentInstance fences and root
    // start-time facts; otherwise child Tool/Network/File processes in one physical workload
    // must share the same cold-start window.
    const generation = text(
      attribution?.agentInstanceId
        ?? attribution?.agent_instance_id
        ?? attribution?.runtimeInstanceId
        ?? attribution?.runtime_instance_id,
    );
    if (generation) return `workload:${text(attribution.physicalWorkloadId)}:generation:${generation}`;

    // F0 may know the physical workload before its process graph has materialized. When the
    // event still carries a root generation fence, use it so a restart cannot inherit the old
    // window. Do not fall back to the event PID: child processes in one workload must continue
    // contributing to the same window while the root start time remains stable.
    const process = processInfo(observerEvent);
    const rootPid = text(
      process.rootPid ?? process.root_pid ?? attribution?.rootPid ?? attribution?.root_pid,
    );
    const rootStart = text(
      process.rootStartTimeTicks
        ?? process.root_start_time_ticks
        ?? process.rootStartTime
        ?? process.root_start_time
        ?? attribution?.rootStartTimeTicks
        ?? attribution?.root_start_time_ticks
        ?? attribution?.rootStartTime
        ?? attribution?.root_start_time,
    );
    if (rootPid && rootStart) {
      return `workload:${text(attribution.physicalWorkloadId)}:root:${rootPid}:${rootStart}`;
    }
    return text(attribution.physicalWorkloadId);
  }
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

function routeText(payload) {
  return text(
    payload.path ??
      payload.route ??
      payload.requestPath ??
      payload.request_path ??
      payload.operation ??
      payload.operationName ??
      payload.operation_name ??
      payload.protocolOperation,
  ).toLowerCase();
}

function normalizedHints(value, fallback = DEFAULT_LLM_HOST_HINTS) {
  const configured = Array.isArray(value)
    ? value
    : text(value)
      ? text(value).split(',')
      : fallback;
  return [...new Set(configured.map((item) => text(item).toLowerCase()).filter(Boolean))].slice(0, 64);
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

function isLlmEvent(kind, payload, llmHostHints = DEFAULT_LLM_HOST_HINTS) {
  if (['LlmApi', 'LlmCall', 'LlmInteraction'].includes(kind)) return true;
  // A file path or executable name can contain protocol words. Only transport observations
  // may supply these optional model hints; otherwise ordinary file activity invents an LLM.
  if (!['Egress', 'Connect', 'Dns', 'DnsQuery', 'Tls', 'TlsHandshake'].includes(kind)) return false;
  const route = routeText(payload);
  // These are protocol operation shapes, not provider or framework names. They also cover
  // private gateways where the peer address carries no useful vendor identity.
  if (/(?:chat\/completions|completions|responses|messages|text-generation|generate-content|inference|model[_-]?invoke|llm)/u.test(route)) {
    return true;
  }
  const semanticKind = text(
    payload.semanticKind ?? payload.semantic_kind ?? payload.operationType ?? payload.operation_type,
  ).toLowerCase();
  if (/(?:llm|language[_ -]?model|model[_ -]?(?:call|request|response|generation)|chat|completion|inference)/u.test(semanticKind)) {
    return true;
  }
  const target = targetText(payload);
  return Boolean(target && normalizedHints(llmHostHints).some((hint) => target.includes(hint)));
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

function boundedWeight(value, fallback, max = 100) {
  return boundedNumber(value, fallback, 0, max);
}

function normalizeSignalRegistry(value) {
  let source = value && typeof value === 'object' ? value : {};
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      source = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      source = {};
    }
  }
  const weights = source.weights && typeof source.weights === 'object' ? source.weights : {};
  const caps = source.caps && typeof source.caps === 'object' ? source.caps : {};
  return {
    version: text(source.version) || DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.version,
    weights: {
      llm: boundedWeight(weights.llm, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.llm),
      tool: boundedWeight(weights.tool, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.tool),
      uniqueTool: boundedWeight(weights.uniqueTool, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.uniqueTool),
      alternation: boundedWeight(weights.alternation, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.alternation),
      networkTarget: boundedWeight(weights.networkTarget, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.networkTarget),
      workspace: boundedWeight(weights.workspace, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.workspace),
      childFanout: boundedWeight(weights.childFanout, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.childFanout),
      agentSequence: boundedWeight(weights.agentSequence, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.weights.agentSequence),
    },
    caps: {
      llm: boundedWeight(caps.llm, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.caps.llm),
      uniqueTool: boundedWeight(caps.uniqueTool, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.caps.uniqueTool),
      alternation: boundedWeight(caps.alternation, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.caps.alternation),
      networkTarget: boundedWeight(caps.networkTarget, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.caps.networkTarget),
      agentSequence: boundedWeight(caps.agentSequence, DEFAULT_BEHAVIOR_SIGNAL_REGISTRY.caps.agentSequence),
    },
  };
}

function scoreRecord(record, registry = DEFAULT_BEHAVIOR_SIGNAL_REGISTRY) {
  const normalized = normalizeSignalRegistry(registry);
  const { weights, caps } = normalized;
  const llm = Math.min(caps.llm, record.llmEvents * weights.llm);
  const tools = Math.min(4, record.toolExecs * weights.tool);
  const uniqueTools = Math.min(caps.uniqueTool, record.uniqueTools.size * weights.uniqueTool);
  const alternation = Math.min(caps.alternation, record.alternations * weights.alternation);
  const network = Math.min(caps.networkTarget, record.networkTargets.size * weights.networkTarget);
  const workspace = record.workspaceFiles >= 2 ? weights.workspace : 0;
  const fanout = record.childPids.size >= 3 ? weights.childFanout : 0;
  const sequences = Math.min(caps.agentSequence, record.agentSequences * weights.agentSequence);
  return llm + tools + uniqueTools + alternation + network + workspace + fanout + sequences;
}

function qualificationPattern(record) {
  const llmToolPattern =
    record.llmEvents > 0 &&
    record.toolExecs > 0 &&
    (record.alternations > 0 || record.uniqueTools.size >= 2);
  const autonomousToolPattern =
    record.agentSequences > 0 &&
    record.toolExecs >= 2 &&
    record.uniqueTools.size >= 2 &&
    record.workspaceFiles > 0;
  // A service Agent can legitimately complete a run without invoking a tool. Requiring
  // ToolExec here would leave a model-only HTTP Agent invisible forever. Two model transport
  // observations in one generation/window are enough for a bounded probable candidate; this is
  // deliberately weaker than confirmation and still carries the normal candidate TTL/profile.
  const modelServicePattern = record.llmEvents >= 2 && record.networkTargets.size > 0;
  if (llmToolPattern) return 'llm_tool';
  if (autonomousToolPattern) return 'autonomous_tool';
  if (modelServicePattern) return 'model_transport';
  return '';
}

function qualifies(record, threshold) {
  return record.score >= threshold && Boolean(qualificationPattern(record));
}

function strongInfrastructurePattern(record, now, minAgeMs, ref, attribution) {
  // Inventory names are weak negative hints. A complete kernel-only decision/tool sequence
  // must survive a deployment rename (for example an Agent which manages a database).
  if (record.llmEvents === 0 && record.agentSequences === 0 && isKnownInfrastructureWorkload(ref, attribution)) {
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
    this.llmHostHints = normalizedHints(
      options.llmHostHints ?? process.env.ANYSENTRY_BEHAVIOR_LLM_HOST_HINTS,
    );
    this.signalRegistry = normalizeSignalRegistry(
      options.signalRegistry ?? process.env.ANYSENTRY_BEHAVIOR_SIGNAL_REGISTRY,
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

  /** Atomically replace the bounded signal registry for subsequent observations. */
  updateSignalRegistry(registry) {
    const next = normalizeSignalRegistry(registry);
    this.signalRegistry = next;
    return { version: next.version, weights: { ...next.weights }, caps: { ...next.caps } };
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
    if (this.operations % 1_024 === 0) this.prune(now);
    let record = this.records.get(key);
    // Capacity applies to new scopes only. Visiting a known scope must not evict its evidence.
    // Map insertion order tracks accesses, avoiding a full-table scan for each cold-start scope.
    if (!record && this.records.size >= this.maxWorkloads) {
      this.records.delete(this.records.keys().next().value);
      this.stats.evicted++;
    }
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
    }
    this.records.delete(key);
    this.records.set(key, record);
    record.lastSeenAt = now;
    const kind = eventKind(observerEvent);
    const payload = eventPayload(observerEvent);
    const llm = isLlmEvent(kind, payload, this.llmHostHints);
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
    record.score = scoreRecord(record, this.signalRegistry);
    const pattern = qualifies(record, this.threshold) ? qualificationPattern(record) : '';
    if (pattern && record.probableUntil < now) {
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
        algorithmVersion: this.signalRegistry.version,
        score: record.score,
        threshold: this.threshold,
        window: `${this.windowMs}ms`,
        evidence: [
          `behavior:score=${record.score}`,
          `behavior:pattern=${pattern || 'hysteresis'}`,
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
    while (this.records.size > this.maxWorkloads) {
      this.records.delete(this.records.keys().next().value);
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
  DEFAULT_BEHAVIOR_SIGNAL_REGISTRY,
  normalizeSignalRegistry,
  qualifies,
  scoreRecord,
  strongInfrastructurePattern,
};
