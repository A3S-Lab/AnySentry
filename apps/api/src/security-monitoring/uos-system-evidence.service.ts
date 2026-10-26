import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClickHouseStore } from './clickhouse-store';
import {
  isLlmShapedRow,
  parseUosPayload,
  UOS_CONVERSATION_PREFIX,
  uosConversationAnchor,
  type UosInteractionRow,
} from './interaction-uos-plaintext';
import type { LocalSessionSystemEvidence } from './local-record-tracking.types';
import { canonicalProcessLifecycleIdentity } from './process-lifecycle';
import type { JudgedEvent, ProcessContext } from './types';

const DEFAULT_EVENT_LIMIT = 250;
const MAX_EVENT_LIMIT = 5_000;
const MAX_INTERACTIONS = 256;
const INTERACTION_LOOKUP_MS = 7 * 24 * 3_600_000;
const DISPLAY_PADDING_MS = 30_000;

type Evidence = LocalSessionSystemEvidence;
type Binding = Evidence['binding'];

type Generation = {
  row: UosInteractionRow;
  process: ProcessContext;
  pid: number;
  startTimeTicks: string;
  matchedOsProcessInstanceKey: string;
};

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function startTicks(value: unknown): string | undefined {
  return typeof value === 'string' && /^[1-9][0-9]*$/u.test(value.trim())
    ? value.trim()
    : undefined;
}

function observedAt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function unixNsToMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  try {
    const milliseconds = BigInt(value) / 1_000_000n;
    return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(milliseconds)
      : undefined;
  } catch {
    return undefined;
  }
}

function processGeneration(row: UosInteractionRow): Generation | undefined {
  const process = row.process;
  const pid = positiveInteger(process?.pid);
  const startTimeTicks = startTicks(process?.startTimeTicks);
  if (!process || !pid || !startTimeTicks) return undefined;
  // The binding is derived only from /proc generation fields captured with the interaction.
  // It does not depend on cgroup IDs, kernel release numbers, process names, or wall-clock
  // proximity. The same exec/exit/connect kprobe facts exist on the x86_64 and ARM64 lanes.
  const canonical = canonicalProcessLifecycleIdentity(process);
  const matchedOsProcessInstanceKey = canonical?.processInstanceKey
    || process.processGenerationKey?.trim()
    || 'uos_generation:' + pid + ':' + startTimeTicks;
  return { row, process, pid, startTimeTicks, matchedOsProcessInstanceKey };
}

function generationKey(generation: Generation): string {
  const process = generation.process;
  return JSON.stringify([
    generation.pid,
    generation.startTimeTicks,
    process.hostId ?? '',
    process.bootId ?? '',
    process.pidNamespace ?? '',
    process.processGenerationKey ?? '',
  ]);
}

function sameGeneration(event: JudgedEvent, generation: Generation): boolean {
  const process = event.process;
  if (!process || process.pid !== generation.pid) return false;
  if (startTicks(process.startTimeTicks) !== generation.startTimeTicks) return false;
  for (const key of ['hostId', 'bootId', 'pidNamespace'] as const) {
    const expected = generation.process[key]?.trim();
    if (expected && process[key]?.trim() !== expected) return false;
  }
  const expectedKey = generation.process.processGenerationKey?.trim();
  const observedKey = process.processGenerationKey?.trim();
  return !expectedKey || !observedKey || expectedKey === observedKey;
}

function bindingFor(conversationId: string, nativeSessionId: string, generation: Generation): Binding {
  return {
    bindingId: 'uos_spb_' + digest([
      conversationId,
      generation.matchedOsProcessInstanceKey,
      generation.pid,
      generation.startTimeTicks,
    ]),
    bindingRevision: 1,
    nativeSessionId,
    matchedOsProcessInstanceKey: generation.matchedOsProcessInstanceKey,
    matchedPid: generation.pid,
    ...(generation.row.agentInstanceId ? { agentInstanceId: generation.row.agentInstanceId } : {}),
    method: 'observer_request',
    confidence: 1,
  };
}

function unboundBinding(conversationId: string, nativeSessionId: string): Binding {
  return {
    bindingId: 'uos_spb_' + digest([conversationId, nativeSessionId, 'unbound']),
    bindingRevision: 1,
    nativeSessionId,
    matchedOsProcessInstanceKey: '',
    matchedPid: 0,
    method: 'observer_request',
    confidence: 0,
  };
}

function emptyEvidence(
  conversationId: string,
  nativeSessionId: string,
  requestedLimit: number,
  binding?: Binding,
  evidenceScope?: Evidence['evidenceScope'],
): Evidence {
  return {
    schemaVersion: 'anysentry.local-session-system-evidence.v1',
    conversationId,
    ...(evidenceScope ? { evidenceScope } : {}),
    binding: binding ?? unboundBinding(conversationId, nativeSessionId),
    persistence: 'not_checked',
    completeness: 'unavailable',
    counts: { direct: 0, lineage: 0, ambiguous: 0, conflict: 0, unattributed: 0 },
    page: {
      requestedLimit,
      totalRelations: 0,
      loadedRelations: 0,
      returnedEvents: 0,
      unavailableEvents: 0,
      totalLineageEdges: 0,
      returnedLineageEdges: 0,
      hasMore: false,
    },
    lineage: [],
    events: [],
    exceptions: [],
    calculatedAt: Date.now(),
  };
}

function attributeText(event: JudgedEvent, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event.attributes[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      return String(value).trim();
    }
  }
  return undefined;
}

function egressTarget(event: JudgedEvent): string | undefined {
  const address = attributeText(event, [
    'destination', 'remoteAddress', 'remote', 'peer', 'dst', 'address', 'dstIp', 'remoteIp', 'ip',
  ]);
  if (!address) return undefined;
  const port = attributeText(event, ['dstPort', 'remotePort', 'port']);
  if (!port || /:\d+$/u.test(address) || address.endsWith(':' + port)) return address;
  return address.includes(':') ? '[' + address + ']:' + port : address + ':' + port;
}

export function uosSystemEvidenceSubject(event: JudgedEvent): string {
  const subject = event.subject.trim();
  if (event.eventKind !== 'Egress') return subject;
  const target = egressTarget(event);
  if (!target || subject.includes(target)) return subject;
  return (subject || 'egress') + ' → ' + target;
}

function commandFor(event: JudgedEvent): string | undefined {
  return attributeText(event, ['command', 'argv']);
}

function commandHashFor(event: JudgedEvent): string | undefined {
  const value = attributeText(event, ['anysentry.kernel.command_hash']);
  return value && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function lineageFor(events: readonly JudgedEvent[]): Evidence['lineage'] {
  const edges = new Map<string, Evidence['lineage'][number]>();
  for (const event of events) {
    const parentPid = positiveInteger(event.process?.ppid);
    const childPid = positiveInteger(event.process?.pid);
    const parentKey = event.attribution?.parentProcessGenerationKey?.trim();
    const childKey = event.processInstanceKey?.trim();
    // PPID alone cannot identify a reusable parent PID generation. Add an edge only when the
    // same event also carries the Forwarder-observed parent generation; never expand ancestry.
    if (
      !parentPid || !childPid || !parentKey || !childKey
      || event.attribution?.parentLinkAuthority !== 'forwarder_process_graph'
    ) continue;
    const key = JSON.stringify([parentKey, childKey]);
    const previous = edges.get(key);
    if (previous) {
      previous.validFrom = Math.min(previous.validFrom, event.at);
      continue;
    }
    edges.set(key, {
      edgeId: 'uos_ple_' + digest([parentKey, childKey, parentPid, childPid]),
      parentProcessInstanceKey: parentKey,
      childProcessInstanceKey: childKey,
      parentPid,
      childPid,
      validFrom: event.at,
    });
  }
  return [...edges.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

@Injectable()
export class UosSystemEvidenceService {
  constructor(private readonly clickhouse: ClickHouseStore) {}

  async evidence(conversationIdInput: string, eventLimit?: number): Promise<Evidence> {
    const conversationId = conversationIdInput.trim().slice(0, 160);
    const nativeSessionId = uosConversationAnchor(conversationId);
    const requestedLimit = Math.max(
      1,
      Math.min(MAX_EVENT_LIMIT, Math.trunc(eventLimit ?? DEFAULT_EVENT_LIMIT)),
    );
    if (
      !conversationId || !nativeSessionId || conversationIdInput.trim().length > 160
      || !conversationId.startsWith(UOS_CONVERSATION_PREFIX)
    ) {
      return emptyEvidence(conversationId, nativeSessionId, requestedLimit);
    }

    const now = Date.now();
    const rows = await this.clickhouse.queryAgentInteractionPayloads({
      startMs: Math.max(0, now - INTERACTION_LOOKUP_MS),
      endMs: now,
      sessionId: nativeSessionId,
      limit: MAX_INTERACTIONS,
    });
    // Empty sessions return before any events-table work. A storage failure has the same complete
    // unavailable shape as a genuinely empty result, so callers never mistake it for attribution.
    if (!rows?.length) return emptyEvidence(conversationId, nativeSessionId, requestedLimit);

    const interactions = rows.flatMap((stored) => {
      const row = parseUosPayload(stored.payload);
      if (!row || !isLlmShapedRow(row)) return [];
      const sessionId = row.sessionId || row.canonicalSessionId || stored.sessionId;
      if (sessionId !== nativeSessionId) return [];
      return [{
        ...row,
        at: observedAt(row.at) ?? observedAt(stored.at),
        agentInstanceId: row.agentInstanceId || stored.agentInstanceId,
      } satisfies UosInteractionRow];
    });
    if (interactions.length === 0) {
      return emptyEvidence(conversationId, nativeSessionId, requestedLimit);
    }
    const generations = interactions.map(processGeneration);
    if (generations.some((generation) => !generation)) {
      return emptyEvidence(conversationId, nativeSessionId, requestedLimit);
    }
    const exactGenerations = generations as Generation[];
    const uniqueGenerations = new Map(exactGenerations.map((generation) => [
      generationKey(generation), generation,
    ]));
    // LocalSessionSystemEvidence has one root binding. Never pick one of several generations by
    // recency/frequency; that would silently assign another generation's kernel events.
    if (uniqueGenerations.size !== 1) {
      return emptyEvidence(conversationId, nativeSessionId, requestedLimit);
    }
    const generation = exactGenerations[0];
    const binding = bindingFor(conversationId, nativeSessionId, generation);
    const observedTimes = exactGenerations.flatMap((item) => {
      const at = observedAt(item.row.at);
      return at ? [{ at, startedAt: unixNsToMs(item.row.startedAtUnixNs) }] : [];
    });
    if (observedTimes.length === 0) {
      return emptyEvidence(conversationId, nativeSessionId, requestedLimit, binding);
    }
    const firstObservedAt = Math.min(...observedTimes.map((item) => item.startedAt ?? item.at));
    const lastObservedAt = Math.max(...observedTimes.map((item) => item.at));
    // Wall-clock bounds only crop the display and make the read finite. They never select a
    // process: every returned event must first match the exact /proc generation above.
    const sinceMs = Math.max(0, firstObservedAt - DISPLAY_PADDING_MS);
    const displayUntilMs = Math.min(now + DISPLAY_PADDING_MS, lastObservedAt + DISPLAY_PADDING_MS);
    const processQuery = {
      processPid: generation.pid,
      processStartTimeTicks: generation.startTimeTicks,
      ...(generation.process.hostId ? { processHostId: generation.process.hostId } : {}),
      ...(generation.process.bootId ? { processBootId: generation.process.bootId } : {}),
      ...(generation.process.pidNamespace
        ? { processPidNamespace: generation.process.pidNamespace }
        : {}),
    };
    const [storedEvents, stats] = await Promise.all([
      this.clickhouse.searchEvents({
        ...processQuery,
        sinceMs,
        untilMs: displayUntilMs,
        limit: requestedLimit + 1,
      }),
      this.clickhouse.readUosProcessGenerationEventStats({
        ...processQuery,
        sinceMs,
        displayUntilMs,
        untilMs: Math.max(now, displayUntilMs),
      }),
    ]);
    if (storedEvents === null) {
      return emptyEvidence(conversationId, nativeSessionId, requestedLimit, binding);
    }
    const matchedCandidates = storedEvents.filter((event) => sameGeneration(event, generation));
    const matched = matchedCandidates.slice(0, requestedLimit);
    const exited = matched.some((event) => event.eventKind === 'ProcessExit')
      || stats?.exitedAt !== undefined;
    const evidenceScope = stats
      ? exited ? 'historical_reconstructed' as const : 'current_generation' as const
      : undefined;
    if (matched.length === 0) {
      return emptyEvidence(conversationId, nativeSessionId, requestedLimit, binding, evidenceScope);
    }

    const events = matched.map((event) => {
      const command = commandFor(event);
      const commandHash = commandHashFor(event);
      return {
        relationId: 'uos_esr_' + digest([
          conversationId, binding.bindingId, event.eventId, event.processInstanceKey ?? '',
        ]),
        relation: 'DIRECT' as const,
        confidence: 1,
        eventId: event.eventId,
        at: event.at,
        eventKind: event.eventKind,
        eventCategory: event.eventCategory,
        subject: uosSystemEvidenceSubject(event),
        processInstanceKey: event.processInstanceKey ?? '',
        ...(event.process?.pid ? { pid: event.process.pid } : {}),
        ...(event.process?.ppid ? { ppid: event.process.ppid } : {}),
        ...(command ? { command } : {}),
        ...(commandHash ? { commandHash } : {}),
        verdict: event.verdict,
        tier: event.tier,
        severity: event.severity,
        riskScore: Number.isFinite(event.riskScore) ? event.riskScore : 0,
        ...(event.decisionRevision !== undefined ? { decisionRevision: event.decisionRevision } : {}),
        ...(event.traceId ? { traceId: event.traceId } : {}),
        ...(event.spanId ? { spanId: event.spanId } : {}),
      };
    }).sort((left, right) => right.at - left.at || left.eventId.localeCompare(right.eventId));
    const lineage = lineageFor(matched);
    const filtered = matchedCandidates.length !== storedEvents.length;
    const interactionTruncated = rows.length >= MAX_INTERACTIONS;
    const hasMore = matchedCandidates.length > matched.length
      || Boolean(stats && stats.totalEvents > matched.length);
    // When the narrow stats read is unavailable, counts describe only this partial page rather
    // than inventing a total. With stats available they are exact for the display window.
    const totalRelations = stats && !filtered ? stats.totalEvents : matched.length;
    return {
      schemaVersion: 'anysentry.local-session-system-evidence.v1',
      conversationId,
      ...(evidenceScope ? { evidenceScope } : {}),
      binding,
      persistence: 'not_checked',
      completeness: stats && !filtered && !interactionTruncated && !hasMore
        ? 'complete_as_observed'
        : 'partial',
      counts: {
        direct: totalRelations,
        lineage: 0,
        ambiguous: 0,
        conflict: 0,
        unattributed: 0,
      },
      page: {
        requestedLimit,
        totalRelations,
        loadedRelations: matched.length,
        returnedEvents: events.length,
        unavailableEvents: 0,
        totalLineageEdges: lineage.length,
        returnedLineageEdges: lineage.length,
        hasMore,
      },
      lineage,
      events,
      exceptions: [],
      calculatedAt: Date.now(),
    };
  }
}
