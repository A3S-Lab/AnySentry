import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentClassification, JudgedEvent, UnknownReason } from './types';

export const UNKNOWN_CLUSTER_SCHEMA_VERSION = 'anysentry.unknown_cluster.v1' as const;
export const UNKNOWN_POLICY_SCHEMA_VERSION = 'anysentry.unknown_policy_candidate.v1' as const;

export type UnknownClusterReview = 'unreviewed' | 'agent' | 'non_agent' | 'deferred';
export type UnknownPolicyStage =
  | 'candidate'
  | 'shadow'
  | 'replay_validated'
  | 'canary'
  | 'enforced'
  | 'rolled_back';
/** Deliberately excludes drop. Unknown learning only makes non-authoritative recommendations. */
export type UnknownLearnedAction = 'keep' | 'sample' | 'aggregate';
export type UnknownCanaryScopeKind = 'node' | 'physical_workload';

export interface UnknownClusterSample {
  eventId: string;
  at: number;
  subject: string;
  process?: {
    pid?: number;
    comm?: string;
    exe?: string;
  };
  targetBucket: string;
}

export interface UnknownMetadataCompleteness {
  processIdentity: boolean;
  processAncestry: boolean;
  workloadIdentity: boolean;
  containerIdentity: boolean;
}

export interface UnknownCluster {
  schemaVersion: typeof UNKNOWN_CLUSTER_SCHEMA_VERSION;
  /** Stable across windows for the same scope/reason/kind/target family. */
  familyId: string;
  /** Stable for one family and one fixed UTC-aligned window. */
  clusterId: string;
  stableScope: string;
  unknownReason: UnknownReason;
  eventKind: string;
  targetBucket: string;
  windowStartMs: number;
  windowEndMs: number;
  /** Exact for retained, server-judged Unknown events; pre-ring suppressed totals stay in S5 accounting. */
  countScope: 'retained_events';
  exactCount: number;
  firstSamples: UnknownClusterSample[];
  reservoirSamples: UnknownClusterSample[];
  metadataCompleteness: UnknownMetadataCompleteness;
  review: UnknownClusterReview;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface UnknownClusterBuildResult {
  schemaVersion: typeof UNKNOWN_CLUSTER_SCHEMA_VERSION;
  clusters: UnknownCluster[];
  observedUnknownEvents: number;
  clusteredEvents: number;
  rejectedWithoutReason: number;
  rejectedWithoutStableScope: number;
  rejectedInvalidEvent: number;
  rejectedUnsafeIdentity: number;
  overflowEvents: number;
  truncated: boolean;
}

export interface UnknownPolicyCandidate {
  schemaVersion: typeof UNKNOWN_POLICY_SCHEMA_VERSION;
  policyId: string;
  revision: number;
  familyId: string;
  /** Anchor cluster retained for audit; policy matching is family-based, not window-based. */
  clusterId: string;
  stage: UnknownPolicyStage;
  desiredAction: UnknownLearnedAction;
  authority: 'recommendation_only';
  authoritativeDrop: false;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  evidence: {
    reviewRevision: number;
    /** Counts are exact only for retained, server-judged Unknown events. */
    countScope: 'retained_events';
    clusterCount: number;
    historicalWindows: number;
    replayEvents?: number;
    replayAgentConflicts?: number;
    canaryScope?: {
      kind: UnknownCanaryScopeKind;
      valueHash: string;
    };
    canaryEvents?: number;
    canaryAgentRecall?: number;
    canaryCriticalDrops?: number;
  };
  audit: Array<{
    at: number;
    from?: UnknownPolicyStage;
    to: UnknownPolicyStage;
    actor: string;
    reason: string;
  }>;
}

export interface UnknownPolicyTransition {
  to: UnknownPolicyStage;
  actor: string;
  reason: string;
  at?: number;
  replayEvents?: number;
  replayAgentConflicts?: number;
  canaryScope?: {
    kind: UnknownCanaryScopeKind;
    value: string;
  };
  canaryEvents?: number;
  canaryAgentRecall?: number;
  canaryCriticalDrops?: number;
}

const REASONS = new Set<UnknownReason>([
  'snapshot_not_ready',
  'snapshot_miss',
  'container_identity_missing',
  'container_name_missing',
  'parent_missing',
  'process_exited_before_enrichment',
  'ancestry_incomplete',
  'pid_reuse_ambiguous',
  'signature_miss',
  'template_conflict',
  'policy_expired',
  'shared_scope_ambiguous',
  'unsupported_agent_adapter',
]);
const POLICY_STAGES = new Set<UnknownPolicyStage>([
  'candidate',
  'shadow',
  'replay_validated',
  'canary',
  'enforced',
  'rolled_back',
]);
const CLUSTER_REVIEWS = new Set<UnknownClusterReview>(['unreviewed', 'agent', 'non_agent', 'deferred']);
const LEARNED_ACTIONS = new Set<UnknownLearnedAction>(['keep', 'sample', 'aggregate']);
const AGENT_CLASSIFICATIONS = new Set<AgentClassification>(['confirmed_agent', 'probable_agent']);
const CANONICAL_EVENT_KINDS = new Set([
  'Exec', 'ToolExec', 'Exit', 'FileAccess', 'FileDelete', 'Egress', 'Dns', 'Tls', 'LlmCall',
  'SslContent', 'SecurityAction', 'Other',
]);
/** Operational summaries/context belong to their own bounded data planes, never to Unknown learning. */
const NON_LEARNABLE_EVENT_KINDS = new Set(['captureaggregate', 'systemcontext']);
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_CLUSTERS = 10_000;
const DEFAULT_FIRST_SAMPLES = 3;
const DEFAULT_RESERVOIR_SAMPLES = 8;
const DEFAULT_MAX_EVENTS = 100_000;
const TARGET_SHARDS = 256;
const NEXT_STAGE: Record<Exclude<UnknownPolicyStage, 'rolled_back'>, UnknownPolicyStage | undefined> = {
  candidate: 'shadow', shadow: 'replay_validated', replay_validated: 'canary', canary: 'enforced', enforced: undefined,
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= limit ? normalized : undefined;
}

function boundedLabel(value: unknown, limit: number, label: string): string {
  const normalized = text(value, limit);
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`a bounded ${label} is required`);
  }
  return normalized;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function attrText(event: JudgedEvent, ...keys: string[]): string | undefined {
  if (!event.attributes || typeof event.attributes !== 'object') return undefined;
  for (const key of keys) {
    const value = text(event.attributes[key], 4_096);
    if (value) return value;
  }
  return undefined;
}

function unknownReason(event: JudgedEvent): UnknownReason | undefined {
  const reason = event.classificationSemantics?.unknownReason ?? event.process?.lifecycleReason;
  return reason && REASONS.has(reason) ? reason : undefined;
}

function unknownIdentityState(event: JudgedEvent): 'unknown' | 'not_unknown' | 'unsafe_conflict' {
  const semantic = event.classificationSemantics?.identityClassification;
  const attributed = event.attribution?.classification;
  const labels = [semantic, attributed].filter((value): value is AgentClassification => Boolean(value));
  const hasAgent = labels.some((value) => AGENT_CLASSIFICATIONS.has(value));
  const hasUnknown = labels.includes('unknown') ||
    (!event.attribution?.monitored && event.attribution?.reason === 'not_evaluated');
  if (hasAgent && hasUnknown) return 'unsafe_conflict';
  if (hasAgent || labels.includes('non_agent')) return 'not_unknown';
  return hasUnknown ? 'unknown' : 'not_unknown';
}

function isNonLearnableEventKind(event: JudgedEvent): boolean {
  const raw = text(event.eventKind, 160)?.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return Boolean(raw && NON_LEARNABLE_EVENT_KINDS.has(raw));
}

function stableProcessScope(event: JudgedEvent): string | undefined {
  const process = event.process;
  const host = text(process?.hostId, 512);
  const boot = text(process?.bootId, 512);
  const startTicks = text(process?.startTimeTicks, 512);
  const startNs = text(process?.startTimeNs, 512);
  const start = startTicks ? `ticks:${startTicks}` : startNs ? `ns:${startNs}` : undefined;
  return host && boot && Number.isSafeInteger(process?.pid) && Number(process?.pid) > 0 && start
    ? `process:${sha256([host, boot, process!.pid, start].join('\0')).slice(0, 32)}`
    : undefined;
}

function stableScope(event: JudgedEvent): string | undefined {
  const rootKey = text(event.attribution?.rootKey, 1_024);
  if (rootKey) return `root:${sha256(rootKey).slice(0, 32)}`;
  const workload = text(event.attribution?.physicalWorkloadId, 512);
  if (workload) return `workload:${sha256(workload).slice(0, 32)}`;
  return stableProcessScope(event);
}

function extensionClass(extension: string): string {
  if (!extension) return 'none';
  if (['.c', '.cc', '.cpp', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.py', '.rs', '.sh', '.ts', '.tsx'].includes(extension)) return 'source';
  if (['.conf', '.ini', '.json', '.toml', '.yaml', '.yml'].includes(extension)) return 'config';
  if (['.csv', '.db', '.log', '.parquet', '.sql'].includes(extension)) return 'data';
  if (['.a', '.bin', '.dll', '.dylib', '.exe', '.o', '.so'].includes(extension)) return 'binary';
  if (['.7z', '.gz', '.rar', '.tar', '.tgz', '.zip'].includes(extension)) return 'archive';
  if (['.crt', '.key', '.pem', '.pfx'].includes(extension)) return 'credential';
  return 'other';
}

function workspaceRootClass(root: string): string {
  if (['src', 'source', 'lib', 'app', 'apps', 'pkg', 'packages'].includes(root)) return 'source';
  if (['node_modules', 'vendor', '.venv', 'venv'].includes(root)) return 'dependency';
  if (['config', 'configs', '.config'].includes(root)) return 'config';
  if (['build', 'dist', 'target', 'out'].includes(root)) return 'build';
  if (['.git', '.github', '.gitlab'].includes(root)) return 'metadata';
  return 'other';
}

function filesystemRootClass(root: string): string {
  if (['bin', 'etc', 'lib', 'lib64', 'sbin', 'usr'].includes(root)) return 'system';
  if (['home', 'root'].includes(root)) return 'home';
  if (['run', 'var'].includes(root)) return 'runtime';
  if (root === 'proc') return 'proc';
  if (['dev', 'sys'].includes(root)) return 'device';
  if (root === 'tmp') return 'temporary';
  if (['data', 'mnt', 'opt', 'srv'].includes(root)) return 'data';
  return 'other';
}

function pathBucket(raw: string, rawWorkspacePath: unknown): string {
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  const workspaceText = text(rawWorkspacePath, 4_096);
  const workspace = workspaceText?.startsWith('/') ? path.posix.normalize(workspaceText) : undefined;
  const extension = extensionClass(path.posix.extname(normalized).toLowerCase().slice(0, 16));
  if (workspace && (normalized === workspace || normalized.startsWith(`${workspace}/`))) {
    const relative = path.posix.relative(workspace, normalized);
    const root = (relative.split('/').filter(Boolean)[0] ?? '').toLowerCase();
    return `workspace:${workspaceRootClass(root)}:ext:${extension}`;
  }
  const top = (normalized.split('/').filter(Boolean)[0] ?? '').toLowerCase();
  return `filesystem:${filesystemRootClass(top)}:ext:${extension}`;
}

function targetShard(raw: string): string {
  const shard = Number.parseInt(sha256(raw).slice(0, 2), 16) % TARGET_SHARDS;
  return shard.toString(16).padStart(2, '0');
}

function networkBucket(raw: string): string {
  const normalized = raw.toLowerCase().replace(/^https?:\/\//u, '');
  const host = normalized.startsWith('[')
    ? normalized.slice(1).split(']')[0] ?? ''
    : normalized.split(/[/:]/u)[0] ?? '';
  if (/^10\./u.test(host)) return `network:private-10:shard:${targetShard(host)}`;
  if (/^192\.168\./u.test(host)) return `network:private-192:shard:${targetShard(host)}`;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return `network:private-172:shard:${targetShard(host)}`;
  if (/^127\./u.test(host) || host === 'localhost' || host === '::1') return 'network:loopback';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return `network:public-ipv4:shard:${targetShard(host)}`;
  if (host.includes(':')) return `network:ipv6:shard:${targetShard(host)}`;
  return `network:dns:shard:${targetShard(host || normalized)}`;
}

function commandBucket(raw: string): string {
  const executable = path.posix.basename(raw.trim().split(/\s+/u)[0] ?? '').toLowerCase();
  if (['bash', 'dash', 'fish', 'sh', 'zsh'].includes(executable)) return 'exec:shell';
  if (['bun', 'deno', 'java', 'node', 'perl', 'php', 'python', 'python3', 'ruby'].includes(executable)) return 'exec:runtime';
  if (['cat', 'curl', 'git', 'grep', 'jq', 'kubectl', 'sed', 'wget'].includes(executable)) return 'exec:tool';
  return `exec:other:shard:${targetShard(executable || raw)}`;
}

function canonicalEventKind(raw: unknown): string | undefined {
  const value = text(raw, 160)?.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  if (!value) return undefined;
  const aliases: Record<string, string> = {
    exec: 'Exec', processexec: 'Exec', toolexec: 'ToolExec', exit: 'Exit', processexit: 'Exit',
    fileaccess: 'FileAccess', filedelete: 'FileDelete', egress: 'Egress', connect: 'Egress', dns: 'Dns',
    tls: 'Tls', llm: 'LlmCall', llmcall: 'LlmCall', ssl: 'SslContent', sslcontent: 'SslContent',
    security: 'SecurityAction', securityaction: 'SecurityAction',
  };
  return aliases[value] ?? 'Other';
}

function targetBucket(event: JudgedEvent, eventKind: string): string {
  const file = attrText(event, 'path') ?? text(event.actionTarget, 4_096);
  if (file && (event.eventCategory === 'file' || file.includes('/') || file.includes('\\'))) {
    return pathBucket(file, event.workspacePath);
  }
  const network = attrText(event, 'peer', 'query', 'sni', 'endpoint');
  if (network) return networkBucket(network);
  const command = attrText(event, 'argv');
  if (command) return commandBucket(command);
  return `kind:${eventKind.toLowerCase()}`;
}

function eventSample(event: JudgedEvent, bucket: string): UnknownClusterSample | undefined {
  const eventId = text(event.eventId, 512);
  if (!eventId || !validTimestamp(event.at)) return undefined;
  const process = event.process;
  return {
    eventId,
    at: event.at,
    subject: text(event.subject, 240) ?? 'unknown event',
    process: process ? {
      pid: Number.isSafeInteger(process.pid) && Number(process.pid) > 0 ? process.pid : undefined,
      comm: text(process.comm, 120),
      exe: text(process.exe, 500),
    } : undefined,
    targetBucket: bucket,
  };
}

/**
 * True only when an event can contribute to an Unknown cluster. The service uses this
 * before watermark and dedupe admission so Agent/operational/invalid events cannot
 * evict real discovery evidence from bounded state.
 */
export function isUnknownLearningCandidate(event: JudgedEvent): boolean {
  if (isNonLearnableEventKind(event) || unknownIdentityState(event) !== 'unknown' || !unknownReason(event) ||
      !stableScope(event)) return false;
  const eventKind = canonicalEventKind(event.eventKind);
  if (!eventKind || !validTimestamp(event.at)) return false;
  const bucket = targetBucket(event, eventKind);
  return Boolean(eventSample(event, bucket));
}

function completeness(event: JudgedEvent): UnknownMetadataCompleteness {
  const process = event.process;
  const workload = event.attribution?.workloadRef;
  return {
    processIdentity: Boolean(process?.hostId && process.bootId && Number.isSafeInteger(process.pid) && Number(process.pid) > 0 && (process.startTimeTicks || process.startTimeNs)),
    processAncestry: Boolean(Number.isSafeInteger(process?.ppid) && Number(process?.ppid) > 0 && !['parent_missing', 'ancestry_incomplete'].includes(unknownReason(event) ?? '')),
    workloadIdentity: Boolean(event.attribution?.physicalWorkloadId),
    containerIdentity: Boolean(workload?.containerName || workload?.podUid || workload?.systemdUnit),
  };
}

function mergeCompleteness(left: UnknownMetadataCompleteness, right: UnknownMetadataCompleteness): UnknownMetadataCompleteness {
  return {
    processIdentity: left.processIdentity || right.processIdentity,
    processAncestry: left.processAncestry || right.processAncestry,
    workloadIdentity: left.workloadIdentity || right.workloadIdentity,
    containerIdentity: left.containerIdentity || right.containerIdentity,
  };
}

function sampleCanonical(sample: UnknownClusterSample): string {
  return [sample.eventId, String(sample.at), sample.subject, String(sample.process?.pid ?? ''), sample.process?.comm ?? '', sample.process?.exe ?? '', sample.targetBucket].join('\0');
}

function compareFirstSample(left: UnknownClusterSample, right: UnknownClusterSample): number {
  return left.at - right.at || compareAscii(left.eventId, right.eventId) || compareAscii(sampleCanonical(left), sampleCanonical(right));
}

function bottomK(clusterId: string, samples: readonly UnknownClusterSample[], limit: number): UnknownClusterSample[] {
  return [...samples]
    .sort((left, right) => compareAscii(sha256(`${clusterId}\0${sampleCanonical(left)}`), sha256(`${clusterId}\0${sampleCanonical(right)}`)) || compareAscii(sampleCanonical(left), sampleCanonical(right)))
    .slice(0, limit)
    .sort(compareFirstSample);
}

function safeCountAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right) {
    throw new Error('unknown cluster exact count exceeds the safe integer range');
  }
  return left + right;
}

function validTargetBucket(value: string): boolean {
  return /^(?:workspace:(?:source|dependency|config|build|metadata|other):ext:(?:none|source|config|data|binary|archive|credential|other)|filesystem:(?:system|home|runtime|proc|device|temporary|data|other):ext:(?:none|source|config|data|binary|archive|credential|other)|network:(?:loopback|(?:private-10|private-192|private-172|public-ipv4|ipv6|dns):shard:[a-f0-9]{2})|exec:(?:shell|runtime|tool|other:shard:[a-f0-9]{2})|kind:(?:exec|toolexec|exit|fileaccess|filedelete|egress|dns|tls|llmcall|sslcontent|securityaction|other))$/u.test(value);
}

function assertClusterShape(cluster: UnknownCluster): void {
  const expectedFamilyId = `ufam_${sha256([
    cluster.stableScope,
    cluster.unknownReason,
    cluster.eventKind,
    cluster.targetBucket,
  ].join('\0')).slice(0, 24)}`;
  const windowMs = cluster.windowEndMs - cluster.windowStartMs;
  const expectedClusterId = `ucl_${sha256(`${cluster.familyId}\0${cluster.windowStartMs}\0${windowMs}`).slice(0, 24)}`;
  if (cluster.schemaVersion !== UNKNOWN_CLUSTER_SCHEMA_VERSION ||
      !/^ufam_[a-f0-9]{24}$/u.test(cluster.familyId) || !/^ucl_[a-f0-9]{24}$/u.test(cluster.clusterId) ||
      cluster.familyId !== expectedFamilyId || cluster.clusterId !== expectedClusterId ||
      !/^(?:root|workload|process):[a-f0-9]{32}$/u.test(cluster.stableScope) ||
      !REASONS.has(cluster.unknownReason) || !CANONICAL_EVENT_KINDS.has(cluster.eventKind) ||
      !validTargetBucket(cluster.targetBucket) || !validTimestamp(cluster.windowStartMs) ||
      !validTimestamp(cluster.windowEndMs) || cluster.windowEndMs <= cluster.windowStartMs ||
      cluster.countScope !== 'retained_events' ||
      !Number.isSafeInteger(cluster.exactCount) || cluster.exactCount <= 0 ||
      !Array.isArray(cluster.firstSamples) || cluster.firstSamples.length > 16 ||
      !Array.isArray(cluster.reservoirSamples) || cluster.reservoirSamples.length > 32 ||
      !CLUSTER_REVIEWS.has(cluster.review) || !validTimestamp(cluster.firstSeenAt) ||
      !validTimestamp(cluster.lastSeenAt) || cluster.firstSeenAt > cluster.lastSeenAt ||
      cluster.firstSeenAt < cluster.windowStartMs || cluster.lastSeenAt >= cluster.windowEndMs) {
    throw new Error('invalid or unsafe Unknown cluster state');
  }
  if (!cluster.metadataCompleteness ||
      Object.values(cluster.metadataCompleteness).some((value) => typeof value !== 'boolean')) {
    throw new Error('invalid or unsafe Unknown cluster metadata completeness');
  }
  for (const entry of [...cluster.firstSamples, ...cluster.reservoirSamples]) {
    if (!text(entry.eventId, 512) || !validTimestamp(entry.at) || entry.at < cluster.windowStartMs ||
        entry.at >= cluster.windowEndMs || !text(entry.subject, 240) || entry.targetBucket !== cluster.targetBucket) {
      throw new Error('invalid or unsafe Unknown cluster sample');
    }
    if (entry.process &&
        ((entry.process.pid !== undefined && (!Number.isSafeInteger(entry.process.pid) || entry.process.pid <= 0)) ||
         (entry.process.comm !== undefined && !text(entry.process.comm, 120)) ||
         (entry.process.exe !== undefined && !text(entry.process.exe, 500)))) {
      throw new Error('invalid or unsafe Unknown cluster sample process');
    }
  }
}

export function validateUnknownCluster(cluster: UnknownCluster): void {
  assertClusterShape(cluster);
}

export function mergeUnknownClusters(
  left: UnknownCluster,
  right: UnknownCluster,
  options: { firstSamples?: number; reservoirSamples?: number } = {},
): UnknownCluster {
  assertClusterShape(left);
  assertClusterShape(right);
  if (left.schemaVersion !== UNKNOWN_CLUSTER_SCHEMA_VERSION || right.schemaVersion !== UNKNOWN_CLUSTER_SCHEMA_VERSION ||
      left.clusterId !== right.clusterId || left.familyId !== right.familyId ||
      left.windowStartMs !== right.windowStartMs || left.windowEndMs !== right.windowEndMs ||
      left.stableScope !== right.stableScope || left.unknownReason !== right.unknownReason ||
      left.eventKind !== right.eventKind || left.targetBucket !== right.targetBucket) {
    throw new Error('only identical unknown cluster windows can be merged');
  }
  const firstLimit = boundedInteger(options.firstSamples, DEFAULT_FIRST_SAMPLES, 1, 16);
  const reservoirLimit = boundedInteger(options.reservoirSamples, DEFAULT_RESERVOIR_SAMPLES, 1, 32);
  return {
    ...left,
    exactCount: safeCountAdd(left.exactCount, right.exactCount),
    firstSamples: [...left.firstSamples, ...right.firstSamples].sort(compareFirstSample).slice(0, firstLimit),
    reservoirSamples: bottomK(left.clusterId, [...left.reservoirSamples, ...right.reservoirSamples], reservoirLimit),
    metadataCompleteness: mergeCompleteness(left.metadataCompleteness, right.metadataCompleteness),
    review: left.review === right.review ? left.review : 'unreviewed',
    firstSeenAt: Math.min(left.firstSeenAt, right.firstSeenAt),
    lastSeenAt: Math.max(left.lastSeenAt, right.lastSeenAt),
  };
}

interface NormalizedUnknownObservation {
  familyId: string;
  clusterId: string;
  stableScope: string;
  reason: UnknownReason;
  eventKind: string;
  bucket: string;
  windowStartMs: number;
  windowEndMs: number;
  event: JudgedEvent;
  sample: UnknownClusterSample;
}

export function buildUnknownClusters(
  events: readonly JudgedEvent[],
  options: {
    windowMs?: number;
    maxClusters?: number;
    firstSamples?: number;
    reservoirSamples?: number;
    maxEvents?: number;
    /** Family review is preferred; cluster review remains accepted for compatibility. */
    reviews?: Readonly<Record<string, UnknownClusterReview>>;
  } = {},
): UnknownClusterBuildResult {
  const maxEvents = boundedInteger(options.maxEvents, DEFAULT_MAX_EVENTS, 1, 1_000_000);
  if (events.length > maxEvents) throw new Error(`Unknown cluster batch exceeds ${maxEvents} events`);
  const windowMs = boundedInteger(options.windowMs, DEFAULT_WINDOW_MS, 60_000, 60 * 60_000);
  const maxClusters = boundedInteger(options.maxClusters, DEFAULT_MAX_CLUSTERS, 1, 100_000);
  const firstLimit = boundedInteger(options.firstSamples, DEFAULT_FIRST_SAMPLES, 1, 16);
  const reservoirLimit = boundedInteger(options.reservoirSamples, DEFAULT_RESERVOIR_SAMPLES, 1, 32);
  const observations: NormalizedUnknownObservation[] = [];
  let observedUnknownEvents = 0;
  let rejectedWithoutReason = 0;
  let rejectedWithoutStableScope = 0;
  let rejectedInvalidEvent = 0;
  let rejectedUnsafeIdentity = 0;

  for (const event of events) {
    if (isNonLearnableEventKind(event)) continue;
    const identity = unknownIdentityState(event);
    if (identity === 'not_unknown') continue;
    observedUnknownEvents += 1;
    if (identity === 'unsafe_conflict') {
      rejectedUnsafeIdentity += 1;
      continue;
    }
    const reason = unknownReason(event);
    if (!reason) {
      rejectedWithoutReason += 1;
      continue;
    }
    const scope = stableScope(event);
    if (!scope) {
      rejectedWithoutStableScope += 1;
      continue;
    }
    const eventKind = canonicalEventKind(event.eventKind);
    if (!eventKind || !validTimestamp(event.at) || event.at > Number.MAX_SAFE_INTEGER - windowMs) {
      rejectedInvalidEvent += 1;
      continue;
    }
    const bucket = targetBucket(event, eventKind);
    const nextSample = eventSample(event, bucket);
    if (!nextSample) {
      rejectedInvalidEvent += 1;
      continue;
    }
    const familyKey = [scope, reason, eventKind, bucket].join('\0');
    const familyId = `ufam_${sha256(familyKey).slice(0, 24)}`;
    const windowStartMs = Math.floor(event.at / windowMs) * windowMs;
    const clusterId = `ucl_${sha256(`${familyId}\0${windowStartMs}\0${windowMs}`).slice(0, 24)}`;
    observations.push({
      familyId, clusterId, stableScope: scope, reason, eventKind, bucket,
      windowStartMs, windowEndMs: windowStartMs + windowMs, event, sample: nextSample,
    });
  }

  // Sorting before bounded admission makes batch results independent of ingest order.
  observations.sort((left, right) => compareAscii(left.clusterId, right.clusterId) || compareFirstSample(left.sample, right.sample));
  const clusters = new Map<string, UnknownCluster & { candidates: UnknownClusterSample[] }>();
  let overflowEvents = 0;
  for (const observation of observations) {
    let cluster = clusters.get(observation.clusterId);
    if (!cluster) {
      if (clusters.size >= maxClusters) {
        overflowEvents += 1;
        continue;
      }
      cluster = {
        schemaVersion: UNKNOWN_CLUSTER_SCHEMA_VERSION,
        familyId: observation.familyId,
        clusterId: observation.clusterId,
        stableScope: observation.stableScope,
        unknownReason: observation.reason,
        eventKind: observation.eventKind,
        targetBucket: observation.bucket,
        windowStartMs: observation.windowStartMs,
        windowEndMs: observation.windowEndMs,
        countScope: 'retained_events',
        exactCount: 0,
        firstSamples: [],
        reservoirSamples: [],
        candidates: [],
        metadataCompleteness: completeness(observation.event),
        review: (() => {
          const review = options.reviews?.[observation.familyId] ?? options.reviews?.[observation.clusterId];
          return review && CLUSTER_REVIEWS.has(review) ? review : 'unreviewed';
        })(),
        firstSeenAt: observation.event.at,
        lastSeenAt: observation.event.at,
      };
      clusters.set(observation.clusterId, cluster);
    }
    cluster.exactCount = safeCountAdd(cluster.exactCount, 1);
    cluster.firstSeenAt = Math.min(cluster.firstSeenAt, observation.event.at);
    cluster.lastSeenAt = Math.max(cluster.lastSeenAt, observation.event.at);
    cluster.metadataCompleteness = mergeCompleteness(cluster.metadataCompleteness, completeness(observation.event));
    cluster.candidates = bottomK(cluster.clusterId, [...cluster.candidates, observation.sample], reservoirLimit);
    cluster.firstSamples = [...cluster.firstSamples, observation.sample].sort(compareFirstSample).slice(0, firstLimit);
  }

  const output = [...clusters.values()].map(({ candidates, ...cluster }) => ({
    ...cluster,
    reservoirSamples: bottomK(cluster.clusterId, candidates, reservoirLimit),
  })).sort((left, right) => right.exactCount - left.exactCount || compareAscii(left.clusterId, right.clusterId));
  return {
    schemaVersion: UNKNOWN_CLUSTER_SCHEMA_VERSION,
    clusters: output,
    observedUnknownEvents,
    clusteredEvents: output.reduce((sum, cluster) => safeCountAdd(sum, cluster.exactCount), 0),
    rejectedWithoutReason,
    rejectedWithoutStableScope,
    rejectedInvalidEvent,
    rejectedUnsafeIdentity,
    overflowEvents,
    truncated: overflowEvents > 0,
  };
}

function boundedReason(value: string): string {
  return boundedLabel(value, 500, 'transition reason');
}

function assertLearnedAction(value: unknown): asserts value is UnknownLearnedAction {
  if (!LEARNED_ACTIONS.has(value as UnknownLearnedAction)) {
    throw new Error('Unknown learning only permits keep, sample, or aggregate; authoritative DROP is forbidden');
  }
}

function assertPolicyInvariant(policy: UnknownPolicyCandidate): void {
  const expectedPolicyId = `upol_${sha256(`${policy.familyId}\0${policy.desiredAction}\0${policy.createdAt}`).slice(0, 24)}`;
  if (policy.schemaVersion !== UNKNOWN_POLICY_SCHEMA_VERSION ||
      !/^upol_[a-f0-9]{24}$/u.test(policy.policyId) || !/^ufam_[a-f0-9]{24}$/u.test(policy.familyId) ||
      !/^ucl_[a-f0-9]{24}$/u.test(policy.clusterId) ||
      policy.policyId !== expectedPolicyId ||
      !POLICY_STAGES.has(policy.stage) || !Number.isSafeInteger(policy.revision) || policy.revision < 1 ||
      !validTimestamp(policy.createdAt) || !validTimestamp(policy.updatedAt) || policy.updatedAt < policy.createdAt ||
      policy.authority !== 'recommendation_only' || policy.authoritativeDrop !== false ||
      !text(policy.createdBy, 240) || !Array.isArray(policy.audit) || policy.audit.length < 1 ||
      policy.audit.length > 64 || policy.audit.length !== policy.revision ||
      !Number.isSafeInteger(policy.evidence?.reviewRevision) || policy.evidence.reviewRevision <= 0 ||
      policy.evidence.countScope !== 'retained_events' ||
      !Number.isSafeInteger(policy.evidence?.clusterCount) || policy.evidence.clusterCount <= 0 ||
      !Number.isSafeInteger(policy.evidence?.historicalWindows) || policy.evidence.historicalWindows <= 0) {
    throw new Error('invalid or unsafe Unknown policy state');
  }
  assertLearnedAction(policy.desiredAction);
  boundedLabel(policy.createdBy, 240, 'creator');
  let previous: UnknownPolicyStage | undefined;
  for (let index = 0; index < policy.audit.length; index += 1) {
    const entry = policy.audit[index]!;
    if (!POLICY_STAGES.has(entry.to) || !validTimestamp(entry.at) ||
        (index > 0 && entry.at < policy.audit[index - 1]!.at)) {
      throw new Error('invalid or unsafe Unknown policy audit chain');
    }
    boundedLabel(entry.actor, 240, 'audit actor');
    boundedReason(entry.reason);
    if (index === 0) {
      if (entry.from !== undefined || entry.to !== 'candidate' || entry.at !== policy.createdAt) {
        throw new Error('invalid or unsafe Unknown policy audit chain');
      }
    } else {
      if (!previous || entry.from !== previous || previous === 'rolled_back' ||
          (entry.to !== 'rolled_back' && NEXT_STAGE[previous] !== entry.to)) {
        throw new Error('invalid or unsafe Unknown policy audit chain');
      }
    }
    previous = entry.to;
  }
  if (previous !== policy.stage || policy.audit.at(-1)!.at !== policy.updatedAt) {
    throw new Error('invalid or unsafe Unknown policy audit chain');
  }
  if (policy.audit[0]!.actor !== policy.createdBy) throw new Error('Unknown policy creator does not match its audit chain');
  const stages = new Set(policy.audit.map((entry) => entry.to));
  const hasReplayEvidence = policy.evidence.replayEvents !== undefined || policy.evidence.replayAgentConflicts !== undefined;
  const hasCanaryScope = policy.evidence.canaryScope !== undefined;
  const hasCanaryEvidence = policy.evidence.canaryEvents !== undefined ||
    policy.evidence.canaryAgentRecall !== undefined || policy.evidence.canaryCriticalDrops !== undefined;
  if (stages.has('replay_validated')) {
    if (!Number.isSafeInteger(policy.evidence.replayEvents) || Number(policy.evidence.replayEvents) <= 0 ||
        !Number.isSafeInteger(policy.evidence.replayAgentConflicts) || policy.evidence.replayAgentConflicts !== 0) {
      throw new Error('invalid or unsafe Unknown replay evidence');
    }
  } else if (hasReplayEvidence) {
    throw new Error('Unknown replay evidence cannot precede replay validation');
  }
  if (stages.has('canary')) {
    if (!policy.evidence.canaryScope || !['node', 'physical_workload'].includes(policy.evidence.canaryScope.kind) ||
        !/^[a-f0-9]{32}$/u.test(policy.evidence.canaryScope.valueHash)) {
      throw new Error('invalid or unsafe Unknown canary scope');
    }
  } else if (hasCanaryScope) {
    throw new Error('Unknown canary scope cannot precede canary');
  }
  if (stages.has('enforced')) {
    if (!Number.isSafeInteger(policy.evidence.canaryEvents) || Number(policy.evidence.canaryEvents) <= 0 ||
        policy.evidence.canaryAgentRecall !== 1 || !Number.isSafeInteger(policy.evidence.canaryCriticalDrops) ||
        policy.evidence.canaryCriticalDrops !== 0) {
      throw new Error('invalid or unsafe Unknown canary evidence');
    }
  } else if (hasCanaryEvidence) {
    throw new Error('Unknown canary evidence cannot precede enforce');
  }
}

export function validateUnknownPolicyCandidate(policy: UnknownPolicyCandidate): void {
  assertPolicyInvariant(policy);
}

export function createUnknownPolicyCandidate(input: {
  cluster: UnknownCluster;
  desiredAction: UnknownLearnedAction;
  actor: string;
  reason: string;
  at?: number;
  clusterCount?: number;
  historicalWindows?: number;
  reviewRevision?: number;
}): UnknownPolicyCandidate {
  assertClusterShape(input.cluster);
  if (input.cluster.review !== 'non_agent') {
    throw new Error('only a human-reviewed non-Agent cluster family can create a learning candidate');
  }
  assertLearnedAction(input.desiredAction);
  const actor = boundedLabel(input.actor, 240, 'actor');
  const at = input.at ?? Date.now();
  if (!validTimestamp(at)) throw new Error('candidate time must be a non-negative safe integer');
  const clusterCount = input.clusterCount ?? input.cluster.exactCount;
  const historicalWindows = input.historicalWindows ?? 1;
  const reviewRevision = input.reviewRevision ?? 1;
  if (!Number.isSafeInteger(clusterCount) || clusterCount <= 0 || !Number.isSafeInteger(historicalWindows) || historicalWindows <= 0) {
    throw new Error('candidate evidence must contain positive exact counts and historical windows');
  }
  if (!Number.isSafeInteger(reviewRevision) || reviewRevision <= 0) {
    throw new Error('candidate evidence must reference a positive human review revision');
  }
  const policyId = `upol_${sha256(`${input.cluster.familyId}\0${input.desiredAction}\0${at}`).slice(0, 24)}`;
  return {
    schemaVersion: UNKNOWN_POLICY_SCHEMA_VERSION,
    policyId,
    revision: 1,
    familyId: input.cluster.familyId,
    clusterId: input.cluster.clusterId,
    stage: 'candidate',
    desiredAction: input.desiredAction,
    authority: 'recommendation_only',
    authoritativeDrop: false,
    createdAt: at,
    updatedAt: at,
    createdBy: actor,
    evidence: { reviewRevision, countScope: 'retained_events', clusterCount, historicalWindows },
    audit: [{ at, to: 'candidate', actor, reason: boundedReason(input.reason) }],
  };
}

export function transitionUnknownPolicy(current: UnknownPolicyCandidate, transition: UnknownPolicyTransition): UnknownPolicyCandidate {
  assertPolicyInvariant(current);
  if (current.stage === 'rolled_back') throw new Error('a rolled-back policy cannot be reactivated');
  const actor = boundedLabel(transition.actor, 240, 'actor');
  const at = transition.at ?? Date.now();
  if (!validTimestamp(at) || at < current.updatedAt) throw new Error('transition time must be monotonic');
  if (transition.to !== 'rolled_back' && NEXT_STAGE[current.stage] !== transition.to) {
    throw new Error(`invalid policy transition ${current.stage} -> ${transition.to}`);
  }

  const hasReplayInput = transition.replayEvents !== undefined || transition.replayAgentConflicts !== undefined;
  const hasCanaryScopeInput = transition.canaryScope !== undefined;
  const hasCanaryInput = transition.canaryEvents !== undefined || transition.canaryAgentRecall !== undefined ||
    transition.canaryCriticalDrops !== undefined;
  if ((hasReplayInput && transition.to !== 'replay_validated') ||
      (hasCanaryScopeInput && transition.to !== 'canary') ||
      (hasCanaryInput && transition.to !== 'enforced')) {
    throw new Error('policy evidence is only accepted by its matching transition stage');
  }

  const evidence = {
    ...current.evidence,
    ...(transition.replayEvents !== undefined ? { replayEvents: transition.replayEvents } : {}),
    ...(transition.replayAgentConflicts !== undefined ? { replayAgentConflicts: transition.replayAgentConflicts } : {}),
    ...(transition.canaryEvents !== undefined ? { canaryEvents: transition.canaryEvents } : {}),
    ...(transition.canaryAgentRecall !== undefined ? { canaryAgentRecall: transition.canaryAgentRecall } : {}),
    ...(transition.canaryCriticalDrops !== undefined ? { canaryCriticalDrops: transition.canaryCriticalDrops } : {}),
    ...(transition.canaryScope ? {
      canaryScope: {
        kind: transition.canaryScope.kind,
        valueHash: sha256(boundedLabel(transition.canaryScope.value, 1_024, 'canary scope')).slice(0, 32),
      },
    } : {}),
  };
  if (transition.to === 'replay_validated') {
    if (!Number.isSafeInteger(evidence.replayEvents) || Number(evidence.replayEvents) <= 0) {
      throw new Error('historical replay must evaluate at least one event');
    }
    if (!Number.isSafeInteger(evidence.replayAgentConflicts) || evidence.replayAgentConflicts !== 0) {
      throw new Error('historical replay has Agent conflicts');
    }
  }
  if (transition.to === 'canary') {
    if (!transition.canaryScope || !['node', 'physical_workload'].includes(transition.canaryScope.kind)) {
      throw new Error('canary requires one exact node or physical workload scope');
    }
  }
  if (transition.to === 'enforced') {
    if (!evidence.canaryScope) throw new Error('enforce requires a completed scoped canary');
    if (!Number.isSafeInteger(evidence.canaryEvents) || Number(evidence.canaryEvents) <= 0) {
      throw new Error('canary must evaluate at least one event');
    }
    if (evidence.canaryAgentRecall !== 1) throw new Error('canary Agent recall must be exactly 100%');
    if (!Number.isSafeInteger(evidence.canaryCriticalDrops) || evidence.canaryCriticalDrops !== 0) {
      throw new Error('canary cannot drop Critical evidence');
    }
  }

  const next: UnknownPolicyCandidate = {
    ...current,
    revision: current.revision + 1,
    stage: transition.to,
    updatedAt: at,
    evidence,
    audit: [...current.audit, { at, from: current.stage, to: transition.to, actor, reason: boundedReason(transition.reason) }].slice(-64),
  };
  assertPolicyInvariant(next);
  return next;
}
