import { createHash } from 'node:crypto';
import type {
  LocalRecordTimelineEvent, LocalSessionSystemEvidence, LocalToolEvidence,
} from './local-record-tracking.types';

type Token = { value: string; string?: boolean };
const MAX_INPUT = 200_000;
const MAX_TOKENS = 30_000;

// The ingestion layer hashes the complete shell script before redacting/capping argv for
// display. Incomplete kernel argv must not supply an equality key, even for candidates.
export function observedCommandHash(attributes: Record<string, unknown>): string | undefined {
  const value = attributes['anysentry.kernel.command_hash'];
  return attributes.exec_confirmed === true && attributes.argv_truncated === false
    && attributes.argv_incomplete === false && typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
    ? value : undefined;
}

// A deliberately small lexical subset. Never execute recorded code. Templates and regex
// literals are unsupported, including apparent tool calls embedded inside either of them.
function tokens(input: string): Token[] | undefined {
  if (input.length > MAX_INPUT) return undefined;
  const out: Token[] = [];
  for (let i = 0; i < input.length;) {
    const c = input[i];
    if (/\s/u.test(c)) { i += 1; continue; }
    if (input.startsWith('//', i)) {
      const end = input.indexOf('\n', i + 2); i = end < 0 ? input.length : end + 1; continue;
    }
    if (input.startsWith('/*', i)) {
      const end = input.indexOf('*/', i + 2); if (end < 0) return undefined;
      i = end + 2; continue;
    }
    if (c === '`' || c === '/') return undefined;
    if (c === '"' || c === "'") {
      const quote = c; let value = ''; let closed = false; i += 1;
      while (i < input.length) {
        const next = input[i++];
        if (next === quote) { closed = true; break; }
        if (next === '\n' || next === '\r') return undefined;
        if (next !== '\\') { value += next; continue; }
        const escaped = input[i++];
        const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'" };
        if (escaped in simple) value += simple[escaped];
        else if (escaped === 'u' || escaped === 'x') {
          const length = escaped === 'u' ? 4 : 2;
          const hex = input.slice(i, i + length);
          if (hex.length !== length || !/^[0-9a-f]+$/iu.test(hex)) return undefined;
          value += String.fromCharCode(parseInt(hex, 16)); i += length;
        } else return undefined;
      }
      if (!closed) return undefined;
      out.push({ value, string: true });
    } else if (/[a-zA-Z_$0-9]/u.test(c)) {
      const start = i++;
      while (i < input.length && /[a-zA-Z_$0-9]/u.test(input[i])) i += 1;
      out.push({ value: input.slice(start, i) });
    } else out.push({ value: c }), i += 1;
    if (out.length > MAX_TOKENS) return undefined;
  }
  return out;
}

function matching(tokens: Token[], start: number): number | undefined {
  const closes: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const stack: string[] = [];
  for (let i = start; i < tokens.length; i += 1) {
    const t = tokens[i]; if (t.string) continue;
    if (closes[t.value]) stack.push(closes[t.value]);
    else if (['}', ']', ')'].includes(t.value)) {
      if (stack.pop() !== t.value) return undefined;
      if (!stack.length) return i;
    }
  }
  return undefined;
}

function objectCommand(ts: Token[], start: number, end: number): string | undefined {
  let command: string | undefined; let seen = false;
  for (let i = start + 1; i < end;) {
    const key = ts[i++];
    // Spreads, shorthand and computed properties can override cmd at runtime.
    if (!key || (!key.string && !/^[a-zA-Z_$][\w$]*$/u.test(key.value)) || ts[i++]?.value !== ':') return undefined;
    const begin = i;
    while (i < end && (ts[i].string || ts[i].value !== ',')) {
      if (!ts[i].string && ['{', '[', '('].includes(ts[i].value)) {
        const close = matching(ts, i); if (close === undefined || close >= end) return undefined;
        i = close + 1;
      } else i += 1;
    }
    if (key.value === 'cmd' || key.value === 'command') {
      if (seen || i !== begin + 1 || !ts[begin]?.string) return undefined;
      seen = true; command = ts[begin].value;
    }
    if (i < end) i += 1;
  }
  return command?.trim() ? command : undefined;
}

export function staticToolCommands(call: LocalRecordTimelineEvent): string[] {
  if (call.phase === 'tool_pending') return [];
  if (call.command?.trim()) return [call.command];
  const ts = tokens(call.content ?? '');
  if (!ts) return [];
  if (ts[0]?.value === '{' && matching(ts, 0) === ts.length - 1) {
    const cmd = objectCommand(ts, 0, ts.length - 1); return cmd ? [cmd] : [];
  }
  const commands = new Set<string>();
  for (let i = 0; i + 5 < ts.length; i += 1) {
    if (ts.slice(i, i + 5).some(t => t.string) || ts[i].value !== 'tools' || ts[i - 1]?.value === '.'
      || ts[i + 1].value !== '.' || ts[i + 2].value !== 'exec_command'
      || ts[i + 3].value !== '(' || ts[i + 4].value !== '{') continue;
    const end = matching(ts, i + 4);
    if (end === undefined || ts[end + 1]?.value !== ')') continue;
    const cmd = objectCommand(ts, i + 4, end);
    if (cmd) commands.add(cmd);
    i = end + 1;
  }
  return [...commands];
}

function commandMatch(observed: string | undefined, commands: string[], commandHash?: string) {
  const raw = observed?.trim(); if (!raw) return undefined;
  if (commands.some(command => command.trim() === raw)) return 'exact_command' as const;
  // The current Observer argv projection is flattened. Only remove one known launcher
  // prefix; preserve the entire script, quoting, substitutions and argument boundaries.
  // Even an exact match here is only a candidate, never authenticated execution identity.
  const wrapper = /^(?:(?:\/usr)?\/bin\/)?(?:bash|sh|dash|zsh) -(?:c|lc|cl) ([\s\S]+)$/u.exec(raw);
  if (!wrapper) return undefined;
  if (commands.some(command => command.trim() === wrapper[1])) return 'shell_wrapper' as const;
  // Native Kimi prepends a literal cwd to Bash scripts. Recognize only that narrow wrapper,
  // and require the complete kernel script hash; truncated argv cannot prove this equality.
  const cwd = /^cd '[^'\r\n]+' && /u.exec(wrapper[1]);
  if (cwd && commandHash && commands.some(command => {
    const script = cwd[0] + command;
    // The display command may be capped independently of the complete kernel hash.
    return createHash('sha256').update(script).digest('hex') === commandHash;
  })) return 'shell_wrapper' as const;
  return undefined;
}

export function buildLocalToolEvidence(
  nativeSessionId: string,
  timeline: readonly LocalRecordTimelineEvent[],
  evidence: LocalSessionSystemEvidence | undefined,
  semanticPartial = false,
): LocalToolEvidence {
  const calls = timeline.filter(e => e.kind === 'tool_call');
  const counts = new Map<string, number>();
  for (const call of calls) if (call.callId) counts.set(call.callId, (counts.get(call.callId) ?? 0) + 1);
  const scopeMatches = evidence?.binding.nativeSessionId === nativeSessionId;
  const events = scopeMatches ? [...new Map(evidence!.events.map(e => [e.eventId, e])).values()] : [];
  const edgesByChild = new Map<string, LocalSessionSystemEvidence['lineage']>();
  if (scopeMatches) for (const edge of evidence!.lineage ?? []) {
    edgesByChild.set(edge.childProcessInstanceKey, [...(edgesByChild.get(edge.childProcessInstanceKey) ?? []), edge]);
  }
  const result: LocalToolEvidence = {
    schemaVersion: 'anysentry.local-tool-evidence.v1', nativeSessionId, scope: 'loaded_window',
    partial: semanticPartial || !scopeMatches || evidence!.completeness !== 'complete_as_observed' || Boolean(evidence!.page?.hasMore),
    calls: [],
  };
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (event: LocalSessionSystemEvidence['events'][number]) => {
    const cached = ancestry.get(event.eventId); if (cached) return cached;
    const reachable = new Set([event.processInstanceKey]);
    let frontier = [event.processInstanceKey];
    for (let depth = 0; depth < 32 && frontier.length && reachable.size <= 256; depth += 1) {
      const next: string[] = [];
      for (const key of frontier) for (const edge of edgesByChild.get(key) ?? []) {
        if (edge.validFrom > event.at || (edge.validTo !== undefined && edge.validTo < event.at)
          || reachable.has(edge.parentProcessInstanceKey)) continue;
        if (reachable.size >= 256) { result.partial = true; continue; }
        reachable.add(edge.parentProcessInstanceKey); next.push(edge.parentProcessInstanceKey);
      }
      frontier = next;
    }
    if (frontier.length) result.partial = true;
    ancestry.set(event.eventId, reachable);
    return reachable;
  };
  for (const call of calls) {
    const row: LocalToolEvidence['calls'][number] = {
      callEventId: call.eventId, callId: call.callId, status: 'unmatched', confirmedEventIds: [], candidates: [],
    };
    result.calls.push(row);
    if (!call.callId || counts.get(call.callId)! > 1) { row.status = 'ambiguous'; continue; }
    row.confirmedEventIds = events.filter(e => e.toolCallBinding?.method === 'authenticated_agent_adapter'
      && e.toolCallBinding.toolCallId === call.callId).map(e => e.eventId);
    const ends = timeline.filter(e => e.kind === 'tool_result' && e.callId === call.callId
      && e.turnId === call.turnId && e.timestamp >= call.timestamp);
    if (!ends.length) { row.status = row.confirmedEventIds.length ? 'confirmed' : 'pending'; continue; }
    const until = Math.min(...ends.map(e => e.timestamp)) + 250;
    const since = call.timestamp - 250;
    const commands = staticToolCommands(call);
    if (!commands.length) { row.status = row.confirmedEventIds.length ? 'confirmed' : 'unsupported'; continue; }
    const eligible = events.filter(e => !e.toolCallBinding && e.processInstanceKey && e.at >= since && e.at <= until);
    const hashes = new Set(commands.map(command => createHash('sha256').update(command).digest('hex')));
    const anchors = eligible.flatMap(e => {
      const reason = e.eventKind === 'ToolExec'
        ? e.commandHash && hashes.has(e.commandHash) ? 'command_hash' as const : commandMatch(e.command, commands, e.commandHash)
        : undefined;
      return reason ? [{ event: e, reason }] : [];
    });
    for (const event of anchors.length ? eligible : []) {
      const direct = anchors.find(a => a.event.eventId === event.eventId);
      if (direct) { row.candidates.push({ eventId: event.eventId, anchorEventId: event.eventId, reason: direct.reason }); continue; }
      const reachable = ancestors(event);
      const anchor = anchors.find(a => a.event.at <= event.at && reachable.has(a.event.processInstanceKey));
      if (anchor) row.candidates.push({ eventId: event.eventId, anchorEventId: anchor.event.eventId, reason: 'process_lineage' });
    }
    row.status = row.confirmedEventIds.length ? 'confirmed' : row.candidates.length ? 'candidate' : 'unmatched';
  }
  const owners = new Map<string, Set<string>>();
  for (const row of result.calls) for (const item of row.candidates) {
    owners.set(item.eventId, new Set([...(owners.get(item.eventId) ?? []), row.callEventId]));
  }
  for (const row of result.calls) if (row.status === 'candidate'
    && row.candidates.some(c => owners.get(c.eventId)!.size > 1)) row.status = 'ambiguous';
  return result;
}
