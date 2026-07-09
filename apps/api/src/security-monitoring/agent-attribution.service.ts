import { Injectable } from '@nestjs/common';
import { AgentAttribution, EventMeta, ProcessContext } from './types';

type ProcRecord = {
  pid: number;
  ppid?: number;
  comm?: string;
  cwd?: string;
  agentId?: string;
  sessionId?: string;
  rootPid?: number;
  confidence: number;
  lastSeen: number;
};

const MAX_PROCS = 20_000;
const ROOT_NAMES = (process.env.ANYSENTRY_AGENT_ROOT_NAMES || 'codex,a3s,a3s-code,a3s code,claude,claude-code,claude code')
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

function directRootMatch(comm?: string, exe?: string, agentId?: string): string | undefined {
  const names = [basename(comm), basename(exe), basename(agentId)].filter(Boolean);
  return ROOT_NAMES.find((root) => names.some((name) => name === root));
}

function argvRootMatch(argv?: string): string | undefined {
  const text = lower(argv);
  if (!text) return undefined;
  if (text.includes('__codex_') || text.includes('codex_thread_id')) return 'codex';
  if (/^a3s\s+code(?:\s|$)/.test(text) || /\/a3s\s+code(?:\s|$)/.test(text)) return 'a3s code';
  if (/^claude(?:[-\s]code)?(?:\s|$)/.test(text) || /\/claude(?:[-\s]code)?(?:\s|$)/.test(text)) return 'Claude Code';
  return undefined;
}

function readProcName(pid?: number): string | undefined {
  if (!pid) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
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
    const comm = process?.comm ?? attrString(attributes, 'comm') ?? meta.agentId;
    const exe = process?.exe ?? attrString(attributes, 'exe');
    const argv = attrString(attributes, 'argv');
    const cwd = process?.cwd ?? attrString(attributes, 'cwd') ?? meta.workspacePath;
    if (!pid) return this.notAgent('not_evaluated');

    const direct = this.matchRoot(pid, ppid, comm, exe, argv, meta, at);
    if (direct) {
      this.remember({ pid, ppid, comm, cwd, agentId: direct.agentScopeId, sessionId: direct.agentSessionId, rootPid: pid, confidence: direct.confidence, lastSeen: at });
      return direct;
    }

    const parentRoot = this.matchParentRoot(ppid, meta);
    if (parentRoot) {
      this.remember({ pid: ppid!, agentId: parentRoot.agentScopeId, sessionId: parentRoot.agentSessionId, rootPid: ppid, confidence: parentRoot.confidence, lastSeen: at });
    }

    const parent = ppid ? this.procs.get(ppid) : undefined;
    if (parent?.agentId) {
      const confidence = Math.max(0, parent.confidence - INHERIT_DECAY);
      const rec = { pid, ppid, comm, cwd, agentId: parent.agentId, sessionId: parent.sessionId, rootPid: parent.rootPid ?? parent.pid, confidence, lastSeen: at };
      this.remember(rec);
      return {
        monitored: confidence >= MIN_MONITORED_CONFIDENCE,
        agentScopeId: parent.agentId,
        agentDisplayName: parent.agentId,
        agentSessionId: parent.sessionId,
        rootPid: parent.rootPid ?? parent.pid,
        confidence,
        reason: 'process_lineage',
        source: 'process_graph',
      };
    }

    const existing = this.procs.get(pid);
    if (existing?.agentId) {
      existing.lastSeen = at;
      return {
        monitored: existing.confidence >= MIN_MONITORED_CONFIDENCE,
        agentScopeId: existing.agentId,
        agentDisplayName: existing.agentId,
        agentSessionId: existing.sessionId,
        rootPid: existing.rootPid,
        confidence: existing.confidence,
        reason: 'process_lineage',
        source: 'process_graph',
      };
    }

    this.remember({ pid, ppid, comm, cwd, confidence: 0, lastSeen: at });
    return this.notAgent('not_agent');
  }

  private matchRoot(pid: number, ppid: number | undefined, comm: string | undefined, exe: string | undefined, argv: string | undefined, meta: EventMeta, at: number): AgentAttribution | undefined {
    const name = lower(comm || meta.agentId);
    if (!name || (GENERIC_NAMES.has(name) && !argvRootMatch(argv))) return undefined;
    const matched = directRootMatch(comm, exe, meta.agentId) ?? argvRootMatch(argv);
    if (!matched) return undefined;
    const confidence = 0.82;
    return {
      monitored: confidence >= MIN_MONITORED_CONFIDENCE,
      agentScopeId: canonicalAgentName(matched) ?? matched,
      agentDisplayName: canonicalAgentName(matched) ?? matched,
      agentSessionId: meta.sessionId,
      rootPid: pid,
      confidence,
      reason: 'hint_only',
      source: 'argv',
    };
  }

  private matchParentRoot(ppid: number | undefined, meta: EventMeta): AgentAttribution | undefined {
    const parentComm = readProcName(ppid);
    const matched = directRootMatch(parentComm);
    if (!matched) return undefined;
    const confidence = 0.82;
    return {
      monitored: confidence >= MIN_MONITORED_CONFIDENCE,
      agentScopeId: canonicalAgentName(matched) ?? matched,
      agentDisplayName: canonicalAgentName(matched) ?? matched,
      agentSessionId: meta.sessionId,
      rootPid: ppid,
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
