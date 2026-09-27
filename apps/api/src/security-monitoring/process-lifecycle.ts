import { createHash } from 'node:crypto';
import { parseTrustedCorrelation } from './trusted-correlation';
import type {
  AgentAttribution,
  EventSource,
  ProcessContext,
  ProcessGenerationLinkAuthority,
} from './types';

export const PROCESS_LIFECYCLE_FACT_SCHEMA = 'anysentry.process_lifecycle_fact.v1' as const;

export interface ProcessLifecycleFactInput {
  eventId: string;
  sourceEventId?: string;
  eventKind: string;
  at: number;
  receivedAt?: number;
  source: EventSource;
  sourceId?: string;
  collectorId?: string;
  workspacePath: string;
  subjectAssetId?: string;
  subjectAssetType?: 'agent' | 'service' | 'infrastructure' | 'workload' | 'ephemeral_process';
  assetBindingQuality?: 'exact' | 'logical' | 'ephemeral' | 'weak' | 'conflict' | 'unassigned';
  assetBindingRevision?: number;
  assetBindingReason?: string;
  identityRevision?: number;
  runtimeInstanceId?: string;
  rootProcess?: boolean;
  process?: ProcessContext;
  attribution?: AgentAttribution;
  attributes?: Record<string, unknown>;
}

export interface ProcessLifecycleFact {
  schemaVersion: typeof PROCESS_LIFECYCLE_FACT_SCHEMA;
  factId: string;
  eventId: string;
  sourceEventId?: string;
  factKind: 'exec' | 'exit';
  at: number;
  receivedAt: number;
  source: EventSource;
  sourceId?: string;
  collectorId?: string;
  workspacePath: string;
  subjectAssetId?: string;
  subjectAssetType?: ProcessLifecycleFactInput['subjectAssetType'];
  assetBindingQuality?: ProcessLifecycleFactInput['assetBindingQuality'];
  assetBindingRevision?: number;
  assetBindingReason?: string;
  identityRevision?: number;
  runtimeInstanceId?: string;
  rootProcess?: boolean;
  processInstanceKey: string;
  processGenerationKey?: string;
  parentProcessGenerationKey?: string;
  parentLinkAuthority?: ProcessGenerationLinkAuthority;
  physicalWorkloadId?: string;
  hostId?: string;
  bootId: string;
  pid: number;
  ppid?: number;
  pidNamespace?: string;
  namespacePid?: number;
  namespacePpid?: number;
  startTime: string;
  lifecycleSource?: ProcessContext['lifecycleSource'];
  exitStatus?: number;
  exitSignal?: number;
  executableHash?: string;
  commandHash?: string;
}

function text(value: unknown, limit = 1_024): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function unsigned32(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff ? parsed : undefined;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function trustedStart(process: ProcessContext): string | undefined {
  const ticks = text(process.startTimeTicks, 160);
  if (ticks && /^[1-9][0-9]*$/u.test(ticks)) return `ticks:${ticks}`;
  const ns = text(process.startTimeNs, 160);
  if (ns && /^[1-9][0-9]*$/u.test(ns)) return `ns:${ns}`;
  return undefined;
}

function trustedProcessGenerationKey(value: unknown): string | undefined {
  const key = text(value, 64);
  return key && /^pgk_[a-f0-9]{24}$/u.test(key) ? key : undefined;
}

export interface CanonicalProcessLifecycleIdentity {
  processInstanceKey: string;
  bootId: string;
  pid: number;
  startTime: string;
  hostId?: string;
  pidNamespace?: string;
  namespacePid?: number;
}

/**
 * One exact Process-generation identity shared by correlation, lifecycle facts, Asset binding,
 * and cold hydration. A validated trusted-correlation key wins; otherwise every consumer hashes
 * the same namespace-aware tuple byte-for-byte.
 */
export function canonicalProcessLifecycleIdentity(
  process: ProcessContext | undefined,
  attribution?: AgentAttribution,
): CanonicalProcessLifecycleIdentity | undefined {
  if (!process) return undefined;
  const bootId = text(process.bootId, 512);
  const pid = positiveInteger(process.pid);
  const startTime = trustedStart(process);
  const hostId = text(process.hostId, 512);
  const pidNamespace = text(process.pidNamespace, 512);
  const namespacePid = positiveInteger(process.namespacePid);
  if (!bootId || !pid || !startTime || (!hostId && !(pidNamespace && namespacePid))) return undefined;
  const suppliedProcessId = parseTrustedCorrelation(attribution?.correlation)?.processInstanceId;
  return {
    processInstanceKey: suppliedProcessId ?? `pri_${sha256([
      bootId,
      hostId ?? '',
      pidNamespace ?? '',
      namespacePid ?? 0,
      pid,
      startTime,
    ]).slice(0, 24)}`,
    bootId,
    pid,
    startTime,
    ...(hostId ? { hostId } : {}),
    ...(pidNamespace ? { pidNamespace } : {}),
    ...(namespacePid ? { namespacePid } : {}),
  };
}

/** Build a compact, non-sensitive lifecycle fact from an exact Process generation. */
export function processLifecycleFact(input: ProcessLifecycleFactInput): ProcessLifecycleFact | undefined {
  const factKind = input.eventKind === 'ToolExec'
    ? 'exec'
    : input.eventKind === 'ProcessExit'
      ? 'exit'
      : undefined;
  if (!factKind || !input.process) return undefined;
  const identity = canonicalProcessLifecycleIdentity(input.process, input.attribution);
  if (!identity) return undefined;
  const { bootId, pid, startTime, hostId, pidNamespace, namespacePid, processInstanceKey } = identity;
  const receivedAt = Number.isFinite(input.receivedAt) ? Number(input.receivedAt) : Date.now();
  const executable = text(input.process.exe, 4_096);
  const commandHash = text(input.attributes?.['anysentry.kernel.command_hash'], 128);
  const physicalWorkloadId = text(input.attribution?.physicalWorkloadId, 1_024);
  const correlation = parseTrustedCorrelation(input.attribution?.correlation);
  const graphAuthority = correlation && !correlation.inferred && (
    correlation.authority === 'attested_observer' || correlation.authority === 'server_process_graph'
  );
  const processGenerationKey = graphAuthority
    ? trustedProcessGenerationKey(input.attribution?.processGenerationKey)
    : undefined;
  const parentLinkAuthority = graphAuthority &&
    input.attribution?.parentLinkAuthority === 'forwarder_process_graph'
    ? input.attribution.parentLinkAuthority
    : undefined;
  const parentProcessGenerationKey = parentLinkAuthority
    ? trustedProcessGenerationKey(input.attribution?.parentProcessGenerationKey)
    : undefined;
  const exitStatus = factKind === 'exit'
    ? unsigned32(
        input.attributes?.exit_code
        ?? input.attributes?.exitCode
        ?? input.attributes?.status,
      )
    : undefined;
  const exitSignal = factKind === 'exit' ? unsigned32(input.attributes?.signal) : undefined;
  return {
    schemaVersion: PROCESS_LIFECYCLE_FACT_SCHEMA,
    factId: `plf_${sha256([input.eventId, factKind, processInstanceKey]).slice(0, 24)}`,
    eventId: input.eventId,
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    factKind,
    at: input.at,
    receivedAt,
    source: input.source,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.collectorId ? { collectorId: input.collectorId } : {}),
    workspacePath: input.workspacePath,
    ...(input.subjectAssetId ? { subjectAssetId: input.subjectAssetId } : {}),
    ...(input.subjectAssetType ? { subjectAssetType: input.subjectAssetType } : {}),
    ...(input.assetBindingQuality ? { assetBindingQuality: input.assetBindingQuality } : {}),
    ...(input.assetBindingRevision !== undefined ? { assetBindingRevision: input.assetBindingRevision } : {}),
    ...(input.assetBindingReason ? { assetBindingReason: input.assetBindingReason } : {}),
    ...(input.identityRevision !== undefined ? { identityRevision: input.identityRevision } : {}),
    ...(input.attribution?.agentInstanceId ? { runtimeInstanceId: input.attribution.agentInstanceId } : {}),
    ...(input.attribution?.rootPid !== undefined
      ? { rootProcess: input.attribution.rootPid === input.process.pid }
      : {}),
    processInstanceKey,
    ...(processGenerationKey ? { processGenerationKey } : {}),
    ...(parentProcessGenerationKey ? { parentProcessGenerationKey } : {}),
    ...(parentProcessGenerationKey && parentLinkAuthority ? { parentLinkAuthority } : {}),
    ...(physicalWorkloadId ? { physicalWorkloadId } : {}),
    ...(hostId ? { hostId } : {}),
    bootId,
    pid,
    ...(positiveInteger(input.process.ppid) ? { ppid: input.process.ppid } : {}),
    ...(pidNamespace ? { pidNamespace } : {}),
    ...(namespacePid ? { namespacePid } : {}),
    ...(positiveInteger(input.process.namespacePpid) ? { namespacePpid: input.process.namespacePpid } : {}),
    startTime,
    ...(input.process.lifecycleSource ? { lifecycleSource: input.process.lifecycleSource } : {}),
    ...(exitStatus !== undefined ? { exitStatus } : {}),
    ...(exitSignal !== undefined ? { exitSignal } : {}),
    ...(executable ? { executableHash: sha256(executable) } : {}),
    ...(commandHash && /^[a-f0-9]{64}$/u.test(commandHash) ? { commandHash } : {}),
  };
}
