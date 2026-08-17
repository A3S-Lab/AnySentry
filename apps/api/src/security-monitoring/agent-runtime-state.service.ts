import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  AgentActivityState,
  AgentAttributionSource,
  AgentClassification,
  AgentRuntimeAckReasonCode,
  AgentRuntimeInstanceRecord,
  AgentRuntimeLeaseAck,
  AgentRuntimeLeaseRequest,
  AgentRuntimeReportedState,
  AgentRuntimeSnapshotAck,
  AgentRuntimeSnapshotEntry,
  AgentRuntimeSnapshotRequest,
  AgentRuntimeState,
  AgentRuntimeStateList,
  AgentRuntimeStateQuery,
  AgentRuntimeStateSummary,
  AgentWorkloadRef,
} from './types';

const SNAPSHOT_SCHEMA = 'anysentry.agent_runtime_snapshot.v1';
const DEFAULT_MAX_FORWARDERS = 512;
const DEFAULT_MAX_INSTANCES = 20_000;
const DEFAULT_MAX_ENTRIES_PER_SNAPSHOT = 5_000;
const DEFAULT_TERMINAL_TTL_MS = 60 * 60_000;
const DEFAULT_UNOBSERVED_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_UNOBSERVED_MS = 90_000;
const DEFAULT_ACTIVITY_IDLE_MS = 5 * 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 30_000;
const DEFAULT_UNOBSERVED_INTERVALS = 3;
const DEFAULT_LEASE_TTL_MS = 90_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export const AGENT_RUNTIME_STATE_OPTIONS = 'ANYSENTRY_AGENT_RUNTIME_STATE_OPTIONS';

export interface AgentRuntimeStateServiceOptions {
  now?: () => number;
  maxForwarders?: number;
  maxRetiredForwarders?: number;
  maxInstances?: number;
  maxEntriesPerSnapshot?: number;
  terminalTtlMs?: number;
  unobservedTtlMs?: number;
  minUnobservedMs?: number;
  activityIdleMs?: number;
  pruneIntervalMs?: number;
  unobservedIntervals?: number;
  leaseTtlMs?: number;
}

interface SanitizedRuntimeEntry
  extends Omit<AgentRuntimeSnapshotEntry, 'discoveredAt' | 'lastSeenAt' | 'lastActivityAt' | 'endedAt'> {
  discoveredAt: number;
  lastSeenAt: number;
  lastActivityAt?: number;
  endedAt?: number;
}

interface SanitizedRuntimeSnapshot
  extends Omit<AgentRuntimeSnapshotRequest, 'generatedAt' | 'entries'> {
  generatedAt: number;
  filterMode: 'shadow' | 'enforce';
  entries: SanitizedRuntimeEntry[];
}

interface ForwarderRecord {
  key: string;
  collectorId: string;
  forwarderInstanceId: string;
  leaseEpoch: number;
  snapshotVersion: number;
  snapshotHash: string;
  generatedAt: number;
  firstReceivedAt: number;
  receivedAt: number;
  ready: boolean;
  intervalSecs: number;
  filterMode: 'shadow' | 'enforce';
  registryVersion?: number;
  registryHash?: string;
  registryMatcherHash?: string;
  supersededAt?: number;
  instanceKeys: Set<string>;
}

interface CollectorLeaseRecord {
  collectorId: string;
  forwarderInstanceId: string;
  hostId: string;
  bootId: string;
  forwarderPid: number;
  forwarderStartTimeTicks: string;
  leaseEpoch: number;
  issuedAt: number;
  lastSeenAt?: number;
}

type StoredRuntimeInstance = Omit<AgentRuntimeInstanceRecord, 'runtimeState' | 'activityState'> & {
  forwarderKey: string;
  reportedRuntimeState: AgentRuntimeReportedState;
  /** Activity age translated from the forwarder's clock at receipt time. */
  activityAgeAtReceivedMs?: number;
  /** Terminal transition translated to the API clock for stable retention across clock skew. */
  terminalAt?: number;
};

type ValidationResult =
  | { snapshot: SanitizedRuntimeSnapshot }
  | { reason: string };

interface TransitionValidationError {
  reasonCode: Extract<
    AgentRuntimeAckReasonCode,
    'identity_conflict' | 'generation_regression' | 'terminal_state_conflict'
  >;
  reason: string;
}

const ATTRIBUTION_SOURCES = new Set<AgentAttributionSource>([
  'none',
  'process_graph',
  'cgroup',
  'systemd',
  'argv',
  'env',
  'self_register',
  'workspace_hint',
  'kubernetes',
  'docker',
  'behavior',
  'process_signature',
  'manual_review',
]);

const CLASSIFICATIONS = new Set<AgentClassification>([
  'confirmed_agent',
  'probable_agent',
  'unknown',
  'non_agent',
]);

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function cleanString(value: unknown, limit: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !CONTROL_CHARACTERS.test(text) ? text.slice(0, limit) : undefined;
}

function requiredString(value: unknown, limit: number, name: string): { value?: string; reason?: string } {
  const cleaned = cleanString(value, limit);
  return cleaned ? { value: cleaned } : { reason: `${name} is required` };
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

function positiveTicks(value: unknown): { raw?: string; parsed?: bigint } {
  const raw = cleanString(value, 120);
  if (!raw || !/^[1-9][0-9]*$/u.test(raw)) return {};
  try {
    return { raw, parsed: BigInt(raw) };
  } catch {
    return {};
  }
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function cleanClassification(value: unknown): AgentClassification | undefined {
  return CLASSIFICATIONS.has(value as AgentClassification) ? value as AgentClassification : undefined;
}

function cleanAttributionSource(value: unknown): AgentAttributionSource | undefined {
  return ATTRIBUTION_SOURCES.has(value as AgentAttributionSource) ? value as AgentAttributionSource : undefined;
}

function cleanWorkloadRef(value: unknown): AgentWorkloadRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const environment = ['kubernetes', 'docker', 'host'].includes(String(input.environment ?? ''))
    ? input.environment as AgentWorkloadRef['environment']
    : undefined;
  const kind = ['pod', 'container', 'service', 'process', 'cgroup'].includes(String(input.kind ?? ''))
    ? input.kind as AgentWorkloadRef['kind']
    : undefined;
  const result: AgentWorkloadRef = {
    environment,
    kind,
    name: cleanString(input.name, 240),
    namespace: cleanString(input.namespace, 160),
    podName: cleanString(input.podName, 240),
    podUid: cleanString(input.podUid, 240),
    nodeName: cleanString(input.nodeName, 240),
    containerName: cleanString(input.containerName, 240),
    containerImage: cleanString(input.containerImage, 500),
    ownerKind: cleanString(input.ownerKind, 120),
    ownerName: cleanString(input.ownerName, 240),
    systemdUnit: cleanString(input.systemdUnit, 240),
    processName: cleanString(input.processName, 240),
    executable: cleanString(input.executable, 1_000),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function snapshotHash(snapshot: SanitizedRuntimeSnapshot): string {
  const canonical = {
    ...snapshot,
    entries: [...snapshot.entries].sort((left, right) =>
      left.agentInstanceId.localeCompare(right.agentInstanceId) ||
      (left.physicalWorkloadId ?? '').localeCompare(right.physicalWorkloadId ?? ''),
    ),
  };
  return createHash('sha256').update(JSON.stringify(stableValue(canonical))).digest('hex');
}

function cloneWorkloadRef(value?: AgentWorkloadRef): AgentWorkloadRef | undefined {
  return value ? { ...value } : undefined;
}

function forwarderKey(collectorId: string, forwarderInstanceId: string): string {
  return `${collectorId}\0${forwarderInstanceId}`;
}

function instanceKey(collectorId: string, agentInstanceId: string): string {
  return `${collectorId}\0${agentInstanceId}`;
}

@Injectable()
export class AgentRuntimeStateService implements OnModuleDestroy {
  private readonly clock: () => number;
  private readonly maxForwarders: number;
  private readonly maxRetiredForwarders: number;
  private readonly maxInstances: number;
  private readonly maxEntriesPerSnapshot: number;
  private readonly terminalTtlMs: number;
  private readonly unobservedTtlMs: number;
  private readonly minUnobservedMs: number;
  private readonly activityIdleMs: number;
  private readonly unobservedIntervals: number;
  private readonly leaseTtlMs: number;
  private readonly forwarders = new Map<string, ForwarderRecord>();
  /** Collector-scoped high-water marks outlive detail records and expire only after full inactivity. */
  private readonly collectorLeases = new Map<string, CollectorLeaseRecord>();
  private readonly activeForwarderByCollector = new Map<string, string>();
  /** Bounded fencing tombstones; a superseded forwarder ID cannot become authoritative again. */
  private readonly retiredForwarders = new Map<string, number>();
  private readonly instances = new Map<string, StoredRuntimeInstance>();
  private pruneTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    @Optional()
    @Inject(AGENT_RUNTIME_STATE_OPTIONS)
    options: AgentRuntimeStateServiceOptions = {},
  ) {
    this.clock = options.now ?? Date.now;
    this.maxForwarders = boundedInteger(options.maxForwarders, DEFAULT_MAX_FORWARDERS, 1, 100_000);
    this.maxRetiredForwarders = boundedInteger(
      options.maxRetiredForwarders,
      Math.max(64, this.maxForwarders * 4),
      1,
      1_000_000,
    );
    this.maxInstances = boundedInteger(options.maxInstances, DEFAULT_MAX_INSTANCES, 1, 1_000_000);
    this.maxEntriesPerSnapshot = Math.min(
      this.maxInstances,
      boundedInteger(options.maxEntriesPerSnapshot, DEFAULT_MAX_ENTRIES_PER_SNAPSHOT, 1, 100_000),
    );
    this.terminalTtlMs = boundedInteger(options.terminalTtlMs, DEFAULT_TERMINAL_TTL_MS, 1, 365 * 24 * 60 * 60_000);
    this.unobservedTtlMs = boundedInteger(options.unobservedTtlMs, DEFAULT_UNOBSERVED_TTL_MS, 1, 365 * 24 * 60 * 60_000);
    this.minUnobservedMs = boundedInteger(options.minUnobservedMs, DEFAULT_MIN_UNOBSERVED_MS, 1, 24 * 60 * 60_000);
    this.activityIdleMs = boundedInteger(options.activityIdleMs, DEFAULT_ACTIVITY_IDLE_MS, 1, 24 * 60 * 60_000);
    this.unobservedIntervals = boundedInteger(options.unobservedIntervals, DEFAULT_UNOBSERVED_INTERVALS, 1, 100);
    this.leaseTtlMs = boundedInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, 1_000, 24 * 60 * 60_000);
    const pruneIntervalMs = boundedInteger(options.pruneIntervalMs, DEFAULT_PRUNE_INTERVAL_MS, 0, 24 * 60 * 60_000);
    if (pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
      this.pruneTimer.unref();
    }
  }

  onModuleDestroy(): void {
    this.close();
  }

  close(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    this.closed = true;
  }

  issueLease(input: unknown, issuedAt = this.clock()): AgentRuntimeLeaseAck {
    const value = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const collectorId = cleanString(value.collectorId, 180);
    const forwarderInstanceId = cleanString(value.forwarderInstanceId, 180);
    const hostId = cleanString(value.hostId, 240);
    const bootId = cleanString(value.bootId, 240);
    const forwarderPid = integer(value.forwarderPid, 1, 4_194_304);
    const startTicks = positiveTicks(value.forwarderStartTimeTicks);
    const reject = (reasonCode: AgentRuntimeAckReasonCode, reason: string): AgentRuntimeLeaseAck => ({
      accepted: false,
      collectorId,
      forwarderInstanceId,
      issuedAt: iso(issuedAt),
      reasonCode,
      reason,
    });
    if (this.closed) return reject('service_unavailable', 'runtime state service is closed');
    if (!collectorId) return reject('validation_error', 'collectorId is required');
    if (!forwarderInstanceId) return reject('validation_error', 'forwarderInstanceId is required');
    if (!hostId) return reject('validation_error', 'hostId is required');
    if (!bootId) return reject('validation_error', 'bootId is required');
    if (forwarderPid === undefined) return reject('validation_error', 'forwarderPid must be a positive integer');
    if (!startTicks.raw || startTicks.parsed === undefined) {
      return reject('validation_error', 'forwarderStartTimeTicks must be a positive integer string');
    }

    const current = this.collectorLeases.get(collectorId);
    if (current?.forwarderInstanceId === forwarderInstanceId) {
      if (
        current.hostId !== hostId ||
        current.bootId !== bootId ||
        current.forwarderPid !== forwarderPid ||
        current.forwarderStartTimeTicks !== startTicks.raw
      ) return reject('stale_forwarder', 'forwarder instance identity conflict');
      return {
        accepted: true,
        collectorId,
        forwarderInstanceId,
        leaseEpoch: current.leaseEpoch,
        issuedAt: iso(current.issuedAt),
      };
    }
    const candidateKey = forwarderKey(collectorId, forwarderInstanceId);
    if (this.retiredForwarders.has(candidateKey)) {
      return reject('stale_forwarder', 'forwarder instance was retired');
    }
    if (current) {
      const currentFreshAt = current.lastSeenAt ?? current.issuedAt;
      const sameHostBoot = current.hostId === hostId && current.bootId === bootId;
      if (sameHostBoot) {
        const currentStart = positiveTicks(current.forwarderStartTimeTicks).parsed;
        if (currentStart === undefined || startTicks.parsed <= currentStart) {
          return reject('stale_forwarder', 'stale forwarder start time');
        }
      } else if (issuedAt - currentFreshAt <= this.leaseTtlMs) {
        return reject('collector_conflict', 'collector lease is active on another host or boot');
      }
    }
    if (!current && this.collectorLeases.size >= this.maxForwarders) this.prune(issuedAt);
    if (!current && this.collectorLeases.size >= this.maxForwarders) {
      return reject('capacity_exceeded', 'runtime collector lease capacity exceeded');
    }
    if (current?.leaseEpoch === Number.MAX_SAFE_INTEGER) {
      return reject('capacity_exceeded', 'runtime lease epoch exhausted');
    }

    const previousKey = current ? forwarderKey(collectorId, current.forwarderInstanceId) : undefined;
    if (previousKey) {
      this.retireForwarder(previousKey, issuedAt);
      this.forwarders.delete(previousKey);
    }
    const lease: CollectorLeaseRecord = {
      collectorId,
      forwarderInstanceId,
      hostId,
      bootId,
      forwarderPid,
      forwarderStartTimeTicks: startTicks.raw,
      leaseEpoch: (current?.leaseEpoch ?? 0) + 1,
      issuedAt,
    };
    this.collectorLeases.set(collectorId, lease);
    return {
      accepted: true,
      collectorId,
      forwarderInstanceId,
      leaseEpoch: lease.leaseEpoch,
      issuedAt: iso(issuedAt),
    };
  }

  rejectLease(
    input: unknown,
    reason: string,
    reasonCode: AgentRuntimeAckReasonCode = 'source_rejected',
    issuedAt = this.clock(),
  ): AgentRuntimeLeaseAck {
    const value = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    return {
      accepted: false,
      collectorId: cleanString(value.collectorId, 180),
      forwarderInstanceId: cleanString(value.forwarderInstanceId, 180),
      issuedAt: iso(issuedAt),
      reasonCode,
      reason,
    };
  }

  recordSnapshot(input: unknown, receivedAt = this.clock()): AgentRuntimeSnapshotAck {
    if (this.closed) {
      return this.rejectedAck(input, receivedAt, 'runtime state service is closed', 'service_unavailable');
    }
    const validation = this.sanitizeSnapshot(input);
    if ('reason' in validation) {
      return this.rejectedAck(input, receivedAt, validation.reason, 'validation_error');
    }

    const snapshot = validation.snapshot;
    const hash = snapshotHash(snapshot);
    const key = forwarderKey(snapshot.collectorId, snapshot.forwarderInstanceId);
    this.prune(receivedAt);
    const previous = this.forwarders.get(key);
    const lease = this.collectorLeases.get(snapshot.collectorId);

    if (!lease) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'runtime lease required', 'lease_not_found');
    }
    if (lease.forwarderInstanceId !== snapshot.forwarderInstanceId) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'runtime lease owner does not match', 'lease_owner_mismatch');
    }
    if (lease.leaseEpoch !== snapshot.leaseEpoch) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'runtime lease epoch is stale', 'lease_epoch_stale');
    }
    const foreignRoot = snapshot.entries.find(
      (entry) => entry.hostId !== lease.hostId || entry.bootId !== lease.bootId,
    );
    if (foreignRoot) {
      return this.ack(
        snapshot,
        hash,
        receivedAt,
        false,
        false,
        false,
        `runtime root host/boot does not match the collector lease: ${foreignRoot.agentInstanceId}`,
        'identity_conflict',
      );
    }
    if (this.retiredForwarders.has(key)) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'forwarder instance was superseded', 'stale_forwarder');
    }
    if (previous?.supersededAt !== undefined) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'forwarder instance was superseded', 'stale_forwarder');
    }
    if (previous && snapshot.snapshotVersion < previous.snapshotVersion) {
      return this.ack(snapshot, hash, receivedAt, true, false, false, 'stale snapshot version', 'snapshot_version_stale');
    }
    if (previous && snapshot.snapshotVersion === previous.snapshotVersion) {
      if (hash === previous.snapshotHash) {
        this.touchLease(lease, previous, receivedAt);
        return this.ack(snapshot, hash, receivedAt, true, false, true);
      }
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'snapshot version conflict', 'snapshot_version_conflict');
    }
    if (previous?.ready && !snapshot.ready) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'ready state cannot regress', 'ready_regression');
    }
    const transitionError = this.validateTransitions(snapshot);
    if (transitionError) {
      return this.ack(
        snapshot,
        hash,
        receivedAt,
        false,
        false,
        false,
        transitionError.reason,
        transitionError.reasonCode,
      );
    }

    const activeKey = this.activeForwarderByCollector.get(snapshot.collectorId);
    const active = activeKey ? this.forwarders.get(activeKey) : undefined;
    const takeover = Boolean(snapshot.ready && activeKey && activeKey !== key);

    const additionalInstances = snapshot.ready
      ? snapshot.entries.reduce(
          (count, entry) => count + Number(!this.instances.has(instanceKey(snapshot.collectorId, entry.agentInstanceId))),
          0,
        )
      : 0;
    if (this.instances.size + additionalInstances > this.maxInstances) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'runtime instance capacity exceeded', 'capacity_exceeded');
    }
    if (!previous && this.forwarders.size >= this.maxForwarders && !takeover) {
      return this.ack(snapshot, hash, receivedAt, false, false, false, 'runtime forwarder capacity exceeded', 'capacity_exceeded');
    }

    const nextForwarder: ForwarderRecord = {
      key,
      collectorId: snapshot.collectorId,
      forwarderInstanceId: snapshot.forwarderInstanceId,
      leaseEpoch: snapshot.leaseEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      snapshotHash: hash,
      generatedAt: snapshot.generatedAt,
      firstReceivedAt: previous?.firstReceivedAt ?? receivedAt,
      receivedAt,
      ready: snapshot.ready,
      intervalSecs: snapshot.intervalSecs,
      filterMode: snapshot.filterMode,
      registryVersion: snapshot.registryVersion,
      registryHash: snapshot.registryHash,
      registryMatcherHash: snapshot.registryMatcherHash,
      instanceKeys: new Set(previous?.instanceKeys ?? []),
    };

    this.forwarders.set(key, nextForwarder);
    this.touchLease(lease, nextForwarder, receivedAt);
    if (!snapshot.ready) {
      this.trimForwarders(receivedAt);
      return this.ack(snapshot, hash, receivedAt, true, false, false, 'awaiting ready snapshot', 'awaiting_ready');
    }

    const takeoverKeys = takeover
      ? new Set(
          [...this.instances.entries()]
            .filter(([, record]) => record.collectorId === snapshot.collectorId)
            .map(([instanceKeyValue]) => instanceKeyValue),
        )
      : undefined;
    if (active && active.key !== key) {
      active.supersededAt = receivedAt;
      this.retireForwarder(active.key, receivedAt);
    }
    this.activeForwarderByCollector.set(snapshot.collectorId, key);
    this.applyReadySnapshot(nextForwarder, snapshot, hash, receivedAt, takeoverKeys);
    if (active && active.key !== key) this.forwarders.delete(active.key);
    for (const candidate of [...this.forwarders.values()]) {
      if (candidate.collectorId !== snapshot.collectorId || candidate.key === key) continue;
      if (candidate.ready) {
        candidate.supersededAt ??= receivedAt;
        this.retireForwarder(candidate.key, receivedAt);
      }
      if (candidate.instanceKeys.size === 0) this.forwarders.delete(candidate.key);
    }
    this.prune(receivedAt);
    return this.ack(snapshot, hash, receivedAt, true, true, false);
  }

  /** Build a structured business rejection without mutating runtime state. */
  rejectSnapshot(
    input: unknown,
    reason: string,
    reasonCode: AgentRuntimeAckReasonCode = 'source_rejected',
    receivedAt = this.clock(),
  ): AgentRuntimeSnapshotAck {
    return this.rejectedAck(input, receivedAt, reason, reasonCode);
  }

  list(query: AgentRuntimeStateQuery = {}, at = this.clock()): AgentRuntimeStateList {
    this.prune(at);
    const input = query && typeof query === 'object' ? query : {};
    const collectorId = cleanString(input.collectorId, 180);
    const forwarderInstanceId = cleanString(input.forwarderInstanceId, 180);
    const agentScopeId = cleanString(input.agentScopeId, 240)?.toLowerCase();
    const agentInstanceId = cleanString(input.agentInstanceId, 500);
    const physicalWorkloadId = cleanString(input.physicalWorkloadId, 500);
    const runtimeState = input.runtimeState && input.runtimeState !== 'all' ? input.runtimeState : undefined;
    const activityState = input.activityState && input.activityState !== 'all' ? input.activityState : undefined;

    const all = [...this.instances.values()]
      .map((record) => this.publicRecord(record, at))
      .filter((record) =>
        (!collectorId || record.collectorId === collectorId) &&
        (!forwarderInstanceId || record.forwarderInstanceId === forwarderInstanceId) &&
        (!agentScopeId || record.agentScopeId.toLowerCase() === agentScopeId) &&
        (!agentInstanceId || record.agentInstanceId === agentInstanceId) &&
        (!physicalWorkloadId || record.physicalWorkloadId === physicalWorkloadId) &&
        (!runtimeState || record.runtimeState === runtimeState) &&
        (!activityState || record.activityState === activityState) &&
        (input.includeShadow !== false || record.filterMode !== 'shadow'),
      )
      .sort((left, right) =>
        this.stateRank(left.runtimeState) - this.stateRank(right.runtimeState) ||
        Number(right.activityState === 'active') - Number(left.activityState === 'active') ||
        right.receivedAt - left.receivedAt ||
        right.lastSeenAt - left.lastSeenAt ||
        left.agentInstanceId.localeCompare(right.agentInstanceId),
      );
    const summary = this.summary(all);
    const limit = boundedInteger(input.limit, this.maxInstances, 1, this.maxInstances);
    return {
      items: all.slice(0, limit),
      total: all.length,
      summary,
      updateTime: iso(at),
    };
  }

  get(agentInstanceId: string, collectorId?: string, at = this.clock()): AgentRuntimeInstanceRecord | undefined {
    const normalizedInstance = cleanString(agentInstanceId, 500);
    if (!normalizedInstance) return undefined;
    if (collectorId) {
      const normalizedCollector = cleanString(collectorId, 180);
      if (!normalizedCollector) return undefined;
      const record = this.instances.get(instanceKey(normalizedCollector, normalizedInstance));
      return record ? this.publicRecord(record, at) : undefined;
    }
    return this.list({ agentInstanceId: normalizedInstance, includeShadow: true, limit: this.maxInstances }, at).items[0];
  }

  metrics(at = this.clock()): {
    forwarders: number;
    retiredForwarders: number;
    activeForwarders: number;
    pendingForwarders: number;
    supersededForwarders: number;
    instances: number;
    summary: AgentRuntimeStateSummary;
  } {
    const state = this.list({ includeShadow: true, limit: this.maxInstances }, at);
    let pendingForwarders = 0;
    let supersededForwarders = 0;
    for (const forwarder of this.forwarders.values()) {
      if (forwarder.supersededAt !== undefined) supersededForwarders += 1;
      else if (!forwarder.ready) pendingForwarders += 1;
    }
    return {
      forwarders: this.forwarders.size,
      retiredForwarders: this.retiredForwarders.size,
      activeForwarders: this.activeForwarderByCollector.size,
      pendingForwarders,
      supersededForwarders,
      instances: this.instances.size,
      summary: state.summary,
    };
  }

  prune(at = this.clock()): void {
    for (const [key, record] of this.instances) {
      const runtimeState = this.effectiveRuntimeState(record, at);
      const terminalAt = record.terminalAt ?? record.receivedAt;
      if (
        ((runtimeState === 'exited' || runtimeState === 'lost') && at - terminalAt > this.terminalTtlMs) ||
        (runtimeState === 'unobserved' && at - record.receivedAt > this.unobservedTtlMs)
      ) {
        this.deleteInstance(key, record);
      }
    }
    this.trimForwarders(at);
    this.trimCollectorLeases(at);
  }

  private sanitizeSnapshot(input: unknown): ValidationResult {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { reason: 'snapshot body must be an object' };
    const value = input as Record<string, unknown>;
    if (value.schemaVersion !== SNAPSHOT_SCHEMA) return { reason: `schemaVersion must be ${SNAPSHOT_SCHEMA}` };

    const collector = requiredString(value.collectorId, 180, 'collectorId');
    if (collector.reason) return { reason: collector.reason };
    const forwarder = requiredString(value.forwarderInstanceId, 180, 'forwarderInstanceId');
    if (forwarder.reason) return { reason: forwarder.reason };
    const leaseEpoch = integer(value.leaseEpoch, 1, Number.MAX_SAFE_INTEGER);
    if (leaseEpoch === undefined) return { reason: 'leaseEpoch must be a positive safe integer' };
    const snapshotVersion = integer(value.snapshotVersion, 0, Number.MAX_SAFE_INTEGER);
    if (snapshotVersion === undefined) return { reason: 'snapshotVersion must be a non-negative safe integer' };
    const generatedAt = timestamp(value.generatedAt);
    if (generatedAt === undefined) return { reason: 'generatedAt must be a valid timestamp' };
    if (typeof value.ready !== 'boolean') return { reason: 'ready must be a boolean' };
    const intervalSecs = integer(value.intervalSecs, 1, 3_600);
    if (intervalSecs === undefined) return { reason: 'intervalSecs must be an integer between 1 and 3600' };
    if (!Array.isArray(value.entries)) return { reason: 'entries must be an array' };
    if (value.entries.length > this.maxEntriesPerSnapshot) {
      return { reason: `entries exceeds limit ${this.maxEntriesPerSnapshot}` };
    }

    if (value.filterMode !== undefined && value.filterMode !== 'shadow' && value.filterMode !== 'enforce') {
      return { reason: 'filterMode must be shadow or enforce' };
    }

    const entries: SanitizedRuntimeEntry[] = [];
    const seenInstances = new Set<string>();
    for (let index = 0; index < value.entries.length; index += 1) {
      const result = this.sanitizeEntry(value.entries[index], index);
      if ('reason' in result) return result;
      if (seenInstances.has(result.entry.agentInstanceId)) {
        return { reason: `entries[${index}].agentInstanceId is duplicated` };
      }
      seenInstances.add(result.entry.agentInstanceId);
      entries.push(result.entry);
    }

    const registryVersion = value.registryVersion === undefined
      ? undefined
      : integer(value.registryVersion, 0, Number.MAX_SAFE_INTEGER);
    if (value.registryVersion !== undefined && registryVersion === undefined) {
      return { reason: 'registryVersion must be a non-negative safe integer' };
    }
    const registryHash = cleanString(value.registryHash, 128);
    if (value.registryHash !== undefined && !registryHash) return { reason: 'registryHash must be a non-empty string' };
    if (registryHash && !SHA256_HEX.test(registryHash)) return { reason: 'registryHash must be a SHA-256 hex digest' };
    const registryMatcherHash = cleanString(value.registryMatcherHash, 128);
    if (value.registryMatcherHash !== undefined && !registryMatcherHash) {
      return { reason: 'registryMatcherHash must be a non-empty string' };
    }
    if (registryMatcherHash && !SHA256_HEX.test(registryMatcherHash)) {
      return { reason: 'registryMatcherHash must be a SHA-256 hex digest' };
    }

    return {
      snapshot: {
        schemaVersion: SNAPSHOT_SCHEMA,
        collectorId: collector.value!,
        forwarderInstanceId: forwarder.value!,
        leaseEpoch,
        snapshotVersion,
        generatedAt,
        ready: value.ready,
        intervalSecs,
        filterMode: value.filterMode === 'enforce' ? 'enforce' : 'shadow',
        registryVersion,
        registryHash,
        registryMatcherHash,
        entries,
      },
    };
  }

  private sanitizeEntry(
    input: unknown,
    index: number,
  ): { entry: SanitizedRuntimeEntry } | { reason: string } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { reason: `entries[${index}] must be an object` };
    const value = input as Record<string, unknown>;
    const prefix = `entries[${index}]`;
    const scope = requiredString(value.agentScopeId, 240, `${prefix}.agentScopeId`);
    if (scope.reason) return { reason: scope.reason };
    const instance = requiredString(value.agentInstanceId, 500, `${prefix}.agentInstanceId`);
    if (instance.reason) return { reason: instance.reason };
    const host = requiredString(value.hostId, 240, `${prefix}.hostId`);
    if (host.reason) return { reason: host.reason };
    const boot = requiredString(value.bootId, 240, `${prefix}.bootId`);
    if (boot.reason) return { reason: boot.reason };
    const rootStart = positiveTicks(value.rootStartTimeTicks);
    if (!rootStart.raw || rootStart.parsed === undefined) {
      return { reason: `${prefix}.rootStartTimeTicks must be a positive integer string` };
    }
    const rootPid = integer(value.rootPid, 1, 4_194_304);
    if (rootPid === undefined) return { reason: `${prefix}.rootPid must be a positive integer` };
    const rootGeneration = integer(value.rootGeneration, 0, Number.MAX_SAFE_INTEGER);
    if (rootGeneration === undefined) return { reason: `${prefix}.rootGeneration must be a non-negative safe integer` };
    const runtimeState = value.runtimeState as AgentRuntimeReportedState;
    if (!['running', 'exited', 'lost'].includes(runtimeState)) {
      return { reason: `${prefix}.runtimeState must be running, exited, or lost` };
    }
    const discoveredAt = timestamp(value.discoveredAt);
    const lastSeenAt = timestamp(value.lastSeenAt);
    const lastActivityAt = value.lastActivityAt === undefined ? undefined : timestamp(value.lastActivityAt);
    const suppliedEndedAt = value.endedAt === undefined ? undefined : timestamp(value.endedAt);
    if (discoveredAt === undefined) return { reason: `${prefix}.discoveredAt must be a valid timestamp` };
    if (lastSeenAt === undefined) return { reason: `${prefix}.lastSeenAt must be a valid timestamp` };
    if (value.lastActivityAt !== undefined && lastActivityAt === undefined) {
      return { reason: `${prefix}.lastActivityAt must be a valid timestamp` };
    }
    if (value.endedAt !== undefined && suppliedEndedAt === undefined) {
      return { reason: `${prefix}.endedAt must be a valid timestamp` };
    }
    if (runtimeState === 'running' && suppliedEndedAt !== undefined) {
      return { reason: `${prefix}.endedAt is not allowed while running` };
    }
    const endedAt = runtimeState === 'running' ? undefined : suppliedEndedAt ?? lastSeenAt;
    const exitCode = value.exitCode === undefined ? undefined : integer(value.exitCode, -1, 65_535);
    if (value.exitCode !== undefined && exitCode === undefined) return { reason: `${prefix}.exitCode must be an integer` };
    const signal = value.signal === undefined ? undefined : integer(value.signal, 0, 255);
    if (value.signal !== undefined && signal === undefined) return { reason: `${prefix}.signal must be an integer` };
    if (runtimeState === 'running' && (exitCode !== undefined || signal !== undefined)) {
      return { reason: `${prefix}.exitCode and signal are not allowed while running` };
    }
    const confidenceNumber = value.confidence;
    const confidence = value.confidence === undefined
      ? undefined
      : typeof confidenceNumber === 'number' && Number.isFinite(confidenceNumber) && confidenceNumber >= 0 && confidenceNumber <= 1
        ? confidenceNumber
        : undefined;
    if (value.confidence !== undefined && confidence === undefined) {
      return { reason: `${prefix}.confidence must be a number between 0 and 1` };
    }
    const classification = cleanClassification(value.classification);
    if (value.classification !== undefined && classification === undefined) {
      return { reason: `${prefix}.classification is invalid` };
    }
    const source = cleanAttributionSource(value.source);
    if (value.source !== undefined && source === undefined) return { reason: `${prefix}.source is invalid` };
    if (value.evidence !== undefined && !Array.isArray(value.evidence)) return { reason: `${prefix}.evidence must be an array` };
    if (Array.isArray(value.evidence) && value.evidence.some((item) => typeof item !== 'string')) {
      return { reason: `${prefix}.evidence entries must be strings` };
    }
    const evidence = Array.isArray(value.evidence)
      ? [...new Set(value.evidence.map((item) => cleanString(item, 240)).filter((item): item is string => Boolean(item)))].slice(0, 16)
      : undefined;
    if (value.workloadRef !== undefined && (!value.workloadRef || typeof value.workloadRef !== 'object' || Array.isArray(value.workloadRef))) {
      return { reason: `${prefix}.workloadRef must be an object` };
    }

    return {
      entry: {
        agentScopeId: scope.value!,
        agentDisplayName: cleanString(value.agentDisplayName, 240),
        agentInstanceId: instance.value!,
        physicalWorkloadId: cleanString(value.physicalWorkloadId, 500),
        classification,
        runtimeState,
        rootPid,
        rootStartTimeTicks: rootStart.raw,
        rootGeneration,
        hostId: host.value!,
        bootId: boot.value!,
        comm: cleanString(value.comm, 64),
        exe: cleanString(value.exe, 1_000),
        workspacePath: cleanString(value.workspacePath, 1_000),
        discoveredAt,
        lastSeenAt,
        lastActivityAt,
        endedAt,
        exitCode,
        signal,
        confidence,
        source,
        evidence,
        workloadRef: cleanWorkloadRef(value.workloadRef),
      },
    };
  }

  private validateTransitions(snapshot: SanitizedRuntimeSnapshot): TransitionValidationError | undefined {
    const ownerKey = forwarderKey(snapshot.collectorId, snapshot.forwarderInstanceId);
    for (const entry of snapshot.entries) {
      const existing = this.instances.get(instanceKey(snapshot.collectorId, entry.agentInstanceId));
      if (!existing) continue;
      if (
        existing.rootPid !== entry.rootPid ||
        existing.rootStartTimeTicks !== entry.rootStartTimeTicks ||
        existing.hostId !== entry.hostId ||
        existing.bootId !== entry.bootId
      ) {
        return {
          reasonCode: 'identity_conflict',
          reason: `agentInstanceId identity conflict: ${entry.agentInstanceId}`,
        };
      }
      if (existing.reportedRuntimeState === 'exited' && entry.runtimeState !== 'exited') {
        return {
          reasonCode: 'terminal_state_conflict',
          reason: `exited instance is terminal: ${entry.agentInstanceId}`,
        };
      }
      if (existing.forwarderKey === ownerKey && entry.rootGeneration < existing.rootGeneration) {
        return {
          reasonCode: 'generation_regression',
          reason: `rootGeneration cannot regress: ${entry.agentInstanceId}`,
        };
      }
      if (
        existing.forwarderKey === ownerKey &&
        existing.reportedRuntimeState !== entry.runtimeState &&
        entry.rootGeneration <= existing.rootGeneration
      ) {
        return {
          reasonCode: 'generation_regression',
          reason: `rootGeneration must advance with a lifecycle transition: ${entry.agentInstanceId}`,
        };
      }
    }
    return undefined;
  }

  private applyReadySnapshot(
    forwarder: ForwarderRecord,
    snapshot: SanitizedRuntimeSnapshot,
    hash: string,
    receivedAt: number,
    takeoverKeys?: Set<string>,
  ): void {
    const previousKeys = new Set([...forwarder.instanceKeys, ...(takeoverKeys ?? [])]);
    for (const entry of snapshot.entries) {
      const key = instanceKey(snapshot.collectorId, entry.agentInstanceId);
      previousKeys.delete(key);
      const previousOwner = this.instances.get(key)?.forwarderKey;
      const previous = this.instances.get(key);
      if (previousOwner && previousOwner !== forwarder.key) {
        this.forwarders.get(previousOwner)?.instanceKeys.delete(key);
      }
      const activityAgeAtReceivedMs = entry.lastActivityAt === undefined
        ? undefined
        : Math.max(0, snapshot.generatedAt - entry.lastActivityAt);
      const terminalAt = entry.runtimeState === 'running'
        ? undefined
        : previous?.terminalAt ?? Math.max(0, receivedAt - Math.max(0, snapshot.generatedAt - (entry.endedAt ?? entry.lastSeenAt)));
      const record: StoredRuntimeInstance = {
        collectorId: snapshot.collectorId,
        forwarderInstanceId: snapshot.forwarderInstanceId,
        leaseEpoch: snapshot.leaseEpoch,
        snapshotVersion: snapshot.snapshotVersion,
        snapshotHash: hash,
        filterMode: snapshot.filterMode,
        registryVersion: snapshot.registryVersion,
        registryHash: snapshot.registryHash,
        registryMatcherHash: snapshot.registryMatcherHash,
        agentScopeId: entry.agentScopeId,
        agentDisplayName: entry.agentDisplayName,
        agentInstanceId: entry.agentInstanceId,
        physicalWorkloadId: entry.physicalWorkloadId,
        classification: entry.classification,
        rootPid: entry.rootPid,
        rootStartTimeTicks: entry.rootStartTimeTicks,
        rootGeneration: entry.rootGeneration,
        hostId: entry.hostId,
        bootId: entry.bootId,
        comm: entry.comm,
        exe: entry.exe,
        workspacePath: entry.workspacePath,
        discoveredAt: previous ? Math.min(previous.discoveredAt, entry.discoveredAt) : entry.discoveredAt,
        lastSeenAt: entry.lastSeenAt,
        lastActivityAt: entry.lastActivityAt,
        endedAt: entry.endedAt,
        exitCode: entry.exitCode,
        signal: entry.signal,
        confidence: entry.confidence,
        source: entry.source,
        evidence: entry.evidence ? [...entry.evidence] : undefined,
        workloadRef: cloneWorkloadRef(entry.workloadRef),
        receivedAt,
        forwarderKey: forwarder.key,
        reportedRuntimeState: entry.runtimeState,
        activityAgeAtReceivedMs,
        terminalAt,
      };
      this.instances.set(key, record);
      forwarder.instanceKeys.add(key);
    }

    // A ready snapshot is a complete view. If an earlier running root disappears without an
    // explicit terminal record, retain the identity as `lost` rather than incorrectly leaving it
    // running forever. Existing terminal records remain until their bounded retention expires.
    for (const key of previousKeys) {
      const record = this.instances.get(key);
      if (!record) continue;
      this.forwarders.get(record.forwarderKey)?.instanceKeys.delete(key);
      forwarder.instanceKeys.add(key);
      if (record.reportedRuntimeState === 'running') {
        this.instances.set(key, {
          ...record,
          forwarderKey: forwarder.key,
          forwarderInstanceId: snapshot.forwarderInstanceId,
          leaseEpoch: snapshot.leaseEpoch,
          snapshotVersion: snapshot.snapshotVersion,
          snapshotHash: hash,
          filterMode: snapshot.filterMode,
          registryVersion: snapshot.registryVersion,
          registryHash: snapshot.registryHash,
          registryMatcherHash: snapshot.registryMatcherHash,
          reportedRuntimeState: 'lost',
          endedAt: receivedAt,
          receivedAt,
          terminalAt: receivedAt,
        });
      } else if (record.forwarderKey !== forwarder.key) {
        // Retain the original public reporter metadata while transferring internal ownership.
        this.instances.set(key, { ...record, forwarderKey: forwarder.key });
      }
    }
  }

  private effectiveRuntimeState(record: StoredRuntimeInstance, at: number): AgentRuntimeState {
    if (record.reportedRuntimeState !== 'running') return record.reportedRuntimeState;
    const lease = this.collectorLeases.get(record.collectorId);
    if (
      !lease ||
      lease.forwarderInstanceId !== record.forwarderInstanceId ||
      lease.leaseEpoch !== record.leaseEpoch
    ) return 'unobserved';
    const forwarder = this.forwarders.get(record.forwarderKey);
    if (!forwarder || forwarder.supersededAt !== undefined || !forwarder.ready) return 'unobserved';
    const timeout = Math.max(this.minUnobservedMs, forwarder.intervalSecs * 1_000 * this.unobservedIntervals);
    return at - forwarder.receivedAt > timeout ? 'unobserved' : 'running';
  }

  private publicRecord(record: StoredRuntimeInstance, at: number): AgentRuntimeInstanceRecord {
    const runtimeState = this.effectiveRuntimeState(record, at);
    const activityState: AgentActivityState | undefined = runtimeState === 'running'
      ? record.activityAgeAtReceivedMs !== undefined && record.activityAgeAtReceivedMs + Math.max(0, at - record.receivedAt) <= this.activityIdleMs
        ? 'active'
        : 'idle'
      : undefined;
    const {
      forwarderKey: _forwarderKey,
      reportedRuntimeState: _reportedRuntimeState,
      activityAgeAtReceivedMs: _activityAgeAtReceivedMs,
      terminalAt: _terminalAt,
      ...rest
    } = record;
    return {
      ...rest,
      evidence: rest.evidence ? [...rest.evidence] : undefined,
      workloadRef: cloneWorkloadRef(rest.workloadRef),
      runtimeState,
      activityState,
    };
  }

  private touchLease(lease: CollectorLeaseRecord, forwarder: ForwarderRecord, at: number): void {
    lease.lastSeenAt = Math.max(lease.lastSeenAt ?? lease.issuedAt, at);
    forwarder.receivedAt = Math.max(forwarder.receivedAt, at);
  }

  private summary(items: AgentRuntimeInstanceRecord[]): AgentRuntimeStateSummary {
    return {
      totalInstances: items.length,
      runningInstances: items.filter((item) => item.runtimeState === 'running').length,
      activeInstances: items.filter((item) => item.runtimeState === 'running' && item.activityState === 'active').length,
      idleInstances: items.filter((item) => item.runtimeState === 'running' && item.activityState === 'idle').length,
      exitedInstances: items.filter((item) => item.runtimeState === 'exited').length,
      lostInstances: items.filter((item) => item.runtimeState === 'lost').length,
      unobservedInstances: items.filter((item) => item.runtimeState === 'unobserved').length,
      shadowInstances: items.filter((item) => item.filterMode === 'shadow').length,
    };
  }

  private stateRank(state: AgentRuntimeState): number {
    if (state === 'running') return 0;
    if (state === 'lost') return 1;
    if (state === 'unobserved') return 2;
    return 3;
  }

  private deleteInstance(key: string, record = this.instances.get(key)): void {
    if (!record) return;
    this.instances.delete(key);
    this.forwarders.get(record.forwarderKey)?.instanceKeys.delete(key);
  }

  private retireForwarder(key: string, at: number): void {
    if (this.retiredForwarders.has(key)) this.retiredForwarders.delete(key);
    while (this.retiredForwarders.size >= this.maxRetiredForwarders) {
      const oldest = this.retiredForwarders.keys().next().value as string | undefined;
      if (!oldest) break;
      this.retiredForwarders.delete(oldest);
    }
    this.retiredForwarders.set(key, at);
  }

  private trimForwarders(at: number): void {
    for (const [key, forwarder] of this.forwarders) {
      if (forwarder.instanceKeys.size > 0) continue;
      if (at - forwarder.receivedAt <= this.unobservedTtlMs) continue;
      if (forwarder.ready) this.retireForwarder(key, at);
      this.forwarders.delete(key);
      if (this.activeForwarderByCollector.get(forwarder.collectorId) === key) {
        this.activeForwarderByCollector.delete(forwarder.collectorId);
      }
    }
  }

  private trimCollectorLeases(at: number): void {
    for (const [collectorId, lease] of this.collectorLeases) {
      const lastSeenAt = lease.lastSeenAt ?? lease.issuedAt;
      if (at - lastSeenAt <= this.unobservedTtlMs) continue;
      const hasInstance = [...this.instances.values()].some((record) => record.collectorId === collectorId);
      if (hasInstance) continue;
      const hasForwarder = [...this.forwarders.values()].some((forwarder) => forwarder.collectorId === collectorId);
      if (hasForwarder) continue;
      this.collectorLeases.delete(collectorId);
      this.activeForwarderByCollector.delete(collectorId);
    }
  }

  private rejectedAck(
    input: unknown,
    receivedAt: number,
    reason: string,
    reasonCode: AgentRuntimeAckReasonCode,
  ): AgentRuntimeSnapshotAck {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    return {
      accepted: false,
      applied: false,
      duplicate: false,
      collectorId: cleanString(value.collectorId, 180),
      forwarderInstanceId: cleanString(value.forwarderInstanceId, 180),
      leaseEpoch: integer(value.leaseEpoch, 1, Number.MAX_SAFE_INTEGER),
      snapshotVersion: integer(value.snapshotVersion, 0, Number.MAX_SAFE_INTEGER),
      ready: false,
      instanceCount: 0,
      receivedAt: iso(receivedAt),
      reasonCode,
      reason,
    };
  }

  private ack(
    snapshot: SanitizedRuntimeSnapshot,
    hash: string,
    receivedAt: number,
    accepted: boolean,
    applied: boolean,
    duplicate: boolean,
    reason?: string,
    reasonCode?: AgentRuntimeAckReasonCode,
  ): AgentRuntimeSnapshotAck {
    return {
      accepted,
      applied,
      duplicate,
      collectorId: snapshot.collectorId,
      forwarderInstanceId: snapshot.forwarderInstanceId,
      leaseEpoch: snapshot.leaseEpoch,
      snapshotVersion: snapshot.snapshotVersion,
      snapshotHash: hash,
      ready: snapshot.ready,
      instanceCount: snapshot.entries.length,
      receivedAt: iso(receivedAt),
      reasonCode,
      reason,
    };
  }
}
