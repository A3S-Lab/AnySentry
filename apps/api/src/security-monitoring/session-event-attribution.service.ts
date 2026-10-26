import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClickHouseStore } from './clickhouse-store';
import type { LocalSessionSystemEvidence } from './local-record-tracking.types';
import { SentryJudgeService } from './sentry-judge.service';
import { systemToolCallBinding } from './system-tool-call-binding';
import { observedCommandHash } from './local-tool-evidence';
import {
  canonicalProcessGenerationIdentity,
  canonicalProcessLifecycleIdentity,
  type ProcessLifecycleFact,
} from './process-lifecycle';
import { RelationalBusinessStore } from './relational-business-store.service';
import {
  eventSessionRelationId,
  eventSessionResultId,
  processLineageEdgeId,
  scopedConversationId,
  SESSION_EVENT_ATTRIBUTION_ALGORITHM,
  SESSION_EVENT_ATTRIBUTION_VERSION,
  sessionProcessBindingId,
  type EventSessionAttributionResult,
  type EventSessionRelation,
  type ProcessLineageEdge,
  type SessionProcessBinding,
  type SessionProcessBindingCandidate,
} from './session-event-attribution.types';

const MAX_SESSION_FACTS = 5_000;

// FileDelete is recorded without a judge-generated subject. Preserve its actual kernel path
// in the Session projection, including old events whose persisted subject is just "FileDelete".
// This changes presentation only: event identities, relations and stored facts stay intact.
export function systemEvidenceSubject(event: {
  eventKind: string;
  subject: string;
  attributes?: Record<string, unknown>;
}): string {
  const path = event.attributes?.path;
  return event.eventKind === 'FileDelete' && typeof path === 'string' && path.length > 0
    ? `delete ${path}`
    : event.subject;
}

// Claude Code runs the recorded command via `bash -c` and does not keep the session
// jsonl open. The kernel hashes the -c script, while the stored subject is capped at
// 80 characters, so the full session command never equals that subject.
function shellInvocationScript(command: string): string | undefined {
  const trimmed = command.trim();
  const single = trimmed.match(/(?:^|\s)-c\s+'([\s\S]*)'\s*$/u)
    ?? trimmed.match(/(?:^|\s)-lc\s+'([\s\S]*)'\s*$/u);
  if (single?.[1]) return single[1];
  const double = trimmed.match(/(?:^|\s)-c\s+"([\s\S]*)"\s*$/u)
    ?? trimmed.match(/(?:^|\s)-lc\s+"([\s\S]*)"\s*$/u);
  return double?.[1]?.replace(/\\(["\\])/gu, '$1');
}

/**
 * kimi-code executes tool commands as `/bin/bash -c 'cd "<workdir>" && <command>'` while the
 * Wire journal keeps the raw command. Reduce both views to the bare command for comparison.
 */
function canonicalKimiToolCommand(command: string): string {
  let script = command.trim();
  const inner = shellInvocationScript(script);
  if (inner) script = inner.trim();
  for (;;) {
    const cdPrefix = script.match(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/u);
    if (!cdPrefix) return script;
    script = script.slice(cdPrefix[0].length).trim();
  }
}
function bindingContextHash(bindings: readonly SessionProcessBinding[]): string {
  return createHash('sha256').update(JSON.stringify([...bindings]
    .sort((a, b) => a.bindingId.localeCompare(b.bindingId))
    .map(({ observedAt, confidence, ...binding }) => binding))).digest('hex');
}
const DEFAULT_SESSION_EVENT_LIMIT = 250;
const MAX_SESSION_EVENT_LIMIT = 5_000;
const INTERACTIVE_LEGACY_COVERAGE_HORIZON_MS = 72 * 60 * 60 * 1_000;
// Interactive System Evidence must stay under the browser/detail deadline while Observer ingest
// is also using ClickHouse. Prefer a small structural budget; the background reconciler still
// walks up to MAX_SESSION_FACTS.
const INTERACTIVE_FAMILY_FACT_FLOOR = 128;
const INTERACTIVE_FAMILY_MAX_DEPTH = 6;
// Evidence is requested more than once while the detail page changes tabs, polls, or retries a
// slow request. Keep a short-lived process-local result so those reads share one ClickHouse walk
// without making the UI stale for a meaningful amount of time. The active-session caller still
// gets a fresh window as soon as its `until` bound advances.
const SESSION_EVIDENCE_CACHE_TTL_MS = 15_000;
const MAX_SESSION_EVIDENCE_CACHE_ENTRIES = 128;

interface SessionEvidenceCacheEntry {
  expiresAt: number;
  value: LocalSessionSystemEvidence;
}

type SessionEvidenceOptions = {
  coveragePartial?: boolean;
  /** Skip relational persistence for an interactive read; the background reconciler owns writes. */
  persist?: boolean;
};

interface AttributableProcessEvent {
  eventId: string;
  eventKind?: string;
  at: number;
  processInstanceKey: string;
  /** Process identity copied from an observed event. Lifecycle facts already expose these fields. */
  processPid?: number;
  processPpid?: number;
  processStartTime?: string;
  runtimeInstanceId?: string;
  runtimeRootPid?: number;
  runtimeRootStartTime?: string;
}

function sameHostBootScope(
  left: Pick<ProcessLifecycleFact, 'hostId' | 'bootId' | 'pidNamespace'>,
  right: Pick<ProcessLifecycleFact, 'hostId' | 'bootId' | 'pidNamespace'>,
): boolean {
  return left.bootId === right.bootId
    && (left.hostId ?? '') === (right.hostId ?? '');
}

// bash -c execs its last external command in place. The PID and start time stay
// the same, but a later event can omit namespace metadata and hash to a new
// process key. That successor is still the same OS process, not a sibling of
// the original image.
function sameOsProcessGeneration(
  left: Pick<ProcessLifecycleFact, 'hostId' | 'bootId' | 'pid' | 'startTime' | 'pidNamespace'>,
  right: Pick<ProcessLifecycleFact, 'hostId' | 'bootId' | 'pid' | 'startTime' | 'pidNamespace'>,
): boolean {
  const leftNamespace = left.pidNamespace ?? '';
  const rightNamespace = right.pidNamespace ?? '';
  return sameHostBootScope(left, right)
    && left.pid === right.pid
    && Boolean(left.startTime)
    && left.startTime === right.startTime
    && (!leftNamespace || !rightNamespace || leftNamespace === rightNamespace);
}

function bindingContains(binding: SessionProcessBinding, at: number): boolean {
  return at >= binding.validFrom && (binding.validTo === undefined || at <= binding.validTo);
}

// Start ticks are boot-scoped, not wall-clock event timestamps. Unknown or mixed
// units cannot prove a parent generation; equal ticks are valid for fast forks.
function parentGenerationPrecedes(parent: string | undefined, child: string | undefined): boolean {
  const left = /^(ticks|ns):([0-9]+)$/u.exec(parent ?? '');
  const right = /^(ticks|ns):([0-9]+)$/u.exec(child ?? '');
  return Boolean(left && right && left[1] === right[1] && BigInt(left[2]) <= BigInt(right[2]));
}

function uniqueText(values: Array<string | undefined>): string | undefined {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return unique.length === 1 ? unique[0] : undefined;
}

function runtimeRootStartTime(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^(?:ticks|ns):[1-9][0-9]*$/u.test(normalized)) return normalized;
  return /^[1-9][0-9]*$/u.test(normalized) ? `ticks:${normalized}` : undefined;
}

function processGenerationRef(pid: number | undefined, startTime: string | undefined): string | undefined {
  return pid && startTime ? `${pid}:${startTime}` : undefined;
}

function nativeRuntimeFamily(runtimeType: string): string {
  const normalized = runtimeType.trim().toLocaleLowerCase();
  if (
    normalized === 'codex'
    || normalized === 'codex_app_server'
    || normalized === 'codex_ebpf_rustls'
  ) return 'codex';
  if (
    normalized === 'a3s_code'
    || normalized === 'a3s-code'
    || normalized === 'a3s code'
    || normalized === 'a3s_code_native_session'
    || normalized === 'a3s_code_ebpf_tls'
  ) return 'a3s_code';
  if (
    normalized === 'claude_code'
    || normalized === 'claude-code'
    || normalized === 'claude code'
    || normalized === 'claude_code_native_session'
    || normalized === 'claude_code_ebpf_tls'
  ) return 'claude_code';
  if (
    normalized === 'gemini'
    || normalized === 'gemini_cli'
    || normalized === 'gemini-cli'
    || normalized === 'gemini cli'
    || normalized === 'gemini_cli_native_session'
    || normalized === 'gemini_cli_ebpf_openssl'
  ) return 'gemini_cli';
  if (['kimi', 'kimi-cli', 'kimi code', 'kimi code cli', 'kimi_cli', 'kimi_cli_native_session', 'kimi_cli_ebpf_openssl'].includes(normalized)) return 'kimi_cli';
  return normalized;
}

const KNOWN_RUNTIME_FAMILIES = new Set(['codex', 'a3s_code', 'claude_code', 'gemini_cli', 'kimi_cli']);

/**
 * One Native Session can be projected by more than one observation lane. For example, the local
 * JSONL reader uses `codex / environment_default`, while the Rustls interaction lane uses
 * `codex_ebpf_rustls / infrastructure`. Their conversation ids are source-local aliases, not two
 * concurrently active user Sessions.
 *
 * Keep tenant, collector, host and runtime family in the key so an equal opaque Session id from a
 * different security scope is never folded into the current Session.
 */
function nativeSessionIdentity(binding: SessionProcessBinding): string {
  return JSON.stringify([
    binding.tenantId,
    binding.collectorId,
    binding.hostId,
    nativeRuntimeFamily(binding.runtimeType),
    binding.nativeSessionId,
  ]);
}

function sameBindingSemantics(
  left: SessionProcessBinding,
  right: SessionProcessBinding,
): boolean {
  return [
    'tenantId',
    'environmentId',
    'collectorId',
    'hostId',
    'runtimeType',
    'nativeSessionId',
    'conversationId',
    'runtimeProcessInstanceId',
    'matchedOsProcessInstanceKey',
    'matchedPid',
    'matchedStartTime',
    'launcherProcessInstanceKey',
    'launcherPid',
    'launcherStartTime',
    'agentRootProcessInstanceKey',
    'agentInstanceId',
    'bootId',
    'pidNamespace',
    'validFrom',
    'validTo',
    'method',
    'confidence',
  ].every((key) =>
    left[key as keyof SessionProcessBinding] === right[key as keyof SessionProcessBinding]);
}

@Injectable()
export class SessionEventAttributionService {
  private readonly evidenceCache = new Map<string, SessionEvidenceCacheEntry>();
  private readonly evidenceInFlight = new Map<string, Promise<LocalSessionSystemEvidence>>();

  constructor(
    private readonly clickhouse: ClickHouseStore,
    private readonly relational: RelationalBusinessStore,
    // SentryJudge owns the process-local hot ring populated by the live Observer ingest path.
    // Reusing it here avoids a second ClickHouse materialization for events that just arrived;
    // historical IDs still fall through to the durable store.  The optional dependency keeps the
    // attribution verifier and degraded/library usages constructible without a Nest container.
    @Optional() private readonly judge?: SentryJudgeService,
  ) {}

  async resolveBindingFromSessionFile(input: {
    tenantId?: string;
    environmentId?: string;
    collectorId?: string;
    runtimeType: string;
    nativeSessionId: string;
    conversationId?: string;
    sessionPaths: readonly string[];
    /** Unique directory markers (e.g. `/session_<uuid>/`) matched as path substrings, for
     *  writers inside containers whose mount view differs from every host-side path. */
    pathMarkers?: readonly string[];
    validFrom: number;
    validTo?: number;
  }, window: { since: number; until: number }, options?: { persist?: boolean }): Promise<SessionProcessBinding | undefined> {
    const events = await this.clickhouse.readSessionFileWriteEvents({
      paths: input.sessionPaths,
      ...(input.pathMarkers?.length ? { pathMarkers: input.pathMarkers } : {}),
      sinceMs: window.since,
      untilMs: window.until,
      limit: 50,
    });
    if (!events?.length) return undefined;
    const expectedRuntime = nativeRuntimeFamily(input.runtimeType);
    const candidates = new Map<string, {
      event: typeof events[number];
      identity: NonNullable<ReturnType<typeof canonicalProcessLifecycleIdentity>>;
    }>();
    for (const event of events) {
      const identity = canonicalProcessLifecycleIdentity(event.process, event.attribution);
      if (!identity?.hostId) continue;
      const observedAgent = event.attribution?.agentScopeId
        ?? event.agentId;
      if (observedAgent) {
        const observedRuntime = nativeRuntimeFamily(observedAgent);
        // Infra scopes (container ids, collector names) are not runtime identities; only a
        // positively identified different agent family vetoes the candidate.
        if (KNOWN_RUNTIME_FAMILIES.has(observedRuntime) && observedRuntime !== expectedRuntime) continue;
      }
      candidates.set(identity.processInstanceKey, { event, identity });
    }
    // A path written by more than one process generation is not a safe automatic binding. The
    // caller retains it as UNATTRIBUTED instead of selecting the newest process heuristically.
    if (candidates.size !== 1) return undefined;
    const { event, identity } = [...candidates.values()][0];
    const hostId = identity.hostId;
    if (!hostId) return undefined;
    return this.resolveBinding({
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      collectorId: input.collectorId ?? event.collectorId ?? hostId,
      runtimeType: input.runtimeType,
      nativeSessionId: input.nativeSessionId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      matchedPid: identity.pid,
      matchedStartTime: identity.startTime,
      ...(event.attribution?.agentInstanceId
        ? { agentInstanceId: event.attribution.agentInstanceId }
        : {}),
      validFrom: input.validFrom,
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      method: 'ebpf_session_file',
      confidence: 0.98,
      observedIdentity: {
        processInstanceKey: identity.processInstanceKey,
        hostId,
        bootId: identity.bootId,
        ...(identity.pidNamespace ? { pidNamespace: identity.pidNamespace } : {}),
      },
    }, window, options);
  }

  /**
   * Recover a bounded historical binding when a Native Session did not leave a Session-file FD
   * observation. A command is an ownership anchor only when its exact subject selects one OS
   * process generation inside the Native Tool Call's execution window. Repeated/concurrent
   * commands remain unattributed instead of being resolved by workspace or temporal proximity.
   */
  async resolveBindingsFromExactToolExec(input: {
    tenantId?: string;
    environmentId?: string;
    collectorId?: string;
    runtimeType: string;
    nativeSessionId: string;
    conversationId?: string;
    workspacePath?: string;
    validFrom: number;
    validTo: number;
    anchors: readonly { command: string; since: number; until: number }[];
  }, options?: { persist?: boolean }): Promise<SessionProcessBinding[]> {
    const bindings = new Map<string, SessionProcessBinding>();
    const anchors = input.anchors
      .filter((anchor) => {
        const command = anchor.command.trim();
        return command.length > 0
          && command.length <= 8_192
          && Number.isSafeInteger(anchor.since)
          && Number.isSafeInteger(anchor.until)
          && anchor.since <= anchor.until;
      })
      .slice(-8);
    for (const anchor of anchors) {
      const command = input.runtimeType === 'opencode' ? anchor.command : anchor.command.trim();
      const shellScript = input.runtimeType === 'claude_code' ? shellInvocationScript(command) : undefined;
      const kimiCommand = input.runtimeType === 'kimi_cli' ? canonicalKimiToolCommand(command) : undefined;
      const commandHash = createHash('sha256').update(shellScript ?? command).digest('hex');
      const since = Math.max(input.validFrom, anchor.since);
      const until = Math.min(input.validTo, anchor.until);
      if (since > until) continue;
      const events = await this.clickhouse.searchEvents({
        sinceMs: since,
        untilMs: until,
        eventKind: 'ToolExec',
        ...(input.runtimeType === 'opencode' || shellScript
          ? { evidenceCommandHashes: [commandHash] }
          // kimi-code wraps commands in `cd <cwd> && …`; the kernel subject can never equal the
          // raw Wire command, so the normalized comparison below does the selection instead.
          : kimiCommand
            ? {}
            : { exactSubject: command }),
        candidateLimit: 32,
        limit: 16,
      });
      if (!events?.length) continue;
      const candidates = new Map<string, {
        event: typeof events[number];
        identity: NonNullable<ReturnType<typeof canonicalProcessLifecycleIdentity>>;
      }>();
      for (const event of events) {
        if (input.runtimeType === 'opencode') {
          // OpenCode's shared DB cannot prove Session ownership. Recover only a candidate
          // from a complete kernel command hash and an independently identified runtime.
          if (observedCommandHash(event.attributes ?? {}) !== commandHash
            || nativeRuntimeFamily(event.attribution?.agentScopeId ?? '') !== 'opencode') continue;
        } else if (shellScript) {
          // The child is bash/sh, not the Claude process. The complete -c script hash is the
          // ownership anchor; a capped subject or a shared workspace is not.
          if (observedCommandHash(event.attributes ?? {}) !== commandHash) continue;
        } else if (kimiCommand) {
          if (canonicalKimiToolCommand(event.subject) !== kimiCommand) continue;
        } else if (event.subject.trim() !== command) continue;
        if (input.workspacePath && event.workspacePath
          && event.workspacePath !== input.workspacePath) continue;
        const identity = canonicalProcessLifecycleIdentity(event.process, event.attribution);
        if (!identity?.hostId || !identity.pidNamespace) continue;
        candidates.set(identity.processInstanceKey, { event, identity });
      }
      if (candidates.size !== 1) continue;
      const { event, identity } = [...candidates.values()][0];
      const hostId = identity.hostId;
      if (!hostId) continue;
      const binding = await this.resolveBinding({
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        collectorId: input.collectorId ?? event.collectorId ?? hostId,
        runtimeType: input.runtimeType,
        nativeSessionId: input.nativeSessionId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        matchedPid: identity.pid,
        matchedStartTime: identity.startTime,
        validFrom: since,
        validTo: until,
        method: 'tool_exec_exact',
        confidence: 0.97,
        observedIdentity: {
          processInstanceKey: identity.processInstanceKey,
          hostId,
          bootId: identity.bootId,
          pidNamespace: identity.pidNamespace,
        },
      }, { since, until }, options);
      if (binding) bindings.set(binding.bindingId, binding);
    }
    return [...bindings.values()];
  }

  async resolveBinding(
    candidate: SessionProcessBindingCandidate,
    window: { since: number; until: number },
    options?: { persist?: boolean },
  ): Promise<SessionProcessBinding | undefined> {
    // Background reconciliation rediscovers the same Native Session through its still-open FD.
    // If that exact PID generation was already verified, reuse the durable binding identity and
    // spend ClickHouse work on its recent descendants. This is both stricter and faster than
    // reconstructing a long-lived root from an arbitrary two-minute child-event window.
    if (candidate.observedIdentity) {
      const existing = await this.relational.loadSessionProcessBindingForGeneration({
        nativeSessionId: candidate.nativeSessionId,
        runtimeType: candidate.runtimeType,
        matchedPid: candidate.matchedPid,
        matchedStartTime: candidate.matchedStartTime,
        method: candidate.method ?? 'proc_fd',
        hostId: candidate.observedIdentity.hostId,
        bootId: candidate.observedIdentity.bootId,
        pidNamespace: candidate.observedIdentity.pidNamespace,
        tenantId: candidate.tenantId,
        environmentId: candidate.environmentId,
        collectorId: candidate.collectorId,
      });
      if (existing
        && existing.hostId === candidate.observedIdentity.hostId
        && existing.bootId === candidate.observedIdentity.bootId
        && Boolean(existing.pidNamespace)
        && (!candidate.observedIdentity.pidNamespace
          || (existing.matchedOsProcessInstanceKey === candidate.observedIdentity.processInstanceKey
            && existing.pidNamespace === candidate.observedIdentity.pidNamespace))
        && existing.nativeSessionId === candidate.nativeSessionId
        && existing.matchedPid === candidate.matchedPid
        && existing.matchedStartTime === candidate.matchedStartTime
        && (!candidate.tenantId || existing.tenantId === candidate.tenantId)
        && (!candidate.environmentId || existing.environmentId === candidate.environmentId)
        && (!candidate.collectorId || existing.collectorId === candidate.collectorId)
        && (!candidate.agentInstanceId || existing.agentInstanceId === candidate.agentInstanceId)
        && (!candidate.conversationId || existing.conversationId === candidate.conversationId)
      ) {
        const { validTo: _previousValidTo, ...openExisting } = existing;
        const proposed: SessionProcessBinding = {
          ...openExisting,
          bindingRevision: existing.bindingRevision,
          validFrom: Math.min(existing.validFrom, candidate.validFrom),
          ...(candidate.validTo !== undefined ? { validTo: candidate.validTo } : {}),
          method: candidate.method ?? existing.method,
          confidence: candidate.confidence ?? existing.confidence,
          observedAt: Date.now(),
        };
        proposed.bindingRevision = sameBindingSemantics(existing, proposed)
          ? existing.bindingRevision
          : existing.bindingRevision + 1;
        return proposed;
      }
    }
    const facts = await this.clickhouse.readSessionProcessLifecycleCandidates(
      candidate.matchedPid,
      window.since,
      window.until,
      MAX_SESSION_FACTS,
      candidate.observedIdentity
        ? {
            hostId: candidate.observedIdentity.hostId,
            bootId: candidate.observedIdentity.bootId,
          }
        : undefined,
    );
    const exactFacts = (facts ?? []).filter((fact) =>
      fact.pid === candidate.matchedPid
      && fact.startTime === candidate.matchedStartTime,
    );
    const exactIdentities = new Map(
      exactFacts.map((fact) => [fact.processInstanceKey, fact]),
    );
    let fact: ProcessLifecycleFact | undefined;
    let derivedIdentity: ReturnType<typeof canonicalProcessGenerationIdentity>;
    if (candidate.observedIdentity) {
      const identity = candidate.observedIdentity;
      fact = identity.pidNamespace ? exactIdentities.get(identity.processInstanceKey) : undefined;
      if (!fact) {
        // Interaction metadata may be emitted before the forwarder has enriched pid/mount
        // namespace fields. Its host/boot/PID/start tuple is still exact, but hashing that partial
        // tuple produces a different process key from the namespace-complete lifecycle fact.
        // Reconcile only when that tuple selects one unambiguous lifecycle generation.
        const compatibleFacts = exactFacts.filter((item) =>
          item.bootId === identity.bootId
          && (item.hostId ?? '') === identity.hostId
          && Boolean(item.pidNamespace)
          && (!identity.pidNamespace || item.pidNamespace === identity.pidNamespace));
        const compatibleIdentities = new Map(
          compatibleFacts.map((item) => [item.processInstanceKey, item]),
        );
        if (compatibleIdentities.size === 1) {
          fact = [...compatibleIdentities.values()][0];
        }
      }
      if (!fact && !identity.pidNamespace) {
        // Container workloads can miss namespace enrichment on both the Session-file event and
        // the lifecycle projection. host+boot+pid+startTime is still generation-exact on one
        // machine; accept it only when it selects a single unambiguous lifecycle generation.
        const hostScopedIdentities = new Map(
          exactFacts
            .filter((item) =>
              item.bootId === identity.bootId
              && (item.hostId ?? '') === identity.hostId)
            .map((item) => [item.processInstanceKey, item]),
        );
        if (hostScopedIdentities.size === 1) {
          fact = [...hostScopedIdentities.values()][0];
        }
      }
      // A short window, storage timeout or competing namespaces is not evidence that the
      // namespace vanished. Never mint a second weak key from partial Interaction metadata.
      if (!fact && !identity.pidNamespace) return undefined;
      derivedIdentity = fact
        ? canonicalProcessGenerationIdentity({
            bootId: fact.bootId,
            ...(fact.hostId ? { hostId: fact.hostId } : {}),
            ...(fact.pidNamespace ? { pidNamespace: fact.pidNamespace } : {}),
            ...(fact.namespacePid ? { namespacePid: fact.namespacePid } : {}),
            pid: fact.pid,
            startTime: fact.startTime,
            suppliedProcessInstanceId: fact.processInstanceKey,
          })
        : canonicalProcessGenerationIdentity({
            bootId: identity.bootId,
            hostId: identity.hostId,
            ...(identity.pidNamespace ? { pidNamespace: identity.pidNamespace } : {}),
            pid: candidate.matchedPid,
            startTime: candidate.matchedStartTime,
            suppliedProcessInstanceId: identity.processInstanceKey,
          });
    } else if (exactIdentities.size === 1) {
      fact = [...exactIdentities.values()][0];
      derivedIdentity = canonicalProcessGenerationIdentity({
        bootId: fact.bootId,
        ...(fact.hostId ? { hostId: fact.hostId } : {}),
        ...(fact.pidNamespace ? { pidNamespace: fact.pidNamespace } : {}),
        ...(fact.namespacePid ? { namespacePid: fact.namespacePid } : {}),
        pid: fact.pid,
        startTime: fact.startTime,
        suppliedProcessInstanceId: fact.processInstanceKey,
      });
    } else if (exactIdentities.size === 0) {
      // The Agent root may never emit its own ToolExec/ProcessExit fact. A direct child's ppid,
      // namespacePpid and exact Session-FD start time are sufficient to reconstruct that parent
      // generation, but only when every observed child agrees on one host/boot/namespace scope.
      let directChildren = (facts ?? []).filter((item) =>
        item.ppid === candidate.matchedPid
        && parentGenerationPrecedes(candidate.matchedStartTime, item.startTime)
        && item.at >= candidate.validFrom
        && (candidate.validTo === undefined || item.at <= candidate.validTo),
      );
      // An explicitly identified Agent cannot borrow a different runtime's child facts.
      if (candidate.agentInstanceId) {
        directChildren = directChildren.filter((item) =>
          item.runtimeInstanceId === candidate.agentInstanceId,
        );
      }
      // A child with only PID/PPID/time evidence is not enough to reconstruct a missing
      // Session root: another concurrent Agent can create children under a reused launcher PID.
      // Require the Observer runtime identity as an additional ownership signal. This is the
      // same boundary used by the live interaction lane and prevents broad time-window joins.
      if (directChildren.some((child) => !child.runtimeInstanceId)) {
        directChildren = directChildren.filter((child) => Boolean(child.runtimeInstanceId));
      }
      const childRuntimeIds = new Set(
        directChildren.map((child) => child.runtimeInstanceId).filter(Boolean),
      );
      if (!candidate.agentInstanceId && childRuntimeIds.size > 1) {
        directChildren = [];
      }
      const scopeCounts = new Map<string, { count: number; fact: ProcessLifecycleFact }>();
      for (const child of directChildren) {
        if (!child.hostId) continue;
        const scopeKey = JSON.stringify([
          child.hostId,
          child.bootId,
          child.pidNamespace ?? '',
          child.namespacePpid ?? 0,
          child.runtimeInstanceId ?? '',
        ]);
        const current = scopeCounts.get(scopeKey);
        scopeCounts.set(scopeKey, {
          count: (current?.count ?? 0) + 1,
          fact: current?.fact ?? child,
        });
      }
      // Event volume cannot prove scope. A missing root with competing namespace/host
      // evidence stays unresolved rather than choosing the busiest candidate.
      const rankedScopes = [...scopeCounts.values()].sort((left, right) => right.count - left.count);
      const dominantScope = rankedScopes[0];
      const competingScope = rankedScopes[1];
      if (
        dominantScope
        && (
          !competingScope
        )
      ) {
        fact = dominantScope.fact;
        derivedIdentity = canonicalProcessGenerationIdentity({
          bootId: fact.bootId,
          hostId: fact.hostId,
          ...(fact.pidNamespace ? { pidNamespace: fact.pidNamespace } : {}),
          ...(fact.namespacePpid ? { namespacePid: fact.namespacePpid } : {}),
          pid: candidate.matchedPid,
          startTime: candidate.matchedStartTime,
        });
      }
    }
    const hostId = derivedIdentity?.hostId;
    const bootId = derivedIdentity?.bootId;
    const matchedOsProcessInstanceKey = derivedIdentity?.processInstanceKey;
    if (!hostId || !bootId || !matchedOsProcessInstanceKey) return undefined;
    const collectorId = candidate.collectorId ?? fact?.collectorId ?? hostId;
    const tenantId = candidate.tenantId ?? 'tenant_default';
    const environmentId = candidate.environmentId ?? 'environment_default';
    const pidNamespace = candidate.observedIdentity?.pidNamespace ?? fact?.pidNamespace;
    // A Native Session file is created only after Codex has already started the exact process
    // generation and performed bootstrap work. Prefer the first directly observed lifecycle fact
    // for that generation over an arbitrary fixed look-back. PID + start time + host/boot scope
    // make this adjustment generation-safe, including slower cold starts on another machine.
    const generationObservedFrom = exactFacts.reduce(
      (earliest, item) => Math.min(earliest, item.at),
      candidate.validFrom,
    );
    const conversationId = candidate.conversationId ?? scopedConversationId({
      tenantId,
      environmentId,
      collectorId,
      hostId,
      runtimeType: candidate.runtimeType,
      nativeSessionId: candidate.nativeSessionId,
    });
    const agentInstanceId = candidate.agentInstanceId
      ?? uniqueText(exactFacts.map((item) => item.runtimeInstanceId))
      ?? uniqueText((facts ?? [])
        .filter((item) =>
          item.ppid === candidate.matchedPid
          && item.bootId === bootId
          && (item.hostId ?? '') === hostId
          && (item.pidNamespace ?? '') === (derivedIdentity?.pidNamespace ?? ''))
        .map((item) => item.runtimeInstanceId));
    const rootFact = agentInstanceId
      ? (facts ?? []).find((item) =>
          item.runtimeInstanceId === agentInstanceId
          && item.rootProcess
          && item.bootId === bootId
          && (item.hostId ?? '') === hostId
          && (item.pidNamespace ?? '') === (pidNamespace ?? ''))
      : undefined;
    const launcherFact = candidate.launcherPid
      ? (facts ?? []).find((item) =>
          item.pid === candidate.launcherPid
          && (!candidate.launcherStartTime || item.startTime === candidate.launcherStartTime)
          && item.bootId === bootId
          && (item.hostId ?? '') === hostId
          && (item.pidNamespace ?? '') === (pidNamespace ?? ''))
      : undefined;
    const base = {
      tenantId,
      environmentId,
      collectorId,
      hostId,
      runtimeType: candidate.runtimeType,
      nativeSessionId: candidate.nativeSessionId,
      matchedOsProcessInstanceKey,
    };
    const proposed: SessionProcessBinding = {
      schemaVersion: 'anysentry.session_process_binding.v1',
      bindingId: sessionProcessBindingId(base),
      bindingRevision: 1,
      ...base,
      conversationId,
      ...(candidate.runtimeProcessInstanceId
        ? { runtimeProcessInstanceId: candidate.runtimeProcessInstanceId }
        : {}),
      matchedPid: candidate.matchedPid,
      matchedStartTime: candidate.matchedStartTime,
      ...(launcherFact ? {
        launcherProcessInstanceKey: launcherFact.processInstanceKey,
        launcherPid: launcherFact.pid,
        launcherStartTime: launcherFact.startTime,
      } : {}),
      ...(rootFact ? { agentRootProcessInstanceKey: rootFact.processInstanceKey } : {}),
      ...(agentInstanceId ? { agentInstanceId } : {}),
      bootId,
      ...(pidNamespace ? { pidNamespace } : {}),
      validFrom: generationObservedFrom,
      ...(candidate.validTo !== undefined ? { validTo: candidate.validTo } : {}),
      method: candidate.method ?? 'proc_fd',
      confidence: candidate.confidence
        ?? (candidate.observedIdentity ? 1 : 0.95),
      observedAt: Date.now(),
    };
    if (options?.persist !== false) {
      const current = await this.relational.loadLatestSessionProcessBinding(proposed.bindingId);
      if (current) {
        proposed.bindingRevision = sameBindingSemantics(current, proposed)
          ? current.bindingRevision
          : current.bindingRevision + 1;
      }
    }
    return proposed;
  }

  hasEvidenceInFlight(): boolean {
    return this.evidenceInFlight.size > 0;
  }

  /**
   * Return durable evidence for older process generations of a Native Session. This path is used
   * only when the interactive/current generation has no attributable event. It never performs a
   * lifecycle walk and therefore remains bounded even for a multi-day Session.
   */
  async historicalEvidenceForNativeSession(input: {
    nativeSessionId: string;
    runtimeType: string;
    since: number;
    until: number;
    eventLimit: number;
  }): Promise<LocalSessionSystemEvidence[] | null> {
    const bindings = await this.relational.loadSessionProcessBindingsForNativeSession({
      nativeSessionId: input.nativeSessionId,
      runtimeType: input.runtimeType,
      limit: 64,
    });
    if (bindings === null) return null;
    const evidence: LocalSessionSystemEvidence[] = [];
    let remaining = Math.max(
      1,
      Math.min(MAX_SESSION_EVENT_LIMIT, Math.trunc(input.eventLimit)),
    );
    for (const binding of bindings) {
      if (remaining <= 0) break;
      const value = await this.evidenceFromPersistedRelations(
        binding,
        { since: input.since, until: input.until },
        remaining,
        '',
        undefined,
        true,
      );
      if (!value) continue;
      evidence.push(value);
      remaining -= Math.max(1, value.page.loadedRelations);
    }
    return evidence;
  }

  /**
   * Load the newest persisted binding for a Native Session without creating anything. Used to
   * rehydrate process ownership across API restarts; the caller must revalidate the process
   * generation against a live /proc scan before trusting it.
   */
  async persistedBindingForNativeSession(
    nativeSessionId: string,
    runtimeType: string,
  ): Promise<SessionProcessBinding | undefined> {
    const bindings = await this.relational.loadSessionProcessBindingsForNativeSession({
      nativeSessionId,
      runtimeType,
      limit: 8,
    });
    return bindings?.[0];
  }

  async evidence(
    binding: SessionProcessBinding,
    window: { since: number; until: number },
    timeWindows?: readonly { sinceMs: number; untilMs: number }[],
    eventLimitInput = DEFAULT_SESSION_EVENT_LIMIT,
    options?: SessionEvidenceOptions,
  ): Promise<LocalSessionSystemEvidence> {
    const eventLimit = Math.max(
      1,
      Math.min(MAX_SESSION_EVENT_LIMIT, Math.trunc(eventLimitInput)),
    );
    const cacheKey = this.evidenceCacheKey(
      binding,
      window,
      timeWindows,
      eventLimit,
      options,
    );
    const now = Date.now();
    const cached = this.evidenceCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > now) return cached.value;
      this.evidenceCache.delete(cacheKey);
    }
    const inFlight = this.evidenceInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const work = this.computeEvidence(
      binding,
      window,
      timeWindows,
      eventLimit,
      options,
    );
    this.evidenceInFlight.set(cacheKey, work);
    try {
      const value = await work;
      this.evidenceCache.set(cacheKey, {
        expiresAt: Date.now() + SESSION_EVIDENCE_CACHE_TTL_MS,
        value,
      });
      this.trimEvidenceCache();
      return value;
    } finally {
      if (this.evidenceInFlight.get(cacheKey) === work) {
        this.evidenceInFlight.delete(cacheKey);
      }
    }
  }

  private async computeEvidence(
    binding: SessionProcessBinding,
    window: { since: number; until: number },
    timeWindows?: readonly { sinceMs: number; untilMs: number }[],
    eventLimitInput = DEFAULT_SESSION_EVENT_LIMIT,
    options?: SessionEvidenceOptions,
  ): Promise<LocalSessionSystemEvidence> {
    const eventLimit = Math.max(
      1,
      Math.min(MAX_SESSION_EVENT_LIMIT, Math.trunc(eventLimitInput)),
    );
    const persist = options?.persist !== false;
    // Read-only changes writes, never the ownership context. Competing and nested
    // Sessions must participate in both detail reads and background reconciliation.
    let bindingSaved = !persist;
    if (persist) {
      bindingSaved = await this.relational.saveSessionProcessBindings([binding]);
    }
    const loadedBindings = await this.relational.loadSessionProcessBindings({
      hostId: binding.hostId, bootId: binding.bootId, since: window.since, until: window.until,
    });
    const bindingContextUnavailable = loadedBindings === null;
    const allBindings = (loadedBindings ?? []).filter(item => item.bindingId !== binding.bindingId);
    allBindings.push(binding);
    const contextHash = bindingContextHash(allBindings);
    // Persisted relations are an incremental materialization, not a completeness proof. The
    // background reconciler deliberately reads bounded batches; returning as soon as one old
    // relation exists can therefore hide newer ToolExec events from an active Session. Always
    // perform the bounded live family walk for an interactive read. Persisted relations remain a
    // fail-closed fallback below when both lifecycle and observed-event storage are unavailable.
    // The UI asks for a bounded page, not a complete replay of a multi-day process tree. Keep a
    // small structural budget for the interactive request; the background reconciler can walk
    // the full 5,000-fact family later. This also prevents a single busy sandbox parent from
    // monopolising ClickHouse while the first page is being rendered.
    const familyFactFloor = persist ? 512 : INTERACTIVE_FAMILY_FACT_FLOOR;
    const familyFactLimit = Math.min(
      MAX_SESSION_FACTS,
      Math.max(familyFactFloor, eventLimit * 2),
    );
    let familyCoverageLimited = false;
    const primaryFamily = await this.clickhouse.readSessionProcessFamilyFacts({
      rootProcessInstanceKey: binding.matchedOsProcessInstanceKey,
      rootPid: binding.matchedPid,
      rootStartTime: binding.matchedStartTime,
      hostId: binding.hostId,
      bootId: binding.bootId,
      ...(binding.pidNamespace ? { pidNamespace: binding.pidNamespace } : {}),
      sinceMs: window.since,
      untilMs: window.until,
      limit: familyFactLimit,
      prioritizeRecent: true,
      onCoverageLimited: () => { familyCoverageLimited = true; },
      ...(persist ? {} : {
        maxDepth: INTERACTIVE_FAMILY_MAX_DEPTH,
        skipLegacyFallback: true,
      }),
    });
    // A busy ClickHouse can time out the lifecycle projection while the narrower event locator is
    // still queryable. Keep the exact Session binding as a root and continue with the observed
    // event path instead of turning a transient projection timeout into an empty evidence page.
    // The final completeness flag remains partial so callers can distinguish this degraded read.
    const familyReadUnavailable = primaryFamily === null;
    const factMap = new Map<string, ProcessLifecycleFact>();
    for (const fact of primaryFamily ?? []) {
      const current = factMap.get(fact.factId);
      if (!current || fact.receivedAt > current.receivedAt) factMap.set(fact.factId, fact);
    }
    const facts = [...factMap.values()].sort((left, right) => left.at - right.at);
    const primaryProcessKeys = new Set([
      binding.matchedOsProcessInstanceKey,
      ...facts.map((fact) => fact.processInstanceKey),
    ]);
    // A Session detail only needs bindings that can structurally claim this exact process family.
    // Same-Agent bindings on unrelated roots are validation context, not attribution candidates.
    const bindings = allBindings.filter((candidate) =>
      candidate.bindingId === binding.bindingId
      || candidate.matchedOsProcessInstanceKey === binding.matchedOsProcessInstanceKey
      || primaryProcessKeys.has(candidate.matchedOsProcessInstanceKey)
      || candidate.launcherProcessInstanceKey === binding.matchedOsProcessInstanceKey
      || candidate.agentRootProcessInstanceKey === binding.matchedOsProcessInstanceKey);
    if (!bindings.some((candidate) => candidate.bindingId === binding.bindingId)) {
      bindings.push(binding);
    }

    const edges = this.lineageEdges(facts, bindings);
    const descendants = this.descendantIndex(edges, bindings);
    const results: EventSessionAttributionResult[] = [];
    const relations: EventSessionRelation[] = [];
    const calculatedAt = Date.now();

    const observedProcesses = new Map<string, {
      pid: number;
      ppid?: number;
      startTime?: string;
      pidNamespace?: string;
      validFrom: number;
      validTo?: number;
    }>();
    for (const fact of facts) {
      const current = observedProcesses.get(fact.processInstanceKey);
      observedProcesses.set(fact.processInstanceKey, {
        pid: fact.pid,
        ...(fact.ppid ?? current?.ppid ? { ppid: fact.ppid ?? current?.ppid } : {}),
        ...(fact.startTime ? { startTime: fact.startTime } : current?.startTime ? { startTime: current.startTime } : {}),
        ...(fact.pidNamespace
          ? { pidNamespace: fact.pidNamespace }
          : current?.pidNamespace
            ? { pidNamespace: current.pidNamespace }
            : {}),
        validFrom: Math.min(current?.validFrom ?? fact.at, fact.at),
        ...(fact.factKind === 'exit' || current?.validTo !== undefined
          ? { validTo: Math.min(current?.validTo ?? fact.at, fact.at) }
          : {}),
      });
    }
    for (const candidate of bindings) {
      if (
        candidate.hostId === binding.hostId
        && candidate.bootId === binding.bootId
        && (candidate.pidNamespace ?? '') === (binding.pidNamespace ?? '')
      ) {
        const current = observedProcesses.get(candidate.matchedOsProcessInstanceKey);
        observedProcesses.set(candidate.matchedOsProcessInstanceKey, {
          pid: candidate.matchedPid,
          ...(current?.ppid ? { ppid: current.ppid } : {}),
          startTime: candidate.matchedStartTime,
          ...(candidate.pidNamespace
            ? { pidNamespace: candidate.pidNamespace }
            : current?.pidNamespace
              ? { pidNamespace: current.pidNamespace }
              : {}),
          validFrom: Math.min(current?.validFrom ?? candidate.validFrom, candidate.validFrom),
          ...(candidate.validTo !== undefined || current?.validTo !== undefined
            ? {
                validTo: Math.min(
                  current?.validTo ?? candidate.validTo!,
                  candidate.validTo ?? current!.validTo!,
                ),
              }
            : {}),
        });
      }
    }
    const observedRead = await this.clickhouse.readSessionProcessObservedEvents({
      processes: [...observedProcesses].map(([processInstanceKey, process]) => ({
        processInstanceKey,
        ...process,
      })),
      hostId: binding.hostId,
      bootId: binding.bootId,
      ...(binding.pidNamespace ? { pidNamespace: binding.pidNamespace } : {}),
      sinceMs: window.since,
      untilMs: window.until,
      ...(timeWindows?.length ? { timeWindows } : {}),
      limit: familyFactLimit,
    });

    const observedAttributableEvents = (observedRead ?? []).map(({ event, processInstanceKey }) => {
      // Session bindings and lifecycle facts both use the Observer attribution contract (`ari_*`).
      // The semantic host/container runtime key is a different identity dimension and must not be
      // compared to agentInstanceId, otherwise valid network/file events become false conflicts.
      const runtimeInstanceId = event.attribution?.agentInstanceId?.trim();
      const runtimeRootPid = event.attribution?.rootPid;
      const normalizedRuntimeRootStartTime = runtimeRootStartTime(
        event.attribution?.rootStartTime,
      );
      return {
        eventId: event.eventId,
        eventKind: event.eventKind,
        at: event.at,
        processInstanceKey,
        ...(event.process?.pid ? { processPid: event.process.pid } : {}),
        ...(event.process?.ppid ? { processPpid: event.process.ppid } : {}),
        ...(event.process?.startTimeTicks
          ? { processStartTime: `ticks:${event.process.startTimeTicks}` }
          : event.process?.startTimeNs
            ? { processStartTime: `ns:${event.process.startTimeNs}` }
            : {}),
        ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
        ...(runtimeRootPid ? { runtimeRootPid } : {}),
        ...(normalizedRuntimeRootStartTime
          ? { runtimeRootStartTime: normalizedRuntimeRootStartTime }
          : {}),
      };
    });
    const attributableEvents: AttributableProcessEvent[] = [
      ...facts.map((fact) => ({
        ...fact,
        eventKind: fact.factKind === 'exec' ? 'ToolExec' : fact.factKind === 'exit' ? 'ProcessExit' : undefined,
        // A lifecycle projection can establish a new Observer Agent root before that nested
        // runtime creates (or without it ever creating) a Native Session file. Preserve that
        // exact generation as a family-local root alias. If a Native Session binding later
        // appears, the more-specific Session-boundary rule below takes ownership instead.
        ...(fact.rootProcess && fact.runtimeInstanceId ? {
          runtimeRootPid: fact.pid,
          runtimeRootStartTime: fact.startTime,
        } : {}),
      })),
      ...observedAttributableEvents,
    ];
    const uniqueAttributableEvents = [...new Map(
      attributableEvents.map((item) => [item.eventId, item]),
    ).values()].sort((left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId));
    // exec preserves PID/start-time. A launch shell and its initialization children can therefore
    // precede the Session Agent within the very same OS generation. Require an observed earlier
    // exec under a different root AND a later exact self-root claim; timestamps alone, a child
    // claim, or a final ProcessExit cannot establish this transition. Keep these old facts as
    // unattributed context, never as aliases/confirmed evidence of the new Agent.
    const identityTransitions = new Map<string, { at: number; priorRuntimeStarts: Map<string, number> }>();
    for (const candidate of bindings) {
      if (!candidate.agentInstanceId) continue;
      const rootEvents = uniqueAttributableEvents.filter((item) =>
        item.processInstanceKey === candidate.matchedOsProcessInstanceKey);
      const ownRoot = rootEvents.find((item) =>
        item.runtimeInstanceId === candidate.agentInstanceId
        && item.runtimeRootPid === candidate.matchedPid
        && item.runtimeRootStartTime === candidate.matchedStartTime
        && item.eventKind !== undefined && item.eventKind !== 'ProcessExit');
      if (!ownRoot) continue;
      const priorRuntimeStarts = new Map<string, number>();
      for (const item of rootEvents) {
        if (item.at >= ownRoot.at) break;
        if (item.eventKind !== 'ToolExec' || !item.runtimeInstanceId
          || item.runtimeInstanceId === candidate.agentInstanceId
          || !item.runtimeRootPid || item.runtimeRootPid === candidate.matchedPid
          || !item.runtimeRootStartTime) continue;
        if (!priorRuntimeStarts.has(item.runtimeInstanceId)) {
          priorRuntimeStarts.set(item.runtimeInstanceId, item.at);
        }
      }
      if (priorRuntimeStarts.size) identityTransitions.set(candidate.bindingId, { at: ownRoot.at, priorRuntimeStarts });
    }
    const startupContext: NonNullable<LocalSessionSystemEvidence['startupContext']> = [];
    const eventAtById = new Map(uniqueAttributableEvents.map((item) => [item.eventId, item.at]));
    const familyGenerationRefs = new Set([
      processGenerationRef(binding.matchedPid, binding.matchedStartTime),
      ...facts.map((item) => processGenerationRef(item.pid, item.startTime)),
    ].filter((item): item is string => Boolean(item)));

    // A collector restart can re-root an already-running Agent at its launcher. The old and new
    // `ari_*` values are still one process family when the emitted root PID is an observed parent
    // of the Session generation. Build that parent frontier from the exact facts/events selected
    // above; this keeps the alias local to the proven Session tree and does not trust a display name,
    // workspace, or an arbitrary root PID supplied by an unrelated event.
    const parentPidsByPid = new Map<number, Set<number>>();
    const knownStartsByPid = new Map<number, Set<string>>();
    const registerProcessShape = (pid: number | undefined, ppid: number | undefined, start?: string) => {
      if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return;
      const processPid = pid as number;
      if (Number.isSafeInteger(ppid) && (ppid ?? 0) > 0) {
        const parents = parentPidsByPid.get(processPid) ?? new Set<number>();
        parents.add(ppid as number);
        parentPidsByPid.set(processPid, parents);
      }
      if (start) {
        const starts = knownStartsByPid.get(processPid) ?? new Set<string>();
        starts.add(start);
        knownStartsByPid.set(processPid, starts);
      }
    };
    for (const fact of facts) registerProcessShape(fact.pid, fact.ppid, fact.startTime);
    for (const item of observedAttributableEvents) {
      registerProcessShape(item.processPid, item.processPpid, item.processStartTime);
    }
    registerProcessShape(binding.matchedPid, undefined, binding.matchedStartTime);
    const familyPids = new Set<number>([
      binding.matchedPid,
      ...facts.map((fact) => fact.pid),
      ...observedAttributableEvents
        .map((item) => item.processPid)
        .filter((pid): pid is number => Number.isSafeInteger(pid) && (pid ?? 0) > 0),
    ]);
    const familyAncestorPids = new Set<number>();
    const pendingFamilyPids = [...familyPids];
    const visitedFamilyPids = new Set<number>();
    while (pendingFamilyPids.length > 0) {
      const pid = pendingFamilyPids.shift() as number;
      if (visitedFamilyPids.has(pid)) continue;
      visitedFamilyPids.add(pid);
      for (const parentPid of parentPidsByPid.get(pid) ?? []) {
        if (parentPid <= 0 || parentPid === pid) continue;
        familyAncestorPids.add(parentPid);
        // A parent may itself be represented by a lifecycle/event shape. Walking the graph makes
        // launcher -> runtime -> sandbox transitions work without widening to all host PIDs.
        pendingFamilyPids.push(parentPid);
      }
    }
    const familyRuntimeInstanceIds = new Set<string>();
    const runtimeFactProcessKeys = new Map<string, Set<string>>();
    const familyProcessKeys = new Set<string>([
      binding.matchedOsProcessInstanceKey,
      ...(descendants.get(binding.bindingId) ?? []),
    ]);
    for (const fact of facts) {
      if (!fact.runtimeInstanceId || !familyProcessKeys.has(fact.processInstanceKey)) continue;
      const processKeys = runtimeFactProcessKeys.get(fact.runtimeInstanceId) ?? new Set<string>();
      processKeys.add(fact.processInstanceKey);
      runtimeFactProcessKeys.set(fact.runtimeInstanceId, processKeys);
      // A lifecycle root fact is an explicit family-local ownership claim. It is safe to retain
      // even when this runtime has not yet emitted a second process generation.
      if (fact.rootProcess) familyRuntimeInstanceIds.add(fact.runtimeInstanceId);
    }
    // When an Observer restarts, the lifecycle projection can retain a short run of child facts
    // under the previous `ari_*` while the new interaction lane reports another id. Requiring at
    // least two exact process generations prevents a one-off foreign event from becoming an alias,
    // while preserving a real launcher/runtime transition (the common case has many children).
    for (const [runtimeId, processKeys] of runtimeFactProcessKeys) {
      if (processKeys.size >= 2) familyRuntimeInstanceIds.add(runtimeId);
    }
    const runtimeIdsWithExternalRoot = new Set<string>();
    for (const item of uniqueAttributableEvents) {
      if (!item.runtimeInstanceId) continue;
      const emittedByExactSessionProcess =
        item.processInstanceKey === binding.matchedOsProcessInstanceKey;
      const attributedRootIsInFamily = familyGenerationRefs.has(
        processGenerationRef(item.runtimeRootPid, item.runtimeRootStartTime) ?? '',
      );
      const attributedRootIsObservedAncestor =
        item.runtimeRootPid !== undefined
        && familyAncestorPids.has(item.runtimeRootPid)
        && (() => {
          const knownStarts = knownStartsByPid.get(item.runtimeRootPid);
          // If we have a trusted root generation, require the emitted start time to agree. When
          // the launcher itself has no lifecycle row (common after an Observer restart), the
          // direct parent edge is still exact and the start-time check has no value to compare.
          if (!knownStarts || knownStarts.size === 0) return true;
          if (!item.runtimeRootStartTime) return false;
          return knownStarts.has(item.runtimeRootStartTime);
        })();
      if (
        (item.runtimeRootPid !== undefined || item.runtimeRootStartTime !== undefined)
        && !attributedRootIsInFamily
        && !attributedRootIsObservedAncestor
      ) {
        runtimeIdsWithExternalRoot.add(item.runtimeInstanceId);
      }
      // Observer may initially anchor an Agent to its launcher and later re-root the same live
      // process generation after the launcher exits. The resulting ari_* values are aliases for
      // this Session process family, not evidence that an unrelated Agent produced the event.
      if (emittedByExactSessionProcess || attributedRootIsInFamily || attributedRootIsObservedAncestor) {
        familyRuntimeInstanceIds.add(item.runtimeInstanceId);
      }
    }

    for (const fact of uniqueAttributableEvents) {
      const structuralCandidates = bindings.flatMap((candidate) => {
        const relation = fact.processInstanceKey === candidate.matchedOsProcessInstanceKey
          ? 'DIRECT' as const
          : descendants.get(candidate.bindingId)?.has(fact.processInstanceKey)
            ? 'LINEAGE' as const
            : undefined;
        return relation ? [{ binding: candidate, relation }] : [];
      });
      // This on-demand calculation is scoped to the Session process families. A platform-wide
      // UNATTRIBUTED ledger belongs in a background reconciler, not in a detail-page request.
      if (structuralCandidates.length === 0) continue;
      const activeCandidates = structuralCandidates.filter(({ binding: candidate }) =>
        bindingContains(candidate, fact.at));
      // A nested Agent Session is a proven process-tree ownership boundary. Once an event is on
      // or below that more-specific Session root, an ancestor Session remains useful lineage
      // context but must not compete for ownership. Bindings on the same exact process generation
      // are deliberately retained: two distinct Native Sessions there are genuinely ambiguous.
      const candidates = activeCandidates.filter((candidate) =>
        !activeCandidates.some((other) =>
          other.binding.matchedOsProcessInstanceKey
            !== candidate.binding.matchedOsProcessInstanceKey
          && descendants.get(candidate.binding.bindingId)?.has(
            other.binding.matchedOsProcessInstanceKey,
          )));
      const conflicting = candidates.filter(({ binding: candidate }) =>
        Boolean(
          fact.runtimeInstanceId
          && candidate.agentInstanceId
          && fact.runtimeInstanceId !== candidate.agentInstanceId
          && (
            !familyRuntimeInstanceIds.has(fact.runtimeInstanceId)
            || runtimeIdsWithExternalRoot.has(fact.runtimeInstanceId)
          ),
        ));
      const accepted = candidates.filter((candidate) => !conflicting.includes(candidate));
      const candidateConversationIds = [...new Set(
        candidates.map((candidate) => candidate.binding.conversationId),
      )].sort();
      let result: EventSessionAttributionResult;
      const acceptedNativeSessions = new Set(
        accepted.map((candidate) => nativeSessionIdentity(candidate.binding)),
      );
      const transition = candidates.length === 1
        ? identityTransitions.get(candidates[0].binding.bindingId) : undefined;
      const priorRuntimeStart = fact.runtimeInstanceId
        ? transition?.priorRuntimeStarts.get(fact.runtimeInstanceId) : undefined;
      if (bindingContextUnavailable) {
        result = this.result(fact, 'UNATTRIBUTED', 'binding_context_unavailable',
          [binding.conversationId], calculatedAt);
      } else if (transition && priorRuntimeStart !== undefined
        && fact.at >= priorRuntimeStart && fact.at < transition.at) {
        result = this.result(fact, 'UNATTRIBUTED', 'before_agent_identity_transition',
          candidateConversationIds, calculatedAt);
        if (candidateConversationIds.includes(binding.conversationId)) {
          startupContext.push({ eventId: fact.eventId, at: fact.at,
            previousAgentInstanceId: fact.runtimeInstanceId!, identityObservedAt: transition.at });
        }
      } else if (acceptedNativeSessions.size > 1) {
        result = this.result(fact, 'AMBIGUOUS', 'multiple_active_sessions', candidateConversationIds, calculatedAt);
      } else if (accepted.length > 0) {
        // A stale or incorrectly enriched candidate must not veto a valid exact-generation
        // candidate. Prefer DIRECT over LINEAGE. When local-Session and Observer projections are
        // aliases of one Native Session, keep the binding requested by this detail view so its
        // definite relations remain visible under the page's conversation id.
        const selected = [...accepted].sort((left, right) =>
          Number(right.relation === 'DIRECT') - Number(left.relation === 'DIRECT')
          || Number(right.binding.bindingId === binding.bindingId)
            - Number(left.binding.bindingId === binding.bindingId)
          || Number(right.binding.conversationId === binding.conversationId)
            - Number(left.binding.conversationId === binding.conversationId)
          || right.binding.validFrom - left.binding.validFrom
          || right.binding.bindingRevision - left.binding.bindingRevision)[0];
        result = this.result(
          fact,
          selected.relation,
          selected.relation === 'DIRECT' ? 'exact_session_process' : 'trusted_process_lineage',
          [selected.binding.conversationId],
          calculatedAt,
          selected.binding,
        );
        relations.push({
          schemaVersion: 'anysentry.event_session_relation.v1',
          relationId: eventSessionRelationId({
            eventId: fact.eventId,
            conversationId: selected.binding.conversationId,
            bindingRevision: selected.binding.bindingRevision,
          }),
          eventId: fact.eventId,
          eventAt: fact.at,
          bindingContextHash: contextHash,
          conversationId: selected.binding.conversationId,
          bindingId: selected.binding.bindingId,
          bindingRevision: selected.binding.bindingRevision,
          processInstanceKey: fact.processInstanceKey,
          relation: selected.relation,
          confidence: selected.relation === 'DIRECT' ? 1 : 0.9,
          active: true,
          effectiveFrom: calculatedAt,
          attributionAlgorithm: SESSION_EVENT_ATTRIBUTION_ALGORITHM,
          attributionVersion: SESSION_EVENT_ATTRIBUTION_VERSION,
          createdAt: calculatedAt,
        });
      } else if (conflicting.length > 0) {
        result = this.result(
          fact,
          'CONFLICT',
          'agent_identity_conflict',
          candidateConversationIds,
          calculatedAt,
        );
      } else {
        result = this.result(
          fact,
          'UNATTRIBUTED',
          candidates.length === 0 ? 'outside_binding_interval' : 'lineage_not_observed',
          [...new Set(
            structuralCandidates.map((candidate) => candidate.binding.conversationId),
          )].sort(),
          calculatedAt,
        );
      }
      results.push(result);
    }

    let edgesSaved = !persist;
    let resultsSaved = !persist;
    let relationsSaved = !persist;
    let relationsReconciled = !persist;
    if (persist && !bindingContextUnavailable) {
      [edgesSaved, resultsSaved] = await Promise.all([
        this.relational.saveProcessLineageEdges(edges),
        this.relational.saveEventSessionAttributionResults(results),
      ]);
      relationsSaved = await this.relational.saveEventSessionRelations(relations);
      relationsReconciled = await this.relational.reconcileEventSessionRelations(
        results,
        relations,
        calculatedAt,
      );
    }
    const relevantRelationsAll = relations
      .filter((relation) => relation.conversationId === binding.conversationId)
      .sort((left, right) =>
        (eventAtById.get(right.eventId) ?? 0) - (eventAtById.get(left.eventId) ?? 0)
        || right.eventId.localeCompare(left.eventId));
    const relevantRelations = relevantRelationsAll
      .slice(0, eventLimit);
    const familyLineage = edges.filter((edge) =>
      descendants.get(binding.bindingId)?.has(edge.childProcessInstanceKey));
    const lineageByChild = new Map<string, ProcessLineageEdge[]>();
    for (const edge of familyLineage) {
      const values = lineageByChild.get(edge.childProcessInstanceKey) ?? [];
      values.push(edge);
      lineageByChild.set(edge.childProcessInstanceKey, values);
    }
    const returnedLineageIds = new Set<string>();
    // The evidence page only needs the ancestor paths that connect its returned relations to the
    // Session root. Returning every edge from a multi-week Codex process made a 250-event response
    // exceed 1 MiB even though the UI never rendered those unrelated branches.
    for (const relation of relevantRelations) {
      let child = relation.processInstanceKey;
      const relationAt = eventAtById.get(relation.eventId) ?? calculatedAt;
      const visited = new Set<string>();
      for (let depth = 0; depth < 64 && child !== binding.matchedOsProcessInstanceKey; depth += 1) {
        if (visited.has(child)) break;
        visited.add(child);
        const candidates = lineageByChild.get(child) ?? [];
        const edge = candidates.find((item) =>
          item.validFrom <= relationAt
          && (item.validTo === undefined || relationAt <= item.validTo))
          ?? candidates[0];
        if (!edge) break;
        returnedLineageIds.add(edge.edgeId);
        child = edge.parentProcessInstanceKey;
      }
    }
    const returnedLineage = familyLineage.filter((edge) => returnedLineageIds.has(edge.edgeId));
    const relationEventIds = relevantRelations.map((relation) => relation.eventId);
    // Live Observer traffic is already present in SentryJudge's bounded latest-revision ring.  A
    // detail read should not round-trip those same rows through a busy, at-ordered ClickHouse
    // table (which can otherwise scan tens of thousands of rows for a few event IDs).  Validate
    // the event-time locator before accepting a hot hit so an ID collision/revision from another
    // generation cannot leak into this Session.
    const hotEvents = this.judge?.hotEventsByIds(relationEventIds, eventAtById) ?? [];
    const hotEventIds = new Set(hotEvents.map((event) => event.eventId));
    const durableEventIds = relationEventIds.filter((eventId) => !hotEventIds.has(eventId));
    let durableEvents: Awaited<ReturnType<ClickHouseStore['eventsByIds']>> = [];
    if (durableEventIds.length > 0) {
      durableEvents = await this.clickhouse.eventsByIds(
        durableEventIds,
        window.since,
        window.until,
        eventAtById,
      );
    }
    const eventLookupUnavailable = durableEvents === null;
    const events = durableEvents === null
      ? (hotEvents.length > 0 ? hotEvents : null)
      : [...hotEvents, ...durableEvents];
    const eventsById = new Map((events ?? []).map((event) => [event.eventId, event]));
    const currentResults = results.filter((result) =>
      result.candidateConversationIds.includes(binding.conversationId));

    if (
      !persist
      && relevantRelationsAll.length === 0
      && (familyReadUnavailable || observedRead === null || eventLookupUnavailable)
      && !bindingContextUnavailable
      && typeof this.relational.loadActiveEventSessionRelations === 'function'
      && typeof this.relational.loadProcessLineageEdgesForProcesses === 'function'
    ) {
      const persisted = await this.evidenceFromPersistedRelations(
        binding,
        window,
        eventLimit,
        contextHash,
        timeWindows,
      );
      if (persisted) return persisted;
    }

    return {
      schemaVersion: 'anysentry.local-session-system-evidence.v1',
      conversationId: binding.conversationId,
      evidenceScope: 'current_generation',
      binding: this.bindingView(binding),
      persistence: !persist ? 'not_checked' : !bindingContextUnavailable
        && bindingSaved
        && edgesSaved
        && resultsSaved
        && relationsSaved
        && relationsReconciled
        ? 'persisted'
        : 'degraded',
      // Long-lived Sessions can include event parts written before lifecycle projection/indexes
      // existed. Interactive reads recover the recent process generation and relationships, but
      // must not claim historical completeness before an explicit background backfill finishes.
      completeness: options?.coveragePartial === true
        || familyCoverageLimited
        || bindingContextUnavailable
        || facts.length >= familyFactLimit
        || facts.length >= MAX_SESSION_FACTS
        || eventLookupUnavailable
        || familyReadUnavailable
        || observedRead === null
        || window.until - window.since > INTERACTIVE_LEGACY_COVERAGE_HORIZON_MS
        ? 'partial'
        : 'complete_as_observed',
      counts: {
        direct: relevantRelationsAll.filter((item) => item.relation === 'DIRECT').length,
        lineage: relevantRelationsAll.filter((item) => item.relation === 'LINEAGE').length,
        ambiguous: currentResults.filter((item) => item.status === 'AMBIGUOUS').length,
        conflict: currentResults.filter((item) => item.status === 'CONFLICT').length,
        unattributed: currentResults.filter((item) => item.status === 'UNATTRIBUTED').length,
      },
      page: {
        requestedLimit: eventLimit,
        totalRelations: relevantRelationsAll.length,
        loadedRelations: relevantRelations.length,
        returnedEvents: eventsById.size,
        unavailableEvents: Math.max(0, relevantRelations.length - eventsById.size),
        totalLineageEdges: familyLineage.length,
        returnedLineageEdges: returnedLineage.length,
        processFamilyTruncated: familyCoverageLimited,
        hasMore: familyCoverageLimited || relevantRelations.length < relevantRelationsAll.length,
      },
      lineage: returnedLineage
        .map((edge) => ({
          edgeId: edge.edgeId,
          parentProcessInstanceKey: edge.parentProcessInstanceKey,
          childProcessInstanceKey: edge.childProcessInstanceKey,
          parentPid: edge.parentPid,
          childPid: edge.childPid,
          validFrom: edge.validFrom,
          ...(edge.validTo !== undefined ? { validTo: edge.validTo } : {}),
        })),
      events: relevantRelations.flatMap((relation) => {
        const event = eventsById.get(relation.eventId);
        if (!event) return [];
        const command = typeof event.attributes.command === 'string'
          ? event.attributes.command
          : typeof event.attributes.argv === 'string'
            ? event.attributes.argv
            : undefined;
        return [{
          relationId: relation.relationId,
          relation: relation.relation,
          confidence: relation.confidence,
          eventId: event.eventId,
          at: event.at,
          eventKind: event.eventKind,
          eventCategory: event.eventCategory,
          subject: systemEvidenceSubject(event),
          processInstanceKey: relation.processInstanceKey,
          ...(event.process?.pid ? { pid: event.process.pid } : {}),
          ...(event.process?.ppid ? { ppid: event.process.ppid } : {}),
          ...(command ? { command } : {}),
          commandHash: observedCommandHash(event.attributes),
          toolCallBinding: systemToolCallBinding(event.attribution?.correlation),
          verdict: event.verdict,
          tier: event.tier,
          severity: event.severity,
          riskScore: event.riskScore,
          ...(event.decisionRevision !== undefined
            ? { decisionRevision: event.decisionRevision }
            : {}),
          ...(event.traceId ? { traceId: event.traceId } : {}),
          ...(event.spanId ? { spanId: event.spanId } : {}),
        }];
      }),
      ...(startupContext.length ? { startupContext } : {}),
      exceptions: currentResults.flatMap((result) =>
        result.status === 'AMBIGUOUS' || result.status === 'CONFLICT'
          ? [{
              resultId: result.resultId,
              eventId: result.eventId,
              status: result.status,
              reason: result.reason,
              candidateConversationIds: result.candidateConversationIds,
            }]
          : []),
      calculatedAt,
    };
  }

  private async evidenceFromPersistedRelations(
    binding: SessionProcessBinding,
    window: { since: number; until: number },
    eventLimit: number,
    contextHash: string,
    timeWindows?: readonly { sinceMs: number; untilMs: number }[],
    historical = false,
  ): Promise<LocalSessionSystemEvidence | undefined> {
    const relations = historical
      ? await this.relational.loadHistoricalEventSessionRelations({
          bindingId: binding.bindingId,
          conversationId: binding.conversationId,
          limit: eventLimit,
          since: window.since,
          until: window.until,
        })
      : await this.relational.loadActiveEventSessionRelations({
          bindingId: binding.bindingId,
          conversationId: binding.conversationId,
          limit: eventLimit,
          since: window.since,
          until: window.until,
          bindingContextHash: contextHash,
          bindingRevision: binding.bindingRevision,
          timeWindows,
        });
    // null = store unavailable → fall through to the live ClickHouse walk.
    // [] = nothing persisted yet for this binding → also fall through.
    if (relations === null || relations.length === 0) return undefined;

    const processKeys = [
      binding.matchedOsProcessInstanceKey,
      ...relations.map((relation) => relation.processInstanceKey),
    ];
    const edges = await this.relational.loadProcessLineageEdgesForProcesses(
      processKeys,
      Math.max(64, eventLimit * 2),
    );
    if (edges === null) return undefined;

    const descendants = this.descendantIndex(edges, [binding]);
    const familyLineage = edges.filter((edge) =>
      edge.parentProcessInstanceKey === binding.matchedOsProcessInstanceKey
      || edge.childProcessInstanceKey === binding.matchedOsProcessInstanceKey
      || descendants.get(binding.bindingId)?.has(edge.childProcessInstanceKey)
      || descendants.get(binding.bindingId)?.has(edge.parentProcessInstanceKey));
    const lineageByChild = new Map<string, ProcessLineageEdge[]>();
    for (const edge of familyLineage) {
      const values = lineageByChild.get(edge.childProcessInstanceKey) ?? [];
      values.push(edge);
      lineageByChild.set(edge.childProcessInstanceKey, values);
    }
    const returnedLineageIds = new Set<string>();
    for (const relation of relations) {
      let child = relation.processInstanceKey;
      const visited = new Set<string>();
      for (let depth = 0; depth < 64 && child !== binding.matchedOsProcessInstanceKey; depth += 1) {
        if (visited.has(child)) break;
        visited.add(child);
        const edge = (lineageByChild.get(child) ?? [])[0];
        if (!edge) break;
        returnedLineageIds.add(edge.edgeId);
        child = edge.parentProcessInstanceKey;
      }
    }
    const returnedLineage = familyLineage.filter((edge) => returnedLineageIds.has(edge.edgeId));
    const relationEventIds = relations.map((relation) => relation.eventId);
    const eventAtById = new Map<string, number>(relations.map(item => [item.eventId, item.eventAt!]));
    const hotEvents = this.judge?.hotEventsByIds(relationEventIds, eventAtById) ?? [];
    const hotEventIds = new Set(hotEvents.map((event) => event.eventId));
    const durableEventIds = relationEventIds.filter((eventId) => !hotEventIds.has(eventId));
    let durableEvents: Awaited<ReturnType<ClickHouseStore['eventsByIds']>> = [];
    if (durableEventIds.length > 0) {
      durableEvents = await this.clickhouse.eventsByIds(
        durableEventIds,
        window.since,
        window.until,
        eventAtById,
      );
    }
    const eventLookupUnavailable = durableEvents === null;
    const events = durableEvents === null
      ? (hotEvents.length > 0 ? hotEvents : null)
      : [...hotEvents, ...durableEvents];
    const eventsById = new Map((events ?? []).map((event) => {
      eventAtById.set(event.eventId, Math.max(eventAtById.get(event.eventId) ?? 0, event.at));
      return [event.eventId, event];
    }));
    const calculatedAt = Date.now();
    return {
      schemaVersion: 'anysentry.local-session-system-evidence.v1',
      conversationId: binding.conversationId,
      evidenceScope: historical ? 'historical_persisted' : 'current_generation',
      binding: this.bindingView(binding),
      persistence: 'persisted',
      completeness: 'partial',
      counts: {
        direct: relations.filter((item) => item.relation === 'DIRECT').length,
        lineage: relations.filter((item) => item.relation === 'LINEAGE').length,
        ambiguous: 0,
        conflict: 0,
        unattributed: 0,
      },
      page: {
        requestedLimit: eventLimit,
        totalRelations: relations.length,
        loadedRelations: relations.length,
        returnedEvents: eventsById.size,
        unavailableEvents: Math.max(0, relations.length - eventsById.size),
        totalLineageEdges: familyLineage.length,
        returnedLineageEdges: returnedLineage.length,
        hasMore: relations.length >= eventLimit || eventLookupUnavailable,
      },
      lineage: returnedLineage.map((edge) => ({
        edgeId: edge.edgeId,
        parentProcessInstanceKey: edge.parentProcessInstanceKey,
        childProcessInstanceKey: edge.childProcessInstanceKey,
        parentPid: edge.parentPid,
        childPid: edge.childPid,
        validFrom: edge.validFrom,
        ...(edge.validTo !== undefined ? { validTo: edge.validTo } : {}),
      })),
      events: relations.flatMap((relation) => {
        const event = eventsById.get(relation.eventId);
        if (!event) return [];
        const command = typeof event.attributes.command === 'string'
          ? event.attributes.command
          : typeof event.attributes.argv === 'string'
            ? event.attributes.argv
            : undefined;
        return [{
          relationId: relation.relationId,
          relation: relation.relation,
          confidence: relation.confidence,
          eventId: event.eventId,
          at: event.at,
          eventKind: event.eventKind,
          eventCategory: event.eventCategory,
          subject: systemEvidenceSubject(event),
          processInstanceKey: relation.processInstanceKey,
          ...(event.process?.pid ? { pid: event.process.pid } : {}),
          ...(event.process?.ppid ? { ppid: event.process.ppid } : {}),
          ...(command ? { command } : {}),
          commandHash: observedCommandHash(event.attributes),
          toolCallBinding: systemToolCallBinding(event.attribution?.correlation),
          verdict: event.verdict,
          tier: event.tier,
          severity: event.severity,
          riskScore: event.riskScore,
          ...(event.decisionRevision !== undefined
            ? { decisionRevision: event.decisionRevision }
            : {}),
          ...(event.traceId ? { traceId: event.traceId } : {}),
          ...(event.spanId ? { spanId: event.spanId } : {}),
        }];
      }).sort((left, right) => right.at - left.at || right.eventId.localeCompare(left.eventId)),
      exceptions: [],
      calculatedAt,
    };
  }

  private evidenceCacheKey(
    binding: SessionProcessBinding,
    window: { since: number; until: number },
    timeWindows: readonly { sinceMs: number; untilMs: number }[] | undefined,
    eventLimit: number,
    options?: SessionEvidenceOptions,
  ): string {
    // Do not include observedAt or other mutable bookkeeping fields. A resolver can construct a
    // semantically identical binding on every poll; those requests should still coalesce. Keep
    // the process generation, binding revision, and bounded time windows so a new generation or
    // newly appended active turn cannot reuse an older result.
    const interactive = options?.persist === false;
    return JSON.stringify({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      nativeSessionId: binding.nativeSessionId,
      matchedOsProcessInstanceKey: binding.matchedOsProcessInstanceKey,
      matchedPid: binding.matchedPid,
      matchedStartTime: binding.matchedStartTime,
      hostId: binding.hostId,
      bootId: binding.bootId,
      pidNamespace: binding.pidNamespace ?? '',
      conversationId: binding.conversationId,
      agentInstanceId: binding.agentInstanceId ?? '',
      // The interactive reader intentionally uses a moving `until` bound for an active Session.
      // Treat that read as one short-lived snapshot so a tab switch or retry immediately after a
      // slow computation can reuse it. Background/persistent calls retain exact windows.
      window: {
            since: Math.trunc(window.since),
            until: Math.trunc(window.until),
          },
      timeWindows: (timeWindows ?? []).map((item) => ({
            sinceMs: Math.trunc(item.sinceMs),
            untilMs: Math.trunc(item.untilMs),
          })),
      eventLimit,
      coveragePartial: interactive ? true : options?.coveragePartial === true,
      persist: options?.persist !== false,
    });
  }

  private trimEvidenceCache(): void {
    if (this.evidenceCache.size <= MAX_SESSION_EVIDENCE_CACHE_ENTRIES) return;
    const entries = [...this.evidenceCache.entries()]
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    for (const [key] of entries.slice(0, this.evidenceCache.size - MAX_SESSION_EVIDENCE_CACHE_ENTRIES)) {
      this.evidenceCache.delete(key);
    }
  }

  private lineageEdges(
    facts: ProcessLifecycleFact[],
    bindings: SessionProcessBinding[],
  ): ProcessLineageEdge[] {
    const firstFactByProcess = new Map<string, ProcessLifecycleFact>();
    const exitAtByProcess = new Map<string, number>();
    for (const fact of facts) {
      if (!firstFactByProcess.has(fact.processInstanceKey) || fact.factKind === 'exec') {
        const current = firstFactByProcess.get(fact.processInstanceKey);
        if (!current || fact.at < current.at) firstFactByProcess.set(fact.processInstanceKey, fact);
      }
      if (fact.factKind === 'exit') exitAtByProcess.set(fact.processInstanceKey, fact.at);
    }
    const processFacts = [...firstFactByProcess.values()].sort((left, right) => left.at - right.at);
    const edges = new Map<string, ProcessLineageEdge>();
    for (const child of processFacts) {
      if (!child.ppid) continue;
      const bindingParents = bindings.flatMap((binding) => {
        if (binding.bootId !== child.bootId || binding.hostId !== (child.hostId ?? '')) return [];
        if (!bindingContains(binding, child.at)) return [];
        if (binding.matchedPid === child.ppid) {
          if (!parentGenerationPrecedes(binding.matchedStartTime, child.startTime)) return [];
          const exitAt = exitAtByProcess.get(binding.matchedOsProcessInstanceKey);
          if (exitAt !== undefined && exitAt < child.at) return [];
          return [{ key: binding.matchedOsProcessInstanceKey, pid: binding.matchedPid }];
        }
        if (
          typeof binding.launcherPid === 'number'
          && binding.launcherPid === child.ppid
          && binding.launcherProcessInstanceKey
        ) {
          if (!parentGenerationPrecedes(binding.launcherStartTime, child.startTime)) return [];
          const exitAt = exitAtByProcess.get(binding.launcherProcessInstanceKey);
          if (exitAt !== undefined && exitAt < child.at) return [];
          return [{ key: binding.launcherProcessInstanceKey, pid: binding.launcherPid }];
        }
        return [];
      });
      const observedParents = processFacts
        .filter((candidate) =>
          candidate.pid === child.ppid
          && parentGenerationPrecedes(candidate.startTime, child.startTime)
          && candidate.at <= child.at
          && (exitAtByProcess.get(candidate.processInstanceKey) === undefined
            || (exitAtByProcess.get(candidate.processInstanceKey) as number) >= child.at)
          // Observer's `pid`/`ppid` are host PID identities. A trusted parent edge therefore
          // remains valid when bwrap/container startup moves the child into a new PID namespace.
          && sameHostBootScope(candidate, child))
        .map((candidate) => ({ key: candidate.processInstanceKey, pid: candidate.pid }));
      const successorParent = this.execImageSuccessorParent(processFacts, child);
      const parents = successorParent
        ? [successorParent]
        : [...new Map(
          [...bindingParents, ...observedParents].map((parent) => [parent.key, parent]),
        ).values()];
      if (parents.length !== 1 || parents[0].key === child.processInstanceKey) continue;
      const parent = parents[0];
      const edge: ProcessLineageEdge = {
        schemaVersion: 'anysentry.process_lineage_edge.v1',
        edgeId: processLineageEdgeId({
          childProcessInstanceKey: child.processInstanceKey,
          parentProcessInstanceKey: parent.key,
          validFrom: child.at,
          sourceEventId: child.eventId,
        }),
        childProcessInstanceKey: child.processInstanceKey,
        parentProcessInstanceKey: parent.key,
        ...(child.hostId ? { hostId: child.hostId } : {}),
        bootId: child.bootId,
        ...(child.pidNamespace ? { pidNamespace: child.pidNamespace } : {}),
        childPid: child.pid,
        parentPid: parent.pid,
        validFrom: child.at,
        ...(exitAtByProcess.get(child.processInstanceKey) !== undefined
          ? { validTo: exitAtByProcess.get(child.processInstanceKey) }
          : {}),
        evidenceType: 'DIRECT_OBSERVED',
        sourceEventId: child.eventId,
        observedAt: Date.now(),
      };
      edges.set(edge.edgeId, edge);
    }
    return [...edges.values()];
  }

  private execImageSuccessorParent(
    processFacts: ProcessLifecycleFact[],
    child: ProcessLifecycleFact,
  ): { key: string; pid: number } | undefined {
    const predecessors = processFacts
      .filter((candidate) =>
        candidate.processInstanceKey !== child.processInstanceKey
        && candidate.at < child.at
        && sameOsProcessGeneration(candidate, child))
      .sort((left, right) => right.at - left.at);
    const predecessor = predecessors[0];
    return predecessor
      ? { key: predecessor.processInstanceKey, pid: predecessor.pid }
      : undefined;
  }

  private descendantIndex(
    edges: ProcessLineageEdge[],
    bindings: SessionProcessBinding[],
  ): Map<string, Set<string>> {
    const children = new Map<string, Set<string>>();
    for (const edge of edges) {
      const values = children.get(edge.parentProcessInstanceKey) ?? new Set<string>();
      values.add(edge.childProcessInstanceKey);
      children.set(edge.parentProcessInstanceKey, values);
    }
    const result = new Map<string, Set<string>>();
    for (const binding of bindings) {
      const visited = new Set<string>();
      const queue = [binding.matchedOsProcessInstanceKey];
      while (queue.length > 0) {
        const parent = queue.shift() as string;
        for (const child of children.get(parent) ?? []) {
          if (visited.has(child)) continue;
          visited.add(child);
          queue.push(child);
        }
      }
      result.set(binding.bindingId, visited);
    }
    return result;
  }

  private result(
    fact: AttributableProcessEvent,
    status: EventSessionAttributionResult['status'],
    reason: EventSessionAttributionResult['reason'],
    candidates: string[],
    calculatedAt: number,
    binding?: SessionProcessBinding,
  ): EventSessionAttributionResult {
    return {
      schemaVersion: 'anysentry.event_session_attribution_result.v1',
      resultId: eventSessionResultId({
        eventId: fact.eventId,
        conversationId: binding?.conversationId,
        bindingRevision: binding?.bindingRevision,
      }),
      eventId: fact.eventId,
      ...(binding ? {
        conversationId: binding.conversationId,
        bindingId: binding.bindingId,
        bindingRevision: binding.bindingRevision,
      } : {}),
      processInstanceKey: fact.processInstanceKey,
      status,
      reason,
      candidateConversationIds: candidates,
      attributionAlgorithm: SESSION_EVENT_ATTRIBUTION_ALGORITHM,
      attributionVersion: SESSION_EVENT_ATTRIBUTION_VERSION,
      calculatedAt,
    };
  }

  private bindingView(binding: SessionProcessBinding): LocalSessionSystemEvidence['binding'] {
    return {
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      nativeSessionId: binding.nativeSessionId,
      ...(binding.runtimeProcessInstanceId
        ? { runtimeProcessInstanceId: binding.runtimeProcessInstanceId }
        : {}),
      matchedOsProcessInstanceKey: binding.matchedOsProcessInstanceKey,
      matchedPid: binding.matchedPid,
      ...(binding.launcherProcessInstanceKey
        ? { launcherProcessInstanceKey: binding.launcherProcessInstanceKey }
        : {}),
      ...(binding.launcherPid ? { launcherPid: binding.launcherPid } : {}),
      ...(binding.agentRootProcessInstanceKey
        ? { agentRootProcessInstanceKey: binding.agentRootProcessInstanceKey }
        : {}),
      ...(binding.agentInstanceId ? { agentInstanceId: binding.agentInstanceId } : {}),
      method: binding.method,
      confidence: binding.confidence,
    };
  }

  private emptyEvidence(
    binding: SessionProcessBinding,
    persistence: LocalSessionSystemEvidence['persistence'],
    completeness: LocalSessionSystemEvidence['completeness'],
    requestedLimit = DEFAULT_SESSION_EVENT_LIMIT,
  ): LocalSessionSystemEvidence {
    return {
      schemaVersion: 'anysentry.local-session-system-evidence.v1',
      conversationId: binding.conversationId,
      evidenceScope: 'current_generation',
      binding: this.bindingView(binding),
      persistence,
      completeness,
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
}
