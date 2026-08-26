import { Injectable } from '@nestjs/common';
import { AgentAttribution, EventMeta, ProcessContext } from './types';

type ProcRecord = {
  pid: number;
  ppid?: number;
  comm?: string;
  cwd?: string;
  agentWorkspacePath?: string;
  agentId?: string;
  sessionId?: string;
  rootPid?: number;
  rootStartTime?: string;
  startTime?: string;
  confidence: number;
  lastSeen: number;
};

const MAX_PROCS = 20_000;
const BUILTIN_AGENT_HINTS_ENABLED = !['0', 'false', 'off', 'no', 'disabled'].includes(
  (process.env.ANYSENTRY_BUILTIN_AGENT_HINTS ?? 'on').trim().toLowerCase(),
);
const ROOT_NAMES = (
  process.env.ANYSENTRY_AGENT_ROOT_NAMES ??
  (BUILTIN_AGENT_HINTS_ENABLED ? 'codex,a3s,a3s-code,a3s code,claude,claude-code,claude code' : '')
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const GENERIC_NAMES = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh']);
const INHERIT_DECAY = 0.05;
const MIN_MONITORED_CONFIDENCE = 0.7;

function lower(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

function attrNumber(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = Number(attributes[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function attrString(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function basename(value?: string): string {
  const text = lower(value);
  return text.split('/').filter(Boolean).at(-1) ?? text;
}

function canonicalAgentName(value?: string): string | undefined {
  const text = lower(value);
  if (!text) return undefined;
  if (text === 'a3s' || text === 'a3s-code' || text === 'a3s code') return 'a3s code';
  if (text === 'claude' || text === 'claude-code' || text === 'claude code') return 'Claude Code';
  return text;
}

function isInternalAgentHelper(argv?: string): boolean {
  const tokens = lower(argv).split(/\s+/u).filter(Boolean);
  return (
    tokens.includes('--codex-run-as-fs-helper') ||
    basename(tokens[0]) === 'codex-linux-sandbox' ||
    tokens.includes('--sandbox-policy-cwd')
  );
}

function directRootMatch(comm?: string, exe?: string, argv?: string): string | undefined {
  if (isInternalAgentHelper(argv)) return undefined;
  const names = [basename(comm), basename(exe)].filter(Boolean);
  return ROOT_NAMES.find((root) => names.some((name) => name === root));
}

function argvRootMatch(argv?: string): string | undefined {
  if (!BUILTIN_AGENT_HINTS_ENABLED) return undefined;
  if (isInternalAgentHelper(argv)) return undefined;
  const text = lower(argv);
  if (!text) return undefined;
  const tokens = text.split(/\s+/u).filter(Boolean);
  const command = basename(tokens[0]);
  if (command === 'codex') return 'codex';
  if (command === 'a3s-code' || (command === 'a3s' && tokens[1] === 'code')) return 'a3s code';
  if (command === 'claude' || command === 'claude-code') return 'Claude Code';
  return undefined;
}

type ProcIdentity = {
  pid: number;
  tgid?: number;
  startTime?: string;
  comm?: string;
  exe?: string;
  argv?: string;
  cwd?: string;
};

function readProcIdentity(pid?: number): ProcIdentity | undefined {
  if (!pid) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    let tgid: number | undefined;
    let startTime: string | undefined;
    let exe: string | undefined;
    let argv: string | undefined;
    let cwd: string | undefined;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close >= 0) startTime = stat.slice(close + 2).trim().split(/\s+/u)[19];
    } catch {}
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const value = Number(status.match(/^Tgid:\s+(\d+)/m)?.[1]);
      if (Number.isInteger(value) && value > 0) tgid = value;
    } catch {}
    try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .join(' ');
    } catch {}
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
    return { pid, tgid, startTime, comm, exe, argv, cwd };
  } catch {
    return undefined;
  }
}

@Injectable()
export class AgentAttributionService {
  private readonly procs = new Map<number, ProcRecord>();

  attribute(meta: EventMeta, process: ProcessContext | undefined, at: number): AgentAttribution {
    const attributes = meta.attributes ?? {};
    const pid = process?.pid ?? attrNumber(attributes, 'pid') ?? attrNumber(attributes, 'observerTask');
    const ppid = process?.ppid ?? attrNumber(attributes, 'ppid');
    const comm = process?.comm ?? attrString(attributes, 'comm');
    const exe = process?.exe ?? attrString(attributes, 'exe');
    const argv = attrString(attributes, 'argv');
    const cwd = process?.cwd ?? attrString(attributes, 'cwd') ?? meta.workspacePath;
    const startTime = process?.startTimeTicks ?? process?.startTimeNs;
    if (!pid) return this.notAgent('not_evaluated');

    const existing = this.procs.get(pid);
    if (existing && startTime && existing.startTime && existing.startTime !== startTime) {
      this.procs.delete(pid);
    } else if (existing?.agentId) {
      existing.lastSeen = at;
      return {
        monitored: existing.confidence >= MIN_MONITORED_CONFIDENCE,
        agentScopeId: existing.agentId,
        agentDisplayName: existing.agentId,
        agentSessionId: existing.sessionId,
        agentWorkspacePath: existing.agentWorkspacePath,
        rootPid: existing.rootPid,
        rootStartTime: existing.rootStartTime,
        confidence: existing.confidence,
        reason: 'process_lineage',
        source: 'process_graph',
      };
    }

    const parentRoot = this.matchParentRoot(ppid, meta);
    if (parentRoot) {
      this.remember({
        pid: ppid!,
        agentId: parentRoot.agentScopeId,
        sessionId: parentRoot.agentSessionId,
        rootPid: parentRoot.rootPid ?? ppid,
        rootStartTime: parentRoot.rootStartTime,
        startTime: parentRoot.rootStartTime,
        agentWorkspacePath: parentRoot.agentWorkspacePath,
        confidence: parentRoot.confidence,
        lastSeen: at,
      });
    }

    const parent = ppid ? this.procs.get(ppid) : undefined;
    if (parent?.agentId) {
      const confidence = Math.max(0, parent.confidence - INHERIT_DECAY);
      const rec = {
        pid,
        ppid,
        comm,
        cwd,
        agentWorkspacePath: parent.agentWorkspacePath ?? parent.cwd,
        startTime,
        agentId: parent.agentId,
        sessionId: parent.sessionId,
        rootPid: parent.rootPid ?? parent.pid,
        rootStartTime: parent.rootStartTime ?? parent.startTime,
        confidence,
        lastSeen: at,
      };
      this.remember(rec);
      return {
        monitored: confidence >= MIN_MONITORED_CONFIDENCE,
        agentScopeId: parent.agentId,
        agentDisplayName: parent.agentId,
        agentSessionId: parent.sessionId,
        agentWorkspacePath: parent.agentWorkspacePath ?? parent.cwd,
        rootPid: parent.rootPid ?? parent.pid,
        rootStartTime: parent.rootStartTime ?? parent.startTime,
        confidence,
        reason: 'process_lineage',
        source: 'process_graph',
      };
    }

    const direct = this.matchRoot(pid, ppid, comm, exe, argv, meta, at, startTime, cwd);
    if (direct) {
      this.remember({
        pid,
        ppid,
        comm,
        cwd,
        agentWorkspacePath: direct.agentWorkspacePath ?? cwd,
        startTime,
        agentId: direct.agentScopeId,
        sessionId: direct.agentSessionId,
        rootPid: pid,
        rootStartTime: startTime,
        confidence: direct.confidence,
        lastSeen: at,
      });
      return direct;
    }

    this.remember({ pid, ppid, comm, cwd, startTime, confidence: 0, lastSeen: at });
    return this.notAgent('not_agent');
  }

  private matchRoot(pid: number, ppid: number | undefined, comm: string | undefined, exe: string | undefined, argv: string | undefined, meta: EventMeta, at: number, startTime?: string, cwd?: string): AgentAttribution | undefined {
    if (isInternalAgentHelper(argv)) return undefined;
    const name = lower(comm || exe);
    if (!name || (GENERIC_NAMES.has(name) && !argvRootMatch(argv))) return undefined;
    const matched = directRootMatch(comm, exe, argv) ?? argvRootMatch(argv);
    if (!matched) return undefined;
    const confidence = 0.82;
    return {
      monitored: confidence >= MIN_MONITORED_CONFIDENCE,
      agentScopeId: canonicalAgentName(matched) ?? matched,
      agentDisplayName: canonicalAgentName(matched) ?? matched,
      agentSessionId: meta.sessionId,
      agentWorkspacePath: cwd ?? meta.workspacePath,
      rootPid: pid,
      rootStartTime: startTime,
      confidence,
      reason: 'hint_only',
      source: 'argv',
    };
  }

  private matchParentRoot(ppid: number | undefined, meta: EventMeta): AgentAttribution | undefined {
    const parent = readProcIdentity(ppid);
    const leader = parent?.tgid && parent.tgid !== parent.pid ? readProcIdentity(parent.tgid) : parent;
    const matched =
      directRootMatch(parent?.comm, parent?.exe, parent?.argv) ??
      directRootMatch(leader?.comm, leader?.exe, leader?.argv);
    if (!matched) return undefined;
    const confidence = 0.82;
    return {
      monitored: confidence >= MIN_MONITORED_CONFIDENCE,
      agentScopeId: canonicalAgentName(matched) ?? matched,
      agentDisplayName: canonicalAgentName(matched) ?? matched,
      agentSessionId: meta.sessionId,
      agentWorkspacePath: leader?.cwd ?? parent?.cwd ?? meta.workspacePath,
      rootPid: leader?.pid ?? ppid,
      rootStartTime: leader?.startTime ?? parent?.startTime,
      confidence,
      reason: 'hint_only',
      source: 'process_graph',
    };
  }

  private remember(rec: ProcRecord): void {
    if (this.procs.size >= MAX_PROCS) {
      const cutoff = Date.now() - 30 * 60_000;
      for (const [pid, item] of this.procs) {
        if (item.lastSeen < cutoff) this.procs.delete(pid);
      }
      if (this.procs.size >= MAX_PROCS) this.procs.clear();
    }
    this.procs.set(rec.pid, rec);
  }

  private notAgent(reason: 'not_evaluated' | 'not_agent'): AgentAttribution {
    return { monitored: false, confidence: 0, reason, source: 'none' };
  }
}
