import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseTrustedCorrelation } from './trusted-correlation';
import type { JudgedEvent, ProcessContext } from './types';

export const TOOL_EVIDENCE_SCHEMA_VERSION = 'anysentry.tool_evidence.v1' as const;
export const TOOL_EVIDENCE_RELATION_VERSION = 2 as const;

export type ToolEvidenceLinkMethod =
  | 'same_process_resource'
  | 'direct_child_command';

export type ToolEvidenceStatus =
  | 'linked'
  | 'semantic_only'
  | 'ambiguous';

export type ToolEvidenceReason =
  | 'exact_process_and_resource'
  | 'exact_child_and_command'
  | 'overlapping_exact_claims'
  | 'kernel_read_not_captured'
  | 'no_matching_kernel_evidence';

export interface KernelEvidenceReference {
  eventId: string;
  eventKind: string;
  at: number;
  linkMethod: ToolEvidenceLinkMethod;
  confidence: number;
}

export interface ToolEvidenceItem {
  invocationId: string;
  toolCallId: string;
  toolName: string;
  spanId?: string;
  startedAt?: number;
  endedAt?: number;
  status: ToolEvidenceStatus;
  reason: ToolEvidenceReason;
  adapterEventIds: string[];
  kernelEvidence: KernelEvidenceReference[];
  ambiguousKernelEventIds?: string[];
  relation?: {
    schemaVersion: 'anysentry.tool_evidence_relation.v1';
    relationVersion: typeof TOOL_EVIDENCE_RELATION_VERSION;
    evidenceVersion: string;
    updatedAt: number;
  };
}

export interface ToolEvidenceBundle {
  schemaVersion: typeof TOOL_EVIDENCE_SCHEMA_VERSION;
  items: ToolEvidenceItem[];
  ignoredUntrustedAdapterEvents: number;
  truncated: boolean;
}

export interface ToolEvidenceResponse extends ToolEvidenceBundle {
  invocationId: string;
  toolCallId?: string;
  dataSource: 'clickhouse_relation' | 'clickhouse+hot_delta' | 'memory_hot_ring';
  partial: boolean;
  partialReasons?: Array<'trusted_correlation_off' | 'storage_unavailable' | 'scan_limit' | 'process_scope_limit'>;
  updateTime: string;
}

interface StrongProcessTuple {
  hostId?: string;
  bootId: string;
  pid: number;
  start: string;
  pidNamespace?: string;
  namespacePid?: number;
  namespacePpid?: number;
}

interface ToolClaim {
  key: string;
  invocationId: string;
  toolCallId: string;
  toolName: string;
  spanId?: string;
  startedAt?: number;
  endedAt?: number;
  process?: StrongProcessTuple;
  resourceHash?: string;
  commandHash?: string;
  adapterEventIds: string[];
}

interface EvidenceCandidate {
  event: JudgedEvent;
  process?: StrongProcessTuple;
  resourceHash?: string;
  commandHash?: string;
  fileAccessMode?: string;
}

const MAX_TOOL_CLAIMS = 1_000;
const MAX_KERNEL_EVIDENCE = 10_000;
const MAX_LINKS_PER_TOOL = 256;
const LINK_CLOCK_SKEW_MS = 2_000;
const OPEN_TOOL_WINDOW_MS = 30 * 60_000;

function text(value: unknown, limit = 1_024): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= limit ? normalized : undefined;
}

function attrText(event: JudgedEvent, key: string, limit = 1_024): string | undefined {
  return text(event.attributes[key], limit);
}

function attrNumber(event: JudgedEvent, key: string): number | undefined {
  const value = event.attributes[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function processTuple(process: ProcessContext | undefined): StrongProcessTuple | undefined {
  const hostId = text(process?.hostId, 512);
  const bootId = text(process?.bootId, 512);
  const pid = process?.pid;
  const startTicks = text(process?.startTimeTicks, 512);
  const startNs = text(process?.startTimeNs, 512);
  const start = startTicks ? `ticks:${startTicks}` : startNs ? `ns:${startNs}` : undefined;
  const pidNamespace = text(process?.pidNamespace, 512);
  const namespacePid = process?.namespacePid;
  const namespacePpid = process?.namespacePpid;
  const hostStrong = Boolean(hostId && Number.isSafeInteger(pid) && Number(pid) > 0);
  const namespaceStrong = Boolean(
    pidNamespace && Number.isSafeInteger(namespacePid) && Number(namespacePid) > 0,
  );
  if (!bootId || !Number.isSafeInteger(pid) || Number(pid) <= 0 || !start || (!hostStrong && !namespaceStrong)) {
    return undefined;
  }
  return {
    hostId,
    bootId,
    pid: Number(pid),
    start,
    pidNamespace,
    ...(Number.isSafeInteger(namespacePid) && Number(namespacePid) > 0
      ? { namespacePid: Number(namespacePid) }
      : {}),
    ...(Number.isSafeInteger(namespacePpid) && Number(namespacePpid) > 0
      ? { namespacePpid: Number(namespacePpid) }
      : {}),
  };
}

function sameProcess(left: StrongProcessTuple | undefined, right: StrongProcessTuple | undefined): boolean {
  if (!left || !right || left.bootId !== right.bootId || left.start !== right.start) return false;
  const sameHostProcess = Boolean(
    left.hostId && right.hostId && left.hostId === right.hostId && left.pid === right.pid,
  );
  if (sameHostProcess) return true;
  return Boolean(
    left.pidNamespace &&
    right.pidNamespace &&
    left.pidNamespace === right.pidNamespace &&
    left.namespacePid &&
    left.namespacePid === right.namespacePid,
  );
}

function eventPath(event: JudgedEvent): string | undefined {
  const raw = attrText(event, 'path', 4_096) ?? text(event.actionTarget, 4_096);
  if (!raw) return undefined;
  const absolute = raw.startsWith('/')
    ? raw
    : event.process?.cwd
      ? path.posix.resolve(event.process.cwd, raw)
      : undefined;
  return absolute ? path.posix.normalize(absolute) : undefined;
}

function argvFromPreview(event: JudgedEvent): string[] | undefined {
  const preview = text(event.rawPreview, 8_192);
  if (!preview?.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(preview) as { event?: { ToolExec?: { argv?: unknown } } };
    const argv = parsed.event?.ToolExec?.argv;
    return Array.isArray(argv) && argv.length <= 256 && argv.every((item) => typeof item === 'string')
      ? argv as string[]
      : undefined;
  } catch {
    return undefined;
  }
}

function shellCommand(event: JudgedEvent): string | undefined {
  const argv = argvFromPreview(event);
  if (argv) {
    const shellFlag = argv.findIndex((part) => part === '-c' || part === '-lc');
    if (shellFlag >= 0) return text(argv[shellFlag + 1], 16_384);
  }
  return undefined;
}

function kernelCommandHash(event: JudgedEvent): string | undefined {
  const attested = attrText(event, 'anysentry.kernel.command_hash', 64);
  if (attested && /^[a-f0-9]{64}$/u.test(attested)) return attested;
  const command = shellCommand(event);
  return command ? sha256(command) : undefined;
}

/** Narrow, server-derived lookup fields persisted beside the wide event row. */
export function toolEvidenceIndexFields(event: JudgedEvent): {
  resourceHash?: string;
  commandHash?: string;
} {
  if (event.eventKind === 'AgentTool') {
    return {
      resourceHash: attrText(event, 'anysentry.tool.resource_hash', 128),
      commandHash: attrText(event, 'anysentry.tool.command_hash', 128),
    };
  }
  if (event.eventKind === 'FileAccess' || event.eventKind === 'FileDelete') {
    const resource = eventPath(event);
    return { resourceHash: resource ? sha256(resource) : undefined };
  }
  if (event.eventKind === 'ToolExec') {
    return { commandHash: kernelCommandHash(event) };
  }
  return {};
}

function isTrustedAdapterEvent(event: JudgedEvent): boolean {
  const correlation = parseTrustedCorrelation(event.attribution?.correlation);
  return correlation?.method === 'agent_adapter' &&
    correlation.authority === 'authenticated_agent_adapter' &&
    correlation.inferred === false &&
    Boolean(correlation.invocationId && correlation.toolCallId);
}

function isTrustedKernelEvidence(event: JudgedEvent): boolean {
  if (!['FileAccess', 'FileDelete', 'ToolExec'].includes(event.eventKind)) return false;
  const correlation = parseTrustedCorrelation(event.attribution?.correlation);
  return Boolean(
    correlation &&
    !correlation.inferred &&
    (correlation.authority === 'attested_observer' || correlation.authority === 'server_process_graph'),
  );
}

function lifecyclePhase(event: JudgedEvent): 'start' | 'end' | undefined {
  const phase = attrText(event, 'anysentry.lifecycle.phase', 16);
  return phase === 'start' || phase === 'end' ? phase : undefined;
}

function toolKey(event: JudgedEvent, invocationId: string, toolCallId: string): string {
  const tenant = attrText(event, 'tenantId', 240) ?? attrText(event, 'tenant.id', 240) ?? '';
  const environment = attrText(event, 'environmentId', 240) ?? attrText(event, 'deployment.environment.name', 240) ?? '';
  const source = event.sourceId ?? attrText(event, 'sourceId', 240) ?? '';
  return [tenant, environment, event.workspacePath, source, event.agentId, invocationId, toolCallId].join('\0');
}

function withinToolWindow(claim: ToolClaim, at: number): boolean {
  const lower = (claim.startedAt ?? claim.endedAt ?? at) - LINK_CLOCK_SKEW_MS;
  const upper = (claim.endedAt ?? ((claim.startedAt ?? at) + OPEN_TOOL_WINDOW_MS)) + LINK_CLOCK_SKEW_MS;
  return at >= lower && at <= upper;
}

function directChildOfAdapter(claim: ToolClaim, event: JudgedEvent): boolean {
  if (!claim.process || !event.process) return false;
  const rootPid = event.attribution?.rootPid;
  const rootStart = text(event.attribution?.rootStartTime, 512);
  const generationMatches = Boolean(
    rootStart && (
      rootStart === claim.process.start ||
      `ticks:${rootStart}` === claim.process.start ||
      `ns:${rootStart}` === claim.process.start
    ),
  );
  if (event.process.bootId !== claim.process.bootId || !generationMatches) return false;
  const hostDirectChild = Boolean(
    event.process.hostId &&
    claim.process.hostId &&
    event.process.hostId === claim.process.hostId &&
    event.process.ppid === claim.process.pid &&
    rootPid === claim.process.pid,
  );
  if (hostDirectChild) return true;
  return Boolean(
    Number.isSafeInteger(rootPid) &&
    Number(rootPid) > 0 &&
    event.process.ppid === rootPid &&
    event.process.pidNamespace &&
    claim.process.pidNamespace &&
    event.process.pidNamespace === claim.process.pidNamespace &&
    claim.process.namespacePid &&
    event.process.namespacePpid === claim.process.namespacePid,
  );
}

function resourceOperationCompatible(claim: ToolClaim, candidate: EvidenceCandidate): boolean {
  const tool = claim.toolName.toLowerCase().replace(/[\s-]+/gu, '_');
  const isRead = tool === 'read' || tool === 'read_file' || tool.startsWith('read_');
  const isWrite = ['write', 'write_file', 'edit', 'apply_patch', 'create_file'].includes(tool)
    || tool.startsWith('write_');
  const isDelete = ['delete', 'delete_file', 'remove', 'remove_file', 'unlink'].includes(tool);
  if (candidate.event.eventKind === 'FileDelete') return isDelete || (!isRead && !isWrite);
  if (candidate.event.eventKind !== 'FileAccess') return true;
  if (isDelete) return false;
  if (!isRead && !isWrite) return true;
  const mode = candidate.fileAccessMode;
  if (isRead) return mode === 'read_only' || (mode === undefined && candidate.event.attributes.write === false);
  return mode === 'write_only' || mode === 'read_write'
    || (mode === undefined && candidate.event.attributes.write === true);
}

function matchMethod(claim: ToolClaim, candidate: EvidenceCandidate): ToolEvidenceLinkMethod | undefined {
  if (!withinToolWindow(claim, candidate.event.at)) return undefined;
  if (
    claim.resourceHash &&
    candidate.resourceHash === claim.resourceHash &&
    resourceOperationCompatible(claim, candidate) &&
    sameProcess(claim.process, candidate.process)
  ) return 'same_process_resource';
  if (
    claim.commandHash &&
    candidate.commandHash === claim.commandHash &&
    directChildOfAdapter(claim, candidate.event)
  ) return 'direct_child_command';
  return undefined;
}

function buildToolClaims(events: JudgedEvent[]): { claims: ToolClaim[]; ignored: number; truncated: boolean } {
  const byKey = new Map<string, ToolClaim>();
  let ignored = 0;
  let truncated = false;
  for (const event of events) {
    if (event.eventKind !== 'AgentTool') continue;
    if (!isTrustedAdapterEvent(event)) {
      ignored += 1;
      continue;
    }
    const correlation = parseTrustedCorrelation(event.attribution?.correlation)!;
    const invocationId = correlation.invocationId!;
    const toolCallId = correlation.toolCallId!;
    const key = toolKey(event, invocationId, toolCallId);
    let claim = byKey.get(key);
    if (!claim) {
      if (byKey.size >= MAX_TOOL_CLAIMS) {
        truncated = true;
        continue;
      }
      claim = {
        key,
        invocationId,
        toolCallId,
        toolName: attrText(event, 'gen_ai.tool.name', 120) ?? 'unknown',
        spanId: event.spanId,
        process: processTuple(event.process),
        resourceHash: attrText(event, 'anysentry.tool.resource_hash', 128),
        commandHash: attrText(event, 'anysentry.tool.command_hash', 128),
        adapterEventIds: [],
      };
      byKey.set(key, claim);
    }
    claim.adapterEventIds.push(event.eventId);
    claim.process ??= processTuple(event.process);
    claim.resourceHash ??= attrText(event, 'anysentry.tool.resource_hash', 128);
    claim.commandHash ??= attrText(event, 'anysentry.tool.command_hash', 128);
    const phase = lifecyclePhase(event);
    if (phase === 'start') claim.startedAt = Math.min(claim.startedAt ?? event.at, event.at);
    if (phase === 'end') claim.endedAt = Math.max(claim.endedAt ?? event.at, event.at);
    if (!phase) {
      // A native OTLP Span is one completed record rather than Pi's start/end pair. Its normalized
      // bounds keep matching exact; malformed or absent bounds collapse to the event timestamp.
      const spanStart = attrNumber(event, 'anysentry.span.start_at_ms') ?? event.at;
      const spanEndCandidate = attrNumber(event, 'anysentry.span.end_at_ms') ?? event.at;
      const spanEnd = spanEndCandidate >= spanStart ? spanEndCandidate : spanStart;
      claim.startedAt = Math.min(claim.startedAt ?? spanStart, spanStart);
      claim.endedAt = Math.max(claim.endedAt ?? spanEnd, spanEnd);
    }
  }
  return { claims: [...byKey.values()], ignored, truncated };
}

function buildKernelCandidates(events: JudgedEvent[]): { candidates: EvidenceCandidate[]; truncated: boolean } {
  const candidates: EvidenceCandidate[] = [];
  let truncated = false;
  for (const event of events) {
    if (!isTrustedKernelEvidence(event)) continue;
    if (candidates.length >= MAX_KERNEL_EVIDENCE) {
      truncated = true;
      continue;
    }
    const resource = event.eventKind === 'FileAccess' || event.eventKind === 'FileDelete'
      ? eventPath(event)
      : undefined;
    candidates.push({
      event,
      process: processTuple(event.process),
      resourceHash: resource ? sha256(resource) : undefined,
      commandHash: event.eventKind === 'ToolExec' ? kernelCommandHash(event) : undefined,
      fileAccessMode: event.eventKind === 'FileAccess'
        ? attrText(event, 'accessMode', 32)
        : undefined,
    });
  }
  return { candidates, truncated };
}

/**
 * Links authenticated Agent Tool spans to attested kernel facts.
 *
 * Time is only a bounded search condition. A link additionally requires either the exact
 * process-instance+resource pair or an exact direct-child+command pair. If one kernel event makes
 * the same exact claim for overlapping ToolCalls, it is deliberately left unassigned.
 */
export function buildToolEvidenceBundle(events: JudgedEvent[]): ToolEvidenceBundle {
  const toolResult = buildToolClaims(events);
  const kernelResult = buildKernelCandidates(events);
  const owners = new Map<string, Array<{ claim: ToolClaim; method: ToolEvidenceLinkMethod }>>();

  for (const candidate of kernelResult.candidates) {
    for (const claim of toolResult.claims) {
      const method = matchMethod(claim, candidate);
      if (!method) continue;
      const matched = owners.get(candidate.event.eventId) ?? [];
      matched.push({ claim, method });
      owners.set(candidate.event.eventId, matched);
    }
  }

  const linked = new Map<string, KernelEvidenceReference[]>();
  const ambiguous = new Map<string, string[]>();
  for (const candidate of kernelResult.candidates) {
    const matched = owners.get(candidate.event.eventId) ?? [];
    if (matched.length === 1) {
      const owner = matched[0];
      const refs = linked.get(owner.claim.key) ?? [];
      if (refs.length < MAX_LINKS_PER_TOOL) {
        refs.push({
          eventId: candidate.event.eventId,
          eventKind: candidate.event.eventKind,
          at: candidate.event.at,
          linkMethod: owner.method,
          confidence: owner.method === 'same_process_resource' ? 1 : 0.98,
        });
        linked.set(owner.claim.key, refs);
      }
      continue;
    }
    if (matched.length > 1) {
      for (const owner of matched) {
        const ids = ambiguous.get(owner.claim.key) ?? [];
        if (ids.length < MAX_LINKS_PER_TOOL) ids.push(candidate.event.eventId);
        ambiguous.set(owner.claim.key, ids);
      }
    }
  }

  const items = toolResult.claims.map((claim): ToolEvidenceItem => {
    const kernelEvidence = (linked.get(claim.key) ?? []).sort((left, right) => left.at - right.at);
    const ambiguousKernelEventIds = [...new Set(ambiguous.get(claim.key) ?? [])];
    const status: ToolEvidenceStatus = kernelEvidence.length
      ? 'linked'
      : ambiguousKernelEventIds.length
        ? 'ambiguous'
        : 'semantic_only';
    const reason: ToolEvidenceReason = kernelEvidence.some((item) => item.linkMethod === 'same_process_resource')
      ? 'exact_process_and_resource'
      : kernelEvidence.some((item) => item.linkMethod === 'direct_child_command')
        ? 'exact_child_and_command'
        : ambiguousKernelEventIds.length
          ? 'overlapping_exact_claims'
          : claim.toolName.toLowerCase() === 'read'
            ? 'kernel_read_not_captured'
            : 'no_matching_kernel_evidence';
    return {
      invocationId: claim.invocationId,
      toolCallId: claim.toolCallId,
      toolName: claim.toolName,
      spanId: claim.spanId,
      startedAt: claim.startedAt,
      endedAt: claim.endedAt,
      status,
      reason,
      adapterEventIds: [...new Set(claim.adapterEventIds)],
      kernelEvidence,
      ...(ambiguousKernelEventIds.length ? { ambiguousKernelEventIds } : {}),
    };
  }).sort((left, right) => (left.startedAt ?? left.endedAt ?? 0) - (right.startedAt ?? right.endedAt ?? 0));

  return {
    schemaVersion: TOOL_EVIDENCE_SCHEMA_VERSION,
    items,
    ignoredUntrustedAdapterEvents: toolResult.ignored,
    truncated: toolResult.truncated || kernelResult.truncated,
  };
}
