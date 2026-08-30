import { Injectable, Optional } from '@nestjs/common';
import { Sentry } from '@a3s-lab/sentry';
import { createHash } from 'node:crypto';
import {
  DashboardAggregateBucketFact,
  DashboardWindowBucketRow,
  DashboardWindowDimensionRow,
  DashboardWindowHistory,
  StoredAgentBucketFact,
  StoredAgentMetricBucketFact,
  StoredAgentObservabilityFact,
  StoredAgentWindowFact,
  StoredEventQuery,
  StoredEventSearchResult,
  StoredTopologyBucketFact,
  StoredTopologyWindowFact,
  StoredWorkspaceBucketFact,
  StoredWorkspaceWindowFact,
} from './clickhouse-store';
import {
  agentRuntimeInstanceIdForEvent,
  agentRuntimeInstanceIdsForEvent,
  detectedAgentIdentity,
  hasAgentRuntimeLineageEvidence,
  hasDirectAgentRootEvidence,
  isInternalAgentHelperRootEvent,
  isAgentAssetClassification,
} from './agent-identity';
import { AgentMetadataService } from './agent-metadata.service';
import { ObservedAssetReviewService } from './observed-asset-review.service';
import { WorkspaceDirectoryService } from './workspace-directory.service';
import { isEventClassificationVisible } from './event-visibility';
import { IngestionSourceService } from './ingestion-source.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { buildAcl, policyConfigError, sanitizePolicy } from './policy-config';
import { SentryJudgeService } from './sentry-judge.service';
import { planDashboardRead, pruneSnapshotCache } from './dashboard-query-plan';
import { DashboardHistoryBucketCache } from './dashboard-history-cache';
import {
  observedDurableThrough,
  relevantCommitProgress,
} from './query-coverage';
import { CommitAwareFactBucketCache } from './commit-aware-fact-cache';
import { foldLatestEventRevisions } from './event-revision';
import { eventActivityContext, eventActivitySubtype } from './activity-context';
import { resolveTimeWindow } from './time-window';
import {
  collectorHeartbeatFailureDelta,
  summarizePipelineAccounting,
} from './pipeline-accounting';
import { correlationCaptureRollout } from './correlation-rollout';
import {
  visibleClassificationSemantics,
  visibleProcessContext,
  visibleUnknownReasonCounts,
} from './classification-semantics';
import { parseTrustedCorrelation } from './trusted-correlation';
import {
  buildToolEvidenceBundle,
  toolEvidenceIndexFields,
  ToolEvidenceResponse,
} from './tool-evidence-linker';
import {
  projectAgentConversations,
  projectConversationTimeline,
} from './agent-conversation';
import { AgentConversationBindingService } from './agent-conversation-binding.service';
import {
  projectSemanticConversationTimeline,
  SEMANTIC_PROJECTION_PARSER_ID,
  SEMANTIC_PROJECTION_PARSER_VERSION,
} from './agent-semantic-timeline';
import * as T from './types';

const SEV_RANK: Record<T.Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const MAX_HISTORY_CACHE_ENTRIES = 64;
const LEVEL_BY_RANK = ['safe', 'low', 'medium', 'high', 'critical'];
const LEVEL_TEXT: Record<string, string> = { safe: '安全', low: '低危', medium: '中危', high: '高危', critical: '严重', unknown: '未知' };
const TOOL_EVIDENCE_RELATION_SETTLE_MS = 10_000;
const CONVERSATION_INTERACTIONS_PER_AGENT = 64;
const CONVERSATION_INTERACTIONS_TOTAL = 2_000;
const CATEGORY_COLOR: Record<string, string> = {
  command_danger: '#fb7185', data_leak: '#f59e0b', secret_exfil: '#f59e0b', prompt_injection: '#a855f7',
  communication_risk: '#38bdf8', systemic_risk: '#f43f5e', privilege_escalation: '#fb7185', other: '#94a3b8',
};

function visibleCollectorFilterMetrics(
  metrics: T.CollectorFilterMetrics,
): T.CollectorFilterMetrics {
  const { unknownReasonCounts: _hiddenUnknownReasons, ...legacyMetrics } = metrics;
  const unknownReasonCounts = visibleUnknownReasonCounts(metrics.unknownReasonCounts);
  return unknownReasonCounts
    ? { ...legacyMetrics, unknownReasonCounts }
    : legacyMetrics;
}
// The monitored risk taxonomy, grouped by risk type. Always listed on the dashboard (with 0 counts
// when nothing fired) so operators see WHAT is watched, not a blank panel. Names mirror `deriveRisk`.
const RISK_TAXONOMY: Record<T.RiskType, Array<{ code: string; name: string }>> = {
  system: [
    { code: 'systemic_risk', name: '云元数据 SSRF' },
    { code: 'privilege_escalation', name: '提权 / 进程注入' },
  ],
  communication: [
    { code: 'secret_exfil', name: '密钥外泄' },
    { code: 'prompt_injection', name: '提示词注入' },
    { code: 'communication_risk', name: '异常外联 / 回连' },
  ],
  atomic: [
    { code: 'command_danger', name: '危险命令执行' },
    { code: 'data_leak', name: '凭据文件访问' },
    { code: 'other', name: '其他风险' },
  ],
};

// The 6 radar dimensions of the highest-risk session.
const DIMENSIONS: Array<{ code: string; name: string; cats: string[] }> = [
  { code: 'command_danger', name: '命令危险', cats: ['command_danger'] },
  { code: 'prompt_injection', name: '提示注入', cats: ['prompt_injection'] },
  { code: 'data_leak', name: '数据泄露', cats: ['data_leak', 'secret_exfil'] },
  { code: 'jailbreak', name: '越狱绕过', cats: ['prompt_injection'] },
  { code: 'communication_risk', name: '通信风险', cats: ['communication_risk'] },
  { code: 'systemic_risk', name: '系统性风险', cats: ['systemic_risk', 'privilege_escalation'] },
];

const EVENT_CATEGORIES: T.EventCategory[] = ['tool', 'network', 'file', 'llm', 'security', 'process', 'runtime', 'unknown'];
const EVENT_SOURCES: T.EventSource[] = ['observer', 'synthetic', 'api'];
const ACTIVE_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const COLLECTOR_STALE_MS = 3 * 60_000;
const COLLECTOR_DOWN_MS = 10 * 60_000;
// Without an explicit de-registration fact, retain a silent Collector as down for one operational
// day, then archive it from the default summary. Explicit collectorId deep links remain queryable.
const COLLECTOR_ARCHIVE_MS = 24 * 60 * 60_000;
const COMPACT_WINDOW_MS = 3_000;

function matchesAgentRuntimeInstance(event: T.JudgedEvent, requested?: string): boolean {
  return !requested || agentRuntimeInstanceIdsForEvent(event).includes(requested);
}
const HOUR = 3_600_000;
const REUSABLE_BUCKET_MS = 10_000;
const DASHBOARD_EXACT_COMPARISON_MAX_BUCKETS = 360;
// One absolute bucket is enough to merge not-yet-visible hot events with durable revisions. A
// minute-wide SELECT-* tail expanded thousands of large evidence rows in the API heap.
const DASHBOARD_HOT_TAIL_MS = REUSABLE_BUCKET_MS;
const FINAL_DECISION_STATUSES = new Set<T.DecisionStatus>(['succeeded', 'failed', 'timeout']);
const TOOL_KERNEL_EVENT_KINDS = new Set(['FileAccess', 'FileDelete', 'ToolExec']);

function legacyEphemeralCollector(collectorId: string): boolean {
  // S3 privileged E2E runs created two heartbeat-only collector IDs before explicit archival
  // metadata existed. Match only that exact generated contract; arbitrary names containing
  // "test"/"e2e" must never disappear from operational health.
  return /^s3-enforce-\d{10,}-\d+-(?:collector|untrusted-heartbeat)$/u.test(collectorId);
}

type CollectorChannelEvaluation = { severity: 0 | 1 | 2; reasons: string[] };

const CHANNEL_STATE_TEXT: Record<T.CollectorHealthChannelState, string> = {
  healthy: '健康', warning: '提醒', degraded: '降级', unknown: '未知',
};

function recentHeartbeatLane(
  heartbeats: readonly T.CollectorHeartbeatRecord[],
  origin: T.CollectorHeartbeatOrigin,
  limit = 4,
): T.CollectorHeartbeatRecord[] {
  const unique = new Map<string, T.CollectorHeartbeatRecord>();
  for (const heartbeat of heartbeats) {
    if (heartbeat.origin !== origin) continue;
    const accounting = heartbeat.pipelineAccounting;
    const key = accounting?.producerInstanceId && Number.isSafeInteger(accounting.sequence)
      ? `${accounting.producerInstanceId}:${accounting.sequence}`
      : `${heartbeat.at}:${heartbeat.filterMetricsReportedAt ?? ''}`;
    const current = unique.get(key);
    if (!current || heartbeat.at > current.at) unique.set(key, heartbeat);
  }
  return [...unique.values()].sort((left, right) => right.at - left.at).slice(0, limit);
}

export function stabilizeCollectorHealthChannel(
  evaluations: readonly CollectorChannelEvaluation[],
  recoveryReason: string,
): T.CollectorHealthChannel {
  if (!evaluations.length) {
    return { state: 'unknown', stateText: CHANNEL_STATE_TEXT.unknown, reasons: ['heartbeat_unavailable'], consecutiveBad: 0, consecutiveClean: 0 };
  }
  const consecutiveBad = evaluations.findIndex((item) => item.severity === 0);
  const bad = consecutiveBad < 0 ? evaluations.length : consecutiveBad;
  const consecutiveClean = evaluations.findIndex((item) => item.severity > 0);
  const clean = consecutiveClean < 0 ? evaluations.length : consecutiveClean;
  const current = evaluations[0];
  let state: T.CollectorHealthChannelState;
  let reasons = [...current.reasons];
  if (current.severity === 2) state = 'degraded';
  else if (current.severity === 1) state = bad >= 2 ? 'degraded' : 'warning';
  else if (clean < 2 && evaluations.slice(clean).some((item) => item.severity > 0)) {
    state = 'warning';
    reasons = [recoveryReason];
  } else state = 'healthy';
  return { state, stateText: CHANNEL_STATE_TEXT[state], reasons, consecutiveBad: bad, consecutiveClean: clean };
}

export function evaluateCollectorCaptureHeartbeat(
  heartbeat: T.CollectorHeartbeatRecord,
  previous?: T.CollectorHeartbeatRecord,
): CollectorChannelEvaluation {
  const reasons: string[] = [];
  const rings = heartbeat.pipelineAccounting?.rings ?? [];
  const ringLoss = rings.some((ring) =>
    ring.ringDropped > 0 || (ring.collectorDropped ?? 0) > 0 || ring.queueDropped > 0);
  // Raw Collector compatibility counters are process-lifetime cumulative, while Forwarder
  // compatibility counters are per-window deltas. Reuse the same source-aware arithmetic as
  // collector quality alerting so an old, unchanged raw drop count does not keep the current
  // capture channel degraded forever. The typed ring accounting remains window-scoped evidence.
  const { droppedDelta } = collectorHeartbeatFailureDelta(heartbeat, previous);
  const capture = heartbeat.captureProfileMetrics;
  if (heartbeat.status !== 'ok') reasons.push(`raw_status_${heartbeat.status}`);
  if (droppedDelta > 0 || ringLoss) reasons.push('capture_pipeline_loss');
  if (capture?.aggregateLedgerDegraded) reasons.push('capture_aggregate_ledger_degraded');
  if (capture?.decisionConserved === false || capture?.payloadConserved === false) reasons.push('capture_accounting_not_conserved');
  return { severity: reasons.length ? 2 : 0, reasons };
}

function deliveryEvaluation(heartbeat: T.CollectorHeartbeatRecord): CollectorChannelEvaluation {
  const metrics = heartbeat.filterMetrics ?? {} as T.CollectorFilterMetrics;
  const hard: string[] = [];
  const soft: string[] = [];
  if (heartbeat.outputDropped > 0) hard.push('permanent_output_loss');
  if ((metrics.protectedQueueDropped ?? 0) > 0) hard.push('protected_queue_pressure');
  if (metrics.spoolAtCapacity) hard.push('spool_at_capacity');
  if ((metrics.spoolRecords ?? 0) > 0 && (metrics.spoolOldestAgeMs ?? 0) >= 60_000) {
    hard.push('spool_backlog_over_slo');
  }
  if ((metrics.queueParked ?? 0) > 0) soft.push('queue_parked');
  if ((metrics.retryParked ?? 0) > 0) soft.push('retry_parked');
  if ((metrics.heartbeatDeliveryFailures ?? 0) > 0) soft.push('heartbeat_delivery_failed');
  if ((metrics.spoolParkedRecords ?? 0) > 0) soft.push('spool_backlog');
  if ((metrics.outstandingOldestAgeMs ?? 0) >= 30_000) soft.push('delivery_backlog_aged');
  return hard.length
    ? { severity: 2, reasons: hard }
    : soft.length
      ? { severity: 1, reasons: soft }
      : { severity: 0, reasons: [] };
}

function controlEvaluation(heartbeat: T.CollectorHeartbeatRecord): CollectorChannelEvaluation {
  const metrics = heartbeat.filterMetrics ?? {} as T.CollectorFilterMetrics;
  const reasons: string[] = [];
  if (metrics.controlPlaneState === 'degraded') {
    reasons.push(...(metrics.controlPlaneFailedLanes ?? []).map((lane) => `control_${lane}_failed`));
    if (!reasons.length) reasons.push('control_plane_degraded');
  }
  if (metrics.controlPlaneState === 'starting') reasons.push('control_plane_starting');
  if (metrics.controlPlaneState === undefined && heartbeat.errorCount > 0) reasons.push('legacy_forwarder_error');
  if (metrics.captureProfileControlPlaneState === 'lkg_degraded') reasons.push('capture_profile_lkg_degraded');
  if (metrics.unifiedProjectionState === 'degraded') reasons.push('filter_projection_degraded');
  if (metrics.controlPlaneLanes?.identity && !metrics.identitySnapshotReady) reasons.push('identity_snapshot_not_ready');
  return { severity: reasons.includes('capture_profile_lkg_degraded') ? 2 : reasons.length ? 1 : 0, reasons };
}

export function resolvedClassificationView(
  filter: Pick<T.SecurityTimeFilter, 'classificationView'>,
): T.ClassificationView {
  return filter.classificationView === 'current_effective' ? 'current_effective' : 'as_observed';
}

function processStartKey(process: T.ProcessContext | undefined): string | undefined {
  return process?.startTimeTicks
    ? `ticks:${process.startTimeTicks}`
    : process?.startTimeNs
      ? `ns:${process.startTimeNs}`
      : undefined;
}

/**
 * Coarse, strong-process prefilter for the hot-ring ToolEvidence fallback.
 *
 * This only limits which facts reach the bounded linker; it never establishes a link. Resource or
 * command equality, root generation, time bounds, trust authority, and ambiguity rejection remain
 * enforced by buildToolEvidenceBundle().
 */
function toolKernelEventInProcessScope(
  event: T.JudgedEvent,
  scopes: readonly NonNullable<T.JudgedEvent['process']>[],
): boolean {
  if (!TOOL_KERNEL_EVENT_KINDS.has(event.eventKind) || !event.process?.bootId) return false;
  const eventStart = processStartKey(event.process);
  return scopes.some((scope) => {
    if (!scope.bootId || event.process!.bootId !== scope.bootId) return false;
    const scopeStart = processStartKey(scope);
    const sameHostProcess = Boolean(
      eventStart && scopeStart && eventStart === scopeStart &&
      event.process!.hostId && scope.hostId && event.process!.hostId === scope.hostId &&
      event.process!.pid === scope.pid,
    );
    const hostDirectChild = Boolean(
      event.process!.hostId && scope.hostId && event.process!.hostId === scope.hostId &&
      Number.isSafeInteger(scope.pid) && event.process!.ppid === scope.pid,
    );
    const sameNamespaceProcess = Boolean(
      eventStart && scopeStart && eventStart === scopeStart &&
      event.process!.pidNamespace && scope.pidNamespace &&
      event.process!.pidNamespace === scope.pidNamespace &&
      Number.isSafeInteger(scope.namespacePid) && event.process!.namespacePid === scope.namespacePid,
    );
    const namespaceDirectChild = Boolean(
      event.process!.pidNamespace && scope.pidNamespace &&
      event.process!.pidNamespace === scope.pidNamespace &&
      Number.isSafeInteger(scope.namespacePid) && event.process!.namespacePpid === scope.namespacePid,
    );
    return sameHostProcess || hostDirectChild || sameNamespaceProcess || namespaceDirectChild;
  });
}

export const toolEvidenceHotPathTesting = { toolKernelEventInProcessScope };

export interface ReusableFactSlices {
  fullStartMs: number;
  fullEndExclusiveMs: number;
  head?: { startMs: number; endMs: number };
  tail?: { startMs: number; endMs: number };
}

/**
 * Split the persisted closed interval into exact partial boundaries and reusable full buckets.
 *
 * Public Dashboard snapshots carry millisecond precision and are almost never bucket-aligned.
 * Refusing those ranges silently disabled the Agent, Workspace and topology caches. The split
 * preserves the exact closed-interval contract without letting a partial bucket enter the cache.
 */
export function reusableFactSlices(
  startMs: number,
  persistedUntilMs: number,
  hotFromMs: number,
  bucketMs = REUSABLE_BUCKET_MS,
): ReusableFactSlices {
  const size = Math.max(1, Math.trunc(bucketMs));
  const endExclusiveMs = Math.max(startMs, persistedUntilMs + 1);
  const firstFullBucket = Math.ceil(startMs / size) * size;
  const safeFullEnd = Math.min(
    Math.floor(endExclusiveMs / size) * size,
    Math.floor(hotFromMs / size) * size,
  );
  const fullEndExclusiveMs = Math.max(firstFullBucket, safeFullEnd);
  const headEndMs = Math.min(persistedUntilMs, firstFullBucket - 1);
  const tailStartMs = Math.max(startMs, fullEndExclusiveMs);
  return {
    fullStartMs: firstFullBucket,
    fullEndExclusiveMs,
    head: startMs <= headEndMs ? { startMs, endMs: headEndMs } : undefined,
    tail: tailStartMs <= persistedUntilMs
      ? { startMs: tailStartMs, endMs: persistedUntilMs }
      : undefined,
  };
}

export class BoundedHistoryQueryGate {
  private active = 0;
  private rejected = 0;

  constructor(private readonly concurrency: number) {}

  async run<V>(operation: () => Promise<V>): Promise<V | null> {
    if (this.active >= this.concurrency) {
      this.rejected += 1;
      return null;
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }

  status(): { active: number; concurrency: number; rejected: number } {
    return { active: this.active, concurrency: this.concurrency, rejected: this.rejected };
  }
}

const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const distinct = <V>(xs: V[]) => new Set(xs).size;
function mode(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function agentInventoryGroupKey(agentAssetId: string, agentInstanceId: string): string {
  return `${agentAssetId}\0${agentInstanceId}`;
}
function worstCriticality(values: Array<T.AgentCriticality | undefined>): T.AgentCriticality | undefined {
  const rank: Record<T.AgentCriticality, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  return values
    .filter((value): value is T.AgentCriticality => Boolean(value))
    .sort((a, b) => rank[b] - rank[a])[0];
}

function levelByRank(rank: number): { level: string; text: string } {
  const level = LEVEL_BY_RANK[Math.max(0, Math.min(4, rank))];
  return { level, text: LEVEL_TEXT[level] };
}
function worstLevel(events: T.JudgedEvent[]): { level: string; text: string } {
  const risky = events.filter((e) => e.verdict !== 'allow');
  if (!risky.length) return { level: 'safe', text: LEVEL_TEXT.safe };
  return levelByRank(Math.max(...risky.map((e) => SEV_RANK[e.severity])));
}
function fmtTokens(n: number): { total: number; unit: string } {
  if (n >= 1e9) return { total: round1(n / 1e9), unit: 'G' };
  if (n >= 1e6) return { total: round1(n / 1e6), unit: 'M' };
  if (n >= 1e3) return { total: round1(n / 1e3), unit: 'K' };
  return { total: n, unit: '' };
}

function eventCategory(kind: string): T.EventCategory {
  if (kind === 'ToolExec') return 'tool';
  if (kind === 'Egress' || kind === 'Dns' || kind === 'SslContent') return 'network';
  if (kind === 'FileAccess' || kind === 'FileDelete') return 'file';
  if (kind === 'LlmCall' || kind === 'LlmApi' || kind === 'LlmInteraction' || kind === 'AgentPlaintextEvidence') return 'llm';
  if (kind === 'SecurityAction') return 'security';
  if (kind === 'ProcessExit') return 'process';
  if (kind === 'RuntimeEvent') return 'runtime';
  return 'unknown';
}

function nodeId(type: T.TopologyNodeType, key: string): string {
  return `${type}:${key.slice(0, 240)}`;
}

function edgeId(sourceNodeId: string, targetNodeId: string, type: T.TopologyEdgeType): string {
  return `${type}:${sourceNodeId}->${targetNodeId}`;
}

function attrString(e: T.JudgedEvent, key: string): string {
  const value = e.attributes[key];
  return value == null ? '' : String(value).trim();
}

function isMonitoredAgentEvent(e: T.JudgedEvent): boolean {
  return e.attribution?.monitored === true;
}

function canonicalAgentName(value?: string): string | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text === 'a3s' || text === 'a3s-code' || text === 'a3s code') return 'a3s code';
  if (text === 'claude' || text === 'claude-code' || text === 'claude code') return 'Claude Code';
  return text;
}

function attributionWorkspacePath(e: T.JudgedEvent): string {
  if (!isMonitoredAgentEvent(e)) return e.workspacePath;
  const cwd = e.process?.cwd?.trim();
  if (cwd) return cwd;
  const scope = canonicalAgentName(e.attribution?.agentScopeId);
  return scope ? `agent://${scope}` : e.workspacePath;
}

function eventAgentLabel(e: T.JudgedEvent): string {
  return canonicalAgentName(e.attribution?.agentDisplayName) ?? canonicalAgentName(e.attribution?.agentScopeId) ?? e.agentId;
}

function eventSessionLabel(e: T.JudgedEvent): string {
  return e.attribution?.agentSessionId?.trim() || eventAgentLabel(e);
}

function dashboardFactForEvent(e: T.JudgedEvent): DashboardAggregateBucketFact {
  const final = e.decisionStatus !== undefined && FINAL_DECISION_STATUSES.has(e.decisionStatus);
  const risky = e.verdict !== 'allow';
  return {
    bucketStartMs: Math.floor(e.at / REUSABLE_BUCKET_MS) * REUSABLE_BUCKET_MS,
    monitored: isMonitoredAgentEvent(e),
    decisionStatus: e.decisionStatus ?? '',
    verdict: e.verdict,
    tier: e.tier,
    riskType: e.riskType,
    riskCategory: e.riskCategory,
    riskName: e.riskName,
    severityRank: SEV_RANK[e.severity],
    sessionKey: eventSessionLabel(e),
    userId: e.userId,
    workspacePath: attributionWorkspacePath(e),
    eventCount: 1,
    blockedCount: final && e.verdict === 'block' ? 1 : 0,
    escalatedCount: final && e.verdict === 'escalate' ? 1 : 0,
    l2Count: final && (e.tier === 'Llm' || e.tier === 'Agent') ? 1 : 0,
    l3Count: final && e.tier === 'Agent' ? 1 : 0,
    riskActivationCount: final && risky ? 1 : 0,
    riskyEventCount: risky ? 1 : 0,
    tokenCount: final ? e.tokenCount : 0,
    latencyTotal: final ? e.latencyMs : 0,
    riskScoreTotal: final ? e.riskScore : 0,
    lastEventAt: e.at,
    commandDangerCount: risky && e.riskCategory === 'command_danger' ? 1 : 0,
    promptInjectionCount: risky && e.riskCategory === 'prompt_injection' ? 1 : 0,
    dataLeakCount: risky && (e.riskCategory === 'data_leak' || e.riskCategory === 'secret_exfil') ? 1 : 0,
    communicationRiskCount: risky && e.riskCategory === 'communication_risk' ? 1 : 0,
    systemicRiskCount: risky && (
      e.riskCategory === 'systemic_risk' ||
      e.riskCategory === 'privilege_escalation'
    ) ? 1 : 0,
  };
}

function isLoopbackPeer(peer: string): boolean {
  return peer === '127.0.0.1' || peer === '::1' || peer === 'localhost';
}

function normalizedCommand(e: T.JudgedEvent): string {
  return (attrString(e, 'argv') || e.subject).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isLowValueAgentNoise(e: T.JudgedEvent): boolean {
  if (!isMonitoredAgentEvent(e)) return false;
  if (e.verdict !== 'allow' || e.riskScore > 0) return false;
  if (e.eventKind === 'ProcessExit') return true;
  if (e.eventKind === 'Egress') {
    const peer = attrString(e, 'peer');
    const port = Number(attrString(e, 'port'));
    return isLoopbackPeer(peer) && (port === 7890 || port === 29653);
  }
  if (e.eventKind !== 'ToolExec') return false;
  const cmd = normalizedCommand(e);
  const exactNoise = new Set([
    'getconf long_bit',
    'lsb_release -a',
    'hostname -i',
    'who',
    'tr [:upper:] [:lower:]',
    'cut -c2-',
  ]);
  return exactNoise.has(cmd) || cmd === 'uname' || cmd.startsWith('uname ');
}
function eventCollectorId(e: T.JudgedEvent): string {
  return e.collectorId?.trim() || attrString(e, 'collectorId');
}

function requiresCollectorCoverage(e: T.JudgedEvent): boolean {
  // SDK/Adapter semantic facts deliberately reach the API without traversing the eBPF Collector.
  // Kernel/observer facts still require collector provenance; exempting only the closed semantic
  // kinds prevents a healthy dual-source Agent from generating a false partial-coverage alert.
  return e.eventKind !== 'AgentTool'
    && e.eventKind !== 'AgentInvocation'
    && e.eventKind !== 'SystemContext';
}

function missingCollectorCoverage(e: T.JudgedEvent): boolean {
  return requiresCollectorCoverage(e) && !eventCollectorId(e);
}

function eventSourceId(e: T.JudgedEvent): string {
  return e.sourceId?.trim() || attrString(e, 'sourceId');
}

function durableEventSearchKey(filter: T.AgentEventQuery, reviewRevision = 0): string {
  const text = (value?: string): string => value?.trim() ?? '';
  return JSON.stringify({
    timeType: filter.timeType ?? 'last_3h',
    // Preserve the raw custom boundaries: a date-only end includes the whole day, while an ISO
    // midnight ends at that instant even though Date.parse yields the same millisecond value.
    startTime: filter.startTime ?? '',
    endTime: filter.endTime ?? '',
    snapshotAsOf: filter.snapshotAsOf ?? '',
    // Omitted scope compacts events; explicit raw scope does not, so these are not equivalent.
    scope: filter.scope ?? '',
    classificationView: resolvedClassificationView(filter),
    reviewRevision,
    includeUnknown: filter.includeUnknown !== false,
    noise: filter.noise ?? 'hide',
    eventId: text(filter.eventId),
    sourceId: text(filter.sourceId),
    collectorId: text(filter.collectorId),
    agentId: text(filter.agentId),
    agentAssetId: text(filter.agentAssetId),
    subjectAssetId: text(filter.subjectAssetId),
    agentInstanceId: text(filter.agentInstanceId),
    sessionId: text(filter.sessionId),
    workspacePath: text(filter.workspacePath),
    traceId: text(filter.traceId),
    invocationId: correlationCaptureRollout().trustedCorrelation === 'off'
      ? ''
      : text(filter.invocationId),
    toolCallId: correlationCaptureRollout().trustedCorrelation === 'off'
      ? ''
      : text(filter.toolCallId),
    runId: text(filter.runId),
    // eventKind and limit are used without text/round normalization by filterEvents/slice.
    eventKind: filter.eventKind ?? '',
    eventCategory: filter.eventCategory ?? '',
    activityContext: filter.activityContext ?? '',
    verdict: filter.verdict ?? '',
    tier: filter.tier ?? '',
    q: text(filter.q).toLowerCase(),
    limit: String(filter.limit ?? 40),
  });
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function commandName(argv: string): string {
  const first = argv.trim().split(/\s+/)[0] ?? '';
  return first.includes('/') ? basename(first) : first;
}

function compactEventKey(e: T.JudgedEvent): string {
  const agent = eventAgentLabel(e);
  const command = e.eventKind === 'ToolExec' ? normalizedCommand(e) : '';
  const peer = e.eventKind === 'Egress' ? attrString(e, 'peer') + ':' + attrString(e, 'port') : '';
  const file = e.eventKind === 'FileAccess' || e.eventKind === 'FileDelete' ? attrString(e, 'path') : '';
  const subject = command || peer || file || e.subject;
  return [
    agent,
    e.eventKind,
    eventActivityContext(e) ?? '',
    eventActivitySubtype(e) ?? '',
    e.verdict,
    e.riskCategory,
    subject,
  ].join('\0');
}

function compactEvents(events: T.JudgedEvent[]): Array<{ event: T.JudgedEvent; repeatCount: number; lastAt: number }> {
  const out: Array<{ event: T.JudgedEvent; repeatCount: number; lastAt: number }> = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last && compactEventKey(last.event) === compactEventKey(event) && Math.abs(last.lastAt - event.at) <= COMPACT_WINDOW_MS) {
      last.repeatCount += 1;
      last.lastAt = Math.max(last.lastAt, event.at);
      if (event.riskScore > last.event.riskScore || event.at > last.event.at) last.event = event;
      continue;
    }
    out.push({ event, repeatCount: 1, lastAt: event.at });
  }
  return out;
}

function topologyTarget(e: T.JudgedEvent): { type: T.TopologyNodeType; key: string; label: string; subtitle?: string; edgeType: T.TopologyEdgeType; edgeLabel: string } | null {
  if (eventActivityContext(e) === 'platform_healthcheck') return null;
  if (e.eventKind === 'ToolExec') {
    const argv = attrString(e, 'argv') || e.subject;
    const cmd = commandName(argv) || 'exec';
    return { type: 'tool', key: cmd, label: cmd, subtitle: argv.slice(0, 120), edgeType: 'executes', edgeLabel: '执行' };
  }
  if (e.eventKind === 'Egress') {
    const peer = attrString(e, 'peer') || e.subject.replace(/^egress\s*→\s*/i, '');
    const port = attrString(e, 'port');
    const label = port && !peer.includes(':') ? `${peer}:${port}` : peer;
    return { type: 'network', key: label || 'unknown-egress', label: label || 'unknown-egress', subtitle: 'egress', edgeType: 'connects', edgeLabel: '连接' };
  }
  if (e.eventKind === 'Dns') {
    const query = attrString(e, 'query') || e.subject.replace(/^dns\s*/i, '');
    return { type: 'network', key: query || 'unknown-dns', label: query || 'unknown-dns', subtitle: 'dns', edgeType: 'resolves', edgeLabel: '解析' };
  }
  if (e.eventKind === 'FileAccess' || e.eventKind === 'FileDelete') {
    const path = attrString(e, 'path') || e.actionTarget || e.subject.replace(/^file\s*/i, '');
    return { type: 'file', key: path || 'unknown-file', label: basename(path || 'unknown-file'), subtitle: path, edgeType: 'accesses', edgeLabel: e.eventKind === 'FileDelete' ? '删除' : '访问' };
  }
  if (e.eventKind === 'LlmCall' || e.eventKind === 'LlmApi') {
    const endpoint = attrString(e, 'sni') || attrString(e, 'peer') || attrString(e, 'query') || e.subject.replace(/^llm\s*/i, '');
    return { type: 'llm', key: endpoint || 'unknown-llm', label: endpoint || 'unknown-llm', subtitle: e.eventKind, edgeType: 'calls_llm', edgeLabel: '调用' };
  }
  if (e.eventKind === 'SecurityAction' || e.eventCategory === 'security') {
    const label = e.actionKind || e.riskName || e.subject;
    return { type: 'security', key: label || e.riskCategory, label: label || e.riskCategory, subtitle: e.reason, edgeType: 'triggers', edgeLabel: '触发' };
  }
  return null;
}

function compactIssueId(type: T.CoverageIssueType, ...parts: Array<string | number | undefined>): string {
  return `cov_${type}_${parts.join('_')}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 140);
}

type SimulatedDecision = { verdict: string; tier: string; severity: string; reason: string };

function normalizeSimulationDecision(decision: SimulatedDecision | null): T.PolicySimulationDecision {
  if (!decision) return { verdict: 'allow', tier: 'Rules', severity: 'info', reason: 'observed' };
  let verdict = decision.verdict as T.Verdict;
  if (verdict === 'allow' && decision.reason.includes('unresolved escalation')) verdict = 'escalate';
  return {
    verdict,
    tier: decision.tier as T.Tier,
    severity: decision.severity as T.Severity,
    reason: decision.reason,
  };
}

function simulationChange(current: T.PolicySimulationDecision, simulated: T.PolicySimulationDecision): T.PolicySimulationChangeType | null {
  if (current.verdict !== 'block' && simulated.verdict === 'block') return 'new_block';
  if (current.verdict === 'block' && simulated.verdict !== 'block') return 'removed_block';
  if (current.verdict === 'allow' && simulated.verdict === 'escalate') return 'new_escalation';
  if (current.verdict === 'escalate' && simulated.verdict === 'allow') return 'removed_escalation';
  if (SEV_RANK[simulated.severity] > SEV_RANK[current.severity]) return 'severity_increase';
  if (SEV_RANK[simulated.severity] < SEV_RANK[current.severity]) return 'severity_decrease';
  if (current.verdict !== simulated.verdict || current.tier !== simulated.tier) return 'verdict_changed';
  return null;
}

@Injectable()
export class AggregationService {
  constructor(
    private readonly judge: SentryJudgeService,
    private readonly agentMetadata: AgentMetadataService,
    private readonly workspaceDirectory: WorkspaceDirectoryService,
    private readonly maintenance: MaintenanceWindowService,
    private readonly sources: IngestionSourceService,
    @Optional() private readonly assetReviews?: ObservedAssetReviewService,
    @Optional() private readonly conversationBindings?: AgentConversationBindingService,
  ) {}

  // The dashboard polls 9 endpoints with the same filter near-simultaneously; cache the windowed
  // scan for a beat so they share one pass over the 100k ring instead of nine (keeps latency flat).
  private readonly winCache = new Map<string, { at: number; val: ReturnType<AggregationService['computeWin']> }>();
  private readonly historyCache = new Map<string, {
    startedAt: number;
    completedAt?: number;
    failedAt?: number;
    ttlMs: number;
    value: Promise<DashboardWindowHistory | null>;
  }>();
  private readonly agentInstanceMetricsCache = new Map<string, {
    at: number;
    value: T.AgentInstanceMetrics;
  }>();
  private readonly agentInventoryInFlight = new Map<string, Promise<T.AgentInventory>>();
  private readonly agentObservabilityInFlight = new Map<string, Promise<T.AgentObservability>>();
  private readonly agentObservabilityRecent = new Map<string, T.AgentObservability>();
  private dashboardHistoryBuckets?: DashboardHistoryBucketCache;
  private readonly agentHistoryBuckets = new Map<
    'agent' | 'all',
    CommitAwareFactBucketCache<StoredAgentBucketFact>
  >();
  private readonly topologyHistoryBuckets = new Map<
    'agent' | 'all',
    CommitAwareFactBucketCache<StoredTopologyBucketFact>
  >();
  private readonly workspaceHistoryBuckets = new Map<
    'agent' | 'all',
    CommitAwareFactBucketCache<StoredWorkspaceBucketFact>
  >();
  // A cold page can request several historical fact families together. Keep those ClickHouse
  // aggregates bounded while leaving ingestion and small boundary reads unconstrained.
  // One exact window may need stable/head/tail reads concurrently. Four slots let one request
  // complete without self-rejection while still bounding cross-page ClickHouse pressure.
  private readonly historyQueryGate = new BoundedHistoryQueryGate(4);
  private readonly agentInventoryLastGood = new Map<string, { at: number; value: T.AgentInventory }>();
  // Two identical HTTP requests otherwise resolve a preset window at slightly different
  // milliseconds and miss the ClickHouse store's exact-query single-flight key. Coalesce the
  // complete durable response by request semantics before either request samples Date.now().
  private durableEventSearchInFlight?: {
    key: string;
    value: Promise<T.AgentEventList>;
  };
  private readonly interactionHot = new Map<string, { record: T.AgentInteractionRecord; bytes: number }>();
  private interactionHotBytes = 0;
  private readonly interactionHotMaxRecords = 2_000;
  private readonly interactionHotMaxBytes = 64 * 1024 * 1024;

  historyFactCacheStatus() {
    const agents = [...this.agentHistoryBuckets.entries()].map(([scope, cache]) => ({
      scope,
      ...cache.stats(),
    }));
    const workspaces = [...this.workspaceHistoryBuckets.entries()].map(([scope, cache]) => ({
      scope,
      ...cache.stats(),
    }));
    const topology = [...this.topologyHistoryBuckets.entries()].map(([scope, cache]) => ({
      scope,
      ...cache.stats(),
    }));
    const caches = [
      ...(this.dashboardHistoryBuckets
        ? [{ name: 'dashboard', ...this.dashboardHistoryBuckets.stats() }]
        : []),
      ...agents.map((stats) => ({ name: `agents:${stats.scope}`, ...stats })),
      ...workspaces.map((stats) => ({ name: `workspaces:${stats.scope}`, ...stats })),
      ...topology.map((stats) => ({ name: `topology:${stats.scope}`, ...stats })),
    ];
    return {
      schemaVersion: 'anysentry.history-cache.v1',
      caches,
      totals: caches.reduce(
        (total, cache) => ({
          buckets: total.buckets + cache.buckets,
          facts: total.facts + cache.facts,
          estimatedBytes: total.estimatedBytes + cache.estimatedBytes,
          evictions: total.evictions + cache.evictions,
          budgetRejects: total.budgetRejects + cache.budgetRejects,
          journalResets: total.journalResets + cache.journalResets,
        }),
        {
          buckets: 0,
          facts: 0,
          estimatedBytes: 0,
          evictions: 0,
          budgetRejects: 0,
          journalResets: 0,
        },
      ),
    };
  }

  invalidateWindowCache(): void {
    this.winCache.clear();
    // Ingestion invalidates the millisecond-scale hot-ring cache, but must not cancel or discard a
    // multi-second ClickHouse history query. Historical snapshots intentionally refresh on their
    // own short TTL; clearing them for every event creates a query storm at observer throughput.
  }

  private history(filter: T.SecurityTimeFilter): Promise<DashboardWindowHistory | null> {
    const window = resolveTimeWindow(filter);
    const t = now();
    const ttlMs = window.custom
      ? 5 * 60_000
      : window.spanMs >= 7 * 24 * 60 * 60_000
        ? 5 * 60_000
        : window.spanMs >= 24 * 60 * 60_000
          ? 60_000
          : 30_000;
    pruneSnapshotCache(this.historyCache, t, (entry) => entry.failedAt ? 30_000 : entry.ttlMs);
    const cached = this.historyCache.get(window.cacheKey);
    const cachedTtlMs = cached?.failedAt ? 30_000 : ttlMs;
    if (cached && (cached.completedAt === undefined || t - cached.completedAt < cachedTtlMs)) {
      // Refresh insertion order so completed entries are evicted least-recently-used.
      this.historyCache.delete(window.cacheKey);
      this.historyCache.set(window.cacheKey, cached);
      return cached.value;
    }
    if (cached) this.historyCache.delete(window.cacheKey);
    while (this.historyCache.size >= MAX_HISTORY_CACHE_ENTRIES) {
      const completedKey = [...this.historyCache].find(([, entry]) => entry.completedAt !== undefined)?.[0];
      if (!completedKey) return Promise.resolve(null);
      this.historyCache.delete(completedKey);
    }
    const value = this.loadDashboardHistory(window);
    const entry = {
      startedAt: t,
      completedAt: undefined as number | undefined,
      failedAt: undefined as number | undefined,
      ttlMs,
      value,
    };
    this.historyCache.set(window.cacheKey, entry);
    void value.then((result) => {
      if (this.historyCache.get(window.cacheKey)?.value !== value) return;
      entry.completedAt = now();
      if (!result) entry.failedAt = entry.completedAt;
    });
    return value;
  }

  private async loadDashboardHistory(window: ReturnType<typeof resolveTimeWindow>): Promise<DashboardWindowHistory | null> {
    // The reusable cache currently targets the high-frequency preset ranges whose two-window
    // footprint is bounded. Long/custom investigations retain the exact legacy query until their
    // own persisted aggregate tables are available.
    if (!window.custom && window.spanMs <= 24 * HOUR) {
      if (Math.ceil((window.spanMs * 2) / REUSABLE_BUCKET_MS) > DASHBOARD_EXACT_COMPARISON_MAX_BUCKETS) {
        // The current and previous comparison periods would exceed the bounded factsJson read.
        // Return partial before even materialising the 10-second durable tail; the hot ring already
        // covers that overlap during healthy ingestion.
        return null;
      }
      this.dashboardHistoryBuckets ??= new DashboardHistoryBucketCache({
        latestCursor: () => this.judge.latestEventCommitCursor(),
        earliestCursor: () => this.judge.earliestEventCommitCursor(),
        changes: (after) => this.judge.eventCommitChanges(after),
        facts: (startMs, endExclusiveMs, bucketMs) =>
          this.historyQueryGate.run(() =>
            this.judge.dashboardAggregateBucketFacts(startMs, endExclusiveMs, bucketMs),
          ),
      });
      const tailStartMs = Math.max(
        window.startMs,
        Math.floor((window.endMs - DASHBOARD_HOT_TAIL_MS) / REUSABLE_BUCKET_MS) *
          REUSABLE_BUCKET_MS,
      );
      try {
        const [persistedTail, hotTail] = await Promise.all([
          this.judge.dashboardTailEvents(tailStartMs, window.endMs),
          Promise.resolve(this.judge.queryRange(tailStartMs, window.endMs)),
        ]);
        if (persistedTail === null) throw new Error('persisted dashboard tail unavailable');
        const tailFacts = foldLatestEventRevisions([...persistedTail, ...hotTail])
          .filter((event) => event.at >= tailStartMs && event.at <= window.endMs)
          .map(dashboardFactForEvent);
        const history = await this.dashboardHistoryBuckets.readWithTail(
          window.startMs,
          window.endMs,
          180,
          tailStartMs,
          tailFacts,
        );
        if (history) return history;
      } catch (error) {
        console.warn(
          `[dashboard] reusable history unavailable; using bounded hot fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // A failed reusable read has already consumed the bounded historical-query budget. The
      // caller explicitly falls back to its bounded hot view; launching a second full-window scan
      // in the same request would turn storage pressure into an API availability failure.
      return null;
    }
    return this.exactDashboardHistory(window);
  }

  private exactDashboardHistory(
    window: ReturnType<typeof resolveTimeWindow>,
  ): Promise<DashboardWindowHistory | null> {
    const operation = () => this.judge.dashboardWindowHistory(window.startMs, window.endMs, 180);
    const latestEventCommitCursor = (
      this.judge as Partial<Pick<SentryJudgeService, 'latestEventCommitCursor'>>
    ).latestEventCommitCursor;
    // Production exposes the durable commit journal and shares the two-slot historical-query
    // budget across dashboard, Agent, workspace and topology aggregates. Minimal/legacy judge
    // adapters have only the already-bounded dashboard query; call that adapter directly so its
    // own single-flight/cache contract remains observable and compatible.
    return typeof latestEventCommitCursor === 'function'
      ? this.historyQueryGate.run(operation)
      : operation();
  }

  private currentDimensions(history: DashboardWindowHistory, filter: T.SecurityTimeFilter): DashboardWindowDimensionRow[] {
    const agentScoped = filter.scope === 'agent';
    return history.dimensions.filter((row) => row.period === 'current' && (!agentScoped || row.monitored));
  }

  private aggregateHistoryBuckets(history: DashboardWindowHistory, filter: T.SecurityTimeFilter, count: number): DashboardWindowBucketRow[] {
    const agentScoped = filter.scope === 'agent';
    const size = 180;
    const out: DashboardWindowBucketRow[] = Array.from({ length: count }, (_, bucketIndex) => ({
      bucketIndex,
      monitored: agentScoped,
      eventCount: 0,
      blockedCount: 0,
      escalatedCount: 0,
      l2Count: 0,
      l3Count: 0,
      riskActivationCount: 0,
      tokenCount: 0,
      latencyTotal: 0,
      riskScoreTotal: 0,
    }));
    for (const row of history.buckets) {
      if (agentScoped && !row.monitored) continue;
      const index = Math.min(count - 1, Math.floor((row.bucketIndex * count) / size));
      const target = out[index];
      target.eventCount += row.eventCount;
      target.blockedCount += row.blockedCount;
      target.escalatedCount += row.escalatedCount;
      target.l2Count += row.l2Count;
      target.l3Count += row.l3Count;
      target.riskActivationCount += row.riskActivationCount;
      target.tokenCount += row.tokenCount;
      target.latencyTotal += row.latencyTotal;
      target.riskScoreTotal += row.riskScoreTotal;
    }
    return out;
  }

  private win(filter: T.SecurityTimeFilter): { events: T.JudgedEvent[]; sinceMs: number; spanMs: number; dataSinceMs: number; dataSpanMs: number } {
    const window = resolveTimeWindow(filter);
    const key = window.cacheKey;
    const cached = this.winCache.get(key);
    const t = now();
    if (cached && t - cached.at < 1500) return cached.val;
    const val = this.computeWin(window.startMs, window.endMs);
    this.winCache.set(key, { at: t, val });
    return val;
  }

  private computeWin(sinceMs: number, endMs: number): { events: T.JudgedEvent[]; sinceMs: number; spanMs: number; dataSinceMs: number; dataSpanMs: number } {
    const queryRange = (this.judge as SentryJudgeService & {
      queryRange?: (startMs: number, untilMs: number) => T.JudgedEvent[];
    }).queryRange;
    const events = typeof queryRange === 'function'
      ? queryRange.call(this.judge, sinceMs, endMs)
      : this.judge.query(sinceMs).filter((event) => event.at <= endMs);
    // The in-memory ring may hold less time than the nominal window. Time-series/rate panels must
    // bucket over the data that actually exists, or everything piles into one bucket (req=100000).
    const dataSinceMs = events.length ? events[0].at : sinceMs;
    return { events, sinceMs, spanMs: endMs - sinceMs, dataSinceMs, dataSpanMs: Math.max(1, endMs - dataSinceMs) };
  }

  // bucketed counts over the window (for time-series + rate panels)
  private buckets(events: T.JudgedEvent[], sinceMs: number, spanMs: number, n: number): T.JudgedEvent[][] {
    const size = spanMs / n || 1;
    const out: T.JudgedEvent[][] = Array.from({ length: n }, () => []);
    for (const e of events) {
      const i = Math.min(n - 1, Math.max(0, Math.floor((e.at - sinceMs) / size)));
      out[i].push(e);
    }
    return out;
  }

  healthCard(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityHealthCard {
    const windowEvents = overlay?.events ?? this.win(filter).events;
    const events = overlay ? windowEvents : this.scopedEventsForView(windowEvents, filter);
    const total = events.length || 1;
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const escalated = events.filter((e) => e.verdict === 'escalate').length;
    const score = Math.max(1, Math.min(100, Math.round(100 - (blocked / total) * 60 - (escalated / total) * 25)));
    const text = score >= 90 ? '健康' : score >= 75 ? '良好' : score >= 60 ? '注意' : score >= 40 ? '风险偏高' : '高危';
    const tok = fmtTokens(events.reduce((a, e) => a + e.tokenCount, 0));
    return {
      healthScore: score,
      healthStatusText: text,
      tokenConsumptionTotal: tok.total,
      tokenConsumptionUnit: tok.unit,
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
    };
  }

  explainabilityScan(
    filter: T.ExplainabilityScanRequest,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityExplainabilityScan {
    const window = resolveTimeWindow(filter);
    const windowed = this.win(filter);
    const windowEvents = overlay?.events ?? windowed.events;
    const events = overlay ? windowEvents : this.scopedEventsForView(windowEvents, filter);
    const dataSinceMs = overlay ? window.startMs : windowed.dataSinceMs;
    const dataSpanMs = overlay ? window.spanMs : windowed.dataSpanMs;
    const n = Math.max(8, Math.min(72, filter.seriesPoints ?? 24));
    const size = dataSpanMs / n || 1;
    const buckets = this.buckets(events, dataSinceMs, dataSpanMs, n);
    const safeSeries: T.WaveSeriesPoint[] = [];
    const riskSeries: T.WaveSeriesPoint[] = [];
    buckets.forEach((b, i) => {
      const statTime = iso(dataSinceMs + i * size);
      const avgRisk = mean(b.map((e) => e.riskScore));
      riskSeries.push({ statTime, value: Math.round(avgRisk), activationCount: b.filter((e) => e.verdict !== 'allow').length });
      safeSeries.push({ statTime, value: Math.round(100 - avgRisk), activationCount: b.length });
    });
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const recent = events.filter((e) => e.at >= now() - 5 * 60_000);
    return {
      waveSeries: [{ safeSeries, riskSeries }],
      threatInterception: `${round1((blocked / (events.length || 1)) * 100)}%`,
      sessionActiveCount: String(distinct(recent.map((e) => e.sessionId))),
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  private classificationResponseMeta(filter: T.SecurityTimeFilter): {
    classificationView: T.ClassificationView;
    reviewRevision: number;
  } {
    return {
      classificationView: resolvedClassificationView(filter),
      reviewRevision: Math.min(
        Number.MAX_SAFE_INTEGER,
        this.agentMetadata.identitySnapshotVersion() + (this.assetReviews?.version() ?? 0),
      ),
    };
  }

  private currentEffectiveClassification(
    event: T.JudgedEvent,
    agentResolved = this.agentMetadata.resolveEvent(event),
  ): T.AgentClassification {
    const assetReview = event.subjectAssetId
      ? this.assetReviews?.current(event.subjectAssetId)
      : undefined;
    if (assetReview) return assetReview.decision;
    if (event.subjectAssetId && event.subjectAssetType && event.subjectAssetType !== 'agent') {
      // Service/Infrastructure identity is re-derived from the current asset plane after clear;
      // never reuse a historical manual non-Agent attribution as the current automatic result.
      return 'unknown';
    }
    return agentResolved.effectiveClassification;
  }

  private eventIsAgentForView(event: T.JudgedEvent, filter: T.SecurityTimeFilter): boolean {
    if (resolvedClassificationView(filter) === 'as_observed') return isMonitoredAgentEvent(event);
    return isAgentAssetClassification(this.currentEffectiveClassification(event));
  }

  private scopedEventsForView(
    events: T.JudgedEvent[],
    filter: T.SecurityTimeFilter,
    agentScoped = filter.scope === 'agent',
  ): T.JudgedEvent[] {
    return agentScoped ? events.filter((event) => this.eventIsAgentForView(event, filter)) : events;
  }

  private boundedHotDashboardOverlay(
    filter: T.SecurityTimeFilter,
    agentScoped = filter.scope === 'agent',
  ): { events: T.JudgedEvent[]; coverage: T.QueryCoverage } {
    const events = this.scopedEventsForView(this.win(filter).events, filter, agentScoped);
    return {
      events,
      coverage: this.queryCoverage(filter, events, {
        source: 'memory_hot_ring',
        totalMode: 'estimated',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
    };
  }

  private needsCurrentAgentOverlay(
    filter: T.SecurityTimeFilter,
    agentScoped = filter.scope === 'agent',
  ): boolean {
    return agentScoped && resolvedClassificationView(filter) === 'current_effective';
  }

  private async currentEffectiveOverlay(
    filter: T.SecurityTimeFilter,
    agentScoped = filter.scope === 'agent',
  ): Promise<{ events: T.JudgedEvent[]; coverage: T.QueryCoverage }> {
    const window = resolveTimeWindow(filter);
    const limit = 10_000;
    const page = this.judge.storageStatus().clickhouseReady
      ? await this.judge.searchStoredEventsPage({
          sinceMs: window.startMs,
          untilMs: window.endMs,
          monitoredOnly: false,
          limit,
        })
      : { events: [], hasMore: false, unavailable: true as const };
    const hot = this.judge.queryRange(window.startMs, window.endMs);
    const all = foldLatestEventRevisions([...(page.events ?? []), ...hot]);
    const events = this.scopedEventsForView(all, filter, agentScoped);
    const partial = page.unavailable === true || page.hasMore === true;
    return {
      events,
      coverage: this.queryCoverage(filter, events, {
        source: page.unavailable
          ? 'memory_hot_ring'
          : hot.length
            ? 'clickhouse+hot_delta'
            : 'clickhouse',
        totalMode: partial ? 'estimated' : 'exact',
        partial,
        partialReason: page.unavailable ? 'hot_ring_only' : page.hasMore ? 'scan_limit' : undefined,
        committedCutoffMs: page.committedCutoffMs,
      }),
    };
  }

  private eventItem(
    e: T.JudgedEvent,
    repeatCount = 1,
    lastAt = e.at,
    classificationView: T.ClassificationView = 'as_observed',
  ): T.AgentEventListItem {
    const detected = detectedAgentIdentity(e);
    const resolved = this.agentMetadata.resolveEvent(e);
    const asObservedClassification = detected.detectedClassification;
    const currentEffectiveClassification = this.currentEffectiveClassification(e, resolved);
    const correlationVisible = correlationCaptureRollout().trustedCorrelation !== 'off';
    const correlation = correlationVisible
      ? parseTrustedCorrelation(e.attribution?.correlation)
      : undefined;
    const classificationSemantics = visibleClassificationSemantics(e.classificationSemantics);
    const attribution = !e.attribution
      ? undefined
      : correlation
        ? { ...e.attribution, correlation }
        : (({ correlation: _hiddenCorrelation, ...legacyAttribution }) => legacyAttribution)(e.attribution);
    return {
      schemaVersion: e.schemaVersion,
      eventId: e.eventId,
      sourceEventId: e.sourceEventId,
      at: iso(e.at),
      eventAtUnixNs: e.eventAtUnixNs,
      receivedAtUnixNs: e.receivedAtUnixNs,
      receivedAt: e.receivedAt ? iso(e.receivedAt) : undefined,
      eventTimeQuality: e.eventTimeQuality,
      captureEpoch: e.captureEpoch,
      captureProfileCode: e.captureProfileCode,
      captureActionCode: e.captureActionCode,
      captureAuthorityCode: e.captureAuthorityCode,
      captureDispositionCode: e.captureDispositionCode,
      captureSelected: e.captureSelected,
      captureFlags: e.captureFlags,
      capturePolicyVersion: e.capturePolicyVersion,
      eventKind: e.eventKind,
      eventCategory: e.eventCategory,
      activityContext: eventActivityContext(e),
      activitySubtype: eventActivitySubtype(e),
      source: e.source,
      subject: e.subject,
      workspacePath: e.workspacePath,
      agentId: e.agentId,
      agentAssetId: resolved.agentAssetId,
      agentAssetAliases: resolved.agentAssetAliases,
      agentProduct: resolved.agentProduct,
      agentRuntimeInstanceId: resolved.agentRuntimeInstanceId,
      agentRuntimeInstanceAliases: resolved.agentRuntimeInstanceAliases,
      identityBindingQuality: resolved.bindingQuality,
      identityReasonCode: resolved.identityReasonCode,
      subjectAssetId: e.subjectAssetId,
      subjectAssetType: e.subjectAssetType,
      assetBindingQuality: e.assetBindingQuality,
      assetBindingRevision: e.assetBindingRevision,
      assetBindingReason: e.assetBindingReason,
      asObservedIdentityRevision: e.identityRevision,
      displayName: resolved.displayName,
      detectedName: resolved.detectedName,
      detectedClassification: resolved.detectedClassification,
      asObservedClassification,
      currentEffectiveClassification,
      effectiveClassification: classificationView === 'current_effective'
        ? currentEffectiveClassification
        : asObservedClassification,
      currentReviewRevision: resolved.reviewRevision,
      currentReviewEffectiveAt: resolved.reviewEffectiveAt !== undefined
        ? iso(resolved.reviewEffectiveAt)
        : undefined,
      runtime: detected.runtime,
      locationLabel: detected.locationLabel,
      collectorId: eventCollectorId(e) || undefined,
      sourceId: eventSourceId(e) || undefined,
      sessionId: e.sessionId,
      userId: e.userId,
      traceId: e.traceId,
      ...(correlation?.invocationId ? { invocationId: correlation.invocationId } : {}),
      ...(correlation?.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
      ...(correlation ? { correlation } : {}),
      spanId: e.spanId,
      parentSpanId: e.parentSpanId,
      runId: e.runId,
      taskId: e.taskId,
      decisionStatus: e.decisionStatus,
      evaluationId: e.evaluationId,
      policyVersion: e.policyVersion,
      decisionRevision: e.decisionRevision,
      decisionUpdatedAt: e.decisionUpdatedAt,
      verdict: e.verdict,
      tier: e.tier,
      severity: e.severity,
      reason: e.reason,
      riskCategory: e.riskCategory,
      riskName: e.riskName,
      riskType: e.riskType,
      riskScore: e.riskScore,
      tokenCount: e.tokenCount,
      latencyMs: e.latencyMs,
      attributes: e.attributes,
      ...(classificationSemantics ? { classificationSemantics } : {}),
      process: visibleProcessContext(e.process),
      attribution,
      judgment: e.judgment,
      repeatCount: repeatCount > 1 ? repeatCount : undefined,
      lastAt: repeatCount > 1 ? iso(lastAt) : undefined,
      rawPreview: e.rawPreview,
    };
  }

  private queryCoverage(
    filter: T.SecurityTimeFilter,
    events: T.JudgedEvent[],
    input: {
      source: T.QueryDataSource;
      totalMode: T.QueryTotalMode;
      partial: boolean;
      partialReason?: T.QueryCoverage['partialReason'];
      committedCutoffMs?: number;
      dataFromMs?: number;
      dataToMs?: number;
    },
  ): T.QueryCoverage {
    const window = resolveTimeWindow(filter);
    const eventTimes = events.map((event) => event.at);
    if (input.dataFromMs !== undefined) eventTimes.push(input.dataFromMs);
    if (input.dataToMs !== undefined) eventTimes.push(input.dataToMs);
    const snapshotAsOf = new Date(window.endMs).toISOString();
    const queryIdentity = filter as T.SecurityTimeFilter & {
      sourceId?: string;
      collectorId?: string;
    };
    // Standalone/local contract tests use the minimal pre-durable judge surface. Treat an absent
    // progress accessor as an empty durable-progress set; production SentryJudgeService provides
    // it, while coverage still truthfully reports the hot-ring or fallback source below.
    const committedEventProgress = (this.judge as SentryJudgeService & {
      committedEventProgress?: () => ReturnType<SentryJudgeService['committedEventProgress']>;
    }).committedEventProgress;
    const progress = relevantCommitProgress(
      typeof committedEventProgress === 'function'
        ? this.judge.committedEventProgress()
        : [],
      queryIdentity,
    );
    const observedThroughMs = observedDurableThrough(
      input.committedCutoffMs,
      progress,
    );
    const observedThrough = observedThroughMs === undefined
      ? undefined
      : new Date(Math.min(observedThroughMs, window.endMs)).toISOString();
    return {
      requestedFrom: new Date(window.startMs).toISOString(),
      requestedTo: snapshotAsOf,
      snapshotAsOf,
      asOf: snapshotAsOf,
      dataFrom: eventTimes.length ? new Date(Math.min(...eventTimes)).toISOString() : undefined,
      dataTo: eventTimes.length ? new Date(Math.max(...eventTimes)).toISOString() : undefined,
      observedDurableThrough: observedThrough,
      committedCutoff: observedThrough,
      commitBoundaryKind: observedThrough ? 'observed_durable_high_water' : undefined,
      commitProgress: progress.entries.map((entry) => ({
        sourceId: entry.sourceId,
        collectorId: entry.collectorId,
        committedEventTime: new Date(entry.committedEventTimeMs).toISOString(),
        committedAt: new Date(entry.committedAtMs).toISOString(),
      })),
      commitProgressScope: progress.scope,
      lateDataPolicy: input.source === 'memory_hot_ring'
        ? undefined
        : 'commit_journal_revision_repair',
      completeness: input.partial
        ? 'partial'
        : resolvedClassificationView(filter) === 'current_effective'
          ? 'exact_current_effective'
          : 'exact_as_observed',
      // A real event-time watermark is not yet available from every collector/partition. Do not
      // present ClickHouse's latest timestamp as a watermark.
      watermark: undefined,
      partial: input.partial,
      partialReason: input.partialReason,
      source: input.source,
      totalMode: input.totalMode,
    };
  }

  private filterEvents(events: T.JudgedEvent[], filter: T.AgentEventQuery): T.JudgedEvent[] {
    const pinnedEventId = filter.eventId?.trim();
    const sourceId = filter.sourceId?.trim();
    const collectorId = filter.collectorId?.trim();
    const agentId = filter.agentId?.trim();
    const subjectAssetId = filter.subjectAssetId?.trim();
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : undefined;
    const agentInstanceId = filter.agentInstanceId?.trim();
    const sessionId = filter.sessionId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const traceId = filter.traceId?.trim();
    const correlationVisible = correlationCaptureRollout().trustedCorrelation !== 'off';
    const invocationId = correlationVisible ? filter.invocationId?.trim() : undefined;
    const toolCallId = correlationVisible ? filter.toolCallId?.trim() : undefined;
    const runId = filter.runId?.trim();
    const q = filter.q?.trim().toLowerCase();
    const hasFilter = Boolean(sourceId || collectorId || agentId || agentAssetId || subjectAssetId || agentInstanceId || sessionId || workspacePath || traceId || invocationId || toolCallId || runId || filter.eventKind || filter.eventCategory || filter.activityContext || filter.verdict || filter.tier || q);
    const agentScoped = filter.scope === 'agent' && !pinnedEventId;
    const includeUnknown = filter.includeUnknown !== false;
    const classificationView = resolvedClassificationView(filter);
    // Process lifecycle rows remain stored for audit/debugging, but are hidden from both the
    // Agent and raw "all events" views by default. An explicit kind filter, noise=include, or a
    // pinned event still makes them accessible.
    const hideNoise = !pinnedEventId && !filter.eventKind && filter.noise !== 'include';
    return events.filter((e) => {
      const matchesEventId = Boolean(pinnedEventId && e.eventId === pinnedEventId);
      // subjectAssetId is a security/tenant-style scope, not a stale display hint. Even a pinned
      // event must satisfy it; otherwise a deep link could escape the caller's explicit Asset scope.
      if (matchesEventId && subjectAssetId && e.subjectAssetId !== subjectAssetId) return false;
      if (pinnedEventId && !hasFilter) return matchesEventId;

      const eventSource = eventSourceId(e);
      const eventCollector = eventCollectorId(e);
      const isHiddenNoise = agentScoped ? isLowValueAgentNoise(e) : e.eventKind === 'ProcessExit';
      // Exact fields are already present on the event. Reject on them before resolving display
      // metadata, which may read the manual-review registry and hash an asset identity. A scoped
      // query commonly reduces the 100k hot ring to tens of rows, so this ordering keeps event
      // search proportional to the result set without changing pinned-event semantics.
      const matchesDirectFilter =
        (!sourceId || eventSource === sourceId) &&
        (!collectorId || eventCollector === collectorId) &&
        (agentAssetId || !agentId || e.agentId === agentId) &&
        (!subjectAssetId || e.subjectAssetId === subjectAssetId) &&
        (!sessionId || e.sessionId === sessionId) &&
        (agentAssetId || !workspacePath || e.workspacePath === workspacePath) &&
        (!traceId || e.traceId === traceId) &&
        (!invocationId || (
          correlationVisible &&
          parseTrustedCorrelation(e.attribution?.correlation)?.invocationId === invocationId
        )) &&
        (!toolCallId || (
          correlationVisible &&
          parseTrustedCorrelation(e.attribution?.correlation)?.toolCallId === toolCallId
        )) &&
        (!runId || e.runId === runId) &&
        (!filter.eventKind || e.eventKind === filter.eventKind) &&
        (!filter.eventCategory || e.eventCategory === filter.eventCategory) &&
        (!filter.activityContext || eventActivityContext(e) === filter.activityContext) &&
        (!filter.verdict || e.verdict === filter.verdict) &&
        (!filter.tier || e.tier === filter.tier) &&
        (!hideNoise || !isHiddenNoise);
      if (!matchesEventId && !matchesDirectFilter) return false;

      const resolved = this.agentMetadata.resolveEvent(e);
      const visibleIdentity = classificationView === 'current_effective'
        ? this.currentEffectiveClassification(e, resolved)
        : detectedAgentIdentity(e).detectedClassification;
      const visibleClassification = agentScoped && classificationView === 'as_observed'
        // `monitored` is the legacy occurrence-time Agent membership used by dashboard facts and
        // authenticated semantic adapters. Identity classification remains an independent field:
        // an authenticated Agent may intentionally remain unknown while its evidence is retained.
        ? isMonitoredAgentEvent(e)
        : classificationView === 'current_effective' && !agentScoped
        // The current asset view must keep excluded assets inspectable. These are already-retained
        // historical facts; this does not re-admit future payloads suppressed by capture policy.
        ? true
        : isEventClassificationVisible(
            visibleIdentity,
            agentScoped ? 'agent' : 'raw',
            includeUnknown,
            matchesEventId,
          );
      const matchesScope =
        visibleClassification &&
        (!hideNoise || !isHiddenNoise);
      const matchesFilter =
        matchesScope &&
        matchesDirectFilter &&
        (!agentAssetId || resolved.agentAssetId === agentAssetId) &&
        matchesAgentRuntimeInstance(e, agentInstanceId) &&
        (
          !q ||
          [
            e.subject,
            e.agentId,
            resolved.displayName,
            resolved.detectedName,
            e.sessionId,
            e.rawPreview,
            JSON.stringify(e.attributes ?? {}),
            JSON.stringify((() => {
              if (!e.attribution) return {};
              const visibleCorrelation = correlationVisible
                ? parseTrustedCorrelation(e.attribution.correlation)
                : undefined;
              return visibleCorrelation
                ? { ...e.attribution, correlation: visibleCorrelation }
                : (({ correlation: _hiddenCorrelation, ...legacyAttribution }) => legacyAttribution)(e.attribution);
            })()),
          ].some((value) => value?.toLowerCase().includes(q))
        );
      return matchesEventId || matchesFilter;
    });
  }

  agentEvents(filter: T.AgentEventQuery): T.AgentEventList {
    const pinnedEventId = filter.eventId?.trim();
    const events = pinnedEventId ? this.judge.query(0) : this.win(filter).events;
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    const filtered = this.filterEvents(events, filter).sort((a, b) =>
      Number(Boolean(pinnedEventId) && b.eventId === pinnedEventId) - Number(Boolean(pinnedEventId) && a.eventId === pinnedEventId) ||
      b.at - a.at,
    );
    const compacted = filter.scope === 'raw' || pinnedEventId ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at })) : compactEvents(filtered);
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) =>
        this.eventItem(event, repeatCount, lastAt, resolvedClassificationView(filter))),
      total: compacted.length,
      totalMode: 'exact',
      coverage: this.queryCoverage(filter, filtered, {
        source: 'memory_hot_ring',
        totalMode: 'exact',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  agentEventsPreview(filter: T.AgentEventQuery): T.AgentEventList {
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    const scanLimit = Math.min(4_000, Math.max(800, limit * 20));
    const recent = this.judge.queryRecentRange(window.startMs, window.endMs, scanLimit);
    const filtered = this.filterEvents(recent, filter).sort((a, b) => b.at - a.at);
    const compacted = filter.scope === 'raw'
      ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at }))
      : compactEvents(filtered);
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) =>
        this.eventItem(event, repeatCount, lastAt, resolvedClassificationView(filter))),
      total: compacted.length,
      totalMode: 'estimated',
      coverage: this.queryCoverage(filter, filtered, {
        source: 'memory_hot_ring',
        totalMode: 'estimated',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async agentEventsForWindow(filter: T.AgentEventQuery): Promise<T.AgentEventList> {
    if (filter.eventId) return this.agentEvents(filter);
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    const persistedLimit = Math.max(1_000, limit * 10);
    const persisted = await this.judge.recentPersistedEvents(
      window.startMs,
      window.endMs,
      persistedLimit,
      {
        monitoredOnly: filter.scope === 'agent' && resolvedClassificationView(filter) === 'as_observed',
        tier: filter.tier,
      },
    );
    if (!persisted) {
      const fallback = this.agentEvents(filter);
      return {
        ...fallback,
        totalMode: 'estimated',
        totalApproximate: true,
        storageFallback: 'hot_ring',
        coverage: { ...fallback.coverage, totalMode: 'estimated' },
      };
    }
    const filtered = this.filterEvents(persisted, filter).sort((a, b) => b.at - a.at);
    const compacted = filter.scope === 'raw'
      ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at }))
      : compactEvents(filtered);
    const hasDetailedFilter = Boolean(
      filter.sourceId || filter.collectorId || filter.agentId || filter.agentAssetId || filter.agentInstanceId ||
      filter.subjectAssetId ||
      filter.sessionId || filter.workspacePath || filter.traceId ||
      (correlationCaptureRollout().trustedCorrelation !== 'off' && (filter.invocationId || filter.toolCallId)) ||
      filter.runId || filter.eventKind || filter.eventCategory || filter.activityContext || filter.verdict || filter.q,
    );
    // A history aggregate cannot answer a text/identity-filtered total. Avoid an unrelated full
    // window scan and report the bounded compacted result set already fetched above.
    const needsCurrentIdentityOverlay = filter.scope === 'agent' &&
      resolvedClassificationView(filter) === 'current_effective';
    const history = hasDetailedFilter || needsCurrentIdentityOverlay ? null : await this.history(filter);
    const rows = history && !hasDetailedFilter
      ? this.currentDimensions(history, filter).filter((row) => !filter.tier || row.tier === filter.tier)
      : [];
    const total = rows.length ? rows.reduce((sum, row) => sum + row.eventCount, 0) : compacted.length;
    const totalApproximate = hasDetailedFilter || !history ||
      (rows.length > 0 && history.countsApproximate) || persisted.length >= persistedLimit;
    const committedEventCutoffMs = (
      this.judge as Partial<Pick<SentryJudgeService, 'committedEventCutoffMs'>>
    ).committedEventCutoffMs;
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) =>
        this.eventItem(event, repeatCount, lastAt, resolvedClassificationView(filter))),
      total,
      totalMode: totalApproximate ? 'estimated' : 'exact',
      totalApproximate: totalApproximate ? true : undefined,
      coverage: this.queryCoverage(filter, filtered, {
        source: 'clickhouse',
        totalMode: totalApproximate ? 'estimated' : 'exact',
        partial: persisted.length >= persistedLimit,
        partialReason: persisted.length >= persistedLimit ? 'scan_limit' : undefined,
        committedCutoffMs: typeof committedEventCutoffMs === 'function'
          ? committedEventCutoffMs.call(this.judge)
          : window.endMs,
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async storedAgentEvents(filter: T.AgentEventQuery): Promise<T.AgentEventList> {
    const snapshot = { ...filter };
    const key = durableEventSearchKey(
      snapshot,
      Math.min(
        Number.MAX_SAFE_INTEGER,
        this.agentMetadata.identitySnapshotVersion() + (this.assetReviews?.version() ?? 0),
      ),
    );
    const current = this.durableEventSearchInFlight;
    if (current?.key === key) {
      const shared = await current.value;
      return structuredClone(shared);
    }
    // A different request is still allowed to reach ClickHouseStore, whose shared wide-read slot
    // will fail it closed to the explicit hot-ring fallback instead of queueing another query.
    if (current) return this.computeStoredAgentEvents(snapshot);

    const value = Promise.resolve().then(() => this.computeStoredAgentEvents(snapshot));
    this.durableEventSearchInFlight = { key, value };
    try {
      const result = await value;
      return structuredClone(result);
    } finally {
      if (this.durableEventSearchInFlight?.value === value) this.durableEventSearchInFlight = undefined;
    }
  }

  private async computeStoredAgentEvents(filter: T.AgentEventQuery): Promise<T.AgentEventList> {
    if (!this.judge.storageStatus().clickhouseReady) {
      const fallback = this.agentEvents(filter);
      return {
        ...fallback,
        totalMode: 'estimated',
        totalApproximate: true,
        storageFallback: 'hot_ring',
        coverage: { ...fallback.coverage, totalMode: 'estimated' },
      };
    }
    const pinnedEventId = filter.eventId?.trim();
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40));
    // ClickHouse late-materialises every selected row into the full evidence payload. Pulling 50x
    // the requested page made a 120-row Event list parse roughly 80 MiB / 6,001 wide rows in Node.
    // Stable predicates and as-observed Agent scope are pushed into ClickHouse below, so ordinary
    // pages only need a small allowance for hidden ProcessExit/noise. Text/current-identity filters
    // keep a larger but still explicit post-filter budget and report scan_limit when exhausted.
    const needsWidePostFilter = Boolean(
      filter.q ||
      filter.agentAssetId ||
      filter.agentInstanceId ||
      (filter.scope === 'agent' && resolvedClassificationView(filter) === 'current_effective'),
    );
    const scanLimit = pinnedEventId
      ? 1
      : Math.min(
          needsWidePostFilter ? 2_000 : 1_000,
          Math.max(limit + 1, limit * (needsWidePostFilter ? 10 : 4)),
        );
    const candidateLimit = pinnedEventId
      ? 3
      : Math.min(
          20_000,
          Math.max(scanLimit * 3, limit * (needsWidePostFilter ? 100 : 12)),
        );
    const durableJudge = this.judge as unknown as {
      committedEventCutoffMs?: () => number | undefined;
      searchStoredEventsPage?: (query: StoredEventQuery) => Promise<StoredEventSearchResult>;
      searchStoredEvents?: (query: StoredEventQuery) => Promise<T.JudgedEvent[] | null>;
      queryRange?: (startMs: number, untilMs: number) => T.JudgedEvent[];
      query?: (sinceMs: number) => T.JudgedEvent[];
    };
    const committedCutoffMs = durableJudge.committedEventCutoffMs?.();
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const persistentQuery: StoredEventQuery = {
      sinceMs: pinnedEventId ? 0 : window.startMs,
      untilMs: pinnedEventId ? Math.max(window.endMs, now()) : persistedUntilMs,
      eventId: pinnedEventId,
      sourceId: pinnedEventId ? undefined : filter.sourceId,
      collectorId: pinnedEventId ? undefined : filter.collectorId,
      agentId: pinnedEventId || filter.agentAssetId ? undefined : filter.agentId,
      subjectAssetId: filter.subjectAssetId,
      // Canonical Agent views may carry several legacy Runtime encodings. Asset-scoped queries
      // apply the alias-aware predicate after retrieval instead of pushing one lossy key.
      agentInstanceId: pinnedEventId || filter.agentAssetId ? undefined : filter.agentInstanceId,
      sessionId: pinnedEventId ? undefined : filter.sessionId,
      workspacePath: pinnedEventId || filter.agentAssetId ? undefined : filter.workspacePath,
      traceId: pinnedEventId ? undefined : filter.traceId,
      invocationId: pinnedEventId || correlationCaptureRollout().trustedCorrelation === 'off'
        ? undefined
        : filter.invocationId,
      toolCallId: pinnedEventId || correlationCaptureRollout().trustedCorrelation === 'off'
        ? undefined
        : filter.toolCallId,
      runId: pinnedEventId ? undefined : filter.runId,
      eventKind: pinnedEventId ? undefined : filter.eventKind,
      eventCategory: pinnedEventId ? undefined : filter.eventCategory,
      activityContext: pinnedEventId ? undefined : filter.activityContext,
      verdict: pinnedEventId ? undefined : filter.verdict,
      tier: pinnedEventId ? undefined : filter.tier,
      monitoredOnly: !pinnedEventId &&
        filter.scope === 'agent' &&
        resolvedClassificationView(filter) === 'as_observed',
      candidateLimit,
      limit: scanLimit,
    };
    let persistentPage: StoredEventSearchResult;
    if (typeof durableJudge.searchStoredEventsPage === 'function') {
      persistentPage = await durableJudge.searchStoredEventsPage(persistentQuery);
    } else {
      // Older/minimal judge adapters expose only the row-list search. Preserve that contract while
      // production uses the page form for explicit availability, scan truncation and commit data.
      const events = typeof durableJudge.searchStoredEvents === 'function'
        ? await durableJudge.searchStoredEvents(persistentQuery)
        : null;
      persistentPage = {
        events: events ?? [],
        hasMore: Boolean(events && events.length >= scanLimit),
        unavailable: events === null,
        committedCutoffMs,
      };
    }
    // A collector/partition event-time watermark is not available yet. Query the bounded hot
    // overlap defensively and remove overlap by stable eventId before aggregation. Splitting only
    // at max(at) would lose a late event that is buffered with an event time below that maximum.
    const hotFromMs = pinnedEventId
      ? 0
      : persistentPage.unavailable
        ? window.startMs
        : plan.hotFromMs;
    const hot = typeof durableJudge.queryRange === 'function'
      ? durableJudge.queryRange(hotFromMs, window.endMs)
      : (durableJudge.query?.(hotFromMs) ?? []).filter((event) => event.at <= window.endMs);
    const folded = foldLatestEventRevisions([...persistentPage.events, ...hot]);
    const filtered = this.filterEvents(folded, filter).sort((a, b) =>
      Number(Boolean(pinnedEventId) && b.eventId === pinnedEventId) - Number(Boolean(pinnedEventId) && a.eventId === pinnedEventId) ||
      b.at - a.at,
    );
    const compacted = filter.scope === 'raw' || pinnedEventId
      ? filtered.map((event) => ({ event, repeatCount: 1, lastAt: event.at }))
      : compactEvents(filtered);
    const totalMode: T.QueryTotalMode = persistentPage.unavailable || persistentPage.hasMore
      ? 'estimated'
      : 'exact';
    return {
      items: compacted.slice(0, limit).map(({ event, repeatCount, lastAt }) =>
        this.eventItem(event, repeatCount, lastAt, resolvedClassificationView(filter))),
      total: compacted.length,
      totalMode,
      totalApproximate: totalMode === 'estimated' ? true : undefined,
      storageFallback: persistentPage.unavailable ? 'hot_ring' : undefined,
      coverage: this.queryCoverage(filter, filtered, {
        source: persistentPage.unavailable
          ? 'memory_hot_ring'
          : hot.length
            ? 'clickhouse+hot_delta'
            : 'clickhouse',
        totalMode,
        partial: persistentPage.unavailable || persistentPage.hasMore,
        partialReason: persistentPage.unavailable
          ? 'hot_ring_only'
          : persistentPage.hasMore
            ? 'scan_limit'
            : undefined,
        committedCutoffMs: persistentPage.committedCutoffMs,
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async storedAgentTimeline(filter: T.AgentEventQuery): Promise<T.AgentTimeline> {
    if (!this.judge.storageStatus().clickhouseReady) {
      const fallback = this.agentTimeline(filter);
      return fallback;
    }
    const window = resolveTimeWindow(filter);
    const limit = Math.max(1, Math.min(5_000, filter.limit ?? 240));
    const pinnedEventId = filter.eventId?.trim();
    const pinnedPage = pinnedEventId
      ? await this.judge.searchStoredEventsPage({
          sinceMs: 0,
          untilMs: window.endMs,
          eventId: pinnedEventId,
          limit: 1,
        })
      : undefined;
    const pinned = pinnedPage?.events[0] ?? (pinnedEventId ? this.judge.findEvent(pinnedEventId) : undefined);
    const traceId = filter.traceId?.trim() || pinned?.traceId;
    const invocationId = correlationCaptureRollout().trustedCorrelation === 'off'
      ? undefined
      : filter.invocationId?.trim();
    const toolCallId = correlationCaptureRollout().trustedCorrelation === 'off'
      ? undefined
      : filter.toolCallId?.trim();
    const effectiveFilter: T.AgentEventQuery = {
      ...filter,
      eventId: undefined,
      traceId,
      invocationId,
      toolCallId,
    };
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const persistentPage = await this.judge.searchStoredEventsPage({
      sinceMs: window.startMs,
      untilMs: persistedUntilMs,
      sourceId: filter.sourceId,
      collectorId: filter.collectorId,
      agentId: filter.agentAssetId ? undefined : filter.agentId,
      subjectAssetId: filter.subjectAssetId,
      traceId,
      invocationId,
      toolCallId,
      runId: traceId ? undefined : filter.runId,
      sessionId: traceId || filter.runId ? undefined : filter.sessionId,
      workspacePath: filter.agentAssetId ? undefined : filter.workspacePath,
      agentInstanceId: traceId || filter.runId || filter.sessionId
        ? undefined
        : filter.agentInstanceId,
      eventKind: filter.eventKind,
      eventCategory: filter.eventCategory,
      activityContext: filter.activityContext,
      verdict: filter.verdict,
      tier: filter.tier,
      limit,
    });
    if (persistentPage.unavailable) {
      return this.agentTimeline(filter);
    }
    // See storedAgentEvents: until collector-scoped watermarks exist, overlap is safer than
    // event-time splitting and is removed before building the ordered timeline.
    const hot = this.judge.queryRange(plan.hotFromMs, window.endMs);
    const folded = foldLatestEventRevisions([...persistentPage.events, ...hot]);
    const filtered = this.filterEvents(folded, effectiveFilter).sort((a, b) => a.at - b.at);
    const visible = filtered.slice(-limit);
    const head = visible[0];
    const hasMore = persistentPage.hasMore || filtered.length > limit;
    return {
      traceId: traceId ?? head?.traceId ?? '',
      runId: filter.runId ?? head?.runId,
      sessionId: filter.sessionId ?? head?.sessionId,
      items: visible.map((event) => this.eventItem(
        event,
        1,
        event.at,
        resolvedClassificationView(filter),
      )),
      total: filtered.length,
      hasMore,
      coverage: this.queryCoverage(filter, visible, {
        source: hot.length ? 'clickhouse+hot_delta' : 'clickhouse',
        totalMode: hasMore ? 'estimated' : 'exact',
        partial: hasMore,
        partialReason: hasMore ? 'scan_limit' : undefined,
        committedCutoffMs: persistentPage.committedCutoffMs,
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async storeAgentInteraction(record: T.AgentInteractionRecord): Promise<{ durable: boolean }> {
    const bytes = Buffer.byteLength(JSON.stringify(record));
    const previous = this.interactionHot.get(record.interactionId);
    if (previous) {
      this.interactionHotBytes = Math.max(0, this.interactionHotBytes - previous.bytes);
      this.interactionHot.delete(record.interactionId);
    }
    this.interactionHot.set(record.interactionId, { record, bytes });
    this.interactionHotBytes += bytes;
    while (
      this.interactionHot.size > this.interactionHotMaxRecords
      || this.interactionHotBytes > this.interactionHotMaxBytes
    ) {
      const oldest = this.interactionHot.entries().next().value as
        | [string, { record: T.AgentInteractionRecord; bytes: number }]
        | undefined;
      if (!oldest) break;
      this.interactionHot.delete(oldest[0]);
      this.interactionHotBytes = Math.max(0, this.interactionHotBytes - oldest[1].bytes);
    }
    return { durable: await this.judge.persistAgentInteraction(record) };
  }

  async agentInteractions(filter: T.AgentInteractionQuery): Promise<T.AgentInteractionList> {
    return this.readAgentInteractions(filter);
  }

  private async readAgentInteractions(
    filter: T.AgentInteractionQuery,
    options: { fairPerAgentLimit?: number; totalLimit?: number } = {},
  ): Promise<T.AgentInteractionList> {
    const window = resolveTimeWindow(filter);
    const requestedAsset = filter.agentAssetId?.trim();
    const agentAssetId = requestedAsset
      ? this.agentMetadata.canonicalAgentAssetId(requestedAsset)
      : undefined;
    // interactionId is globally unique and is the stronger lookup key. An asset recorded before
    // identity reconciliation may now resolve to a newer canonical ID, so prefiltering durable
    // rows by that canonical ID can hide the exact historical interaction. Resolve the strong ID
    // first, then enforce canonical asset equivalence below.
    const query = {
      ...filter,
      agentAssetId: filter.interactionId ? undefined : agentAssetId,
      startMs: window.startMs,
      endMs: window.endMs,
      ...(options.fairPerAgentLimit
        ? { fairPerAgentLimit: options.fairPerAgentLimit }
        : {}),
      ...(options.totalLimit ? { limit: options.totalLimit } : {}),
    };
    const persisted = await this.judge.storedAgentInteractions(query);
    const merged = new Map<string, T.AgentInteractionRecord>();
    for (const item of persisted ?? []) merged.set(item.interactionId, item);
    for (const { record } of this.interactionHot.values()) {
      if (record.at < window.startMs || record.at > window.endMs) continue;
      merged.set(record.interactionId, record);
    }
    const currentView = resolvedClassificationView(filter) === 'current_effective';
    const items = [...merged.values()]
      .map((item): T.AgentInteractionRecord => {
        const review = currentView ? this.assetReviews?.current(item.agentAssetId) : undefined;
        return review ? { ...item, currentEffectiveClassification: review.decision } : item;
      })
      .filter((item) =>
        (!agentAssetId
          || item.agentAssetId === requestedAsset
          || this.agentMetadata.canonicalAgentAssetId(item.agentAssetId) === agentAssetId)
        && (!filter.agentInstanceId || item.agentInstanceId === filter.agentInstanceId)
        && (!filter.interactionId || item.interactionId === filter.interactionId)
        && (!filter.interactionType || item.interactionType === filter.interactionType)
        && (!filter.model || item.model === filter.model)
        && (!filter.transport || item.transport === filter.transport)
        && (!filter.tlsAdapterId || item.tlsAdapterId === filter.tlsAdapterId)
        && (!filter.transportProtocol || item.transportProtocol === filter.transportProtocol)
        && (!filter.wireTemplateId || item.wireTemplateId === filter.wireTemplateId)
        && (!filter.parseState || item.parseState === filter.parseState)
        && (!filter.completeness || item.completeness === filter.completeness)
        && (filter.scope === 'raw' || ['confirmed_agent', 'probable_agent'].includes(
          currentView ? item.currentEffectiveClassification : item.detectedClassification,
        )))
      .sort((left, right) => right.at - left.at || right.interactionId.localeCompare(left.interactionId));
    const limit = options.totalLimit
      ? Math.max(1, Math.min(CONVERSATION_INTERACTIONS_TOTAL, options.totalLimit))
      : Math.max(1, Math.min(500, filter.limit ?? 100));
    const visible = options.fairPerAgentLimit
      ? (() => {
          const perAgent = Math.max(1, Math.min(256, options.fairPerAgentLimit));
          const counts = new Map<string, number>();
          const selected: T.AgentInteractionRecord[] = [];
          for (const item of items) {
            const identity = this.agentMetadata.canonicalAgentAssetId(item.agentAssetId);
            const count = counts.get(identity) ?? 0;
            if (count >= perAgent) continue;
            counts.set(identity, count + 1);
            selected.push(item);
            if (selected.length >= limit) break;
          }
          return selected;
        })()
      : items.slice(0, limit);
    const snapshotAsOf = new Date(window.endMs).toISOString();
    const dataTimes = visible.map((item) => item.at);
    const durable = persisted !== null;
    return {
      items: visible,
      total: items.length,
      totalMode: durable && !options.fairPerAgentLimit && items.length <= limit
        ? 'exact'
        : 'omitted',
      coverage: {
        requestedFrom: new Date(window.startMs).toISOString(),
        requestedTo: snapshotAsOf,
        snapshotAsOf,
        asOf: snapshotAsOf,
        dataFrom: dataTimes.length ? new Date(Math.min(...dataTimes)).toISOString() : undefined,
        dataTo: dataTimes.length ? new Date(Math.max(...dataTimes)).toISOString() : undefined,
        completeness: durable && !options.fairPerAgentLimit
          ? currentView ? 'exact_current_effective' : 'exact_as_observed'
          : 'partial',
        partial: !durable || Boolean(options.fairPerAgentLimit),
        partialReason: !durable
          ? 'hot_ring_only'
          : options.fairPerAgentLimit ? 'scan_limit' : undefined,
        source: durable ? 'clickhouse+hot_delta' : 'memory_hot_ring',
        totalMode: durable && !options.fairPerAgentLimit && items.length <= limit
          ? 'exact'
          : 'omitted',
      },
      dataSource: durable ? 'clickhouse' : 'hot_ring',
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  private async agentConversationProjection(filter: T.AgentConversationQuery): Promise<{
    projection: ReturnType<typeof projectAgentConversations>;
    interactions: T.AgentInteractionList;
    inventory: T.AgentInventory;
  }> {
    // An inferred conversation ID is anchored in the globally ordered projection. Applying an
    // asset, instance, or model prefilter can change the first record in that projection and thus
    // produce a different ID. Once a conversationId is present, keep those values as post-
    // projection consistency filters instead of changing the record set used to resolve the ID.
    const resolveConversationId = Boolean(filter.conversationId);
    const interactionQuery: T.AgentInteractionQuery = {
      timeType: filter.timeType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      scope: 'agent',
      classificationView: filter.classificationView,
      agentAssetId: resolveConversationId ? undefined : filter.agentAssetId,
      agentInstanceId: resolveConversationId ? undefined : filter.agentInstanceId,
      model: resolveConversationId ? undefined : filter.model,
      limit: 500,
    };
    const inventoryQuery: T.AgentInventoryQuery = {
      timeType: filter.timeType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      scope: 'agent',
      classificationView: filter.classificationView,
      agentAssetId: resolveConversationId ? undefined : filter.agentAssetId,
      agentInstanceId: resolveConversationId ? undefined : filter.agentInstanceId,
      includeUnclassified: false,
      limit: 500,
    };
    const preciseContentQuery = Boolean(
      filter.agentAssetId
      || filter.agentInstanceId
      || filter.conversationId
      || filter.q
      || filter.model
      || filter.product,
    );
    let inventoryTimer: NodeJS.Timeout | undefined;
    const inventoryPromise = preciseContentQuery
      ? Promise.resolve(this.agentInventory(inventoryQuery))
      : Promise.race([
          this.storedAgentInventory(inventoryQuery).catch(() => this.agentInventory(inventoryQuery)),
          new Promise<T.AgentInventory>((resolve) => {
            inventoryTimer = setTimeout(() => resolve(this.agentInventory(inventoryQuery)), 1_500);
            inventoryTimer.unref();
          }),
        ]);
    const fairHistoryRead = resolveConversationId || (
      !filter.agentAssetId
      && !filter.agentInstanceId
      && !filter.model
    );
    const [interactions, inventory] = await Promise.all([
      this.readAgentInteractions(interactionQuery, fairHistoryRead ? {
        fairPerAgentLimit: CONVERSATION_INTERACTIONS_PER_AGENT,
        totalLimit: CONVERSATION_INTERACTIONS_TOTAL,
      } : undefined),
      inventoryPromise,
    ]).finally(() => {
      if (inventoryTimer) clearTimeout(inventoryTimer);
    });
    const boundInteractions = this.conversationBindings
      ? await this.conversationBindings.applyPersistedBindings(interactions.items)
      : interactions.items;
    const projection = projectAgentConversations(boundInteractions, inventory.items, filter);
    if (this.conversationBindings) await this.conversationBindings.persistProjection(projection);
    return {
      projection,
      interactions,
      inventory,
    };
  }

  async agentConversations(filter: T.AgentConversationQuery): Promise<T.AgentConversationList> {
    const { projection, interactions, inventory } = await this.agentConversationProjection(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 80));
    const items = projection.summaries.slice(0, limit);
    const partial = interactions.coverage.partial || inventory.coverage.partial;
    return {
      items,
      total: projection.summaries.length,
      totalMode: projection.summaries.length > limit || interactions.totalMode === 'omitted'
        ? 'omitted'
        : 'exact',
      coverage: {
        ...interactions.coverage,
        partial,
        partialReason: interactions.coverage.partialReason
          ?? inventory.coverage.partialReason,
      },
      dataSource: interactions.dataSource,
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async agentConversationTimeline(
    filter: T.AgentConversationQuery,
  ): Promise<T.AgentConversationTimeline> {
    const { projection, interactions, inventory } = await this.agentConversationProjection(filter);
    const conversation = projection.summaries.find((item) =>
      item.conversationId === filter.conversationId);
    const records = filter.conversationId
      ? projection.interactionsByConversation.get(filter.conversationId) ?? []
      : [];
    const items = conversation?.hasContent
      ? projectConversationTimeline(conversation, records)
      : [];
    const partial = interactions.coverage.partial || inventory.coverage.partial;
    return {
      conversation,
      items,
      interactionIds: records.map((item) => item.interactionId),
      total: items.length,
      coverage: {
        ...interactions.coverage,
        partial,
        partialReason: interactions.coverage.partialReason
          ?? inventory.coverage.partialReason,
      },
      dataSource: interactions.dataSource,
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async agentConversationTimelineV2(
    filter: T.AgentConversationQuery,
  ): Promise<T.AgentConversationTimelineV2> {
    const { projection, interactions, inventory } = await this.agentConversationProjection(filter);
    const thread = projection.summaries.find((item) =>
      item.conversationId === filter.conversationId);
    const records = filter.conversationId
      ? projection.interactionsByConversation.get(filter.conversationId) ?? []
      : [];
    const segments = filter.conversationId && this.conversationBindings
      ? this.conversationBindings.segmentsForConversation(filter.conversationId)
      : [];
    const turns = thread?.hasContent
      ? projectSemanticConversationTimeline(thread, records, segments)
      : [];
    const partial = interactions.coverage.partial || inventory.coverage.partial;
    return {
      thread,
      segments,
      turns,
      interactionIds: records.map((item) => item.interactionId),
      parserId: SEMANTIC_PROJECTION_PARSER_ID,
      parserVersion: SEMANTIC_PROJECTION_PARSER_VERSION,
      coverage: {
        ...interactions.coverage,
        partial,
        partialReason: interactions.coverage.partialReason
          ?? inventory.coverage.partialReason,
      },
      dataSource: interactions.dataSource,
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  /**
   * Build the product-neutral Agent behavior feed. Semantic ToolCall rows are collapsed here;
   * potentially expensive Kernel Evidence linking remains an on-demand action-detail query.
   */
  async storedAgentActions(filter: T.AgentEventQuery): Promise<T.AgentActionList> {
    const limit = Math.max(1, Math.min(100, filter.limit ?? 80));
    const semantic = await this.storedAgentEvents({
      ...filter,
      eventId: undefined,
      eventKind: 'AgentTool',
      eventCategory: 'tool',
      activityContext: undefined,
      scope: 'agent',
      durable: true,
      limit: Math.min(200, Math.max(limit * 4, 80)),
    });
    type ActionGroup = {
      items: T.AgentEventListItem[];
      start?: T.AgentEventListItem;
      end?: T.AgentEventListItem;
    };
    const groups = new Map<string, ActionGroup>();
    for (const item of semantic.items) {
      if (!item.invocationId || !item.toolCallId) continue;
      const key = [item.sourceId ?? '', item.agentAssetId, item.invocationId, item.toolCallId].join('\0');
      const group = groups.get(key) ?? { items: [] };
      group.items.push(item);
      const phase = String(item.attributes['anysentry.lifecycle.phase'] ?? '').toLowerCase();
      if (phase === 'start' && (!group.start || Date.parse(item.at) < Date.parse(group.start.at))) group.start = item;
      if (phase === 'end' && (!group.end || Date.parse(item.at) > Date.parse(group.end.at))) group.end = item;
      groups.set(key, group);
    }
    const actions = [...groups.values()].map((group): T.AgentActionItem => {
      const ordered = [...group.items].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
      const representative = group.end ?? group.start ?? ordered.at(-1)!;
      const startedAt = group.start?.at ?? ordered[0].at;
      const endedAt = group.end?.at;
      const error = group.end?.attributes['anysentry.tool.is_error'] === true
        || group.end?.attributes['anysentry.tool.is_error'] === 'true'
        || group.end?.attributes['anysentry.tool.is_error'] === 1
        || Boolean(group.end?.attributes['error.type']);
      const toolName = String(
        representative.attributes['gen_ai.tool.name']
        ?? representative.attributes['anysentry.tool.name']
        ?? representative.subject.replace(/^.*?tool\s+/iu, '').split(/\s+/u)[0]
        ?? 'tool',
      ).slice(0, 160);
      const targetSummary = ordered
        .flatMap((item) => [
          item.attributes['anysentry.tool.resource_path'],
          item.attributes['anysentry.tool.command'],
          item.attributes['anysentry.tool.command_executable'],
        ])
        .find((value) => typeof value === 'string' && value.trim());
      const duration = endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
      return {
        actionId: `act_${createHash('sha256')
          .update([
            representative.sourceId ?? '',
            representative.agentRuntimeInstanceId ?? representative.agentAssetId,
            representative.invocationId,
            representative.toolCallId,
          ].join('\0'))
          .digest('hex').slice(0, 24)}`,
        origin: 'semantic',
        status: endedAt ? (error ? 'failed' : 'succeeded') : 'running',
        agentAssetId: representative.agentAssetId,
        agentAssetAliases: representative.agentAssetAliases,
        sourceId: representative.sourceId,
        agentProduct: representative.agentProduct,
        agentRuntimeInstanceId: representative.agentRuntimeInstanceId,
        invocationId: representative.invocationId,
        toolCallId: representative.toolCallId,
        toolName,
        operation: 'execute_tool',
        targetSummary: typeof targetSummary === 'string' ? targetSummary.slice(0, 500) : undefined,
        startedAt,
        endedAt,
        durationMs: duration,
        semanticEventIds: ordered.map((item) => item.eventId),
        evidenceState: 'available_on_demand',
        evidenceHref: `/security-center/events/tool-evidence`,
      };
    }).sort((left, right) => Date.parse(right.endedAt ?? right.startedAt) - Date.parse(left.endedAt ?? left.startedAt));

    if (actions.length > 0) {
      return {
        items: actions.slice(0, limit),
        total: actions.length,
        totalMode: semantic.total <= semantic.items.length ? semantic.totalMode : 'omitted',
        coverage: semantic.coverage,
        ...this.classificationResponseMeta(filter),
        updateTime: iso(),
      };
    }

    const fallback = await this.storedAgentEvents({
      ...filter,
      eventId: undefined,
      eventKind: undefined,
      eventCategory: undefined,
      activityContext: undefined,
      scope: 'agent',
      durable: true,
      limit: Math.min(500, Math.max(limit * 4, 80)),
    });
    const fallbackItems = fallback.items.flatMap((item): T.AgentActionItem[] => {
      const accessMode = String(item.attributes.accessMode ?? 'unknown');
      const path = typeof item.attributes.path === 'string' ? item.attributes.path : undefined;
      const operation: T.AgentActionItem['operation'] | undefined = item.eventKind === 'ToolExec'
        ? 'kernel_exec'
        : item.eventKind === 'FileDelete'
          ? 'file_delete'
          : item.eventKind === 'FileAccess'
            ? accessMode === 'read_only'
              ? 'file_read'
              : accessMode === 'write_only' || accessMode === 'read_write' || item.attributes.write === true
                ? 'file_write'
                : 'file_access'
            : ['Egress', 'Dns', 'Tls'].includes(item.eventKind)
              ? 'network_connect'
              : undefined;
      if (!operation) return [];
      const toolName = operation === 'kernel_exec'
        ? String(item.process?.comm ?? item.subject.split(/\s+/u)[0] ?? 'command')
        : operation === 'file_read'
          ? 'read file'
          : operation === 'file_write'
            ? 'write file'
            : operation === 'file_access'
              ? 'file access'
            : operation === 'file_delete'
              ? 'delete file'
              : 'network access';
      return [{
        actionId: `act_${createHash('sha256').update(`kernel\0${item.eventId}`).digest('hex').slice(0, 24)}`,
        origin: 'kernel_inferred',
        status: 'incomplete',
        agentAssetId: item.agentAssetId,
        agentAssetAliases: item.agentAssetAliases,
        sourceId: item.sourceId,
        agentProduct: item.agentProduct,
        agentRuntimeInstanceId: item.agentRuntimeInstanceId,
        toolName: toolName.slice(0, 160),
        operation,
        targetSummary: path ?? item.subject,
        startedAt: item.at,
        semanticEventIds: [],
        fallbackEventId: item.eventId,
        evidenceState: 'runtime_level',
      }];
    }).slice(0, limit);
    return {
      items: fallbackItems,
      total: fallbackItems.length,
      totalMode: fallback.total <= fallback.items.length && fallbackItems.length === fallback.items.length
        ? fallback.totalMode
        : 'omitted',
      coverage: fallback.coverage,
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  /**
   * Build the S6 semantic ToolCall ↔ kernel evidence view without changing legacy Trace grouping.
   * Durable lookup is bounded first by an authenticated Invocation and then by exact process
   * tuples. The linker itself still requires resource/command equality and refuses overlapping
   * claims, so time proximity alone can never create a ToolCall edge.
   */
  async agentToolEvidence(filter: T.AgentEventQuery): Promise<ToolEvidenceResponse> {
    const invocationId = filter.invocationId?.trim() ?? '';
    const toolCallId = filter.toolCallId?.trim() || undefined;
    const correlationEnabled = correlationCaptureRollout().trustedCorrelation !== 'off';
    const empty = buildToolEvidenceBundle([]);
    if (!correlationEnabled) {
      return {
        ...empty,
        invocationId,
        ...(toolCallId ? { toolCallId } : {}),
        dataSource: 'memory_hot_ring',
        partial: true,
        partialReasons: ['trusted_correlation_off'],
        updateTime: iso(),
      };
    }

    const window = resolveTimeWindow(filter);
    const storageReady = this.judge.storageStatus().clickhouseReady;
    const partialReasons = new Set<NonNullable<ToolEvidenceResponse['partialReasons']>[number]>();
    const durableEvents: T.JudgedEvent[] = [];
    const semanticLimit = Math.max(100, Math.min(2_000, filter.limit ?? 1_000));

    if (storageReady) {
      const storedRelation = await this.judge.readStoredToolEvidenceRelations(
        invocationId,
        toolCallId,
        {
          workspacePath: filter.workspacePath?.trim(),
          sourceId: filter.sourceId?.trim(),
          agentInstanceId: filter.agentInstanceId?.trim(),
        },
      );
      const relationItems = storedRelation?.items.filter((item) =>
        (!toolCallId || item.toolCallId === toolCallId) &&
        (item.startedAt ?? item.endedAt ?? window.startMs) >= window.startMs &&
        (item.endedAt ?? item.startedAt ?? window.endMs) <= window.endMs,
      ) ?? [];
      if (
        relationItems.length > 0 &&
        relationItems.every((item) =>
          item.endedAt !== undefined && now() - item.endedAt >= TOOL_EVIDENCE_RELATION_SETTLE_MS,
        )
      ) {
        return {
          schemaVersion: 'anysentry.tool_evidence.v1',
          items: relationItems,
          ignoredUntrustedAdapterEvents: 0,
          truncated: false,
          invocationId,
          ...(toolCallId ? { toolCallId } : {}),
          dataSource: 'clickhouse_relation',
          partial: false,
          updateTime: iso(),
        };
      }
    }

    if (storageReady) {
      const semanticPage = await this.judge.searchStoredEventsPage({
        sinceMs: window.startMs,
        untilMs: window.endMs,
        sourceId: filter.sourceId,
        collectorId: filter.collectorId,
        agentId: filter.agentAssetId ? undefined : filter.agentId,
        sessionId: filter.sessionId,
        workspacePath: filter.agentAssetId ? undefined : filter.workspacePath,
        invocationId,
        toolCallId,
        eventKind: 'AgentTool',
        limit: semanticLimit,
      });
      durableEvents.push(...semanticPage.events);
      if (semanticPage.unavailable) partialReasons.add('storage_unavailable');
      if (semanticPage.hasMore) partialReasons.add('scan_limit');
    } else {
      partialReasons.add('storage_unavailable');
    }

    const hotEvents = this.judge.queryRange(window.startMs, window.endMs);
    const semanticEvents = foldLatestEventRevisions([...durableEvents, ...hotEvents]).filter((event) => {
      if (event.eventKind !== 'AgentTool') return false;
      const correlation = parseTrustedCorrelation(event.attribution?.correlation);
      return correlation?.method === 'agent_adapter' &&
        correlation.authority === 'authenticated_agent_adapter' &&
        correlation.invocationId === invocationId &&
        (!toolCallId || correlation.toolCallId === toolCallId);
    });

    const processScopes = new Map<string, NonNullable<T.JudgedEvent['process']>>();
    for (const event of semanticEvents) {
      const process = event.process;
      const start = process?.startTimeTicks
        ? `ticks:${process.startTimeTicks}`
        : process?.startTimeNs
          ? `ns:${process.startTimeNs}`
          : undefined;
      const hostStrong = Boolean(process?.hostId && process.pid);
      const namespaceStrong = Boolean(process?.pidNamespace && process.namespacePid);
      if (!process?.bootId || !start || (!hostStrong && !namespaceStrong)) continue;
      const key = namespaceStrong
        ? ['ns', process.bootId, process.pidNamespace, process.namespacePid, start].join('\0')
        : ['host', process.hostId, process.bootId, process.pid, start].join('\0');
      if (!processScopes.has(key)) processScopes.set(key, process);
    }

    const selectedScopes = [...processScopes.values()].slice(0, 8);
    if (processScopes.size > selectedScopes.length) partialReasons.add('process_scope_limit');
    const resourceHashes = [...new Set(semanticEvents
      .map((event) => toolEvidenceIndexFields(event).resourceHash)
      .filter((value): value is string => Boolean(value)))];
    const commandHashes = [...new Set(semanticEvents
      .map((event) => toolEvidenceIndexFields(event).commandHash)
      .filter((value): value is string => Boolean(value)))];
    const semanticStart = semanticEvents.length
      ? Math.min(...semanticEvents.map((event) => event.at))
      : window.startMs;
    const semanticEnd = semanticEvents.length
      ? Math.max(...semanticEvents.map((event) => event.at))
      : window.endMs;
    const evidenceStart = Math.max(window.startMs, semanticStart - 2_000);
    const evidenceEnd = Math.min(window.endMs, semanticEnd + 30 * 60_000 + 2_000);
    const hotKernelEvents = hotEvents.filter((event) =>
      event.at >= evidenceStart && event.at <= evidenceEnd &&
      toolKernelEventInProcessScope(event, selectedScopes));

    if (storageReady && semanticEvents.length) {
      for (const process of selectedScopes) {
        const namespaceStrong = Boolean(process.pidNamespace && process.namespacePid);
        const common = {
          sinceMs: evidenceStart,
          untilMs: evidenceEnd,
          processBootId: process.bootId,
          ...(namespaceStrong
            ? { processPidNamespace: process.pidNamespace }
            : { processHostId: process.hostId }),
          limit: 5_000,
        };
        if (resourceHashes.length > 0) {
          const exactProcessPage = await this.judge.searchStoredEventsPage({
            ...common,
            ...(namespaceStrong
              ? { processNamespacePid: process.namespacePid }
              : { processPid: process.pid }),
            ...(process.startTimeTicks ? { processStartTimeTicks: process.startTimeTicks } : {}),
            ...(process.startTimeNs ? { processStartTimeNs: process.startTimeNs } : {}),
            evidenceResourceHashes: resourceHashes,
          });
          durableEvents.push(...exactProcessPage.events);
          if (exactProcessPage.unavailable) partialReasons.add('storage_unavailable');
          if (exactProcessPage.hasMore) partialReasons.add('scan_limit');
        }

        // Pi's bash tool spawns a direct shell child. Parent PID + exact command hash is the
        // additional non-temporal evidence; descendants without that equality remain unlinked.
        if (commandHashes.length > 0) {
          const directChildPage = await this.judge.searchStoredEventsPage({
            ...common,
            ...(namespaceStrong
              ? { processNamespacePpid: process.namespacePid }
              : { processPpid: process.pid }),
            eventKind: 'ToolExec',
            evidenceCommandHashes: commandHashes,
          });
          durableEvents.push(...directChildPage.events);
          if (directChildPage.unavailable) partialReasons.add('storage_unavailable');
          if (directChildPage.hasMore) partialReasons.add('scan_limit');
        }
      }
    }

    const evidenceEvents = foldLatestEventRevisions([
      ...durableEvents,
      ...semanticEvents,
      ...hotKernelEvents,
    ]);
    const bundle = buildToolEvidenceBundle(evidenceEvents);
    const items = toolCallId
      ? bundle.items.filter((item) => item.invocationId === invocationId && item.toolCallId === toolCallId)
      : bundle.items.filter((item) => item.invocationId === invocationId);
    if (
      storageReady &&
      !bundle.truncated &&
      partialReasons.size === 0 &&
      items.length > 0 &&
      items.every((item) => item.endedAt && now() - item.endedAt >= TOOL_EVIDENCE_RELATION_SETTLE_MS)
    ) {
      const scopes = new Map<string, {
        workspacePath: string;
        sourceId: string;
        agentInstanceId: string;
      }>();
      for (const event of semanticEvents) {
        const sourceId = event.sourceId?.trim();
        if (!sourceId) continue;
        const scope = {
          workspacePath: event.workspacePath,
          sourceId,
          agentInstanceId: agentRuntimeInstanceIdForEvent(event),
        };
        scopes.set([scope.workspacePath, scope.sourceId, scope.agentInstanceId].join('\0'), scope);
      }
      if (scopes.size === 1) {
        const evidenceVersion = createHash('sha256')
          .update(JSON.stringify(evidenceEvents
            .map((event) => [event.eventId, event.decisionRevision ?? 1, event.decisionUpdatedAt ?? event.at])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0])))))
          .digest('hex');
        await this.judge.writeStoredToolEvidenceRelations(
          items,
          evidenceVersion,
          [...scopes.values()][0],
        );
      }
    }
    return {
      ...bundle,
      items,
      invocationId,
      ...(toolCallId ? { toolCallId } : {}),
      dataSource: storageReady ? 'clickhouse+hot_delta' : 'memory_hot_ring',
      partial: bundle.truncated || partialReasons.size > 0,
      ...(partialReasons.size ? { partialReasons: [...partialReasons] } : {}),
      updateTime: iso(),
    };
  }

  agentTimeline(filter: T.AgentEventQuery): T.AgentTimeline {
    const pinnedEventId = filter.eventId?.trim();
    const events = pinnedEventId ? this.judge.query(0) : this.win(filter).events;
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    const pinned = pinnedEventId ? events.find((event) => event.eventId === pinnedEventId) : undefined;
    const effectiveFilter = pinned && !filter.traceId ? { ...filter, eventId: undefined, traceId: pinned.traceId } : filter;
    const filtered = this.filterEvents(events, effectiveFilter).sort((a, b) => a.at - b.at).slice(-limit);
    const head = filtered[0];
    return {
      traceId: filter.traceId ?? pinned?.traceId ?? head?.traceId ?? '',
      runId: filter.runId ?? head?.runId,
      sessionId: filter.sessionId ?? head?.sessionId,
      items: filtered.map((event) => this.eventItem(
        event,
        1,
        event.at,
        resolvedClassificationView(filter),
      )),
      total: filtered.length,
      hasMore: false,
      coverage: this.queryCoverage(filter, filtered, {
        source: 'memory_hot_ring',
        totalMode: 'exact',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  private incidentItem(i: T.Incident): T.IncidentListItem {
    return {
      ...i,
      openedAt: iso(i.openedAt),
      updatedAt: iso(i.updatedAt),
      acknowledgedAt: i.acknowledgedAt ? iso(i.acknowledgedAt) : undefined,
      resolvedAt: i.resolvedAt ? iso(i.resolvedAt) : undefined,
    };
  }

  incidents(filter: T.IncidentQuery): T.IncidentList {
    const { sinceMs } = this.win(filter);
    const limit = Math.max(1, Math.min(200, filter.limit ?? 60));
    const pinnedIncidentId = filter.incidentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const agentId = filter.agentId?.trim();
    const collectorId = filter.collectorId?.trim();
    const sourceId = filter.sourceId?.trim();
    const sessionId = filter.sessionId?.trim();
    const traceId = filter.traceId?.trim();
    const hasFilter = Boolean(
      (filter.status && filter.status !== 'all') ||
      (filter.severity && filter.severity !== 'all') ||
      workspacePath ||
      agentId ||
      collectorId ||
      sourceId ||
      sessionId ||
      traceId,
    );
    const all = this.judge.listIncidents(pinnedIncidentId ? 0 : sinceMs);
    const filtered = all
      .filter((i) => {
        const matchesIncidentId = Boolean(pinnedIncidentId && i.incidentId === pinnedIncidentId);
        if (filter.scope === 'agent' && !matchesIncidentId && i.monitored !== true) return false;
        const matchesFilter =
          i.updatedAt >= sinceMs &&
          (!filter.status || filter.status === 'all' || i.status === filter.status) &&
          (!filter.severity || filter.severity === 'all' || i.severity === filter.severity) &&
          (!workspacePath || i.workspacePath === workspacePath) &&
          (!agentId || i.agentId === agentId) &&
          (!collectorId || i.collectorId === collectorId) &&
          (!sourceId || i.sourceId === sourceId) &&
          (!sessionId || i.sessionId === sessionId) &&
          (!traceId || i.traceId === traceId);
        if (pinnedIncidentId && !hasFilter) return matchesIncidentId;
        return matchesIncidentId || matchesFilter;
      })
      .sort((a, b) =>
        Number(Boolean(pinnedIncidentId) && b.incidentId === pinnedIncidentId) - Number(Boolean(pinnedIncidentId) && a.incidentId === pinnedIncidentId) ||
        b.updatedAt - a.updatedAt,
      );
    const summary: Record<T.IncidentStatus, number> = { open: 0, acknowledged: 0, resolved: 0 };
    for (const i of all) summary[i.status]++;
    return {
      items: filtered.slice(0, limit).map((i) => this.incidentItem(i)),
      total: filtered.length,
      summary,
      updateTime: iso(),
    };
  }

  updateIncident(incidentId: string, body: T.IncidentUpdateRequest): T.IncidentListItem | null {
    const incident = this.judge.updateIncident(incidentId, body);
    return incident ? this.incidentItem(incident) : null;
  }

  agentInventory(filter: T.AgentInventoryQuery): T.AgentInventory {
    const window = this.win(filter);
    const events = filter.scope === 'agent'
      ? window.events.filter((event) => event.attribution?.monitored === true)
      : window.events;
    return this.agentInventoryFromEvents(filter, events);
  }

  private agentFactForEvent(event: T.JudgedEvent): StoredAgentWindowFact {
    const risky = event.verdict !== 'allow';
    const instanceKey = agentRuntimeInstanceIdForEvent(event);
    const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [
      category,
      event.eventCategory === category ? 1 : 0,
    ]));
    const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [
      source,
      event.source === source ? 1 : 0,
    ]));
    return {
      identityKey: event.eventId,
      representativeEvent: event,
      firstSeenAt: event.at,
      lastSeenAt: event.at,
      eventCount: 1,
      riskyEventCount: risky ? 1 : 0,
      sessionCount: 1,
      runCount: 1,
      traceCount: 1,
      sessionKeys: [event.sessionId],
      runKeys: [event.runId],
      traceKeys: [event.traceId],
      collectorKeys: eventCollectorId(event) ? [eventCollectorId(event)] : [],
      eventsWithoutCollector: missingCollectorCoverage(event) ? 1 : 0,
      tokenCount: event.tokenCount,
      latencyTotal: event.latencyMs,
      instanceCount: 1,
      instanceKeys: [instanceKey],
      worstSeverityRank: risky ? SEV_RANK[event.severity] : 0,
      topRiskAt: risky ? event.at : undefined,
      topRiskCategory: risky ? event.riskCategory : undefined,
      topRiskName: risky ? event.riskName : undefined,
      eventCategoryCounts: categoryCounts,
      sourceCounts,
      hasPhysicalIdentity: Boolean(
        event.attribution?.physicalWorkloadId ||
        event.attribution?.agentInstanceId ||
        event.attribution?.workloadRef?.podUid,
      ),
      hasRootIdentity: Boolean(event.attribution?.rootStartTime) && hasDirectAgentRootEvidence(event),
      hasInternalHelperRoot: isInternalAgentHelperRootEvent(event),
    };
  }

  private mergeAgentFacts(a: StoredAgentWindowFact, b: StoredAgentWindowFact): StoredAgentWindowFact {
    const newest = a.lastSeenAt >= b.lastSeenAt ? a : b;
    const latestRisk = (b.topRiskAt ?? 0) >= (a.topRiskAt ?? 0) ? b : a;
    const sessionKeys = [...new Set([...a.sessionKeys, ...b.sessionKeys])];
    const runKeys = [...new Set([...a.runKeys, ...b.runKeys])];
    const traceKeys = [...new Set([...a.traceKeys, ...b.traceKeys])];
    const collectorKeys = [...new Set([...a.collectorKeys, ...b.collectorKeys])];
    const instanceKeys = [...new Set([...a.instanceKeys, ...b.instanceKeys])];
    const eventCategoryCounts: Record<string, number> = {};
    for (const category of EVENT_CATEGORIES) {
      eventCategoryCounts[category] =
        (a.eventCategoryCounts[category] ?? 0) +
        (b.eventCategoryCounts[category] ?? 0);
    }
    const sourceCounts: Record<string, number> = {};
    for (const source of EVENT_SOURCES) {
      sourceCounts[source] =
        (a.sourceCounts[source] ?? 0) +
        (b.sourceCounts[source] ?? 0);
    }
    return {
      identityKey: newest.identityKey,
      representativeEvent: newest.representativeEvent,
      firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
      lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
      eventCount: a.eventCount + b.eventCount,
      riskyEventCount: a.riskyEventCount + b.riskyEventCount,
      sessionCount: sessionKeys.length,
      runCount: runKeys.length,
      traceCount: traceKeys.length,
      sessionKeys,
      runKeys,
      traceKeys,
      collectorKeys,
      eventsWithoutCollector: a.eventsWithoutCollector + b.eventsWithoutCollector,
      tokenCount: a.tokenCount + b.tokenCount,
      latencyTotal: a.latencyTotal + b.latencyTotal,
      instanceCount: instanceKeys.length,
      instanceKeys,
      worstSeverityRank: Math.max(a.worstSeverityRank, b.worstSeverityRank),
      topRiskAt: latestRisk.topRiskAt,
      topRiskCategory: latestRisk.topRiskCategory,
      topRiskName: latestRisk.topRiskName,
      eventCategoryCounts,
      sourceCounts,
      hasPhysicalIdentity: a.hasPhysicalIdentity || b.hasPhysicalIdentity,
      hasRootIdentity: a.hasRootIdentity || b.hasRootIdentity,
      hasInternalHelperRoot: a.hasInternalHelperRoot || b.hasInternalHelperRoot,
    };
  }

  async storedAgentInventory(filter: T.AgentInventoryQuery): Promise<T.AgentInventory> {
    const window = resolveTimeWindow(filter);
    const key = JSON.stringify([
      window.custom ? window.cacheKey : ['relative', filter.timeType ?? 'last_1h'],
      filter.scope ?? 'all',
      filter.healthState ?? 'all',
      filter.criticality ?? 'all',
      filter.owner ?? '',
      filter.environment ?? '',
      filter.tag ?? '',
      filter.q ?? '',
      filter.agentId ?? '',
      filter.agentAssetId ?? '',
      filter.agentInstanceId ?? '',
      filter.workspacePath ?? '',
      filter.userId ?? '',
      filter.includeUnclassified === true,
      filter.limit ?? 120,
    ]);
    const current = this.agentInventoryInFlight.get(key);
    if (current) return current;
    const request = this.computeStoredAgentInventory(filter);
    this.agentInventoryInFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (this.agentInventoryInFlight.get(key) === request) {
        this.agentInventoryInFlight.delete(key);
      }
    }
  }

  private async computeStoredAgentInventory(filter: T.AgentInventoryQuery): Promise<T.AgentInventory> {
    const lkgKey = JSON.stringify({
      timeType: filter.timeType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      scope: filter.scope,
      healthState: filter.healthState,
      criticality: filter.criticality,
      owner: filter.owner,
      environment: filter.environment,
      tag: filter.tag,
      q: filter.q,
      agentId: filter.agentId,
      agentAssetId: filter.agentAssetId,
      agentInstanceId: filter.agentInstanceId,
      workspacePath: filter.workspacePath,
      userId: filter.userId,
      includeUnclassified: filter.includeUnclassified,
      limit: filter.limit,
    });
    const fallback = (): T.AgentInventory => {
      const lkg = this.agentInventoryLastGood.get(lkgKey);
      if (lkg && now() - lkg.at <= 15 * 60_000) {
        const value = structuredClone(lkg.value);
        value.coverage = {
          ...value.coverage,
          completeness: 'partial',
          partial: true,
          partialReason: 'storage_unavailable',
        };
        return value;
      }
      return this.agentInventory(filter);
    };
    if (!this.judge.storageStatus().clickhouseReady) return fallback();
    const window = resolveTimeWindow(filter);
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const hotEvents = foldLatestEventRevisions(
      (committedCutoffMs === undefined
        ? this.judge.pendingStoredEvents(window.startMs, window.endMs)
        : this.judge.queryRange(plan.hotFromMs, window.endMs))
        .filter((event) => filter.scope !== 'agent' || event.attribution?.monitored === true),
    );
    const overlapEventIds = hotEvents
      .filter((event) => event.at <= persistedUntilMs)
      .map((event) => event.eventId);
    let persisted: StoredAgentWindowFact[] | null;
    // Without a globally complete commit boundary, query the durable window through snapshot end
    // and overlay only the process-local pending FIFO. Closed buckets remain reusable; the commit
    // journal invalidates a bucket when one of those pending revisions later becomes durable.
    const reusableHotFromMs = committedCutoffMs === undefined
      ? window.endMs + 1
      : plan.hotFromMs;
    const slices = reusableFactSlices(window.startMs, persistedUntilMs, reusableHotFromMs);
    if (
      !window.custom &&
      window.spanMs <= 24 * HOUR &&
      slices.fullEndExclusiveMs > slices.fullStartMs
    ) {
      const scope = filter.scope === 'agent' ? 'agent' : 'all';
      let cache = this.agentHistoryBuckets.get(scope);
      if (!cache) {
        cache = new CommitAwareFactBucketCache<StoredAgentBucketFact>({
          latestCursor: () => this.judge.latestEventCommitCursor(),
          earliestCursor: () => this.judge.earliestEventCommitCursor(),
          changes: (after) => this.judge.eventCommitChanges(after),
          facts: (startMs, endExclusiveMs, bucketMs) =>
            this.historyQueryGate.run(() =>
              this.judge.agentWindowBucketFacts(
                startMs,
                endExclusiveMs,
                bucketMs,
                scope === 'agent',
              ),
            ),
        });
        this.agentHistoryBuckets.set(scope, cache);
      }
      const [stableFacts, headFacts, tailFacts] = await Promise.all([
        cache.read(slices.fullStartMs, slices.fullEndExclusiveMs).catch((error) => {
          console.warn(
            `[agents] reusable history unavailable; using bounded hot fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }),
        slices.head
          ? this.historyQueryGate.run(() =>
              this.judge.agentWindowFacts(
                slices.head!.startMs,
                slices.head!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
        slices.tail
          ? this.historyQueryGate.run(() =>
              this.judge.agentWindowFacts(
                slices.tail!.startMs,
                slices.tail!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
      ]);
      persisted = stableFacts && headFacts && tailFacts
        ? [...headFacts, ...stableFacts, ...tailFacts]
        : null;
    } else {
      persisted = await this.historyQueryGate.run(() =>
        this.judge.agentWindowFacts(
          window.startMs,
          persistedUntilMs,
          filter.scope === 'agent',
          overlapEventIds,
        ),
      );
    }
    if (!persisted) return fallback();

    const allFacts = [
      ...persisted,
      ...hotEvents.map((event) => this.agentFactForEvent(event)),
    ];
    // Build the bounded strong-alias union before assigning group keys. This makes a batch
    // independent of whether its physical Observer fact or logical Adapter fact arrived first.
    for (const fact of allFacts) this.agentMetadata.resolveEvent(fact.representativeEvent);
    const factsByInstance = new Map<string, StoredAgentWindowFact>();
    for (const fact of allFacts) {
      const assetId = this.agentMetadata.resolveEvent(fact.representativeEvent).agentAssetId;
      const instanceId = agentRuntimeInstanceIdForEvent(fact.representativeEvent);
      const groupKey = agentInventoryGroupKey(assetId, instanceId);
      const current = factsByInstance.get(groupKey);
      factsByInstance.set(groupKey, current ? this.mergeAgentFacts(current, fact) : fact);
    }
    const result = this.agentInventoryFromEvents(
      filter,
      [...factsByInstance.values()].map((fact) => fact.representativeEvent),
      factsByInstance,
    );
    result.coverage = this.queryCoverage(filter, [...factsByInstance.values()].map((fact) => fact.representativeEvent), {
      source: hotEvents.length ? 'clickhouse+hot_delta' : 'clickhouse',
      totalMode: 'exact',
      partial: false,
      committedCutoffMs,
      dataFromMs: allFacts.length ? Math.min(...allFacts.map((fact) => fact.firstSeenAt)) : undefined,
      dataToMs: allFacts.length ? Math.max(...allFacts.map((fact) => fact.lastSeenAt)) : undefined,
    });
    this.agentInventoryLastGood.delete(lkgKey);
    this.agentInventoryLastGood.set(lkgKey, { at: now(), value: structuredClone(result) });
    while (this.agentInventoryLastGood.size > 32) {
      const oldest = this.agentInventoryLastGood.keys().next().value;
      if (oldest === undefined) break;
      this.agentInventoryLastGood.delete(oldest);
    }
    return result;
  }

  private agentInventoryFromEvents(
    filter: T.AgentInventoryQuery,
    events: T.JudgedEvent[],
    factsByInstance?: Map<string, StoredAgentWindowFact>,
  ): T.AgentInventory {
    for (const event of events) this.agentMetadata.resolveEvent(event);
    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    const agentId = filter.agentId?.trim();
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : undefined;
    const agentInstanceId = filter.agentInstanceId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean((filter.healthState && filter.healthState !== 'all') || (filter.criticality && filter.criticality !== 'all') || owner || environment || tag || q || filter.userId);
    const shouldScopeExactAgent = Boolean((agentAssetId || agentId || agentInstanceId) && !hasFilter);
    const byAgent = new Map<string, T.JudgedEvent[]>();
    for (const e of events) {
      if (shouldScopeExactAgent && !agentAssetId && agentId && e.agentId !== agentId && e.attribution?.agentScopeId !== agentId) continue;
      // A canonical asset selection identifies the workload. Legacy display fields must not
      // reject its raw events before metadata/alias resolution.
      if (!agentAssetId && workspacePath && e.workspacePath !== workspacePath) continue;
      if (!agentId && filter.userId && e.userId !== filter.userId) continue;
      const resolved = this.agentMetadata.resolveEvent(e);
      if (agentAssetId && resolved.agentAssetId !== agentAssetId) continue;
      const runtimeInstanceId = agentRuntimeInstanceIdForEvent(e);
      if (!matchesAgentRuntimeInstance(e, agentInstanceId)) continue;
      const groupKey = agentInventoryGroupKey(resolved.agentAssetId, runtimeInstanceId);
      (byAgent.get(groupKey) ?? byAgent.set(groupKey, []).get(groupKey)!).push(e);
    }

    const openIncidents = new Map<string, number>();
    for (const incident of this.judge.listIncidents(0)) {
      if (incident.status !== 'open') continue;
      if (filter.scope === 'agent' && incident.monitored !== true) continue;
      const key = `${incident.workspacePath}\0${incident.agentId}`;
      openIncidents.set(key, (openIncidents.get(key) ?? 0) + 1);
    }

    const t = now();
    const visibleAgentGroups = [...byAgent.entries()].filter(([groupKey, evs]) => {
      const identityEvent =
        [...evs].reverse().find((event) => Boolean(event.attribution?.classification)) ??
        evs.at(-1);
      if (!identityEvent) return false;
      const fact = factsByInstance?.get(groupKey);
      // Durable aggregate facts are authoritative for one concrete runtime. Falling back to the
      // representative event's inherited `process_lineage` would resurrect historical helper
      // processes that the aggregate correctly classified as lacking root evidence.
      const hasPhysicalRuntime = fact
        ? fact.hasPhysicalIdentity
        : evs.some((event) =>
            Boolean(
              event.attribution?.physicalWorkloadId ||
              event.attribution?.agentInstanceId ||
              event.attribution?.workloadRef?.podUid,
            )
          );
      const hasStrongRootRuntime = fact
        ? fact.hasRootIdentity
        : evs.some(hasAgentRuntimeLineageEvidence);
      if (
        fact?.hasInternalHelperRoot ||
        evs.some(isInternalAgentHelperRootEvent)
      ) return false;
      // Human/AI review classifies a logical identity; it cannot manufacture a runtime instance.
      // A concrete row still needs workload identity or a directly observed root lifetime.
      if (!hasPhysicalRuntime && !hasStrongRootRuntime) return false;
      if (shouldScopeExactAgent) return true;
      const resolved = this.agentMetadata.resolveEvent(identityEvent);
      if (resolved.effectiveClassification !== 'probable_agent') return true;
      if (resolved.metadata?.reviewDecision) return true;
      if (
        resolved.metadata?.displayName ||
        resolved.metadata?.owner ||
        resolved.metadata?.team ||
        resolved.metadata?.environment ||
        resolved.metadata?.note ||
        resolved.metadata?.tags?.length
      ) return true;
      return hasPhysicalRuntime || hasStrongRootRuntime;
    });

    const logicalInstanceCounts = new Map<string, number>();
    for (const [, evs] of visibleAgentGroups) {
      const identityEvent = evs.at(-1);
      if (!identityEvent) continue;
      const assetId = this.agentMetadata.resolveEvent(identityEvent).agentAssetId;
      logicalInstanceCounts.set(assetId, (logicalInstanceCounts.get(assetId) ?? 0) + 1);
    }

    const eventBackedItems = visibleAgentGroups.map(([groupKey, evs]): T.AgentInventoryItem => {
      const sorted = [...evs].sort((a, b) => a.at - b.at);
      const fact = factsByInstance?.get(groupKey);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const risky = sorted.filter((e) => e.verdict !== 'allow');
      const lvl = fact
        ? levelByRank(fact.worstSeverityRank)
        : worstLevel(sorted);
      const identityEvent =
        [...sorted].reverse().find((event) => Boolean(event.attribution?.classification)) ??
        last;
      const resolved = this.agentMetadata.resolveEvent(identityEvent);
      const assetId = resolved.agentAssetId;
      const detected = detectedAgentIdentity(identityEvent);
      const metadata = resolved.metadata;
      const attribution = identityEvent.attribution;
      const classification = resolved.effectiveClassification;
      const reviewed = Boolean(metadata?.reviewDecision);
      const itemAgentId =
        attribution?.agentScopeId ??
        attribution?.agentDisplayName ??
        detected.detectedName ??
        last.agentId;
      const itemWorkspacePath = last.workspacePath;
      const incidentKeys = new Set(sorted.map((event) => `${event.workspacePath}\0${event.agentId}`));
      const openIncidentCount = [...incidentKeys].reduce(
        (total, incidentKey) => total + (openIncidents.get(incidentKey) ?? 0),
        0,
      );
      const sinceLast = t - (fact?.lastSeenAt ?? last.at);
      const rootExit = [...sorted].reverse().find((event) =>
        event.eventKind === 'ProcessExit' &&
        Boolean(event.attribution?.rootPid) &&
        event.process?.pid === event.attribution?.rootPid
      );
      const terminatedAt = rootExit && !sorted.some((event) => event.at > rootExit.at)
        ? rootExit.at
        : undefined;
      const lifecycleState: T.AgentLifecycleState = terminatedAt !== undefined
        ? 'terminated'
        : sinceLast <= ACTIVE_MS
          ? 'current'
          : 'historical';
      const healthState: T.AgentHealthState = openIncidentCount > 0
        ? 'risky'
        : sinceLast <= ACTIVE_MS
          ? 'active'
          : sinceLast <= STALE_MS
            ? 'idle'
            : 'stale';
      const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [
        category,
        fact?.eventCategoryCounts[category] ?? 0,
      ])) as Record<T.EventCategory, number>;
      const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [
        source,
        fact?.sourceCounts[source] ?? 0,
      ])) as Record<T.EventSource, number>;
      const topRisk = new Map<string, { count: number; name: string }>();
      if (!fact) {
        for (const e of sorted) {
          categoryCounts[e.eventCategory] = (categoryCounts[e.eventCategory] ?? 0) + 1;
          sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;
          if (e.verdict !== 'allow') {
            const cur = topRisk.get(e.riskCategory);
            topRisk.set(e.riskCategory, { count: (cur?.count ?? 0) + 1, name: e.riskName });
          }
        }
      }
      const top = [...topRisk.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      const runtimeInstanceId = agentRuntimeInstanceIdForEvent(identityEvent);
      return {
        agentId: itemAgentId,
        agentAssetId: assetId,
        agentAssetAliases: resolved.agentAssetAliases,
        agentProduct: resolved.agentProduct,
        workspacePath: itemWorkspacePath,
        userId: last.userId,
        displayName: resolved.displayName,
        detectedName: resolved.detectedName,
        detectedClassification: resolved.detectedClassification,
        owner: metadata?.owner,
        team: metadata?.team,
        environment: metadata?.environment,
        criticality: metadata?.criticality,
        tags: metadata?.tags ?? [],
        note: metadata?.note,
        metadataUpdatedAt: metadata?.updatedAt ? iso(metadata.updatedAt) : undefined,
        classification,
        runtime: detected.runtime,
        locationLabel: detected.locationLabel,
        instanceCount: 1,
        logicalInstanceCount: logicalInstanceCounts.get(assetId) ?? 1,
        confidence: reviewed ? 1 : attribution?.confidence ?? 0,
        attributionSource: reviewed ? 'manual_review' : attribution?.source ?? 'none',
        attributionEvidence: reviewed
          ? [
              ...(attribution?.evidence ?? []),
              `manual_review:${metadata?.reviewDecision}`,
              ...(metadata?.reviewedBy ? [`manual_review:reviewer=${metadata.reviewedBy}`] : []),
            ].slice(-16)
          : attribution?.evidence ?? [],
        physicalWorkloadId: attribution?.physicalWorkloadId ?? metadata?.reviewPhysicalWorkloadId,
        agentInstanceId: runtimeInstanceId,
        agentInstanceAliases: resolved.agentRuntimeInstanceAliases,
        identityBindingQuality: resolved.bindingQuality,
        identityReasonCode: resolved.identityReasonCode,
        workloadRef: attribution?.workloadRef ?? metadata?.reviewWorkloadRef,
        hostId: identityEvent.process?.hostId,
        bootId: identityEvent.process?.bootId,
        rootPid: attribution?.rootPid,
        rootStartTime: attribution?.rootStartTime,
        reviewDecision: metadata?.reviewDecision,
        reviewedBy: metadata?.reviewedBy,
        reviewedAt: metadata?.reviewedAt ? iso(metadata.reviewedAt) : undefined,
        reviewNote: metadata?.reviewNote,
        reviewIdentityKeys:
          metadata?.identityKeys ??
          metadata?.reviewIdentityKeys ??
          this.agentMetadata.identityKeysForEvent(identityEvent),
        firstSeen: iso(fact?.firstSeenAt ?? first.at),
        lastSeen: iso(fact?.lastSeenAt ?? last.at),
        lifecycleState,
        terminatedAt: terminatedAt !== undefined ? iso(terminatedAt) : undefined,
        healthState,
        riskLevel: lvl.level,
        riskLevelText: lvl.text,
        eventCount: fact?.eventCount ?? sorted.length,
        riskyEventCount: fact?.riskyEventCount ?? risky.length,
        openIncidentCount,
        sessionCount: fact?.sessionCount ?? distinct(sorted.map((e) => e.sessionId)),
        runCount: fact?.runCount ?? distinct(sorted.map((e) => e.runId)),
        traceCount: fact?.traceCount ?? distinct(sorted.map((e) => e.traceId)),
        tokenCount: fact?.tokenCount ?? sorted.reduce((a, e) => a + e.tokenCount, 0),
        avgLatencyMs: fact
          ? Math.round(fact.latencyTotal / Math.max(1, fact.eventCount))
          : Math.round(mean(sorted.map((e) => e.latencyMs))),
        topRiskCategory: fact?.topRiskCategory ?? top?.[0],
        topRiskName: fact?.topRiskName ?? top?.[1].name,
        lastEventSubject: last.subject,
        lastEventId: last.eventId,
        collectorIds: fact?.collectorKeys ?? [...new Set(sorted.map(eventCollectorId).filter(Boolean))],
        eventsWithoutCollector: fact?.eventsWithoutCollector ?? sorted.filter(missingCollectorCoverage).length,
        eventCategoryCounts: categoryCounts,
        sourceCounts,
      };
    });

    const eventBackedAssetIds = new Set(eventBackedItems.map((item) => item.agentAssetId));
    const metadataOnlyItems = this.agentMetadata.list()
      .filter((metadata) =>
        (
          isAgentAssetClassification(metadata.reviewDecision ?? 'unknown') ||
          Boolean(filter.includeUnclassified && (agentAssetId || agentId))
        ) &&
        !eventBackedAssetIds.has(metadata.agentAssetId) &&
        !agentInstanceId &&
        (
          !shouldScopeExactAgent ||
          (agentAssetId ? metadata.agentAssetId === agentAssetId : metadata.agentId === agentId)
        ) &&
        (!agentAssetId || metadata.agentAssetId === agentAssetId) &&
        (!workspacePath || metadata.workspacePath === workspacePath) &&
        !filter.userId
      )
      .map((metadata): T.AgentInventoryItem => {
        const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [category, 0])) as Record<T.EventCategory, number>;
        const sourceCounts = Object.fromEntries(EVENT_SOURCES.map((source) => [source, 0])) as Record<T.EventSource, number>;
        return {
          agentId: metadata.agentId,
          agentAssetId: metadata.agentAssetId,
          agentAssetAliases: metadata.agentAssetAliases,
          workspacePath: metadata.workspacePath,
          userId: '-',
          displayName: metadata.displayName,
          detectedName: metadata.agentId,
          detectedClassification: 'unknown',
          owner: metadata.owner,
          team: metadata.team,
          environment: metadata.environment,
          criticality: metadata.criticality,
          tags: metadata.tags,
          note: metadata.note,
          metadataUpdatedAt: metadata.updatedAt,
          classification: metadata.reviewDecision ?? 'unknown',
          runtime: metadata.workloadRef?.environment ?? metadata.reviewWorkloadRef?.environment ?? 'unknown',
          locationLabel: metadata.workspacePath,
          instanceCount: metadata.agentInstanceId || metadata.reviewAgentInstanceId ? 1 : 0,
          confidence: metadata.reviewDecision ? 1 : 0,
          attributionSource: metadata.reviewDecision ? 'manual_review' : 'none',
          attributionEvidence: metadata.reviewDecision
            ? [
                `manual_review:${metadata.reviewDecision}`,
                ...(metadata.reviewedBy ? [`manual_review:reviewer=${metadata.reviewedBy}`] : []),
              ]
            : [],
          physicalWorkloadId: metadata.physicalWorkloadId ?? metadata.reviewPhysicalWorkloadId,
          agentInstanceId: metadata.agentInstanceId ?? metadata.reviewAgentInstanceId,
          workloadRef: metadata.workloadRef ?? metadata.reviewWorkloadRef,
          reviewDecision: metadata.reviewDecision,
          reviewedBy: metadata.reviewedBy,
          reviewedAt: metadata.reviewedAt,
          reviewNote: metadata.reviewNote,
          reviewIdentityKeys: metadata.identityKeys ?? metadata.reviewIdentityKeys ?? [metadata.agentId.toLowerCase()],
          firstSeen: metadata.updatedAt,
          lastSeen: metadata.updatedAt,
          lifecycleState: 'historical',
          healthState: 'stale',
          riskLevel: 'safe',
          riskLevelText: LEVEL_TEXT.safe,
          eventCount: 0,
          riskyEventCount: 0,
          openIncidentCount: 0,
          sessionCount: 0,
          runCount: 0,
          traceCount: 0,
          tokenCount: 0,
          avgLatencyMs: 0,
          lastEventSubject: 'metadata-only asset',
          collectorIds: [],
          eventsWithoutCollector: 0,
          eventCategoryCounts: categoryCounts,
          sourceCounts,
        };
      });

    const items = [...eventBackedItems, ...metadataOnlyItems];

    const filtered = items
      .filter((item) => {
        const matchesInstance = !agentInstanceId || item.agentInstanceId === agentInstanceId;
        const matchesAgentId = Boolean(
          matchesInstance && (
            (agentAssetId && item.agentAssetId === agentAssetId) ||
            (agentId && item.agentId === agentId && (!workspacePath || item.workspacePath === workspacePath))
          ),
        );
        if (
          !isAgentAssetClassification(item.classification) &&
          !(filter.includeUnclassified && matchesAgentId)
        ) {
          return false;
        }
        const matchesFilter =
          (!filter.healthState || filter.healthState === 'all' || item.healthState === filter.healthState) &&
          (!filter.criticality || filter.criticality === 'all' || item.criticality === filter.criticality) &&
          (!owner || (item.owner ?? '').toLowerCase().includes(owner)) &&
          (!environment || (item.environment ?? '').toLowerCase().includes(environment)) &&
          (!tag || item.tags.some((value) => value.toLowerCase().includes(tag))) &&
          (!q || [
            item.agentId,
            item.agentAssetId,
            item.agentInstanceId,
            item.displayName,
            item.detectedName,
            item.locationLabel,
            item.workspacePath,
            item.hostId,
            item.bootId,
            item.rootPid !== undefined ? String(item.rootPid) : undefined,
            item.rootStartTime,
            item.userId,
            item.owner,
            item.team,
            item.environment,
            item.criticality,
            item.note,
            item.topRiskName,
            item.lastEventSubject,
            ...item.tags,
          ].some((v) => (v ?? '').toLowerCase().includes(q)));
        if ((agentAssetId || agentId) && !hasFilter) return matchesAgentId;
        return matchesAgentId || matchesFilter;
      })
      .sort((a, b) => {
        const classificationRank: Record<T.AgentClassification, number> = {
          confirmed_agent: 0,
          probable_agent: 1,
          unknown: 2,
          non_agent: 3,
        };
        const riskRank: Record<string, number> = {
          critical: 4,
          high: 3,
          medium: 2,
          low: 1,
          safe: 0,
          unknown: 0,
        };
        const aSelected = Boolean(
          (!agentInstanceId || a.agentInstanceId === agentInstanceId) &&
          (
            (agentAssetId && a.agentAssetId === agentAssetId) ||
            (agentId && a.agentId === agentId && (!workspacePath || a.workspacePath === workspacePath))
          ),
        );
        const bSelected = Boolean(
          (!agentInstanceId || b.agentInstanceId === agentInstanceId) &&
          (
            (agentAssetId && b.agentAssetId === agentAssetId) ||
            (agentId && b.agentId === agentId && (!workspacePath || b.workspacePath === workspacePath))
          ),
        );
        return Number(bSelected) - Number(aSelected)
          || classificationRank[a.classification] - classificationRank[b.classification]
          || (riskRank[b.riskLevel] ?? 0) - (riskRank[a.riskLevel] ?? 0)
          || b.openIncidentCount - a.openIncidentCount
          || b.riskyEventCount - a.riskyEventCount
          || Date.parse(b.lastSeen) - Date.parse(a.lastSeen)
          || (a.displayName ?? a.detectedName ?? a.agentId).localeCompare(b.displayName ?? b.detectedName ?? b.agentId)
          || a.agentAssetId.localeCompare(b.agentAssetId)
          || (a.agentInstanceId ?? '').localeCompare(b.agentInstanceId ?? '');
      });

    const summary: T.AgentInventorySummary = {
      totalAgents: filtered.length,
      managedAgents: filtered.filter((item) => item.metadataUpdatedAt).length,
      productionAgents: filtered.filter((item) => item.environment?.toLowerCase() === 'prod' || item.environment?.toLowerCase() === 'production').length,
      highCriticalityAgents: filtered.filter((item) => item.criticality === 'high' || item.criticality === 'critical').length,
      activeAgents: filtered.filter((item) => item.healthState === 'active').length,
      idleAgents: filtered.filter((item) => item.healthState === 'idle').length,
      staleAgents: filtered.filter((item) => item.healthState === 'stale').length,
      riskyAgents: filtered.filter((item) => item.healthState === 'risky').length,
      openIncidentAgents: filtered.filter((item) => item.openIncidentCount > 0).length,
      observedEventCount: filtered.reduce((a, item) => a + item.eventCount, 0),
      riskyEventCount: filtered.reduce((a, item) => a + item.riskyEventCount, 0),
    };
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
      summary,
      coverage: this.queryCoverage(filter, events, {
        source: 'memory_hot_ring',
        totalMode: 'exact',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      updateTime: iso(),
    };
  }

  agentInstanceMetrics(filter: T.AgentInstanceMetricsQuery): T.AgentInstanceMetrics {
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : '';
    const agentInstanceId = filter.agentInstanceId?.trim();
    const cacheKey = [
      agentAssetId,
      agentInstanceId ?? '',
      filter.timeType ?? '',
      filter.startTime ?? '',
      filter.endTime ?? '',
      filter.seriesPoints ?? 36,
      this.agentMetadata.identitySnapshotVersion(),
    ].join('\0');
    const cached = this.agentInstanceMetricsCache.get(cacheKey);
    if (cached && now() - cached.at < 15_000) return cached.value;
    const window = this.win(filter);
    const events = agentAssetId
      ? window.events.filter((event) =>
          this.agentMetadata.resolveEvent(event).agentAssetId === agentAssetId &&
          matchesAgentRuntimeInstance(event, agentInstanceId)
        )
      : [];
    const pointCount = Math.max(12, Math.min(72, filter.seriesPoints ?? 36));
    const bucketSize = window.spanMs / pointCount || 1;
    const buckets = this.buckets(events, window.sinceMs, window.spanMs, pointCount);
    const points = buckets.map((bucket, index): T.AgentInstanceMetricPoint => {
      const latencies = bucket
        .map((event) => event.latencyMs)
        .filter((value) => Number.isFinite(value) && value >= 0);
      return {
        statTime: iso(window.sinceMs + index * bucketSize),
        eventCount: bucket.length,
        riskyEventCount: bucket.filter((event) => event.verdict !== 'allow').length,
        blockedCount: bucket.filter((event) => event.verdict === 'block').length,
        escalatedCount: bucket.filter((event) => event.verdict === 'escalate').length,
        toolCount: bucket.filter((event) => event.eventCategory === 'tool').length,
        fileCount: bucket.filter((event) => event.eventCategory === 'file').length,
        networkCount: bucket.filter((event) => event.eventCategory === 'network').length,
        processCount: bucket.filter((event) => event.eventCategory === 'process' || event.eventCategory === 'runtime').length,
        llmCount: bucket.filter((event) => event.eventCategory === 'llm').length,
        l1Count: bucket.filter((event) => event.tier === 'Rules').length,
        l2Count: bucket.filter((event) => event.tier === 'Llm').length,
        l3Count: bucket.filter((event) => event.tier === 'Agent').length,
        failedCount: bucket.filter((event) => event.decisionStatus === 'failed').length,
        timeoutCount: bucket.filter((event) => event.decisionStatus === 'timeout').length,
        tokenCount: bucket.reduce((total, event) => total + event.tokenCount, 0),
        avgLatencyMs: Math.round(mean(latencies)),
        maxRiskScore: bucket.length ? Math.max(...bucket.map((event) => event.riskScore)) : 0,
      };
    });
    const latencies = events
      .map((event) => event.latencyMs)
      .filter((value) => Number.isFinite(value) && value >= 0);
    const value: T.AgentInstanceMetrics = {
      agentAssetId,
      points,
      eventCount: events.length,
      riskyEventCount: events.filter((event) => event.verdict !== 'allow').length,
      blockedCount: events.filter((event) => event.verdict === 'block').length,
      escalatedCount: events.filter((event) => event.verdict === 'escalate').length,
      tokenCount: events.reduce((total, event) => total + event.tokenCount, 0),
      avgLatencyMs: Math.round(mean(latencies)),
      failedCount: events.filter((event) => event.decisionStatus === 'failed').length,
      timeoutCount: events.filter((event) => event.decisionStatus === 'timeout').length,
      updateTime: iso(),
    };
    this.agentInstanceMetricsCache.set(cacheKey, { at: now(), value });
    if (this.agentInstanceMetricsCache.size > 256) {
      const oldestKey = [...this.agentInstanceMetricsCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldestKey) this.agentInstanceMetricsCache.delete(oldestKey);
    }
    return value;
  }

  private metricFactForEvent(
    event: T.JudgedEvent,
    bucketIndex: number,
    recentSinceMs: number,
  ): StoredAgentMetricBucketFact {
    const recent = event.at > recentSinceMs;
    return {
      bucketIndex,
      identityKey: event.eventId,
      agentId: event.agentId,
      representativeEvent: event,
      eventCount: 1,
      riskyEventCount: event.verdict !== 'allow' ? 1 : 0,
      blockedCount: event.verdict === 'block' ? 1 : 0,
      escalatedCount: event.verdict === 'escalate' ? 1 : 0,
      toolCount: event.eventCategory === 'tool' ? 1 : 0,
      fileCount: event.eventCategory === 'file' ? 1 : 0,
      networkCount: event.eventCategory === 'network' ? 1 : 0,
      processCount: event.eventCategory === 'process' || event.eventCategory === 'runtime' ? 1 : 0,
      llmCount: event.eventCategory === 'llm' ? 1 : 0,
      l1Count: event.tier === 'Rules' ? 1 : 0,
      l2Count: event.tier === 'Llm' ? 1 : 0,
      l3Count: event.tier === 'Agent' ? 1 : 0,
      failedCount: event.decisionStatus === 'failed' ? 1 : 0,
      timeoutCount: event.decisionStatus === 'timeout' ? 1 : 0,
      tokenCount: event.tokenCount,
      latencyTotal: event.latencyMs,
      maxRiskScore: event.riskScore,
      sessionKeys: [event.sessionId],
      recentEventCount: recent ? 1 : 0,
      recentCommCount: recent && (event.eventKind === 'Egress' || event.eventKind === 'Dns') ? 1 : 0,
      recentSessionKeys: recent ? [event.sessionId] : [],
    };
  }

  private observabilityFactForEvents(
    events: T.JudgedEvent[],
    recentSinceMs: number,
  ): StoredAgentObservabilityFact {
    const recent = events.filter((event) => event.at > recentSinceMs);
    return {
      eventCount: events.length,
      riskyEventCount: events.filter((event) => event.verdict !== 'allow').length,
      latencyTotal: events.reduce((sum, event) => sum + event.latencyMs, 0),
      agentIds: [...new Set(events.map((event) => event.agentId).filter(Boolean))],
      recentEventCount: recent.length,
      recentCommCount: recent.filter(
        (event) => event.eventKind === 'Egress' || event.eventKind === 'Dns',
      ).length,
      recentSessionKeys: [...new Set(recent.map((event) => event.sessionId).filter(Boolean))],
    };
  }

  private async storedAgentObservabilityFact(
    filter: T.SecurityTimeFilter,
  ): Promise<{
    fact: StoredAgentObservabilityFact;
    coverage: T.QueryCoverage;
  } | null> {
    if (!this.judge.storageStatus().clickhouseReady) return null;
    const window = resolveTimeWindow(filter);
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    if (committedCutoffMs === undefined) return null;
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = Math.min(
      plan.persistedUntilMs ?? window.endMs,
      Math.max(window.startMs - 1, plan.hotFromMs - 1),
    );
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs)
        .filter((event) => filter.scope !== 'agent' || isMonitoredAgentEvent(event)),
    );
    const persisted = await this.judge.agentObservabilityFact(
      window.startMs,
      persistedUntilMs,
      filter.scope === 'agent',
    );
    if (!persisted) return null;
    const hot = this.observabilityFactForEvents(
      hotEvents,
      Math.max(window.startMs, window.endMs - 60_000),
    );
    return {
      fact: {
        eventCount: persisted.eventCount + hot.eventCount,
        riskyEventCount: persisted.riskyEventCount + hot.riskyEventCount,
        latencyTotal: persisted.latencyTotal + hot.latencyTotal,
        agentIds: [...new Set([...persisted.agentIds, ...hot.agentIds])],
        recentEventCount: persisted.recentEventCount + hot.recentEventCount,
        recentCommCount: persisted.recentCommCount + hot.recentCommCount,
        recentSessionKeys: [
          ...new Set([...persisted.recentSessionKeys, ...hot.recentSessionKeys]),
        ],
      },
      coverage: this.queryCoverage(filter, [], {
        source: hotEvents.length ? 'clickhouse+hot_delta' : 'clickhouse',
        totalMode: 'exact',
        partial: false,
        committedCutoffMs,
        dataFromMs: window.startMs,
        dataToMs: window.endMs,
      }),
    };
  }

  private async storedAgentMetricFacts(
    filter: T.SecurityTimeFilter,
    bucketCount: number,
    hydrateRepresentatives = true,
  ): Promise<{
    facts: StoredAgentMetricBucketFact[];
    coverage: T.QueryCoverage;
  } | null> {
    if (!this.judge.storageStatus().clickhouseReady) return null;
    const window = resolveTimeWindow(filter);
    const pointCount = Math.max(1, Math.min(72, Math.round(bucketCount)));
    const bucketSize = window.spanMs / pointCount || 1;
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    if (committedCutoffMs === undefined) return null;
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    // Keep the durable and hot sources disjoint by construction. Passing every overlap event ID
    // through ClickHouse HTTP eventually exceeds its form-field limit during sustained ingestion;
    // ending the durable range immediately before the complete hot tail is exact and needs no
    // exclusion parameter.
    const persistedUntilMs = Math.min(
      plan.persistedUntilMs ?? window.endMs,
      Math.max(window.startMs - 1, plan.hotFromMs - 1),
    );
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs)
        .filter((event) => filter.scope !== 'agent' || isMonitoredAgentEvent(event)),
    );
    const persisted = await this.judge.agentMetricBucketFacts(
      window.startMs,
      persistedUntilMs,
      pointCount,
      filter.scope === 'agent',
      [],
      hydrateRepresentatives,
    );
    if (!persisted) return null;
    const recentSinceMs = Math.max(window.startMs, window.endMs - 60_000);
    const hotFacts = hotEvents.map((event) => this.metricFactForEvent(
      event,
      Math.min(pointCount - 1, Math.max(0, Math.floor((event.at - window.startMs) / bucketSize))),
      recentSinceMs,
    ));
    const facts = [...persisted, ...hotFacts];
    return {
      facts,
      coverage: this.queryCoverage(
        filter,
        facts.flatMap((fact) => fact.representativeEvent ? [fact.representativeEvent] : []),
        {
          source: hotEvents.length ? 'clickhouse+hot_delta' : 'clickhouse',
          totalMode: 'exact',
          partial: false,
          committedCutoffMs,
          dataFromMs: window.startMs,
          dataToMs: window.endMs,
        },
      ),
    };
  }

  async storedAgentInstanceMetrics(filter: T.AgentInstanceMetricsQuery): Promise<T.AgentInstanceMetrics> {
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : '';
    const agentInstanceId = filter.agentInstanceId?.trim();
    const pointCount = Math.max(12, Math.min(72, filter.seriesPoints ?? 36));
    const cacheKey = [
      'durable',
      agentAssetId,
      agentInstanceId ?? '',
      filter.timeType ?? '',
      filter.startTime ?? '',
      filter.endTime ?? '',
      pointCount,
      this.agentMetadata.identitySnapshotVersion(),
    ].join('\0');
    const cached = this.agentInstanceMetricsCache.get(cacheKey);
    if (cached && now() - cached.at < 15_000) return cached.value;
    const durable = await this.storedAgentMetricFacts({ ...filter, scope: 'agent' }, pointCount);
    if (!durable) return this.agentInstanceMetrics(filter);
    const window = resolveTimeWindow(filter);
    const bucketSize = window.spanMs / pointCount || 1;
    const selected = durable.facts.filter((fact) =>
      agentAssetId &&
      fact.representativeEvent &&
      this.agentMetadata.resolveEvent(fact.representativeEvent).agentAssetId === agentAssetId &&
      matchesAgentRuntimeInstance(fact.representativeEvent, agentInstanceId),
    );
    const bucketFacts = Array.from({ length: pointCount }, () => [] as StoredAgentMetricBucketFact[]);
    for (const fact of selected) {
      if (fact.bucketIndex >= 0 && fact.bucketIndex < pointCount) bucketFacts[fact.bucketIndex].push(fact);
    }
    const points = bucketFacts.map((facts, index): T.AgentInstanceMetricPoint => {
      const eventCount = facts.reduce((sum, fact) => sum + fact.eventCount, 0);
      return {
        statTime: iso(window.startMs + index * bucketSize),
        eventCount,
        riskyEventCount: facts.reduce((sum, fact) => sum + fact.riskyEventCount, 0),
        blockedCount: facts.reduce((sum, fact) => sum + fact.blockedCount, 0),
        escalatedCount: facts.reduce((sum, fact) => sum + fact.escalatedCount, 0),
        toolCount: facts.reduce((sum, fact) => sum + fact.toolCount, 0),
        fileCount: facts.reduce((sum, fact) => sum + fact.fileCount, 0),
        networkCount: facts.reduce((sum, fact) => sum + fact.networkCount, 0),
        processCount: facts.reduce((sum, fact) => sum + fact.processCount, 0),
        llmCount: facts.reduce((sum, fact) => sum + fact.llmCount, 0),
        l1Count: facts.reduce((sum, fact) => sum + fact.l1Count, 0),
        l2Count: facts.reduce((sum, fact) => sum + fact.l2Count, 0),
        l3Count: facts.reduce((sum, fact) => sum + fact.l3Count, 0),
        failedCount: facts.reduce((sum, fact) => sum + fact.failedCount, 0),
        timeoutCount: facts.reduce((sum, fact) => sum + fact.timeoutCount, 0),
        tokenCount: facts.reduce((sum, fact) => sum + fact.tokenCount, 0),
        avgLatencyMs: Math.round(facts.reduce((sum, fact) => sum + fact.latencyTotal, 0) / (eventCount || 1)),
        maxRiskScore: Math.max(0, ...facts.map((fact) => fact.maxRiskScore)),
      };
    });
    const eventCount = selected.reduce((sum, fact) => sum + fact.eventCount, 0);
    const value: T.AgentInstanceMetrics = {
      agentAssetId,
      points,
      eventCount,
      riskyEventCount: selected.reduce((sum, fact) => sum + fact.riskyEventCount, 0),
      blockedCount: selected.reduce((sum, fact) => sum + fact.blockedCount, 0),
      escalatedCount: selected.reduce((sum, fact) => sum + fact.escalatedCount, 0),
      tokenCount: selected.reduce((sum, fact) => sum + fact.tokenCount, 0),
      avgLatencyMs: Math.round(selected.reduce((sum, fact) => sum + fact.latencyTotal, 0) / (eventCount || 1)),
      failedCount: selected.reduce((sum, fact) => sum + fact.failedCount, 0),
      timeoutCount: selected.reduce((sum, fact) => sum + fact.timeoutCount, 0),
      coverage: durable.coverage,
      updateTime: iso(window.endMs),
    };
    this.agentInstanceMetricsCache.set(cacheKey, { at: now(), value });
    return value;
  }

  private workspaceFactForEvent(event: T.JudgedEvent): StoredWorkspaceWindowFact {
    const risky = event.verdict !== 'allow';
    const collectorId = eventCollectorId(event);
    const resolvedWorkspacePath =
      this.agentMetadata.resolveEvent(event).metadata?.workspacePath ??
      attributionWorkspacePath(event);
    return {
      workspacePath: resolvedWorkspacePath,
      representativeEvent: event,
      firstSeenAt: event.at,
      lastSeenAt: event.at,
      eventCount: 1,
      riskyEventCount: risky ? 1 : 0,
      sessionKeys: [event.sessionId],
      runKeys: [event.runId],
      traceKeys: [event.traceId],
      collectorKeys: collectorId ? [collectorId] : [],
      tokenCount: event.tokenCount,
      latencyTotal: event.latencyMs,
      worstSeverityRank: risky ? SEV_RANK[event.severity] : 0,
      topRiskAt: risky ? event.at : undefined,
      topRiskCategory: risky ? event.riskCategory : undefined,
      topRiskName: risky ? event.riskName : undefined,
    };
  }

  private mergeWorkspaceFacts(
    a: StoredWorkspaceWindowFact,
    b: StoredWorkspaceWindowFact,
  ): StoredWorkspaceWindowFact {
    const newest = a.lastSeenAt >= b.lastSeenAt ? a : b;
    const latestRisk = (b.topRiskAt ?? 0) >= (a.topRiskAt ?? 0) ? b : a;
    return {
      workspacePath: newest.workspacePath,
      representativeEvent: newest.representativeEvent,
      firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
      lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
      eventCount: a.eventCount + b.eventCount,
      riskyEventCount: a.riskyEventCount + b.riskyEventCount,
      sessionKeys: [...new Set([...a.sessionKeys, ...b.sessionKeys])],
      runKeys: [...new Set([...a.runKeys, ...b.runKeys])],
      traceKeys: [...new Set([...a.traceKeys, ...b.traceKeys])],
      collectorKeys: [...new Set([...a.collectorKeys, ...b.collectorKeys])],
      tokenCount: a.tokenCount + b.tokenCount,
      latencyTotal: a.latencyTotal + b.latencyTotal,
      worstSeverityRank: Math.max(a.worstSeverityRank, b.worstSeverityRank),
      topRiskAt: latestRisk.topRiskAt,
      topRiskCategory: latestRisk.topRiskCategory,
      topRiskName: latestRisk.topRiskName,
    };
  }

  async storedWorkspaceInventory(filter: T.WorkspaceInventoryQuery): Promise<T.WorkspaceInventory> {
    if (!this.judge.storageStatus().clickhouseReady) return this.workspaceInventory(filter);
    const window = resolveTimeWindow(filter);
    const committedCutoffMs = this.judge.committedEventCutoffMs();
    if (committedCutoffMs === undefined) return this.workspaceInventory(filter);
    const plan = planDashboardRead(window.startMs, window.endMs, committedCutoffMs);
    const persistedUntilMs = plan.persistedUntilMs ?? window.endMs;
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs)
        .filter((event) => filter.scope !== 'agent' || event.attribution?.monitored === true),
    );
    const overlapEventIds = hotEvents
      .filter((event) => event.at <= persistedUntilMs)
      .map((event) => event.eventId);
    const scope = filter.scope === 'agent' ? 'agent' : 'all';
    const slices = reusableFactSlices(window.startMs, persistedUntilMs, plan.hotFromMs);
    let persisted: StoredWorkspaceWindowFact[] | null = null;
    const reusablePreset =
      !window.custom &&
      window.spanMs <= 24 * HOUR &&
      slices.fullEndExclusiveMs > slices.fullStartMs;
    if (reusablePreset) {
      let cache = this.workspaceHistoryBuckets.get(scope);
      if (!cache) {
        cache = new CommitAwareFactBucketCache<StoredWorkspaceBucketFact>({
          latestCursor: () => this.judge.latestEventCommitCursor(),
          earliestCursor: () => this.judge.earliestEventCommitCursor(),
          changes: (cursor) => this.judge.eventCommitChanges(cursor),
          facts: (startMs, endExclusiveMs) => this.historyQueryGate.run(() =>
            this.judge.workspaceWindowBucketFacts(
              startMs,
              endExclusiveMs,
              REUSABLE_BUCKET_MS,
              scope === 'agent',
            ),
          ),
        }, REUSABLE_BUCKET_MS);
        this.workspaceHistoryBuckets.set(scope, cache);
      }
      const [reusableFacts, headFacts, tailFacts] = await Promise.all([
        cache.read(slices.fullStartMs, slices.fullEndExclusiveMs).catch((error) => {
          console.error('[aggregation] reusable workspace history failed:', (error as Error).message);
          return null;
        }),
        slices.head
          ? this.historyQueryGate.run(() =>
              this.judge.workspaceWindowFacts(
                slices.head!.startMs,
                slices.head!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
        slices.tail
          ? this.historyQueryGate.run(() =>
              this.judge.workspaceWindowFacts(
                slices.tail!.startMs,
                slices.tail!.endMs,
                scope === 'agent',
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
      ]);
      if (reusableFacts && headFacts && tailFacts) {
        persisted = [...headFacts, ...reusableFacts, ...tailFacts];
      }
    }
    if (!persisted && !reusablePreset) {
      // Only custom/non-reusable ranges retain the exact query path. A failed or busy reusable
      // preset already consumed its read budget and falls back to the bounded hot view below.
      persisted = await this.historyQueryGate.run(() =>
        this.judge.workspaceWindowFacts(
          window.startMs,
          persistedUntilMs,
          scope === 'agent',
          overlapEventIds,
        ),
      );
    }
    if (!persisted) return this.workspaceInventory(filter);

    const factsByWorkspace = new Map<string, StoredWorkspaceWindowFact>();
    for (const fact of [...persisted, ...hotEvents.map((event) => this.workspaceFactForEvent(event))]) {
      const resolvedWorkspacePath =
        this.agentMetadata.resolveEvent(fact.representativeEvent).metadata?.workspacePath ??
        fact.workspacePath;
      const canonicalFact = resolvedWorkspacePath === fact.workspacePath
        ? fact
        : { ...fact, workspacePath: resolvedWorkspacePath };
      const current = factsByWorkspace.get(resolvedWorkspacePath);
      factsByWorkspace.set(
        resolvedWorkspacePath,
        current ? this.mergeWorkspaceFacts(current, canonicalFact) : canonicalFact,
      );
    }

    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean(
      (filter.healthState && filter.healthState !== 'all') ||
      (filter.criticality && filter.criticality !== 'all') ||
      owner ||
      environment ||
      q
    );
    const shouldScopeExactWorkspace = Boolean(workspacePath && !hasFilter);
    const agents = await this.storedAgentInventory({
      timeType: filter.timeType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      scope: filter.scope,
      workspacePath: shouldScopeExactWorkspace ? workspacePath : undefined,
      limit: 500,
    });
    const byWorkspaceAgents = new Map<string, T.AgentInventoryItem[]>();
    for (const agent of agents.items) {
      if (shouldScopeExactWorkspace && agent.workspacePath !== workspacePath) continue;
      const current = byWorkspaceAgents.get(agent.workspacePath) ?? [];
      current.push(agent);
      byWorkspaceAgents.set(agent.workspacePath, current);
    }

    const workspaceKeys = new Set([...factsByWorkspace.keys(), ...byWorkspaceAgents.keys()]);
    const items = [...workspaceKeys].flatMap((key): T.WorkspaceInventoryItem[] => {
      if (shouldScopeExactWorkspace && key !== workspacePath) return [];
      const fact = factsByWorkspace.get(key);
      const wsAgents = byWorkspaceAgents.get(key) ?? [];
      if (!fact && !wsAgents.length) return [];
      const agentFirstSeen = wsAgents.map((agent) => Date.parse(agent.firstSeen)).filter(Number.isFinite);
      const agentLastSeen = wsAgents.map((agent) => Date.parse(agent.lastSeen)).filter(Number.isFinite);
      const firstMs = fact?.firstSeenAt ?? Math.min(...agentFirstSeen);
      const lastMs = fact?.lastSeenAt ?? Math.max(...agentLastSeen);
      const lvl = fact?.riskyEventCount
        ? levelByRank(fact.worstSeverityRank)
        : { level: 'safe', text: LEVEL_TEXT.safe };
      const maintenance = this.maintenance.activeFor({ workspacePath: key });
      const tags = [...new Set(wsAgents.flatMap((agent) => agent.tags ?? []))].slice(0, 24);
      const healthState: T.AgentHealthState = wsAgents.some((agent) => agent.healthState === 'risky')
        ? 'risky'
        : wsAgents.some((agent) => agent.healthState === 'active')
          ? 'active'
          : wsAgents.some((agent) => agent.healthState === 'idle')
            ? 'idle'
            : 'stale';
      const byLastSeen = [...wsAgents].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      const eventCount = fact?.eventCount ?? wsAgents.reduce((sum, agent) => sum + agent.eventCount, 0);
      return [{
        workspaceId: this.workspaceDirectory.resolveWorkspaceId(key),
        workspacePath: key,
        owner: mode(wsAgents.map((agent) => agent.owner)),
        team: mode(wsAgents.map((agent) => agent.team)),
        environment: mode(wsAgents.map((agent) => agent.environment)),
        criticality: worstCriticality(wsAgents.map((agent) => agent.criticality)),
        tags,
        healthState,
        riskLevel: lvl.level,
        riskLevelText: lvl.text,
        agentCount: wsAgents.length,
        managedAgentCount: wsAgents.filter((agent) => agent.metadataUpdatedAt).length,
        activeAgentCount: wsAgents.filter((agent) => agent.healthState === 'active').length,
        idleAgentCount: wsAgents.filter((agent) => agent.healthState === 'idle').length,
        staleAgentCount: wsAgents.filter((agent) => agent.healthState === 'stale').length,
        riskyAgentCount: wsAgents.filter((agent) => agent.healthState === 'risky').length,
        openIncidentCount: wsAgents.reduce((sum, agent) => sum + agent.openIncidentCount, 0),
        collectorCount: fact?.collectorKeys.length ?? 0,
        eventCount,
        riskyEventCount: fact?.riskyEventCount ?? wsAgents.reduce((sum, agent) => sum + agent.riskyEventCount, 0),
        sessionCount: fact?.sessionKeys.length ?? wsAgents.reduce((sum, agent) => sum + agent.sessionCount, 0),
        runCount: fact?.runKeys.length ?? wsAgents.reduce((sum, agent) => sum + agent.runCount, 0),
        traceCount: fact?.traceKeys.length ?? wsAgents.reduce((sum, agent) => sum + agent.traceCount, 0),
        tokenCount: fact?.tokenCount ?? wsAgents.reduce((sum, agent) => sum + agent.tokenCount, 0),
        avgLatencyMs: fact
          ? Math.round(fact.latencyTotal / (eventCount || 1))
          : Math.round(mean(wsAgents.map((agent) => agent.avgLatencyMs))),
        topRiskCategory: fact?.topRiskCategory ?? mode(wsAgents.map((agent) => agent.topRiskCategory)),
        topRiskName: fact?.topRiskName ?? mode(wsAgents.map((agent) => agent.topRiskName)),
        firstSeen: iso(Number.isFinite(firstMs) ? firstMs : window.startMs),
        lastSeen: iso(Number.isFinite(lastMs) ? lastMs : window.endMs),
        lastEventSubject: fact?.representativeEvent.subject ?? byLastSeen[0]?.lastEventSubject ?? '',
        maintenanceActive: Boolean(maintenance),
        maintenanceWindowId: maintenance?.windowId,
        maintenanceTitle: maintenance?.title,
      }];
    });

    const filtered = items
      .filter((item) => {
        const matchesWorkspacePath = Boolean(workspacePath && item.workspacePath === workspacePath);
        const matchesFilter =
          (!filter.healthState || filter.healthState === 'all' || item.healthState === filter.healthState) &&
          (!filter.criticality || filter.criticality === 'all' || item.criticality === filter.criticality) &&
          (!owner || (item.owner ?? '').toLowerCase().includes(owner)) &&
          (!environment || (item.environment ?? '').toLowerCase().includes(environment)) &&
          (!q || [
            item.workspacePath,
            item.owner,
            item.team,
            item.environment,
            item.criticality,
            item.topRiskName,
            item.topRiskCategory,
            item.lastEventSubject,
            item.maintenanceTitle,
            ...item.tags,
          ].some((value) => (value ?? '').toLowerCase().includes(q)));
        if (workspacePath && !hasFilter) return matchesWorkspacePath;
        return matchesWorkspacePath || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<T.AgentHealthState, number> = { risky: 0, active: 1, idle: 2, stale: 3 };
        return Number(Boolean(workspacePath) && b.workspacePath === workspacePath) -
          Number(Boolean(workspacePath) && a.workspacePath === workspacePath) ||
          Number(b.maintenanceActive) - Number(a.maintenanceActive) ||
          rank[a.healthState] - rank[b.healthState] ||
          b.openIncidentCount - a.openIncidentCount ||
          b.riskyEventCount - a.riskyEventCount ||
          Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
      });
    const summary: T.WorkspaceInventorySummary = {
      totalWorkspaces: filtered.length,
      managedWorkspaces: filtered.filter((item) => item.managedAgentCount > 0).length,
      productionWorkspaces: filtered.filter((item) => ['prod', 'production'].includes(item.environment?.toLowerCase() ?? '')).length,
      highCriticalityWorkspaces: filtered.filter((item) => item.criticality === 'high' || item.criticality === 'critical').length,
      activeWorkspaces: filtered.filter((item) => item.healthState === 'active').length,
      staleWorkspaces: filtered.filter((item) => item.healthState === 'stale').length,
      riskyWorkspaces: filtered.filter((item) => item.healthState === 'risky').length,
      maintainedWorkspaces: filtered.filter((item) => item.maintenanceActive).length,
      totalAgents: filtered.reduce((sum, item) => sum + item.agentCount, 0),
      openIncidentCount: filtered.reduce((sum, item) => sum + item.openIncidentCount, 0),
      observedEventCount: filtered.reduce((sum, item) => sum + item.eventCount, 0),
      riskyEventCount: filtered.reduce((sum, item) => sum + item.riskyEventCount, 0),
    };
    const allFacts = [...factsByWorkspace.values()];
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
      summary,
      coverage: this.queryCoverage(filter, allFacts.map((fact) => fact.representativeEvent), {
        source: hotEvents.length ? 'clickhouse+hot_delta' : 'clickhouse',
        totalMode: 'exact',
        partial: false,
        committedCutoffMs,
        dataFromMs: allFacts.length ? Math.min(...allFacts.map((fact) => fact.firstSeenAt)) : undefined,
        dataToMs: allFacts.length ? Math.max(...allFacts.map((fact) => fact.lastSeenAt)) : undefined,
      }),
      updateTime: iso(window.endMs),
    };
  }

  workspaceInventory(filter: T.WorkspaceInventoryQuery): T.WorkspaceInventory {
    const window = this.win(filter);
    const events = filter.scope === 'agent'
      ? window.events.filter((event) => event.attribution?.monitored === true)
      : window.events;
    const q = filter.q?.trim().toLowerCase();
    const owner = filter.owner?.trim().toLowerCase();
    const environment = filter.environment?.trim().toLowerCase();
    const workspacePath = filter.workspacePath?.trim();
    const hasFilter = Boolean((filter.healthState && filter.healthState !== 'all') || (filter.criticality && filter.criticality !== 'all') || owner || environment || q);
    const shouldScopeExactWorkspace = Boolean(workspacePath && !hasFilter);
    const agents = this.agentInventory({
      timeType: filter.timeType,
      startTime: filter.startTime,
      endTime: filter.endTime,
      scope: filter.scope,
      workspacePath: shouldScopeExactWorkspace ? workspacePath : undefined,
      limit: 500,
    });
    const byWorkspaceEvents = new Map<string, T.JudgedEvent[]>();
    for (const e of events) {
      if (shouldScopeExactWorkspace && e.workspacePath !== workspacePath) continue;
      (byWorkspaceEvents.get(e.workspacePath) ?? byWorkspaceEvents.set(e.workspacePath, []).get(e.workspacePath)!).push(e);
    }
    const byWorkspaceAgents = new Map<string, T.AgentInventoryItem[]>();
    for (const agent of agents.items) {
      if (shouldScopeExactWorkspace && agent.workspacePath !== workspacePath) continue;
      (byWorkspaceAgents.get(agent.workspacePath) ?? byWorkspaceAgents.set(agent.workspacePath, []).get(agent.workspacePath)!).push(agent);
    }

    const workspaceKeys = new Set([...byWorkspaceEvents.keys(), ...byWorkspaceAgents.keys()]);
    const items = [...workspaceKeys].map((workspacePath): T.WorkspaceInventoryItem | null => {
      const evs = [...(byWorkspaceEvents.get(workspacePath) ?? [])].sort((a, b) => a.at - b.at);
      const wsAgents = byWorkspaceAgents.get(workspacePath) ?? [];
      if (!evs.length && !wsAgents.length) return null;
      const firstMs = evs[0]?.at ?? Math.min(...wsAgents.map((agent) => Date.parse(agent.firstSeen)).filter(Number.isFinite));
      const lastMs = evs.at(-1)?.at ?? Math.max(...wsAgents.map((agent) => Date.parse(agent.lastSeen)).filter(Number.isFinite));
      const risky = evs.filter((event) => event.verdict !== 'allow');
      const topRisk = new Map<string, { count: number; name: string }>();
      for (const e of risky) {
        const cur = topRisk.get(e.riskCategory);
        topRisk.set(e.riskCategory, { count: (cur?.count ?? 0) + 1, name: e.riskName });
      }
      const top = [...topRisk.entries()].sort((a, b) => b[1].count - a[1].count)[0];
      const lvl = evs.length ? worstLevel(evs) : { level: 'safe', text: LEVEL_TEXT.safe };
      const collectorIds = new Set(evs.map(eventCollectorId).filter(Boolean));
      const maintenance = this.maintenance.activeFor({ workspacePath });
      const tags = [...new Set(wsAgents.flatMap((agent) => agent.tags ?? []))].slice(0, 24);
      const healthState: T.AgentHealthState = wsAgents.some((agent) => agent.healthState === 'risky')
        ? 'risky'
        : wsAgents.some((agent) => agent.healthState === 'active')
          ? 'active'
          : wsAgents.some((agent) => agent.healthState === 'idle')
            ? 'idle'
            : 'stale';
      const byLastSeen = [...wsAgents].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      return {
        workspaceId: this.workspaceDirectory.resolveWorkspaceId(workspacePath),
        workspacePath,
        owner: mode(wsAgents.map((agent) => agent.owner)),
        team: mode(wsAgents.map((agent) => agent.team)),
        environment: mode(wsAgents.map((agent) => agent.environment)),
        criticality: worstCriticality(wsAgents.map((agent) => agent.criticality)),
        tags,
        healthState,
        riskLevel: lvl.level,
        riskLevelText: lvl.text,
        agentCount: wsAgents.length,
        managedAgentCount: wsAgents.filter((agent) => agent.metadataUpdatedAt).length,
        activeAgentCount: wsAgents.filter((agent) => agent.healthState === 'active').length,
        idleAgentCount: wsAgents.filter((agent) => agent.healthState === 'idle').length,
        staleAgentCount: wsAgents.filter((agent) => agent.healthState === 'stale').length,
        riskyAgentCount: wsAgents.filter((agent) => agent.healthState === 'risky').length,
        openIncidentCount: wsAgents.reduce((a, agent) => a + agent.openIncidentCount, 0),
        collectorCount: collectorIds.size,
        eventCount: evs.length || wsAgents.reduce((a, agent) => a + agent.eventCount, 0),
        riskyEventCount: risky.length || wsAgents.reduce((a, agent) => a + agent.riskyEventCount, 0),
        sessionCount: evs.length ? distinct(evs.map((event) => event.sessionId)) : wsAgents.reduce((a, agent) => a + agent.sessionCount, 0),
        runCount: evs.length ? distinct(evs.map((event) => event.runId)) : wsAgents.reduce((a, agent) => a + agent.runCount, 0),
        traceCount: evs.length ? distinct(evs.map((event) => event.traceId)) : wsAgents.reduce((a, agent) => a + agent.traceCount, 0),
        tokenCount: evs.reduce((a, event) => a + event.tokenCount, 0) || wsAgents.reduce((a, agent) => a + agent.tokenCount, 0),
        avgLatencyMs: Math.round(mean(evs.length ? evs.map((event) => event.latencyMs) : wsAgents.map((agent) => agent.avgLatencyMs))),
        topRiskCategory: top?.[0] ?? mode(wsAgents.map((agent) => agent.topRiskCategory)),
        topRiskName: top?.[1].name ?? mode(wsAgents.map((agent) => agent.topRiskName)),
        firstSeen: iso(Number.isFinite(firstMs) ? firstMs : now()),
        lastSeen: iso(Number.isFinite(lastMs) ? lastMs : now()),
        lastEventSubject: evs.at(-1)?.subject ?? byLastSeen[0]?.lastEventSubject ?? '',
        maintenanceActive: Boolean(maintenance),
        maintenanceWindowId: maintenance?.windowId,
        maintenanceTitle: maintenance?.title,
      };
    }).filter((item): item is T.WorkspaceInventoryItem => Boolean(item));

    const filtered = items
      .filter((item) => {
        const matchesWorkspacePath = Boolean(workspacePath && item.workspacePath === workspacePath);
        const matchesFilter =
          (!filter.healthState || filter.healthState === 'all' || item.healthState === filter.healthState) &&
          (!filter.criticality || filter.criticality === 'all' || item.criticality === filter.criticality) &&
          (!owner || (item.owner ?? '').toLowerCase().includes(owner)) &&
          (!environment || (item.environment ?? '').toLowerCase().includes(environment)) &&
          (!q || [
            item.workspacePath,
            item.owner,
            item.team,
            item.environment,
            item.criticality,
            item.topRiskName,
            item.topRiskCategory,
            item.lastEventSubject,
            item.maintenanceTitle,
            ...item.tags,
          ].some((value) => (value ?? '').toLowerCase().includes(q)));
        if (workspacePath && !hasFilter) return matchesWorkspacePath;
        return matchesWorkspacePath || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<T.AgentHealthState, number> = { risky: 0, active: 1, idle: 2, stale: 3 };
        return Number(Boolean(workspacePath) && b.workspacePath === workspacePath) - Number(Boolean(workspacePath) && a.workspacePath === workspacePath)
          || Number(b.maintenanceActive) - Number(a.maintenanceActive)
          || rank[a.healthState] - rank[b.healthState]
          || b.openIncidentCount - a.openIncidentCount
          || b.riskyEventCount - a.riskyEventCount
          || Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
      });

    const summary: T.WorkspaceInventorySummary = {
      totalWorkspaces: filtered.length,
      managedWorkspaces: filtered.filter((item) => item.managedAgentCount > 0).length,
      productionWorkspaces: filtered.filter((item) => item.environment?.toLowerCase() === 'prod' || item.environment?.toLowerCase() === 'production').length,
      highCriticalityWorkspaces: filtered.filter((item) => item.criticality === 'high' || item.criticality === 'critical').length,
      activeWorkspaces: filtered.filter((item) => item.healthState === 'active').length,
      staleWorkspaces: filtered.filter((item) => item.healthState === 'stale').length,
      riskyWorkspaces: filtered.filter((item) => item.healthState === 'risky').length,
      maintainedWorkspaces: filtered.filter((item) => item.maintenanceActive).length,
      totalAgents: filtered.reduce((a, item) => a + item.agentCount, 0),
      openIncidentCount: filtered.reduce((a, item) => a + item.openIncidentCount, 0),
      observedEventCount: filtered.reduce((a, item) => a + item.eventCount, 0),
      riskyEventCount: filtered.reduce((a, item) => a + item.riskyEventCount, 0),
    };
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return { items: filtered.slice(0, limit), total: filtered.length, summary, updateTime: iso() };
  }

  async storedAgentTopology(filter: T.AgentTopologyQuery): Promise<T.AgentTopology> {
    const window = resolveTimeWindow(filter);
    const committed = this.judge.committedEventCutoffMs();
    if (committed === undefined) return this.agentTopology(filter);
    const plan = planDashboardRead(window.startMs, window.endMs, committed);
    // Topology uses the same single-owner overlap rule as Agent inventory. It avoids oversized
    // NOT IN parameters when Observer emits thousands of events during one refresh interval.
    const persistedUntilMs = Math.min(
      plan.persistedUntilMs ?? window.endMs,
      Math.max(window.startMs - 1, plan.hotFromMs - 1),
    );
    const hotEvents = foldLatestEventRevisions(
      this.judge.queryRange(plan.hotFromMs, window.endMs),
    );
    const monitoredOnly = filter.scope === 'agent';
    const overlapEventIds: string[] = [];
    const slices = reusableFactSlices(window.startMs, persistedUntilMs, plan.hotFromMs);
    let persisted: StoredTopologyWindowFact[] | null;
    if (
      !window.custom &&
      window.spanMs <= 24 * HOUR &&
      slices.fullEndExclusiveMs > slices.fullStartMs
    ) {
      const topologyScope = monitoredOnly ? 'agent' : 'all';
      let topologyCache = this.topologyHistoryBuckets.get(topologyScope);
      if (!topologyCache) {
        topologyCache = new CommitAwareFactBucketCache<StoredTopologyBucketFact>({
          latestCursor: () => this.judge.latestEventCommitCursor(),
          earliestCursor: () => this.judge.earliestEventCommitCursor(),
          changes: (after) => this.judge.eventCommitChanges(after),
          facts: (startMs, endExclusiveMs, bucketMs) =>
            this.historyQueryGate.run(() =>
            this.judge.topologyWindowBucketFacts(
              startMs,
              endExclusiveMs,
              bucketMs,
              monitoredOnly,
            ),
            ),
        });
        this.topologyHistoryBuckets.set(topologyScope, topologyCache);
      }
      const [stableFacts, headFacts, tailFacts] = await Promise.all([
        topologyCache.read(
          slices.fullStartMs,
          slices.fullEndExclusiveMs,
        ).catch((error) => {
          console.warn(
            `[topology] reusable history unavailable; using bounded hot fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }),
        slices.head
          ? this.historyQueryGate.run(() =>
              this.judge.topologyWindowFacts(
                slices.head!.startMs,
                slices.head!.endMs,
                monitoredOnly,
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
        slices.tail
          ? this.historyQueryGate.run(() =>
              this.judge.topologyWindowFacts(
                slices.tail!.startMs,
                slices.tail!.endMs,
                monitoredOnly,
                overlapEventIds,
              ),
            )
          : Promise.resolve([]),
      ]);
      persisted = stableFacts && headFacts && tailFacts
        ? [...headFacts, ...stableFacts, ...tailFacts]
        : null;
    } else {
      persisted = await this.historyQueryGate.run(() =>
        this.judge.topologyWindowFacts(
          window.startMs,
          persistedUntilMs,
          monitoredOnly,
          overlapEventIds,
        ),
      );
    }
    if (persisted === null) return this.agentTopology(filter);
    const pinnedEventId = filter.eventId?.trim();
    const pinnedPage = pinnedEventId
      ? await this.judge.searchStoredEventsPage({
          sinceMs: 0,
          untilMs: window.endMs,
          eventId: pinnedEventId,
          limit: 1,
        })
      : undefined;
    const pinnedEvent = pinnedPage?.events[0] ?? (pinnedEventId ? this.judge.findEvent(pinnedEventId) : undefined);
    const hotFacts: StoredTopologyWindowFact[] = hotEvents.map((event) => ({
      identityKey: event.eventId,
      instanceKey: agentRuntimeInstanceIdForEvent(event),
      representativeEvent: event,
      hasPhysicalIdentity: Boolean(
        event.attribution?.physicalWorkloadId ||
        event.attribution?.agentInstanceId ||
        event.attribution?.workloadRef?.podUid,
      ),
      hasRootIdentity:
        Boolean(event.attribution?.rootStartTime) &&
        hasDirectAgentRootEvidence(event),
      hasInternalHelperRoot: isInternalAgentHelperRootEvent(event),
      firstSeenAt: event.at,
      lastSeenAt: event.at,
      eventCount: 1,
      riskyEventCount: event.verdict === 'allow' ? 0 : 1,
      worstSeverityRank: event.verdict === 'allow' ? 0 : SEV_RANK[event.severity],
      riskCategory: event.riskCategory,
      riskName: event.riskName,
    }));
    const facts = [...persisted, ...hotFacts];
    if (pinnedEvent && !facts.some((fact) => fact.representativeEvent.eventId === pinnedEvent.eventId)) {
      facts.push({
        identityKey: pinnedEvent.eventId,
        instanceKey: agentRuntimeInstanceIdForEvent(pinnedEvent),
        representativeEvent: pinnedEvent,
        hasPhysicalIdentity: Boolean(
          pinnedEvent.attribution?.physicalWorkloadId ||
          pinnedEvent.attribution?.agentInstanceId ||
          pinnedEvent.attribution?.workloadRef?.podUid,
        ),
        hasRootIdentity:
          Boolean(pinnedEvent.attribution?.rootStartTime) &&
          hasDirectAgentRootEvidence(pinnedEvent),
        hasInternalHelperRoot: isInternalAgentHelperRootEvent(pinnedEvent),
        firstSeenAt: pinnedEvent.at,
        lastSeenAt: pinnedEvent.at,
        eventCount: 1,
        riskyEventCount: pinnedEvent.verdict === 'allow' ? 0 : 1,
        worstSeverityRank: pinnedEvent.verdict === 'allow' ? 0 : SEV_RANK[pinnedEvent.severity],
        riskCategory: pinnedEvent.riskCategory,
        riskName: pinnedEvent.riskName,
      });
    }
    return this.agentTopology(filter, {
      facts,
      committedCutoffMs: Math.min(committed, window.endMs),
      source: hotFacts.length ? 'clickhouse+hot_delta' : 'clickhouse',
    });
  }

  agentTopology(
    filter: T.AgentTopologyQuery,
    durable?: {
      facts: StoredTopologyWindowFact[];
      committedCutoffMs: number;
      source: 'clickhouse' | 'clickhouse+hot_delta';
    },
  ): T.AgentTopology {
    const pinnedEdgeId = filter.edgeId?.trim();
    const pinnedEventId = filter.eventId?.trim();
    const agentScoped = filter.scope === 'agent';
    const resolvedEvents = new Map<string, ReturnType<AgentMetadataService['resolveEvent']>>();
    const resolveAgent = (event: T.JudgedEvent) => {
      const cached = resolvedEvents.get(event.eventId);
      if (cached) return cached;
      const resolved = this.agentMetadata.resolveEvent(event);
      resolvedEvents.set(event.eventId, resolved);
      return resolved;
    };
    const topologyFacts = durable?.facts;
    const factByEventId = new Map((topologyFacts ?? []).map((fact) => [fact.representativeEvent.eventId, fact]));
    const invalidHelperInstances = new Set(
      (topologyFacts ?? [])
        .filter((fact) => fact.hasInternalHelperRoot)
        .map((fact) => fact.instanceKey),
    );
    const isAgentRelatedEvent = (event: T.JudgedEvent) => {
      if (!isAgentAssetClassification(resolveAgent(event).effectiveClassification)) return false;
      const fact = factByEventId.get(event.eventId);
      const instanceKey = fact?.instanceKey ?? agentRuntimeInstanceIdForEvent(event);
      if (
        invalidHelperInstances.has(instanceKey) ||
        fact?.hasInternalHelperRoot ||
        isInternalAgentHelperRootEvent(event)
      ) return false;
      if (fact) {
        return fact.hasPhysicalIdentity || fact.hasRootIdentity;
      }
      return Boolean(
        event.attribution?.physicalWorkloadId ||
        event.attribution?.agentInstanceId ||
        event.attribution?.workloadRef?.podUid ||
        hasAgentRuntimeLineageEvidence(event)
      );
    };
    const rawWindowedEvents = topologyFacts
      ? topologyFacts.map((fact) => fact.representativeEvent)
      : this.win(filter).events;
    const windowedEvents = agentScoped
      ? rawWindowedEvents.filter(isAgentRelatedEvent)
      : rawWindowedEvents;
    const windowedEventIds = new Set(windowedEvents.map((event) => event.eventId));
    const rawPinnedEvent = pinnedEventId
      ? topologyFacts?.find((fact) => fact.representativeEvent.eventId === pinnedEventId)?.representativeEvent
        ?? this.judge.findEvent(pinnedEventId)
      : undefined;
    const pinnedEvent = rawPinnedEvent && (!agentScoped || isAgentRelatedEvent(rawPinnedEvent))
      ? rawPinnedEvent
      : undefined;
    const rawEvents = pinnedEdgeId && !topologyFacts
      ? this.judge.query(0)
      : pinnedEvent && !windowedEventIds.has(pinnedEvent.eventId)
        ? [...windowedEvents, pinnedEvent]
        : windowedEvents;
    const events = agentScoped ? rawEvents.filter(isAgentRelatedEvent) : rawEvents;
    const includeBenign = filter.includeBenign !== false;
    const q = filter.q?.trim().toLowerCase();
    const requestedAgentAssetId = filter.agentAssetId?.trim();
    const agentAssetId = requestedAgentAssetId
      ? this.agentMetadata.canonicalAgentAssetId(requestedAgentAssetId)
      : undefined;
    const agentInstanceId = filter.agentInstanceId?.trim();
    const agentId = filter.agentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const collectorId = filter.collectorId?.trim();
    const sourceId = filter.sourceId?.trim();
    const hasFilter = Boolean(agentAssetId || agentInstanceId || agentId || workspacePath || collectorId || sourceId || q || !includeBenign);
    const exactPinnedMode = Boolean((pinnedEdgeId || pinnedEventId) && !hasFilter);
    const limit = Math.max(20, Math.min(1000, filter.limit ?? 300));
    const pinnedEdgeIds = new Set<string>(pinnedEdgeId ? [pinnedEdgeId] : []);

    type NodeSpec = {
      id: string;
      type: T.TopologyNodeType;
      label: string;
      subtitle?: string;
      extra?: Partial<Pick<T.AgentTopologyNode, 'agentAssetId' | 'agentInstanceId' | 'agentId' | 'classification' | 'workspacePath' | 'collectorId'>>;
    };
    type EdgeSpec = {
      id: string;
      source: NodeSpec;
      target: NodeSpec;
      type: T.TopologyEdgeType;
      label: string;
    };
    type NodeAgg = Omit<T.AgentTopologyNode, 'lastSeen' | 'riskLevel' | 'riskLevelText'> & { lastSeenMs: number; severityRank: number };
    type EdgeAgg = Omit<T.AgentTopologyEdge, 'lastSeen' | 'riskCategories'> & {
      lastSeenMs: number;
      severityRank: number;
      risks: Map<string, { riskName: string; eventCount: number }>;
    };

    const nodes = new Map<string, NodeAgg>();
    const edges = new Map<string, EdgeAgg>();
    const rosterAgentNodeIds = new Set<string>();
    const bumpNode = (
      id: string,
      type: T.TopologyNodeType,
      label: string,
      subtitle: string | undefined,
      event: T.JudgedEvent,
      extra: Partial<Pick<T.AgentTopologyNode, 'agentAssetId' | 'agentInstanceId' | 'agentId' | 'classification' | 'workspacePath' | 'collectorId'>> = {},
    ) => {
      const fact = factByEventId.get(event.eventId);
      const eventCount = fact?.eventCount ?? 1;
      const riskyEventCount = fact?.riskyEventCount ?? (event.verdict !== 'allow' ? 1 : 0);
      const cur = nodes.get(id);
      const base = cur ?? {
        nodeId: id,
        type,
        label,
        subtitle,
        eventCount: 0,
        riskyEventCount: 0,
        lastSeenMs: 0,
        severityRank: 0,
        ...extra,
      };
      base.eventCount += eventCount;
      if (riskyEventCount > 0) {
        base.riskyEventCount += riskyEventCount;
        base.severityRank = Math.max(base.severityRank, fact?.worstSeverityRank ?? SEV_RANK[event.severity]);
      }
      base.lastSeenMs = Math.max(base.lastSeenMs, fact?.lastSeenAt ?? event.at);
      nodes.set(id, base);
    };
    const bumpEdge = (
      sourceNodeId: string,
      targetNodeId: string,
      type: T.TopologyEdgeType,
      label: string,
      event: T.JudgedEvent,
    ) => {
      const id = edgeId(sourceNodeId, targetNodeId, type);
      const cur = edges.get(id);
      const fact = factByEventId.get(event.eventId);
      const eventCount = fact?.eventCount ?? 1;
      const riskyEventCount = fact?.riskyEventCount ?? (event.verdict !== 'allow' ? 1 : 0);
      const rank = riskyEventCount > 0 ? (fact?.worstSeverityRank ?? SEV_RANK[event.severity]) : 0;
      const lastSeenAt = fact?.lastSeenAt ?? event.at;
      const base: EdgeAgg = cur ?? {
        edgeId: id,
        sourceNodeId,
        targetNodeId,
        type,
        label,
        eventCount: 0,
        riskyEventCount: 0,
        maxSeverity: 'info',
        lastSeenMs: 0,
        severityRank: 0,
        sampleEventId: event.eventId,
        sampleSubject: event.subject,
        risks: new Map(),
      };
      base.eventCount += eventCount;
      if (riskyEventCount > 0) {
        base.riskyEventCount += riskyEventCount;
        if (rank >= base.severityRank) {
          base.severityRank = rank;
          base.maxSeverity = LEVEL_BY_RANK[Math.max(0, Math.min(4, rank))] as T.Severity;
        }
        const category = fact?.riskCategory ?? event.riskCategory;
        const risk = base.risks.get(category);
        base.risks.set(category, {
          riskName: fact?.riskName ?? event.riskName,
          eventCount: (risk?.eventCount ?? 0) + riskyEventCount,
        });
      }
      if (lastSeenAt >= base.lastSeenMs) {
        base.lastSeenMs = lastSeenAt;
        base.sampleEventId = event.eventId;
        base.sampleSubject = event.subject;
      }
      edges.set(id, base);
    };

    for (const e of events) {
      const resolved = resolveAgent(e);
      const collectorRef = eventCollectorId(e);
      const sourceRef = eventSourceId(e);
      const canonicalWorkspacePath = resolved.metadata?.workspacePath ?? e.workspacePath;
      const canonicalAgentId =
        canonicalAgentName(e.attribution?.agentScopeId) ??
        canonicalAgentName(e.attribution?.agentDisplayName) ??
        resolved.detectedName ??
        e.agentId;
      const canonicalAgentLabel =
        resolved.displayName ??
        canonicalAgentName(e.attribution?.agentDisplayName) ??
        canonicalAgentName(e.attribution?.agentScopeId) ??
        resolved.detectedName ??
        e.agentId;
      const runtimeInstanceId = agentRuntimeInstanceIdForEvent(e);
      const runtimeLocation = detectedAgentIdentity(e).locationLabel ?? canonicalWorkspacePath;
      const isPinnedEvent = Boolean(pinnedEventId && e.eventId === pinnedEventId);
      const matchesDirectScope =
        (!agentAssetId || resolved.agentAssetId === agentAssetId) &&
        matchesAgentRuntimeInstance(e, agentInstanceId) &&
        (!agentId || [e.agentId, canonicalAgentId, canonicalAgentLabel].includes(agentId)) &&
        (!workspacePath || canonicalWorkspacePath === workspacePath || e.workspacePath === workspacePath) &&
        (!collectorId || collectorRef === collectorId) &&
        (!sourceId || sourceRef === sourceId);
      const matchesRelationshipScope =
        matchesDirectScope &&
        (includeBenign || e.verdict !== 'allow');
      if (!pinnedEdgeId && !isPinnedEvent && !matchesDirectScope) continue;

      const target = topologyTarget(e);
      const agentNodeId = nodeId(
        'agent',
        agentInventoryGroupKey(resolved.agentAssetId, runtimeInstanceId),
      );
      const workspaceNodeId = nodeId('workspace', canonicalWorkspacePath);
      const collectorNodeId = collectorRef ? nodeId('collector', collectorRef) : '';
      const targetNodeId = target ? nodeId(target.type, target.key) : '';
      const workspaceNode: NodeSpec = {
        id: workspaceNodeId,
        type: 'workspace',
        label: canonicalWorkspacePath,
        extra: { workspacePath: canonicalWorkspacePath },
      };
      const agentNode: NodeSpec = {
        id: agentNodeId,
        type: 'agent',
        label: canonicalAgentLabel,
        subtitle: runtimeLocation,
        extra: {
          agentAssetId: resolved.agentAssetId,
          agentInstanceId: runtimeInstanceId,
          agentId: canonicalAgentId,
          classification: resolved.effectiveClassification,
          workspacePath: canonicalWorkspacePath,
        },
      };
      const collectorNode: NodeSpec | undefined = collectorRef
        ? { id: collectorNodeId, type: 'collector', label: collectorRef, subtitle: attrString(e, 'collectorNode') || undefined, extra: { collectorId: collectorRef } }
        : undefined;
      const targetNode: NodeSpec | undefined = target && targetNodeId
        ? { id: targetNodeId, type: target.type, label: target.label, subtitle: target.subtitle }
        : undefined;
      const eventEdges: EdgeSpec[] = [
        { id: edgeId(workspaceNodeId, agentNodeId, 'runs_in'), source: workspaceNode, target: agentNode, type: 'runs_in', label: '运行' },
      ];
      if (collectorNode) eventEdges.push({ id: edgeId(collectorNodeId, agentNodeId, 'observed_by'), source: collectorNode, target: agentNode, type: 'observed_by', label: '观测' });
      if (target && targetNode) eventEdges.push({ id: edgeId(agentNodeId, targetNodeId, target.edgeType), source: agentNode, target: targetNode, type: target.edgeType, label: target.edgeLabel });
      const eventEdgeIds = eventEdges.map((edge) => edge.id);
      const isPinnedEdge = Boolean(pinnedEdgeId && eventEdgeIds.includes(pinnedEdgeId));
      const matchesText =
        !q || [
          e.agentId,
          resolved.agentAssetId,
          runtimeInstanceId,
          canonicalAgentId,
          canonicalAgentLabel,
          canonicalWorkspacePath,
          e.subject,
          e.riskCategory,
          e.riskName,
          collectorRef,
          sourceRef,
          target?.label,
          target?.subtitle,
        ].some((v) => (v ?? '').toLowerCase().includes(q));
      const rosterMatch =
        windowedEventIds.has(e.eventId) &&
        matchesDirectScope &&
        matchesText;
      const normalMatch =
        rosterMatch &&
        matchesRelationshipScope;
      const includeAllEventEdges = exactPinnedMode ? isPinnedEvent : normalMatch || isPinnedEvent;
      const includedEdges = includeAllEventEdges ? eventEdges : eventEdges.filter((edge) => pinnedEdgeId && edge.id === pinnedEdgeId);
      if (isPinnedEvent) for (const id of eventEdgeIds) pinnedEdgeIds.add(id);

      const bumpedNodeIds = new Set<string>();
      const bumpNodeOnce = (node: NodeSpec) => {
        if (bumpedNodeIds.has(node.id)) return;
        bumpedNodeIds.add(node.id);
        bumpNode(node.id, node.type, node.label, node.subtitle, e, node.extra);
      };
      // The relationship dropdown filters edges, not the Agent roster. Otherwise a healthy
      // runtime disappears from topology and looks like an attribution/data-loss bug.
      if (rosterMatch) {
        rosterAgentNodeIds.add(agentNode.id);
        bumpNodeOnce(agentNode);
      }
      if (!includedEdges.length && !isPinnedEdge) continue;
      for (const edge of includedEdges) {
        bumpNodeOnce(edge.source);
        bumpNodeOnce(edge.target);
        bumpEdge(edge.source.id, edge.target.id, edge.type, edge.label, e);
      }
    }

    const selectedEdges = [...edges.values()]
      .sort((a, b) =>
        Number(pinnedEdgeIds.has(b.edgeId)) - Number(pinnedEdgeIds.has(a.edgeId)) ||
        b.riskyEventCount - a.riskyEventCount ||
        b.severityRank - a.severityRank ||
        b.eventCount - a.eventCount ||
        b.lastSeenMs - a.lastSeenMs,
      )
      .slice(0, limit);
    const selectedNodeIds = new Set([
      ...selectedEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]),
      ...rosterAgentNodeIds,
    ]);
    const selectedNodes = [...nodes.values()].filter((node) => selectedNodeIds.has(node.nodeId));
    const nodeItem = (node: NodeAgg): T.AgentTopologyNode => {
      const level = node.riskyEventCount ? levelByRank(node.severityRank) : { level: 'safe', text: LEVEL_TEXT.safe };
      return {
        nodeId: node.nodeId,
        type: node.type,
        label: node.label,
        subtitle: node.subtitle,
        agentAssetId: node.agentAssetId,
        agentInstanceId: node.agentInstanceId,
        agentId: node.agentId,
        classification: node.classification,
        workspacePath: node.workspacePath,
        collectorId: node.collectorId,
        riskLevel: level.level,
        riskLevelText: level.text,
        eventCount: node.eventCount,
        riskyEventCount: node.riskyEventCount,
        lastSeen: iso(node.lastSeenMs),
      };
    };
    const edgeItem = (edge: EdgeAgg): T.AgentTopologyEdge => ({
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      type: edge.type,
      label: edge.label,
      eventCount: edge.eventCount,
      riskyEventCount: edge.riskyEventCount,
      maxSeverity: edge.maxSeverity,
      lastSeen: iso(edge.lastSeenMs),
      sampleEventId: edge.sampleEventId,
      sampleSubject: edge.sampleSubject,
      riskCategories: [...edge.risks.entries()]
        .map(([riskCategory, value]) => ({ riskCategory, riskName: value.riskName, eventCount: value.eventCount }))
        .sort((a, b) => b.eventCount - a.eventCount),
    });
    const items = selectedNodes.map(nodeItem).sort((a, b) => b.riskyEventCount - a.riskyEventCount || b.eventCount - a.eventCount || Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    const edgeItems = selectedEdges.map(edgeItem);
    const countNodes = (type: T.TopologyNodeType) => items.filter((node) => node.type === type).length;
    return {
      nodes: items,
      edges: edgeItems,
      summary: {
        agentCount: countNodes('agent'),
        workspaceCount: countNodes('workspace'),
        collectorCount: countNodes('collector'),
        toolTargetCount: countNodes('tool'),
        externalEndpointCount: countNodes('network'),
        fileTargetCount: countNodes('file'),
        llmEndpointCount: countNodes('llm'),
        securityTargetCount: countNodes('security'),
        nodeCount: items.length,
        edgeCount: edgeItems.length,
        riskyEdgeCount: edgeItems.filter((edge) => edge.riskyEventCount > 0).length,
      },
      coverage: this.queryCoverage(filter, events, {
        source: durable?.source ?? 'memory_hot_ring',
        totalMode: 'exact',
        partial: !durable,
        partialReason: durable ? undefined : 'hot_ring_only',
        committedCutoffMs: durable?.committedCutoffMs,
        dataFromMs: topologyFacts?.length
          ? Math.min(...topologyFacts.map((fact) => fact.firstSeenAt))
          : undefined,
        dataToMs: topologyFacts?.length
          ? Math.max(...topologyFacts.map((fact) => fact.lastSeenAt))
          : undefined,
      }),
      updateTime: iso(resolveTimeWindow(filter).endMs),
    };
  }

  async storedCollectorHealth(filter: T.CollectorHealthQuery): Promise<T.CollectorHealth> {
    const window = resolveTimeWindow(filter);
    const [persistedHeartbeats, persistedLatest, distributedLatest] = await Promise.all([
      this.judge.storedCollectorHeartbeats(window.startMs, window.endMs),
      this.judge.storedLatestCollectorHeartbeats(window.endMs),
      this.judge.distributedLatestCollectorHeartbeats(window.endMs),
    ]);
    if (persistedHeartbeats === null || persistedLatest === null) return this.collectorHealth(filter);
    const hotHeartbeats = this.judge.queryCollectorHeartbeats(window.startMs, window.endMs);
    const hotLatest = this.judge.latestCollectorHeartbeats(window.endMs);
    const merge = (items: T.CollectorHeartbeatRecord[]) => {
      const unique = new Map<string, T.CollectorHeartbeatRecord>();
      for (const item of items) unique.set(`${item.collectorId}\0${item.at}`, item);
      return [...unique.values()];
    };
    const heartbeats = merge([...persistedHeartbeats, ...hotHeartbeats]);
    const latest = merge([...persistedLatest, ...distributedLatest, ...hotLatest])
      .sort((a, b) => a.at - b.at)
      .reduce((map, item) => map.set(item.collectorId, item), new Map<string, T.CollectorHeartbeatRecord>());
    const hasRedisCurrent = distributedLatest.some((current) =>
      !persistedLatest.some((saved) => saved.collectorId === current.collectorId && saved.at >= current.at),
    );
    return this.collectorHealth(filter, {
      heartbeats,
      latest: [...latest.values()],
      source: hasRedisCurrent
        ? 'clickhouse+redis_current'
        : hotHeartbeats.some((hot) => !persistedHeartbeats.some((saved) => saved.collectorId === hot.collectorId && saved.at === hot.at))
          ? 'clickhouse+hot_delta'
          : 'clickhouse',
    });
  }

  collectorHealth(
    filter: T.CollectorHealthQuery,
    durable?: {
      heartbeats: T.CollectorHeartbeatRecord[];
      latest: T.CollectorHeartbeatRecord[];
      source: 'clickhouse' | 'clickhouse+hot_delta' | 'clickhouse+redis_current';
    },
  ): T.CollectorHealth {
    const window = resolveTimeWindow(filter);
    const sinceMs = window.startMs;
    const spanMs = window.spanMs;
    // Some legacy/minimal judge implementations accept only `sinceMs`; enforce the closed custom
    // end boundary here as well so a newer live heartbeat cannot leak into an historical snapshot.
    const windowHeartbeats = (durable?.heartbeats
      ?? this.judge.queryCollectorHeartbeats(window.startMs, window.endMs))
      .filter((heartbeat) => heartbeat.at >= window.startMs && heartbeat.at <= window.endMs);
    const rawHeartbeatHeads = durable
      ? (() => {
          // `storedLatestCollectorHeartbeats` intentionally returns one latest row per collector.
          // Raw Collector and Forwarder heartbeats are independent telemetry channels, so deriving
          // both heads from that single row loses the older channel whenever the other reports a
          // few milliseconds later. Rebuild per-origin heads from the durable window plus the
          // current-state head instead.
          const candidates = [...durable.heartbeats, ...durable.latest];
          const latestMatching = (
            predicate: (heartbeat: T.CollectorHeartbeatRecord) => boolean,
            timestamp: (heartbeat: T.CollectorHeartbeatRecord) => number = (heartbeat) => heartbeat.at,
          ): T.CollectorHeartbeatRecord[] => {
            const heads = new Map<string, T.CollectorHeartbeatRecord>();
            for (const heartbeat of candidates) {
              if (!predicate(heartbeat)) continue;
              const current = heads.get(heartbeat.collectorId);
              if (!current || timestamp(heartbeat) >= timestamp(current)) {
                heads.set(heartbeat.collectorId, heartbeat);
              }
            }
            return [...heads.values()];
          };
          return {
            latest: durable.latest,
            latestMetrics: latestMatching(
              (heartbeat) => heartbeat.filterMetricsReportedAt !== undefined,
              (heartbeat) => heartbeat.filterMetricsReportedAt ?? heartbeat.at,
            ),
            latestRaw: latestMatching((heartbeat) => heartbeat.origin === 'raw_collector'),
            latestForwarder: latestMatching((heartbeat) => heartbeat.origin === 'forwarder'),
            latestCaptureProfile: latestMatching(
              (heartbeat) => heartbeat.captureProfileMetricsReportedAt !== undefined,
              (heartbeat) => heartbeat.captureProfileMetricsReportedAt ?? heartbeat.at,
            ),
          };
        })()
      : this.judge.collectorHeartbeatHeads();
    const heartbeatHeads = {
      latest: rawHeartbeatHeads.latest.filter((heartbeat) => heartbeat.at <= window.endMs),
      latestMetrics: rawHeartbeatHeads.latestMetrics.filter((heartbeat) => heartbeat.at <= window.endMs),
      latestRaw: rawHeartbeatHeads.latestRaw.filter((heartbeat) => heartbeat.at <= window.endMs),
      latestForwarder: rawHeartbeatHeads.latestForwarder.filter((heartbeat) => heartbeat.at <= window.endMs),
      latestCaptureProfile: (rawHeartbeatHeads.latestCaptureProfile ?? [])
        .filter((heartbeat) => heartbeat.at <= window.endMs),
    };
    const latestHeartbeatByCollector = new Map(heartbeatHeads.latest.map((heartbeat) => [heartbeat.collectorId, heartbeat]));
    const latestMetricsByCollector = new Map(heartbeatHeads.latestMetrics.map((heartbeat) => [heartbeat.collectorId, heartbeat]));
    const latestRawByCollector = new Map(heartbeatHeads.latestRaw.map((heartbeat) => [heartbeat.collectorId, heartbeat]));
    const latestForwarderByCollector = new Map(
      heartbeatHeads.latestForwarder.map((heartbeat) => [heartbeat.collectorId, heartbeat]),
    );
    const latestCaptureProfileByCollector = new Map(
      heartbeatHeads.latestCaptureProfile.map((heartbeat) => [heartbeat.collectorId, heartbeat]),
    );
    const byCollector = new Map<string, T.CollectorHeartbeatRecord[]>();
    for (const hb of windowHeartbeats) (byCollector.get(hb.collectorId) ?? byCollector.set(hb.collectorId, []).get(hb.collectorId)!).push(hb);
    const requestedCollectorId = filter.collectorId?.trim();
    const collectorArchiveCutoff = window.endMs - COLLECTOR_ARCHIVE_MS;
    for (const hb of heartbeatHeads.latest) {
      // `storedLatestCollectorHeartbeats` deliberately retains the last row for every historical
      // collector. Preserve recently silent Collectors as down beyond the selected chart window,
      // but archive long-dead one-off/E2E heads after the explicit operational TTL. An exact deep
      // link remains queryable at any age.
      if (
        hb.at < window.startMs &&
        (hb.at < collectorArchiveCutoff || legacyEphemeralCollector(hb.collectorId)) &&
        hb.collectorId !== requestedCollectorId
      ) continue;
      if (!byCollector.has(hb.collectorId)) byCollector.set(hb.collectorId, []);
    }

    const t = window.endMs;
    const stateText: Record<T.CollectorHealthState, string> = {
      healthy: '健康',
      quiet: '静默',
      degraded: '降级',
      stale: '陈旧',
      down: '断流',
    };
    const items = [...byCollector.entries()].map(([collectorId, hbs]): T.CollectorHealthItem => {
      const latest = latestHeartbeatByCollector.get(collectorId);
      const latestMetricsHeartbeat = latestMetricsByCollector.get(collectorId);
      const latestRawHeartbeat = latestRawByCollector.get(collectorId);
      const latestForwarderHeartbeat = latestForwarderByCollector.get(collectorId);
      const latestCaptureProfileHeartbeat = latestCaptureProfileByCollector.get(collectorId);
      const freshMetricsHeartbeat = latestMetricsHeartbeat?.filterMetricsReportedAt !== undefined &&
        t - latestMetricsHeartbeat.filterMetricsReportedAt <= COLLECTOR_STALE_MS
        ? latestMetricsHeartbeat
        : undefined;
      // The raw Collector is the sole producer of attached-probe and binary capability metadata.
      // A co-located Forwarder reports more frequently, but its heartbeat intentionally carries
      // only delivery/filter state; letting that newer row win would render a healthy 27-probe
      // Collector as 0/[] every few seconds. Keep the channels independent and use the generic
      // head only when no fresh raw Collector heartbeat exists.
      const freshRawHeartbeat = latestRawHeartbeat !== undefined &&
        t - latestRawHeartbeat.at <= COLLECTOR_STALE_MS
        ? latestRawHeartbeat
        : undefined;
      const freshForwarderHeartbeat = latestForwarderHeartbeat !== undefined &&
        t - latestForwarderHeartbeat.at <= COLLECTOR_STALE_MS
        ? latestForwarderHeartbeat
        : undefined;
      const collectorMetadataHeartbeat = freshRawHeartbeat ?? latest;
      const freshFileFilterHeartbeat = latestRawHeartbeat?.fileFilterMetricsReportedAt !== undefined &&
        t - latestRawHeartbeat.fileFilterMetricsReportedAt <= COLLECTOR_STALE_MS
        ? latestRawHeartbeat
        : undefined;
      const freshCaptureProfileHeartbeat = latestCaptureProfileHeartbeat?.captureProfileMetricsReportedAt !== undefined &&
        t - latestCaptureProfileHeartbeat.captureProfileMetricsReportedAt <= COLLECTOR_STALE_MS
        ? latestCaptureProfileHeartbeat
        : undefined;
      const categoryCounts = Object.fromEntries(EVENT_CATEGORIES.map((category) => [category, 0])) as Record<T.EventCategory, number>;
      let eventCount = 0;
      let observedAgentCount = 0;
      let reportedIntervalSecs = 0;
      const windowErrorMaxima = { droppedEvents: 0, outputDropped: 0, errorCount: 0 };
      const windowExecEvidence: T.CollectorExecEvidenceMetrics & {
        heartbeatCount: number;
        intervalSecs: number;
        shutdownFinalCount: number;
      } = {
        exec: 0,
        execTruncated: 0,
        execIncomplete: 0,
        execReassemblyTimeout: 0,
        heartbeatCount: 0,
        intervalSecs: 0,
        shutdownFinalCount: 0,
      };
      let latestExecEvidenceHeartbeat: T.CollectorHeartbeatRecord | undefined;
      for (const hb of hbs) {
        observedAgentCount = Math.max(observedAgentCount, hb.observedAgents);
        reportedIntervalSecs += hb.intervalSecs;
        windowErrorMaxima.droppedEvents = Math.max(windowErrorMaxima.droppedEvents, hb.droppedEvents ?? 0);
        windowErrorMaxima.outputDropped = Math.max(windowErrorMaxima.outputDropped, hb.outputDropped ?? 0);
        windowErrorMaxima.errorCount = Math.max(windowErrorMaxima.errorCount, hb.errorCount ?? 0);
        if (hb.origin === 'raw_collector' && hb.execEvidence) {
          windowExecEvidence.exec += hb.execEvidence.exec ?? 0;
          windowExecEvidence.execTruncated += hb.execEvidence.execTruncated ?? 0;
          windowExecEvidence.execIncomplete += hb.execEvidence.execIncomplete ?? 0;
          windowExecEvidence.execReassemblyTimeout += hb.execEvidence.execReassemblyTimeout ?? 0;
          windowExecEvidence.heartbeatCount += 1;
          windowExecEvidence.intervalSecs += hb.intervalSecs ?? 0;
          if (hb.execEvidence.shutdownFinal) windowExecEvidence.shutdownFinalCount += 1;
          if (!latestExecEvidenceHeartbeat || hb.at >= latestExecEvidenceHeartbeat.at) {
            latestExecEvidenceHeartbeat = hb;
          }
        }
        for (const [kind, count] of Object.entries(hb.eventKindCounts)) {
          eventCount += count;
          const category = eventCategory(kind);
          categoryCounts[category] = (categoryCounts[category] ?? 0) + count;
        }
      }
      const age = latest ? t - latest.at : Infinity;
      const pipelineAccounting = summarizePipelineAccounting(hbs);
      const laneHeartbeats = [
        ...hbs,
        ...(freshRawHeartbeat ? [freshRawHeartbeat] : []),
        ...(freshForwarderHeartbeat ? [freshForwarderHeartbeat] : []),
        ...(freshCaptureProfileHeartbeat ? [freshCaptureProfileHeartbeat] : []),
      ];
      const recentRaw = freshRawHeartbeat
        ? recentHeartbeatLane(laneHeartbeats, 'raw_collector')
        : [];
      const recentForwarder = freshForwarderHeartbeat
        ? recentHeartbeatLane(laneHeartbeats, 'forwarder')
        : [];
      const captureEvaluations = recentRaw.map((heartbeat, index) =>
        evaluateCollectorCaptureHeartbeat(heartbeat, recentRaw[index + 1]));
      if (captureEvaluations.length && freshCaptureProfileHeartbeat?.captureProfileMetrics) {
        const previousProfileHeartbeat = recentRaw.find((heartbeat) =>
          heartbeat.at < freshCaptureProfileHeartbeat.at);
        const profileEvaluation = evaluateCollectorCaptureHeartbeat(
          freshCaptureProfileHeartbeat,
          previousProfileHeartbeat,
        );
        if (profileEvaluation.severity > captureEvaluations[0].severity) {
          captureEvaluations[0] = {
            severity: profileEvaluation.severity,
            reasons: [...new Set([
              ...captureEvaluations[0].reasons,
              ...profileEvaluation.reasons,
            ])],
          };
        }
      }
      const healthChannels = {
        capture: stabilizeCollectorHealthChannel(
          captureEvaluations,
          'capture_recovering_after_recent_failure',
        ),
        delivery: stabilizeCollectorHealthChannel(
          recentForwarder.map(deliveryEvaluation),
          'delivery_recovering_after_recent_failure',
        ),
        control: stabilizeCollectorHealthChannel(
          recentForwarder.map(controlEvaluation),
          'control_recovering_after_recent_failure',
        ),
      };
      // Raw Collector and enriched Forwarder heartbeats are independent operational producers.
      // A clean record from one must not erase the latest error/drop reported by the other.
      const operationalHeads = [latestRawHeartbeat, latestForwarderHeartbeat].filter(
        (heartbeat): heartbeat is T.CollectorHeartbeatRecord => heartbeat !== undefined,
      );
      const currentDroppedEvents = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.droppedEvents), 0,
      );
      const currentOutputDropped = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.outputDropped), 0,
      );
      const currentErrorCount = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.errorCount), 0,
      );
      const currentQueueDepth = operationalHeads.reduce(
        (value, heartbeat) => Math.max(value, heartbeat.queueDepth), 0,
      );
      const degraded = Object.values(healthChannels).some((channel) => channel.state === 'degraded');
      const state: T.CollectorHealthState = age > COLLECTOR_DOWN_MS
        ? 'down'
        : age > COLLECTOR_STALE_MS
          ? 'stale'
          : degraded
            ? 'degraded'
            : eventCount === 0
              ? 'quiet'
              : 'healthy';
      return {
        collectorId,
        nodeName: collectorMetadataHeartbeat?.nodeName,
        namespace: collectorMetadataHeartbeat?.namespace,
        podName: collectorMetadataHeartbeat?.podName,
        version: collectorMetadataHeartbeat?.version,
        mode: collectorMetadataHeartbeat?.mode,
        state,
        stateText: stateText[state],
        healthChannels,
        firstSeen: hbs.length ? iso(Math.min(...hbs.map((hb) => hb.at))) : undefined,
        lastHeartbeatAt: latest ? iso(latest.at) : undefined,
        lastSeenAt: latest ? iso(latest.at) : undefined,
        eventCount,
        eventRatePerMin: round1(eventCount / Math.max(1, reportedIntervalSecs > 0 ? reportedIntervalSecs / 60 : spanMs / 60_000)),
        riskyEventCount: 0,
        observedAgentCount,
        observedWorkspaceCount: 0,
        attachedProbes: collectorMetadataHeartbeat?.attachedProbes ?? 0,
        enabledFeatures: collectorMetadataHeartbeat?.enabledFeatures ?? [],
        queueDepth: currentQueueDepth,
        droppedEvents: currentDroppedEvents,
        outputDropped: currentOutputDropped,
        errorCount: currentErrorCount,
        windowErrorMaxima,
        execEvidence: {
          reported: latestExecEvidenceHeartbeat !== undefined,
          ...(latestExecEvidenceHeartbeat ? {
            // Preserve milliseconds for the shutdown barrier; top-level health timestamps are
            // intentionally second-granular and cannot order two raw heartbeats in one second.
            lastReportedAt: new Date(latestExecEvidenceHeartbeat.at).toISOString(),
            latest: {
              exec: latestExecEvidenceHeartbeat.execEvidence?.exec ?? 0,
              execTruncated: latestExecEvidenceHeartbeat.execEvidence?.execTruncated ?? 0,
              execIncomplete: latestExecEvidenceHeartbeat.execEvidence?.execIncomplete ?? 0,
              execReassemblyTimeout: latestExecEvidenceHeartbeat.execEvidence?.execReassemblyTimeout ?? 0,
              shutdownFinal: latestExecEvidenceHeartbeat.execEvidence?.shutdownFinal === true,
              intervalSecs: latestExecEvidenceHeartbeat.intervalSecs ?? 0,
            },
          } : {}),
          window: windowExecEvidence,
        },
        ...(pipelineAccounting ? { pipelineAccounting } : {}),
        filterMetricsReported: freshMetricsHeartbeat !== undefined,
        filterMetrics: visibleCollectorFilterMetrics(freshMetricsHeartbeat?.filterMetrics ?? {
          scope: 'decoupled',
          shutdownFinal: false,
          filterMode: 'shadow',
          retainUnknown: true,
          retainNonAgent: false,
          noisePolicy: 'balanced',
          observed: 0,
          forwarded: 0,
          confirmedAgent: 0,
          probableAgent: 0,
          unknown: 0,
          nonAgent: 0,
          filteredNonAgent: 0,
          wouldFilterNonAgent: 0,
          filteredUnknown: 0,
          wouldFilterUnknown: 0,
          filteredNoise: 0,
          wouldFilterNoise: 0,
          discoveryBudgetDropped: 0,
          wouldDiscoveryBudgetDrop: 0,
          deduplicated: 0,
          queueDropped: 0,
          batches: 0,
          batchEvents: 0,
          identitySnapshotReady: false,
          identitySnapshotVersion: 0,
          identitySnapshotAgeSeconds: 0,
          identityCacheEntries: 0,
          identityCacheHits: 0,
          identityCacheMisses: 0,
          identityCandidateCacheEntries: 0,
          identityCgroupBindings: 0,
          identityCgroupHits: 0,
          identityCgroupMisses: 0,
          identityErrors: 0,
          dockerEnabled: false,
          dockerReady: false,
          dockerEntries: 0,
          dockerReconnects: 0,
          dockerErrors: 0,
          behaviorWorkloads: 0,
          behaviorCandidates: 0,
          behaviorPromoted: 0,
          behaviorEvicted: 0,
          templateLoaded: 0,
          templateInvalid: 0,
          templateMatches: 0,
          templateAmbiguous: 0,
          processCacheEntries: 0,
          processTombstones: 0,
          processClassifications: 0,
          processCacheHits: 0,
          processCacheMisses: 0,
          processProcReads: 0,
          processBootstrapProcReads: 0,
          processFallbackProcReads: 0,
          processAncestryProcReads: 0,
        }),
        fileFilterMetricsReported: freshFileFilterHeartbeat !== undefined,
        fileFilterMetrics: freshFileFilterHeartbeat?.fileFilterMetrics ?? {
          fileAccess: 0,
          fileDelete: 0,
          accessKept: 0,
          accessSampled: 0,
          accessDropped: 0,
          accessSuppressed: 0,
          deleteKept: 0,
          deleteDropped: 0,
          ruleHits: 0,
          ruleMisses: 0,
          staleRules: 0,
          accessRingDropped: 0,
          deleteRingDropped: 0,
          enabled: false,
          epoch: 0,
        },
        captureProfileMetricsReported: freshCaptureProfileHeartbeat !== undefined,
        ...(freshCaptureProfileHeartbeat?.captureProfileMetrics
          ? { captureProfileMetrics: freshCaptureProfileHeartbeat.captureProfileMetrics }
          : {}),
        message: latest?.message,
        eventCategoryCounts: categoryCounts,
      };
    });

    const collectorId = requestedCollectorId;
    const nodeName = filter.nodeName?.trim();
    const q = filter.q?.trim().toLowerCase();
    const hasFilter = Boolean((filter.state && filter.state !== 'all') || nodeName || q);
    const filtered = items
      .filter((item) => {
        const matchesCollectorId = Boolean(collectorId && item.collectorId === collectorId);
        const matchesFilter =
          (!filter.state || filter.state === 'all' || item.state === filter.state) &&
          (!nodeName || item.nodeName === nodeName) &&
          (!q || [item.collectorId, item.nodeName, item.namespace, item.podName, item.version, item.mode, item.message].some((v) => (v ?? '').toLowerCase().includes(q)));
        if (collectorId && !hasFilter) return matchesCollectorId;
        return matchesCollectorId || matchesFilter;
      })
      .sort((a, b) => {
        const rank: Record<T.CollectorHealthState, number> = { down: 0, stale: 1, degraded: 2, quiet: 3, healthy: 4 };
        return Number(Boolean(collectorId) && b.collectorId === collectorId) - Number(Boolean(collectorId) && a.collectorId === collectorId)
          || rank[a.state] - rank[b.state]
          || b.droppedEvents - a.droppedEvents
          || b.eventCount - a.eventCount;
      });
    const summary: T.CollectorHealthSummary = {
      totalCollectors: filtered.length,
      healthyCollectors: filtered.filter((item) => item.state === 'healthy').length,
      quietCollectors: filtered.filter((item) => item.state === 'quiet').length,
      warningCollectors: filtered.filter((item) =>
        !['degraded', 'stale', 'down'].includes(item.state) &&
        Object.values(item.healthChannels).some((channel) => channel.state === 'warning')).length,
      degradedCollectors: filtered.filter((item) => item.state === 'degraded').length,
      staleCollectors: filtered.filter((item) => item.state === 'stale').length,
      downCollectors: filtered.filter((item) => item.state === 'down').length,
      collectorsWithHeartbeat: filtered.filter((item) => item.lastHeartbeatAt).length,
      observedEventCount: filtered.reduce((a, item) => a + item.eventCount, 0),
      observedAgentCount: filtered.reduce((a, item) => a + item.observedAgentCount, 0),
    };
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
      summary,
      coverage: this.queryCoverage(filter, [], {
        source: durable?.source ?? 'memory_hot_ring',
        totalMode: 'exact',
        partial: !durable,
        partialReason: durable ? undefined : 'hot_ring_only',
        dataFromMs: windowHeartbeats.length
          ? Math.min(...windowHeartbeats.map((heartbeat) => heartbeat.at))
          : undefined,
        dataToMs: windowHeartbeats.length
          ? Math.max(...windowHeartbeats.map((heartbeat) => heartbeat.at))
          : undefined,
      }),
      updateTime: iso(window.endMs),
    };
  }

  async storedCoverageOverview(filter: T.CoverageQuery): Promise<T.CoverageOverview> {
    if (!this.judge.storageStatus().clickhouseReady) return this.coverageOverview(filter);
    const [collectors, agents] = await Promise.all([
      this.storedCollectorHealth({
        timeType: filter.timeType,
        startTime: filter.startTime,
        endTime: filter.endTime,
        limit: 500,
      }),
      this.storedAgentInventory({
        timeType: filter.timeType,
        startTime: filter.startTime,
        endTime: filter.endTime,
        scope: 'agent',
        limit: 500,
      }),
      this.sources.refreshDistributedCurrentState(),
    ]);
    return this.coverageOverview(filter, { collectors, agents });
  }

  coverageOverview(
    filter: T.CoverageQuery,
    durable?: { collectors: T.CollectorHealth; agents: T.AgentInventory },
  ): T.CoverageOverview {
    const events = durable
      ? []
      : this.win(filter).events.filter((event) => event.attribution?.monitored === true);
    const collectors = durable?.collectors ??
      this.collectorHealth({ timeType: filter.timeType, startTime: filter.startTime, endTime: filter.endTime, limit: 500 });
    const agents = durable?.agents ??
      this.agentInventory({ timeType: filter.timeType, startTime: filter.startTime, endTime: filter.endTime, scope: 'agent', limit: 500 });
    // A directly scoped source or issue must also participate when it is a verifier
    // source. IngestionSourceService deliberately hides verifier sources from broad
    // inventory views, while an exact sourceId/issueId is an explicit operator
    // selection. The issue list is pinned again below, so enabling verifier inputs for
    // an exact issue cannot widen the returned issue inventory.
    const sourceList = this.sources.list({
      status: 'all',
      type: 'all',
      sourceId: filter.sourceId,
      includeVerification: Boolean(filter.issueId),
      limit: 500,
    });
    const collectorById = new Map(collectors.items.map((collector) => [collector.collectorId, collector]));
    const activeCollectorIds = new Set(
      collectors.items
        .filter((collector) => collector.state === 'healthy' || collector.state === 'quiet' || collector.state === 'degraded')
        .map((collector) => collector.collectorId),
    );
    const byAgent = new Map<string, T.JudgedEvent[]>();
    const byWorkspace = new Map<string, T.AgentInventoryItem[]>();
    for (const e of events) {
      const key = `${e.workspacePath}\0${e.agentId}`;
      (byAgent.get(key) ?? byAgent.set(key, []).get(key)!).push(e);
    }
    for (const agent of agents.items) {
      (byWorkspace.get(agent.workspacePath) ?? byWorkspace.set(agent.workspacePath, []).get(agent.workspacePath)!).push(agent);
    }

    const issue = (
      type: T.CoverageIssueType,
      severity: T.Severity,
      title: string,
      description: string,
      recommendedAction: string,
      labels: Record<string, string>,
      refs: Partial<Pick<T.CoverageIssue, 'agentId' | 'workspacePath' | 'collectorId' | 'sourceId' | 'nodeName' | 'evidenceEventId' | 'evidenceSubject' | 'lastSeenAt'>> = {},
    ): T.CoverageIssue => {
      const maintenance = this.maintenance.activeFor({
        workspacePath: refs.workspacePath,
        agentId: refs.agentId,
        collectorId: refs.collectorId,
        sourceId: refs.sourceId,
        nodeName: refs.nodeName,
      });
      return {
        issueId: compactIssueId(type, refs.workspacePath, refs.agentId, refs.collectorId, refs.nodeName, title),
        type,
        severity,
        title,
        description,
        detectedAt: iso(),
        recommendedAction,
        labels,
        suppressedByMaintenance: Boolean(maintenance),
        maintenanceWindowId: maintenance?.windowId,
        maintenanceTitle: maintenance?.title,
        ...refs,
      };
    };

    const issues: T.CoverageIssue[] = [];
    for (const source of sourceList.items) {
      if (!source.enabled) continue;
      const refs = {
        sourceId: source.sourceId,
        collectorId: source.collectorId,
        workspacePath: source.workspacePath,
        lastSeenAt: source.lastSignalAt ?? source.lastSeenAt,
      };
      const labels = {
        sourceType: source.type,
        requireToken: String(source.requireToken),
        acceptedEvents: String(source.acceptedEvents),
        acceptedHeartbeats: String(source.acceptedHeartbeats),
        rejectedEvents: String(source.rejectedEvents),
      };
      if (source.status === 'unused') {
        issues.push(issue(
          'source_unused',
          source.discovered ? 'low' : 'medium',
          `接入源未产生有效信号 · ${source.sourceId}`,
          source.lastSeenAt ? `最近只有接入尝试: ${source.lastSeenAt}，尚无 accepted event/heartbeat。` : '该接入源尚未产生 accepted event/heartbeat。',
          '发送一次带正确 sourceId/token 的测试事件或 check-in；若该源已废弃，请禁用它。',
          { ...labels, discovered: String(source.discovered) },
          refs,
        ));
      } else if (source.status === 'stale') {
        issues.push(issue(
          'source_stale',
          'high',
          `接入源信号陈旧 · ${source.sourceId}`,
          `最近 accepted 信号: ${source.lastSignalAt ?? 'unknown'}，该异构接入链路可能已经中断。`,
          '检查 forwarder/webhook/OTel bridge 进程、网络和 token；确认仍在发送 accepted event 或 heartbeat。',
          labels,
          refs,
        ));
      }

      if (source.lastResult === 'rejected') {
        issues.push(issue(
          'source_rejected',
          source.requireToken ? 'high' : 'medium',
          `接入源最近请求被拒绝 · ${source.sourceId}`,
          source.lastError ?? '最近一次接入尝试被拒绝。',
          '检查 source token、sourceId 绑定、事件格式和 /alerts 中的 Source 告警。',
          { ...labels, lastError: source.lastError ?? 'unknown' },
          { ...refs, lastSeenAt: source.lastSeenAt },
        ));
      }

      if (source.tokenRotationStatus === 'overdue') {
        issues.push(issue(
          'source_token_rotation_due',
          source.status === 'active' ? 'medium' : 'low',
          `接入源 Token 需要轮换 · ${source.sourceId}`,
          `Token issued=${source.tokenIssuedAt ?? 'unknown'}，rotation due=${source.tokenRotationDueAt ?? 'unknown'}。`,
          '在 Sources 页面轮换 token，更新生产者密钥后发送 check-in 或测试事件确认新 token 生效。',
          {
            ...labels,
            tokenIssuedAt: source.tokenIssuedAt ?? 'unknown',
            tokenRotationDueAt: source.tokenRotationDueAt ?? 'unknown',
            tokenRotationDays: String(source.tokenRotationDays ?? ''),
            tokenAgeSecs: String(source.tokenAgeSecs ?? ''),
          },
          { ...refs, lastSeenAt: source.lastSignalAt ?? source.lastSeenAt ?? source.tokenRotationDueAt },
        ));
      }
    }

    for (const collector of collectors.items) {
      if (collector.state === 'down') {
        issues.push(issue(
          'collector_down',
          'critical',
          `Collector 断流 · ${collector.collectorId}`,
          `最近心跳: ${collector.lastHeartbeatAt ?? 'unknown'}，该采集链路已超过断流阈值。`,
          '检查 DaemonSet/forwarder 进程、节点网络和 /security-center/ingest 可达性。',
          { state: collector.state, eventRatePerMin: String(collector.eventRatePerMin) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      } else if (collector.state === 'stale') {
        issues.push(issue(
          'collector_stale',
          'high',
          `Collector 心跳陈旧 · ${collector.collectorId}`,
          `最近心跳: ${collector.lastHeartbeatAt ?? 'unknown'}，采集链路可能正在断开。`,
          '确认 observer collector 仍在发送 CollectorHeartbeat，并检查节点资源压力。',
          { state: collector.state, eventRatePerMin: String(collector.eventRatePerMin) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      } else if (collector.state === 'degraded') {
        const dropped = collector.droppedEvents + collector.outputDropped;
        issues.push(issue(
          'collector_degraded',
          dropped > 0 || collector.errorCount > 0 ? 'high' : 'medium',
          `Collector 降级 · ${collector.collectorId}`,
          `dropped=${dropped}, errors=${collector.errorCount}, queue=${collector.queueDepth}`,
          '检查 ring buffer、输出队列、CPU/内存限制，以及 AnySentry ingest 延迟。',
          { dropped: String(dropped), errors: String(collector.errorCount), queueDepth: String(collector.queueDepth) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      } else if (collector.state === 'quiet' && collector.observedAgentCount > 0) {
        issues.push(issue(
          'collector_quiet',
          'low',
          `Collector 静默 · ${collector.collectorId}`,
          `Collector 上报覆盖 ${collector.observedAgentCount} 个 Agent，但当前窗口没有事件。`,
          '确认窗口内是否预期无活动；若不是，检查 eBPF probes 和事件过滤条件。',
          { observedAgents: String(collector.observedAgentCount) },
          { collectorId: collector.collectorId, nodeName: collector.nodeName, lastSeenAt: collector.lastSeenAt },
        ));
      }
    }

    const collectorIdsFromEvents = new Map<string, {
      count: number;
      agents: Set<string>;
      sample?: T.JudgedEvent;
      aggregateOnly?: boolean;
    }>();
    for (const e of events) {
      const collectorId = eventCollectorId(e);
      if (!collectorId) continue;
      const cur = collectorIdsFromEvents.get(collectorId) ?? { count: 0, agents: new Set<string>(), sample: e };
      cur.count += 1;
      cur.agents.add(e.agentId);
      if (!cur.sample || e.at > cur.sample.at) cur.sample = e;
      collectorIdsFromEvents.set(collectorId, cur);
    }
    if (durable) {
      for (const agent of agents.items) {
        for (const collectorId of agent.collectorIds ?? []) {
          const current = collectorIdsFromEvents.get(collectorId) ?? {
            count: 0,
            agents: new Set<string>(),
            aggregateOnly: true,
          };
          current.agents.add(agent.agentId);
          collectorIdsFromEvents.set(collectorId, current);
        }
      }
    }
    for (const [collectorId, rec] of collectorIdsFromEvents) {
      if (collectorById.has(collectorId)) continue;
      issues.push(issue(
        'missing_collector_heartbeat',
        'high',
        `缺少 Collector 心跳 · ${collectorId}`,
        rec.aggregateOnly
          ? `${rec.agents.size} 个持久化 Agent 聚合仍引用该 collectorId，但查询窗口内没有对应 CollectorHeartbeat。`
          : `${rec.count} 条事件携带该 collectorId，但没有对应 CollectorHeartbeat。`,
        '启用 a3s-observer CollectorHeartbeat，或让 forwarder 定期 POST /security-center/collectors/heartbeat。',
        rec.aggregateOnly
          ? { evidenceMode: 'agent_aggregate', agentCount: String(rec.agents.size) }
          : { evidenceMode: 'event_fact', eventCount: String(rec.count), agentCount: String(rec.agents.size) },
        {
          collectorId,
          nodeName: rec.sample ? attrString(rec.sample, 'collectorNode') || undefined : undefined,
          evidenceEventId: rec.sample?.eventId,
          evidenceSubject: rec.sample?.subject,
          lastSeenAt: rec.sample ? iso(rec.sample.at) : undefined,
        },
      ));
    }

    let coveredAgents = 0;
    let uncoveredAgents = 0;
    let staleAgents = 0;
    let eventsWithoutCollector = 0;
    for (const agent of agents.items) {
      const key = `${agent.workspacePath}\0${agent.agentId}`;
      const agentEvents = byAgent.get(key) ?? [];
      const latest = [...agentEvents].sort((a, b) => b.at - a.at)[0];
      const collectorIds = new Set(
        durable
          ? agent.collectorIds ?? []
          : agentEvents.map(eventCollectorId).filter(Boolean),
      );
      const liveCollectorIds = [...collectorIds].filter((collectorId) => activeCollectorIds.has(collectorId));
      const missingCollectorEvents = agentEvents.filter(missingCollectorCoverage);
      const missingCollectorEventCount = durable
        ? agent.eventsWithoutCollector ?? 0
        : missingCollectorEvents.length;
      eventsWithoutCollector += missingCollectorEventCount;
      const covered = liveCollectorIds.length > 0;
      if (covered) coveredAgents += 1;
      else uncoveredAgents += 1;
      if (agent.healthState === 'stale') staleAgents += 1;

      if (agent.healthState === 'stale') {
        issues.push(issue(
          'agent_stale',
          agent.openIncidentCount > 0 ? 'high' : 'medium',
          `Agent 观测陈旧 · ${agent.agentId}`,
          `最近事件: ${agent.lastSeen}，当前窗口内该 Agent 没有新的旁路活动。`,
          '确认该 Agent 是否仍在运行；若仍运行，检查所在节点 observer/forwarder 覆盖。',
          { openIncidents: String(agent.openIncidentCount), eventCount: String(agent.eventCount) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: latest?.eventId ?? agent.lastEventId, evidenceSubject: latest?.subject ?? agent.lastEventSubject, lastSeenAt: agent.lastSeen },
        ));
      }

      if (!covered) {
        const severity: T.Severity = agent.openIncidentCount > 0 || agent.riskyEventCount > 0 ? 'high' : 'medium';
        issues.push(issue(
          'agent_uncovered',
          severity,
          `Agent 缺少有效 Collector 覆盖 · ${agent.agentId}`,
          collectorIds.size
            ? `事件归属 Collector: ${[...collectorIds].join(', ')}，但当前没有活跃心跳。`
            : '该 Agent 的事件没有 collectorId，无法定位采集链路。',
          '检查 forwarder 是否附加 collectorId/nodeName，并确认对应 CollectorHeartbeat 正常上报。',
          { collectorIds: [...collectorIds].join(', ') || 'none', missingCollectorEvents: String(missingCollectorEventCount) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: latest?.eventId ?? agent.lastEventId, evidenceSubject: latest?.subject ?? agent.lastEventSubject, lastSeenAt: agent.lastSeen },
        ));
      } else if (missingCollectorEventCount > 0) {
        issues.push(issue(
          'agent_uncovered',
          agent.riskyEventCount > 0 ? 'medium' : 'low',
          `Agent 部分事件缺少 Collector 归属 · ${agent.agentId}`,
          `${missingCollectorEventCount}/${agent.eventCount} 条事件没有 collectorId。`,
          '统一使用 observer forwarder，并在事件 attributes 中附加 collectorId/nodeName。',
          { missingCollectorEvents: String(missingCollectorEventCount), eventCount: String(agent.eventCount) },
          { agentId: agent.agentId, workspacePath: agent.workspacePath, evidenceEventId: missingCollectorEvents[0]?.eventId ?? agent.lastEventId, evidenceSubject: missingCollectorEvents[0]?.subject ?? agent.lastEventSubject, lastSeenAt: agent.lastSeen },
        ));
      }
    }

    for (const [workspacePath, workspaceAgents] of byWorkspace) {
      if (workspaceAgents.length < 2) continue;
      const stale = workspaceAgents.filter((agent) => agent.healthState === 'stale');
      if (stale.length !== workspaceAgents.length) continue;
      issues.push(issue(
        'workspace_quiet',
        'medium',
        `Workspace 整体静默 · ${workspacePath}`,
        `${workspaceAgents.length} 个已观察 Agent 全部处于陈旧状态。`,
        '确认该 Workspace 是否已停用；若未停用，检查节点级 observer 覆盖和命名空间过滤。',
        { agentCount: String(workspaceAgents.length) },
        { workspacePath, lastSeenAt: workspaceAgents.map((agent) => agent.lastSeen).sort().at(-1) },
      ));
    }

    const q = filter.q?.trim().toLowerCase();
    const pinnedIssueId = filter.issueId?.trim();
    const agentId = filter.agentId?.trim();
    const workspacePath = filter.workspacePath?.trim();
    const collectorId = filter.collectorId?.trim();
    const sourceId = filter.sourceId?.trim();
    const hasFilter = Boolean(agentId || workspacePath || collectorId || sourceId || (filter.severity && filter.severity !== 'all') || (filter.type && filter.type !== 'all') || q);
    const filtered = issues
      .filter((item) => {
        const matchesIssueId = Boolean(pinnedIssueId && item.issueId === pinnedIssueId);
        const matchesFilter =
          (!agentId || item.agentId === agentId) &&
          (!workspacePath || item.workspacePath === workspacePath) &&
          (!collectorId || item.collectorId === collectorId) &&
          (!sourceId || item.sourceId === sourceId) &&
          (!filter.severity || filter.severity === 'all' || item.severity === filter.severity) &&
          (!filter.type || filter.type === 'all' || item.type === filter.type) &&
          (!q || [item.title, item.description, item.agentId, item.workspacePath, item.collectorId, item.sourceId, item.nodeName, item.evidenceSubject, item.type, item.maintenanceTitle].some((v) => (v ?? '').toLowerCase().includes(q)));
        if (pinnedIssueId && !hasFilter) return matchesIssueId;
        return matchesIssueId || matchesFilter;
      })
      .sort((a, b) =>
        Number(Boolean(pinnedIssueId) && b.issueId === pinnedIssueId) - Number(Boolean(pinnedIssueId) && a.issueId === pinnedIssueId) ||
        Number(a.suppressedByMaintenance) - Number(b.suppressedByMaintenance) ||
        SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
        String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')),
      );
    const limit = Math.max(1, Math.min(500, filter.limit ?? 120));
    const actionable = issues.filter((item) => !item.suppressedByMaintenance);
    const actionableSourceGapCount = distinct(
      actionable
        .filter((item) => item.type === 'source_unused' || item.type === 'source_stale')
        .map((item) => item.sourceId)
        .filter((sourceId): sourceId is string => Boolean(sourceId)),
    );
    const allCounts = {
      critical: actionable.filter((item) => item.severity === 'critical').length,
      high: actionable.filter((item) => item.severity === 'high').length,
      medium: actionable.filter((item) => item.severity === 'medium').length,
      low: actionable.filter((item) => item.severity === 'low').length,
    };
    const unhealthySourceCount = distinct(
      sourceList.items
        .filter((source) => source.enabled && (source.status === 'stale' || source.status === 'unused' || source.lastResult === 'rejected' || source.tokenRotationStatus === 'overdue'))
        .map((source) => source.sourceId),
    );
    const coverageScore = Math.max(1, Math.min(100, Math.round(
      100
      - allCounts.critical * 25
      - allCounts.high * 15
      - allCounts.medium * 7
      - allCounts.low * 3
      - Math.max(0, uncoveredAgents) * 4
      - actionableSourceGapCount * 2
      - Math.min(20, eventsWithoutCollector),
    )));
    const statusText = coverageScore >= 90 ? '覆盖良好' : coverageScore >= 75 ? '轻微缺口' : coverageScore >= 55 ? '需要关注' : coverageScore >= 35 ? '覆盖不足' : '严重盲区';
    return {
      summary: {
        coverageScore,
        statusText,
        issueCount: actionable.length,
        criticalIssues: allCounts.critical,
        highIssues: allCounts.high,
        mediumIssues: allCounts.medium,
        lowIssues: allCounts.low,
        suppressedIssues: issues.length - actionable.length,
        observedAgents: agents.summary.totalAgents,
        coveredAgents,
        uncoveredAgents,
        staleAgents,
        totalCollectors: collectors.summary.totalCollectors,
        activeCollectors: collectors.summary.healthyCollectors + collectors.summary.quietCollectors + collectors.summary.degradedCollectors,
        degradedCollectors: collectors.summary.degradedCollectors,
        downCollectors: collectors.summary.downCollectors + collectors.summary.staleCollectors,
        totalSources: sourceList.summary.totalSources,
        activeSources: sourceList.summary.activeSources,
        unhealthySources: unhealthySourceCount,
        eventsWithoutCollector,
        observedWorkspaces: distinct(agents.items.map((agent) => agent.workspacePath)),
      },
      issues: filtered.slice(0, limit),
      coverage: durable
        ? {
            ...agents.coverage,
            source: agents.coverage.source === 'clickhouse+hot_delta' || collectors.coverage?.source === 'clickhouse+hot_delta'
              ? 'clickhouse+hot_delta'
              : collectors.coverage?.source === 'clickhouse+redis_current'
                ? 'clickhouse+redis_current'
                : 'clickhouse',
            partial: Boolean(agents.coverage.partial || collectors.coverage?.partial),
            partialReason: agents.coverage.partialReason ?? collectors.coverage?.partialReason,
          }
        : this.queryCoverage(filter, events, {
            source: 'memory_hot_ring',
            totalMode: 'exact',
            partial: true,
            partialReason: 'hot_ring_only',
          }),
      updateTime: iso(),
    };
  }

  async storedPolicySimulation(input: T.PolicySimulationRequest): Promise<T.PolicySimulationResult> {
    if (!this.judge.storageStatus().clickhouseReady) return this.policySimulation(input);
    const window = resolveTimeWindow(input);
    const sampleLimit = Math.max(100, Math.min(5_000, input.sampleLimit ?? 2_000));
    const persisted = await this.judge.searchStoredEventsPage({
      sinceMs: window.startMs,
      untilMs: window.endMs,
      monitoredOnly: input.scope === 'agent' && resolvedClassificationView(input) === 'as_observed',
      limit: sampleLimit,
    });
    const hot = this.judge.queryRange(window.startMs, window.endMs);
    const scoped = foldLatestEventRevisions([...persisted.events, ...hot])
      .filter((event) => input.scope !== 'agent' || this.eventIsAgentForView(event, input))
      .sort((a, b) => b.at - a.at);
    const truncated = persisted.hasMore || scoped.length > sampleLimit;
    const events = scoped.slice(0, sampleLimit);
    const coverage = this.queryCoverage(input, events, {
      source: hot.length ? 'clickhouse+hot_delta' : 'clickhouse',
      totalMode: 'omitted',
      partial: truncated,
      partialReason: truncated ? 'scan_limit' : undefined,
      committedCutoffMs: persisted.committedCutoffMs,
    });
    return this.policySimulation(input, events, coverage, sampleLimit, truncated);
  }

  policySimulation(
    input: T.PolicySimulationRequest,
    sampledEvents?: T.JudgedEvent[],
    durableCoverage?: T.QueryCoverage,
    durableSampleLimit?: number,
    durableTruncated = false,
  ): T.PolicySimulationResult {
    const config = sanitizePolicy(input.policy);
    let simulator: Sentry;
    try {
      simulator = Sentry.create(buildAcl(config));
    } catch (error) {
      throw policyConfigError(error);
    }
    const window = sampledEvents ? undefined : this.win(input);
    const events = sampledEvents ?? window!.events;
    const limit = Math.max(1, Math.min(500, input.limit ?? 120));
    const sampleLimit = durableSampleLimit ?? Math.max(1, Math.min(100_000, events.length));
    let evaluatedEvents = 0;
    let skippedEvents = 0;
    const diffs: T.PolicySimulationDiff[] = [];

    for (const event of events) {
      const raw = event.rawPreview;
      if (!raw) {
        skippedEvents += 1;
        continue;
      }
      evaluatedEvents += 1;
      let simulated: T.PolicySimulationDecision;
      try {
        simulated = normalizeSimulationDecision(simulator.evaluate(raw) as SimulatedDecision | null);
      } catch {
        skippedEvents += 1;
        continue;
      }
      const current: T.PolicySimulationDecision = {
        verdict: event.verdict,
        tier: event.tier,
        severity: event.severity,
        reason: event.reason,
      };
      const changeType = simulationChange(current, simulated);
      if (!changeType) continue;
      diffs.push({
        eventId: event.eventId,
        at: iso(event.at),
        eventKind: event.eventKind,
        subject: event.subject,
        agentId: event.agentId,
        workspacePath: event.workspacePath,
        traceId: event.traceId,
        riskCategory: event.riskCategory,
        riskName: event.riskName,
        current,
        simulated,
        changeType,
      });
    }

    diffs.sort((a, b) => {
      const aWeight = a.changeType === 'new_block' ? 4 : a.changeType === 'removed_block' ? 3 : a.changeType === 'new_escalation' ? 2 : 1;
      const bWeight = b.changeType === 'new_block' ? 4 : b.changeType === 'removed_block' ? 3 : b.changeType === 'new_escalation' ? 2 : 1;
      return bWeight - aWeight || SEV_RANK[b.simulated.severity] - SEV_RANK[a.simulated.severity] || Date.parse(b.at) - Date.parse(a.at);
    });

    const group = (keyOf: (diff: T.PolicySimulationDiff) => string): T.PolicySimulationGroup[] => {
      const byKey = new Map<string, T.PolicySimulationGroup>();
      for (const diff of diffs) {
        const key = keyOf(diff);
        const cur = byKey.get(key) ?? { key, eventCount: 0, newBlocks: 0, removedBlocks: 0, newEscalations: 0, maxSeverity: 'info' as T.Severity };
        cur.eventCount += 1;
        if (diff.changeType === 'new_block') cur.newBlocks += 1;
        if (diff.changeType === 'removed_block') cur.removedBlocks += 1;
        if (diff.changeType === 'new_escalation') cur.newEscalations += 1;
        cur.maxSeverity = SEV_RANK[diff.simulated.severity] > SEV_RANK[cur.maxSeverity] ? diff.simulated.severity : cur.maxSeverity;
        byKey.set(key, cur);
      }
      return [...byKey.values()].sort((a, b) => b.newBlocks - a.newBlocks || b.eventCount - a.eventCount).slice(0, 20);
    };

    const summary: T.PolicySimulationSummary = {
      evaluatedEvents,
      skippedEvents,
      changedEvents: diffs.length,
      newBlocks: diffs.filter((d) => d.changeType === 'new_block').length,
      removedBlocks: diffs.filter((d) => d.changeType === 'removed_block').length,
      newEscalations: diffs.filter((d) => d.changeType === 'new_escalation').length,
      removedEscalations: diffs.filter((d) => d.changeType === 'removed_escalation').length,
      severityIncreases: diffs.filter((d) => d.changeType === 'severity_increase').length,
      severityDecreases: diffs.filter((d) => d.changeType === 'severity_decrease').length,
      affectedAgents: distinct(diffs.map((d) => d.agentId)),
      affectedWorkspaces: distinct(diffs.map((d) => d.workspacePath)),
    };
    return {
      summary,
      diffs: diffs.slice(0, limit),
      byAgent: group((diff) => diff.agentId),
      byWorkspace: group((diff) => diff.workspacePath),
      sampling: {
        strategy: 'latest_event_sample',
        sampleLimit,
        sampledEvents: events.length,
        truncated: durableTruncated || !sampledEvents,
      },
      coverage: durableCoverage ?? this.queryCoverage(input, events, {
        source: 'memory_hot_ring',
        totalMode: 'omitted',
        partial: true,
        partialReason: 'hot_ring_only',
      }),
      ...this.classificationResponseMeta(input),
      updateTime: iso(),
    };
  }

  performanceCard(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityPerformanceCard {
    const window = resolveTimeWindow(filter);
    const windowed = this.win(filter);
    const windowEvents = overlay?.events ?? windowed.events;
    const events = overlay ? windowEvents : this.scopedEventsForView(windowEvents, filter);
    const dataSinceMs = overlay ? window.startMs : windowed.dataSinceMs;
    const dataSpanMs = overlay ? window.spanMs : windowed.dataSpanMs;
    const n = 60;
    const size = dataSpanMs / n || 1;
    const counts = this.buckets(events, dataSinceMs, dataSpanMs, n).map((b) => b.length);
    const perSec = counts.map((c) => c / (size / 1000));
    const reqCur = counts[counts.length - 1] ?? 0;
    return {
      componentRequestCount: { current: reqCur, peak: Math.max(0, ...counts), avg: Math.round(mean(counts)) },
      tps: { current: round1(perSec[perSec.length - 1] ?? 0), peak: round1(Math.max(0, ...perSec)), avg: round1(mean(perSec)) },
      avgLatency: { value: Math.round(mean(events.map((e) => e.latencyMs))), unit: 'ms' },
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  riskSummary(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityRiskSummary {
    const events = overlay?.events ?? this.scopedEventsForView(this.win(filter).events, filter);
    const risky = events.filter((e) => e.verdict !== 'allow');
    const card = (code: T.RiskType, name: string) => ({ riskTypeCode: code, riskTypeName: name, eventCount: risky.filter((e) => e.riskType === code).length });
    return {
      summaryCards: [card('system', '系统性风险'), card('communication', '通信风险'), card('atomic', '单体智能体风险')],
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  riskBreakdown(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
    previousOverlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityRiskBreakdown {
    const windowed = this.win(filter);
    const { sinceMs, spanMs } = windowed;
    const events = overlay?.events ?? windowed.events;
    const agentScoped = filter.scope === 'agent';
    const scopedEvents = overlay ? events : this.scopedEventsForView(events, filter, agentScoped);
    const prev = previousOverlay?.events ?? this.judge.query(sinceMs - spanMs).filter((e) => e.at < sinceMs);
    const scopedPrev = previousOverlay ? prev : this.scopedEventsForView(prev, filter, agentScoped);
    const cat = (type: T.RiskType): T.RiskCategory => {
      const risky = scopedEvents.filter((e) => e.verdict !== 'allow' && e.riskType === type);
      const prevRisky = scopedPrev.filter((e) => e.verdict !== 'allow' && e.riskType === type);
      const countOf = (xs: T.JudgedEvent[], code: string) => xs.filter((e) => e.riskCategory === code).length;
      // Always emit the full taxonomy for this type, then append any live code not in it (so a new
      // category from deriveRisk is never silently dropped).
      const known = RISK_TAXONOMY[type];
      const extras = [...new Set(risky.map((e) => e.riskCategory))]
        .filter((c) => !known.some((k) => k.code === c))
        .map((code) => ({ code, name: risky.find((e) => e.riskCategory === code)?.riskName ?? code }));
      const items = [...known, ...extras]
        .map(({ code, name }) => {
          const eventCount = countOf(risky, code);
          const before = countOf(prevRisky, code);
          const changeRate = before === 0 ? (eventCount ? 100 : 0) : round1(((eventCount - before) / before) * 100);
          return { riskCode: code, riskName: name, eventCount, changeRate };
        })
        .sort((a, b) => b.eventCount - a.eventCount);
      const top = items.find((i) => i.eventCount > 0);
      return { totalCount: risky.length, displayColor: CATEGORY_COLOR[top?.riskCode ?? ''] ?? '#94a3b8', items };
    };
    return {
      systemRisks: cat('system'),
      communicationRisks: cat('communication'),
      singleAgentRisks: cat('atomic'),
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  highestRiskSession(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityHighestRiskSession {
    const events = overlay?.events ?? this.win(filter).events;
    const agentEvents = overlay ? events : this.scopedEventsForView(events, filter, true);
    const bySession = new Map<string, T.JudgedEvent[]>();
    for (const e of agentEvents) {
      const key = eventSessionLabel(e);
      (bySession.get(key) ?? bySession.set(key, []).get(key)!).push(e);
    }
    let top: T.JudgedEvent[] = [];
    let topScore = -1;
    for (const evs of bySession.values()) {
      const s = evs.reduce((a, e) => a + e.riskScore, 0);
      if (s > topScore) [topScore, top] = [s, evs];
    }
    if (!top.length) {
      return {
        sessionId: '-',
        userId: '-',
        workspacePath: '-',
        riskLevel: 'safe',
        riskLevelText: LEVEL_TEXT.safe,
        compositeScore: 0,
        lastEventTime: iso(),
        riskDimensions: DIMENSIONS.map((d) => ({ dimensionCode: d.code, dimensionName: d.name, score: 0 })),
        ...(overlay ? { coverage: overlay.coverage } : {}),
        ...this.classificationResponseMeta(filter),
        updateTime: iso(),
      };
    }
    const head = top[0];
    const composite = Math.min(100, Math.round(mean(top.map((e) => e.riskScore)) + Math.sqrt(top.filter((e) => e.verdict !== 'allow').length) * 6));
    const dims = DIMENSIONS.map((d) => {
      const c = top.filter((e) => e.verdict !== 'allow' && d.cats.includes(e.riskCategory)).length;
      return { dimensionCode: d.code, dimensionName: d.name, score: c === 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : 3 };
    });
    const lvl = levelByRank(Math.min(4, Math.floor(composite / 22)));
    return {
      sessionId: eventAgentLabel(head), userId: head.userId, workspacePath: attributionWorkspacePath(head),
      riskLevel: lvl.level, riskLevelText: lvl.text, compositeScore: composite,
      lastEventTime: iso(Math.max(...top.map((e) => e.at))), riskDimensions: dims, updateTime: iso(),
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
    };
  }

  decisionFunnel(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityDecisionFunnel {
    const windowEvents = overlay?.events ?? this.win(filter).events;
    const events = overlay ? windowEvents : this.scopedEventsForView(windowEvents, filter);
    const total = events.length || 1;
    const l2 = events.filter((e) => e.tier === 'Llm' || e.tier === 'Agent');
    const l3 = events.filter((e) => e.tier === 'Agent');
    const blocked = events.filter((e) => e.verdict === 'block').length;
    const pct = (c: number) => round1((c / total) * 100);
    return {
      tiers: [
        { tierCode: 'L1', tierName: '规则引擎', count: events.length, percentage: 100, slaDesc: '确定性匹配 · <1ms' },
        { tierCode: 'L2', tierName: 'LLM 研判', count: l2.length, percentage: pct(l2.length), slaDesc: '语义判定 · <100ms' },
        { tierCode: 'L3', tierName: '智能体深判', count: l3.length, percentage: pct(l3.length), slaDesc: 'a3s-code · 深度调查' },
      ],
      finalBlock: { count: blocked, percentage: pct(blocked) },
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  agentObservability(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.AgentObservability {
    const windowEvents = overlay?.events ?? this.win(filter).events;
    const events = overlay ? windowEvents : this.scopedEventsForView(windowEvents, filter);
    const recent = events.filter((e) => e.at >= now() - 60_000);
    const total = events.length || 1;
    const errorRate = round1((events.filter((e) => e.verdict !== 'allow').length / total) * 100);
    const comm = recent.filter((e) => e.eventKind === 'Egress' || e.eventKind === 'Dns').length;
    return {
      health: { heartbeatOk: recent.length > 0, resourceUtil: Math.min(99, 20 + recent.length * 3), errorRate, decisionLatencyMs: Math.round(mean(events.map((e) => e.latencyMs))) },
      behavioral: { actionRate: recent.length, decisionPattern: errorRate > 25 ? 'drift' : 'baseline', stateTransitions: distinct(recent.map((e) => e.sessionId)), goalProgress: Math.max(0, 100 - Math.round(errorRate)) },
      system: { agentCount: distinct(events.map((e) => e.agentId)), commThroughput: comm, infraHealthy: true },
      ...(overlay ? { coverage: overlay.coverage } : {}),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async agentObservabilityForWindow(filter: T.SecurityTimeFilter): Promise<T.AgentObservability> {
    if (this.needsCurrentAgentOverlay(filter)) {
      return this.agentObservability(filter, await this.currentEffectiveOverlay(filter));
    }
    const durable = await this.storedAgentObservabilityFact(filter);
    if (!durable) return this.agentObservability(filter);
    const window = resolveTimeWindow(filter);
    const fact = durable.fact;
    const eventCount = fact.eventCount;
    const errorRate = round1((fact.riskyEventCount / (eventCount || 1)) * 100);
    return {
      health: {
        heartbeatOk: fact.recentEventCount > 0,
        resourceUtil: Math.min(99, 20 + fact.recentEventCount * 3),
        errorRate,
        decisionLatencyMs: Math.round(fact.latencyTotal / (eventCount || 1)),
      },
      behavioral: {
        actionRate: fact.recentEventCount,
        decisionPattern: errorRate > 25 ? 'drift' : 'baseline',
        stateTransitions: fact.recentSessionKeys.length,
        goalProgress: Math.max(0, 100 - Math.round(errorRate)),
      },
      system: {
        agentCount: fact.agentIds.length,
        commThroughput: fact.recentCommCount,
        infraHealthy: true,
      },
      coverage: durable.coverage,
      ...this.classificationResponseMeta(filter),
      updateTime: iso(window.endMs),
    };
  }

  async sharedAgentObservabilityForWindow(filter: T.SecurityTimeFilter): Promise<T.AgentObservability> {
    const window = resolveTimeWindow(filter);
    const key = JSON.stringify([
      window.custom ? window.cacheKey : ['relative', filter.timeType ?? 'last_3h'],
      filter.scope ?? 'all',
    ]);
    const effectiveFilter = window.custom || filter.snapshotAsOf
      ? filter
      : {
          ...filter,
          snapshotAsOf: new Date(Math.floor(now() / 3_000) * 3_000).toISOString(),
        };
    const completedKey = JSON.stringify([
      resolveTimeWindow(effectiveFilter).cacheKey,
      effectiveFilter.scope ?? 'all',
    ]);
    const recent = this.agentObservabilityRecent.get(completedKey);
    if (recent) return recent;
    const current = this.agentObservabilityInFlight.get(key);
    if (current) return current;
    const request = this.agentObservabilityForWindow(effectiveFilter);
    this.agentObservabilityInFlight.set(key, request);
    try {
      const value = await request;
      this.agentObservabilityRecent.set(completedKey, value);
      while (this.agentObservabilityRecent.size > 64) {
        const oldestKey = this.agentObservabilityRecent.keys().next().value as string | undefined;
        if (!oldestKey) break;
        this.agentObservabilityRecent.delete(oldestKey);
      }
      return value;
    } finally {
      if (this.agentObservabilityInFlight.get(key) === request) {
        this.agentObservabilityInFlight.delete(key);
      }
    }
  }

  workspaceRiskDistribution(
    filter: T.SecurityTimeFilter,
    overlay?: { events: T.JudgedEvent[]; coverage: T.QueryCoverage },
  ): T.SecurityWorkspaceRiskDistribution {
    const events = overlay?.events ?? this.win(filter).events;
    const agentScoped = filter.scope !== 'raw';
    const scopedEvents = overlay ? events : this.scopedEventsForView(events, filter, agentScoped);
    const byWs = new Map<string, T.JudgedEvent[]>();
    for (const e of scopedEvents) {
      const workspacePath = agentScoped ? attributionWorkspacePath(e) : e.workspacePath;
      (byWs.get(workspacePath) ?? byWs.set(workspacePath, []).get(workspacePath)!).push(e);
    }
    const list = [...byWs.entries()]
      .map(([workspacePath, evs]) => {
        const lvl = worstLevel(evs);
        return { workspacePath, sessionCount: distinct(evs.map((e) => e.sessionId)), totalRiskScore: evs.reduce((a, e) => a + e.riskScore, 0), riskLevel: lvl.level, riskLevelText: lvl.text };
      })
      .sort((a, b) => b.totalRiskScore - a.totalRiskScore);
    return { list, ...(overlay ? { coverage: overlay.coverage } : {}), ...this.classificationResponseMeta(filter), updateTime: iso() };
  }

  async healthCardForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityHealthCard> {
    if (this.needsCurrentAgentOverlay(filter)) {
      return this.healthCard(filter, await this.currentEffectiveOverlay(filter));
    }
    const history = await this.history(filter);
    if (!history) return this.healthCard(filter, this.boundedHotDashboardOverlay(filter));
    const rows = this.currentDimensions(history, filter);
    const total = rows.reduce((sum, row) => sum + row.eventCount, 0) || 1;
    const blocked = rows.filter((row) => row.verdict === 'block').reduce((sum, row) => sum + row.eventCount, 0);
    const escalated = rows.filter((row) => row.verdict === 'escalate').reduce((sum, row) => sum + row.eventCount, 0);
    const score = Math.max(1, Math.min(100, Math.round(100 - (blocked / total) * 60 - (escalated / total) * 25)));
    const text = score >= 90 ? '健康' : score >= 75 ? '良好' : score >= 60 ? '注意' : score >= 40 ? '风险偏高' : '高危';
    const tokens = fmtTokens(rows.reduce((sum, row) => sum + row.tokenCount, 0));
    return {
      healthScore: score,
      healthStatusText: text,
      tokenConsumptionTotal: tokens.total,
      tokenConsumptionUnit: tokens.unit,
      ...this.classificationResponseMeta(filter),
    };
  }

  async explainabilityScanForWindow(filter: T.ExplainabilityScanRequest): Promise<T.SecurityExplainabilityScan> {
    if (this.needsCurrentAgentOverlay(filter)) {
      return this.explainabilityScan(filter, await this.currentEffectiveOverlay(filter));
    }
    const history = await this.history(filter);
    if (!history) return this.explainabilityScan(filter, this.boundedHotDashboardOverlay(filter));
    const n = Math.max(8, Math.min(72, filter.seriesPoints ?? 24));
    const window = resolveTimeWindow(filter);
    const buckets = this.aggregateHistoryBuckets(history, filter, n);
    const safeSeries: T.WaveSeriesPoint[] = [];
    const riskSeries: T.WaveSeriesPoint[] = [];
    buckets.forEach((bucket, index) => {
      const statTime = iso(window.startMs + index * (window.spanMs / n));
      const avgRisk = bucket.eventCount ? bucket.riskScoreTotal / bucket.eventCount : 0;
      riskSeries.push({ statTime, value: Math.round(avgRisk), activationCount: bucket.riskActivationCount });
      safeSeries.push({ statTime, value: Math.round(100 - avgRisk), activationCount: bucket.eventCount });
    });
    const rows = this.currentDimensions(history, filter);
    const total = rows.reduce((sum, row) => sum + row.eventCount, 0);
    const blocked = rows.filter((row) => row.verdict === 'block').reduce((sum, row) => sum + row.eventCount, 0);
    const hotEvents = window.custom ? [] : this.judge.queryRange(Math.max(window.startMs, window.endMs - 5 * 60_000), window.endMs);
    const scopedHotEvents = this.scopedEventsForView(hotEvents, filter);
    return {
      waveSeries: [{ safeSeries, riskSeries }],
      threatInterception: `${round1((blocked / (total || 1)) * 100)}%`,
      sessionActiveCount: String(distinct(scopedHotEvents.map((event) => event.sessionId))),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async performanceCardForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityPerformanceCard> {
    if (this.needsCurrentAgentOverlay(filter)) {
      return this.performanceCard(filter, await this.currentEffectiveOverlay(filter));
    }
    const history = await this.history(filter);
    if (!history) return this.performanceCard(filter, this.boundedHotDashboardOverlay(filter));
    const window = resolveTimeWindow(filter);
    const buckets = this.aggregateHistoryBuckets(history, filter, 60);
    const bucketSeconds = window.spanMs / buckets.length / 1000;
    const counts = buckets.map((bucket) => bucket.eventCount);
    const perSecond = counts.map((count) => count / (bucketSeconds || 1));
    const total = buckets.reduce((sum, bucket) => sum + bucket.eventCount, 0);
    const latencyTotal = buckets.reduce((sum, bucket) => sum + bucket.latencyTotal, 0);
    return {
      componentRequestCount: {
        current: counts[counts.length - 1] ?? 0,
        peak: Math.max(0, ...counts),
        avg: Math.round(mean(counts)),
      },
      tps: {
        current: round1(perSecond[perSecond.length - 1] ?? 0),
        peak: round1(Math.max(0, ...perSecond)),
        avg: round1(mean(perSecond)),
      },
      avgLatency: { value: Math.round(latencyTotal / (total || 1)), unit: 'ms' },
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async riskSummaryForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityRiskSummary> {
    if (this.needsCurrentAgentOverlay(filter)) {
      return this.riskSummary(filter, await this.currentEffectiveOverlay(filter));
    }
    const history = await this.history(filter);
    if (!history) return this.riskSummary(filter, this.boundedHotDashboardOverlay(filter));
    const rows = this.currentDimensions(history, filter).filter((row) => row.verdict !== 'allow');
    const card = (code: T.RiskType, name: string) => ({
      riskTypeCode: code,
      riskTypeName: name,
      eventCount: rows.filter((row) => row.riskType === code).reduce((sum, row) => sum + row.eventCount, 0),
    });
    return {
      summaryCards: [
        card('system', '系统性风险'),
        card('communication', '通信风险'),
        card('atomic', '单体智能体风险'),
      ],
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async riskBreakdownForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityRiskBreakdown> {
    if (this.needsCurrentAgentOverlay(filter)) {
      const window = resolveTimeWindow(filter);
      const previousFilter: T.SecurityTimeFilter = {
        ...filter,
        timeType: 'custom',
        startTime: new Date(Math.max(0, window.startMs - window.spanMs)).toISOString(),
        endTime: new Date(Math.max(0, window.startMs - 1)).toISOString(),
        snapshotAsOf: new Date(Math.max(0, window.startMs - 1)).toISOString(),
      };
      const [current, previous] = await Promise.all([
        this.currentEffectiveOverlay(filter),
        this.currentEffectiveOverlay(previousFilter),
      ]);
      return this.riskBreakdown(filter, current, previous);
    }
    const history = await this.history(filter);
    if (!history) return this.riskBreakdown(filter, this.boundedHotDashboardOverlay(filter));
    const agentScoped = filter.scope === 'agent';
    const select = (period: DashboardWindowDimensionRow['period']) => history.dimensions.filter((row) =>
      row.period === period && row.verdict !== 'allow' && (!agentScoped || row.monitored));
    const current = select('current');
    const previous = select('previous');
    const category = (type: T.RiskType): T.RiskCategory => {
      const rows = current.filter((row) => row.riskType === type);
      const previousRows = previous.filter((row) => row.riskType === type);
      const countOf = (items: DashboardWindowDimensionRow[], code: string) =>
        items.filter((row) => row.riskCategory === code).reduce((sum, row) => sum + row.eventCount, 0);
      const known = RISK_TAXONOMY[type];
      const extras = [...new Set(rows.map((row) => row.riskCategory))]
        .filter((code) => !known.some((item) => item.code === code))
        .map((code) => ({ code, name: rows.find((row) => row.riskCategory === code)?.riskName || code }));
      const items = [...known, ...extras].map(({ code, name }) => {
        const eventCount = countOf(rows, code);
        const before = countOf(previousRows, code);
        const changeRate = before === 0 ? (eventCount ? 100 : 0) : round1(((eventCount - before) / before) * 100);
        return { riskCode: code, riskName: name, eventCount, changeRate };
      }).sort((a, b) => b.eventCount - a.eventCount);
      const top = items.find((item) => item.eventCount > 0);
      return {
        totalCount: rows.reduce((sum, row) => sum + row.eventCount, 0),
        displayColor: CATEGORY_COLOR[top?.riskCode ?? ''] ?? '#94a3b8',
        items,
      };
    };
    return {
      systemRisks: category('system'),
      communicationRisks: category('communication'),
      singleAgentRisks: category('atomic'),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async highestRiskSessionForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityHighestRiskSession> {
    if (resolvedClassificationView(filter) === 'current_effective') {
      const scoped = { ...filter, scope: 'agent' as const };
      return this.highestRiskSession(scoped, await this.currentEffectiveOverlay(scoped, true));
    }
    const history = await this.history(filter);
    if (!history) return this.highestRiskSession(filter, this.boundedHotDashboardOverlay(filter, true));
    const top = history.topSession;
    if (!top) {
      return {
        sessionId: '-',
        userId: '-',
        workspacePath: '-',
        riskLevel: 'safe',
        riskLevelText: LEVEL_TEXT.safe,
        compositeScore: 0,
        lastEventTime: iso(resolveTimeWindow(filter).endMs),
        riskDimensions: DIMENSIONS.map((dimension) => ({ dimensionCode: dimension.code, dimensionName: dimension.name, score: 0 })),
        ...this.classificationResponseMeta(filter),
        updateTime: iso(),
      };
    }
    const compositeScore = Math.min(100, Math.round((top.riskScoreTotal / (top.eventCount || 1)) + Math.sqrt(top.riskyEventCount) * 6));
    const level = levelByRank(Math.min(4, Math.floor(compositeScore / 22)));
    return {
      sessionId: top.sessionId,
      userId: top.userId,
      workspacePath: top.workspacePath,
      riskLevel: level.level,
      riskLevelText: level.text,
      compositeScore,
      lastEventTime: iso(top.lastEventAt),
      riskDimensions: DIMENSIONS.map((dimension) => {
        const count = top.dimensionCounts[dimension.code] ?? 0;
        return {
          dimensionCode: dimension.code,
          dimensionName: dimension.name,
          score: count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3,
        };
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async decisionFunnelForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityDecisionFunnel> {
    if (this.needsCurrentAgentOverlay(filter)) {
      return this.decisionFunnel(filter, await this.currentEffectiveOverlay(filter));
    }
    const history = await this.history(filter);
    if (!history) return this.decisionFunnel(filter, this.boundedHotDashboardOverlay(filter));
    const rows = this.currentDimensions(history, filter);
    const total = rows.reduce((sum, row) => sum + row.eventCount, 0) || 1;
    const count = (predicate: (row: DashboardWindowDimensionRow) => boolean) =>
      rows.filter(predicate).reduce((sum, row) => sum + row.eventCount, 0);
    const l2 = count((row) => row.tier === 'Llm' || row.tier === 'Agent');
    const l3 = count((row) => row.tier === 'Agent');
    const blocked = count((row) => row.verdict === 'block');
    const percentage = (value: number) => round1((value / total) * 100);
    return {
      tiers: [
        { tierCode: 'L1', tierName: '规则引擎', count: total, percentage: 100, slaDesc: '确定性匹配 · <1ms' },
        { tierCode: 'L2', tierName: 'LLM 研判', count: l2, percentage: percentage(l2), slaDesc: '语义判定 · <100ms' },
        { tierCode: 'L3', tierName: '智能体深判', count: l3, percentage: percentage(l3), slaDesc: 'a3s-code · 深度调查' },
      ],
      finalBlock: { count: blocked, percentage: percentage(blocked) },
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }

  async workspaceRiskDistributionForWindow(filter: T.SecurityTimeFilter): Promise<T.SecurityWorkspaceRiskDistribution> {
    if (this.needsCurrentAgentOverlay(filter, filter.scope !== 'raw')) {
      return this.workspaceRiskDistribution(
        filter,
        await this.currentEffectiveOverlay(filter, true),
      );
    }
    const history = await this.history(filter);
    if (!history || filter.scope === 'raw') {
      return this.workspaceRiskDistribution(
        filter,
        this.boundedHotDashboardOverlay(filter, filter.scope !== 'raw'),
      );
    }
    return {
      list: history.workspaces.map((workspace) => {
        const level = levelByRank(workspace.worstSeverityRank);
        return {
          workspacePath: workspace.workspacePath,
          sessionCount: workspace.sessionCount,
          totalRiskScore: workspace.totalRiskScore,
          riskLevel: level.level,
          riskLevelText: level.text,
        };
      }),
      ...this.classificationResponseMeta(filter),
      updateTime: iso(),
    };
  }
}
