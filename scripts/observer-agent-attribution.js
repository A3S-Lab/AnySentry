'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT_NAMES = 'codex,a3s,a3s-code,a3s code,claude,claude-code,claude code';
const DEFAULT_MAX_PROCS = 20_000;
const DEFAULT_MAX_ANCESTORS = 32;
const RECORD_TTL_MS = 30 * 60_000;

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function eventPayload(observerEvent) {
  const entries = Object.entries(observerEvent?.event ?? {});
  return entries.length > 0 && entries[0][1] && typeof entries[0][1] === 'object' ? entries[0][1] : {};
}

function argvText(value) {
  if (Array.isArray(value)) return value.map(String).join(' ');
  return text(value);
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
    try {
      const status = fs.readFileSync(path.join(base, 'status'), 'utf8');
      tgid = positiveInt(status.match(/^Tgid:\s+(\d+)/m)?.[1]);
    } catch {}
    try { exe = fs.readlinkSync(path.join(base, 'exe')); } catch {}
    try { argv = fs.readFileSync(path.join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' '); } catch {}
    return { pid, tgid, ppid, startTime, comm, exe, argv };
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

class AgentAttributor {
  constructor(options = {}) {
    this.procRoot = options.procRoot || '/proc';
    this.maxProcs = positiveInt(options.maxProcs) || DEFAULT_MAX_PROCS;
    this.maxAncestors = positiveInt(options.maxAncestors) || DEFAULT_MAX_ANCESTORS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.readProc = typeof options.readProc === 'function' ? options.readProc : (pid) => readProcInfo(pid, this.procRoot);
    this.listPids = typeof options.listPids === 'function' ? options.listPids : () => listProcPids(this.procRoot);
    this.rootNames = new Set((options.rootNames || process.env.ANYSENTRY_AGENT_ROOT_NAMES || DEFAULT_ROOT_NAMES)
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
    this.procs = new Map();
  }

  seedFromProc() {
    const now = this.now();
    const snapshot = new Map();
    for (const pid of this.listPids().slice(0, this.maxProcs)) {
      const info = this.readProc(pid);
      if (info) snapshot.set(pid, info);
    }

    let roots = 0;
    for (const info of snapshot.values()) {
      const agentId = this.matchAgentExecutable(info);
      if (!agentId) continue;
      this.remember({ ...info, state: 'agent', agentId, rootPid: info.tgid || info.pid, lastSeen: now });
      roots++;
    }

    let descendants = 0;
    for (const info of snapshot.values()) {
      if (this.procs.get(info.pid)?.state === 'agent') continue;
      const scope = this.resolveSnapshotScope(info, snapshot);
      if (!scope) continue;
      this.remember({ ...info, state: 'agent', agentId: scope.agentId, rootPid: scope.rootPid, lastSeen: now });
      descendants++;
    }
    return { scanned: snapshot.size, roots, descendants };
  }

  resolveSnapshotScope(info, snapshot) {
    let current = info;
    const visited = new Set();
    for (let depth = 0; current && depth < this.maxAncestors; depth++) {
      if (visited.has(current.pid)) return undefined;
      visited.add(current.pid);

      const tgid = positiveInt(current.tgid);
      if (tgid && tgid !== current.pid) {
        const leader = this.procs.get(tgid);
        if (leader?.state === 'agent') return { agentId: leader.agentId, rootPid: leader.rootPid };
      }
      const cached = this.procs.get(current.pid);
      if (cached?.state === 'agent') return { agentId: cached.agentId, rootPid: cached.rootPid };

      const ppid = positiveInt(current.ppid);
      if (!ppid || ppid === 1) return undefined;
      current = snapshot.get(ppid);
    }
    return undefined;
  }

  classify(observerEvent) {
    const now = this.now();
    const payload = eventPayload(observerEvent);
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object' ? observerEvent.process : {};
    const pid = positiveInt(processInfo.pid) || positiveInt(payload.pid) || positiveInt(observerEvent?.identity?.task);
    if (!pid) return this.unknown();
    const exiting = Object.prototype.hasOwnProperty.call(observerEvent?.event ?? {}, 'ProcessExit');

    const live = this.readProc(pid);
    const current = {
      pid,
      ppid: positiveInt(processInfo.ppid) || positiveInt(payload.ppid) || live?.ppid,
      startTime:
        text(processInfo.startTimeTicks) ||
        text(processInfo.start_time_ticks) ||
        text(processInfo.startTimeNs) ||
        text(processInfo.start_time_ns) ||
        live?.startTime,
      comm: text(processInfo.comm) || live?.comm || text(observerEvent?.identity?.agent),
      exe: text(processInfo.exe) || live?.exe,
      argv: argvText(payload.argv) || live?.argv,
    };
    this.discardReusedPid(current);

    const directAgent = this.matchAgent(current);
    if (directAgent) return this.finish(pid, this.rememberAgent(current, directAgent, pid, 'hint_only', 'argv'), exiting);

    const existing = this.procs.get(pid);
    if (existing?.state === 'agent') return this.finish(pid, this.agentResult(existing), exiting);

    // Short-process events can arrive out of order. Re-evaluate negative cache entries when
    // a later event carries a usable parent, otherwise ProcessExit can hide the ToolExec lineage.
    const ancestry = this.resolveAncestry(current.ppid, now);
    if (ancestry.state === 'agent') {
      return this.finish(pid, this.rememberAgent(current, ancestry.agentId, ancestry.rootPid, 'process_lineage', 'process_graph'), exiting);
    }

    if (ancestry.state === 'non_agent') {
      this.remember({ ...current, state: 'non_agent', lastSeen: now });
      return this.finish(pid, {
        state: 'non_agent',
        attribution: {
          monitored: false,
          classification: 'non_agent',
          confidence: 1,
          reason: 'not_agent',
          source: 'process_graph',
          evidence: ['process_lineage:pid1'],
        },
      }, exiting);
    }

    this.remember({ ...current, state: 'unknown', lastSeen: now });
    return this.finish(pid, this.unknown(), exiting);
  }

  finish(pid, result, exiting) {
    if (exiting) this.procs.delete(pid);
    return result;
  }

  resolveAncestry(initialPpid, now) {
    let pid = positiveInt(initialPpid);
    if (!pid) return { state: 'unknown' };
    const visited = new Set();

    for (let depth = 0; depth < this.maxAncestors; depth++) {
      if (visited.has(pid)) return { state: 'unknown' };
      visited.add(pid);

      const cached = this.procs.get(pid);
      if (cached?.state === 'agent') return { state: 'agent', agentId: cached.agentId, rootPid: cached.rootPid };
      if (pid === 1) return { state: 'non_agent' };

      const live = this.readProc(pid);
      if (!live) return cached?.state === 'non_agent' ? { state: 'non_agent' } : { state: 'unknown' };
      this.discardReusedPid(live);

      const tgid = positiveInt(live.tgid);
      if (tgid && tgid !== pid) {
        const leaderCached = this.procs.get(tgid);
        if (leaderCached?.state === 'agent') {
          this.remember({ ...live, state: 'agent', agentId: leaderCached.agentId, rootPid: leaderCached.rootPid, lastSeen: now });
          return { state: 'agent', agentId: leaderCached.agentId, rootPid: leaderCached.rootPid };
        }

        const leader = this.readProc(tgid);
        if (leader) {
          this.discardReusedPid(leader);
          const leaderAgent = this.matchAgent(leader);
          if (leaderAgent) {
            this.remember({ ...leader, state: 'agent', agentId: leaderAgent, rootPid: tgid, lastSeen: now });
            this.remember({ ...live, state: 'agent', agentId: leaderAgent, rootPid: tgid, lastSeen: now });
            return { state: 'agent', agentId: leaderAgent, rootPid: tgid };
          }
        }
      }

      const directAgent = this.matchAgent(live);
      if (directAgent) {
        this.remember({ ...live, state: 'agent', agentId: directAgent, rootPid: pid, lastSeen: now });
        return { state: 'agent', agentId: directAgent, rootPid: pid };
      }

      this.remember({ ...live, state: 'unknown', lastSeen: now });
      pid = positiveInt(live.ppid);
      if (!pid) return { state: 'unknown' };
    }
    return { state: 'unknown' };
  }

  matchAgent(info) {
    const executableMatch = this.matchAgentExecutable(info);
    if (executableMatch) return executableMatch;
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
    const candidates = [basename(info.comm), basename(info.exe)];
    for (const root of this.rootNames) {
      if (candidates.includes(root)) return canonicalAgentName(root);
    }
    return undefined;
  }

  rememberAgent(info, agentId, rootPid, reason, source) {
    const record = { ...info, state: 'agent', agentId, rootPid, lastSeen: this.now() };
    this.remember(record);
    return {
      state: 'agent',
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        agentScopeId: agentId,
        agentDisplayName: agentId,
        rootPid,
        confidence: source === 'process_graph' ? 0.9 : 0.85,
        reason,
        source,
        evidence: [source === 'process_graph' ? 'process_lineage:agent_root' : 'process_signature:command'],
      },
    };
  }

  agentResult(record) {
    record.lastSeen = this.now();
    return {
      state: 'agent',
      attribution: {
        monitored: true,
        classification: 'probable_agent',
        agentScopeId: record.agentId,
        agentDisplayName: record.agentId,
        rootPid: record.rootPid,
        confidence: 0.9,
        reason: 'process_lineage',
        source: 'process_graph',
        evidence: ['process_lineage:cached_agent_root'],
      },
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
    const existing = this.procs.get(info.pid);
    if (existing?.startTime && info.startTime && existing.startTime !== info.startTime) this.procs.delete(info.pid);
  }

  remember(record) {
    const now = this.now();
    if (this.procs.size >= this.maxProcs) {
      for (const [pid, item] of this.procs) {
        if (item.lastSeen < now - RECORD_TTL_MS) this.procs.delete(pid);
      }
      if (this.procs.size >= this.maxProcs) this.procs.clear();
    }
    this.procs.set(record.pid, record);
  }
}

module.exports = { AgentAttributor, readProcInfo, listProcPids };
