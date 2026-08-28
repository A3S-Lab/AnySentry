'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  RuntimeSignatureRegistry,
  defaultSignatureDocument,
  legacyRootNameDocument,
} = require('./observer-agent-runtime-signatures');

const DEFAULT_ROOT_NAMES = 'codex,a3s,a3s-code,a3s code,claude,claude-code,claude code';
const DEFAULT_MAX_PROCS = 20_000;
const DEFAULT_MAX_ANCESTORS = 32;
const RECORD_TTL_MS = 30 * 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 15_000;
const DEFAULT_ROOT_TERMINAL_TTL_MS = 60 * 60_000;
const DEFAULT_LIVENESS_MISSES = 2;
const DEFAULT_ACTIVITY_IDLE_MS = 60_000;
const DEFAULT_MAX_ROOTS = 4096;
const DEFAULT_MAX_TRANSITIONS = 4096;
const WORKSPACE_CACHE_SIZE = 4096;
const EPHEMERAL_WORKSPACE_ROOTS = ['/tmp', '/var/tmp', '/proc', '/sys', '/run', '/dev'];

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return '';
}

function enabledValue(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(normalized);
}

function basename(value) {
  const normalized = text(value).toLowerCase();
  return normalized ? path.posix.basename(normalized) : '';
}

function canonicalAgentName(value) {
  const normalized = text(value).toLowerCase();
  if (normalized === 'a3s' || normalized === 'a3s-code' || normalized === 'a3s code') return 'a3s code';
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claude code') return 'Claude Code';
  return normalized;
}

function canonicalWorkspacePath(value) {
  const normalized = text(value);
  if (!normalized || !path.posix.isAbsolute(normalized) || normalized === '/') return undefined;
  return path.posix.normalize(normalized).replace(/\/+$/, '');
}

function isPathWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isEphemeralWorkspacePath(value) {
  const normalized = canonicalWorkspacePath(value);
  return Boolean(normalized && EPHEMERAL_WORKSPACE_ROOTS.some((root) => isPathWithin(normalized, root)));
}

function findGitWorkspace(value, fsApi = fs) {
  let current = canonicalWorkspacePath(value);
  if (!current || isEphemeralWorkspacePath(current)) return undefined;
  while (current && current !== '/') {
    try {
      fsApi.lstatSync(path.join(current, '.git'));
      return current;
    } catch {}
    current = path.posix.dirname(current);
  }
  return undefined;
}

function eventPayload(observerEvent) {
  const entries = Object.entries(observerEvent?.event ?? {});
  return entries.length > 0 && entries[0][1] && typeof entries[0][1] === 'object' ? entries[0][1] : {};
}

function argvText(value) {
  if (Array.isArray(value)) return value.map(String).join(' ');
  return text(value);
}

function isInternalAgentHelper(info) {
  const argv = argvText(info?.argv).toLowerCase();
  const tokens = argv.split(/\s+/).filter(Boolean);
  return (
    tokens.includes('--codex-run-as-fs-helper') ||
    basename(tokens[0]) === 'codex-linux-sandbox' ||
    tokens.includes('--sandbox-policy-cwd')
  );
}

function containerIdFromCgroup(value) {
  const cgroup = text(value);
  if (!cgroup) return undefined;
  return cgroup.match(/(?:^|\/)docker[-/]([a-f0-9]{12,64})(?:\.scope)?(?:$|\/)/i)?.[1]
    || cgroup.match(/(?:^|\/)(?:cri-containerd|crio)[-/]([a-f0-9]{12,64})(?:\.scope)?(?:$|\/)/i)?.[1]
    || cgroup.match(/(?:^|\/)([a-f0-9]{64})(?:\.scope)?(?:$|\/)/i)?.[1];
}

function readProcInfo(pid, procRoot = '/proc') {
  try {
    const base = path.join(procRoot, String(pid));
    const stat = fs.readFileSync(path.join(base, 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ppid = positiveInt(fields[1]);
    const startTime = fields[19] || undefined;
    const comm = fs.readFileSync(path.join(base, 'comm'), 'utf8').trim();
    let tgid;
    let exe = '';
    let argv = '';
    let cgroup = '';
    let cwd = '';
    try {
      const status = fs.readFileSync(path.join(base, 'status'), 'utf8');
      tgid = positiveInt(status.match(/^Tgid:\s+(\d+)/m)?.[1]);
    } catch {}
    try { exe = fs.readlinkSync(path.join(base, 'exe')); } catch {}
    try { argv = fs.readFileSync(path.join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' '); } catch {}
    try { cgroup = fs.readFileSync(path.join(base, 'cgroup'), 'utf8'); } catch {}
    try { cwd = fs.readlinkSync(path.join(base, 'cwd')); } catch {}
    return { pid, tgid, ppid, startTime, comm, exe, argv, cgroup, cwd };
  } catch {
    return undefined;
  }
}

function listProcPids(procRoot = '/proc') {
  try {
    return fs.readdirSync(procRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => positiveInt(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readTextFile(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8').trim() || fallback; } catch { return fallback; }
}

function defaultHostId() {
  return text(process.env.A3S_OBSERVER_HOST_ID)
    || text(process.env.A3S_NODE_NAME)
    || text(process.env.NODE_NAME)
    || text(process.env.K8S_NODE_NAME)
    || readTextFile('/etc/machine-id', 'local-host');
}

function defaultBootId(procRoot = '/proc') {
  return readTextFile(path.join(procRoot, 'sys/kernel/random/boot_id'), 'unknown-boot');
}

function scopedPidKey(hostId, bootId, pid) {
  return JSON.stringify([text(hostId) || 'local-host', text(bootId) || 'unknown-boot', positiveInt(pid) || 0]);
}

function processKey(info, defaults = {}) {
  const pid = positiveInt(info?.pid);
  const startTime = text(info?.startTime);
  if (!pid || !startTime) return undefined;
  return JSON.stringify([
    text(info?.hostId) || defaults.hostId || 'local-host',
    text(info?.bootId) || defaults.bootId || 'unknown-boot',
    pid,
    startTime,
  ]);
}

function readProcStartTime(pid, procRoot = '/proc') {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    return stat.slice(close + 2).trim().split(/\s+/)[19] || undefined;
  } catch {
    return undefined;
  }
}

class ProcessRecordStore {
  constructor(defaults) {
    this.defaults = defaults;
    this.records = new Map();
    this.pidIndex = new Map();
  }

  normalize(record) {
    return {
      ...record,
      hostId: text(record?.hostId) || this.defaults.hostId,
      bootId: text(record?.bootId) || this.defaults.bootId,
      startTime: text(record?.startTime),
    };
  }

  set(recordOrPid, maybeRecord) {
    const record = maybeRecord && typeof maybeRecord === 'object' ? maybeRecord : recordOrPid;
    const normalized = this.normalize(record);
    const key = processKey(normalized, this.defaults);
    if (!key) return undefined;
    const pidKey = scopedPidKey(normalized.hostId, normalized.bootId, normalized.pid);
    const previousKey = this.pidIndex.get(pidKey);
    if (previousKey && previousKey !== key) this.records.delete(previousKey);
    const stored = { ...normalized, processKey: key };
    this.records.set(key, stored);
    this.pidIndex.set(pidKey, key);
    return stored;
  }

  get(pid, hostId = this.defaults.hostId, bootId = this.defaults.bootId) {
    const key = this.pidIndex.get(scopedPidKey(hostId, bootId, pid));
    return key ? this.records.get(key) : undefined;
  }

  getFor(info, allowPidFallback = false) {
    const normalized = this.normalize(info);
    const key = processKey(normalized, this.defaults);
    if (key) return this.records.get(key);
    return allowPidFallback ? this.get(normalized.pid, normalized.hostId, normalized.bootId) : undefined;
  }

  getByKey(key) {
    return this.records.get(key);
  }

  deleteRecord(record) {
    if (!record) return false;
    const normalized = this.normalize(record);
    const key = record.processKey || processKey(normalized, this.defaults);
    if (!key) return false;
    const deleted = this.records.delete(key);
    const pidKey = scopedPidKey(normalized.hostId, normalized.bootId, normalized.pid);
    if (this.pidIndex.get(pidKey) === key) this.pidIndex.delete(pidKey);
    return deleted;
  }

  deletePid(pid, hostId = this.defaults.hostId, bootId = this.defaults.bootId) {
    return this.deleteRecord(this.get(pid, hostId, bootId));
  }

  hasFor(info) {
    return Boolean(this.getFor(info));
  }

  has(pid, hostId = this.defaults.hostId, bootId = this.defaults.bootId) {
    return Boolean(this.get(pid, hostId, bootId));
  }

  delete(pid, hostId = this.defaults.hostId, bootId = this.defaults.bootId) {
    return this.deletePid(pid, hostId, bootId);
  }

  clear() {
    this.records.clear();
    this.pidIndex.clear();
  }

  values() {
    return this.records.values();
  }

  entries() {
    return this.records.entries();
  }

  [Symbol.iterator]() {
    return this.records[Symbol.iterator]();
  }

  get size() {
    return this.records.size;
  }
}

class AgentAttributor {
  constructor(options = {}) {
    this.procRoot = options.procRoot || '/proc';
    this.hostId = text(options.hostId) || defaultHostId();
    this.bootId = text(options.bootId) || defaultBootId(this.procRoot);
    this.maxProcs = positiveInt(options.maxProcs) || DEFAULT_MAX_PROCS;
    this.maxAncestors = positiveInt(options.maxAncestors) || DEFAULT_MAX_ANCESTORS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.readProc = typeof options.readProc === 'function' ? options.readProc : (pid) => readProcInfo(pid, this.procRoot);
    this.listPids = typeof options.listPids === 'function' ? options.listPids : () => listProcPids(this.procRoot);
    this.findWorkspaceRoot = typeof options.findWorkspaceRoot === 'function'
      ? options.findWorkspaceRoot
      : findGitWorkspace;
    this.workspaceCache = new Map();
    this.builtinHintsEnabled = enabledValue(
      options.builtinHintsEnabled ?? process.env.ANYSENTRY_BUILTIN_AGENT_HINTS,
      true,
    );
    const configuredRootNames =
      options.rootNames ??
      process.env.ANYSENTRY_AGENT_ROOT_NAMES ??
      (this.builtinHintsEnabled ? DEFAULT_ROOT_NAMES : '');
    this.rootNames = new Set(text(configuredRootNames)
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
    this.signatureRegistry = options.signatureRegistry instanceof RuntimeSignatureRegistry
      ? options.signatureRegistry
      : new RuntimeSignatureRegistry(
          options.rootNames != null || process.env.ANYSENTRY_AGENT_ROOT_NAMES != null
            ? legacyRootNameDocument(configuredRootNames)
            : this.builtinHintsEnabled
              ? defaultSignatureDocument()
              : legacyRootNameDocument(''),
          { source: options.rootNames != null ? 'legacy-option' : 'builtin' },
        );
    this.processesByKey = new ProcessRecordStore({ hostId: this.hostId, bootId: this.bootId });
    // Backward-compatible diagnostic name. This object is no longer keyed by bare PID internally;
    // get(pid) resolves through a scoped PID index to the ProcessKey record.
    this.procs = this.processesByKey;
    this.rootsByKey = new Map();
    this.transitions = [];
    this.maxRoots = positiveInt(options.maxRoots) || DEFAULT_MAX_ROOTS;
    this.maxTransitions = positiveInt(options.maxTransitions) || DEFAULT_MAX_TRANSITIONS;
    this.terminalRootTtlMs = positiveInt(options.terminalRootTtlMs) || DEFAULT_ROOT_TERMINAL_TTL_MS;
    this.livenessMissThreshold = positiveInt(options.livenessMissThreshold) || DEFAULT_LIVENESS_MISSES;
    this.activityIdleMs = positiveInt(options.activityIdleMs) || DEFAULT_ACTIVITY_IDLE_MS;
    this.readStartTime = typeof options.readStartTime === 'function'
      ? options.readStartTime
      : (pid) => readProcStartTime(pid, this.procRoot);
    this.tombstones = new Map();
    this.tombstoneTtlMs =
      positiveInt(options.tombstoneTtlMs) ||
      positiveInt(process.env.ANYSENTRY_PROCESS_TOMBSTONE_MS) ||
      DEFAULT_TOMBSTONE_TTL_MS;
    this.maxTombstones =
      positiveInt(options.maxTombstones) ||
      positiveInt(process.env.ANYSENTRY_PROCESS_MAX_TOMBSTONES) ||
      this.maxProcs;
    this.negativeTtlMs =
      positiveInt(options.negativeTtlMs) ||
      positiveInt(process.env.ANYSENTRY_PROCESS_NEGATIVE_TTL_MS) ||
      1_000;
    this.stats = {
      classifications: 0,
      cacheHits: 0,
      cacheMisses: 0,
      procReads: 0,
      bootstrapProcReads: 0,
      fallbackProcReads: 0,
      ancestryProcReads: 0,
      rootsDiscovered: 0,
      rootsExited: 0,
      rootsLost: 0,
      rootsRecovered: 0,
      rootLivenessChecks: 0,
      rootLivenessMisses: 0,
      staleGenerationMisses: 0,
      cacheEvictions: 0,
    };
    this.infrastructureRoots = new Map();
    this.infrastructureContainers = new Map();
    if (Array.isArray(options.infrastructureRoots)) this.setInfrastructureRoots(options.infrastructureRoots);
  }

  readProcess(pid, reason = 'fallback') {
    this.stats.procReads++;
    if (reason === 'bootstrap') this.stats.bootstrapProcReads++;
    else if (reason === 'ancestry') this.stats.ancestryProcReads++;
    else this.stats.fallbackProcReads++;
    const info = this.readProc(pid);
    return info
      ? {
          ...info,
          hostId: text(info.hostId) || this.hostId,
          bootId: text(info.bootId) || this.bootId,
        }
      : undefined;
  }

  processKey(info) {
    return processKey(info, { hostId: this.hostId, bootId: this.bootId });
  }

  stableProcessStartTime(observerEvent) {
    const payload = eventPayload(observerEvent);
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
    const supplied = text(
      processInfo.startTimeTicks ?? processInfo.start_time_ticks ??
      processInfo.startTimeNs ?? processInfo.start_time_ns,
    );
    if (supplied) return supplied;
    const pid = positiveInt(processInfo.pid) || positiveInt(payload.pid) || positiveInt(observerEvent?.identity?.task);
    const cgroupId = text(processInfo.cgroupId) || text(processInfo.cgroup_id);
    if (!pid || !cgroupId) return '';
    const hostId = text(processInfo.hostId) || text(processInfo.host_id) || this.hostId;
    const bootId = text(processInfo.bootId) || text(processInfo.boot_id) || this.bootId;
    const cached = this.procs.get(pid, hostId, bootId);
    if (!cached?.startTime || !cached.cgroupId || cached.cgroupId !== cgroupId) return '';
    return cached.startTime;
  }

  /**
   * Memoize an immutable unified-rule negative root so immediately spawned helpers inherit the
   * same Non-Agent provenance through ProcessKey ancestry. Exit-only observations are never
   * reinserted after lifecycle cleanup, and PID reuse remains fenced by start/cgroup identity.
   */
  rememberTrustedNonAgent(observerEvent, ruleId) {
    const normalizedRuleId = text(ruleId);
    if (!normalizedRuleId || Object.hasOwn(observerEvent?.event ?? {}, 'ProcessExit')) return false;
    const payload = eventPayload(observerEvent);
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object'
      ? observerEvent.process
      : {};
    const pid = positiveInt(processInfo.pid) || positiveInt(payload.pid) || positiveInt(observerEvent?.identity?.task);
    if (!pid) return false;
    const observed = {
      hostId: text(processInfo.hostId) || text(processInfo.host_id) || this.hostId,
      bootId: text(processInfo.bootId) || text(processInfo.boot_id) || this.bootId,
      pid,
      tgid: positiveInt(processInfo.tgid),
      ppid: positiveInt(processInfo.ppid) || positiveInt(payload.ppid),
      startTime: text(
        processInfo.startTimeTicks ?? processInfo.start_time_ticks
        ?? processInfo.startTimeNs ?? processInfo.start_time_ns,
      ),
      cgroupId: text(processInfo.cgroupId) || text(processInfo.cgroup_id),
      comm: text(processInfo.comm),
      exe: text(processInfo.exe),
      argv: argvText(payload.argv),
      cgroup: text(processInfo.cgroup),
      cwd: text(processInfo.cwd) || text(payload.cwd),
    };
    this.discardReusedPid(observed);
    const cached = this.procs.getFor(observed, !observed.startTime);
    const now = this.now();
    this.remember({
      ...(cached ?? {}),
      ...observed,
      ppid: observed.ppid || cached?.ppid,
      startTime: observed.startTime || cached?.startTime,
      cgroupId: observed.cgroupId || cached?.cgroupId,
      state: 'non_agent',
      nonAgentRuleId: normalizedRuleId,
      evidence: [`filter_rule:${normalizedRuleId}:r1`, 'process_family:trusted_non_agent'],
      lastSeen: now,
      nextResolveAt: now + Math.max(5_000, this.negativeTtlMs),
    });
    return true;
  }

  agentInstanceId(agentId, rootKey) {
    return `ari_${crypto.createHash('sha256')
      .update(text(agentId))
      .update('\0')
      .update(rootKey)
      .digest('hex')
      .slice(0, 24)}`;
  }

  rootForRecord(record, countMiss = true) {
    if (!record?.rootKey) return undefined;
    const root = this.rootsByKey.get(record.rootKey);
    if (
      !root ||
      root.runtimeState !== 'running' ||
      root.generation !== record.rootGeneration
    ) {
      if (countMiss) this.stats.staleGenerationMisses++;
      return undefined;
    }
    return root;
  }

  transition(root, runtimeState, details = {}) {
    if (!root || root.runtimeState === runtimeState) return false;
    const at = this.now();
    root.runtimeState = runtimeState;
    root.generation += 1;
    root.endedAt = at;
    root.lastSeenAt = Math.max(root.lastSeenAt || 0, at);
    Object.assign(root, details);
    this.transitions.push({
      agentInstanceId: root.agentInstanceId,
      rootKey: root.rootKey,
      runtimeState,
      at,
      ...details,
    });
    if (this.transitions.length > this.maxTransitions) {
      this.transitions.splice(0, this.transitions.length - this.maxTransitions);
    }
    if (runtimeState === 'exited') this.stats.rootsExited++;
    if (runtimeState === 'lost') this.stats.rootsLost++;
    return true;
  }

  ensureRoot(info, match) {
    const normalized = {
      ...info,
      hostId: text(info?.hostId) || this.hostId,
      bootId: text(info?.bootId) || this.bootId,
      startTime: text(info?.startTime),
    };
    const rootKey = this.processKey(normalized);
    if (!rootKey) return undefined;
    const now = this.now();
    const existing = this.rootsByKey.get(rootKey);
    if (existing) {
      if (existing.agentId !== text(match?.agentId)) return undefined;
      if (existing.runtimeState === 'exited') return undefined;
      if (existing.runtimeState === 'lost') {
        existing.runtimeState = 'running';
        existing.generation += 1;
        existing.endedAt = undefined;
        existing.reason = undefined;
        existing.exitCode = undefined;
        existing.signal = undefined;
        existing.missedLivenessChecks = 0;
        existing.signatureRuleId = match?.ruleId;
        existing.registryVersion = match?.registryVersion;
        existing.registryHash = match?.registryHash;
        existing.registryMatcherHash = match?.registryMatcherHash;
        existing.evidence = Array.isArray(match?.evidence) ? [...match.evidence] : [];
        this.stats.rootsRecovered++;
        this.transitions.push({
          agentInstanceId: existing.agentInstanceId,
          rootKey,
          runtimeState: 'running',
          at: now,
          reason: 'reobserved_same_process',
        });
        if (this.transitions.length > this.maxTransitions) this.transitions.shift();
      }
      existing.lastSeenAt = now;
      existing.lastActivityAt = now;
      existing.missedLivenessChecks = 0;
      return existing;
    }
    this.pruneRoots();
    if (this.rootsByKey.size >= this.maxRoots) return undefined;
    const agentId = text(match?.agentId);
    if (!agentId) return undefined;
    const root = {
      rootKey,
      generation: 1,
      runtimeState: 'running',
      agentId,
      agentDisplayName: text(match?.displayName) || agentId,
      agentInstanceId: this.agentInstanceId(agentId, rootKey),
      hostId: normalized.hostId,
      bootId: normalized.bootId,
      pid: normalized.pid,
      rootPid: normalized.pid,
      startTime: normalized.startTime,
      comm: text(normalized.comm),
      exe: text(normalized.exe),
      cgroup: text(normalized.cgroup),
      cgroupId: text(normalized.cgroupId),
      cwd: text(normalized.cwd),
      workspacePath: normalized.workspacePath,
      signatureRuleId: match?.ruleId,
      registryVersion: match?.registryVersion,
      registryHash: match?.registryHash,
      registryMatcherHash: match?.registryMatcherHash,
      classification: 'probable_agent',
      confidence: 0.85,
      attributionSource: 'process_signature',
      evidence: Array.isArray(match?.evidence) ? [...match.evidence] : [],
      discoveredAt: now,
      lastSeenAt: now,
      lastActivityAt: now,
      missedLivenessChecks: 0,
    };
    this.rootsByKey.set(rootKey, root);
    this.stats.rootsDiscovered++;
    this.transitions.push({
      agentInstanceId: root.agentInstanceId,
      rootKey,
      runtimeState: 'running',
      at: now,
      reason: 'discovered',
    });
    if (this.transitions.length > this.maxTransitions) this.transitions.shift();
    return root;
  }

  activeRootByPid(pid, hostId = this.hostId, bootId = this.bootId) {
    const record = this.procs.get(pid, hostId, bootId);
    return this.rootForRecord(record, false);
  }

  /**
   * Resolves only an ancestor of the same registered Agent scope. A different Agent scope is a
   * lifecycle boundary: callers may establish a nested root below it. When startup reconciliation
   * sees the child before its matching wrapper, the highest same-scope signature below that
   * boundary is materialized first so process enumeration order cannot create duplicate roots.
   */
  resolveSameScopeAncestor(initialPpid, match, snapshot) {
    const agentId = text(match?.agentId);
    let pid = positiveInt(initialPpid);
    if (!pid || !agentId) return undefined;
    const visited = new Set();
    let highestSameScope;

    const establishHighest = () => {
      if (!highestSameScope) return undefined;
      const result = this.rememberAgent(
        highestSameScope.info,
        highestSameScope.match,
        highestSameScope.info.pid,
        'hint_only',
        'process_signature',
      );
      if (result.state !== 'agent') return undefined;
      const record = this.procs.getFor(highestSameScope.info);
      const scope = this.agentScope(record);
      return scope.state === 'agent' ? scope : undefined;
    };

    for (let depth = 0; pid && depth < this.maxAncestors; depth++) {
      if (visited.has(pid)) return establishHighest();
      visited.add(pid);
      if (pid === 1) return establishHighest();

      const usingSnapshot = snapshot instanceof Map;
      const cachedBeforeRead = this.procs.get(pid);
      let live = usingSnapshot ? snapshot.get(pid) : this.readProcess(pid, 'ancestry');
      // A process may disappear between ToolExec and attribution. Cached non-Agent/unknown records
      // still carry bounded ProcessKey and PPID facts that are safe to follow for this repair path.
      if (!live && !usingSnapshot && cachedBeforeRead?.startTime) live = cachedBeforeRead;
      if (!live) return establishHighest();
      if (live !== cachedBeforeRead) this.discardReusedPid(live);
      const cached = this.procs.get(pid);

      if (this.matchInfrastructure(live)) return establishHighest();
      const ancestorMatch = this.matchAgentExecutable(live);
      if (ancestorMatch) {
        if (text(ancestorMatch.agentId) !== agentId) return establishHighest();
        const scope = cached?.state === 'agent' ? this.agentScope(cached) : undefined;
        if (scope?.state === 'agent' && scope.agentId === agentId) return scope;
        highestSameScope = { info: live, match: ancestorMatch };
      } else if (cached?.state === 'agent') {
        // A shell/tool process attributed to an existing Codex is an ownership edge, not an
        // implementation-wrapper edge. Crossing it would collapse a newly launched same-product
        // CLI into the ancestor session. Only an uninterrupted chain of exact same-scope
        // signatures (for example npm Node launcher -> native Codex) may share one root.
        return establishHighest();
      } else {
        return establishHighest();
      }
      if (cached?.state === 'infrastructure') return establishHighest();

      pid = positiveInt(live.ppid);
    }
    return establishHighest();
  }

  directParentMatchesAgentScope(info, match, ancestry) {
    const parentPid = positiveInt(info?.ppid);
    if (!parentPid || parentPid !== positiveInt(ancestry?.rootPid)) return false;
    const parent = this.procs.get(parentPid) || this.readProcess(parentPid, 'ancestry');
    if (!parent) return false;
    const parentMatch = this.matchAgentExecutable(parent);
    return Boolean(
      parentMatch
      && text(parentMatch.agentId) === text(match?.agentId)
      && text(parentMatch.agentId) === text(ancestry?.agentId),
    );
  }

  pruneRoots() {
    const cutoff = this.now() - this.terminalRootTtlMs;
    for (const [key, root] of this.rootsByKey) {
      if (root.runtimeState !== 'running' && (root.endedAt || 0) < cutoff) this.rootsByKey.delete(key);
    }
    if (this.rootsByKey.size < this.maxRoots) return;
    const terminal = [...this.rootsByKey.values()]
      .filter((root) => root.runtimeState !== 'running')
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    for (const root of terminal) {
      if (this.rootsByKey.size < this.maxRoots) break;
      this.rootsByKey.delete(root.rootKey);
    }
  }

  checkRootLiveness() {
    const checkedAt = this.now();
    let checked = 0;
    let lost = 0;
    for (const root of this.rootsByKey.values()) {
      if (root.runtimeState !== 'running') continue;
      checked++;
      this.stats.rootLivenessChecks++;
      const observedStart = text(this.readStartTime(root.pid));
      root.lastLivenessCheckAt = checkedAt;
      if (observedStart && observedStart === root.startTime) {
        root.missedLivenessChecks = 0;
        root.lastLivenessAt = checkedAt;
        continue;
      }
      this.stats.rootLivenessMisses++;
      root.missedLivenessChecks += observedStart && observedStart !== root.startTime
        ? this.livenessMissThreshold
        : 1;
      if (root.missedLivenessChecks < this.livenessMissThreshold) continue;
      if (this.transition(root, 'lost', {
        reason: observedStart ? 'pid_reused' : 'process_missing',
      })) lost++;
    }
    this.pruneRoots();
    return { checked, lost, checkedAt };
  }

  runtimeSnapshot() {
    const now = this.now();
    this.pruneRoots();
    return {
      schemaVersion: 'anysentry.agent_runtime_snapshot.v1',
      generatedAt: new Date(now).toISOString(),
      registryVersion: this.signatureRegistry.version,
      registryHash: this.signatureRegistry.hash,
      registryMatcherHash: this.signatureRegistry.matcherHash,
      entries: [...this.rootsByKey.values()].map((root) => ({
        agentScopeId: root.agentId,
        agentDisplayName: root.agentDisplayName,
        agentInstanceId: root.agentInstanceId,
        physicalWorkloadId: root.physicalWorkloadId,
        classification: root.classification || 'probable_agent',
        runtimeState: root.runtimeState,
        activityState: root.runtimeState === 'running'
          ? now - root.lastActivityAt <= this.activityIdleMs ? 'active' : 'idle'
          : undefined,
        rootPid: root.pid,
        rootStartTimeTicks: root.startTime,
        rootGeneration: root.generation,
        hostId: root.hostId,
        bootId: root.bootId,
        comm: root.comm || undefined,
        exe: root.exe || undefined,
        workspacePath: root.workspacePath,
        discoveredAt: new Date(root.discoveredAt).toISOString(),
        lastSeenAt: new Date(root.lastSeenAt).toISOString(),
        lastActivityAt: new Date(root.lastActivityAt).toISOString(),
        endedAt: root.endedAt ? new Date(root.endedAt).toISOString() : undefined,
        exitCode: root.exitCode,
        signal: root.signal,
        confidence: root.confidence ?? 0.85,
        source: root.attributionSource || 'process_signature',
        evidence: root.evidence,
        workloadRef: root.workloadRef ? { ...root.workloadRef } : undefined,
      })),
    };
  }

  /**
   * Adds workload/template placement to the stable process-root record without changing its
   * physical instance identity. Event attribution may intentionally use a container identity,
   * while runtime lifecycle always remains keyed by this root's ProcessKey-derived instance ID.
   */
  enrichRuntimeRoot(processClassification, mergedClassification) {
    const processAttribution = processClassification?.attribution;
    const mergedAttribution = mergedClassification?.attribution;
    const rootKey = text(processAttribution?.rootKey);
    if (!rootKey || !mergedAttribution || typeof mergedAttribution !== 'object') return false;
    const root = this.rootsByKey.get(rootKey);
    if (!root || text(processAttribution.agentInstanceId) !== root.agentInstanceId) return false;

    const physicalWorkloadId = text(mergedAttribution.physicalWorkloadId);
    if (physicalWorkloadId) root.physicalWorkloadId = physicalWorkloadId;
    if (
      mergedAttribution.workloadRef &&
      typeof mergedAttribution.workloadRef === 'object' &&
      !Array.isArray(mergedAttribution.workloadRef)
    ) {
      root.workloadRef = { ...mergedAttribution.workloadRef };
    }

    const classification = text(mergedAttribution.classification).toLowerCase();
    if (['confirmed_agent', 'probable_agent', 'unknown', 'non_agent'].includes(classification)) {
      root.classification = classification;
    }
    const confidence = Number(mergedAttribution.confidence);
    if (Number.isFinite(confidence)) root.confidence = Math.max(0, Math.min(1, confidence));
    const source = text(mergedAttribution.source);
    if (source) root.attributionSource = source;

    const evidence = [
      ...(Array.isArray(mergedAttribution.evidence) ? mergedAttribution.evidence : []),
      ...(root.evidence || []),
    ];
    root.evidence = [...new Set(evidence.map(text).filter(Boolean))].slice(0, 16);
    root.attributionConflict = mergedAttribution.conflict === true;
    return true;
  }

  invalidateUnmatchedRoots() {
    let invalidated = 0;
    for (const root of this.rootsByKey.values()) {
      if (root.runtimeState !== 'running') continue;
      const current = this.readProcess(root.pid, 'reconcile');
      const sameProcess = current && text(current.startTime) === root.startTime;
      const match = sameProcess ? this.matchAgentExecutable(current) : undefined;
      if (match && text(match.agentId) === root.agentId) continue;
      if (this.transition(root, 'lost', {
        reason: sameProcess ? 'signature_removed' : 'process_missing_during_reconcile',
      })) invalidated++;
    }
    return invalidated;
  }

  reconcileFromProc(options = {}) {
    const invalidated = options.invalidateSignatures ? this.invalidateUnmatchedRoots() : 0;
    return { ...this.seedFromProc(), invalidated };
  }

  seedFromProc() {
    const now = this.now();
    const snapshot = new Map();
    for (const pid of this.listPids().slice(0, this.maxProcs)) {
      const info = this.readProcess(pid, 'bootstrap');
      if (info) snapshot.set(pid, info);
    }

    let roots = 0;
    let signatureDescendants = 0;
    for (const info of snapshot.values()) {
      if (positiveInt(info.tgid) && positiveInt(info.tgid) !== info.pid) continue;
      const directAgent = this.matchAgent(info);
      if (!directAgent) continue;
      const before = this.rootsByKey.size;
      const ancestor = this.resolveSameScopeAncestor(info.ppid, directAgent, snapshot);
      const result = ancestor
        ? this.rememberAgent(
            info,
            ancestor,
            ancestor.rootPid,
            'process_lineage',
            'process_graph',
            ancestor.workspacePath,
          )
        : this.rememberAgent(info, directAgent, info.pid, 'hint_only', 'process_signature');
      if (result.state !== 'agent') continue;
      const addedRoots = this.rootsByKey.size - before;
      roots += addedRoots;
      if (result.attribution.rootKey !== this.processKey(info)) signatureDescendants++;
    }

    let descendants = signatureDescendants;
    let infrastructureDescendants = 0;
    for (const info of snapshot.values()) {
      if (['agent', 'infrastructure'].includes(this.procs.get(info.pid)?.state)) continue;
      const scope = this.resolveSnapshotScope(info, snapshot);
      if (!scope) continue;
      if (scope.state === 'agent') {
        const result = this.rememberAgent(
          info,
          scope,
          scope.rootPid,
          'process_lineage',
          'process_graph',
          scope.workspacePath,
        );
        if (result.state === 'agent') descendants++;
      } else if (scope.state === 'infrastructure') {
        this.remember({
          ...info,
          state: 'infrastructure',
          rootPid: scope.rootPid,
          serviceName: scope.serviceName,
          containerId: scope.containerId,
          lastSeen: now,
        });
        infrastructureDescendants++;
      }
    }
    // Keep the remaining process facts as short-lived unknown entries. The initial snapshot has
    // already paid for these reads, so discarding them would make the first event for every
    // unrelated host process walk /proc again. Unknown remains fail-open and is never promoted to
    // non-Agent merely because it appeared in the snapshot.
    for (const info of snapshot.values()) {
      if (!this.procs.hasFor(info)) this.remember({ ...info, state: 'unknown', lastSeen: now });
    }
    return {
      scanned: snapshot.size,
      roots,
      descendants,
      infrastructureRoots: this.infrastructureRoots.size,
      infrastructureDescendants,
    };
  }

  async reconcileFromProcBatched(options = {}) {
    const batchSize = positiveInt(options.batchSize) || 128;
    const yieldNow = typeof options.yieldNow === 'function'
      ? options.yieldNow
      : () => new Promise((resolve) => setImmediate(resolve));
    const now = this.now();
    const snapshot = new Map();
    const pids = this.listPids().slice(0, this.maxProcs);
    for (let offset = 0; offset < pids.length; offset += batchSize) {
      for (const pid of pids.slice(offset, offset + batchSize)) {
        const info = this.readProcess(pid, 'bootstrap');
        if (info) snapshot.set(pid, info);
      }
      if (offset + batchSize < pids.length) await yieldNow();
    }

    let invalidated = 0;
    if (options.invalidateSignatures) {
      const liveByKey = new Map([...snapshot.values()].map((info) => [this.processKey(info), info]));
      for (const root of this.rootsByKey.values()) {
        if (root.runtimeState !== 'running') continue;
        const current = liveByKey.get(root.rootKey);
        const match = current ? this.matchAgentExecutable(current) : undefined;
        if (match && text(match.agentId) === root.agentId) continue;
        if (this.transition(root, 'lost', {
          reason: current ? 'signature_removed' : 'process_missing_during_reconcile',
        })) invalidated++;
      }
    }

    let roots = 0;
    let signatureDescendants = 0;
    const all = [...snapshot.values()];
    for (let offset = 0; offset < all.length; offset += batchSize) {
      for (const info of all.slice(offset, offset + batchSize)) {
        if (positiveInt(info.tgid) && positiveInt(info.tgid) !== info.pid) continue;
        const directAgent = this.matchAgent(info);
        if (!directAgent) continue;
        const before = this.rootsByKey.size;
        const ancestor = this.resolveSameScopeAncestor(info.ppid, directAgent, snapshot);
        const result = ancestor
          ? this.rememberAgent(
              info,
              ancestor,
              ancestor.rootPid,
              'process_lineage',
              'process_graph',
              ancestor.workspacePath,
            )
          : this.rememberAgent(info, directAgent, info.pid, 'hint_only', 'process_signature');
        if (result.state !== 'agent') continue;
        const addedRoots = this.rootsByKey.size - before;
        roots += addedRoots;
        if (result.attribution.rootKey !== this.processKey(info)) signatureDescendants++;
      }
      if (offset + batchSize < all.length) await yieldNow();
    }

    let descendants = signatureDescendants;
    let infrastructureDescendants = 0;
    for (let offset = 0; offset < all.length; offset += batchSize) {
      for (const info of all.slice(offset, offset + batchSize)) {
        if (['agent', 'infrastructure'].includes(this.procs.getFor(info)?.state)) continue;
        const scope = this.resolveSnapshotScope(info, snapshot);
        if (scope?.state === 'agent') {
          if (this.rememberAgent(
            info,
            scope,
            scope.rootPid,
            'process_lineage',
            'process_graph',
            scope.workspacePath,
          ).state === 'agent') descendants++;
        } else if (scope?.state === 'infrastructure') {
          this.rememberInfrastructure(
            info,
            scope.rootPid,
            scope.serviceName,
            scope.containerId,
          );
          infrastructureDescendants++;
        }
      }
      if (offset + batchSize < all.length) await yieldNow();
    }
    for (const info of all) {
      if (!this.procs.hasFor(info)) this.remember({ ...info, state: 'unknown', lastSeen: now });
    }
    return {
      scanned: snapshot.size,
      roots,
      descendants,
      infrastructureRoots: this.infrastructureRoots.size,
      infrastructureDescendants,
      invalidated,
    };
  }

  resolveSnapshotScope(info, snapshot) {
    let current = info;
    const visited = new Set();
    for (let depth = 0; current && depth < this.maxAncestors; depth++) {
      if (visited.has(current.pid)) return undefined;
      visited.add(current.pid);

      const containerScope = this.matchInfrastructure(current);
      if (containerScope) return containerScope;

      const tgid = positiveInt(current.tgid);
      if (tgid && tgid !== current.pid) {
        const leader = this.procs.get(tgid);
        if (leader?.state === 'agent') {
          const scope = this.agentScope(leader);
          if (scope.state === 'agent') return scope;
        }
        if (leader?.state === 'infrastructure') return this.infrastructureScope(leader);
      }
      const cached = this.procs.get(current.pid);
      if (cached?.state === 'agent') {
        const scope = this.agentScope(cached);
        if (scope.state === 'agent') return scope;
      }
      if (cached?.state === 'infrastructure') return this.infrastructureScope(cached);

      const ppid = positiveInt(current.ppid);
      if (!ppid || ppid === 1) return undefined;
      current = snapshot.get(ppid);
    }
    return undefined;
  }

  classify(observerEvent) {
    const now = this.now();
    this.stats.classifications++;
    const payload = eventPayload(observerEvent);
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object' ? observerEvent.process : {};
    const pid = positiveInt(processInfo.pid) || positiveInt(payload.pid) || positiveInt(observerEvent?.identity?.task);
    if (!pid) return this.unknown();
    const exiting = Object.prototype.hasOwnProperty.call(observerEvent?.event ?? {}, 'ProcessExit');
    const toolExec = Object.prototype.hasOwnProperty.call(observerEvent?.event ?? {}, 'ToolExec');
    const observed = {
      hostId: text(processInfo.hostId) || text(processInfo.host_id) || this.hostId,
      bootId: text(processInfo.bootId) || text(processInfo.boot_id) || this.bootId,
      pid,
      tgid: positiveInt(processInfo.tgid),
      ppid: positiveInt(processInfo.ppid) || positiveInt(payload.ppid),
      startTime:
        text(processInfo.startTimeTicks) ||
        text(processInfo.start_time_ticks) ||
        text(processInfo.startTimeNs) ||
        text(processInfo.start_time_ns),
      cgroupId: text(processInfo.cgroupId) || text(processInfo.cgroup_id),
      // `identity.agent` is a claimed/inherited scope label from the Observer envelope. It is not
      // process executable evidence. Falling back to it here promoted short-lived bwrap, shell,
      // and ProcessExit records into new Agent roots whenever the real comm field was unavailable.
      comm: text(processInfo.comm),
      exe: text(processInfo.exe),
      argv: argvText(payload.argv),
      cgroup: text(processInfo.cgroup),
      cwd: text(processInfo.cwd) || text(payload.cwd),
      exitCode: exiting ? payload.exitCode ?? payload.exit_code : undefined,
      signal: exiting ? payload.signal : undefined,
    };
    this.discardReusedPid(observed);
    const cached = this.procs.getFor(observed, !observed.startTime);
    const sameCachedProcess = Boolean(
      cached &&
      (
        (observed.startTime && cached.startTime === observed.startTime) ||
        (!observed.startTime &&
          observed.cgroupId &&
          cached.cgroupId &&
          observed.cgroupId === cached.cgroupId)
      ),
    );
    let current = {
      ...(sameCachedProcess ? cached : {}),
      ...observed,
      ppid: observed.ppid || (sameCachedProcess ? cached.ppid : undefined),
      startTime: observed.startTime || (sameCachedProcess ? cached.startTime : undefined),
      cgroupId: observed.cgroupId || (sameCachedProcess ? cached.cgroupId : undefined),
      comm: observed.comm || (sameCachedProcess ? cached.comm : ''),
      exe: observed.exe || (sameCachedProcess ? cached.exe : ''),
      argv: observed.argv || (sameCachedProcess ? cached.argv : ''),
      cgroup: observed.cgroup || (sameCachedProcess ? cached.cgroup : ''),
      cwd: observed.cwd || (sameCachedProcess ? cached.cwd : ''),
    };
    if (sameCachedProcess) this.stats.cacheHits++;
    else this.stats.cacheMisses++;

    const existing = sameCachedProcess ? cached : undefined;
    // A stable cached binding is the hot path. ToolExec still evaluates the executable first so a
    // nested Agent (for example Pi launched by Codex) can establish its own root instance.
    if (!toolExec && existing?.state === 'agent' && this.rootForRecord(existing, false)) {
      const workspace = canonicalWorkspacePath(observed.cwd)
        ? this.resolveWorkspace(current.cwd, existing.workspacePath)
        : {
            workspacePath: existing.workspacePath,
            workspaceSource: existing.workspaceSource || 'unresolved',
            workspaceConflict: existing.workspaceConflict === true,
          };
      Object.assign(existing, current, workspace, { lastSeen: now });
      return this.finish(pid, this.agentResult(existing), exiting, current);
    }

    // Observer normally supplies the complete process instance. `/proc` is now a cache-miss and
    // missing-fact fallback instead of an unconditional per-event read.
    if (!sameCachedProcess && (!current.ppid || !current.startTime || !current.comm || (!current.cgroup && !current.cwd))) {
      const live = this.readProcess(pid, 'fallback');
      if (live) {
        this.discardReusedPid(live);
        current = {
          ...live,
          ...current,
          ppid: current.ppid || live.ppid,
          startTime: current.startTime || live.startTime,
          comm: current.comm || live.comm,
          exe: current.exe || live.exe,
          argv: current.argv || live.argv,
          cgroup: current.cgroup || live.cgroup,
          cwd: current.cwd || live.cwd,
        };
      }
    }

    const directInfrastructure = this.matchInfrastructure(current);
    if (directInfrastructure) {
      return this.finish(
        pid,
        this.rememberInfrastructure(
          current,
          directInfrastructure.rootPid,
          directInfrastructure.serviceName,
          directInfrastructure.containerId,
        ),
        exiting,
        current,
      );
    }

    const directAgent = this.matchAgentExecutable(current);
    const existingScope = existing?.state === 'agent' ? this.agentScope(existing) : undefined;
    const directMatchesExistingScope = Boolean(
      directAgent &&
      existingScope?.state === 'agent' &&
      text(existingScope.agentId) === text(directAgent.agentId)
    );
    if (
      existing?.state === 'agent' &&
      this.rootForRecord(existing) &&
      (!toolExec || !directAgent || directMatchesExistingScope)
    ) {
      // A short process can emit ToolExec and ProcessExit after /proc/<pid>/cwd has already
      // disappeared. Preserve an earlier conflict decision for the same PID instead of silently
      // turning the later event into an unresolved-but-trusted Agent event.
      const workspace = canonicalWorkspacePath(observed.cwd)
        ? this.resolveWorkspace(current.cwd, existing.workspacePath)
        : {
            workspacePath: existing.workspacePath,
            workspaceSource: existing.workspaceSource || 'unresolved',
            workspaceConflict: existing.workspaceConflict === true,
          };
      Object.assign(existing, current, workspace, { lastSeen: now });
      return this.finish(pid, this.agentResult(existing), exiting, current);
    }
    if (existing?.state === 'infrastructure') {
      return this.finish(pid, this.infrastructureResult(existing), exiting, current);
    }
    const tombstone = exiting ? this.tombstoneFor(current) : undefined;
    if (tombstone?.state === 'agent') {
      return this.finish(pid, this.agentResult(tombstone, true), exiting, current);
    }

    // Routine file/network/security observations reuse a recent negative result. ToolExec and
    // ProcessExit re-evaluate because they are lifecycle/high-signal boundaries and can repair
    // out-of-order parent information.
    if (!toolExec && !exiting && existing?.nextResolveAt > now) {
      if (existing.state === 'non_agent') return this.nonAgentResult(existing);
      return this.unknown();
    }

    // Resolve ownership before creating a root from the current command. This prevents inherited
    // labels and same-scope implementation wrappers from fragmenting one Agent lifecycle. A
    // different, registry-verified executable remains a real nested Agent boundary (for example
    // Pi launched by Codex), so it may establish an independent root below the owner.
    const ancestry = this.resolveAncestry(current.ppid, now);
    if (ancestry.state === 'agent') {
      const directImplementationChild = directAgent
        ? this.directParentMatchesAgentScope(current, directAgent, ancestry)
        : false;
      if (directAgent && (
        text(directAgent.agentId) !== text(ancestry.agentId)
        || !directImplementationChild
      )) {
        return this.finish(
          pid,
          this.rememberAgent(
            current,
            directAgent,
            pid,
            'hint_only',
            'process_signature',
          ),
          exiting,
          current,
        );
      }
      return this.finish(
        pid,
        this.rememberAgent(
          current,
          ancestry,
          ancestry.rootPid,
          'process_lineage',
          'process_graph',
          ancestry.workspacePath,
        ),
        exiting,
        current,
      );
    }

    if (ancestry.state === 'infrastructure') {
      return this.finish(
        pid,
        this.rememberInfrastructure(current, ancestry.rootPid, ancestry.serviceName, ancestry.containerId),
        exiting,
        current,
      );
    }

    // Only a registry-verified process signature can create a root after ownership resolution.
    // `identity.agent` is intentionally absent from `current`, so an envelope claim cannot enter
    // this branch.
    if (directAgent) {
      return this.finish(
        pid,
        this.rememberAgent(
          current,
          directAgent,
          pid,
          'hint_only',
          'process_signature',
        ),
        exiting,
        current,
      );
    }

    if (ancestry.state === 'non_agent') {
      const record = {
        ...current,
        state: 'non_agent',
        nonAgentRuleId: ancestry.nonAgentRuleId,
        evidence: ancestry.evidence,
        lastSeen: now,
        nextResolveAt: ancestry.nonAgentRuleId
          ? now + Math.max(5_000, this.negativeTtlMs)
          : undefined,
      };
      this.remember(record);
      return this.finish(pid, this.nonAgentResult(record), exiting, current);
    }

    this.remember({ ...current, state: 'unknown', lastSeen: now });
    return this.finish(pid, this.unknown(), exiting, current);
  }

  nonAgentResult(record = {}) {
    const ruleId = text(record.nonAgentRuleId);
    const evidence = Array.isArray(record.evidence) ? record.evidence.map(text).filter(Boolean) : [];
    return {
      state: 'non_agent',
      attribution: {
        monitored: false,
        classification: 'non_agent',
        confidence: 1,
        reason: 'not_agent',
        source: 'process_graph',
        evidence: [...new Set([
          ...evidence,
          ...(ruleId ? [`filter_rule:${ruleId}:r1`, 'process_lineage:trusted_non_agent_family'] : ['process_lineage:pid1']),
        ])].slice(0, 16),
      },
    };
  }

  finish(pid, result, exiting, current) {
    if (exiting) {
      const record = this.procs.getFor(current, true) || (
        result.state === 'agent'
          ? {
              ...current,
              state: 'agent',
              agentId: result.attribution.agentScopeId,
              rootPid: result.attribution.rootPid ?? pid,
              rootStartTime: result.attribution.rootStartTime ?? current.startTime,
              lastSeen: this.now(),
            }
          : undefined
      );
      if (record?.startTime) this.rememberTombstone(record);
      const root = record?.rootKey ? this.rootsByKey.get(record.rootKey) : undefined;
      if (root && record.processKey === root.rootKey && root.runtimeState === 'running') {
        this.transition(root, 'exited', {
          reason: 'process_exit',
          exitCode: current.exitCode,
          signal: current.signal,
        });
      }
      this.procs.deleteRecord(record);
    }
    return result;
  }

  tombstoneFor(info) {
    this.pruneTombstones();
    const key = this.processKey(info);
    if (!key) return undefined;
    const tombstone = this.tombstones.get(key);
    if (!tombstone || tombstone.expiresAt <= this.now()) return undefined;
    return tombstone.record;
  }

  rememberTombstone(record) {
    const key = record.processKey || this.processKey(record);
    if (!key) return;
    this.tombstones.set(key, {
      record: { ...record },
      expiresAt: this.now() + this.tombstoneTtlMs,
    });
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest == null) break;
      this.tombstones.delete(oldest);
    }
  }

  pruneTombstones() {
    const now = this.now();
    for (const [key, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(key);
    }
  }

  resolveAncestry(initialPpid, now) {
    let pid = positiveInt(initialPpid);
    if (!pid) return { state: 'unknown' };
    const visited = new Set();

    for (let depth = 0; depth < this.maxAncestors; depth++) {
      if (visited.has(pid)) return { state: 'unknown' };
      visited.add(pid);

      const cached = this.procs.get(pid);
      if (cached?.state === 'agent') {
        const scope = this.agentScope(cached);
        if (scope.state === 'agent') return scope;
      }
      if (cached?.state === 'infrastructure') return this.infrastructureScope(cached);
      if (cached?.state === 'non_agent' && cached.nextResolveAt > now) {
        return {
          state: 'non_agent',
          nonAgentRuleId: cached.nonAgentRuleId,
          evidence: cached.evidence,
        };
      }
      if (pid === 1) return { state: 'non_agent' };

      // A recent unknown entry still contains useful parent/start facts. Follow that cached
      // parent without re-reading /proc; once the negative TTL expires, refresh it normally.
      if (cached?.state === 'unknown' && cached.nextResolveAt > now) {
        pid = positiveInt(cached.ppid);
        if (!pid) return { state: 'unknown' };
        continue;
      }

      const live = this.readProcess(pid, 'ancestry');
      if (!live) return cached?.state === 'non_agent'
        ? { state: 'non_agent', nonAgentRuleId: cached.nonAgentRuleId, evidence: cached.evidence }
        : { state: 'unknown' };
      this.discardReusedPid(live);

      const containerScope = this.matchInfrastructure(live);
      if (containerScope) {
        this.remember({
          ...live,
          state: 'infrastructure',
          rootPid: containerScope.rootPid,
          serviceName: containerScope.serviceName,
          containerId: containerScope.containerId,
          lastSeen: now,
        });
        return containerScope;
      }

      const tgid = positiveInt(live.tgid);
      if (tgid && tgid !== pid) {
        const leaderCached = this.procs.get(tgid);
        if (leaderCached?.state === 'agent') {
          const scope = this.agentScope(leaderCached);
          if (scope.state === 'agent') {
            this.rememberAgent(
              live,
              scope,
              scope.rootPid,
              'process_lineage',
              'process_graph',
              scope.workspacePath,
            );
            return scope;
          }
        }
        if (leaderCached?.state === 'infrastructure') {
          this.remember({
            ...live,
            state: 'infrastructure',
            rootPid: leaderCached.rootPid,
            serviceName: leaderCached.serviceName,
            containerId: leaderCached.containerId,
            lastSeen: now,
          });
          return this.infrastructureScope(leaderCached);
        }

        const leader = this.readProcess(tgid, 'ancestry');
        if (leader) {
          this.discardReusedPid(leader);
          const leaderAgent = this.matchAgent(leader);
          if (leaderAgent) {
            const { workspacePath } = this.resolveWorkspace(leader.cwd);
            const ancestor = this.resolveSameScopeAncestor(leader.ppid, leaderAgent);
            const leaderResult = this.rememberAgent(
              { ...leader, workspacePath },
              ancestor || leaderAgent,
              ancestor?.rootPid || tgid,
              ancestor ? 'process_lineage' : 'hint_only',
              ancestor ? 'process_graph' : 'process_signature',
              ancestor?.workspacePath,
            );
            if (leaderResult.state === 'agent') {
              const rootRecord = this.procs.getFor(leader);
              const scope = this.agentScope(rootRecord);
              this.rememberAgent(
                live,
                scope,
                tgid,
                'process_lineage',
                'process_graph',
                workspacePath,
              );
              return scope;
            }
          }
        }
      }

      const directAgent = this.matchAgent(live);
      if (directAgent) {
        const ancestor = this.resolveSameScopeAncestor(live.ppid, directAgent);
        this.rememberAgent(
          live,
          ancestor || directAgent,
          ancestor?.rootPid || pid,
          ancestor ? 'process_lineage' : 'hint_only',
          ancestor ? 'process_graph' : 'process_signature',
          ancestor?.workspacePath,
        );
        return this.agentScope(this.procs.getFor(live));
      }

      this.remember({ ...live, state: 'unknown', lastSeen: now });
      pid = positiveInt(live.ppid);
      if (!pid) return { state: 'unknown' };
    }
    return { state: 'unknown' };
  }

  matchAgent(info) {
    // Codex starts short-lived filesystem helpers whose executable/comm is also `codex`.
    // They are descendants of a real Agent root, not independent terminal/window instances.
    // If their ancestry is temporarily unavailable, leave them unknown instead of inventing a
    // new root that later becomes a permanent Agent asset.
    if (isInternalAgentHelper(info)) return undefined;
    const executableMatch = this.matchAgentExecutable(info);
    if (executableMatch) return executableMatch;
    if (!this.builtinHintsEnabled) return undefined;
    const argv = text(info.argv).toLowerCase();
    if (!argv) return undefined;
    // Only the command prefix is identity evidence. Scanning every argument lets untrusted
    // prompts such as "Actor: a3s code" misclassify an ordinary node process as an Agent.
    const tokens = argv.split(/\s+/).filter(Boolean);
    const command = basename(tokens[0]);
    if (command === 'codex') return 'codex';
    if (command === 'a3s-code' || (command === 'a3s' && tokens[1] === 'code')) return 'a3s code';
    if (command === 'claude' || command === 'claude-code' || (command === 'claude' && tokens[1] === 'code')) return 'Claude Code';
    return undefined;
  }

  matchAgentExecutable(info) {
    if (isInternalAgentHelper(info)) return undefined;
    return this.signatureRegistry.match(info);
  }

  rememberAgent(info, agentId, rootPid, reason, source, inheritedWorkspacePath) {
    const match = typeof agentId === 'object' && agentId
      ? agentId
      : { agentId, displayName: agentId };
    const workspace = this.resolveWorkspace(info.workspacePath || info.cwd, inheritedWorkspacePath);
    const root = match.rootKey
      ? this.rootsByKey.get(match.rootKey)
      : this.ensureRoot({ ...info, ...workspace }, match);
    if (!root || root.runtimeState !== 'running') return this.unknown();
    const now = this.now();
    root.lastSeenAt = now;
    root.lastActivityAt = now;
    if (!root.workspacePath && workspace.workspacePath) root.workspacePath = workspace.workspacePath;
    const record = {
      ...info,
      hostId: text(info.hostId) || root.hostId,
      bootId: text(info.bootId) || root.bootId,
      state: 'agent',
      agentId: root.agentId,
      agentDisplayName: root.agentDisplayName,
      signatureRuleId: root.signatureRuleId,
      registryVersion: root.registryVersion,
      registryHash: root.registryHash,
      registryMatcherHash: root.registryMatcherHash,
      rootPid: root.pid,
      rootKey: root.rootKey,
      rootGeneration: root.generation,
      agentInstanceId: root.agentInstanceId,
      agentWorkspacePath: root.workspacePath,
      ...workspace,
      lastSeen: now,
    };
    // Some late kernel events lack start-time after /proc has disappeared. They may inherit a
    // still-live root for this event, but are deliberately not cached without a complete key.
    this.remember(record);
    return {
      state: 'agent',
      ...workspace,
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        agentScopeId: root.agentId,
        agentDisplayName: root.agentDisplayName,
        agentInstanceId: root.agentInstanceId,
        ...(root.workspacePath ? { agentWorkspacePath: root.workspacePath } : {}),
        rootPid: root.pid,
        rootKey: root.rootKey,
        rootStartTime: root.startTime,
        rootStartTimeTicks: root.startTime,
        rootGeneration: root.generation,
        confidence: source === 'process_graph' ? 0.9 : 0.85,
        reason,
        source,
        evidence: source === 'process_graph'
          ? ['process_lineage:agent_root']
          : root.evidence?.length
            ? root.evidence
            : ['process_signature:command'],
        ...(workspace.workspaceConflict ? { conflict: true } : {}),
      },
    };
  }

  agentResult(record, allowTerminal = false) {
    const root = record?.rootKey ? this.rootsByKey.get(record.rootKey) : undefined;
    if (!root || (!allowTerminal && !this.rootForRecord(record))) return this.unknown();
    const now = this.now();
    record.lastSeen = now;
    if (root.runtimeState === 'running') {
      root.lastSeenAt = now;
      root.lastActivityAt = now;
    }
    return {
      state: 'agent',
      workspacePath: record.workspacePath,
      workspaceSource: record.workspaceSource,
      workspaceConflict: record.workspaceConflict,
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        agentScopeId: record.agentId,
        agentDisplayName: record.agentDisplayName || record.agentId,
        agentInstanceId: root.agentInstanceId,
        ...(root.workspacePath ? { agentWorkspacePath: root.workspacePath } : {}),
        rootPid: record.rootPid,
        rootKey: root.rootKey,
        rootStartTime: root.startTime,
        rootStartTimeTicks: root.startTime,
        rootGeneration: record.rootGeneration,
        confidence: 0.9,
        reason: 'process_lineage',
        source: 'process_graph',
        evidence: ['process_lineage:cached_agent_root'],
        ...(record.workspaceConflict ? { conflict: true } : {}),
      },
    };
  }

  agentScope(record) {
    const root = this.rootForRecord(record);
    if (!root) return { state: 'unknown' };
    return {
      state: 'agent',
      agentId: root.agentId,
      displayName: root.agentDisplayName,
      rootPid: root.pid,
      rootKey: root.rootKey,
      rootGeneration: root.generation,
      agentInstanceId: root.agentInstanceId,
      signatureRuleId: root.signatureRuleId,
      registryVersion: root.registryVersion,
      registryHash: root.registryHash,
      registryMatcherHash: root.registryMatcherHash,
      rootStartTime: root.startTime,
      workspacePath: root.workspacePath || record.workspacePath,
    };
  }

  cachedGitWorkspace(value) {
    const normalized = canonicalWorkspacePath(value);
    if (!normalized || isEphemeralWorkspacePath(normalized)) return undefined;
    if (this.workspaceCache.has(normalized)) return this.workspaceCache.get(normalized) || undefined;
    const workspacePath = canonicalWorkspacePath(this.findWorkspaceRoot(normalized));
    if (this.workspaceCache.size >= WORKSPACE_CACHE_SIZE) this.workspaceCache.clear();
    this.workspaceCache.set(normalized, workspacePath || null);
    return workspacePath;
  }

  resolveWorkspace(ownValue, inheritedValue) {
    const ownPath = canonicalWorkspacePath(ownValue);
    const inheritedPath = canonicalWorkspacePath(inheritedValue);
    const ownGitWorkspace = this.cachedGitWorkspace(ownPath);
    if (ownGitWorkspace) {
      return { workspacePath: ownGitWorkspace, workspaceSource: 'event_git_root', workspaceConflict: false };
    }

    if (!ownPath || isEphemeralWorkspacePath(ownPath)) {
      return inheritedPath
        ? { workspacePath: inheritedPath, workspaceSource: 'agent_root', workspaceConflict: false }
        : { workspacePath: undefined, workspaceSource: 'unresolved', workspaceConflict: false };
    }

    if (!inheritedPath) {
      return { workspacePath: ownPath, workspaceSource: 'event_cwd', workspaceConflict: false };
    }

    if (isPathWithin(ownPath, inheritedPath) || isPathWithin(inheritedPath, ownPath)) {
      return { workspacePath: inheritedPath, workspaceSource: 'agent_root', workspaceConflict: false };
    }

    return { workspacePath: undefined, workspaceSource: 'conflict', workspaceConflict: true };
  }

  setInfrastructureRoots(roots) {
    const next = new Map();
    const containers = new Map();
    for (const root of Array.isArray(roots) ? roots : []) {
      const pid = positiveInt(root?.pid);
      if (!pid) continue;
      const live = this.readProcess(pid, 'fallback');
      const record = {
        ...(live || {}),
        pid,
        startTime: live?.startTime,
        state: 'infrastructure',
        rootPid: pid,
        serviceName: text(root.serviceName) || 'infrastructure',
        containerId: text(root.containerId) || undefined,
        lastSeen: this.now(),
      };
      next.set(pid, record);
      if (record.containerId) containers.set(record.containerId, record);
      const existing = this.procs.get(pid);
      if (existing?.state !== 'agent') this.remember(record);
    }
    this.infrastructureRoots = next;
    this.infrastructureContainers = containers;
    return next.size;
  }

  matchInfrastructure(info) {
    const observedId = containerIdFromCgroup(info?.cgroup);
    if (!observedId) return undefined;
    for (const [containerId, record] of this.infrastructureContainers) {
      if (containerId.startsWith(observedId) || observedId.startsWith(containerId)) {
        return this.infrastructureScope(record);
      }
    }
    return undefined;
  }

  rememberInfrastructure(info, rootPid, serviceName, containerId) {
    const record = {
      ...info,
      state: 'infrastructure',
      rootPid,
      serviceName,
      containerId,
      lastSeen: this.now(),
    };
    this.remember(record);
    return this.infrastructureResult(record);
  }

  infrastructureScope(record) {
    return {
      state: 'infrastructure',
      rootPid: record.rootPid,
      serviceName: record.serviceName,
      containerId: record.containerId,
    };
  }

  infrastructureResult(record) {
    record.lastSeen = this.now();
    return {
      ...this.infrastructureScope(record),
      reason: 'infrastructure_root',
      source: record.containerId ? 'docker_label' : 'configured_root',
    };
  }

  unknown() {
    return {
      state: 'unknown',
      attribution: {
        monitored: false,
        classification: 'unknown',
        confidence: 0,
        reason: 'not_evaluated',
        source: 'none',
        evidence: ['process_lineage:incomplete'],
      },
    };
  }

  discardReusedPid(info) {
    const hostId = text(info.hostId) || this.hostId;
    const bootId = text(info.bootId) || this.bootId;
    const existing = this.procs.get(info.pid, hostId, bootId);
    if (existing?.startTime && info.startTime && existing.startTime !== info.startTime) {
      this.procs.deleteRecord(existing);
    }
  }

  remember(record) {
    const now = this.now();
    if (this.procs.size >= this.maxProcs) {
      for (const [, item] of this.procs) {
        if (item.lastSeen < now - RECORD_TTL_MS) {
          this.procs.deleteRecord(item);
          this.stats.cacheEvictions++;
        }
      }
      if (this.procs.size >= this.maxProcs) {
        const candidates = [...this.procs.values()].sort((left, right) => {
          const leftPriority = left.state === 'agent' ? 1 : 0;
          const rightPriority = right.state === 'agent' ? 1 : 0;
          return leftPriority - rightPriority || (left.lastSeen || 0) - (right.lastSeen || 0);
        });
        const target = Math.max(1, Math.ceil(this.maxProcs * 0.05));
        for (let index = 0; index < target && this.procs.size >= this.maxProcs; index += 1) {
          if (this.procs.deleteRecord(candidates[index])) this.stats.cacheEvictions++;
        }
      }
    }
    return this.procs.set(record.pid, {
      ...record,
      nextResolveAt:
        record.state === 'agent'
          ? 0
          : record.nextResolveAt ?? now + this.negativeTtlMs,
    });
  }

  metrics() {
    this.pruneTombstones();
    return {
      processes: this.procs.size,
      tombstones: this.tombstones.size,
      runtimeSignatures: this.signatureRegistry.metrics(),
      ...this.stats,
    };
  }
}

module.exports = {
  AgentAttributor,
  ProcessRecordStore,
  canonicalWorkspacePath,
  findGitWorkspace,
  isEphemeralWorkspacePath,
  containerIdFromCgroup,
  readProcInfo,
  listProcPids,
  processKey,
  readProcStartTime,
};
